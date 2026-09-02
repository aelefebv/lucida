//! SQLite-backed bearer-token store.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use super::bearer_token::{BearerToken, BearerTokenStore, BearerTokenStoreError};

#[derive(Debug, Clone)]
pub struct SqliteBearerTokenStore {
    pool: SqlitePool,
}

impl SqliteBearerTokenStore {
    pub(crate) fn new(pool: SqlitePool) -> Self {
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
        sqlx::query(
            r#"
            UPDATE bearer_tokens
            SET revoked_at = COALESCE(revoked_at, ?)
            WHERE token_hash = ?
            "#,
        )
        .bind(now)
        .bind(token_hash)
        .execute(&self.pool)
        .await
        .map_err(map_err)?;
        self.get_by_hash(token_hash).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::bearer_token::hash_bearer_token;
    use crate::storage::SqliteStorageBackend;

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
        let backend = SqliteStorageBackend::open_in_memory().await.unwrap();
        let store = SqliteBearerTokenStore::new(backend.pool().clone());
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
}
