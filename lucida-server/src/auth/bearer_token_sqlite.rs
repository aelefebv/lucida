//! SQLite-backed bearer-token store.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use super::bearer_token::{BearerToken, BearerTokenStore, BearerTokenStoreError};
use crate::persistence::{PersistenceDeadline, PersistenceOperation, PersistenceWorkerOutcome};

#[derive(Debug, Clone)]
pub struct SqliteBearerTokenStore {
    pool: SqlitePool,
}

impl SqliteBearerTokenStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn map_err(e: sqlx::Error) -> BearerTokenStoreError {
    BearerTokenStoreError::Backend(e.to_string())
}

fn row_to_token(row: sqlx::sqlite::SqliteRow) -> BearerToken {
    BearerToken {
        id: row.get("id"),
        token_hash: row.get("token_hash"),
        name: row.get("name"),
        email: row.get("email"),
        display_name: row.get("display_name"),
        picture_url: row.get("picture_url"),
        created_at: row.get("created_at"),
        last_used_at: row.get("last_used_at"),
        expires_at: row.get("expires_at"),
        revoked_at: row.get("revoked_at"),
    }
}

#[async_trait]
impl BearerTokenStore for SqliteBearerTokenStore {
    fn begin_revoke_by_hash(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> PersistenceOperation<Option<BearerToken>, BearerTokenStoreError> {
        let store = self.clone();
        let token_hash = token_hash.to_string();
        let pool = self.pool.clone();
        PersistenceOperation::spawn(
            PersistenceDeadline::default(),
            async move {
                match store.revoke_by_hash(&token_hash, now).await {
                    Ok(row) => PersistenceWorkerOutcome::Committed(row),
                    Err(error) => PersistenceWorkerOutcome::RecoverablyIndeterminate(error),
                }
            },
            move || async move { sqlite_write_quiescence_barrier(&pool).await },
        )
    }

    async fn create(&self, token: BearerToken) -> Result<(), BearerTokenStoreError> {
        sqlx::query(
            r#"
            INSERT INTO bearer_tokens
                (id, token_hash, name, email, display_name, picture_url,
                 created_at, last_used_at, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&token.id)
        .bind(&token.token_hash)
        .bind(&token.name)
        .bind(&token.email)
        .bind(&token.display_name)
        .bind(&token.picture_url)
        .bind(token.created_at)
        .bind(token.last_used_at)
        .bind(token.expires_at)
        .bind(token.revoked_at)
        .execute(&self.pool)
        .await
        .map_err(map_err)?;
        Ok(())
    }

    async fn get_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<BearerToken>, BearerTokenStoreError> {
        let row = sqlx::query(
            r#"
            SELECT id, token_hash, name, email, display_name, picture_url,
                   created_at, last_used_at, expires_at, revoked_at
            FROM bearer_tokens
            WHERE token_hash = ?
            "#,
        )
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_err)?;

        Ok(row.map(row_to_token))
    }

    async fn touch_last_used(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), BearerTokenStoreError> {
        sqlx::query("UPDATE bearer_tokens SET last_used_at = ? WHERE id = ?")
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(())
    }

    async fn revoke_by_hash(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<BearerToken>, BearerTokenStoreError> {
        let row = sqlx::query(
            r#"
            UPDATE bearer_tokens
            SET revoked_at = ?
            WHERE token_hash = ? AND revoked_at IS NULL
            RETURNING id, token_hash, name, email, display_name, picture_url,
                      created_at, last_used_at, expires_at, revoked_at
            "#,
        )
        .bind(now)
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_err)?;

        Ok(row.map(row_to_token))
    }
}

async fn sqlite_write_quiescence_barrier(pool: &SqlitePool) -> bool {
    let Ok(mut connection) = pool.acquire().await else {
        return false;
    };
    if sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .is_err()
    {
        return false;
    }
    sqlx::query("ROLLBACK")
        .execute(&mut *connection)
        .await
        .is_ok()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::auth::bearer_token::hash_bearer_token;
    use crate::auth::session_store_sqlite::SqliteSessionStore;
    use tokio::sync::Barrier;

    fn sample(id: &str) -> BearerToken {
        let now = Utc::now();
        BearerToken {
            id: id.to_string(),
            token_hash: hash_bearer_token(id),
            name: "test token".to_string(),
            email: "dev@local".to_string(),
            display_name: "Local Dev".to_string(),
            picture_url: None,
            created_at: now,
            last_used_at: None,
            expires_at: now + chrono::Duration::hours(1),
            revoked_at: None,
        }
    }

    #[tokio::test]
    async fn sqlite_roundtrip_touch_and_revoke() {
        let session_store = SqliteSessionStore::open_in_memory().await.unwrap();
        let store = SqliteBearerTokenStore::new(session_store.pool().clone());
        let token = sample("tok-a");
        let hash = token.token_hash.clone();
        store.create(token).await.unwrap();

        let row = store.get_by_hash(&hash).await.unwrap().unwrap();
        assert_eq!(row.email, "dev@local");

        let touched = Utc::now();
        store.touch_last_used(&row.id, touched).await.unwrap();
        let row = store.get_by_hash(&hash).await.unwrap().unwrap();
        assert!(
            (row.last_used_at.unwrap() - touched)
                .num_milliseconds()
                .abs()
                < 1
        );

        let revoked = Utc::now();
        let row = store.revoke_by_hash(&hash, revoked).await.unwrap().unwrap();
        assert!((row.revoked_at.unwrap() - revoked).num_milliseconds().abs() < 1);
    }

    #[tokio::test]
    async fn sqlite_revoke_returns_the_principal_exactly_once() {
        let session_store = SqliteSessionStore::open_in_memory().await.unwrap();
        let store = SqliteBearerTokenStore::new(session_store.pool().clone());
        let token = sample("tok-once");
        let hash = token.token_hash.clone();
        store.create(token).await.unwrap();

        let first_at = Utc::now();
        let first = store
            .revoke_by_hash(&hash, first_at)
            .await
            .unwrap()
            .unwrap();
        let second_at = first_at + chrono::Duration::seconds(1);
        assert!(
            store
                .revoke_by_hash(&hash, second_at)
                .await
                .unwrap()
                .is_none()
        );

        assert_eq!(first.email, "dev@local");
        assert_eq!(first.revoked_at, Some(first_at));
        assert_eq!(
            store.get_by_hash(&hash).await.unwrap().unwrap().revoked_at,
            Some(first_at)
        );
    }

    #[tokio::test]
    async fn concurrent_sqlite_revoke_has_one_transition_owner() {
        let directory = tempfile::tempdir().unwrap();
        let session_store = SqliteSessionStore::open(&directory.path().join("auth.sqlite"))
            .await
            .unwrap();
        let store = Arc::new(SqliteBearerTokenStore::new(session_store.pool().clone()));
        let token = sample("tok-concurrent");
        let hash = token.token_hash.clone();
        store.create(token).await.unwrap();

        const CALLERS: usize = 8;
        let start = Arc::new(Barrier::new(CALLERS + 1));
        let baseline = Utc::now();
        let mut tasks = Vec::with_capacity(CALLERS);
        for offset in 0..CALLERS {
            let store = Arc::clone(&store);
            let hash = hash.clone();
            let start = Arc::clone(&start);
            tasks.push(tokio::spawn(async move {
                start.wait().await;
                store
                    .revoke_by_hash(&hash, baseline + chrono::Duration::seconds(offset as i64))
                    .await
                    .unwrap()
            }));
        }
        start.wait().await;

        let mut owners = Vec::new();
        for task in tasks {
            if let Some(row) = task.await.unwrap() {
                owners.push(row);
            }
        }

        assert_eq!(owners.len(), 1);
        let owner = &owners[0];
        assert_eq!(owner.email, "dev@local");
        let owner_revoked_at = owner.revoked_at.expect("owner must be revoked");
        assert_eq!(
            store.get_by_hash(&hash).await.unwrap().unwrap().revoked_at,
            Some(owner_revoked_at)
        );
    }
}
