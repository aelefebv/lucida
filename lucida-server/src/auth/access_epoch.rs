//! Process-local authorization generations shared by credential validation and
//! WebSocket admission.
//!
//! A credential extractor captures an email's epoch between two validations of
//! the backing session/token. Logout or administrative revocation increments
//! the same epoch after invalidating the credential. A principal authenticated
//! before that increment therefore cannot be admitted after it, even when its
//! request was already queued in middleware.

use std::collections::HashMap;

use tokio::sync::{Mutex, MutexGuard};

/// Per-principal authorization generations.
#[derive(Debug, Default)]
pub struct AuthEpochRegistry {
    epochs: Mutex<HashMap<String, u64>>,
}

impl AuthEpochRegistry {
    pub async fn current(&self, email: &str) -> u64 {
        self.epochs
            .lock()
            .await
            .get(&normalize_email(email))
            .copied()
            .unwrap_or(0)
    }

    pub(crate) async fn lock(&self) -> AuthEpochGuard<'_> {
        AuthEpochGuard {
            epochs: self.epochs.lock().await,
        }
    }
}

/// Guard used to make WebSocket registration and epoch revocation mutually
/// exclusive at their linearization point.
pub(crate) struct AuthEpochGuard<'a> {
    epochs: MutexGuard<'a, HashMap<String, u64>>,
}

impl AuthEpochGuard<'_> {
    pub(crate) fn current(&self, email: &str) -> u64 {
        self.epochs
            .get(&normalize_email(email))
            .copied()
            .unwrap_or(0)
    }

    pub(crate) fn revoke(&mut self, email: &str) -> u64 {
        let epoch = self.epochs.entry(normalize_email(email)).or_default();
        *epoch = epoch.wrapping_add(1);
        *epoch
    }
}

fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn epochs_are_case_insensitive_and_monotonic() {
        let registry = AuthEpochRegistry::default();
        assert_eq!(registry.current("Alice@Example.com").await, 0);
        assert_eq!(registry.lock().await.revoke(" alice@example.COM "), 1);
        assert_eq!(registry.current("ALICE@example.com").await, 1);
    }
}
