//! Conformance suite for `PendingAuthStore`.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::instant;
use crate::auth::{MemoryPendingAuthStore, PendingAuth, PendingAuthStore};
use crate::storage::StorageBackend;
use crate::storage::test_support::{postgres_backend, sqlite_backend};

conformance_suite! {
    cases: [
        a_written_intent_reads_back_on_consume,
        an_intent_with_no_hash_reads_back_as_an_empty_one,
        consume_is_single_use,
        consuming_an_absent_token_is_none,
        a_reused_state_token_is_rejected,
        the_sweep_spares_an_intent_exactly_at_the_cutoff,
        concurrent_consumes_have_exactly_one_winner,
    ],
    over: [memory, sqlite],
    when_available: [postgres],
}

async fn memory() -> Arc<dyn PendingAuthStore> {
    Arc::new(MemoryPendingAuthStore::new())
}

async fn sqlite() -> Arc<dyn PendingAuthStore> {
    sqlite_backend().await.pending_auth()
}

/// `None` when no PostgreSQL was offered. The harness says so once, on
/// stderr, rather than letting seven cases pass without running.
async fn postgres() -> Option<Arc<dyn PendingAuthStore>> {
    Some(postgres_backend().await?.backend.pending_auth())
}

fn intent(state_token: &str, created_at: DateTime<Utc>) -> PendingAuth {
    PendingAuth {
        state_token: state_token.to_string(),
        intended_path: "/w/demo".to_string(),
        intended_hash: "#v=1".to_string(),
        created_at,
    }
}

async fn a_written_intent_reads_back_on_consume(store: Arc<dyn PendingAuthStore>) {
    let written = intent("state-a", instant(0));
    store.insert(written.clone()).await.unwrap();

    assert_eq!(store.consume("state-a").await.unwrap(), Some(written));
}

async fn an_intent_with_no_hash_reads_back_as_an_empty_one(store: Arc<dyn PendingAuthStore>) {
    // Landing on a page with no fragment is the common case, and it must
    // come back as an empty string rather than an absent value — the
    // callback has no `Option` to branch on.
    let mut written = intent("state-a", instant(0));
    written.intended_hash = String::new();
    store.insert(written.clone()).await.unwrap();

    assert_eq!(store.consume("state-a").await.unwrap(), Some(written));
}

async fn consume_is_single_use(store: Arc<dyn PendingAuthStore>) {
    store.insert(intent("state-a", instant(0))).await.unwrap();

    assert!(store.consume("state-a").await.unwrap().is_some());
    assert!(
        store.consume("state-a").await.unwrap().is_none(),
        "a replayed state token must not ride to the same landing twice",
    );
}

async fn consuming_an_absent_token_is_none(store: Arc<dyn PendingAuthStore>) {
    assert!(store.consume("never-written").await.unwrap().is_none());
}

async fn a_reused_state_token_is_rejected(store: Arc<dyn PendingAuthStore>) {
    store.insert(intent("state-a", instant(0))).await.unwrap();

    let mut intruder = intent("state-a", instant(0));
    intruder.intended_path = "/w/somewhere-else".to_string();
    assert!(
        store.insert(intruder).await.is_err(),
        "a reused state token must be rejected, not redirect the round-trip in flight",
    );

    let kept = store.consume("state-a").await.unwrap().unwrap();
    assert_eq!(kept.intended_path, "/w/demo");
}

async fn the_sweep_spares_an_intent_exactly_at_the_cutoff(store: Arc<dyn PendingAuthStore>) {
    store.insert(intent("stale", instant(-1))).await.unwrap();
    store
        .insert(intent("on-the-cutoff", instant(0)))
        .await
        .unwrap();
    store.insert(intent("fresh", instant(1))).await.unwrap();

    let removed = store.delete_expired(instant(0)).await.unwrap();
    assert_eq!(
        removed, 1,
        "the sweep drops what is strictly older than the cutoff",
    );
    assert!(store.consume("stale").await.unwrap().is_none());
    assert!(store.consume("on-the-cutoff").await.unwrap().is_some());
    assert!(store.consume("fresh").await.unwrap().is_some());
}

async fn concurrent_consumes_have_exactly_one_winner(store: Arc<dyn PendingAuthStore>) {
    // The single-use guarantee is worth nothing if two callbacks racing
    // on one token can both be handed the intent.
    store.insert(intent("state-a", instant(0))).await.unwrap();

    let mut callers = Vec::new();
    for _ in 0..8 {
        let store = Arc::clone(&store);
        callers.push(tokio::spawn(async move {
            store.consume("state-a").await.unwrap()
        }));
    }

    let mut winners = 0;
    for caller in callers {
        if caller.await.unwrap().is_some() {
            winners += 1;
        }
    }
    assert_eq!(winners, 1, "consume must be atomic");
}
