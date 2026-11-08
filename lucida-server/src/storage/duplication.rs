//! What duplicating a workspace does with each table keyed by
//! `workspace_id`.
//!
//! Each backend's `duplicate_workspace` copies a hand-written list of
//! tables, so a table added later is left out of every copy unless someone
//! thinks of it. Here every such table is copied or skipped for a stated
//! reason, and a table the schema has but the list lacks fails. The
//! conformance suite never names a table, so this lives beside it.

use std::collections::BTreeSet;

use chrono::{Duration, Utc};
use lucida_content::DatasetId;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::DocumentState;

use super::test_support::{PostgresTestDatabase, postgres_backend, sqlite_backend};
use super::{SqliteStorageBackend, StorageBackend};
use crate::inbox::NewInboxEntry;
use crate::workspace::{NewWorkspacePreview, SavedViewVisibility, WorkspaceRole};

enum OnDuplicate {
    /// The copy gets the source's rows, or the ones a copy carries.
    Copied,
    /// The copy starts with what a new workspace has, for this reason.
    Skipped(&'static str),
}

const PER_WORKSPACE_TABLES: &[(&str, OnDuplicate)] = &[
    ("workspace_datasets", OnDuplicate::Copied),
    // Shared views only; the conformance suite pins which.
    ("workspace_saved_views", OnDuplicate::Copied),
    ("workspace_previews", OnDuplicate::Copied),
    (
        "workspace_members",
        OnDuplicate::Skipped("the copy's only member is whoever made it"),
    ),
    (
        "user_workspace_state",
        OnDuplicate::Skipped("pins, recents, and last views are each member's own"),
    ),
    (
        "workspace_viewer_profiles",
        OnDuplicate::Skipped("a viewer profile is private to one member"),
    ),
    (
        "inbox_entries",
        OnDuplicate::Skipped("a report sent to a workspace stays in its inbox"),
    ),
];

/// One migrated database, with the catalog and row counts no store exposes.
enum Database {
    Sqlite(SqliteStorageBackend),
    Postgres(PostgresTestDatabase),
}

impl Database {
    fn backend(&self) -> &dyn StorageBackend {
        match self {
            Self::Sqlite(backend) => backend,
            Self::Postgres(db) => &db.backend,
        }
    }

    async fn tables_keyed_by_workspace(&self) -> BTreeSet<String> {
        let tables = match self {
            Self::Sqlite(backend) => {
                sqlx::query_scalar::<_, String>(
                    "SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) p \
                 WHERE m.type = 'table' AND p.name = 'workspace_id'",
                )
                .fetch_all(backend.pool())
                .await
            }
            Self::Postgres(db) => {
                sqlx::query_scalar::<_, String>(
                    "SELECT table_name::text FROM information_schema.columns \
                 WHERE table_schema = $1 AND column_name = 'workspace_id'",
                )
                .bind(&db.schema)
                .fetch_all(db.backend.pool())
                .await
            }
        };
        tables
            .expect("the catalog is readable")
            .into_iter()
            .collect()
    }

    async fn rows(&self, table: &str, workspace_id: &str) -> i64 {
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE workspace_id = $1");
        let count = match self {
            Self::Sqlite(backend) => {
                sqlx::query_scalar::<_, i64>(&sql)
                    .bind(workspace_id)
                    .fetch_one(backend.pool())
                    .await
            }
            Self::Postgres(db) => {
                sqlx::query_scalar::<_, i64>(&sql)
                    .bind(workspace_id)
                    .fetch_one(db.backend.pool())
                    .await
            }
        };
        count.unwrap_or_else(|e| panic!("{table} is countable by workspace: {e}"))
    }
}

fn member(email: &str) -> AuthPrincipal {
    AuthPrincipal {
        email: email.to_string(),
        display_name: format!("{email} display name"),
        picture_url: None,
        is_admin: false,
    }
}

/// A workspace with at least one row in every table keyed by it, written
/// through the stores the way the server writes them.
async fn a_workspace_with_a_row_in_every_table(
    backend: &dyn StorageBackend,
    owner: &AuthPrincipal,
    colleague: &AuthPrincipal,
) -> String {
    let workspaces = backend.workspaces();
    let id = workspaces
        .create_workspace(owner, Some("Source"))
        .await
        .unwrap()
        .id;
    workspaces
        .upsert_member(
            &id,
            &colleague.email,
            &colleague.display_name,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap()
        .unwrap();
    workspaces
        .persist_dataset_opened(
            &id,
            &DatasetId("wds-source-a".to_string()),
            "source-a",
            "file:///data/a.zarr",
            "Alpha",
            &owner.email,
            1,
            &DocumentState::default(),
        )
        .await
        .unwrap();
    workspaces
        .create_saved_view(
            &id,
            "Overview",
            owner,
            SavedView::empty([800, 600]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap()
        .unwrap();
    workspaces
        .record_workspace_open(&id, colleague)
        .await
        .unwrap();
    workspaces
        .upsert_viewer_profile(
            &id,
            colleague,
            "default",
            None,
            SavedView::empty([800, 600]),
        )
        .await
        .unwrap()
        .unwrap();
    let now = Utc::now();
    workspaces
        .put_preview(NewWorkspacePreview {
            workspace_id: &id,
            content_type: "image/webp",
            image: b"RIFF\0\xffWEBP",
            updated_by: &owner.email,
            updated_at: now,
            replaces_up_to: now,
        })
        .await
        .unwrap()
        .unwrap();
    backend
        .inbox()
        .put(NewInboxEntry {
            workspace_id: &id,
            sent_by: &colleague.email,
            sent_by_name: &colleague.display_name,
            sent_at: now,
            expires_at: now + Duration::days(14),
            header_json: "{}",
            bundle_json: "{}",
        })
        .await
        .unwrap();
    id
}

async fn every_per_workspace_table_is_copied_or_skipped(db: Database) {
    let classified: BTreeSet<String> = PER_WORKSPACE_TABLES
        .iter()
        .map(|(table, _)| (*table).to_string())
        .collect();
    assert_eq!(
        db.tables_keyed_by_workspace().await,
        classified,
        "every table keyed by workspace_id needs a line in PER_WORKSPACE_TABLES \
         saying whether duplicating a workspace copies it",
    );

    let owner = member("owner@example.com");
    let colleague = member("colleague@example.com");
    let source = a_workspace_with_a_row_in_every_table(db.backend(), &owner, &colleague).await;
    for (table, _) in PER_WORKSPACE_TABLES {
        assert!(
            db.rows(table, &source).await > 0,
            "the source needs a row in {table}, or nothing here sees what a copy does with it",
        );
    }

    let workspaces = db.backend().workspaces();
    let copy = workspaces
        .duplicate_workspace(&source, &colleague, "Copy of Source")
        .await
        .unwrap()
        .unwrap();
    let blank = workspaces
        .create_workspace(&colleague, Some("Blank"))
        .await
        .unwrap();
    for (table, on_duplicate) in PER_WORKSPACE_TABLES {
        let copied = db.rows(table, &copy.id).await;
        match on_duplicate {
            OnDuplicate::Copied => assert!(copied > 0, "a duplicate copies {table}"),
            OnDuplicate::Skipped(reason) => assert_eq!(
                copied,
                db.rows(table, &blank.id).await,
                "a duplicate skips {table}, because {reason}",
            ),
        }
    }
}

#[tokio::test]
async fn on_sqlite() {
    every_per_workspace_table_is_copied_or_skipped(Database::Sqlite(sqlite_backend().await)).await;
}

#[tokio::test]
async fn on_postgres() {
    if let Some(db) = postgres_backend().await {
        every_per_workspace_table_is_copied_or_skipped(Database::Postgres(db)).await;
    }
}
