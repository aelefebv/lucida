//! Live `BookmarkChanged` broadcasts.
//!
//! After a successful `POST` / `PATCH` / `DELETE` on a bookmark, the
//! handler hands off to [`broadcast_bookmark_change`] which:
//!
//!   1. Reads the current [`Session`]'s server bindings to learn which
//!      dataset URLs are loaded.
//!   2. If at least one of those URLs overlaps `dataset_urls`, dispatches
//!      `ServerMessage::BookmarkChanged` to every connected client via
//!      their per-client unicast channel.
//!
//! "Overlapping loaded datasets" maps cleanly onto the existing session
//! state: each `ServerBinding` carries its source URL, and bookmarks
//! list the URLs they reference. We compare URL-by-URL (string equality)
//! rather than going through `DatasetId` / BLAKE3 — both ends of the
//! comparison are the canonical source URL strings, and there's no
//! benefit to round-tripping through the content-derived id here.
//!
//! ## Scope rule
//!
//! A single `Session` is shared across all clients of the server (see
//! `AppState.session`); the per-session `server_bindings` are the
//! authoritative "which datasets are open" set. A bookmark whose
//! `dataset_urls` is empty (a "current view, no datasets" capture) is
//! broadcast to every connected client — the slice-4 acceptance bullet
//! "broadcast scope respects current session loaded datasets" doesn't
//! apply when the bookmark itself isn't dataset-scoped.
//!
//! ## Best-effort
//!
//! Failures (closed unicast channel, JSON serialization error) are
//! logged via `tracing::warn` and counted in the returned summary, but
//! never propagated to the HTTP response. The PRD §"Broadcast is
//! best-effort" calls this out explicitly: a sidebar that misses one
//! update self-heals on the next refresh; a 500 on the POST surfaces
//! a phantom failure to the user.
//!
//! ## Self-broadcast
//!
//! The originating client receives the broadcast too — slice-3
//! optimistic state reconciles cleanly because the broadcast-driven
//! refetch returns the same canonical state. Filtering self at the
//! server would force the web client to wire alternate plumbing for
//! the originator, doubling the surface area.

use std::sync::Arc;

use axum::extract::ws::Message;
use tokio::sync::Mutex;
use tracing::warn;

use lucida_core::protocol::{BookmarkAction, ServerMessage};

use crate::UnicastRoutes;
use crate::session::Session;

/// Outcome of a single broadcast attempt. Logged at the call site for
/// observability ("how many sidebars did this update reach?") and
/// returned to handlers that want to surface the count in tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BroadcastSummary {
    /// Number of clients the broadcast was successfully enqueued to.
    pub delivered: usize,
    /// Number of clients we tried to deliver to but the unicast channel
    /// was closed (client just disconnected). Logged only.
    pub failed: usize,
    /// Whether the broadcast scope matched any loaded dataset in the
    /// session. `false` for a non-overlapping update; the broadcast
    /// is still skipped entirely. `true` for empty `dataset_urls`
    /// (broadcast-to-all fallback) — see module docs.
    pub matched_scope: bool,
}

/// Compute the affected clients and dispatch `ServerMessage::BookmarkChanged`.
///
/// Returns a summary so handler tests can assert on the delivery count
/// without poking at internal channels. The handler discards the value
/// in production — the broadcast is fire-and-forget from its viewpoint.
pub async fn broadcast_bookmark_change(
    session: &Arc<Mutex<Session>>,
    unicast_routes: &UnicastRoutes,
    bookmark_id: &str,
    action: BookmarkAction,
    dataset_urls: &[String],
) -> BroadcastSummary {
    let mut summary = BroadcastSummary::default();

    // Decide scope: any session binding URL appears in `dataset_urls`?
    // Empty `dataset_urls` means "broadcast to everyone" (see module
    // docs). The `matched_scope` field carries the distinction.
    let in_scope = if dataset_urls.is_empty() {
        true
    } else {
        let sess = session.lock().await;
        sess.server_bindings
            .values()
            .any(|b| dataset_urls.iter().any(|u| u == &b.source_url))
    };
    summary.matched_scope = in_scope;
    if !in_scope {
        return summary;
    }

    // Build the wire message once — every recipient gets the same JSON.
    // Variant added at the end of `ServerMessage` so this serializes
    // without reshuffling existing tag positions (see
    // `wiki/gotchas/scene-document-state-json-compat`).
    let msg = ServerMessage::BookmarkChanged {
        id: bookmark_id.to_string(),
        action,
        dataset_urls: dataset_urls.to_vec(),
    };
    let json = match serde_json::to_string(&msg) {
        Ok(j) => j,
        Err(e) => {
            warn!(error = %e, "bookmarks.broadcast.serialize_failed");
            return summary;
        }
    };

    // Snapshot the unicast route map under a short-lived lock so we
    // don't hold it across `send` calls. The senders themselves are
    // unbounded mpsc — `send` returns immediately even if the receiver
    // is slow. A subsequent disconnect drops the receiver, which makes
    // future sends fail; the dropped client gets cleaned up by its
    // own handler loop.
    let senders: Vec<_> = {
        let routes = unicast_routes.lock().await;
        routes.iter().map(|(id, tx)| (*id, tx.clone())).collect()
    };
    for (client_id, sender) in senders {
        match sender.send(Message::Text(json.clone().into())) {
            Ok(()) => summary.delivered += 1,
            Err(_) => {
                summary.failed += 1;
                warn!(
                    client_id = client_id,
                    bookmark_id = bookmark_id,
                    "bookmarks.broadcast.unicast_send_failed",
                );
            }
        }
    }

    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;

    use lucida_content::{
        Axis, AxisKind, DataType, DatasetId, DatasetKind, DatasetManifest, Entity, EntityId,
        EntityKind, EntityLabels, ImageId, ImageSpec, LevelGeometry, MultiscaleInfo,
    };
    use lucida_core::protocol::{ClientId, ServerMessage};
    use lucida_protocol::{
        AssetCatalog, DatasetOpened, FetchSource, ProxiedFetchDescriptor, ProxiedImageSpec,
        WireFormat,
    };
    use lucida_store::cache::CachedStore;
    use object_store::memory::InMemory;
    use tokio::sync::{Mutex as TokioMutex, mpsc};

    use crate::UnicastRoutes;
    use crate::binding::{ChunkResolver, ServerBinding};
    use crate::generated::{DerivedChunkCache, GeneratedCoarseService};
    use crate::proxy::{ProxyCache, ProxyGenerator};
    use crate::session::Session;
    use lucida_store::import_types::ServerBindingSeed;

    /// Build a `ServerBinding` with the given source URL and just enough
    /// auxiliary state that storing it in `server_bindings` works. The
    /// proxy cache uses `new_disabled` so we don't leak temp dirs.
    fn make_binding(url: &str) -> ServerBinding {
        let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let cached = Arc::new(CachedStore::new(store.clone(), 1024));
        let resolver = Arc::new(ChunkResolver::new(&ServerBindingSeed { images: vec![] }));
        let manifest = DatasetManifest::new(
            DatasetId(format!("ds-{url}")),
            "test".into(),
            DatasetKind::Single,
            vec![Entity {
                id: EntityId("e".into()),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels::default(),
            }],
            vec![],
            vec![ImageSpec {
                image_id: ImageId("img".into()),
                owner: EntityId("e".into()),
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "z".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".into(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, 1, 1, 1, 1],
                        chunk_shape: [1, 1, 1, 1, 1],
                        grid_shape: [1, 1, 1, 1, 1],
                        scale: [1.0; 5],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                },
            }],
            vec![],
            None,
        );
        let dataset_opened = DatasetOpened {
            manifest: manifest.clone(),
            fetch: FetchSource::Proxied(ProxiedFetchDescriptor {
                images: vec![ProxiedImageSpec {
                    image_id: ImageId("img".into()),
                    wire_format: WireFormat::Raw {
                        data_type: DataType::Uint16,
                    },
                }],
            }),
            catalog: AssetCatalog::default(),
        };
        let proxy_cache = Arc::new(ProxyCache::new_disabled(
            std::path::PathBuf::from("/dev/null"),
            [0u8; 16],
        ));
        let proxy_generator = Arc::new(ProxyGenerator::new(
            proxy_cache.clone(),
            cached.clone(),
            resolver.clone(),
            Arc::new(manifest),
            1,
        ));
        let derived_chunks = Arc::new(DerivedChunkCache::default());
        ServerBinding {
            source_url: url.to_string(),
            store,
            resolver,
            cache: cached,
            dataset_opened,
            derived_chunks: derived_chunks.clone(),
            generated_service: Arc::new(GeneratedCoarseService::inert(derived_chunks)),
            legacy_proxy_enabled: false,
            proxy_cache,
            proxy_generator,
        }
    }

    /// Add a fake client to `Session.clients` and an `mpsc::UnboundedSender`
    /// to `unicast_routes`. Returns the receiving end so the test can
    /// drain delivered messages.
    async fn register_client(
        session: &Arc<TokioMutex<Session>>,
        unicast_routes: &UnicastRoutes,
        id: ClientId,
    ) -> mpsc::UnboundedReceiver<Message> {
        session.lock().await.add_client(id);
        let (tx, rx) = mpsc::unbounded_channel::<Message>();
        unicast_routes.lock().await.insert(id, tx);
        rx
    }

    /// Pull every queued message off a receiver without blocking.
    fn drain(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            if let Message::Text(t) = msg {
                out.push(t.to_string());
            }
        }
        out
    }

    async fn install_binding(session: &Arc<TokioMutex<Session>>, url: &str) {
        let mut sess = session.lock().await;
        let dataset_id = DatasetId(format!("ds-{url}"));
        sess.server_bindings.insert(dataset_id, make_binding(url));
    }

    #[tokio::test]
    async fn empty_dataset_urls_broadcasts_to_all() {
        let session = Arc::new(TokioMutex::new(Session::new()));
        let unicast_routes: UnicastRoutes = Arc::new(TokioMutex::new(HashMap::new()));
        let mut rx_a = register_client(&session, &unicast_routes, 1).await;
        let mut rx_b = register_client(&session, &unicast_routes, 2).await;

        let summary = broadcast_bookmark_change(
            &session,
            &unicast_routes,
            "bm-1",
            BookmarkAction::Created,
            &[],
        )
        .await;

        assert!(summary.matched_scope, "empty dataset_urls is broadcast-all");
        assert_eq!(summary.delivered, 2);
        assert_eq!(summary.failed, 0);

        let a = drain(&mut rx_a);
        let b = drain(&mut rx_b);
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
    }

    #[tokio::test]
    async fn matching_dataset_url_broadcasts_to_all_in_session() {
        let session = Arc::new(TokioMutex::new(Session::new()));
        let unicast_routes: UnicastRoutes = Arc::new(TokioMutex::new(HashMap::new()));
        install_binding(&session, "gs://bucket/a.zarr").await;
        let mut rx_a = register_client(&session, &unicast_routes, 1).await;
        let mut rx_b = register_client(&session, &unicast_routes, 2).await;

        let summary = broadcast_bookmark_change(
            &session,
            &unicast_routes,
            "bm-1",
            BookmarkAction::Created,
            &["gs://bucket/a.zarr".to_string()],
        )
        .await;

        assert!(summary.matched_scope);
        assert_eq!(summary.delivered, 2);
        let msgs_a = drain(&mut rx_a);
        let msgs_b = drain(&mut rx_b);
        assert_eq!(msgs_a.len(), 1);
        assert_eq!(msgs_b.len(), 1);
        // Sanity: payload parses back as BookmarkChanged.
        let parsed: ServerMessage = serde_json::from_str(&msgs_a[0]).unwrap();
        match parsed {
            ServerMessage::BookmarkChanged {
                id,
                action,
                dataset_urls,
            } => {
                assert_eq!(id, "bm-1");
                assert_eq!(action, BookmarkAction::Created);
                assert_eq!(dataset_urls, vec!["gs://bucket/a.zarr".to_string()]);
            }
            _ => panic!("unexpected variant"),
        }
    }

    #[tokio::test]
    async fn non_overlapping_url_skips_broadcast_entirely() {
        let session = Arc::new(TokioMutex::new(Session::new()));
        let unicast_routes: UnicastRoutes = Arc::new(TokioMutex::new(HashMap::new()));
        install_binding(&session, "gs://bucket/a.zarr").await;
        let mut rx = register_client(&session, &unicast_routes, 1).await;

        let summary = broadcast_bookmark_change(
            &session,
            &unicast_routes,
            "bm-x",
            BookmarkAction::Updated,
            &["gs://other/b.zarr".to_string()],
        )
        .await;

        assert!(!summary.matched_scope);
        assert_eq!(summary.delivered, 0);
        assert!(drain(&mut rx).is_empty());
    }

    #[tokio::test]
    async fn closed_receiver_counts_as_failure_not_delivery() {
        let session = Arc::new(TokioMutex::new(Session::new()));
        let unicast_routes: UnicastRoutes = Arc::new(TokioMutex::new(HashMap::new()));
        let _rx = register_client(&session, &unicast_routes, 1).await;
        // Drop the second receiver before broadcasting — the unicast
        // channel rejects the send.
        {
            let rx2 = register_client(&session, &unicast_routes, 2).await;
            drop(rx2);
        }

        let summary = broadcast_bookmark_change(
            &session,
            &unicast_routes,
            "bm-x",
            BookmarkAction::Deleted,
            &[],
        )
        .await;
        assert_eq!(summary.delivered, 1);
        assert_eq!(summary.failed, 1);
    }

    #[tokio::test]
    async fn no_clients_no_delivery_no_failure() {
        let session = Arc::new(TokioMutex::new(Session::new()));
        let unicast_routes: UnicastRoutes = Arc::new(TokioMutex::new(HashMap::new()));

        let summary = broadcast_bookmark_change(
            &session,
            &unicast_routes,
            "bm-x",
            BookmarkAction::Created,
            &[],
        )
        .await;
        assert!(summary.matched_scope);
        assert_eq!(summary.delivered, 0);
        assert_eq!(summary.failed, 0);
    }
}
