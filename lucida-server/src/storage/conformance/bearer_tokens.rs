//! Conformance suite for `BearerTokenStore`.

use std::sync::Arc;

use super::{at, instant};
use crate::auth::{BearerToken, BearerTokenStore, MemoryBearerTokenStore, hash_bearer_token};
use crate::storage::StorageBackend;
use crate::storage::test_support::{postgres_backend, sqlite_backend};

conformance_suite! {
    cases: [
        a_written_token_reads_back_by_hash,
        an_absent_hash_reads_as_none,
        a_reused_hash_is_rejected,
        a_reused_id_is_rejected,
        touch_advances_last_used,
        touching_an_absent_id_is_silent,
        revoke_stamps_the_row_and_hands_it_back,
        revoke_keeps_the_first_stamp,
        revoking_an_absent_hash_is_none,
        an_expiry_reads_back_exact_at_its_own_boundary,
    ],
    over: [memory, sqlite],
    when_available: [postgres],
}

async fn memory() -> Arc<dyn BearerTokenStore> {
    Arc::new(MemoryBearerTokenStore::new())
}

async fn sqlite() -> Arc<dyn BearerTokenStore> {
    sqlite_backend().await.bearer_tokens()
}

/// `None` when no PostgreSQL was offered. The harness says so once, on
/// stderr, rather than letting the cases pass without running.
async fn postgres() -> Option<Arc<dyn BearerTokenStore>> {
    Some(postgres_backend().await?.backend.bearer_tokens())
}

fn token(id: &str) -> BearerToken {
    BearerToken {
        id: id.to_string(),
        token_hash: hash_bearer_token(id),
        name: "laptop".to_string(),
        email: "dev@example.com".to_string(),
        display_name: "Dev".to_string(),
        picture_url: Some("https://example.com/dev.png".to_string()),
        created_at: instant(0),
        last_used_at: None,
        expires_at: instant(3600),
        revoked_at: None,
    }
}

async fn a_written_token_reads_back_by_hash(store: Arc<dyn BearerTokenStore>) {
    let written = token("token-a");
    store.create(written.clone()).await.unwrap();

    let found = store.get_by_hash(&written.token_hash).await.unwrap();
    assert_eq!(found, Some(written));
}

async fn an_absent_hash_reads_as_none(store: Arc<dyn BearerTokenStore>) {
    let absent = hash_bearer_token("never-written");
    assert!(store.get_by_hash(&absent).await.unwrap().is_none());
}

async fn a_reused_hash_is_rejected(store: Arc<dyn BearerTokenStore>) {
    store.create(token("token-a")).await.unwrap();

    let mut intruder = token("token-b");
    intruder.token_hash = hash_bearer_token("token-a");
    intruder.email = "intruder@example.com".to_string();
    assert!(
        store.create(intruder).await.is_err(),
        "one hash must resolve to one identity, or presenting a credential is ambiguous",
    );

    let kept = store
        .get_by_hash(&hash_bearer_token("token-a"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kept.email, "dev@example.com");
}

async fn a_reused_id_is_rejected(store: Arc<dyn BearerTokenStore>) {
    store.create(token("token-a")).await.unwrap();

    let mut intruder = token("token-a");
    intruder.token_hash = hash_bearer_token("a-different-credential");
    assert!(
        store.create(intruder).await.is_err(),
        "a reused id must be rejected, not silently overwrite the token under it",
    );

    assert!(
        store
            .get_by_hash(&hash_bearer_token("a-different-credential"))
            .await
            .unwrap()
            .is_none(),
    );
}

async fn touch_advances_last_used(store: Arc<dyn BearerTokenStore>) {
    let written = token("token-a");
    store.create(written.clone()).await.unwrap();

    store.touch_last_used("token-a", instant(60)).await.unwrap();

    let touched = store
        .get_by_hash(&written.token_hash)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(touched.last_used_at, Some(instant(60)));
    assert_eq!(touched.expires_at, instant(3600));
}

async fn touching_an_absent_id_is_silent(store: Arc<dyn BearerTokenStore>) {
    store
        .touch_last_used("never-written", instant(60))
        .await
        .expect("a token revoked between lookup and bump is a race, not a failure");
}

async fn revoke_stamps_the_row_and_hands_it_back(store: Arc<dyn BearerTokenStore>) {
    let written = token("token-a");
    store.create(written.clone()).await.unwrap();

    let revoked = store
        .revoke_by_hash(&written.token_hash, instant(60))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revoked.revoked_at, Some(instant(60)));
    assert!(!revoked.is_active_at(instant(61)));

    let reread = store
        .get_by_hash(&written.token_hash)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reread.revoked_at, Some(instant(60)));
}

async fn revoke_keeps_the_first_stamp(store: Arc<dyn BearerTokenStore>) {
    let written = token("token-a");
    store.create(written.clone()).await.unwrap();
    store
        .revoke_by_hash(&written.token_hash, instant(60))
        .await
        .unwrap();

    let again = store
        .revoke_by_hash(&written.token_hash, instant(120))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        again.revoked_at,
        Some(instant(60)),
        "a credential stops being valid when it was first revoked, not when someone said so again",
    );
}

async fn revoking_an_absent_hash_is_none(store: Arc<dyn BearerTokenStore>) {
    let absent = hash_bearer_token("never-written");
    assert!(
        store
            .revoke_by_hash(&absent, instant(60))
            .await
            .unwrap()
            .is_none()
    );
}

/// Nothing compares a bearer token's expiry in SQL: the store hands the
/// row back and [`BearerToken::is_active_at`] decides. That puts the
/// whole of expiry on the round trip being exact, so this is where the
/// round trip is checked against a boundary rather than against a value
/// the same case wrote a moment ago.
///
/// The expiry is a whole second — the shape a store keeping RFC 3339 text
/// writes without a fractional part — named from five and three quarter
/// hours east, and the two instants it is judged against are named from
/// eight hours west, where they fall on the day before.
async fn an_expiry_reads_back_exact_at_its_own_boundary(store: Arc<dyn BearerTokenStore>) {
    let mut written = token("token-a");
    written.expires_at = at("2026-01-02T08:49:05+05:45");
    store.create(written.clone()).await.unwrap();

    let read = store
        .get_by_hash(&written.token_hash)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.expires_at, written.expires_at);
    assert!(read.is_active_at(at("2026-01-01T19:04:04.999999-08:00")));
    assert!(
        !read.is_active_at(at("2026-01-01T19:04:05-08:00")),
        "a credential is spent the moment it expires, not a tick later",
    );
}
