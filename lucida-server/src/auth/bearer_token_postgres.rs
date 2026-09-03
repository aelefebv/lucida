//! PostgreSQL-backed bearer-token store.
//!
//! Shares the PostgreSQL pool that [`crate::storage`] opened, as every
//! PostgreSQL store does.
//!
//! The statements come from [`super::bearer_token_sql`], which the SQLite
//! store runs too, so this module holds the binding and the row mapping
//! and no SQL of its own. Read it beside `bearer_token_sqlite`: the two
//! differ in the pool type, the row type, and the type name, and nowhere
//! else. ADR-0058 records why the SQL is shared and the Rust is not.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};

use super::bearer_token::{BearerToken, BearerTokenStore, BearerTokenStoreError};
use super::bearer_token_sql::{self as sql, map_err};

#[derive(Debug, Clone)]
pub struct PostgresBearerTokenStore {
    pool: PgPool,
}

impl PostgresBearerTokenStore {
    /// Build the store from an already-opened pool. The migrator does not
    /// run here: the storage backend runs it once, before any store
    /// exists.
    pub(crate) fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

fn row_to_token(row: sqlx::postgres::PgRow) -> BearerToken {
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
impl BearerTokenStore for PostgresBearerTokenStore {
    async fn create(&self, token: BearerToken) -> Result<(), BearerTokenStoreError> {
        sqlx::query(sql::INSERT)
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
        let row = sqlx::query(sql::SELECT_BY_HASH)
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
        sqlx::query(sql::TOUCH_LAST_USED)
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
        sqlx::query(sql::REVOKE_BY_HASH)
            .bind(now)
            .bind(token_hash)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        self.get_by_hash(token_hash).await
    }
}
