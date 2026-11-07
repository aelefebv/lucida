//! SQLite-backed CLI authorization request store.
//!
//! The statements come from [`super::cli_authorization_sql`], which the
//! PostgreSQL store runs too, so this module holds the binding and the
//! row mapping and no SQL of its own.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use super::cli_authorization::{
    CliTokenAuthorization, CliTokenAuthorizationStore, CliTokenAuthorizationStoreError,
};
use super::cli_authorization_sql::{self as sql, map_err};

#[derive(Debug, Clone)]
pub struct SqliteCliTokenAuthorizationStore {
    pool: SqlitePool,
}

impl SqliteCliTokenAuthorizationStore {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn row_to_request(row: sqlx::sqlite::SqliteRow) -> CliTokenAuthorization {
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
impl CliTokenAuthorizationStore for SqliteCliTokenAuthorizationStore {
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
