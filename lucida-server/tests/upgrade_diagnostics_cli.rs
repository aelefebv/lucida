//! Real-binary regression coverage for upgrade/recovery diagnostics.
//!
//! These tests intentionally seed credentialed, signed locator-shaped values
//! and inspect both process streams. Unit tests cannot catch Rust's top-level
//! `Error: Custom` rendering or a tracing call that accidentally formats a raw
//! database value.

use std::path::Path;
use std::process::Command;

use lucida_core::saved_view::SavedView;
use lucida_server::auth::SqliteSessionStore;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

const BIN: &str = env!("CARGO_BIN_EXE_lucida-server");
const SECRET_SOURCE: &str =
    "https://user:password@example.test/private/data.zarr?X-Amz-Signature=super-secret-token";
const SECRET_ID: &str = "https://id-user:id-password@example.test/private-id?token=id-secret";

fn clean_command() -> Command {
    let mut command = Command::new(BIN);
    command
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("RUST_LOG", "off");
    command
}

fn assert_streams_do_not_contain_secrets(stdout: &[u8], stderr: &[u8]) {
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    );
    for secret in [
        SECRET_SOURCE,
        SECRET_ID,
        "user:password",
        "private/data.zarr",
        "X-Amz-Signature",
        "super-secret-token",
        "id-user:id-password",
        "private-id",
        "id-secret",
    ] {
        assert!(
            !combined.contains(secret),
            "process output leaked {secret:?}"
        );
    }
}

async fn seed_recovery_database(path: &Path) {
    let store = SqliteSessionStore::open(path).await.unwrap();
    sqlx::query(
        r#"
        INSERT INTO workspaces
            (id, name, created_by, created_at, updated_at, seq, document_json)
        VALUES ('workspace-1', 'Recovery target', 'owner@example.test',
                '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 0, '{}')
        "#,
    )
    .execute(store.pool())
    .await
    .unwrap();
    let mut view = SavedView::empty([1600, 900]);
    view.datasets = vec![SECRET_SOURCE.to_string()];
    sqlx::query(
        r#"
        INSERT INTO bookmarks
            (id, name, created_by, created_by_name, created_at, view_json)
        VALUES ('bookmark-1', 'Credentialed legacy view', 'owner@example.test',
                'Owner', '2026-07-01T00:00:00Z', ?)
        "#,
    )
    .bind(serde_json::to_string(&view).unwrap())
    .execute(store.pool())
    .await
    .unwrap();
    store.pool().close().await;
}

#[tokio::test]
async fn recovery_json_failure_is_one_document_on_stdout_and_never_leaks() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("recovery.sqlite3");
    seed_recovery_database(&db_path).await;

    let output = clean_command()
        .args([
            "recover-legacy-bookmark",
            "--db-path",
            db_path.to_str().unwrap(),
            "--bookmark",
            "bookmark-1",
            "--workspace",
            "workspace-1",
            "--json",
        ])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(
        output.stderr.is_empty(),
        "stderr must be empty in JSON mode"
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count(),
        1,
        "JSON failure must contain exactly one document"
    );
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(document["ok"], false);
    assert_eq!(document["error"]["code"], "missing_dataset");
    assert_eq!(
        document["error"]["source"]["hint"],
        "https://example.test/<redacted>"
    );
    assert!(
        document["error"]["source"]["fingerprint"]
            .as_str()
            .unwrap()
            .starts_with("ds-")
    );
    assert_streams_do_not_contain_secrets(&output.stdout, &output.stderr);

    let text_output = clean_command()
        .args([
            "recover-legacy-bookmark",
            "--db-path",
            db_path.to_str().unwrap(),
            "--bookmark",
            "bookmark-1",
            "--workspace",
            "workspace-1",
        ])
        .output()
        .unwrap();
    assert!(!text_output.status.success());
    assert!(
        text_output.stdout.is_empty(),
        "text failures use stderr only"
    );
    assert!(
        String::from_utf8_lossy(&text_output.stderr)
            .starts_with("legacy bookmark recovery failed: ")
    );
    assert_streams_do_not_contain_secrets(&text_output.stdout, &text_output.stderr);
}

#[tokio::test]
async fn startup_migration_failure_is_safe_and_leaves_database_unchanged() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("upgrade.sqlite3");
    let store = SqliteSessionStore::open(&db_path).await.unwrap();
    sqlx::query("DELETE FROM lucida_data_migrations WHERE name = ?")
        .bind("dataset-source-identities/full-blake3-v2")
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO dataset_sources
            (id, canonical_url, default_name, created_at, updated_at)
        VALUES (?, ?, 'Unsafe upgrade fixture',
                '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')
        "#,
    )
    .bind(SECRET_ID)
    .bind(SECRET_SOURCE)
    .execute(store.pool())
    .await
    .unwrap();
    store.pool().close().await;

    let output = clean_command()
        .env("RUST_LOG", "lucida_server=info")
        .env("LUCIDA_LOG_FORMAT", "json")
        .env("LUCIDA_DB_PATH", &db_path)
        .env("LUCIDA_AUTH", "disabled")
        .env("LUCIDA_BIND", "127.0.0.1:0")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_streams_do_not_contain_secrets(&output.stdout, &output.stderr);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("unsupported_source_identity"));
    assert!(stderr.contains("https://example.test/<redacted>"));

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT canonical_url FROM dataset_sources")
            .fetch_one(&pool)
            .await
            .unwrap(),
        SECRET_SOURCE
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT id FROM dataset_sources")
            .fetch_one(&pool)
            .await
            .unwrap(),
        SECRET_ID
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM lucida_data_migrations WHERE name = ?",)
            .bind("dataset-source-identities/full-blake3-v2")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}
