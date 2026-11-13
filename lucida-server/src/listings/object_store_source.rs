//! The dataset source lucida ships: every dataset under the data roots,
//! grouped by the folder it sits in. It records no owner.
//!
//! Each root is walked through the object store it opens as, so a root in
//! a bucket would walk the way a local directory does.

use std::sync::Arc;

use futures_util::future::join_all;
use lucida_content::url::DatasetLocation;
use lucida_store::backend;
use lucida_store::zarr_roots::{self, RootKind, WalkLimits, ZarrRoot};
use object_store::ObjectStore;

use super::{DatasetSource, Listing, ListingGroup, ListingKind, SourceContext, SourceError};

/// One data root and the object store it opens as.
pub struct DataRoot {
    pub location: DatasetLocation,
    pub store: Arc<dyn ObjectStore>,
}

pub struct ObjectStoreSource {
    roots: Vec<DataRoot>,
}

impl ObjectStoreSource {
    pub fn new(roots: Vec<DataRoot>) -> Self {
        Self { roots }
    }

    /// The source over the configured data roots, or `None` without any.
    /// A root that does not open is logged and left out.
    pub async fn configured(context: &SourceContext) -> Option<Arc<dyn DatasetSource>> {
        let policy = &context.policy;
        let mut roots = Vec::new();
        for path in policy.data_roots() {
            let Some(location) = path
                .to_str()
                .and_then(|text| DatasetLocation::parse(text).ok())
            else {
                tracing::warn!(root = %path.display(), "listings.data_root_unparsed");
                continue;
            };
            match backend::open_permitted(&location, policy).await {
                Ok(store) => roots.push(DataRoot { location, store }),
                Err(error) => {
                    tracing::warn!(root = %location, error = %error, "listings.data_root_unopened");
                }
            }
        }
        if roots.is_empty() {
            return None;
        }
        Some(Arc::new(Self::new(roots)))
    }
}

#[async_trait::async_trait]
impl DatasetSource for ObjectStoreSource {
    fn group_noun(&self) -> &str {
        "Folder"
    }

    async fn listings(&self) -> Result<Vec<Listing>, SourceError> {
        let walks = join_all(self.roots.iter().map(|root| async move {
            let found = zarr_roots::find(Arc::clone(&root.store), WalkLimits::default()).await;
            (root, found)
        }))
        .await;
        let mut listings = Vec::new();
        for (root, found) in walks {
            match found {
                Ok(found) => listings.extend(found.into_iter().filter_map(|z| listing(root, z))),
                // One root that cannot be listed leaves the others listed.
                Err(error) => {
                    tracing::warn!(root = %root.location, error = %error, "listings.data_root_unlisted");
                }
            }
        }
        Ok(listings)
    }
}

fn listing(root: &DataRoot, found: ZarrRoot) -> Option<Listing> {
    let mut url = root.location.as_str().trim_end_matches('/').to_string();
    for part in found.path.parts() {
        url.push('/');
        url.push_str(part.as_ref());
    }
    let location = DatasetLocation::parse(&url).ok()?;
    Some(Listing {
        title: location.display_name().to_string(),
        group: parent_folder(location.as_str()),
        url: location.into_string(),
        kind: match found.kind {
            RootKind::Image => ListingKind::Image,
            RootKind::Collection => ListingKind::Collection,
        },
        tiles: found.tiles,
        owner: None,
        date: Some(found.modified),
        fields: Vec::new(),
    })
}

/// The folder `url` sits in, or `None` when nothing above it names one: a
/// filesystem's root, a drive, or the scheme above a bucket.
fn parent_folder(url: &str) -> Option<ListingGroup> {
    let (parent, _) = url.rsplit_once('/')?;
    if parent.is_empty() || parent.ends_with(':') || parent.ends_with('/') {
        return None;
    }
    let label = parent.rsplit('/').next().unwrap_or(parent);
    Some(ListingGroup {
        id: parent.to_string(),
        label: label.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use object_store::memory::InMemory;
    use object_store::path::Path;
    use object_store::{ObjectStoreExt, PutPayload};

    async fn put(store: &InMemory, path: &str, document: serde_json::Value) {
        store
            .put(&Path::from(path), PutPayload::from(document.to_string()))
            .await
            .unwrap();
    }

    fn group(id: &str, label: &str) -> Option<ListingGroup> {
        Some(ListingGroup {
            id: id.into(),
            label: label.into(),
        })
    }

    #[tokio::test]
    async fn each_dataset_is_listed_under_the_folder_it_sits_in() {
        let store = InMemory::new();
        put(
            &store,
            "a.zarr/zarr.json",
            serde_json::json!({"zarr_format": 3, "node_type": "group",
                "attributes": {"ome": {"multiscales": [{}]}}}),
        )
        .await;
        put(
            &store,
            "runs/b.ome.zarr/.zattrs",
            serde_json::json!({"plate": {"wells": [{"path": "A/1"}, {"path": "A/2"}]}}),
        )
        .await;
        let source = ObjectStoreSource::new(vec![DataRoot {
            location: DatasetLocation::parse("/srv/data").unwrap(),
            store: Arc::new(store),
        }]);

        let listings = source.listings().await.unwrap();
        let summary: Vec<_> = listings
            .iter()
            .map(|l| (l.url.as_str(), l.title.as_str(), l.kind, l.group.clone()))
            .collect();
        assert_eq!(
            summary,
            [
                (
                    "/srv/data/a.zarr",
                    "a.zarr",
                    ListingKind::Image,
                    group("/srv/data", "data")
                ),
                (
                    "/srv/data/runs/b.ome.zarr",
                    "b.ome.zarr",
                    ListingKind::Collection,
                    group("/srv/data/runs", "runs")
                ),
            ]
        );
        let tiles: Vec<_> = listings.iter().map(|l| l.tiles).collect();
        assert_eq!(tiles, [None, Some(2)]);
        assert!(listings.iter().all(|l| l.owner.is_none()));
        assert!(listings.iter().all(|l| l.date.is_some()));
        assert_eq!(source.group_noun(), "Folder");
    }

    #[test]
    fn the_top_of_a_filesystem_or_a_bucket_is_no_folder() {
        assert_eq!(
            parent_folder("gs://bucket/runs/a.zarr"),
            group("gs://bucket/runs", "runs")
        );
        assert_eq!(
            parent_folder("gs://bucket/a.zarr"),
            group("gs://bucket", "bucket")
        );
        assert_eq!(
            parent_folder("//server/share/a.zarr"),
            group("//server/share", "share")
        );
        for url in ["/a.zarr", "c:/a.zarr", "gs://bucket"] {
            assert_eq!(parent_folder(url), None, "{url}");
        }
    }
}
