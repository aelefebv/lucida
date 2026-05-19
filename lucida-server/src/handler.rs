use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use lucida_content::{DatasetId, DatasetManifest, EntityId, EntityKind, ImageId};
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ChunkMessage, ClientId, ClientMessage, ServerMessage};
use lucida_protocol::{
    AssetCatalog, AssetMessage, DatasetOpened, GeneratedAvailabilityDelta, GeneratedChunkStatus,
    ProxyAvailability, ProxyFootprint,
};
use lucida_proxy::{ProxyAsset, ProxyKind, ProxySpec, estimate_proxy_dims};
use lucida_store::cache::CachedStore;
use object_store::path::Path;
use tokio::sync::{Mutex, broadcast, mpsc};

use crate::binding::{ChunkResolver, ServerBinding};
use crate::decode::decode_storage_bytes;
use crate::generated::{
    DerivedChunkCache, DerivedChunkLookup, GeneratedCoarseConfig, GeneratedCoarseService,
    GeneratedSchedulingConfig, plan_generated_coarse_for_manifest,
};
use crate::proxy::{ProxyCache, ProxyGenerator};
use crate::session::Session;
use crate::{BroadcastItem, ProxyConfig, UnicastRoutes};

pub async fn handle_client(
    id: ClientId,
    ws: WebSocket,
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    unicast_routes: UnicastRoutes,
    proxy_config: ProxyConfig,
) {
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Per-client unicast channel for targeted messages (chunk routing).
    let (unicast_tx, mut unicast_rx) = mpsc::unbounded_channel::<Message>();
    unicast_routes.lock().await.insert(id, unicast_tx);

    // Lock session, subscribe (before unlock — no gap), add client, snapshot, unlock.
    let (snapshot_json, mut rx, peer_joined_json) = {
        let mut sess = session.lock().await;
        let rx = tx.subscribe();
        let presence = sess.add_client(id);
        let snapshot = sess.snapshot(id);
        let snapshot_json = serde_json::to_string(&snapshot).unwrap();
        let peer_joined = ServerMessage::PeerJoined {
            client_id: id,
            presence,
        };
        let peer_joined_json = serde_json::to_string(&peer_joined).unwrap();
        (snapshot_json, rx, peer_joined_json)
    };

    // Send snapshot as first message.
    if ws_tx
        .send(Message::Text(snapshot_json.into()))
        .await
        .is_err()
    {
        eprintln!("client {id}: failed to send snapshot");
        let mut sess = session.lock().await;
        sess.remove_client(id);
        unicast_routes.lock().await.remove(&id);
        return;
    }

    // Broadcast PeerJoined to others.
    let _ = tx.send(BroadcastItem::PeerJoined {
        sender: id,
        json: peer_joined_json,
    });

    // Outbound: forward broadcast + unicast messages to this client.
    let outbound = tokio::spawn(async move {
        loop {
            tokio::select! {
                result = rx.recv() => {
                    match result {
                        Ok(item) => {
                            let json = match &item {
                                BroadcastItem::CommandBroadcast { sender, broadcast_json, ack_json } => {
                                    if *sender == id {
                                        ack_json
                                    } else {
                                        broadcast_json
                                    }
                                }
                                BroadcastItem::PresenceUpdate { sender, json } => {
                                    if *sender == id { continue; }
                                    json
                                }
                                BroadcastItem::CursorUpdate { sender, json } => {
                                    if *sender == id { continue; }
                                    json
                                }
                                BroadcastItem::PeerJoined { sender, json } => {
                                    if *sender == id { continue; }
                                    json
                                }
                                BroadcastItem::PeerLeft { json } => json,
                                BroadcastItem::FollowChanged { json } => json,
                                BroadcastItem::DatasetPresenceUpdate { sender, json } => {
                                    if *sender == id { continue; }
                                    json
                                }
                                BroadcastItem::GeneratedAvailabilityUpdate { json } => json,
                            };
                            if ws_tx
                                .send(Message::Text(json.clone().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("client {id} lagged by {n} messages");
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                msg = unicast_rx.recv() => {
                    match msg {
                        Some(msg) => {
                            if ws_tx.send(msg).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }
    });

    // Inbound: parse client messages, apply/route.
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                let json = text.to_string();

                // Try as ClientMessage (new protocol).
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&json) {
                    match client_msg {
                        ClientMessage::Command { command } => {
                            // All commands in ClientMessage are DocumentCommands
                            // by construction — no runtime guard needed.
                            let seq = {
                                let mut sess = session.lock().await;
                                sess.apply(command.clone())
                            };

                            let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };
                            let ack_msg = ServerMessage::Ack { seq };

                            let _ = tx.send(BroadcastItem::CommandBroadcast {
                                sender: id,
                                broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
                                ack_json: serde_json::to_string(&ack_msg).unwrap(),
                            });
                        }
                        ClientMessage::Presence {
                            camera,
                            view,
                            display,
                        } => {
                            {
                                let mut sess = session.lock().await;
                                sess.update_presence(
                                    id,
                                    camera.clone(),
                                    view.clone(),
                                    display.clone(),
                                );
                            }
                            let update = ServerMessage::PresenceUpdate {
                                client_id: id,
                                camera,
                                view,
                                display,
                            };
                            let _ = tx.send(BroadcastItem::PresenceUpdate {
                                sender: id,
                                json: serde_json::to_string(&update).unwrap(),
                            });
                        }
                        ClientMessage::Cursor { position } => {
                            {
                                let mut sess = session.lock().await;
                                sess.update_cursor(id, position);
                            }
                            let update = ServerMessage::CursorUpdate {
                                client_id: id,
                                position,
                            };
                            let _ = tx.send(BroadcastItem::CursorUpdate {
                                sender: id,
                                json: serde_json::to_string(&update).unwrap(),
                            });
                        }
                        ClientMessage::Follow { target } => {
                            let changes = {
                                let mut sess = session.lock().await;
                                sess.set_follow(id, target)
                            };
                            for (cid, new_target) in changes {
                                let msg = ServerMessage::FollowChanged {
                                    client_id: cid,
                                    target: new_target,
                                };
                                let _ = tx.send(BroadcastItem::FollowChanged {
                                    json: serde_json::to_string(&msg).unwrap(),
                                });
                            }
                        }
                        ClientMessage::Steer { client } => {
                            let changes = {
                                let mut sess = session.lock().await;
                                sess.set_follow(client, Some(id))
                            };
                            for (cid, new_target) in changes {
                                let msg = ServerMessage::FollowChanged {
                                    client_id: cid,
                                    target: new_target,
                                };
                                let _ = tx.send(BroadcastItem::FollowChanged {
                                    json: serde_json::to_string(&msg).unwrap(),
                                });
                            }
                        }
                        ClientMessage::OpenRemoteDataset { url } => {
                            tracing::info!(
                                client_id = %id,
                                url = %url,
                                "open_remote_dataset.received"
                            );
                            let session_clone = Arc::clone(&session);
                            let tx_clone = tx.clone();
                            let unicast_routes_clone = Arc::clone(&unicast_routes);
                            let url_clone = url.clone();
                            let proxy_config_clone = proxy_config.clone();
                            tokio::spawn(async move {
                                handle_open_remote_dataset(
                                    id,
                                    url_clone,
                                    session_clone,
                                    tx_clone,
                                    unicast_routes_clone,
                                    proxy_config_clone,
                                )
                                .await;
                            });
                        }
                        ClientMessage::ViewerInterest { interest } => {
                            let service = {
                                let sess = session.lock().await;
                                sess.server_bindings
                                    .get(&interest.dataset_id)
                                    .map(|binding| binding.generated_service.clone())
                            };
                            if let Some(service) = service {
                                service.apply_viewer_interest(id, interest).await;
                            }
                        }
                        ClientMessage::DatasetPresence {
                            dataset_order,
                            dataset_settings,
                        } => {
                            {
                                let mut sess = session.lock().await;
                                sess.update_dataset_presence(
                                    id,
                                    dataset_order.clone(),
                                    dataset_settings.clone(),
                                );
                            }
                            let update = ServerMessage::DatasetPresenceUpdate {
                                client_id: id,
                                dataset_order,
                                dataset_settings,
                            };
                            let _ = tx.send(BroadcastItem::DatasetPresenceUpdate {
                                sender: id,
                                json: serde_json::to_string(&update).unwrap(),
                            });
                        }
                    }
                    continue;
                }

                // Try as ChunkMessage.
                if let Ok(chunk_msg) = serde_json::from_str::<ChunkMessage>(&json) {
                    match chunk_msg {
                        ChunkMessage::ChunkRequest {
                            dataset_id,
                            image_id,
                            key,
                        } => {
                            // Look up the server binding for this dataset.
                            // Parse the level prefix from the chunk key to
                            // pick the right per-level compression + byte
                            // layout. Malformed keys default to level 0 —
                            // serve_chunk_from_store will fail-fast at
                            // resolve time.
                            let level = parse_level_from_chunk_key(&key);
                            let dispatch = {
                                let sess = session.lock().await;
                                sess.server_bindings.get(&dataset_id).map(|b| {
                                    if b.is_generated_level(&image_id, level) {
                                        ChunkDispatch::Generated {
                                            level,
                                            derived_chunks: b.derived_chunks.clone(),
                                            generated_service: b.generated_service.clone(),
                                        }
                                    } else {
                                        let level_info = b.resolver.level_info(&image_id, level);
                                        ChunkDispatch::Source {
                                            resolved: b.resolver.resolve(&image_id, &key),
                                            level_info,
                                            cache: b.cache.clone(),
                                        }
                                    }
                                })
                            };
                            match dispatch {
                                Some(ChunkDispatch::Source {
                                    resolved,
                                    level_info,
                                    cache,
                                }) => {
                                    let unicast_routes_clone = Arc::clone(&unicast_routes);
                                    tokio::spawn(async move {
                                        serve_chunk_from_store(
                                            id,
                                            &dataset_id,
                                            &image_id,
                                            &key,
                                            resolved.as_deref(),
                                            level_info,
                                            &cache,
                                            &unicast_routes_clone,
                                        )
                                        .await;
                                    });
                                }
                                Some(ChunkDispatch::Generated {
                                    level,
                                    derived_chunks,
                                    generated_service,
                                }) => {
                                    let unicast_routes_clone = Arc::clone(&unicast_routes);
                                    tokio::spawn(async move {
                                        generated_service
                                            .enqueue_chunk_request(&image_id, level, &key)
                                            .await;
                                        serve_generated_chunk_request(
                                            id,
                                            &dataset_id,
                                            &image_id,
                                            level,
                                            &key,
                                            &derived_chunks,
                                            &unicast_routes_clone,
                                        )
                                        .await;
                                    });
                                }
                                None => {
                                    eprintln!(
                                        "server: no binding for dataset {dataset_id} (chunk {key} dropped)"
                                    );
                                }
                            }
                        }
                        ChunkMessage::ChunkFetch { .. } => {
                            // Clients should not send ChunkFetch — ignore.
                        }
                    }
                    continue;
                }

                // Try as AssetMessage (proxy asset request).
                if let Ok(asset_msg) = serde_json::from_str::<AssetMessage>(&json) {
                    match asset_msg {
                        AssetMessage::AssetRequest {
                            dataset_id,
                            entity_id,
                            kind,
                            t,
                            c,
                        } => {
                            let generator = {
                                let sess = session.lock().await;
                                sess.server_bindings.get(&dataset_id).and_then(|b| {
                                    b.legacy_proxy_enabled.then(|| b.proxy_generator.clone())
                                })
                            };
                            let Some(generator) = generator else {
                                eprintln!(
                                    "server: no binding for dataset {dataset_id} (asset {entity_id:?}/{kind:?} dropped)"
                                );
                                continue;
                            };
                            let unicast_routes_clone = Arc::clone(&unicast_routes);
                            tokio::spawn(async move {
                                serve_asset_request(
                                    id,
                                    entity_id,
                                    kind,
                                    t,
                                    c,
                                    &generator,
                                    &unicast_routes_clone,
                                )
                                .await;
                            });
                        }
                    }
                    continue;
                }

                eprintln!("client {id}: unrecognized message");
            }
            Message::Binary(data) => {
                // Binary chunk data: [client_id: u32 LE][key_len: u16 LE][key][data]
                if data.len() < 6 {
                    continue;
                }
                let target_id = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as u64;

                let senders = unicast_routes.lock().await;
                if let Some(sender) = senders.get(&target_id) {
                    let _ = sender.send(Message::Binary(data));
                }
            }
            _ => {}
        }
    }

    // Cleanup on disconnect.
    outbound.abort();
    unicast_routes.lock().await.remove(&id);
    let generated_services: Vec<_> = {
        let sess = session.lock().await;
        sess.server_bindings
            .values()
            .map(|binding| binding.generated_service.clone())
            .collect()
    };
    for service in generated_services {
        service.remove_client_interest(id).await;
    }

    // Remove client from session, get affected followers.
    let (affected_followers, peer_left_json) = {
        let mut sess = session.lock().await;
        let affected = sess.remove_client(id);
        let peer_left = ServerMessage::PeerLeft { client_id: id };
        let json = serde_json::to_string(&peer_left).unwrap();
        (affected, json)
    };

    // Broadcast PeerLeft.
    let _ = tx.send(BroadcastItem::PeerLeft {
        json: peer_left_json,
    });

    // Broadcast FollowChanged for any followers that were redirected.
    for follower_id in affected_followers {
        let msg = ServerMessage::FollowChanged {
            client_id: follower_id,
            target: None,
        };
        let _ = tx.send(BroadcastItem::FollowChanged {
            json: serde_json::to_string(&msg).unwrap(),
        });
    }

    eprintln!("client {id} disconnected");
}

/// Compute the stable, content-derived DatasetId for a source URL.
///
/// The ID is deterministic in `url` only — independent of wall clock or
/// server lifetime — so that:
///   * the same URL opened multiple times within a session shares one
///     `ServerBinding` (and therefore one cache, one import);
///   * the proxy cache layout can key on the URL hash and survive
///     restarts.
///
/// Uses the first 8 bytes of a BLAKE3 hash of the URL.
pub fn dataset_id_for_url(url: &str) -> String {
    let digest = blake3_url(url);
    let prefix: [u8; 8] = digest[..8].try_into().unwrap();
    format!("ds-{:016x}", u64::from_le_bytes(prefix))
}

/// 16-byte URL hash used by the proxy cache for its per-dataset
/// directory name. Shares the underlying BLAKE3 digest with
/// [`dataset_id_for_url`] so the two stay in lockstep — the cache
/// directory's first 8 bytes (in BLAKE3 order) match the bytes from
/// which the `ds-...` ID is built.
pub fn dataset_url_hash16(url: &str) -> [u8; 16] {
    let digest = blake3_url(url);
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    out
}

/// Internal: full 32-byte BLAKE3 digest of `url`. Held as a single
/// helper so the ID, the 16-byte cache key, and any future longer
/// derivation cannot drift apart.
fn blake3_url(url: &str) -> [u8; 32] {
    *blake3::hash(url.as_bytes()).as_bytes()
}

/// Handle OpenRemoteDataset: open a StorageBackend, import dataset, broadcast DatasetOpened.
#[tracing::instrument(
    name = "dataset_open",
    skip(session, tx, unicast_routes, proxy_config),
    fields(url = %url, client_id = %client_id)
)]
async fn handle_open_remote_dataset(
    client_id: ClientId,
    url: String,
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    unicast_routes: UnicastRoutes,
    proxy_config: ProxyConfig,
) {
    // Stable, content-derived ID. Two opens of the same URL produce the
    // same ID so the second open reuses the existing binding.
    let dataset_id = dataset_id_for_url(&url);
    let dataset_id_key = DatasetId(dataset_id.clone());

    // If we've already imported this URL in this session, reuse the binding.
    // Re-broadcast the existing DatasetOpened (held on the binding) so the
    // requesting client receives the same content graph + fetch descriptor
    // without re-importing.
    {
        let sess = session.lock().await;
        if let Some(existing) = sess.server_bindings.get(&dataset_id_key) {
            let command = DocumentCommand::DatasetOpened(existing.dataset_opened.clone());
            let seq = sess.seq;
            drop(sess);
            let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };
            let _ = tx.send(BroadcastItem::CommandBroadcast {
                sender: u64::MAX,
                broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
                ack_json: String::new(),
            });
            tracing::info!(
                dataset_id = %dataset_id,
                "open_remote_dataset.dedup_reuse"
            );
            return;
        }
    }

    // Open storage backend.
    let store = match lucida_store::backend::open(&url) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "open_remote_dataset.backend_open_failed");
            send_open_failed(client_id, &url, &e.to_string(), &unicast_routes).await;
            return;
        }
    };

    // Extract dataset name from URL (last path component).
    let name = url
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or("dataset")
        .to_string();

    // Import dataset via the new pipeline.
    tracing::info!(url = %url, id = %dataset_id, name = %name, "importing dataset");
    let result = match lucida_store::import::import_dataset(&store, &dataset_id, &name).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "open_remote_dataset.import_failed");
            send_open_failed(client_id, &url, &e.to_string(), &unicast_routes).await;
            return;
        }
    };

    // Log import result summary.
    let n_entities = result.manifest.entities().len();
    let n_images = result.manifest.images().len();
    let n_levels = result
        .manifest
        .images()
        .first()
        .map(|i| i.multiscale.levels.len())
        .unwrap_or(0);
    tracing::info!(
        id = %dataset_id,
        kind = ?result.manifest.kind,
        entities = n_entities,
        images = n_images,
        levels = n_levels,
        binding_images = result.binding_seed.images.len(),
        "import complete"
    );

    // Build operational binding.
    let cached = Arc::new(CachedStore::new(store.clone(), 512 * 1024 * 1024));
    let resolver = Arc::new(ChunkResolver::new(&result.binding_seed));
    let generated_config = GeneratedCoarseConfig {
        target_long_axis: proxy_config.generated_target_long_axis,
        chunk_long_axis: proxy_config.generated_chunk_long_axis,
        max_chunk_bytes: proxy_config.generated_max_chunk_bytes,
    };
    let generated_plans = if proxy_config.generated_enabled {
        plan_generated_coarse_for_manifest(&result.manifest, generated_config)
    } else {
        vec![]
    };

    // Legacy proxy fallback is opt-in after the coarse/detail default
    // flip. The default DatasetOpened catalog is empty so fallback
    // availability comes from chunk tier metadata instead of proxies.
    let catalog_entries =
        proxy_catalog_entries_for_manifest(&result.manifest, proxy_config.legacy_proxy_enabled);

    let dataset_opened = DatasetOpened {
        manifest: result.manifest.clone(),
        fetch: result.fetch,
        catalog: AssetCatalog {
            entries: catalog_entries.clone(),
        },
    };

    // Per-dataset proxy infrastructure. Cache root is keyed by the
    // 16-byte URL hash so a single shared `cache_dir` can host many
    // datasets without collision. The generator owns its own bounded
    // semaphore + in-flight dedup map.
    let url_hash16 = dataset_url_hash16(&url);
    let derived_chunks = Arc::new(DerivedChunkCache::new_on_disk_with_budget(
        proxy_config.generated_cache_dir.clone(),
        url_hash16,
        proxy_config.generated_disk_budget_bytes,
    ));
    let mut generated_initial_delta = GeneratedAvailabilityDelta::default();
    for plan in &generated_plans {
        match derived_chunks.register_generated_plan(plan) {
            Ok(delta) => {
                generated_initial_delta.levels.extend(delta.levels);
                generated_initial_delta.chunks.extend(delta.chunks);
            }
            Err(e) => {
                tracing::warn!(
                    dataset_id = %dataset_id,
                    image = %plan.image_id.0,
                    error = %e,
                    "generated coarse derived-cache registration failed"
                );
                derived_chunks.upsert_level(plan.availability.clone());
                generated_initial_delta
                    .levels
                    .push(plan.availability.clone());
            }
        }
    }
    let proxy_cache = Arc::new(ProxyCache::new(proxy_config.cache_dir.clone(), url_hash16));
    let generated_manifest = Arc::new(result.manifest.clone());
    let generated_store = cached.clone();
    let generated_resolver = resolver.clone();
    let generated_service = Arc::new(GeneratedCoarseService::new(
        generated_plans.clone(),
        generated_manifest,
        generated_store,
        generated_resolver,
        derived_chunks.clone(),
        session.clone(),
        tx.clone(),
        GeneratedSchedulingConfig {
            concurrency: proxy_config.generated_concurrency,
            background_chunk_limit: proxy_config.generated_background_chunk_limit,
            ..GeneratedSchedulingConfig::default()
        },
    ));
    generated_service.start();
    let proxy_generator = Arc::new(ProxyGenerator::new(
        proxy_cache.clone(),
        cached.clone(),
        resolver.clone(),
        Arc::new(result.manifest),
        proxy_config.concurrency,
    ));

    // Clone for the (T=0, C=0) pre-generation task spawned below.
    let prefetch_generator = proxy_generator.clone();
    let prefetch_entries = catalog_entries.clone();

    let binding = ServerBinding {
        source_url: url.clone(),
        store: store.clone(),
        resolver,
        cache: cached,
        dataset_opened: dataset_opened.clone(),
        derived_chunks: derived_chunks.clone(),
        generated_service: generated_service.clone(),
        legacy_proxy_enabled: proxy_config.legacy_proxy_enabled,
        proxy_cache,
        proxy_generator,
    };

    // Build DatasetOpened command (manifest + fetch, no server-private state).
    let command = DocumentCommand::DatasetOpened(dataset_opened);

    // Apply command and register server binding. Re-check the binding
    // presence under the lock in case a concurrent open raced ahead.
    let seq = {
        let mut sess = session.lock().await;
        if let Some(existing) = sess.server_bindings.get(&dataset_id_key) {
            // Lost the race: another open completed the import. Drop our
            // duplicate binding/command and rebroadcast the canonical one.
            let canonical = existing.dataset_opened.clone();
            let seq = sess.seq;
            drop(sess);
            let broadcast_msg = ServerMessage::CommandBroadcast {
                seq,
                command: DocumentCommand::DatasetOpened(canonical),
            };
            let _ = tx.send(BroadcastItem::CommandBroadcast {
                sender: u64::MAX,
                broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
                ack_json: String::new(),
            });
            tracing::info!(
                dataset_id = %dataset_id,
                "open_remote_dataset.lost_race"
            );
            return;
        }
        let seq = sess.apply(command.clone());
        if !generated_initial_delta.levels.is_empty() {
            sess.apply_generated_availability_delta(
                dataset_id_key.clone(),
                generated_initial_delta.clone(),
            );
        }
        sess.server_bindings.insert(dataset_id_key, binding);
        seq
    };

    // Broadcast to ALL clients including the requester.
    // Use u64::MAX as sender so no client matches — everyone gets the
    // CommandBroadcast (not an Ack), since the requester hasn't applied
    // the DatasetOpened locally.
    let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };

    let _ = tx.send(BroadcastItem::CommandBroadcast {
        sender: u64::MAX,
        broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
        ack_json: String::new(), // unused — no client will match
    });

    if !generated_initial_delta.levels.is_empty() {
        let msg = ServerMessage::GeneratedAvailabilityUpdate {
            dataset_id: DatasetId(dataset_id.clone()),
            delta: generated_initial_delta.clone(),
        };
        let _ = tx.send(BroadcastItem::GeneratedAvailabilityUpdate {
            json: serde_json::to_string(&msg).unwrap(),
        });
    }

    tracing::info!(
        dataset_id = %dataset_id,
        seq,
        "open_remote_dataset.broadcast_sent"
    );

    if !generated_plans.is_empty() {
        generated_service.enqueue_background_fill().await;
    }

    // Kick off background generation for the initial (T=0, C=0) view
    // of every advertised entity at the lowest priority. Errors are logged
    // but do not propagate — the open succeeds either way, and downstream
    // requests will surface the failure with their own error path.
    if !prefetch_entries.is_empty() {
        let dataset_id_for_log = dataset_id.clone();
        tokio::spawn(async move {
            for availability in prefetch_entries {
                for kind in availability.kinds {
                    let spec = ProxySpec {
                        entity_id: availability.entity_id.clone(),
                        kind,
                        t: 0,
                        c: 0,
                        target_long_axis: PROXY_TARGET_LONG_AXIS,
                    };
                    if let Err(e) = prefetch_generator.request(spec, 0).await {
                        tracing::warn!(
                            dataset = %dataset_id_for_log,
                            entity = %availability.entity_id.0,
                            kind = ?kind,
                            error = %e,
                            "background proxy pre-generation failed"
                        );
                    }
                }
            }
        });
    }
}

/// Soft cap on the longest output dimension of a proxy. Mirrors the value
/// used by `serve_asset_request` so the cache key (which is derived from
/// `(entity, kind, t, c)` only, not the target) stays in lockstep with the
/// pre-generation task.
const PROXY_TARGET_LONG_AXIS: u32 = 128;

fn proxy_catalog_entries_for_manifest(
    manifest: &lucida_content::DatasetManifest,
    legacy_proxy_enabled: bool,
) -> Vec<ProxyAvailability> {
    if !legacy_proxy_enabled {
        return vec![];
    }

    // Build the legacy proxy availability catalog by enumerating
    // entities. Wells advertise WellProxy3D, Fields advertise FieldProxy3D,
    // and bare Images advertise FieldProxy3D (the proxy generator falls
    // back to FieldProxy semantics for non-Well entities — see
    // `build_server_proxy_source`). Entities without a contributing image
    // are skipped — Planning has nothing to fetch for them.
    manifest
        .entities()
        .iter()
        .filter_map(|entity| {
            let kinds = match entity.kind {
                EntityKind::Well => vec![ProxyKind::WellProxy3D],
                EntityKind::Field | EntityKind::Image => vec![ProxyKind::FieldProxy3D],
            };
            // Only advertise entities that own an image (Wells aggregate
            // their fields' images downstream, so we keep all Wells).
            let has_image = matches!(entity.kind, EntityKind::Well)
                || manifest.images().iter().any(|img| img.owner == entity.id);
            if !has_image {
                return None;
            }
            let footprints = proxy_footprints_for_entity(manifest, &entity.id, &kinds);
            Some(ProxyAvailability {
                entity_id: entity.id.clone(),
                kinds,
                footprints,
            })
        })
        .collect()
}

enum ChunkDispatch {
    Source {
        resolved: Option<String>,
        level_info: Option<crate::binding::LevelInfo>,
        cache: Arc<CachedStore>,
    },
    Generated {
        level: u32,
        derived_chunks: Arc<DerivedChunkCache>,
        generated_service: Arc<GeneratedCoarseService>,
    },
}

fn proxy_footprints_for_entity(
    manifest: &DatasetManifest,
    entity_id: &EntityId,
    kinds: &[ProxyKind],
) -> Vec<ProxyFootprint> {
    kinds
        .iter()
        .filter_map(|kind| {
            let spec = ProxySpec {
                entity_id: entity_id.clone(),
                kind: *kind,
                t: 0,
                c: 0,
                target_long_axis: PROXY_TARGET_LONG_AXIS,
            };
            estimate_proxy_dims(&spec, manifest)
                .ok()
                .map(|dims| ProxyFootprint::u16(*kind, dims))
        })
        .collect()
}

/// Parse the level prefix from a canonical chunk key (`"{level}/t/c/z/y/x"`).
/// Returns `0` if the key is malformed or missing a numeric prefix — the
/// caller's resolve step will turn that into a clean per-key failure.
fn parse_level_from_chunk_key(key: &str) -> u32 {
    key.split('/')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Parse the wire `(t, c)` voxel coordinates from a canonical chunk key
/// (`"{level}/t/c/z/y/x"`). Returns `(0, 0)` if the key is malformed —
/// downstream slice math then yields the canonical prefix, which is the
/// safe fallback for legacy paths.
fn parse_t_c_from_chunk_key(key: &str) -> (u64, u64) {
    let mut parts = key.split('/');
    let _level = parts.next();
    let t = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let c = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (t, c)
}

/// Read a chunk from a CachedStore and send it to the requesting client.
///
/// `object_path` is the pre-resolved object store path from the ChunkResolver.
/// If `None`, the image_id was unknown and the request is rejected.
///
/// `level_info` carries per-level compression, on-disk chunk_shape, and
/// the canonical-byte slice layout. The wire `(t, c)` coords are parsed
/// from `chunk_key` and reduced to intra-chunk indices via
/// `wire_value % chunk_shape[axis]`; the resulting `(offset, size)` from
/// [`ChunkByteLayout::slice_range`] picks the requested timepoint/channel
/// out of the decompressed on-disk chunk.
///
/// A `None` `level_info` (unknown image or level — e.g. older snapshot)
/// falls back to no-compression-no-slicing so legacy datasets keep
/// working.
// Internal helper threading per-request state from the dispatch site;
// extracting a struct would just push the bundle one frame up.
#[allow(clippy::too_many_arguments)]
async fn serve_chunk_from_store(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    object_path: Option<&str>,
    level_info: Option<crate::binding::LevelInfo>,
    cache: &Arc<CachedStore>,
    unicast_routes: &UnicastRoutes,
) {
    let object_path = match object_path {
        Some(p) => p,
        None => {
            eprintln!(
                "server: unknown image_id {image_id} for dataset {dataset_id}, key {chunk_key}"
            );
            return;
        }
    };

    let level_info = level_info.unwrap_or(crate::binding::LevelInfo {
        level_index: 0,
        compression: crate::decode::StorageCompression::None,
        chunk_shape: Vec::new(),
        chunk_byte_layout: lucida_store::layout::ChunkByteLayout {
            canonical_byte_size: 0,
            on_disk_byte_size: 0,
            byte_stride_t: 0,
            byte_stride_c: 0,
            chunk_size_t: 1,
            chunk_size_c: 1,
        },
    });

    tracing::trace!(dataset = %dataset_id, image = %image_id, key = chunk_key, path = object_path, "serving chunk");
    let obj_path = Path::from(object_path);
    let storage_bytes = match cache.get_bytes(&obj_path).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("server: failed to read chunk {chunk_key} for {dataset_id}: {e}");
            return;
        }
    };

    // Decode storage compression → raw bytes (WireFormat::Raw for phase 1).
    // Shared with the proxy generator via [`crate::decode::decode_storage_bytes`].
    let mut bytes: Vec<u8> = match decode_storage_bytes(&storage_bytes, level_info.compression) {
        Ok(raw) => {
            tracing::debug!(
                key = chunk_key,
                compressed = storage_bytes.len(),
                decompressed = raw.len(),
                compression = ?level_info.compression,
                "chunk decoded"
            );
            raw
        }
        Err(e) => {
            eprintln!("server: decode failed for {chunk_key}: {e}");
            return;
        }
    };

    // Pick out the requested (t, c) slice from the decompressed on-disk
    // chunk. For canonical 5D / chunk_size 1 datasets, slice_range returns
    // (0, canonical_byte_size) and this is equivalent to the old prefix
    // truncate. For chunk_size > 1 on t/c or pinned-axis bundling, the
    // offset/size pick out exactly one timepoint/channel's bytes.
    let (wire_t, wire_c) = parse_t_c_from_chunk_key(chunk_key);
    let (offset, size) = level_info.chunk_byte_layout.slice_range(wire_t, wire_c);
    if size > 0
        && offset
            .checked_add(size)
            .is_some_and(|end| end <= bytes.len())
    {
        bytes = bytes[offset..offset + size].to_vec();
    }

    let buf = encode_chunk_frame(client_id, dataset_id, image_id, chunk_key, &bytes);

    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send(Message::Binary(buf.into()));
    }
}

async fn serve_generated_chunk_request(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    level: u32,
    chunk_key: &str,
    derived_chunks: &Arc<DerivedChunkCache>,
    unicast_routes: &UnicastRoutes,
) {
    match derived_chunks.lookup(image_id, level, chunk_key) {
        DerivedChunkLookup::Ready(bytes) => {
            let buf = encode_chunk_frame(client_id, dataset_id, image_id, chunk_key, &bytes);
            let senders = unicast_routes.lock().await;
            if let Some(sender) = senders.get(&client_id) {
                let _ = sender.send(Message::Binary(buf.into()));
            }
        }
        DerivedChunkLookup::Status { status, message } => {
            send_generated_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                status,
                message,
                unicast_routes,
            )
            .await;
        }
    }
}

async fn send_generated_chunk_status(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    status: GeneratedChunkStatus,
    message: Option<String>,
    unicast_routes: &UnicastRoutes,
) {
    let msg = ServerMessage::GeneratedChunkStatus {
        dataset_id: dataset_id.clone(),
        image_id: image_id.clone(),
        key: chunk_key.to_string(),
        status,
        message,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send(Message::Text(json.into()));
    }
}

fn encode_chunk_frame(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    bytes: &[u8],
) -> Vec<u8> {
    // Binary response: [client_id: u32 LE][key_len: u16 LE][key][data].
    // The composite key is "{dataset_id}/{image_id}/{chunk_key}".
    let composite_key = format!("{dataset_id}/{image_id}/{chunk_key}");
    let key_bytes = composite_key.as_bytes();
    let key_len = key_bytes.len() as u16;

    let mut buf = Vec::with_capacity(4 + 2 + key_bytes.len() + bytes.len());
    buf.extend_from_slice(&(client_id as u32).to_le_bytes());
    buf.extend_from_slice(&key_len.to_le_bytes());
    buf.extend_from_slice(key_bytes);
    buf.extend_from_slice(bytes);
    buf
}

/// Generate (or fetch from cache) a proxy asset and send it to the
/// requesting client over the unicast channel.
///
/// Wire frame layout (binary, little-endian):
///
/// ```text
/// [client_id : u32]
/// [key_len   : u16] [key bytes]
/// [header    : 64 bytes  (lucida_proxy::write_header layout)]
/// [voxels    : N * u16   (Z, Y, X row-major)]
/// ```
///
/// The leading `client_id`/`key_len`/`key` envelope mirrors
/// [`serve_chunk_from_store`] so the client's bridge layer can route both
/// chunk and proxy frames through the same binary handler.
///
/// `key` is `proxy/{entity_id}/{kind_str}/T{t:05}_C{c:03}` where
/// `kind_str` is `WellProxy3D` or `FieldProxy3D` (matching the JSON
/// variant names of [`ProxyKind`]). The `proxy/` prefix lets the client
/// distinguish proxy frames from chunk frames, which use
/// `{dataset_id}/{image_id}/{chunk_key}`.
async fn serve_asset_request(
    client_id: ClientId,
    entity_id: lucida_content::EntityId,
    kind: ProxyKind,
    t: u32,
    c: u32,
    generator: &Arc<ProxyGenerator>,
    unicast_routes: &UnicastRoutes,
) {
    let spec = ProxySpec {
        entity_id: entity_id.clone(),
        kind,
        t,
        c,
        target_long_axis: PROXY_TARGET_LONG_AXIS,
    };

    tracing::debug!(
        entity = %entity_id.0,
        kind = ?kind,
        t,
        c,
        "serving proxy asset"
    );

    let asset = match generator.request(spec, 1).await {
        Ok(a) => a,
        Err(e) => {
            eprintln!("server: proxy generation failed for {entity_id:?}/{kind:?}/T{t}_C{c}: {e}");
            return;
        }
    };

    let buf = match encode_proxy_frame(client_id, &entity_id, kind, t, c, &asset) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("server: proxy frame encode failed: {e}");
            return;
        }
    };

    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send(Message::Binary(buf.into()));
    }
}

/// Build the binary proxy response frame. See [`serve_asset_request`] for
/// the layout. Pulled out as a free function so unit tests can exercise the
/// format without spinning up the network.
pub(crate) fn encode_proxy_frame(
    client_id: ClientId,
    entity_id: &lucida_content::EntityId,
    kind: ProxyKind,
    t: u32,
    c: u32,
    asset: &ProxyAsset,
) -> std::io::Result<Vec<u8>> {
    let key = proxy_response_key(entity_id, kind, t, c);
    let key_bytes = key.as_bytes();
    let key_len: u16 = key_bytes
        .len()
        .try_into()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "proxy key too long"))?;

    let voxel_bytes: &[u8] = bytemuck::cast_slice(&asset.voxels);

    let mut buf = Vec::with_capacity(4 + 2 + key_bytes.len() + 64 + voxel_bytes.len());
    buf.extend_from_slice(&(client_id as u32).to_le_bytes());
    buf.extend_from_slice(&key_len.to_le_bytes());
    buf.extend_from_slice(key_bytes);
    lucida_proxy::write_header(&mut buf, &asset.header)?;
    buf.extend_from_slice(voxel_bytes);
    Ok(buf)
}

/// Compose the proxy response key. Public so the TS client can mirror
/// the format and the test suite can assert it.
pub(crate) fn proxy_response_key(
    entity_id: &lucida_content::EntityId,
    kind: ProxyKind,
    t: u32,
    c: u32,
) -> String {
    format!(
        "proxy/{}/{}/T{:05}_C{:03}",
        entity_id.0,
        proxy_kind_str(kind),
        t,
        c
    )
}

/// Stable string representation of [`ProxyKind`] used in proxy response
/// keys. We pin it explicitly rather than using `Debug` so renaming a
/// variant won't silently break the wire format.
pub(crate) fn proxy_kind_str(kind: ProxyKind) -> &'static str {
    match kind {
        ProxyKind::WellProxy3D => "WellProxy3D",
        ProxyKind::FieldProxy3D => "FieldProxy3D",
    }
}

/// Send an OpenDatasetFailed message to the requesting client.
async fn send_open_failed(
    client_id: ClientId,
    url: &str,
    error: &str,
    unicast_routes: &UnicastRoutes,
) {
    tracing::warn!(
        client_id = %client_id,
        url = %url,
        error = %error,
        "open_remote_dataset.failed"
    );
    let msg = ServerMessage::OpenDatasetFailed {
        url: url.to_string(),
        error: error.to_string(),
    };
    let json = serde_json::to_string(&msg).unwrap();
    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send(Message::Text(json.into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::{
        Axis, AxisKind, DataType, DatasetKind, Entity, EntityId, EntityKind, EntityLabels,
        LevelGeometry, MultiscaleInfo,
    };
    use lucida_proxy::{ProxyDtype, ProxyHeader};

    fn single_image_manifest() -> lucida_content::DatasetManifest {
        let entity_id = EntityId("entity-1".into());
        lucida_content::DatasetManifest::new(
            DatasetId("ds-1".into()),
            "test".into(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels::default(),
            }],
            vec![],
            vec![lucida_content::ImageSpec {
                image_id: ImageId("img-1".into()),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".into(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".into(),
                            kind: AxisKind::Channel,
                        },
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
                        shape: [1, 1, 1, 256, 256],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, 1, 1, 2, 2],
                        scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                },
            }],
            vec![],
            None,
        )
    }

    fn sample_asset(zyx: [u32; 3]) -> ProxyAsset {
        let count = zyx.iter().fold(1usize, |a, b| a * (*b as usize));
        let voxels: Vec<u16> = (0..count).map(|i| (i as u16).wrapping_mul(7)).collect();
        ProxyAsset {
            header: ProxyHeader {
                algorithm_version: lucida_proxy::ALGORITHM_VERSION,
                source_content_hash: [0xABu8; 32],
                dims: zyx,
                dtype: ProxyDtype::U16,
            },
            voxels,
        }
    }

    #[test]
    fn proxy_response_key_format_matches_spec() {
        let key = proxy_response_key(&EntityId("field-A1".into()), ProxyKind::FieldProxy3D, 0, 0);
        assert_eq!(key, "proxy/field-A1/FieldProxy3D/T00000_C000");

        let well = proxy_response_key(&EntityId("well-B2".into()), ProxyKind::WellProxy3D, 12, 3);
        assert_eq!(well, "proxy/well-B2/WellProxy3D/T00012_C003");
    }

    #[test]
    fn proxy_kind_str_pins_variant_names() {
        assert_eq!(proxy_kind_str(ProxyKind::WellProxy3D), "WellProxy3D");
        assert_eq!(proxy_kind_str(ProxyKind::FieldProxy3D), "FieldProxy3D");
    }

    #[test]
    fn proxy_catalog_is_empty_on_default_path() {
        let manifest = single_image_manifest();
        let entries = proxy_catalog_entries_for_manifest(&manifest, false);
        assert!(entries.is_empty());
    }

    #[test]
    fn proxy_catalog_is_available_only_for_legacy_bridge() {
        let manifest = single_image_manifest();
        let entries = proxy_catalog_entries_for_manifest(&manifest, true);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kinds, vec![ProxyKind::FieldProxy3D]);
    }

    #[test]
    fn encode_proxy_frame_round_trips_header_and_voxels() {
        let asset = sample_asset([2, 3, 4]);
        let entity_id = EntityId("e1".into());
        let buf = encode_proxy_frame(7, &entity_id, ProxyKind::FieldProxy3D, 5, 1, &asset)
            .expect("encode");

        // [client_id:u32 LE][key_len:u16 LE][key][header 64][voxels]
        assert!(buf.len() >= 4 + 2 + 64);
        let client_id = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!(client_id, 7);

        let key_len = u16::from_le_bytes(buf[4..6].try_into().unwrap()) as usize;
        let key_start = 6;
        let key_end = key_start + key_len;
        let key = std::str::from_utf8(&buf[key_start..key_end]).unwrap();
        assert_eq!(key, "proxy/e1/FieldProxy3D/T00005_C001");

        // Header round-trips via lucida_proxy::read_header.
        let mut header_cursor = std::io::Cursor::new(&buf[key_end..key_end + 64]);
        let header = lucida_proxy::read_header(&mut header_cursor).unwrap();
        assert_eq!(header.dims, [2, 3, 4]);
        assert_eq!(header.algorithm_version, asset.header.algorithm_version);
        assert_eq!(header.source_content_hash, asset.header.source_content_hash);

        // Voxels follow immediately, little-endian u16.
        let voxel_bytes = &buf[key_end + 64..];
        assert_eq!(voxel_bytes.len(), asset.voxels.len() * 2);
        let parsed: Vec<u16> = voxel_bytes
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect();
        assert_eq!(parsed, asset.voxels);
    }

    #[test]
    fn encode_chunk_frame_uses_normal_chunk_key_envelope() {
        let dataset_id = DatasetId("ds1".into());
        let image_id = ImageId("img1".into());
        let buf = encode_chunk_frame(9, &dataset_id, &image_id, "2/0/0/0/0/0", &[1, 2, 3]);

        let client_id = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!(client_id, 9);
        let key_len = u16::from_le_bytes(buf[4..6].try_into().unwrap()) as usize;
        let key = std::str::from_utf8(&buf[6..6 + key_len]).unwrap();
        assert_eq!(key, "ds1/img1/2/0/0/0/0/0");
        assert_eq!(&buf[6 + key_len..], &[1, 2, 3]);
    }

    #[tokio::test]
    async fn generated_pending_status_is_sent_as_text() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        routes.lock().await.insert(3, tx);

        send_generated_chunk_status(
            3,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "2/0/0/0/0/0",
            GeneratedChunkStatus::Pending,
            None,
            &routes,
        )
        .await;

        let msg = rx.recv().await.expect("message");
        let Message::Text(json) = msg else {
            panic!("expected text message");
        };
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::GeneratedChunkStatus { status, .. } => {
                assert_eq!(status, GeneratedChunkStatus::Pending);
            }
            _ => panic!("expected GeneratedChunkStatus"),
        }
    }
}
