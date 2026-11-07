//! Conformance suite for `InboxStore`.
//!
//! Two implementations, SQLite and PostgreSQL, and every case runs
//! against both. The PostgreSQL one is in `when_available:` because it
//! needs a server the machine may not have.
//!
//! Each case gets both the inbox and the workspace store over one
//! database, because an entry belongs to a workspace and a workspace has
//! to exist for one to be written. The pair is what a factory hands
//! over; nothing here names a table to make it.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use lucida_core::auth_principal::AuthPrincipal;

use crate::inbox::{InboxStore, NewInboxEntry};
use crate::storage::StorageBackend;
use crate::storage::test_support::{postgres_backend, sqlite_backend};
use crate::workspace::WorkspaceStore;

conformance_suite! {
    cases: [
        a_sent_bundle_comes_back_byte_for_byte,
        a_listing_carries_the_header_and_the_size_and_not_the_bundle,
        a_listing_puts_the_newest_first,
        an_inbox_holds_only_its_own_workspaces_reports,
        an_entry_of_another_workspace_is_not_fetchable_by_id,
        an_absent_entry_reads_as_none,
        an_entry_past_its_expiry_is_neither_listed_nor_fetched,
        a_send_sweeps_whatever_has_expired,
        a_swept_inbox_says_how_many_entries_went,
    ],
    over: [sqlite],
    when_available: [postgres],
}

/// One database's inbox, and the workspace store that can make a
/// workspace for entries to belong to.
struct Inbox {
    store: Arc<dyn InboxStore>,
    workspaces: Arc<dyn WorkspaceStore>,
}

async fn sqlite() -> Inbox {
    let backend = sqlite_backend().await;
    Inbox {
        store: backend.inbox(),
        workspaces: backend.workspaces(),
    }
}

/// `None` when no PostgreSQL was offered. The harness says so once, on
/// stderr, rather than letting the whole suite pass without running.
async fn postgres() -> Option<Inbox> {
    let backend = postgres_backend().await?.backend;
    Some(Inbox {
        store: backend.inbox(),
        workspaces: backend.workspaces(),
    })
}

/// A fixed instant to stamp entries against. Cases that care about
/// expiry name their own instants relative to this one, so nothing here
/// depends on how long a test takes to run.
fn sent_at() -> DateTime<Utc> {
    "2026-09-09T14:05:00Z".parse().unwrap()
}

fn sender(email: &str) -> AuthPrincipal {
    AuthPrincipal {
        email: email.to_string(),
        display_name: format!("{email} display name"),
        picture_url: None,
        is_admin: false,
    }
}

/// A bundle, small enough to read in a failure message and shaped like
/// the real one: a header the listing shows, and a payload it does not.
fn bundle(run_id: &str) -> String {
    format!(
        r#"{{"format":"lucida-trace-bundle","bundleVersion":1,"header":{{"runId":"{run_id}"}},"trace":{{"runs":[]}}}}"#
    )
}

fn header(run_id: &str) -> String {
    format!(r#"{{"runId":"{run_id}"}}"#)
}

/// A workspace to send reports to, with `owner@example.com` in it.
async fn workspace(inbox: &Inbox, name: &str) -> String {
    inbox
        .workspaces
        .create_workspace(&sender("owner@example.com"), Some(name))
        .await
        .unwrap()
        .id
}

/// Send one bundle, at `sent_at()` unless the case says otherwise.
async fn send_at(
    inbox: &Inbox,
    workspace_id: &str,
    run_id: &str,
    at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> String {
    let payload = bundle(run_id);
    inbox
        .store
        .put(NewInboxEntry {
            workspace_id,
            sent_by: "owner@example.com",
            sent_by_name: "Owner",
            sent_at: at,
            expires_at,
            header_json: &header(run_id),
            bundle_json: &payload,
        })
        .await
        .unwrap()
        .id
}

/// Send one bundle that stays readable for a fortnight, which is what
/// the retention does in production.
async fn send(inbox: &Inbox, workspace_id: &str, run_id: &str) -> String {
    send_at(
        inbox,
        workspace_id,
        run_id,
        sent_at(),
        sent_at() + Duration::days(14),
    )
    .await
}

async fn a_sent_bundle_comes_back_byte_for_byte(inbox: Inbox) {
    let workspace_id = workspace(&inbox, "Field reports").await;
    let entry_id = send(&inbox, &workspace_id, "remote-cold").await;

    let fetched = inbox
        .store
        .fetch(&workspace_id, &entry_id, sent_at())
        .await
        .unwrap()
        .expect("the entry that was just written");
    // The whole point of the inbox: what a reader fetches is what the
    // sender's page produced, not something reassembled from a parse.
    assert_eq!(fetched.bundle_json, bundle("remote-cold"));
    assert_eq!(fetched.entry.id, entry_id);
    assert_eq!(fetched.entry.workspace_id, workspace_id);
    assert_eq!(fetched.entry.sent_by, "owner@example.com");
    assert_eq!(fetched.entry.sent_by_name, "Owner");
    assert_eq!(fetched.entry.sent_at, sent_at());
    assert_eq!(fetched.entry.expires_at, sent_at() + Duration::days(14));
}

async fn a_listing_carries_the_header_and_the_size_and_not_the_bundle(inbox: Inbox) {
    let workspace_id = workspace(&inbox, "Field reports").await;
    send(&inbox, &workspace_id, "remote-cold").await;

    let listed = inbox.store.list(&workspace_id, sent_at()).await.unwrap();
    let [entry] = listed.as_slice() else {
        panic!("one entry was sent, {} came back", listed.len());
    };
    assert_eq!(entry.header_json, header("remote-cold"));
    assert_eq!(entry.size_bytes, bundle("remote-cold").len() as i64);
}

async fn a_listing_puts_the_newest_first(inbox: Inbox) {
    let workspace_id = workspace(&inbox, "Field reports").await;
    let older = send_at(
        &inbox,
        &workspace_id,
        "older",
        sent_at(),
        sent_at() + Duration::days(14),
    )
    .await;
    let newer = send_at(
        &inbox,
        &workspace_id,
        "newer",
        sent_at() + Duration::minutes(1),
        sent_at() + Duration::days(14),
    )
    .await;

    let listed = inbox.store.list(&workspace_id, sent_at()).await.unwrap();
    let ids: Vec<&str> = listed.iter().map(|entry| entry.id.as_str()).collect();
    assert_eq!(ids, [newer.as_str(), older.as_str()]);
}

async fn an_inbox_holds_only_its_own_workspaces_reports(inbox: Inbox) {
    let mine = workspace(&inbox, "Mine").await;
    let theirs = workspace(&inbox, "Theirs").await;
    send(&inbox, &mine, "mine").await;
    send(&inbox, &theirs, "theirs").await;

    let listed = inbox.store.list(&mine, sent_at()).await.unwrap();
    let headers: Vec<&str> = listed
        .iter()
        .map(|entry| entry.header_json.as_str())
        .collect();
    assert_eq!(headers, [header("mine").as_str()]);
}

/// An entry id is the only thing a fetch carries, so a store that
/// answered on the id alone would hand one workspace's field report to
/// another.
async fn an_entry_of_another_workspace_is_not_fetchable_by_id(inbox: Inbox) {
    let mine = workspace(&inbox, "Mine").await;
    let theirs = workspace(&inbox, "Theirs").await;
    let entry_id = send(&inbox, &theirs, "theirs").await;

    assert!(
        inbox
            .store
            .fetch(&mine, &entry_id, sent_at())
            .await
            .unwrap()
            .is_none()
    );
}

async fn an_absent_entry_reads_as_none(inbox: Inbox) {
    let workspace_id = workspace(&inbox, "Field reports").await;
    assert!(
        inbox
            .store
            .fetch(&workspace_id, "never-sent", sent_at())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        inbox
            .store
            .list(&workspace_id, sent_at())
            .await
            .unwrap()
            .is_empty()
    );
}

/// Retention is what the inbox promises, so expiry is judged on the
/// read: an entry stops being visible the moment it passes, whether or
/// not a sweep has run since.
async fn an_entry_past_its_expiry_is_neither_listed_nor_fetched(inbox: Inbox) {
    let workspace_id = workspace(&inbox, "Field reports").await;
    let expires_at = sent_at() + Duration::days(14);
    let entry_id = send_at(&inbox, &workspace_id, "remote-cold", sent_at(), expires_at).await;

    let a_moment_before = expires_at - Duration::seconds(1);
    assert_eq!(
        inbox
            .store
            .list(&workspace_id, a_moment_before)
            .await
            .unwrap()
            .len(),
        1,
        "the entry is readable up to its expiry",
    );

    assert!(
        inbox
            .store
            .list(&workspace_id, expires_at)
            .await
            .unwrap()
            .is_empty(),
        "the listing stops showing it at the expiry",
    );
    assert!(
        inbox
            .store
            .fetch(&workspace_id, &entry_id, expires_at)
            .await
            .unwrap()
            .is_none(),
        "a fetch by id stops finding it at the expiry",
    );
}

/// The table grows only when somebody sends, so that is where it is
/// swept. An inbox nobody tends still empties itself.
async fn a_send_sweeps_whatever_has_expired(inbox: Inbox) {
    let workspace_id = workspace(&inbox, "Field reports").await;
    let stale_expiry = sent_at() + Duration::days(14);
    send_at(&inbox, &workspace_id, "stale", sent_at(), stale_expiry).await;

    let a_fortnight_later = stale_expiry + Duration::minutes(1);
    send_at(
        &inbox,
        &workspace_id,
        "fresh",
        a_fortnight_later,
        a_fortnight_later + Duration::days(14),
    )
    .await;

    // Asked as of the stale entry's own lifetime, when nothing about it
    // had expired yet: a store that only filtered on the read would list
    // it here, so its absence is the row being gone.
    let listed = inbox.store.list(&workspace_id, sent_at()).await.unwrap();
    let headers: Vec<&str> = listed
        .iter()
        .map(|entry| entry.header_json.as_str())
        .collect();
    assert_eq!(
        headers,
        [header("fresh").as_str()],
        "the send swept the entry that had expired by then, and kept its own",
    );
}

async fn a_swept_inbox_says_how_many_entries_went(inbox: Inbox) {
    let workspace_id = workspace(&inbox, "Field reports").await;
    let expires_at = sent_at() + Duration::days(14);
    send_at(&inbox, &workspace_id, "one", sent_at(), expires_at).await;
    send_at(&inbox, &workspace_id, "two", sent_at(), expires_at).await;

    assert_eq!(inbox.store.delete_expired(sent_at()).await.unwrap(), 0);
    assert_eq!(inbox.store.delete_expired(expires_at).await.unwrap(), 2);
    assert_eq!(inbox.store.delete_expired(expires_at).await.unwrap(), 0);
}
