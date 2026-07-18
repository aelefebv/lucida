//! Transactional upgrade of persisted dataset-source identities.
//!
//! Lucida's released workspace schema stored source ids using the first eight
//! BLAKE3 bytes of the canonical locator. The typed source-identity boundary
//! now uses the full digest. SQLite cannot calculate BLAKE3 in a declarative
//! migration, so startup performs this data migration before
//! any workspace store is exposed to request handling.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

use chrono::Utc;
use lucida_content::url::SourceIdentity;
use sqlx::{Row, SqlitePool};
use thiserror::Error;

use crate::source_policy::SafeSourceDiagnostic;

pub(crate) const SOURCE_IDENTITY_V2_MIGRATION: &str = "dataset-source-identities/full-blake3-v2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourceIdentityMigrationReport {
    pub(crate) sources_updated: usize,
    pub(crate) memberships_rekeyed: u64,
    pub(crate) already_recorded: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SafeMigrationIdentifier(String);

impl SafeMigrationIdentifier {
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
        let valid = raw.strip_prefix("wds-").is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix.len() <= 128
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        });
        Self::validated_or_fingerprint(raw, valid, "workspace-dataset-id")
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

    #[cfg(test)]
    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SafeMigrationIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SafeMigrationIdentifier")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for SafeMigrationIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Error)]
pub(crate) enum SourceIdentityMigrationError {
    #[error("database operation failed")]
    Database,
    #[error("dataset source {persisted_id} has invalid canonical locator {diagnostic}")]
    InvalidSource {
        persisted_id: SafeMigrationIdentifier,
        diagnostic: SafeSourceDiagnostic,
    },
    #[error(
        "dataset source {persisted_id} does not match a released identity generation for {diagnostic}; expected canonical id {expected_id}"
    )]
    UnsupportedSourceIdentity {
        persisted_id: SafeMigrationIdentifier,
        diagnostic: SafeSourceDiagnostic,
        expected_id: SafeMigrationIdentifier,
    },
    #[error(
        "dataset sources {source_ids:?} collapse onto canonical identity {target_id}; refusing to merge workspace memberships"
    )]
    IdentityCollision {
        target_id: SafeMigrationIdentifier,
        source_ids: Vec<SafeMigrationIdentifier>,
    },
    #[error(
        "dataset source {source_id} must become {target_id}, but that id is occupied by another source"
    )]
    TargetOccupied {
        source_id: SafeMigrationIdentifier,
        target_id: SafeMigrationIdentifier,
    },
    #[error(
        "workspace dataset {workspace_dataset_id} references missing dataset source {dataset_source_id}"
    )]
    OrphanedMembership {
        workspace_dataset_id: SafeMigrationIdentifier,
        dataset_source_id: SafeMigrationIdentifier,
    },
    #[error("dataset source {source_id} changed {actual} rows during rekey; expected exactly one")]
    UnexpectedSourceUpdate {
        source_id: SafeMigrationIdentifier,
        actual: u64,
    },
    #[error(
        "dataset source {source_id} changed {actual} workspace memberships during rekey; expected {expected}"
    )]
    UnexpectedMembershipUpdate {
        source_id: SafeMigrationIdentifier,
        expected: u64,
        actual: u64,
    },
}

impl From<sqlx::Error> for SourceIdentityMigrationError {
    fn from(_error: sqlx::Error) -> Self {
        Self::Database
    }
}

impl SourceIdentityMigrationError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Database => "database_error",
            Self::InvalidSource { .. } => "invalid_source_locator",
            Self::UnsupportedSourceIdentity { .. } => "unsupported_source_identity",
            Self::IdentityCollision { .. } => "source_identity_collision",
            Self::TargetOccupied { .. } => "source_identity_target_occupied",
            Self::OrphanedMembership { .. } => "orphaned_workspace_dataset",
            Self::UnexpectedSourceUpdate { .. } => "unexpected_source_update",
            Self::UnexpectedMembershipUpdate { .. } => "unexpected_membership_update",
        }
    }
}

struct SourceRekey {
    old_id: String,
    target_id: String,
    old_url: String,
    target_url: String,
}

/// Return every explicitly supported persisted id for `raw_url`.
///
/// The released short-id code hashed its argument without normalizing it.
/// Most persistence callers supplied an already canonical locator, but old
/// bookmark rows could retain the user's original spelling. Keeping both the
/// raw and normalized short forms here gives recovery and startup migration a
/// single compatibility definition. The current full digest is always last.
pub(crate) fn supported_dataset_id_aliases(
    raw_url: &str,
    identity: &SourceIdentity,
) -> Vec<String> {
    let mut aliases = Vec::with_capacity(3);
    for candidate in [
        legacy_short_dataset_id(raw_url),
        legacy_short_dataset_id(identity.locator.as_str()),
        identity.dataset_id(),
    ] {
        if !aliases.contains(&candidate) {
            aliases.push(candidate);
        }
    }
    aliases
}

/// Exact identity algorithm shipped before full-digest source ids.
pub(crate) fn legacy_short_dataset_id(url: &str) -> String {
    let digest = blake3::hash(url.as_bytes());
    let prefix: [u8; 8] = digest.as_bytes()[..8]
        .try_into()
        .expect("BLAKE3 digest is always at least 8 bytes");
    format!("ds-{:016x}", u64::from_le_bytes(prefix))
}

/// Validate, canonicalize, and rekey every persisted dataset source in one
/// transaction.
///
/// All rows and references are planned before the first update. Equivalent
/// locators that would collapse to one full identity are treated as an
/// operator-visible collision: choosing which source or workspace-local
/// membership survives would silently discard provenance, so startup fails
/// with the database untouched. Workspace-local `wds-*` ids are never edited.
pub(crate) async fn migrate_dataset_source_identities(
    pool: &SqlitePool,
) -> Result<SourceIdentityMigrationReport, SourceIdentityMigrationError> {
    let mut tx = pool.begin().await?;
    // Rekeying a referenced primary key necessarily creates a short-lived
    // mismatch inside the transaction. Defer the FK check until commit, after
    // every workspace reference has moved with its source.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;

    let already_recorded: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM lucida_data_migrations WHERE name = ?)")
            .bind(SOURCE_IDENTITY_V2_MIGRATION)
            .fetch_one(&mut *tx)
            .await?;

    let rows =
        sqlx::query("SELECT id, canonical_url FROM dataset_sources ORDER BY id, canonical_url")
            .fetch_all(&mut *tx)
            .await?;

    let mut source_ids = HashSet::with_capacity(rows.len());
    let mut targets: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut rekeys = Vec::new();
    for row in rows {
        let source_id: String = row.try_get("id")?;
        let canonical_url: String = row.try_get("canonical_url")?;
        let source = SafeSourceDiagnostic::from_untrusted(&canonical_url);
        let persisted_id = SafeMigrationIdentifier::dataset_source(&source_id);
        let identity = SourceIdentity::parse(&canonical_url).map_err(|_| {
            SourceIdentityMigrationError::InvalidSource {
                persisted_id: persisted_id.clone(),
                diagnostic: source.clone(),
            }
        })?;
        let supported_ids = supported_dataset_id_aliases(&canonical_url, &identity);
        if !supported_ids.contains(&source_id) {
            return Err(SourceIdentityMigrationError::UnsupportedSourceIdentity {
                persisted_id,
                diagnostic: source,
                expected_id: SafeMigrationIdentifier::dataset_source(&identity.dataset_id()),
            });
        }

        let target_id = identity.dataset_id();
        source_ids.insert(source_id.clone());
        targets
            .entry(target_id.clone())
            .or_default()
            .push(source_id.clone());
        rekeys.push(SourceRekey {
            old_id: source_id,
            target_id,
            old_url: canonical_url,
            target_url: identity.locator.into_string(),
        });
    }

    if let Some((target_id, colliding)) = targets
        .into_iter()
        .find(|(_, source_ids)| source_ids.len() > 1)
    {
        return Err(SourceIdentityMigrationError::IdentityCollision {
            target_id: SafeMigrationIdentifier::dataset_source(&target_id),
            source_ids: colliding
                .iter()
                .map(|id| SafeMigrationIdentifier::dataset_source(id))
                .collect(),
        });
    }
    if let Some(rekey) = rekeys
        .iter()
        .find(|rekey| rekey.old_id != rekey.target_id && source_ids.contains(&rekey.target_id))
    {
        return Err(SourceIdentityMigrationError::TargetOccupied {
            source_id: SafeMigrationIdentifier::dataset_source(&rekey.old_id),
            target_id: SafeMigrationIdentifier::dataset_source(&rekey.target_id),
        });
    }

    let membership_rows = sqlx::query(
        r#"
        SELECT id, dataset_source_id
        FROM workspace_datasets
        ORDER BY id, dataset_source_id
        "#,
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut membership_counts: HashMap<String, u64> = HashMap::new();
    for row in membership_rows {
        let workspace_dataset_id: String = row.try_get("id")?;
        let dataset_source_id: String = row.try_get("dataset_source_id")?;
        if !source_ids.contains(&dataset_source_id) {
            return Err(SourceIdentityMigrationError::OrphanedMembership {
                workspace_dataset_id: SafeMigrationIdentifier::workspace_dataset(
                    &workspace_dataset_id,
                ),
                dataset_source_id: SafeMigrationIdentifier::dataset_source(&dataset_source_id),
            });
        }
        *membership_counts.entry(dataset_source_id).or_default() += 1;
    }

    let mut sources_updated = 0;
    let mut memberships_rekeyed = 0;
    for rekey in rekeys
        .iter()
        .filter(|rekey| rekey.old_id != rekey.target_id || rekey.old_url != rekey.target_url)
    {
        let source_result = sqlx::query(
            r#"
            UPDATE dataset_sources
            SET id = ?, canonical_url = ?
            WHERE id = ? AND canonical_url = ?
            "#,
        )
        .bind(&rekey.target_id)
        .bind(&rekey.target_url)
        .bind(&rekey.old_id)
        .bind(&rekey.old_url)
        .execute(&mut *tx)
        .await?;
        if source_result.rows_affected() != 1 {
            return Err(SourceIdentityMigrationError::UnexpectedSourceUpdate {
                source_id: SafeMigrationIdentifier::dataset_source(&rekey.old_id),
                actual: source_result.rows_affected(),
            });
        }

        if rekey.old_id != rekey.target_id {
            let expected_memberships = membership_counts.get(&rekey.old_id).copied().unwrap_or(0);
            let membership_result = sqlx::query(
                "UPDATE workspace_datasets SET dataset_source_id = ? WHERE dataset_source_id = ?",
            )
            .bind(&rekey.target_id)
            .bind(&rekey.old_id)
            .execute(&mut *tx)
            .await?;
            if membership_result.rows_affected() != expected_memberships {
                return Err(SourceIdentityMigrationError::UnexpectedMembershipUpdate {
                    source_id: SafeMigrationIdentifier::dataset_source(&rekey.old_id),
                    expected: expected_memberships,
                    actual: membership_result.rows_affected(),
                });
            }
            memberships_rekeyed += membership_result.rows_affected();
        }

        sources_updated += 1;
    }

    sqlx::query(
        r#"
        INSERT INTO lucida_data_migrations (name, applied_at)
        VALUES (?, ?)
        ON CONFLICT(name) DO NOTHING
        "#,
    )
    .bind(SOURCE_IDENTITY_V2_MIGRATION)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(SourceIdentityMigrationReport {
        sources_updated,
        memberships_rekeyed,
        already_recorded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::url::SourceRevision;

    use crate::auth::SqliteSessionStore;
    use crate::workspace::store::{SqliteWorkspaceStore, WorkspaceStore};

    const WORKSPACE_ID: &str = "workspace-upgrade-test";
    const CANONICAL_URL: &str = "https://data.example.test/sets/legacy.zarr";
    const RAW_LEGACY_URL: &str = "HTTPS://data.example.test/sets/legacy.zarr";
    const SECOND_CANONICAL_URL: &str = "s3://upgrade-test/second-legacy.zarr";

    async fn remove_marker(pool: &SqlitePool) {
        sqlx::query("DELETE FROM lucida_data_migrations WHERE name = ?")
            .bind(SOURCE_IDENTITY_V2_MIGRATION)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn seed_workspace(pool: &SqlitePool) {
        sqlx::query(
            r#"
            INSERT INTO workspaces
                (id, name, created_by, created_at, updated_at, seq, document_json)
            VALUES (?, 'Upgrade fixture', 'owner@example.test',
                    '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 0, '{}')
            "#,
        )
        .bind(WORKSPACE_ID)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_source(
        pool: &SqlitePool,
        source_id: &str,
        canonical_url: &str,
        workspace_dataset_id: Option<&str>,
    ) {
        sqlx::query(
            r#"
            INSERT INTO dataset_sources
                (id, canonical_url, default_name, created_at, updated_at)
            VALUES (?, ?, 'Legacy source',
                    '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')
            "#,
        )
        .bind(source_id)
        .bind(canonical_url)
        .execute(pool)
        .await
        .unwrap();

        if let Some(workspace_dataset_id) = workspace_dataset_id {
            let revision = SourceRevision::from_bytes(b"pre-upgrade-source-revision").as_hex();
            sqlx::query(
                r#"
                INSERT INTO workspace_datasets
                    (id, workspace_id, dataset_source_id, source_revision,
                     display_name, added_by, added_at, sort_order)
                VALUES (?, ?, ?, ?, 'Workspace-local name', 'owner@example.test',
                        '2026-07-03T00:00:00Z', 7)
                "#,
            )
            .bind(workspace_dataset_id)
            .bind(WORKSPACE_ID)
            .bind(source_id)
            .bind(revision)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn opening_pre_upgrade_file_normalizes_and_rekeys_without_changing_workspace_ids() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("lucida.sqlite3");
        let store = SqliteSessionStore::open(&db_path).await.unwrap();
        seed_workspace(store.pool()).await;
        remove_marker(store.pool()).await;
        let legacy_id = legacy_short_dataset_id(RAW_LEGACY_URL);
        let second_legacy_id = legacy_short_dataset_id(SECOND_CANONICAL_URL);
        seed_source(store.pool(), &legacy_id, RAW_LEGACY_URL, Some("wds-stable")).await;
        seed_source(
            store.pool(),
            &second_legacy_id,
            SECOND_CANONICAL_URL,
            Some("wds-stable-second"),
        )
        .await;
        store.pool().close().await;
        drop(store);

        let reopened = SqliteSessionStore::open(&db_path).await.unwrap();
        let expected_id = SourceIdentity::parse(CANONICAL_URL).unwrap().dataset_id();
        let second_expected_id = SourceIdentity::parse(SECOND_CANONICAL_URL)
            .unwrap()
            .dataset_id();
        let source_row = sqlx::query(
            r#"
            SELECT id, canonical_url, default_name, created_at, updated_at
            FROM dataset_sources
            WHERE canonical_url = ?
            "#,
        )
        .bind(CANONICAL_URL)
        .fetch_one(reopened.pool())
        .await
        .unwrap();
        assert_eq!(source_row.get::<String, _>("id"), expected_id);
        assert_eq!(source_row.get::<String, _>("canonical_url"), CANONICAL_URL);
        assert_eq!(source_row.get::<String, _>("default_name"), "Legacy source");
        assert_eq!(
            source_row.get::<String, _>("created_at"),
            "2026-07-01T00:00:00Z"
        );
        assert_eq!(
            source_row.get::<String, _>("updated_at"),
            "2026-07-02T00:00:00Z"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM dataset_sources WHERE id = ?")
                .bind(&legacy_id)
                .fetch_one(reopened.pool())
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT id FROM dataset_sources WHERE canonical_url = ?",
            )
            .bind(SECOND_CANONICAL_URL)
            .fetch_one(reopened.pool())
            .await
            .unwrap(),
            second_expected_id
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM dataset_sources WHERE id = ?")
                .bind(&second_legacy_id)
                .fetch_one(reopened.pool())
                .await
                .unwrap(),
            0
        );

        let membership = sqlx::query(
            r#"
            SELECT id, dataset_source_id, source_revision, display_name, sort_order
            FROM workspace_datasets
            WHERE id = 'wds-stable'
            "#,
        )
        .fetch_one(reopened.pool())
        .await
        .unwrap();
        assert_eq!(membership.get::<String, _>("id"), "wds-stable");
        assert_eq!(
            membership.get::<String, _>("dataset_source_id"),
            expected_id
        );
        assert_eq!(
            membership.get::<String, _>("source_revision"),
            SourceRevision::from_bytes(b"pre-upgrade-source-revision").as_hex()
        );
        assert_eq!(
            membership.get::<String, _>("display_name"),
            "Workspace-local name"
        );
        assert_eq!(membership.get::<i64, _>("sort_order"), 7);
        let second_membership_source: String = sqlx::query_scalar(
            "SELECT dataset_source_id FROM workspace_datasets WHERE id = 'wds-stable-second'",
        )
        .fetch_one(reopened.pool())
        .await
        .unwrap();
        assert_eq!(second_membership_source, second_expected_id);

        // Exercise the typed production persistence boundary: migration must
        // make the stricter `SourceIdentity::from_persisted` mapper succeed.
        let workspace_store = SqliteWorkspaceStore::new(reopened.pool().clone());
        let listed = workspace_store
            .list_dataset_sources(WORKSPACE_ID)
            .await
            .unwrap();
        assert_eq!(listed.len(), 2);
        let mut listed_ids: Vec<_> = listed
            .iter()
            .map(|source| {
                (
                    source.workspace_dataset_id.to_string(),
                    source.identity.dataset_id(),
                )
            })
            .collect();
        listed_ids.sort();
        assert_eq!(
            listed_ids,
            vec![
                ("wds-stable".to_string(), expected_id.clone()),
                ("wds-stable-second".to_string(), second_expected_id.clone(),),
            ]
        );

        reopened.pool().close().await;
        drop(reopened);
        let reopened_again = SqliteSessionStore::open(&db_path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM lucida_data_migrations WHERE name = ?",
            )
            .bind(SOURCE_IDENTITY_V2_MIGRATION)
            .fetch_one(reopened_again.pool())
            .await
            .unwrap(),
            1
        );
        let persisted_source_ids: Vec<String> =
            sqlx::query_scalar("SELECT id FROM dataset_sources ORDER BY id")
                .fetch_all(reopened_again.pool())
                .await
                .unwrap();
        let mut expected_source_ids = vec![expected_id, second_expected_id];
        expected_source_ids.sort();
        assert_eq!(persisted_source_ids, expected_source_ids);
        let persisted_workspace_ids: Vec<String> =
            sqlx::query_scalar("SELECT id FROM workspace_datasets ORDER BY id")
                .fetch_all(reopened_again.pool())
                .await
                .unwrap();
        assert_eq!(
            persisted_workspace_ids,
            vec!["wds-stable".to_string(), "wds-stable-second".to_string(),]
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM dataset_sources WHERE canonical_url = ?",
            )
            .bind(CANONICAL_URL)
            .fetch_one(reopened_again.pool())
            .await
            .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn equivalent_locator_collision_fails_without_merging_rows() {
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
        remove_marker(store.pool()).await;
        let raw_url = "HTTP://data.example.test/sets/collision.zarr";
        let canonical_url = "http://data.example.test/sets/collision.zarr";
        let raw_legacy_id = legacy_short_dataset_id(raw_url);
        let target_id = SourceIdentity::parse(canonical_url).unwrap().dataset_id();
        seed_source(store.pool(), &raw_legacy_id, raw_url, None).await;
        seed_source(store.pool(), &target_id, canonical_url, None).await;

        let error = migrate_dataset_source_identities(store.pool())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            SourceIdentityMigrationError::IdentityCollision { target_id: ref collision_target, .. }
                if collision_target.as_str() == target_id
        ));
        let persisted_ids: Vec<String> =
            sqlx::query_scalar("SELECT id FROM dataset_sources ORDER BY id")
                .fetch_all(store.pool())
                .await
                .unwrap();
        let mut expected = vec![raw_legacy_id, target_id];
        expected.sort();
        assert_eq!(persisted_ids, expected);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM lucida_data_migrations WHERE name = ?",
            )
            .bind(SOURCE_IDENTITY_V2_MIGRATION)
            .fetch_one(store.pool())
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn invalid_row_aborts_before_any_valid_legacy_row_is_changed() {
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
        remove_marker(store.pool()).await;
        let valid_url = "s3://upgrade-test/valid.zarr";
        let valid_legacy_id = legacy_short_dataset_id(valid_url);
        seed_source(store.pool(), &valid_legacy_id, valid_url, None).await;
        seed_source(
            store.pool(),
            "ds-not-a-released-identity",
            "s3://upgrade-test/invalid.zarr",
            None,
        )
        .await;

        let error = migrate_dataset_source_identities(store.pool())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            SourceIdentityMigrationError::UnsupportedSourceIdentity { .. }
        ));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM dataset_sources WHERE id = ?")
                .bind(&valid_legacy_id)
                .fetch_one(store.pool())
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM lucida_data_migrations WHERE name = ?",
            )
            .bind(SOURCE_IDENTITY_V2_MIGRATION)
            .fetch_one(store.pool())
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn current_full_id_with_raw_locator_is_normalized_once() {
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
        remove_marker(store.pool()).await;
        let raw_url = "HTTPS://data.example.test/sets/current-id.zarr";
        let identity = SourceIdentity::parse(raw_url).unwrap();
        let current_id = identity.dataset_id();
        seed_source(store.pool(), &current_id, raw_url, None).await;

        let first = migrate_dataset_source_identities(store.pool())
            .await
            .unwrap();
        assert_eq!(first.sources_updated, 1);
        assert_eq!(first.memberships_rekeyed, 0);
        assert!(!first.already_recorded);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT canonical_url FROM dataset_sources")
                .fetch_one(store.pool())
                .await
                .unwrap(),
            identity.locator.as_str()
        );

        let second = migrate_dataset_source_identities(store.pool())
            .await
            .unwrap();
        assert_eq!(second.sources_updated, 0);
        assert_eq!(second.memberships_rekeyed, 0);
        assert!(second.already_recorded);
    }

    #[tokio::test]
    async fn orphaned_workspace_membership_fails_without_recording_migration() {
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
        remove_marker(store.pool()).await;
        // Reproduce a database imported while FK enforcement was disabled.
        // Startup must diagnose it rather than let an INNER JOIN hide the row.
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(store.pool())
            .await
            .unwrap();
        sqlx::query(
            r#"
            INSERT INTO workspace_datasets
                (id, workspace_id, dataset_source_id, display_name,
                 added_by, added_at, sort_order)
            VALUES ('wds-orphan', 'workspace-missing', 'ds-source-missing',
                    'Orphan', 'owner@example.test', '2026-07-03T00:00:00Z', 0)
            "#,
        )
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(store.pool())
            .await
            .unwrap();

        let error = migrate_dataset_source_identities(store.pool())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            SourceIdentityMigrationError::OrphanedMembership {
                ref workspace_dataset_id,
                ref dataset_source_id,
            } if workspace_dataset_id.as_str() == "wds-orphan"
                && dataset_source_id.as_str().starts_with("dataset-source-id-blake3-")
        ));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM lucida_data_migrations WHERE name = ?",
            )
            .bind(SOURCE_IDENTITY_V2_MIGRATION)
            .fetch_one(store.pool())
            .await
            .unwrap(),
            0
        );
    }

    #[test]
    fn aliases_cover_raw_and_normalized_released_ids_before_current_id() {
        let raw = "HTTPS://data.example.test/sets/alias.zarr";
        let identity = SourceIdentity::parse(raw).unwrap();
        let aliases = supported_dataset_id_aliases(raw, &identity);
        assert_eq!(aliases[0], legacy_short_dataset_id(raw));
        assert_eq!(
            aliases[1],
            legacy_short_dataset_id(identity.locator.as_str())
        );
        assert_eq!(aliases.last().unwrap(), &identity.dataset_id());
    }

    #[tokio::test]
    async fn migration_errors_never_format_raw_locator_or_unvalidated_id() {
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
        remove_marker(store.pool()).await;
        let raw_url = "https://user:password@example.test/private/data.zarr?X-Amz-Signature=super-secret-token";
        let raw_id = "https://id-user:id-password@example.test/private-id?token=id-secret";
        seed_source(store.pool(), raw_id, raw_url, None).await;

        let error = migrate_dataset_source_identities(store.pool())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            SourceIdentityMigrationError::UnsupportedSourceIdentity { .. }
        ));
        let rendered = format!("{error}\n{error:?}");
        for secret in [
            "user",
            "password",
            "private/data.zarr",
            "X-Amz-Signature",
            "super-secret-token",
            "id-user",
            "id-password",
            "private-id",
            "id-secret",
        ] {
            assert!(
                !rendered.contains(secret),
                "migration error leaked {secret:?}"
            );
        }
        assert!(rendered.contains("https://example.test/<redacted>"));
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT canonical_url FROM dataset_sources")
                .fetch_one(store.pool())
                .await
                .unwrap(),
            raw_url
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM lucida_data_migrations WHERE name = ?",
            )
            .bind(SOURCE_IDENTITY_V2_MIGRATION)
            .fetch_one(store.pool())
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn invalid_locator_parse_context_is_discarded_without_writes() {
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
        remove_marker(store.pool()).await;
        let malformed = "user:password/private/data.zarr?token=malformed-secret";
        assert!(SourceIdentity::parse(malformed).is_err());
        let source_id = legacy_short_dataset_id(malformed);
        seed_source(store.pool(), &source_id, malformed, None).await;

        let error = migrate_dataset_source_identities(store.pool())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            SourceIdentityMigrationError::InvalidSource { .. }
        ));
        let rendered = format!("{error}\n{error:?}");
        for secret in ["user", "password", "private", "token", "malformed-secret"] {
            assert!(
                !rendered.contains(secret),
                "parse context leaked {secret:?}"
            );
        }
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT canonical_url FROM dataset_sources")
                .fetch_one(store.pool())
                .await
                .unwrap(),
            malformed
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM lucida_data_migrations WHERE name = ?",
            )
            .bind(SOURCE_IDENTITY_V2_MIGRATION)
            .fetch_one(store.pool())
            .await
            .unwrap(),
            0
        );
    }
}
