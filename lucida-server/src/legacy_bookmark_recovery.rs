//! Offline recovery of retired organization-global bookmarks into one chosen
//! workspace's saved-view store.
//!
//! This is intentionally an operator command over the SQLite database, not a
//! compatibility HTTP route. Recovery validates the complete URL-to-membership
//! mapping and the creator's current workspace role in one transaction before
//! it can write anything. A partial or ambiguous remap therefore leaves the
//! database unchanged.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Utc};
use clap::ValueEnum;
use lucida_content::DatasetId;
use lucida_content::url::SourceIdentity;
use lucida_core::quota::{MAX_DOCUMENT_JSON_BYTES, to_json_vec_bounded};
use lucida_core::saved_view::SavedView;
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use thiserror::Error;

use crate::source_identity_migration::supported_dataset_id_aliases;
use crate::source_policy::SafeSourceDiagnostic;

const MAX_SAVED_VIEW_NAME_CHARS: usize = 200;
const MAX_RECOVERY_DATASETS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryVisibility {
    /// Keep the recovered view private to the selected workspace member.
    Personal,
    /// Make the recovered view visible to the workspace. Requires an editor
    /// or owner as creator, matching the live saved-view authorization rule.
    Shared,
}

impl RecoveryVisibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Shared => "shared",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RecoveryRequest<'a> {
    pub bookmark_id: &'a str,
    pub workspace_id: &'a str,
    /// Reattribute to this current workspace member. When omitted, the legacy
    /// bookmark creator must still be a member of the target workspace.
    pub creator_email: Option<&'a str>,
    pub visibility: RecoveryVisibility,
    /// `false` performs every read, parse, and validation but rolls back.
    pub apply: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasetRecoveryMapping {
    /// Credential/path-free locator hint suitable for terminals and JSON logs.
    pub source_hint: String,
    /// Full canonical source hash, which lets an operator distinguish sources
    /// whose redacted host/bucket hints are identical.
    pub source_identity: String,
    pub legacy_dataset_id: String,
    pub workspace_dataset_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecoveryOutcome {
    pub bookmark_id: String,
    pub workspace_id: String,
    pub saved_view_id: String,
    pub name: String,
    pub created_by: String,
    pub visibility: RecoveryVisibility,
    pub created_at: String,
    pub updated_at: String,
    pub dataset_mappings: Vec<DatasetRecoveryMapping>,
    pub applied: bool,
    pub already_present: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct SafeIdentifier(String);

impl SafeIdentifier {
    fn dataset_source(raw: &str) -> Self {
        let valid = raw.strip_prefix("ds-").is_some_and(|suffix| {
            matches!(suffix.len(), 16 | 64)
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        });
        Self::validated_or_fingerprint(raw, valid, "dataset-source-id")
    }

    fn workspace_dataset(raw: &str) -> Self {
        let valid = raw
            .strip_prefix("wds-")
            .is_some_and(is_bounded_identifier_suffix);
        Self::validated_or_fingerprint(raw, valid, "workspace-dataset-id")
    }

    fn generic(raw: &str, label: &str) -> Self {
        Self::validated_or_fingerprint(raw, is_bounded_identifier_suffix(raw), label)
    }

    fn validated_or_fingerprint(raw: &str, valid: bool, label: &str) -> Self {
        if valid {
            Self(raw.to_string())
        } else {
            Self(format!(
                "{label}-blake3-{}",
                blake3::hash(raw.as_bytes()).to_hex()
            ))
        }
    }
}

fn is_bounded_identifier_suffix(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 128
        && raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

impl fmt::Debug for SafeIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SafeIdentifier")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for SafeIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct SafeEmail(String);

impl SafeEmail {
    fn from_untrusted(raw: &str) -> Self {
        let (local, domain) = raw.split_once('@').unwrap_or_default();
        let local_is_safe = !local.is_empty()
            && local.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'%' | b'+' | b'-')
            });
        let domain_is_safe = !domain.is_empty()
            && domain
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
        if raw.len() <= 254 && local_is_safe && domain_is_safe && !domain.contains("..") {
            Self(raw.to_string())
        } else {
            Self(format!(
                "email-blake3-{}",
                blake3::hash(raw.as_bytes()).to_hex()
            ))
        }
    }
}

impl fmt::Debug for SafeEmail {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("SafeEmail").field(&self.0).finish()
    }
}

impl fmt::Display for SafeEmail {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum InvalidBookmarkReason {
    #[error("created_at is not valid RFC 3339")]
    InvalidCreatedAt,
    #[error("creator email is empty")]
    EmptyCreatorEmail,
    #[error("saved-view JSON could not be serialized")]
    ViewSerializationFailed,
    #[error("saved-view JSON is malformed")]
    MalformedViewJson,
    #[error("saved-view JSON is {bytes} bytes; limit is {limit}")]
    ViewJsonTooLarge { bytes: usize, limit: usize },
    #[error("saved view declares {count} datasets; limit is {limit}")]
    TooManyViewDatasets { count: usize, limit: usize },
    #[error("bookmark side table declares more than {limit} datasets")]
    TooManySideTableDatasets { limit: usize },
    #[error("bookmark declares more than {limit} distinct datasets")]
    TooManyDistinctDatasets { limit: usize },
    #[error("saved-view name is empty")]
    EmptyName,
    #[error("saved-view name exceeds {limit} characters")]
    NameTooLong { limit: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum WorkspaceSourceIssue {
    #[error("locator is invalid")]
    InvalidLocator,
    #[error("persisted id does not match a released identity generation")]
    UnsupportedPersistedIdentity,
}

#[derive(Debug, Error)]
pub enum RecoveryError {
    #[error("database path does not name an existing file")]
    DatabaseMissing,
    #[error("database operation failed")]
    Database,
    #[error("legacy bookmark {0} was not found")]
    BookmarkNotFound(SafeIdentifier),
    #[error("target workspace {0} was not found or is archived")]
    WorkspaceUnavailable(SafeIdentifier),
    #[error("legacy bookmark is invalid: {0}")]
    InvalidBookmark(InvalidBookmarkReason),
    #[error("bookmark dataset source {diagnostic} is invalid")]
    InvalidBookmarkSource { diagnostic: SafeSourceDiagnostic },
    #[error(
        "workspace dataset source {diagnostic} is invalid: {issue}; persisted id {persisted_id}"
    )]
    InvalidWorkspaceSource {
        diagnostic: SafeSourceDiagnostic,
        issue: WorkspaceSourceIssue,
        persisted_id: SafeIdentifier,
    },
    #[error("creator {email} is not a member of workspace {workspace_id}")]
    CreatorNotMember {
        email: SafeEmail,
        workspace_id: SafeIdentifier,
    },
    #[error(
        "creator {email} has role {role}; recovering a shared view requires an editor or owner"
    )]
    CreatorCannotShare {
        email: SafeEmail,
        role: SafeIdentifier,
    },
    #[error("bookmark dataset source {diagnostic} is not present in the target workspace")]
    MissingDataset { diagnostic: SafeSourceDiagnostic },
    #[error(
        "bookmark dataset source {diagnostic} matches multiple target memberships: {workspace_dataset_ids:?}"
    )]
    AmbiguousDataset {
        diagnostic: SafeSourceDiagnostic,
        workspace_dataset_ids: Vec<SafeIdentifier>,
    },
    #[error("saved view references dataset id {0}, but no legacy dataset source maps it")]
    MissingDatasetReference(SafeIdentifier),
    #[error(
        "legacy dataset ids {legacy_dataset_ids:?} collapse onto target membership {workspace_dataset_id:?}"
    )]
    AmbiguousDatasetReference {
        workspace_dataset_id: SafeIdentifier,
        legacy_dataset_ids: Vec<SafeIdentifier>,
    },
    #[error(
        "saved-view id {saved_view_id:?} already exists in workspace {workspace_id:?} with different content"
    )]
    SavedViewCollision {
        saved_view_id: SafeIdentifier,
        workspace_id: SafeIdentifier,
    },
}

#[derive(Serialize)]
pub struct RecoveryErrorEnvelope<'a> {
    ok: bool,
    error: RecoveryErrorBody<'a>,
}

#[derive(Serialize)]
struct RecoveryErrorBody<'a> {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a SafeSourceDiagnostic>,
}

impl RecoveryError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DatabaseMissing => "database_missing",
            Self::Database => "database_error",
            Self::BookmarkNotFound(_) => "bookmark_not_found",
            Self::WorkspaceUnavailable(_) => "workspace_unavailable",
            Self::InvalidBookmark(_) => "invalid_bookmark",
            Self::InvalidBookmarkSource { .. } => "invalid_bookmark_source",
            Self::InvalidWorkspaceSource { .. } => "invalid_workspace_source",
            Self::CreatorNotMember { .. } => "creator_not_member",
            Self::CreatorCannotShare { .. } => "creator_cannot_share",
            Self::MissingDataset { .. } => "missing_dataset",
            Self::AmbiguousDataset { .. } => "ambiguous_dataset",
            Self::MissingDatasetReference(_) => "missing_dataset_reference",
            Self::AmbiguousDatasetReference { .. } => "ambiguous_dataset_reference",
            Self::SavedViewCollision { .. } => "saved_view_collision",
        }
    }

    pub fn envelope(&self) -> RecoveryErrorEnvelope<'_> {
        let source = match self {
            Self::InvalidBookmarkSource { diagnostic }
            | Self::InvalidWorkspaceSource { diagnostic, .. }
            | Self::MissingDataset { diagnostic }
            | Self::AmbiguousDataset { diagnostic, .. } => Some(diagnostic),
            _ => None,
        };
        RecoveryErrorEnvelope {
            ok: false,
            error: RecoveryErrorBody {
                code: self.code(),
                message: self.to_string(),
                source,
            },
        }
    }
}

fn map_sql(_error: sqlx::Error) -> RecoveryError {
    RecoveryError::Database
}

/// Open an existing Lucida SQLite database without creating a new empty file
/// for a mistyped path. The server should be stopped while applying recovery;
/// a bounded busy timeout makes accidental concurrent use fail rather than
/// wait forever.
pub async fn open_existing_database(path: &Path) -> Result<SqlitePool, RecoveryError> {
    if !path.is_file() {
        return Err(RecoveryError::DatabaseMissing);
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(map_sql)
}

#[derive(Debug, Clone)]
struct WorkspaceMembership {
    workspace_dataset_id: DatasetId,
    identity: SourceIdentity,
}

#[derive(Debug)]
struct BookmarkRow {
    name: String,
    created_by: String,
    created_by_name: String,
    created_at: String,
    view: SavedView,
    dataset_urls: Vec<String>,
}

/// Recover one retired bookmark. The original bookmark UUID becomes the
/// workspace saved-view UUID: this makes the operation naturally idempotent
/// and lets an old `#b=<id>` resolve again once paired with the chosen
/// workspace URL.
pub async fn recover_legacy_bookmark(
    pool: &SqlitePool,
    request: RecoveryRequest<'_>,
) -> Result<RecoveryOutcome, RecoveryError> {
    let mut tx = pool.begin().await.map_err(map_sql)?;

    let workspace_exists: Option<(String,)> =
        sqlx::query_as("SELECT id FROM workspaces WHERE id = ? AND archived_at IS NULL")
            .bind(request.workspace_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(map_sql)?;
    if workspace_exists.is_none() {
        tx.rollback().await.map_err(map_sql)?;
        return Err(RecoveryError::WorkspaceUnavailable(
            SafeIdentifier::generic(request.workspace_id, "workspace-id"),
        ));
    }

    let mut bookmark = read_bookmark(&mut tx, request.bookmark_id).await?;
    bookmark.name = normalize_saved_view_name(&bookmark.name)?;
    let created_at = DateTime::parse_from_rfc3339(&bookmark.created_at)
        .map_err(|_| RecoveryError::InvalidBookmark(InvalidBookmarkReason::InvalidCreatedAt))?
        .with_timezone(&Utc)
        .to_rfc3339();

    let memberships = read_memberships(&mut tx, request.workspace_id).await?;
    let referenced = referenced_dataset_ids(&bookmark.view);
    let (remap, dataset_mappings) =
        build_strict_dataset_remap(&bookmark.dataset_urls, &memberships, &referenced)?;

    bookmark.view.remap_dataset_ids(&remap);
    bookmark.view.clear_source_urls();
    let target_ids: HashSet<&str> = memberships
        .iter()
        .map(|membership| membership.workspace_dataset_id.as_ref())
        .collect();
    if let Some(dangling) = referenced_dataset_ids(&bookmark.view)
        .into_iter()
        .find(|id| !target_ids.contains(id.as_str()))
    {
        return Err(RecoveryError::MissingDatasetReference(
            SafeIdentifier::workspace_dataset(&dangling),
        ));
    }

    let creator_email = normalize_email(
        request
            .creator_email
            .unwrap_or(bookmark.created_by.as_str()),
    );
    if creator_email.is_empty() {
        return Err(RecoveryError::InvalidBookmark(
            InvalidBookmarkReason::EmptyCreatorEmail,
        ));
    }
    let member = sqlx::query(
        "SELECT role, display_name FROM workspace_members WHERE workspace_id = ? AND email = ?",
    )
    .bind(request.workspace_id)
    .bind(&creator_email)
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_sql)?
    .ok_or_else(|| RecoveryError::CreatorNotMember {
        email: SafeEmail::from_untrusted(&creator_email),
        workspace_id: SafeIdentifier::generic(request.workspace_id, "workspace-id"),
    })?;
    let creator_role: String = member.get("role");
    if request.visibility == RecoveryVisibility::Shared
        && !matches!(creator_role.as_str(), "editor" | "owner")
    {
        return Err(RecoveryError::CreatorCannotShare {
            email: SafeEmail::from_untrusted(&creator_email),
            role: SafeIdentifier::generic(&creator_role, "workspace-role"),
        });
    }
    let member_display_name: String = member.get("display_name");
    let created_by_name = if member_display_name.trim().is_empty()
        && creator_email == normalize_email(&bookmark.created_by)
    {
        bookmark.created_by_name.clone()
    } else if member_display_name.trim().is_empty() {
        creator_email.clone()
    } else {
        member_display_name
    };

    let view_json = String::from_utf8(
        to_json_vec_bounded(&bookmark.view, MAX_DOCUMENT_JSON_BYTES).map_err(|_| {
            RecoveryError::InvalidBookmark(InvalidBookmarkReason::ViewSerializationFailed)
        })?,
    )
    .expect("serde_json always emits UTF-8");
    let now = Utc::now().to_rfc3339();

    if let Some(existing) = sqlx::query(
        r#"
        SELECT workspace_id, name, created_by, visibility, view_json, created_at, updated_at
        FROM workspace_saved_views
        WHERE id = ?
        "#,
    )
    .bind(request.bookmark_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_sql)?
    {
        let same = existing.get::<String, _>("workspace_id") == request.workspace_id
            && existing.get::<String, _>("name") == bookmark.name
            && existing.get::<String, _>("created_by") == creator_email
            && existing.get::<String, _>("visibility") == request.visibility.as_str()
            && existing.get::<String, _>("view_json") == view_json;
        if !same {
            return Err(RecoveryError::SavedViewCollision {
                saved_view_id: SafeIdentifier::generic(request.bookmark_id, "saved-view-id"),
                workspace_id: SafeIdentifier::generic(
                    &existing.get::<String, _>("workspace_id"),
                    "workspace-id",
                ),
            });
        }
        let outcome = RecoveryOutcome {
            bookmark_id: request.bookmark_id.to_string(),
            workspace_id: request.workspace_id.to_string(),
            saved_view_id: request.bookmark_id.to_string(),
            name: bookmark.name,
            created_by: creator_email,
            visibility: request.visibility,
            created_at: existing.get("created_at"),
            updated_at: existing.get("updated_at"),
            dataset_mappings,
            applied: false,
            already_present: true,
        };
        tx.rollback().await.map_err(map_sql)?;
        return Ok(outcome);
    }

    if request.apply {
        sqlx::query(
            r#"
            INSERT INTO workspace_saved_views
                (id, workspace_id, name, created_by, created_by_name,
                 created_at, updated_at, visibility, view_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(request.bookmark_id)
        .bind(request.workspace_id)
        .bind(&bookmark.name)
        .bind(&creator_email)
        .bind(&created_by_name)
        .bind(&created_at)
        .bind(&now)
        .bind(request.visibility.as_str())
        .bind(&view_json)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;
        sqlx::query("UPDATE workspaces SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(request.workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        tx.commit().await.map_err(map_sql)?;
    } else {
        tx.rollback().await.map_err(map_sql)?;
    }

    Ok(RecoveryOutcome {
        bookmark_id: request.bookmark_id.to_string(),
        workspace_id: request.workspace_id.to_string(),
        saved_view_id: request.bookmark_id.to_string(),
        name: bookmark.name,
        created_by: creator_email,
        visibility: request.visibility,
        created_at,
        updated_at: now,
        dataset_mappings,
        applied: request.apply,
        already_present: false,
    })
}

async fn read_bookmark(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    bookmark_id: &str,
) -> Result<BookmarkRow, RecoveryError> {
    let row = sqlx::query(
        r#"
        SELECT name, created_by, created_by_name, created_at, view_json
        FROM bookmarks
        WHERE id = ?
        "#,
    )
    .bind(bookmark_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(map_sql)?
    .ok_or_else(|| {
        RecoveryError::BookmarkNotFound(SafeIdentifier::generic(bookmark_id, "bookmark-id"))
    })?;
    let view_json: String = row.get("view_json");
    if view_json.len() > MAX_DOCUMENT_JSON_BYTES {
        return Err(RecoveryError::InvalidBookmark(
            InvalidBookmarkReason::ViewJsonTooLarge {
                bytes: view_json.len(),
                limit: MAX_DOCUMENT_JSON_BYTES,
            },
        ));
    }
    let view: SavedView = serde_json::from_str(&view_json)
        .map_err(|_| RecoveryError::InvalidBookmark(InvalidBookmarkReason::MalformedViewJson))?;
    if view.datasets.len() > MAX_RECOVERY_DATASETS {
        return Err(RecoveryError::InvalidBookmark(
            InvalidBookmarkReason::TooManyViewDatasets {
                count: view.datasets.len(),
                limit: MAX_RECOVERY_DATASETS,
            },
        ));
    }
    let side_rows = sqlx::query(
        r#"
        SELECT dataset_url
        FROM bookmark_datasets
        WHERE bookmark_id = ?
        ORDER BY dataset_url
        LIMIT ?
        "#,
    )
    .bind(bookmark_id)
    .bind((MAX_RECOVERY_DATASETS + 1) as i64)
    .fetch_all(&mut **tx)
    .await
    .map_err(map_sql)?;
    if side_rows.len() > MAX_RECOVERY_DATASETS {
        return Err(RecoveryError::InvalidBookmark(
            InvalidBookmarkReason::TooManySideTableDatasets {
                limit: MAX_RECOVERY_DATASETS,
            },
        ));
    }
    let mut dataset_urls = Vec::new();
    let mut seen = HashSet::new();
    for url in view.datasets.iter().cloned().chain(
        side_rows
            .into_iter()
            .map(|dataset_row| dataset_row.get::<String, _>("dataset_url")),
    ) {
        if seen.insert(url.clone()) {
            dataset_urls.push(url);
        }
        if dataset_urls.len() > MAX_RECOVERY_DATASETS {
            return Err(RecoveryError::InvalidBookmark(
                InvalidBookmarkReason::TooManyDistinctDatasets {
                    limit: MAX_RECOVERY_DATASETS,
                },
            ));
        }
    }
    Ok(BookmarkRow {
        name: row.get("name"),
        created_by: row.get("created_by"),
        created_by_name: row.get("created_by_name"),
        created_at: row.get("created_at"),
        view,
        dataset_urls,
    })
}

async fn read_memberships(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workspace_id: &str,
) -> Result<Vec<WorkspaceMembership>, RecoveryError> {
    let rows = sqlx::query(
        r#"
        SELECT wd.id AS workspace_dataset_id, wd.dataset_source_id, ds.canonical_url
        FROM workspace_datasets wd
        INNER JOIN dataset_sources ds ON ds.id = wd.dataset_source_id
        WHERE wd.workspace_id = ?
        ORDER BY wd.sort_order, wd.added_at, wd.id
        "#,
    )
    .bind(workspace_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(map_sql)?;
    rows.into_iter()
        .map(|row| {
            let source_id: String = row.get("dataset_source_id");
            let canonical_url: String = row.get("canonical_url");
            let source = SafeSourceDiagnostic::from_untrusted(&canonical_url);
            let persisted_id = SafeIdentifier::dataset_source(&source_id);
            let identity = SourceIdentity::parse(&canonical_url).map_err(|_| {
                RecoveryError::InvalidWorkspaceSource {
                    diagnostic: source.clone(),
                    issue: WorkspaceSourceIssue::InvalidLocator,
                    persisted_id: persisted_id.clone(),
                }
            })?;
            let valid_persisted_id = dataset_id_aliases(&canonical_url, &identity)
                .into_iter()
                .any(|candidate| candidate.as_ref() == source_id);
            if !valid_persisted_id {
                return Err(RecoveryError::InvalidWorkspaceSource {
                    diagnostic: source,
                    issue: WorkspaceSourceIssue::UnsupportedPersistedIdentity,
                    persisted_id,
                });
            }
            Ok(WorkspaceMembership {
                workspace_dataset_id: DatasetId(row.get("workspace_dataset_id")),
                identity,
            })
        })
        .collect()
}

fn build_strict_dataset_remap(
    dataset_urls: &[String],
    memberships: &[WorkspaceMembership],
    referenced_ids: &BTreeSet<String>,
) -> Result<(HashMap<DatasetId, DatasetId>, Vec<DatasetRecoveryMapping>), RecoveryError> {
    let mut remap = HashMap::new();
    let mut mappings_by_legacy_id: HashMap<String, DatasetRecoveryMapping> = HashMap::new();
    let mut seen_urls = HashSet::new();
    for url in dataset_urls {
        if !seen_urls.insert(url.as_str()) {
            continue;
        }
        let source = SafeSourceDiagnostic::from_untrusted(url);
        let identity =
            SourceIdentity::parse(url).map_err(|_| RecoveryError::InvalidBookmarkSource {
                diagnostic: source.clone(),
            })?;
        let matches: Vec<_> = memberships
            .iter()
            .filter(|membership| membership.identity == identity)
            .collect();
        let membership = match matches.as_slice() {
            [] => return Err(RecoveryError::MissingDataset { diagnostic: source }),
            [membership] => *membership,
            _ => {
                return Err(RecoveryError::AmbiguousDataset {
                    diagnostic: source,
                    workspace_dataset_ids: matches
                        .iter()
                        .map(|membership| {
                            SafeIdentifier::workspace_dataset(
                                membership.workspace_dataset_id.as_ref(),
                            )
                        })
                        .collect(),
                });
            }
        };
        // Bookmarks existed before canonical source identities. Rows written
        // by that generation key their view fields with the first 8 bytes of
        // BLAKE3(raw URL), interpreted little-endian. Rows written after the
        // canonical-identity rollout use the current full normalized digest.
        // Accept both explicit historical formats; never guess by name/order.
        let aliases = dataset_id_aliases(url, &identity);
        let mut mapped_referenced_alias = false;
        for legacy_id in &aliases {
            if let Some(previous) =
                remap.insert(legacy_id.clone(), membership.workspace_dataset_id.clone())
                && previous != membership.workspace_dataset_id
            {
                return Err(RecoveryError::AmbiguousDataset {
                    diagnostic: source.clone(),
                    workspace_dataset_ids: vec![
                        SafeIdentifier::workspace_dataset(previous.as_ref()),
                        SafeIdentifier::workspace_dataset(membership.workspace_dataset_id.as_ref()),
                    ],
                });
            }
            if referenced_ids.contains(legacy_id.as_ref()) {
                mapped_referenced_alias = true;
                mappings_by_legacy_id
                    .entry(legacy_id.to_string())
                    .or_insert_with(|| DatasetRecoveryMapping {
                        source_hint: source.hint().to_string(),
                        source_identity: source.fingerprint().to_string(),
                        legacy_dataset_id: legacy_id.to_string(),
                        workspace_dataset_id: membership.workspace_dataset_id.to_string(),
                    });
            }
        }
        if !mapped_referenced_alias {
            let current_id = aliases
                .last()
                .expect("each dataset URL has at least one explicit id alias");
            mappings_by_legacy_id
                .entry(current_id.to_string())
                .or_insert_with(|| DatasetRecoveryMapping {
                    source_hint: source.hint().to_string(),
                    source_identity: source.fingerprint().to_string(),
                    legacy_dataset_id: current_id.to_string(),
                    workspace_dataset_id: membership.workspace_dataset_id.to_string(),
                });
        }
    }

    for referenced in referenced_ids {
        if !remap.contains_key(&DatasetId(referenced.clone())) {
            return Err(RecoveryError::MissingDatasetReference(
                SafeIdentifier::dataset_source(referenced),
            ));
        }
    }

    let mut reverse: HashMap<&str, Vec<String>> = HashMap::new();
    for referenced in referenced_ids {
        let target = remap
            .get(&DatasetId(referenced.clone()))
            .expect("coverage checked above");
        reverse
            .entry(target.as_ref())
            .or_default()
            .push(referenced.clone());
    }
    if let Some((target, mut legacy_ids)) = reverse
        .into_iter()
        .find(|(_, legacy_ids)| legacy_ids.len() > 1)
    {
        legacy_ids.sort();
        return Err(RecoveryError::AmbiguousDatasetReference {
            workspace_dataset_id: SafeIdentifier::workspace_dataset(target),
            legacy_dataset_ids: legacy_ids
                .iter()
                .map(|id| SafeIdentifier::dataset_source(id))
                .collect(),
        });
    }

    let mut mappings: Vec<_> = mappings_by_legacy_id.into_values().collect();
    mappings.sort_by(|left, right| {
        left.source_identity
            .cmp(&right.source_identity)
            .then_with(|| left.legacy_dataset_id.cmp(&right.legacy_dataset_id))
    });
    Ok((remap, mappings))
}

fn dataset_id_aliases(raw_url: &str, identity: &SourceIdentity) -> Vec<DatasetId> {
    supported_dataset_id_aliases(raw_url, identity)
        .into_iter()
        .map(DatasetId)
        .collect()
}

fn referenced_dataset_ids(view: &SavedView) -> BTreeSet<String> {
    view.active_layouts
        .keys()
        .chain(view.dataset_order.iter())
        .chain(view.dataset_settings.keys())
        .chain(view.auto_contrast.keys())
        .map(ToString::to_string)
        .collect()
}

fn normalize_saved_view_name(name: &str) -> Result<String, RecoveryError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(RecoveryError::InvalidBookmark(
            InvalidBookmarkReason::EmptyName,
        ));
    }
    if trimmed.chars().count() > MAX_SAVED_VIEW_NAME_CHARS {
        return Err(RecoveryError::InvalidBookmark(
            InvalidBookmarkReason::NameTooLong {
                limit: MAX_SAVED_VIEW_NAME_CHARS,
            },
        ));
    }
    Ok(trimmed.to_string())
}

fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::LayoutId;
    use lucida_core::scene::DatasetDisplaySettings;

    use crate::auth::SqliteSessionStore;

    // Legacy bookmarks retained raw user spelling, while workspace sources
    // were persisted from the normalized locator. The uppercase scheme makes
    // those two released short ids differ and proves recovery accepts both.
    const URL_A: &str = "HTTPS://data.example.test/sets/a.zarr";
    const URL_B: &str = "s3://example-bucket/sets/b.zarr";

    async fn setup_pool() -> SqlitePool {
        SqliteSessionStore::open_in_memory()
            .await
            .unwrap()
            .pool()
            .clone()
    }

    async fn seed_workspace(pool: &SqlitePool, urls: &[(&str, &str)]) {
        sqlx::query(
            r#"
            INSERT INTO workspaces
                (id, name, created_by, created_at, updated_at, seq, document_json)
            VALUES ('workspace-1', 'Recovery target', 'owner@example.test',
                    '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 0, '{}')
            "#,
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO workspace_members
                (workspace_id, email, role, display_name, added_at)
            VALUES ('workspace-1', 'owner@example.test', 'owner', 'Current Owner',
                    '2026-07-01T00:00:00Z')
            "#,
        )
        .execute(pool)
        .await
        .unwrap();
        for (sort_order, (url, workspace_dataset_id)) in urls.iter().enumerate() {
            let identity = SourceIdentity::parse(url).unwrap();
            let persisted_source_id = historical_dataset_id(identity.locator.as_str());
            sqlx::query(
                r#"
                INSERT INTO dataset_sources
                    (id, canonical_url, default_name, created_at, updated_at)
                VALUES (?, ?, ?, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')
                "#,
            )
            .bind(persisted_source_id.to_string())
            .bind(identity.locator.as_str())
            .bind(format!("Dataset {sort_order}"))
            .execute(pool)
            .await
            .unwrap();
            sqlx::query(
                r#"
                INSERT INTO workspace_datasets
                    (id, workspace_id, dataset_source_id, display_name,
                     added_by, added_at, sort_order)
                VALUES (?, 'workspace-1', ?, ?, 'owner@example.test',
                        '2026-07-01T00:00:00Z', ?)
                "#,
            )
            .bind(workspace_dataset_id)
            .bind(persisted_source_id.to_string())
            .bind(format!("Dataset {sort_order}"))
            .bind(sort_order as i64)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    fn two_dataset_view() -> SavedView {
        let old_a = historical_dataset_id(URL_A);
        let old_b = historical_dataset_id(URL_B);
        let mut view = SavedView::empty([1600, 900]);
        view.datasets = vec![URL_A.to_string(), URL_B.to_string()];
        view.active_layouts
            .insert(old_a.clone(), LayoutId("layout-a".to_string()));
        view.active_layouts
            .insert(old_b.clone(), LayoutId("layout-b".to_string()));
        view.dataset_order = vec![old_b.clone(), old_a.clone()];
        view.dataset_settings
            .insert(old_a.clone(), DatasetDisplaySettings::default());
        view.dataset_settings
            .insert(old_b.clone(), DatasetDisplaySettings::default());
        view.auto_contrast.insert(old_a, false);
        view.auto_contrast.insert(old_b, true);
        view
    }

    fn historical_dataset_id(url: &str) -> DatasetId {
        dataset_id_aliases(url, &SourceIdentity::parse(url).unwrap())
            .into_iter()
            .next()
            .unwrap()
    }

    async fn seed_bookmark(pool: &SqlitePool) {
        let view = two_dataset_view();
        sqlx::query(
            r#"
            INSERT INTO bookmarks
                (id, name, created_by, created_by_name, created_at, view_json)
            VALUES ('bookmark-1', 'Legacy two-dataset view', 'OWNER@EXAMPLE.TEST',
                    'Legacy Owner', '2026-06-01T12:34:56Z', ?)
            "#,
        )
        .bind(serde_json::to_string(&view).unwrap())
        .execute(pool)
        .await
        .unwrap();
        for url in [URL_A, URL_B] {
            sqlx::query(
                "INSERT INTO bookmark_datasets (bookmark_id, dataset_url) VALUES ('bookmark-1', ?)",
            )
            .bind(url)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn recovers_multi_dataset_bookmark_with_complete_remap_and_no_urls() {
        let pool = setup_pool().await;
        seed_workspace(&pool, &[(URL_A, "wds-a"), (URL_B, "wds-b")]).await;
        seed_bookmark(&pool).await;

        let outcome = recover_legacy_bookmark(
            &pool,
            RecoveryRequest {
                bookmark_id: "bookmark-1",
                workspace_id: "workspace-1",
                creator_email: None,
                visibility: RecoveryVisibility::Personal,
                apply: true,
            },
        )
        .await
        .unwrap();

        assert!(outcome.applied);
        assert!(!outcome.already_present);
        assert_eq!(outcome.saved_view_id, "bookmark-1");
        assert_eq!(outcome.dataset_mappings.len(), 2);
        let row = sqlx::query(
            r#"
            SELECT workspace_id, created_by, created_by_name, created_at,
                   updated_at, visibility, view_json
            FROM workspace_saved_views WHERE id = 'bookmark-1'
            "#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("workspace_id"), "workspace-1");
        assert_eq!(row.get::<String, _>("created_by"), "owner@example.test");
        assert_eq!(row.get::<String, _>("created_by_name"), "Current Owner");
        assert_eq!(row.get::<String, _>("visibility"), "personal");
        DateTime::parse_from_rfc3339(&row.get::<String, _>("created_at")).unwrap();
        DateTime::parse_from_rfc3339(&row.get::<String, _>("updated_at")).unwrap();

        let recovered: SavedView =
            serde_json::from_str(&row.get::<String, _>("view_json")).unwrap();
        assert!(recovered.datasets.is_empty());
        assert_eq!(
            recovered
                .active_layouts
                .keys()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            vec!["wds-a", "wds-b"]
        );
        assert_eq!(
            recovered
                .dataset_order
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            vec!["wds-b", "wds-a"]
        );
        assert_eq!(
            recovered
                .dataset_settings
                .keys()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            vec!["wds-a", "wds-b"]
        );
        assert_eq!(
            recovered
                .auto_contrast
                .keys()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            vec!["wds-a", "wds-b"]
        );
    }

    #[tokio::test]
    async fn missing_membership_fails_without_partial_saved_view() {
        let pool = setup_pool().await;
        seed_workspace(&pool, &[(URL_A, "wds-a")]).await;
        seed_bookmark(&pool).await;

        let error = recover_legacy_bookmark(
            &pool,
            RecoveryRequest {
                bookmark_id: "bookmark-1",
                workspace_id: "workspace-1",
                creator_email: None,
                visibility: RecoveryVisibility::Personal,
                apply: true,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, RecoveryError::MissingDataset { .. }));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_saved_views")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn ambiguous_membership_fails_before_remapping() {
        let identity = SourceIdentity::parse(URL_A).unwrap();
        let memberships = vec![
            WorkspaceMembership {
                workspace_dataset_id: DatasetId("wds-a1".to_string()),
                identity: identity.clone(),
            },
            WorkspaceMembership {
                workspace_dataset_id: DatasetId("wds-a2".to_string()),
                identity: identity.clone(),
            },
        ];
        let referenced = BTreeSet::from([identity.dataset_id()]);
        let error = build_strict_dataset_remap(&[URL_A.to_string()], &memberships, &referenced)
            .unwrap_err();
        assert!(matches!(error, RecoveryError::AmbiguousDataset { .. }));
    }

    #[test]
    fn recovery_plan_redacts_source_credentials_and_object_paths() {
        let raw_url = "https://user:password@example.test/private/data.zarr?token=super-secret";
        let identity = SourceIdentity::parse(raw_url).unwrap();
        let memberships = vec![WorkspaceMembership {
            workspace_dataset_id: DatasetId("wds-redacted".to_string()),
            identity: identity.clone(),
        }];
        let legacy_id = historical_dataset_id(raw_url);
        let referenced = BTreeSet::from([legacy_id.to_string()]);

        let (_, mappings) =
            build_strict_dataset_remap(&[raw_url.to_string()], &memberships, &referenced).unwrap();
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].source_hint, "https://example.test/<redacted>");
        assert_eq!(mappings[0].source_identity, identity.dataset_id());
        let json = serde_json::to_string(&mappings).unwrap();
        for secret in ["user", "password", "private", "token", "super-secret"] {
            assert!(!json.contains(secret), "recovery plan leaked {secret:?}");
        }
    }

    #[tokio::test]
    async fn dry_run_validates_but_does_not_write() {
        let pool = setup_pool().await;
        seed_workspace(&pool, &[(URL_A, "wds-a"), (URL_B, "wds-b")]).await;
        seed_bookmark(&pool).await;
        let outcome = recover_legacy_bookmark(
            &pool,
            RecoveryRequest {
                bookmark_id: "bookmark-1",
                workspace_id: "workspace-1",
                creator_email: None,
                visibility: RecoveryVisibility::Personal,
                apply: false,
            },
        )
        .await
        .unwrap();
        assert!(!outcome.applied);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_saved_views")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn shared_recovery_rejects_non_editor_creator_without_writing() {
        let pool = setup_pool().await;
        seed_workspace(&pool, &[(URL_A, "wds-a"), (URL_B, "wds-b")]).await;
        seed_bookmark(&pool).await;
        sqlx::query(
            r#"
            INSERT INTO workspace_members
                (workspace_id, email, role, display_name, added_at)
            VALUES ('workspace-1', 'viewer@example.test', 'viewer', 'Current Viewer',
                    '2026-07-01T00:00:00Z')
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let error = recover_legacy_bookmark(
            &pool,
            RecoveryRequest {
                bookmark_id: "bookmark-1",
                workspace_id: "workspace-1",
                creator_email: Some("VIEWER@example.test"),
                visibility: RecoveryVisibility::Shared,
                apply: true,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, RecoveryError::CreatorCannotShare { .. }));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_saved_views")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn exact_rerun_is_idempotent() {
        let pool = setup_pool().await;
        seed_workspace(&pool, &[(URL_A, "wds-a"), (URL_B, "wds-b")]).await;
        seed_bookmark(&pool).await;
        let request = || RecoveryRequest {
            bookmark_id: "bookmark-1",
            workspace_id: "workspace-1",
            creator_email: None,
            visibility: RecoveryVisibility::Personal,
            apply: true,
        };
        recover_legacy_bookmark(&pool, request()).await.unwrap();
        let second = recover_legacy_bookmark(&pool, request()).await.unwrap();
        assert!(second.already_present);
        assert!(!second.applied);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_saved_views")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn missing_database_path_is_not_created() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("mistyped.db");
        let error = open_existing_database(&path).await.unwrap_err();
        assert!(matches!(error, RecoveryError::DatabaseMissing));
        assert!(!path.exists());
    }

    #[test]
    fn every_recovery_error_surface_rejects_locator_shaped_values() {
        let raw = "https://user:password@example.test/private/data.zarr?X-Amz-Signature=super-secret-token";
        let diagnostic = SafeSourceDiagnostic::from_untrusted(raw);
        let errors = [
            RecoveryError::InvalidBookmarkSource {
                diagnostic: diagnostic.clone(),
            },
            RecoveryError::InvalidWorkspaceSource {
                diagnostic: diagnostic.clone(),
                issue: WorkspaceSourceIssue::UnsupportedPersistedIdentity,
                persisted_id: SafeIdentifier::dataset_source(raw),
            },
            RecoveryError::MissingDataset {
                diagnostic: diagnostic.clone(),
            },
            RecoveryError::AmbiguousDataset {
                diagnostic,
                workspace_dataset_ids: vec![SafeIdentifier::workspace_dataset(raw)],
            },
            RecoveryError::BookmarkNotFound(SafeIdentifier::generic(raw, "bookmark-id")),
            RecoveryError::WorkspaceUnavailable(SafeIdentifier::generic(raw, "workspace-id")),
            RecoveryError::MissingDatasetReference(SafeIdentifier::dataset_source(raw)),
            RecoveryError::AmbiguousDatasetReference {
                workspace_dataset_id: SafeIdentifier::workspace_dataset(raw),
                legacy_dataset_ids: vec![SafeIdentifier::dataset_source(raw)],
            },
            RecoveryError::SavedViewCollision {
                saved_view_id: SafeIdentifier::generic(raw, "saved-view-id"),
                workspace_id: SafeIdentifier::generic(raw, "workspace-id"),
            },
            RecoveryError::CreatorNotMember {
                email: SafeEmail::from_untrusted(raw),
                workspace_id: SafeIdentifier::generic(raw, "workspace-id"),
            },
            RecoveryError::CreatorCannotShare {
                email: SafeEmail::from_untrusted(raw),
                role: SafeIdentifier::generic(raw, "workspace-role"),
            },
            RecoveryError::DatabaseMissing,
            RecoveryError::Database,
            RecoveryError::InvalidBookmark(InvalidBookmarkReason::MalformedViewJson),
        ];

        for error in errors {
            let rendered = format!(
                "{error}\n{error:?}\n{}",
                serde_json::to_string(&error.envelope()).unwrap()
            );
            for secret in [
                "user",
                "password",
                "private/data.zarr",
                "X-Amz-Signature",
                "super-secret-token",
            ] {
                assert!(
                    !rendered.contains(secret),
                    "{} error leaked {secret:?}: {rendered}",
                    error.code()
                );
            }
        }
    }

    #[test]
    fn malformed_bookmark_locator_parse_context_is_discarded() {
        let malformed = "user:password/private/data.zarr?token=malformed-secret";
        assert!(SourceIdentity::parse(malformed).is_err());
        let error = build_strict_dataset_remap(&[malformed.to_string()], &[], &BTreeSet::new())
            .unwrap_err();
        assert!(matches!(error, RecoveryError::InvalidBookmarkSource { .. }));
        let rendered = format!(
            "{error}\n{error:?}\n{}",
            serde_json::to_string(&error.envelope()).unwrap()
        );
        for secret in ["user", "password", "private", "token", "malformed-secret"] {
            assert!(
                !rendered.contains(secret),
                "parse context leaked {secret:?}"
            );
        }
    }
}
