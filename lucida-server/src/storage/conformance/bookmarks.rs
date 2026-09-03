//! Conformance suite for `BookmarkStore`.

use std::sync::Arc;

use lucida_core::saved_view::SavedView;

use crate::bookmarks::{Bookmark, BookmarkStore, MemoryBookmarkStore};
use crate::storage::StorageBackend;
use crate::storage::test_support::sqlite_backend;

conformance_suite! {
    cases: [
        a_created_bookmark_reads_back,
        an_absent_bookmark_reads_as_none,
        create_deduplicates_and_sorts_the_dataset_urls,
        listing_puts_the_newest_first,
        overlap_lists_every_bookmark_that_shares_a_url,
        overlap_lists_a_bookmark_once_however_many_urls_match,
        an_empty_overlap_query_lists_everything,
        rename_changes_only_the_name,
        renaming_an_absent_bookmark_is_none,
        delete_hands_back_the_row_it_removed,
        deleting_an_absent_bookmark_is_none,
        delete_drops_the_dataset_attachments,
        concurrent_creates_all_land,
    ],
    over: [memory, sqlite],
}

async fn memory() -> Arc<dyn BookmarkStore> {
    Arc::new(MemoryBookmarkStore::new())
}

async fn sqlite() -> Arc<dyn BookmarkStore> {
    sqlite_backend().await.bookmarks()
}

/// Create a bookmark named `name` over `datasets`, with a view whose
/// viewport encodes `name` so a round-trip can be checked without
/// building a payload by hand.
async fn bookmark(store: &Arc<dyn BookmarkStore>, name: &str, datasets: &[&str]) -> Bookmark {
    store
        .create(
            name,
            "author@example.com",
            "Author",
            datasets.iter().map(|url| (*url).to_string()).collect(),
            SavedView::empty([name.len() as u32, 600]),
        )
        .await
        .unwrap()
}

/// Three bookmarks with overlapping attachments, oldest first: `a`+`b`,
/// `b`+`c`, then `d`. Every ordering assertion in the suite reads their
/// creation order back out, so this checks the premise — both stores take
/// `created_at` from the clock, and neither settles a tie.
async fn three_bookmarks(store: &Arc<dyn BookmarkStore>) -> (Bookmark, Bookmark, Bookmark) {
    let first = bookmark(
        store,
        "first",
        &["file:///data/a.zarr", "file:///data/b.zarr"],
    )
    .await;
    let second = bookmark(
        store,
        "second",
        &["file:///data/b.zarr", "file:///data/c.zarr"],
    )
    .await;
    let third = bookmark(store, "third", &["file:///data/d.zarr"]).await;
    assert!(
        first.created_at < second.created_at && second.created_at < third.created_at,
        "newest-first is only a defined order over distinct creation instants",
    );
    (first, second, third)
}

fn ids(bookmarks: &[Bookmark]) -> Vec<&str> {
    bookmarks.iter().map(|b| b.id.as_str()).collect()
}

async fn a_created_bookmark_reads_back(store: Arc<dyn BookmarkStore>) {
    let created = bookmark(&store, "Region overview", &["file:///data/a.zarr"]).await;
    assert_eq!(created.name, "Region overview");
    assert_eq!(created.created_by, "author@example.com");
    assert_eq!(created.created_by_name, "Author");
    assert_eq!(created.datasets, ["file:///data/a.zarr"]);

    let found = store.get(&created.id).await.unwrap().unwrap();
    assert_eq!(found.id, created.id);
    assert_eq!(found.name, created.name);
    assert_eq!(found.created_by, created.created_by);
    assert_eq!(found.created_by_name, created.created_by_name);
    assert_eq!(found.created_at, created.created_at);
    assert_eq!(found.datasets, created.datasets);
    assert_eq!(found.view, created.view);
}

async fn an_absent_bookmark_reads_as_none(store: Arc<dyn BookmarkStore>) {
    assert!(store.get("never-created").await.unwrap().is_none());
}

async fn create_deduplicates_and_sorts_the_dataset_urls(store: Arc<dyn BookmarkStore>) {
    let created = bookmark(
        &store,
        "Two datasets",
        &[
            "file:///data/b.zarr",
            "file:///data/a.zarr",
            "file:///data/b.zarr",
        ],
    )
    .await;

    assert_eq!(
        created.datasets,
        ["file:///data/a.zarr", "file:///data/b.zarr"],
        "the attached URLs are a set, so they come back deduplicated and in one settled order",
    );
    assert_eq!(
        store.get(&created.id).await.unwrap().unwrap().datasets,
        created.datasets,
        "the list a create hands back is the list a read hands back",
    );
}

async fn listing_puts_the_newest_first(store: Arc<dyn BookmarkStore>) {
    let (first, second, third) = three_bookmarks(&store).await;

    let listed = store.list_all().await.unwrap();
    assert_eq!(ids(&listed), [&third.id, &second.id, &first.id]);
}

async fn overlap_lists_every_bookmark_that_shares_a_url(store: Arc<dyn BookmarkStore>) {
    let (first, second, third) = three_bookmarks(&store).await;

    // Overlap matches keep the newest-first order an unfiltered listing
    // uses.
    let matched = store
        .list_by_dataset_overlap(&["file:///data/b.zarr".to_string()])
        .await
        .unwrap();
    assert_eq!(ids(&matched), [&second.id, &first.id]);

    // Several URLs union rather than intersect.
    let union = store
        .list_by_dataset_overlap(&[
            "file:///data/a.zarr".to_string(),
            "file:///data/d.zarr".to_string(),
        ])
        .await
        .unwrap();
    assert_eq!(ids(&union), [&third.id, &first.id]);

    let unmatched = store
        .list_by_dataset_overlap(&["file:///data/nothing.zarr".to_string()])
        .await
        .unwrap();
    assert!(unmatched.is_empty());
}

async fn overlap_lists_a_bookmark_once_however_many_urls_match(store: Arc<dyn BookmarkStore>) {
    let both = bookmark(
        &store,
        "both",
        &["file:///data/a.zarr", "file:///data/b.zarr"],
    )
    .await;

    let matched = store
        .list_by_dataset_overlap(&[
            "file:///data/a.zarr".to_string(),
            "file:///data/b.zarr".to_string(),
        ])
        .await
        .unwrap();
    assert_eq!(ids(&matched), [&both.id]);
}

async fn an_empty_overlap_query_lists_everything(store: Arc<dyn BookmarkStore>) {
    bookmark(&store, "first", &["file:///data/a.zarr"]).await;
    bookmark(&store, "second", &[]).await;

    // No datasets open yet is the sidebar's cold start, and it asks to
    // see everything rather than nothing.
    let listed = store.list_by_dataset_overlap(&[]).await.unwrap();
    assert_eq!(listed.len(), 2);
}

async fn rename_changes_only_the_name(store: Arc<dyn BookmarkStore>) {
    let created = bookmark(&store, "old name", &["file:///data/a.zarr"]).await;

    let renamed = store
        .patch_name(&created.id, "new name")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renamed.name, "new name");
    assert_eq!(renamed.created_by, created.created_by);
    assert_eq!(renamed.created_at, created.created_at);
    assert_eq!(renamed.datasets, created.datasets);
    assert_eq!(renamed.view, created.view);

    assert_eq!(
        store.get(&created.id).await.unwrap().unwrap().name,
        "new name"
    );
}

async fn renaming_an_absent_bookmark_is_none(store: Arc<dyn BookmarkStore>) {
    assert!(
        store
            .patch_name("never-created", "new name")
            .await
            .unwrap()
            .is_none()
    );
}

async fn delete_hands_back_the_row_it_removed(store: Arc<dyn BookmarkStore>) {
    let created = bookmark(
        &store,
        "doomed",
        &["file:///data/a.zarr", "file:///data/b.zarr"],
    )
    .await;

    // The caller scopes its change fanout on the removed row's datasets,
    // so delete owes them back rather than making it read first and race.
    let removed = store.delete(&created.id).await.unwrap().unwrap();
    assert_eq!(removed.id, created.id);
    assert_eq!(removed.name, "doomed");
    assert_eq!(removed.datasets, created.datasets);

    assert!(store.get(&created.id).await.unwrap().is_none());
}

async fn deleting_an_absent_bookmark_is_none(store: Arc<dyn BookmarkStore>) {
    assert!(store.delete("never-created").await.unwrap().is_none());

    let created = bookmark(&store, "doomed", &["file:///data/a.zarr"]).await;
    store.delete(&created.id).await.unwrap();
    assert!(
        store.delete(&created.id).await.unwrap().is_none(),
        "only the caller who actually removed the bookmark is told so",
    );
}

async fn delete_drops_the_dataset_attachments(store: Arc<dyn BookmarkStore>) {
    let created = bookmark(&store, "doomed", &["file:///data/only-here.zarr"]).await;

    store.delete(&created.id).await.unwrap();

    let matched = store
        .list_by_dataset_overlap(&["file:///data/only-here.zarr".to_string()])
        .await
        .unwrap();
    assert!(
        matched.is_empty(),
        "a deleted bookmark's dataset attachments go with it",
    );
}

async fn concurrent_creates_all_land(store: Arc<dyn BookmarkStore>) {
    let mut writers = Vec::new();
    for n in 0..16 {
        let store = Arc::clone(&store);
        writers.push(tokio::spawn(async move {
            bookmark(&store, &format!("bookmark-{n}"), &["file:///data/a.zarr"])
                .await
                .id
        }));
    }

    let mut ids = std::collections::HashSet::new();
    for writer in writers {
        ids.insert(writer.await.unwrap());
    }
    assert_eq!(ids.len(), 16, "the store mints a distinct id per bookmark");
    assert_eq!(store.list_all().await.unwrap().len(), 16);
}
