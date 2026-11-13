//! Finding the datasets under an object store without opening them: a walk
//! one folder level at a time that stops at the root of each Zarr hierarchy.
//!
//! The walk goes through the [`ObjectStore`] interface only, so a bucket
//! prefix walks the way a local directory does.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use futures_util::stream::{self, StreamExt};
use object_store::path::Path;
use object_store::prefix::PrefixStore;
use object_store::{ListResult, ObjectStore};

use crate::backend::{MetadataFault, StoreError};
use crate::cache::CachedStore;
use crate::parse;
pub use crate::parse::RootKind;

/// The root of one Zarr hierarchy that opens as a dataset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZarrRoot {
    /// Where it is, relative to the walked store. Empty when the walked
    /// store is itself a Zarr root.
    pub path: Path,
    pub kind: RootKind,
    /// How many tiles a collection lays out; `None` for an image.
    pub tiles: Option<usize>,
    /// When its root metadata was last written.
    pub modified: DateTime<Utc>,
}

/// How far one walk may go. A symlink cycle or a vast tree that holds no
/// datasets must not keep a walk going, or spend a list request per folder
/// without end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalkLimits {
    /// Folder levels below the walked store.
    pub max_depth: usize,
    /// Folders listed, the walked store's own root included.
    pub max_folders: usize,
}

impl Default for WalkLimits {
    fn default() -> Self {
        Self {
            max_depth: 12,
            max_folders: 20_000,
        }
    }
}

/// The objects that make a folder a Zarr node. The walk never lists inside
/// one: below a node there are only more nodes and chunks.
const NODE_METADATA: [&str; 5] = ["zarr.json", ".zattrs", ".zgroup", ".zarray", ".zmetadata"];

/// Folders listed, and roots read, at once.
const WALK_CONCURRENCY: usize = 8;

/// The cache a root's metadata is read through. It holds one root's
/// documents for one read.
const ROOT_CACHE_BYTES: usize = 1 << 20;

/// Every Zarr root under `store` that opens as a dataset, sorted by path.
///
/// Fails only when the top of `store` cannot be listed. A folder below it
/// that fails to list, or a root whose metadata does not read, is logged
/// and passed over.
pub async fn find(
    store: Arc<dyn ObjectStore>,
    limits: WalkLimits,
) -> Result<Vec<ZarrRoot>, object_store::Error> {
    let top = store.list_with_delimiter(None).await?;
    let mut level = vec![(Path::default(), top)];
    let mut listed = 1;
    let mut found = Vec::new();
    for depth in 1.. {
        let mut nodes = Vec::new();
        let mut next = Vec::new();
        for (path, listing) in level {
            match node_modified(&listing) {
                Some(modified) => nodes.push((path, modified)),
                None => next.extend(listing.common_prefixes.into_iter().filter(|p| !hidden(p))),
            }
        }
        found.extend(
            stream::iter(nodes)
                .map(|(path, modified)| read_root(&store, path, modified))
                .buffer_unordered(WALK_CONCURRENCY)
                .filter_map(|root| async move { root })
                .collect::<Vec<_>>()
                .await,
        );
        if next.is_empty() {
            break;
        }
        if depth > limits.max_depth {
            tracing::warn!(
                max_depth = limits.max_depth,
                folders_left = next.len(),
                "zarr_roots.walk_too_deep"
            );
            break;
        }
        let budget = limits.max_folders.saturating_sub(listed);
        if next.len() > budget {
            tracing::warn!(
                max_folders = limits.max_folders,
                folders_left = next.len() - budget,
                "zarr_roots.walk_too_wide"
            );
            // Sorted first, so the folders a cut keeps are the same each walk.
            next.sort();
            next.truncate(budget);
        }
        listed += next.len();
        level = list_level(&store, next).await;
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(found)
}

/// One level's folders, listed. A folder that fails is left out, and the
/// level's failures are logged once.
async fn list_level(store: &Arc<dyn ObjectStore>, folders: Vec<Path>) -> Vec<(Path, ListResult)> {
    let results: Vec<_> = stream::iter(folders)
        .map(|path| async move {
            let listing = store.list_with_delimiter(Some(&path)).await;
            (path, listing)
        })
        .buffer_unordered(WALK_CONCURRENCY)
        .collect()
        .await;
    let mut level = Vec::with_capacity(results.len());
    let mut failed = Vec::new();
    for (path, listing) in results {
        match listing {
            Ok(listing) => level.push((path, listing)),
            Err(e) => failed.push((path, e)),
        }
    }
    if let Some((path, error)) = failed.first() {
        tracing::warn!(
            failed = failed.len(),
            first = %path,
            error = %error,
            "zarr_roots.folders_unlisted"
        );
    }
    level
}

/// When a folder's Zarr metadata was last written, or `None` when the
/// folder holds none and so is no Zarr node.
fn node_modified(listing: &ListResult) -> Option<DateTime<Utc>> {
    listing
        .objects
        .iter()
        .filter(|object| {
            object
                .location
                .filename()
                .is_some_and(|name| NODE_METADATA.contains(&name))
        })
        .map(|object| object.last_modified)
        .max()
}

fn hidden(folder: &Path) -> bool {
    folder.filename().is_some_and(|name| name.starts_with('.'))
}

/// The node at `path` as a dataset root, read as an open reads it. A node
/// that is no dataset root, such as a bare array or a group with neither
/// multiscales nor a collection layout, is `None`.
async fn read_root(
    store: &Arc<dyn ObjectStore>,
    path: Path,
    modified: DateTime<Utc>,
) -> Option<ZarrRoot> {
    let inner: Arc<dyn ObjectStore> = if path.as_ref().is_empty() {
        Arc::clone(store)
    } else {
        Arc::new(PrefixStore::new(Arc::clone(store), path.clone()))
    };
    let cached = Arc::new(CachedStore::new(inner, ROOT_CACHE_BYTES));
    match parse::read_root(&cached).await {
        Ok((_, root)) => parse::root_kind(&root).map(|kind| ZarrRoot {
            path,
            kind,
            tiles: parse::collection_tiles(&root),
            modified,
        }),
        Err(StoreError::Metadata {
            fault: MetadataFault::Missing,
            ..
        }) => None,
        Err(e) => {
            tracing::warn!(path = %path, error = %e, "zarr_roots.root_unreadable");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::CountingStore;
    use object_store::ObjectStoreExt;
    use serde_json::json;

    fn v3_image() -> serde_json::Value {
        json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"ome": {"version": "0.5", "multiscales": [{"axes": [], "datasets": []}]}}
        })
    }

    fn v3_collection() -> serde_json::Value {
        json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {"ome": {"version": "0.5", "plate": {}}}
        })
    }

    async fn seed(store: &CountingStore, path: &str, document: serde_json::Value) {
        store.seed(path, document.to_string()).await;
    }

    async fn walk(store: CountingStore) -> Vec<(String, RootKind)> {
        walk_with(store, WalkLimits::default()).await
    }

    async fn walk_with(store: CountingStore, limits: WalkLimits) -> Vec<(String, RootKind)> {
        find(Arc::new(store), limits)
            .await
            .unwrap()
            .into_iter()
            .map(|root| (root.path.to_string(), root.kind))
            .collect()
    }

    #[tokio::test]
    async fn zarr_v2_and_v3_roots_are_found_with_their_kinds() {
        let store = CountingStore::new(0);
        seed(&store, "a/image.zarr/zarr.json", v3_image()).await;
        seed(&store, "a/tiles.zarr/zarr.json", v3_collection()).await;
        seed(&store, "b/c/old.zarr/.zgroup", json!({"zarr_format": 2})).await;
        seed(
            &store,
            "b/c/old.zarr/.zattrs",
            json!({"multiscales": [{"axes": [], "datasets": []}]}),
        )
        .await;
        seed(&store, "b/old-tiles.zarr/.zattrs", json!({"plate": {}})).await;
        store.seed("b/notes.txt", "not a dataset").await;

        assert_eq!(
            walk(store).await,
            [
                ("a/image.zarr".to_string(), RootKind::Image),
                ("a/tiles.zarr".to_string(), RootKind::Collection),
                ("b/c/old.zarr".to_string(), RootKind::Image),
                ("b/old-tiles.zarr".to_string(), RootKind::Collection),
            ]
        );
    }

    #[tokio::test]
    async fn the_walk_never_lists_inside_a_zarr_node() {
        let store = CountingStore::new(0);
        let listed = Arc::clone(&store.listed);
        seed(&store, "a.zarr/zarr.json", v3_image()).await;
        seed(&store, "a.zarr/inner.zarr/zarr.json", v3_image()).await;
        store.seed("a.zarr/0/c/0/0/0", [0u8; 4]).await;
        // A bare array is a node too, and holds only chunks.
        seed(&store, "array/.zarray", json!({"zarr_format": 2})).await;
        store.seed("array/0/0", [0u8; 4]).await;

        assert_eq!(walk(store).await, [("a.zarr".to_string(), RootKind::Image)]);
        let mut listed = listed.lock().unwrap().clone();
        listed.sort();
        assert_eq!(listed, ["", "a.zarr", "array"]);
    }

    #[tokio::test]
    async fn groups_that_open_as_no_dataset_are_passed_over() {
        let store = CountingStore::new(0);
        seed(
            &store,
            "plain.zarr/zarr.json",
            json!({"zarr_format": 3, "node_type": "group", "attributes": {}}),
        )
        .await;
        seed(
            &store,
            "array.zarr/zarr.json",
            json!({"zarr_format": 3, "node_type": "array", "shape": [1]}),
        )
        .await;
        store.seed("broken.zarr/zarr.json", "{ not json").await;
        assert!(walk(store).await.is_empty());
    }

    #[tokio::test]
    async fn hidden_folders_are_not_walked() {
        let store = CountingStore::new(0);
        seed(&store, ".trash/a.zarr/zarr.json", v3_image()).await;
        seed(&store, "shown/.cache/b.zarr/zarr.json", v3_image()).await;
        seed(&store, "shown/c.zarr/zarr.json", v3_image()).await;
        assert_eq!(
            walk(store).await,
            [("shown/c.zarr".to_string(), RootKind::Image)]
        );
    }

    #[tokio::test]
    async fn a_walked_store_that_is_itself_a_root_is_found_at_the_empty_path() {
        let store = CountingStore::new(0);
        seed(&store, "zarr.json", v3_collection()).await;
        assert_eq!(walk(store).await, [(String::new(), RootKind::Collection)]);
    }

    #[tokio::test]
    async fn a_root_is_dated_by_its_metadata() {
        let store = CountingStore::new(0);
        seed(&store, "a.zarr/zarr.json", v3_image()).await;
        let written = store
            .head(&Path::from("a.zarr/zarr.json"))
            .await
            .unwrap()
            .last_modified;
        let found = find(Arc::new(store), WalkLimits::default()).await.unwrap();
        assert_eq!(found[0].modified, written);
    }

    #[tokio::test]
    async fn a_collection_counts_the_tiles_its_root_lays_out() {
        let store = CountingStore::new(0);
        seed(&store, "a.zarr/zarr.json", v3_image()).await;
        let wells = [
            json!({"path": "A/1", "rowIndex": 0, "columnIndex": 0}),
            json!({"path": "A/2", "rowIndex": 0, "columnIndex": 1}),
            json!({"path": "B/1", "rowIndex": 1, "columnIndex": 0}),
        ];
        seed(
            &store,
            "b.zarr/zarr.json",
            json!({"zarr_format": 3, "node_type": "group",
                "attributes": {"ome": {"version": "0.5", "plate": {"wells": wells}}}}),
        )
        .await;
        seed(&store, "c.zarr/.zattrs", json!({"plate": {"wells": wells}})).await;
        let found = find(Arc::new(store), WalkLimits::default()).await.unwrap();
        let tiles: Vec<_> = found.iter().map(|root| root.tiles).collect();
        assert_eq!(tiles, [None, Some(3), Some(3)]);
    }

    #[tokio::test]
    async fn the_limits_stop_a_walk() {
        let deep = || async {
            let store = CountingStore::new(0);
            seed(&store, "top.zarr/zarr.json", v3_image()).await;
            seed(&store, "a/b/c/deep.zarr/zarr.json", v3_image()).await;
            for i in 0..5 {
                seed(&store, &format!("wide/{i}/w.zarr/zarr.json"), v3_image()).await;
            }
            store
        };
        let shallow = WalkLimits {
            max_depth: 2,
            ..WalkLimits::default()
        };
        let found = walk_with(deep().await, shallow).await;
        assert!(found.iter().any(|(path, _)| path == "top.zarr"));
        assert!(!found.iter().any(|(path, _)| path == "a/b/c/deep.zarr"));

        let narrow = WalkLimits {
            max_folders: 4,
            ..WalkLimits::default()
        };
        let store = deep().await;
        let listed = Arc::clone(&store.listed);
        walk_with(store, narrow).await;
        assert_eq!(listed.lock().unwrap().len(), 4);
    }
}
