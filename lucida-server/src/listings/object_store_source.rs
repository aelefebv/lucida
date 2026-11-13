//! The dataset source lucida ships: every dataset under the data roots,
//! grouped by the folder it sits in. It records no owner.
//!
//! Each root is walked through the object store it opens as, so a root in
//! a bucket walks the way a local directory does.

use std::sync::Arc;

use futures_util::future::join_all;
use lucida_content::url::DatasetLocation;
use lucida_store::backend;
use lucida_store::source_policy::SourcePolicy;
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
    pub async fn configured(context: &SourceContext) -> Option<Arc<dyn DatasetSource>> {
        let roots = open_roots(&context.policy).await;
        if roots.is_empty() {
            return None;
        }
        Some(Arc::new(Self::new(roots)))
    }
}

/// Every data root `policy` holds, on this machine and in buckets, opened
/// as the store it walks. A root that does not open is logged and left out.
async fn open_roots(policy: &SourcePolicy) -> Vec<DataRoot> {
    let local = policy.data_roots().filter_map(|path| {
        let location = path
            .to_str()
            .and_then(|text| DatasetLocation::parse(text).ok());
        if location.is_none() {
            tracing::warn!(root = %path.display(), "listings.data_root_unparsed");
        }
        location
    });
    let locations: Vec<DatasetLocation> = local.chain(policy.bucket_roots().cloned()).collect();
    let mut roots = Vec::new();
    for location in locations {
        match backend::open_permitted(&location, policy).await {
            Ok(store) => roots.push(DataRoot { location, store }),
            Err(error) => {
                tracing::warn!(root = %location, error = %error, "listings.data_root_unopened");
            }
        }
    }
    roots
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
    use lucida_store::source_policy::SourcePolicyConfig;
    use object_store::memory::InMemory;
    use object_store::path::Path;
    use object_store::prefix::PrefixStore;
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

    #[tokio::test]
    async fn a_bucket_root_lists_its_datasets_under_their_parent_prefixes() {
        let image = serde_json::json!({"zarr_format": 3, "node_type": "group",
            "attributes": {"ome": {"multiscales": [{}]}}});
        let shared = InMemory::new();
        put(&shared, "images/a.zarr/zarr.json", image.clone()).await;
        put(&shared, "images/runs/b.zarr/zarr.json", image.clone()).await;
        put(&shared, "other/c.zarr/zarr.json", image.clone()).await;
        let top = InMemory::new();
        put(&top, "d.zarr/zarr.json", image).await;
        let source = ObjectStoreSource::new(vec![
            DataRoot {
                location: DatasetLocation::parse("gs://shared/images").unwrap(),
                store: Arc::new(PrefixStore::new(shared, "images")),
            },
            DataRoot {
                location: DatasetLocation::parse("s3://top").unwrap(),
                store: Arc::new(top),
            },
        ]);

        let listings = source.listings().await.unwrap();
        let summary: Vec<_> = listings
            .iter()
            .map(|l| (l.url.as_str(), l.group.clone()))
            .collect();
        assert_eq!(
            summary,
            [
                (
                    "gs://shared/images/a.zarr",
                    group("gs://shared/images", "images")
                ),
                (
                    "gs://shared/images/runs/b.zarr",
                    group("gs://shared/images/runs", "runs")
                ),
                ("s3://top/d.zarr", group("s3://top", "top")),
            ]
        );
    }

    /// The bucket allowlist leaves the root's bucket out, so only the root
    /// itself lets it open.
    #[tokio::test]
    async fn bucket_roots_are_opened_beside_local_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let policy = SourcePolicy::new(SourcePolicyConfig {
            restricted: true,
            data_roots: vec![tmp.path().to_path_buf()],
            bucket_roots: vec!["gs://shared/images".into()],
            allowed_buckets: vec!["gs://team-data".into()],
            ..Default::default()
        })
        .unwrap();

        let roots = open_roots(&policy).await;
        let locations: Vec<_> = roots.iter().map(|root| root.location.as_str()).collect();
        let local = DatasetLocation::parse(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(locations, [local.as_str(), "gs://shared/images"]);
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
