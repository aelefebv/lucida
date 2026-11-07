//! In-memory CLI authorization request store for tests.
//!
//! The `CliTokenAuthorizationStore` conformance suite in
//! [`crate::storage`] runs against this store and the SQLite one, so the
//! two answer alike.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::cli_authorization::{
    CliTokenAuthorization, CliTokenAuthorizationStore, CliTokenAuthorizationStoreError,
};

#[derive(Debug, Default)]
pub struct MemoryCliTokenAuthorizationStore {
    rows: Mutex<HashMap<String, CliTokenAuthorization>>,
}

impl MemoryCliTokenAuthorizationStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.rows.lock().expect("memory store mutex poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows
            .lock()
            .expect("memory store mutex poisoned")
            .is_empty()
    }
}

#[async_trait]
impl CliTokenAuthorizationStore for MemoryCliTokenAuthorizationStore {
    async fn create(
        &self,
        request: CliTokenAuthorization,
    ) -> Result<(), CliTokenAuthorizationStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        // Every uniqueness rule the SQL schema carries: one request per
        // id, and one per poll secret, credential hash, and user code.
        if rows.contains_key(&request.id)
            || rows.values().any(|row| {
                row.poll_token_hash == request.poll_token_hash
                    || row.token_hash == request.token_hash
                    || row.user_code == request.user_code
            })
        {
            return Err(CliTokenAuthorizationStoreError::Backend(
                "duplicate cli authorization request".to_string(),
            ));
        }
        rows.insert(request.id.clone(), request);
        Ok(())
    }

    async fn get(
        &self,
        id: &str,
    ) -> Result<Option<CliTokenAuthorization>, CliTokenAuthorizationStoreError> {
        let rows = self.rows.lock().expect("memory store mutex poisoned");
        Ok(rows.get(id).cloned())
    }

    async fn get_for_poll(
        &self,
        id: &str,
        poll_token_hash: &str,
    ) -> Result<Option<CliTokenAuthorization>, CliTokenAuthorizationStoreError> {
        let rows = self.rows.lock().expect("memory store mutex poisoned");
        Ok(rows
            .get(id)
            .filter(|row| row.poll_token_hash == poll_token_hash)
            .cloned())
    }

    async fn mark_approved(
        &self,
        id: &str,
        token_id: &str,
        email: &str,
        now: DateTime<Utc>,
    ) -> Result<(), CliTokenAuthorizationStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        if let Some(row) = rows.get_mut(id) {
            // First approval wins: a second must not re-point an approved
            // request at another credential or another person.
            row.approved_at.get_or_insert(now);
            row.approved_token_id
                .get_or_insert_with(|| token_id.to_string());
            row.approved_email.get_or_insert_with(|| email.to_string());
        }
        Ok(())
    }
}
