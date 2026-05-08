//! In-memory `LoginSessionStore` implementation.
//!
//! Used by unit tests and integration tests so they don't need to spin
//! up a SQLite database on disk. The semantics deliberately mirror the
//! SQLite implementation: get returns `Ok(None)` when missing, touch is
//! racy, delete is idempotent, delete_expired removes by `<= now`.
//!
//! Production code never reaches this — `main.rs` always wires the
//! SQLite implementation. Lives behind a regular module rather than
//! `cfg(test)` so integration tests in `tests/` can construct it.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::session_store::{LoginSession, LoginSessionStore, SessionStoreError};

/// In-memory implementation. The mutex is uncontended in tests so the
/// extra lock overhead is irrelevant.
#[derive(Debug, Default)]
pub struct MemorySessionStore {
    rows: Mutex<HashMap<String, LoginSession>>,
}

impl MemorySessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Total row count, for tests that want to assert sweep behaviour.
    pub fn len(&self) -> usize {
        self.rows.lock().expect("memory store mutex poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[async_trait]
impl LoginSessionStore for MemorySessionStore {
    async fn create(&self, session: LoginSession) -> Result<(), SessionStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        rows.insert(session.id.clone(), session);
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Option<LoginSession>, SessionStoreError> {
        let rows = self.rows.lock().expect("memory store mutex poisoned");
        Ok(rows.get(id).cloned())
    }

    async fn touch_last_used(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), SessionStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        if let Some(row) = rows.get_mut(id) {
            row.last_used_at = now;
        }
        // Missing row is not an error: the session may have been
        // deleted between the get() and the bump (tab open during
        // logout). Mirror the SQLite implementation, which uses
        // `UPDATE` and silently affects 0 rows in the same case.
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<(), SessionStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        rows.remove(id);
        Ok(())
    }

    async fn delete_expired(&self, now: DateTime<Utc>) -> Result<u64, SessionStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        let before = rows.len();
        rows.retain(|_, row| row.expires_at > now);
        Ok((before - rows.len()) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;

    fn sample(id: &str, now: DateTime<Utc>, expires_in_hours: i64) -> LoginSession {
        LoginSession {
            id: id.to_string(),
            email: "dev@local".to_string(),
            display_name: "Local Dev".to_string(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + ChronoDuration::hours(expires_in_hours),
        }
    }

    #[tokio::test]
    async fn roundtrip_get_after_create() {
        let store = MemorySessionStore::new();
        let now = Utc::now();
        let s = sample("id-a", now, 24);
        store.create(s.clone()).await.unwrap();

        let got = store.get("id-a").await.unwrap();
        assert_eq!(got.as_ref(), Some(&s));
    }

    #[tokio::test]
    async fn get_missing_returns_none_not_error() {
        let store = MemorySessionStore::new();
        assert!(store.get("nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn touch_bumps_last_used() {
        let store = MemorySessionStore::new();
        let now = Utc::now();
        let later = now + ChronoDuration::seconds(60);
        store.create(sample("id-a", now, 24)).await.unwrap();

        store.touch_last_used("id-a", later).await.unwrap();
        let got = store.get("id-a").await.unwrap().unwrap();
        assert_eq!(got.last_used_at, later);
    }

    #[tokio::test]
    async fn touch_missing_id_is_silent() {
        let store = MemorySessionStore::new();
        store
            .touch_last_used("nope", Utc::now())
            .await
            .expect("missing-id touch must not error");
    }

    #[tokio::test]
    async fn delete_is_idempotent() {
        let store = MemorySessionStore::new();
        store.delete("nope").await.unwrap();
        store.create(sample("id-a", Utc::now(), 1)).await.unwrap();
        store.delete("id-a").await.unwrap();
        store.delete("id-a").await.unwrap();
        assert!(store.get("id-a").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_expired_removes_only_past_rows() {
        let store = MemorySessionStore::new();
        let now = Utc::now();
        store.create(sample("dead", now, -1)).await.unwrap();
        store.create(sample("alive", now, 24)).await.unwrap();

        let removed = store.delete_expired(now).await.unwrap();
        assert_eq!(removed, 1);
        assert!(store.get("dead").await.unwrap().is_none());
        assert!(store.get("alive").await.unwrap().is_some());
    }
}
