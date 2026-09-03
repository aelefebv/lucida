//! PostgreSQL-backed `LoginSessionStore`.
//!
//! Shares the PostgreSQL pool that [`crate::storage`] opened, as every
//! PostgreSQL store does.
//!
//! The statements come from [`super::session_store_sql`], which the
//! SQLite store runs too, so this module holds the binding and the row
//! mapping and no SQL of its own. Read it beside `session_store_sqlite`:
//! the two differ in the pool type and the type name, and nowhere else.
//! ADR-0058 records why the SQL is shared and the Rust is not.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};

use super::session_store::{LoginSession, LoginSessionStore, SessionStoreError};
use super::session_store_sql::{self as sql, map_err};

/// PostgreSQL session store. Holds a `PgPool` clone, so it is cheap to
/// build and cheap to share.
#[derive(Debug, Clone)]
pub struct PostgresSessionStore {
    pool: PgPool,
}

impl PostgresSessionStore {
    /// Build the store from an already-opened pool. The migrator does not
    /// run here: the storage backend runs it once, before any store
    /// exists.
    pub(crate) fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl LoginSessionStore for PostgresSessionStore {
    async fn create(&self, session: LoginSession) -> Result<(), SessionStoreError> {
        sqlx::query(sql::INSERT)
            .bind(&session.id)
            .bind(&session.email)
            .bind(&session.display_name)
            .bind(&session.picture_url)
            .bind(session.created_at)
            .bind(session.last_used_at)
            .bind(session.expires_at)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Option<LoginSession>, SessionStoreError> {
        let row = sqlx::query(sql::SELECT_BY_ID)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_err)?;

        Ok(row.map(|r| LoginSession {
            id: r.get("id"),
            email: r.get("email"),
            display_name: r.get("display_name"),
            picture_url: r.get("picture_url"),
            created_at: r.get("created_at"),
            last_used_at: r.get("last_used_at"),
            expires_at: r.get("expires_at"),
        }))
    }

    async fn touch_last_used(&self, id: &str, now: DateTime<Utc>) -> Result<(), SessionStoreError> {
        sqlx::query(sql::TOUCH_LAST_USED)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<(), SessionStoreError> {
        sqlx::query(sql::DELETE)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(())
    }

    async fn delete_expired(&self, now: DateTime<Utc>) -> Result<u64, SessionStoreError> {
        let result = sqlx::query(sql::DELETE_EXPIRED)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(result.rows_affected())
    }
}

/// What the `LoginSessionStore` conformance suite cannot ask, because a
/// case may not name an engine: what a `TIMESTAMPTZ` round trip does with
/// an instant, and what the server's own `TimeZone` does to it.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::postgres_backend;
    use chrono::TimeZone;
    use sqlx::postgres::PgPoolOptions;

    fn session(expires_at: DateTime<Utc>) -> LoginSession {
        LoginSession {
            id: "session-a".to_string(),
            email: "dev@example.com".to_string(),
            display_name: "Dev".to_string(),
            picture_url: None,
            created_at: expires_at - chrono::Duration::hours(1),
            last_used_at: expires_at - chrono::Duration::hours(1),
            expires_at,
        }
    }

    fn utc(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("the test names a real instant")
    }

    /// A server whose `TimeZone` is not UTC keeps the same instants.
    ///
    /// `TIMESTAMPTZ` is an instant, not a wall clock, but a deployment is
    /// free to set `TimeZone` to anything, and a value that travelled as
    /// text would come back shifted by it. The zone here is 14 hours from
    /// UTC and the expiry sits half an hour before midnight, so a leak
    /// would move the row to the next day and the sweep with it.
    ///
    /// One store covers all of them: every PostgreSQL store binds and
    /// reads `DateTime<Utc>` through the same driver.
    #[tokio::test]
    async fn a_server_time_zone_does_not_move_an_instant() {
        let Some(db) = postgres_backend().await else {
            return;
        };

        // `SET TIME ZONE` is per-session, so only an after-connect hook
        // reaches every connection the pool opens.
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SET TIME ZONE 'Pacific/Kiritimati'")
                        .execute(&mut *connection)
                        .await?;
                    Ok(())
                })
            })
            .connect(&db.url)
            .await
            .expect("the harness already opened this database");
        let zone: String = sqlx::query_scalar("SHOW TimeZone")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(zone, "Pacific/Kiritimati", "the zone is what is under test");

        let store = PostgresSessionStore::new(pool);
        let written = session(utc(2026, 1, 1, 23, 30));
        store.create(written.clone()).await.unwrap();
        assert_eq!(store.get("session-a").await.unwrap(), Some(written.clone()));

        assert_eq!(
            store
                .delete_expired(written.expires_at - chrono::Duration::seconds(1))
                .await
                .unwrap(),
            0,
            "a cutoff a second short of the expiry spares the session",
        );
        assert_eq!(
            store.delete_expired(written.expires_at).await.unwrap(),
            1,
            "and the expiry itself takes it",
        );
    }

    /// A `TIMESTAMPTZ` is whole microseconds, so it drops anything finer
    /// on the way in.
    ///
    /// This is the one value the two engines disagree on: the SQLite
    /// store keeps every digit chrono wrote, which
    /// `a_sub_microsecond_expiry_survives` pins. Nothing in the server
    /// compares a timestamp against one it did not read back, and no
    /// expiry policy is measured in nanoseconds, so the difference costs
    /// nothing.
    #[tokio::test]
    async fn a_sub_microsecond_expiry_is_truncated() {
        let Some(db) = postgres_backend().await else {
            return;
        };
        let whole_microsecond = utc(2026, 1, 2, 3, 4) + chrono::Duration::microseconds(1);

        let store = db.backend.login_sessions();
        store
            .create(session(
                whole_microsecond + chrono::Duration::nanoseconds(500),
            ))
            .await
            .unwrap();

        assert_eq!(
            store.get("session-a").await.unwrap().unwrap().expires_at,
            whole_microsecond,
        );
    }
}
