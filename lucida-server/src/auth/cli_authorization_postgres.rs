//! PostgreSQL-backed CLI authorization request store.
//!
//! Shares the PostgreSQL pool that [`crate::storage`] opened, as every
//! PostgreSQL store does.
//!
//! The statements come from [`super::cli_authorization_sql`], which the
//! SQLite store runs too, so this module holds the binding and the row
//! mapping and no SQL of its own. Read it beside
//! `cli_authorization_sqlite`: the two differ in the pool type, the row
//! type, and the type name, and nowhere else. ADR-0058 records why the
//! SQL is shared and the Rust is not.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};

use super::cli_authorization::{
    CliTokenAuthorization, CliTokenAuthorizationStore, CliTokenAuthorizationStoreError,
};
use super::cli_authorization_sql::{self as sql, map_err};

#[derive(Debug, Clone)]
pub struct PostgresCliTokenAuthorizationStore {
    pool: PgPool,
}

impl PostgresCliTokenAuthorizationStore {
    /// Build the store from an already-opened pool. The migrator does not
    /// run here: the storage backend runs it once, before any store
    /// exists.
    pub(crate) fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

fn row_to_request(row: sqlx::postgres::PgRow) -> CliTokenAuthorization {
    CliTokenAuthorization {
        id: row.get("id"),
        poll_token_hash: row.get("poll_token_hash"),
        token_hash: row.get("token_hash"),
        user_code: row.get("user_code"),
        name: row.get("name"),
        created_at: row.get("created_at"),
        expires_at: row.get("expires_at"),
        token_expires_at: row.get("token_expires_at"),
        approved_at: row.get("approved_at"),
        approved_token_id: row.get("approved_token_id"),
        approved_email: row.get("approved_email"),
    }
}

#[async_trait]
impl CliTokenAuthorizationStore for PostgresCliTokenAuthorizationStore {
    async fn create(
        &self,
        request: CliTokenAuthorization,
    ) -> Result<(), CliTokenAuthorizationStoreError> {
        sqlx::query(sql::INSERT)
            .bind(&request.id)
            .bind(&request.poll_token_hash)
            .bind(&request.token_hash)
            .bind(&request.user_code)
            .bind(&request.name)
            .bind(request.created_at)
            .bind(request.expires_at)
            .bind(request.token_expires_at)
            .bind(request.approved_at)
            .bind(&request.approved_token_id)
            .bind(&request.approved_email)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(())
    }

    async fn get(
        &self,
        id: &str,
    ) -> Result<Option<CliTokenAuthorization>, CliTokenAuthorizationStoreError> {
        let row = sqlx::query(sql::SELECT_BY_ID)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(row.map(row_to_request))
    }

    async fn get_for_poll(
        &self,
        id: &str,
        poll_token_hash: &str,
    ) -> Result<Option<CliTokenAuthorization>, CliTokenAuthorizationStoreError> {
        let row = sqlx::query(sql::SELECT_FOR_POLL)
            .bind(id)
            .bind(poll_token_hash)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(row.map(row_to_request))
    }

    async fn mark_approved(
        &self,
        id: &str,
        token_id: &str,
        email: &str,
        now: DateTime<Utc>,
    ) -> Result<(), CliTokenAuthorizationStoreError> {
        sqlx::query(sql::MARK_APPROVED)
            .bind(now)
            .bind(token_id)
            .bind(email)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(())
    }
}
