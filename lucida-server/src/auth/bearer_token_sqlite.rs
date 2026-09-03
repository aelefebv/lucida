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
