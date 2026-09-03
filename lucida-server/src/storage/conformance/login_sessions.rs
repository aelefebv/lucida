//! Conformance suite for `LoginSessionStore`.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::{at, instant};
use crate::auth::{LoginSession, LoginSessionStore, MemorySessionStore};
use crate::storage::StorageBackend;
use crate::storage::test_support::{postgres_backend, sqlite_backend};

conformance_suite! {
    cases: [
        a_written_session_reads_back,
        an_absent_session_reads_as_none,
        a_reused_id_is_rejected,
        touch_advances_the_idle_anchor_alone,
        touching_an_absent_session_is_silent,
        delete_removes_the_session_and_repeats_harmlessly,
        the_sweep_removes_sessions_expired_at_the_cutoff,
        the_sweep_reads_an_expiry_as_an_instant,
        concurrent_creates_all_land,
    ],
    over: [memory, sqlite],
    when_available: [postgres],
}

async fn memory() -> Arc<dyn LoginSessionStore> {
    Arc::new(MemorySessionStore::new())
}

async fn sqlite() -> Arc<dyn LoginSessionStore> {
    sqlite_backend().await.login_sessions()
}

/// `None` when no PostgreSQL was offered. The harness says so once, on
/// stderr, rather than letting the cases pass without running.
async fn postgres() -> Option<Arc<dyn LoginSessionStore>> {
    Some(postgres_backend().await?.backend.login_sessions())
}

fn session(id: &str, expires_at: DateTime<Utc>) -> LoginSession {
    LoginSession {
        id: id.to_string(),
        email: "dev@example.com".to_string(),
        display_name: "Dev".to_string(),
        picture_url: Some("https://example.com/dev.png".to_string()),
        created_at: instant(0),
        last_used_at: instant(0),
        expires_at,
    }
}

async fn a_written_session_reads_back(store: Arc<dyn LoginSessionStore>) {
    let written = session("session-a", instant(3600));
    store.create(written.clone()).await.unwrap();

    assert_eq!(store.get("session-a").await.unwrap(), Some(written));
}

async fn an_absent_session_reads_as_none(store: Arc<dyn LoginSessionStore>) {
    assert!(store.get("never-written").await.unwrap().is_none());
}

async fn a_reused_id_is_rejected(store: Arc<dyn LoginSessionStore>) {
    store
        .create(session("session-a", instant(3600)))
        .await
        .unwrap();

    let mut intruder = session("session-a", instant(7200));
    intruder.email = "intruder@example.com".to_string();
    assert!(
        store.create(intruder).await.is_err(),
        "a reused id must be rejected, not silently overwrite the session under it",
    );

    let kept = store.get("session-a").await.unwrap().unwrap();
    assert_eq!(kept.email, "dev@example.com");
}

async fn touch_advances_the_idle_anchor_alone(store: Arc<dyn LoginSessionStore>) {
    store
        .create(session("session-a", instant(3600)))
        .await
        .unwrap();

    store
        .touch_last_used("session-a", instant(60))
        .await
        .unwrap();

    let touched = store.get("session-a").await.unwrap().unwrap();
    assert_eq!(touched.last_used_at, instant(60));
    // Moving the hard-cap anchors would extend a session past its own
    // deadline.
    assert_eq!(touched.created_at, instant(0));
    assert_eq!(touched.expires_at, instant(3600));
}

async fn touching_an_absent_session_is_silent(store: Arc<dyn LoginSessionStore>) {
    store
        .touch_last_used("never-written", instant(60))
        .await
        .expect("a session deleted between lookup and bump is a race, not a failure");
}

async fn delete_removes_the_session_and_repeats_harmlessly(store: Arc<dyn LoginSessionStore>) {
    store
        .create(session("session-a", instant(3600)))
        .await
        .unwrap();

    store.delete("session-a").await.unwrap();
    assert!(store.get("session-a").await.unwrap().is_none());

    store
        .delete("session-a")
        .await
        .expect("a second logout for the same session is not a failure");
    store
        .delete("never-written")
        .await
        .expect("deleting a session that never existed is not a failure");
}

async fn the_sweep_removes_sessions_expired_at_the_cutoff(store: Arc<dyn LoginSessionStore>) {
    store.create(session("expired", instant(-1))).await.unwrap();
    store
        .create(session("on-the-cutoff", instant(0)))
        .await
        .unwrap();
    store.create(session("live", instant(1))).await.unwrap();

    let removed = store.delete_expired(instant(0)).await.unwrap();
    assert_eq!(
        removed, 2,
        "a session expiring exactly at the cutoff has expired",
    );
    assert!(store.get("expired").await.unwrap().is_none());
    assert!(store.get("on-the-cutoff").await.unwrap().is_none());
    assert!(store.get("live").await.unwrap().is_some());

    assert_eq!(
        store.delete_expired(instant(0)).await.unwrap(),
        0,
        "the count is what this sweep removed, not what is already gone",
    );
}

/// The sweep answers by instant, however the instant is spelled.
///
/// An expiry is a `DateTime<Utc>` to every caller, and each store keeps
/// it as it likes: one holds an instant and compares instants, another
/// holds RFC 3339 text and compares text. Those two agree only while the
/// text sorts the way the instants do, and it has two chances not to. A
/// fractional second is written only when it is non-zero, so a whole
/// second and a sub-second reading of that same second are different
/// shapes. And one instant can be named from any offset, which can put it
/// on another date.
///
/// So the three expiries here sit a microsecond apart around a whole
/// second, one of them named from five and three quarter hours east, and
/// the cutoff is that same whole second named from eight hours west,
/// where it falls on the day before.
async fn the_sweep_reads_an_expiry_as_an_instant(store: Arc<dyn LoginSessionStore>) {
    store
        .create(session("just-before", at("2026-01-02T03:04:04.999999Z")))
        .await
        .unwrap();
    store
        .create(session("on-the-second", at("2026-01-02T08:49:05+05:45")))
        .await
        .unwrap();
    store
        .create(session("just-after", at("2026-01-02T03:04:05.000001Z")))
        .await
        .unwrap();

    let removed = store
        .delete_expired(at("2026-01-01T19:04:05-08:00"))
        .await
        .unwrap();

    assert_eq!(removed, 2, "the cutoff takes the expiry that lands on it");
    assert!(store.get("just-before").await.unwrap().is_none());
    assert!(store.get("on-the-second").await.unwrap().is_none());
    assert!(
        store.get("just-after").await.unwrap().is_some(),
        "and spares the one a microsecond past it",
    );
}

async fn concurrent_creates_all_land(store: Arc<dyn LoginSessionStore>) {
    // Every sign-in mints a session on its own request, so parallel
    // creates under distinct ids are the production write pattern.
    let mut writers = Vec::new();
    for n in 0..16 {
        let store = Arc::clone(&store);
        writers.push(tokio::spawn(async move {
            store
                .create(session(&format!("session-{n}"), instant(3600)))
                .await
                .unwrap();
        }));
    }
    for writer in writers {
        writer.await.unwrap();
    }

    assert_eq!(store.delete_expired(instant(7200)).await.unwrap(), 16);
}
