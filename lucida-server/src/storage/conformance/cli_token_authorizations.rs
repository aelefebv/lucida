//! Conformance suite for `CliTokenAuthorizationStore`.

use std::sync::Arc;

use super::{at, instant};
use crate::auth::{
    CliTokenAuthorization, CliTokenAuthorizationStore, MemoryCliTokenAuthorizationStore,
};
use crate::storage::StorageBackend;
use crate::storage::test_support::{postgres_backend, sqlite_backend};

conformance_suite! {
    cases: [
        a_written_request_reads_back,
        an_absent_request_reads_as_none,
        polling_needs_the_matching_poll_hash,
        polling_an_absent_id_is_none,
        a_reused_id_is_rejected,
        a_reused_poll_hash_is_rejected,
        a_reused_token_hash_is_rejected,
        a_reused_user_code_is_rejected,
        approval_stamps_the_row,
        approval_keeps_the_first_approver,
        approving_an_absent_id_is_silent,
        an_expiry_reads_back_exact_at_its_own_boundary,
    ],
    over: [memory, sqlite],
    when_available: [postgres],
}

async fn memory() -> Arc<dyn CliTokenAuthorizationStore> {
    Arc::new(MemoryCliTokenAuthorizationStore::new())
}

async fn sqlite() -> Arc<dyn CliTokenAuthorizationStore> {
    sqlite_backend().await.cli_token_authorizations()
}

/// `None` when no PostgreSQL was offered. The harness says so once, on
/// stderr, rather than letting the cases pass without running.
async fn postgres() -> Option<Arc<dyn CliTokenAuthorizationStore>> {
    Some(postgres_backend().await?.backend.cli_token_authorizations())
}

fn request(id: &str) -> CliTokenAuthorization {
    CliTokenAuthorization {
        id: id.to_string(),
        poll_token_hash: format!("poll-hash-{id}"),
        token_hash: format!("token-hash-{id}"),
        user_code: format!("CODE-{id}"),
        name: "laptop".to_string(),
        created_at: instant(0),
        expires_at: instant(600),
        token_expires_at: instant(2_592_000),
        approved_at: None,
        approved_token_id: None,
        approved_email: None,
    }
}

async fn a_written_request_reads_back(store: Arc<dyn CliTokenAuthorizationStore>) {
    let written = request("req-a");
    store.create(written.clone()).await.unwrap();

    assert_eq!(store.get("req-a").await.unwrap(), Some(written.clone()));
    assert_eq!(
        store
            .get_for_poll("req-a", &written.poll_token_hash)
            .await
            .unwrap(),
        Some(written),
    );
}

async fn an_absent_request_reads_as_none(store: Arc<dyn CliTokenAuthorizationStore>) {
    assert!(store.get("never-written").await.unwrap().is_none());
}

async fn polling_needs_the_matching_poll_hash(store: Arc<dyn CliTokenAuthorizationStore>) {
    store.create(request("req-a")).await.unwrap();

    assert!(
        store
            .get_for_poll("req-a", "poll-hash-someone-else")
            .await
            .unwrap()
            .is_none(),
        "the request id alone must not reveal the approval",
    );
}

async fn polling_an_absent_id_is_none(store: Arc<dyn CliTokenAuthorizationStore>) {
    assert!(
        store
            .get_for_poll("never-written", "poll-hash-never-written")
            .await
            .unwrap()
            .is_none()
    );
}

async fn a_reused_id_is_rejected(store: Arc<dyn CliTokenAuthorizationStore>) {
    store.create(request("req-a")).await.unwrap();

    let mut intruder = request("req-b");
    intruder.id = "req-a".to_string();
    assert!(
        store.create(intruder).await.is_err(),
        "a reused id must be rejected, not silently overwrite the request under it",
    );

    let kept = store.get("req-a").await.unwrap().unwrap();
    assert_eq!(kept.token_hash, "token-hash-req-a");
}

async fn a_reused_poll_hash_is_rejected(store: Arc<dyn CliTokenAuthorizationStore>) {
    store.create(request("req-a")).await.unwrap();

    let mut intruder = request("req-b");
    intruder.poll_token_hash = "poll-hash-req-a".to_string();
    assert!(
        store.create(intruder).await.is_err(),
        "one poll secret must unlock one request",
    );
}

async fn a_reused_token_hash_is_rejected(store: Arc<dyn CliTokenAuthorizationStore>) {
    store.create(request("req-a")).await.unwrap();

    let mut intruder = request("req-b");
    intruder.token_hash = "token-hash-req-a".to_string();
    assert!(
        store.create(intruder).await.is_err(),
        "approving one request must not mint a credential a second request also claims",
    );
}

async fn a_reused_user_code_is_rejected(store: Arc<dyn CliTokenAuthorizationStore>) {
    store.create(request("req-a")).await.unwrap();

    let mut intruder = request("req-b");
    intruder.user_code = "CODE-req-a".to_string();
    assert!(
        store.create(intruder).await.is_err(),
        "the code a person reads out must name exactly one request",
    );
}

async fn approval_stamps_the_row(store: Arc<dyn CliTokenAuthorizationStore>) {
    store.create(request("req-a")).await.unwrap();

    store
        .mark_approved("req-a", "token-a", "dev@example.com", instant(60))
        .await
        .unwrap();

    let approved = store.get("req-a").await.unwrap().unwrap();
    assert!(approved.is_approved());
    assert_eq!(approved.approved_at, Some(instant(60)));
    assert_eq!(approved.approved_token_id.as_deref(), Some("token-a"));
    assert_eq!(approved.approved_email.as_deref(), Some("dev@example.com"));
}

async fn approval_keeps_the_first_approver(store: Arc<dyn CliTokenAuthorizationStore>) {
    store.create(request("req-a")).await.unwrap();
    store
        .mark_approved("req-a", "token-a", "dev@example.com", instant(60))
        .await
        .unwrap();

    store
        .mark_approved("req-a", "token-b", "intruder@example.com", instant(120))
        .await
        .unwrap();

    let approved = store.get("req-a").await.unwrap().unwrap();
    assert_eq!(approved.approved_at, Some(instant(60)));
    assert_eq!(
        approved.approved_token_id.as_deref(),
        Some("token-a"),
        "a second approval must not re-point an already-approved request at another credential",
    );
    assert_eq!(approved.approved_email.as_deref(), Some("dev@example.com"));
}

/// Nothing compares an approval request's expiry in SQL: the store hands
/// the row back and [`CliTokenAuthorization::is_expired_at`] decides.
/// That puts the whole of expiry on the round trip being exact, so this
/// is where the round trip is checked against a boundary rather than
/// against a value the same case wrote a moment ago.
///
/// The expiry is a whole second — the shape a store keeping RFC 3339 text
/// writes without a fractional part — named from five and three quarter
/// hours east, and the two instants it is judged against are named from
/// eight hours west, where they fall on the day before.
async fn an_expiry_reads_back_exact_at_its_own_boundary(
    store: Arc<dyn CliTokenAuthorizationStore>,
) {
    let mut written = request("req-a");
    written.expires_at = at("2026-01-02T08:49:05+05:45");
    store.create(written.clone()).await.unwrap();

    let read = store.get("req-a").await.unwrap().unwrap();
    assert_eq!(read.expires_at, written.expires_at);
    assert!(!read.is_expired_at(at("2026-01-01T19:04:04.999999-08:00")));
    assert!(
        read.is_expired_at(at("2026-01-01T19:04:05-08:00")),
        "a window that has run out is shut, not shutting",
    );
}

async fn approving_an_absent_id_is_silent(store: Arc<dyn CliTokenAuthorizationStore>) {
    store
        .mark_approved("never-written", "token-a", "dev@example.com", instant(60))
        .await
        .expect("a request that expired before the browser approved it is a race, not a failure");

    assert!(store.get("never-written").await.unwrap().is_none());
}
