use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use lucida_content::url::{
    dataset_id_for_url, dataset_url_hash16, is_local_dataset_url, normalize_dataset_url,
};
use lucida_content::{DatasetId, DatasetManifest, EntityId, EntityKind, ImageId};
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ChunkMessage, ClientId, ClientMessage, ServerMessage};
use lucida_protocol::{
    AssetCatalog, AssetMessage, DatasetGeneratedCoarseHealth, DatasetHealthComponent,
    DatasetHealthStatus, DatasetOpenFailureDiagnostic, DatasetOpenFailureKind,
    DatasetOpenProgressDiagnostic, DatasetOpenStage, DatasetOpenSuccessDiagnostic, DatasetOpened,
    DatasetSourceCacheStats, DatasetSourceHealth, GeneratedAvailabilityDelta,
    GeneratedAvailabilitySnapshot, GeneratedChunkStatus, ProxyAvailability, ProxyFootprint,
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
use crate::workspace::{LiveWorkspace, WorkspaceDatasetSource, WorkspaceManager};
use crate::{BroadcastItem, ProxyConfig, UnicastRoutes};

#[derive(Clone)]
struct WorkspaceClientContext {
    live: Arc<LiveWorkspace>,
    manager: Arc<WorkspaceManager>,
    principal: AuthPrincipal,
}

pub async fn handle_workspace_client(
    id: ClientId,
    ws: WebSocket,
    live: Arc<LiveWorkspace>,
    manager: Arc<WorkspaceManager>,
    principal: AuthPrincipal,
) {
    let session = Arc::clone(&live.session);
    let tx = live.tx.clone();
    let unicast_routes = Arc::clone(&live.unicast_routes);
    let proxy_config = manager.proxy_config();
    handle_client_inner(
        id,
        ws,
        session,
        tx,
        unicast_routes,
        proxy_config,
        Some(WorkspaceClientContext {
            live,
            manager,
            principal,
        }),
    )
    .await;
}

/// Rebuild server-private dataset bindings for a lazily restored workspace.
///
/// The durable workspace document stores client-facing dataset state, but
/// operational chunk/proxy/generated services are intentionally not part of
/// `DocumentState`. On first open after a server restart, rebuild those
/// bindings from the structured `workspace_datasets → dataset_sources`
/// records before the first snapshot goes out.
pub async fn restore_workspace_bindings(
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    sources: Vec<WorkspaceDatasetSource>,
    proxy_config: ProxyConfig,
) {
    for source in sources {
        {
            let mut sess = session.lock().await;
            if sess
                .server_bindings
                .contains_key(&source.workspace_dataset_id)
            {
                continue;
            }
            sess.record_binding_source(
                source.workspace_dataset_id.clone(),
                normalize_dataset_url(&source.canonical_url),
                Some(source.dataset_source_id.clone()),
                source.display_name.clone(),
            );
        }
        if let Err(e) =
            restore_one_workspace_binding(Arc::clone(&session), tx.clone(), &source, &proxy_config)
                .await
        {
            {
                let mut sess = session.lock().await;
                sess.record_binding_restore_failure(
                    source.workspace_dataset_id.clone(),
                    normalize_dataset_url(&source.canonical_url),
                    Some(source.dataset_source_id.clone()),
                    source.display_name.clone(),
                    e.clone(),
                );
            }
            tracing::warn!(
                dataset_id = %source.workspace_dataset_id,
                dataset_source_id = %source.dataset_source_id,
                url = %source.canonical_url,
                error = %e.message,
                stage = ?e.stage,
                kind = ?e.kind,
                retryable = e.retryable,
                "workspace.binding_restore_failed"
            );
        }
    }
}

async fn restore_one_workspace_binding(
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    source: &WorkspaceDatasetSource,
    proxy_config: &ProxyConfig,
) -> Result<(), DatasetOpenFailureDiagnostic> {
    let canonical_url = normalize_dataset_url(&source.canonical_url);
    let dataset_id = source.workspace_dataset_id.0.clone();
    let dataset_id_key = DatasetId(dataset_id.clone());

    let store =
        lucida_store::backend::open(&canonical_url).map_err(|e| backend_open_failure(&e))?;
    let result = lucida_store::import::import_dataset(&store, &dataset_id, &source.display_name)
        .await
        .map_err(|e| import_failure(&e))?;

    let catalog_entries =
        proxy_catalog_entries_for_manifest(&result.manifest, proxy_config.legacy_proxy_enabled);
    let dataset_opened = DatasetOpened {
        manifest: result.manifest.clone(),
        fetch: result.fetch,
        catalog: AssetCatalog {
            entries: catalog_entries.clone(),
        },
    };

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

    let url_hash16 = dataset_url_hash16(&canonical_url);
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
                    "workspace.binding_restore.generated_registration_failed"
                );
                derived_chunks.upsert_level(plan.availability.clone());
                generated_initial_delta
                    .levels
                    .push(plan.availability.clone());
            }
        }
    }
    let proxy_cache = Arc::new(ProxyCache::new(proxy_config.cache_dir.clone(), url_hash16));
    let generated_service = Arc::new(GeneratedCoarseService::new(
        generated_plans.clone(),
        Arc::new(result.manifest.clone()),
        cached.clone(),
        resolver.clone(),
        derived_chunks.clone(),
        Arc::clone(&session),
        tx,
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

    let binding = ServerBinding {
        source_url: canonical_url.clone(),
        store,
        resolver,
        cache: cached,
        dataset_opened,
        derived_chunks,
        generated_service: generated_service.clone(),
        legacy_proxy_enabled: proxy_config.legacy_proxy_enabled,
        proxy_cache,
        proxy_generator,
    };

    {
        let mut sess = session.lock().await;
        sess.record_binding_source(
            dataset_id_key.clone(),
            canonical_url,
            Some(source.dataset_source_id.clone()),
            source.display_name.clone(),
        );
        sess.clear_binding_restore_failure(&dataset_id_key);
        if !generated_initial_delta.levels.is_empty() {
            sess.apply_generated_availability_delta(
                dataset_id_key.clone(),
                generated_initial_delta.clone(),
            );
        }
        sess.server_bindings.insert(dataset_id_key, binding);
    }
    if !generated_plans.is_empty() {
        generated_service.enqueue_background_fill().await;
    }
    Ok(())
}

pub async fn handle_client(
    id: ClientId,
    ws: WebSocket,
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    unicast_routes: UnicastRoutes,
    proxy_config: ProxyConfig,
) {
    handle_client_inner(id, ws, session, tx, unicast_routes, proxy_config, None).await;
}

async fn handle_client_inner(
    id: ClientId,
    ws: WebSocket,
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    unicast_routes: UnicastRoutes,
    proxy_config: ProxyConfig,
    workspace: Option<WorkspaceClientContext>,
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
                                BroadcastItem::WorkspaceArchived { json } => json,
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
                            if let Some(ctx) = workspace.as_ref() {
                                if matches!(command, DocumentCommand::DatasetOpened(_)) {
                                    tracing::warn!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        "workspace.command.rejected_client_dataset_opened"
                                    );
                                    continue;
                                }
                                if let Err(e) = ctx
                                    .manager
                                    .require_editor(&ctx.live.workspace_id, &ctx.principal)
                                    .await
                                {
                                    tracing::warn!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        error = %e,
                                        "workspace.command.forbidden"
                                    );
                                    continue;
                                }
                            }

                            let (seq, document) = {
                                let mut sess = session.lock().await;
                                let seq = sess.apply(command.clone());
                                let document = sess.document.clone();
                                (seq, document)
                            };

                            if let Some(ctx) = workspace.as_ref()
                                && let Err(e) = ctx
                                    .manager
                                    .persist_applied_command(&ctx.live, &command, seq, &document)
                                    .await
                            {
                                tracing::error!(
                                    client_id = %id,
                                    workspace_id = %ctx.live.workspace_id,
                                    error = %e,
                                    "workspace.command.persist_failed"
                                );
                                continue;
                            }

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
                        ClientMessage::OpenRemoteDataset { request_id, url } => {
                            tracing::info!(
                                client_id = %id,
                                request_id = %request_id,
                                url = %url,
                                "open_remote_dataset.received"
                            );
                            let session_clone = Arc::clone(&session);
                            let tx_clone = tx.clone();
                            let unicast_routes_clone = Arc::clone(&unicast_routes);
                            let proxy_config_clone = proxy_config.clone();
                            let workspace_clone = workspace.clone();
                            let request = OpenRemoteDatasetRequest { request_id, url };
                            tokio::spawn(async move {
                                handle_open_remote_dataset(
                                    id,
                                    request,
                                    session_clone,
                                    tx_clone,
                                    unicast_routes_clone,
                                    proxy_config_clone,
                                    workspace_clone,
                                )
                                .await;
                            });
                        }
                        ClientMessage::DatasetHealth {
                            request_id,
                            dataset_id,
                        } => {
                            let datasets = {
                                let sess = session.lock().await;
                                dataset_health_snapshot(&sess, dataset_id.as_ref())
                            };
                            let msg = ServerMessage::DatasetHealth {
                                request_id,
                                datasets,
                            };
                            let senders = unicast_routes.lock().await;
                            if let Some(sender) = senders.get(&id) {
                                let _ = sender.send(Message::Text(
                                    serde_json::to_string(&msg).unwrap().into(),
                                ));
                            }
                        }
                        ClientMessage::DatasetRetry {
                            request_id,
                            dataset_id,
                        } => {
                            let Some(ctx) = workspace.as_ref() else {
                                send_open_failed(
                                    id,
                                    &request_id,
                                    dataset_id.as_ref(),
                                    open_failure(
                                        DatasetOpenStage::Authorization,
                                        DatasetOpenFailureKind::Internal,
                                        false,
                                        "dataset retry requires a workspace session",
                                        None,
                                    ),
                                    &unicast_routes,
                                )
                                .await;
                                continue;
                            };
                            if let Err(e) = ctx
                                .manager
                                .require_editor(&ctx.live.workspace_id, &ctx.principal)
                                .await
                            {
                                send_open_failed(
                                    id,
                                    &request_id,
                                    dataset_id.as_ref(),
                                    open_failure(
                                        DatasetOpenStage::Authorization,
                                        DatasetOpenFailureKind::Authorization,
                                        false,
                                        "workspace role cannot retry dataset bindings",
                                        Some(e.to_string()),
                                    ),
                                    &unicast_routes,
                                )
                                .await;
                                continue;
                            }
                            let source = match ctx
                                .manager
                                .dataset_by_workspace_dataset(&ctx.live.workspace_id, &dataset_id)
                                .await
                            {
                                Ok(Some(source)) => source,
                                Ok(None) => {
                                    send_open_failed(
                                        id,
                                        &request_id,
                                        dataset_id.as_ref(),
                                        open_failure(
                                            DatasetOpenStage::SourceLookup,
                                            DatasetOpenFailureKind::WorkspaceLookup,
                                            false,
                                            "workspace dataset source was not found",
                                            None,
                                        ),
                                        &unicast_routes,
                                    )
                                    .await;
                                    continue;
                                }
                                Err(e) => {
                                    send_open_failed(
                                        id,
                                        &request_id,
                                        dataset_id.as_ref(),
                                        open_failure(
                                            DatasetOpenStage::SourceLookup,
                                            DatasetOpenFailureKind::WorkspaceLookup,
                                            true,
                                            "workspace dataset source lookup failed",
                                            Some(e.to_string()),
                                        ),
                                        &unicast_routes,
                                    )
                                    .await;
                                    continue;
                                }
                            };

                            tracing::info!(
                                client_id = %id,
                                request_id = %request_id,
                                workspace_dataset_id = %dataset_id,
                                url = %source.canonical_url,
                                "dataset_retry.received"
                            );
                            let session_clone = Arc::clone(&session);
                            let tx_clone = tx.clone();
                            let unicast_routes_clone = Arc::clone(&unicast_routes);
                            let proxy_config_clone = proxy_config.clone();
                            let workspace_clone = workspace.clone();
                            let request = OpenRemoteDatasetRequest {
                                request_id,
                                url: source.canonical_url,
                            };
                            tokio::spawn(async move {
                                handle_open_remote_dataset(
                                    id,
                                    request,
                                    session_clone,
                                    tx_clone,
                                    unicast_routes_clone,
                                    proxy_config_clone,
                                    workspace_clone,
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

// `dataset_id_for_url` and `dataset_url_hash16` live in
// `lucida_content::url` so the SPA (via the `lucida-core` wasm shim),
// the storage layer, and this handler share one implementation. See
// `wiki/decisions/0042-canonical-dataset-url-form.md`.

fn new_workspace_dataset_id() -> DatasetId {
    DatasetId(format!("wds-{}", uuid::Uuid::new_v4().simple()))
}

fn find_loaded_binding(
    sess: &Session,
    dataset_id: &DatasetId,
    canonical_url: &str,
    allow_source_url_match: bool,
) -> Option<(DatasetId, DatasetOpened)> {
    if sess.document.manifests.contains_key(dataset_id)
        && let Some(binding) = sess.server_bindings.get(dataset_id)
    {
        return Some((dataset_id.clone(), binding.dataset_opened.clone()));
    }

    if allow_source_url_match {
        for (existing_id, binding) in &sess.server_bindings {
            if binding.source_url == canonical_url
                && sess.document.manifests.contains_key(existing_id)
            {
                return Some((existing_id.clone(), binding.dataset_opened.clone()));
            }
        }
    }

    None
}

fn dataset_health_snapshot(sess: &Session, filter: Option<&DatasetId>) -> Vec<DatasetSourceHealth> {
    sess.document
        .manifests
        .values()
        .filter(|manifest| filter.is_none_or(|id| &manifest.dataset_id == id))
        .map(|manifest| dataset_health_for_manifest(sess, manifest))
        .collect()
}

fn dataset_health_for_manifest(sess: &Session, manifest: &DatasetManifest) -> DatasetSourceHealth {
    let dataset_id = manifest.dataset_id.clone();
    let binding = sess.server_bindings.get(&dataset_id);
    let runtime = sess.binding_runtime.get(&dataset_id);
    let generated = generated_coarse_health(sess.generated_availability.get(&dataset_id));
    let binding_component = match binding {
        Some(_) => DatasetHealthComponent {
            status: DatasetHealthStatus::Healthy,
            message: Some("server binding is ready".to_string()),
        },
        None => match runtime.and_then(|state| state.last_restore_failure.as_ref()) {
            Some(failure) => DatasetHealthComponent {
                status: DatasetHealthStatus::Unavailable,
                message: Some(format!(
                    "binding restore failed at {:?}: {}",
                    failure.stage, failure.message
                )),
            },
            None => DatasetHealthComponent {
                status: DatasetHealthStatus::Unavailable,
                message: Some("server binding is missing; chunks cannot be served".to_string()),
            },
        },
    };
    let source_cache = binding.map(|binding| cache_stats_for_protocol(binding.cache.stats()));
    let source_url = binding
        .map(|binding| binding.source_url.clone())
        .or_else(|| runtime.map(|state| state.source_url.clone()));
    let backend = source_url.as_deref().map(backend_kind_for_url);
    let mut messages = Vec::new();
    if binding.is_none() {
        messages.push(
            "dataset exists in the workspace document but has no runtime binding; retry dataset restore"
                .into(),
        );
    }
    if let Some(failure) = runtime.and_then(|state| state.last_restore_failure.as_ref()) {
        messages.push(format!(
            "last restore failure: stage {:?}, kind {:?}, retryable {}, {}",
            failure.stage, failure.kind, failure.retryable, failure.message
        ));
    }
    if generated.status == DatasetHealthStatus::Degraded {
        messages.push(
            generated
                .message
                .clone()
                .unwrap_or_else(|| "generated coarse has degraded readiness".into()),
        );
    }

    DatasetSourceHealth {
        workspace_dataset_id: dataset_id,
        name: manifest.name.clone(),
        status: combine_health(binding_component.status, generated.status),
        source_url,
        backend,
        binding: binding_component,
        source_cache,
        generated_coarse: generated,
        messages,
    }
}

fn cache_stats_for_protocol(stats: lucida_store::cache::CacheStats) -> DatasetSourceCacheStats {
    DatasetSourceCacheStats {
        max_bytes: stats.max_bytes,
        current_bytes: stats.current_bytes,
        entry_count: stats.entry_count,
        hits: stats.hits,
        misses: stats.misses,
        evictions: stats.evictions,
        backend_errors: stats.backend_errors,
    }
}

fn generated_coarse_health(
    snapshot: Option<&GeneratedAvailabilitySnapshot>,
) -> DatasetGeneratedCoarseHealth {
    let Some(snapshot) = snapshot else {
        return DatasetGeneratedCoarseHealth {
            status: DatasetHealthStatus::Healthy,
            level_count: 0,
            ready_chunks: 0,
            pending_chunks: 0,
            failed_chunks: 0,
            unavailable_chunks: 0,
            message: Some("no generated coarse levels advertised".to_string()),
        };
    };

    let mut ready_chunks = 0;
    let mut pending_chunks = 0;
    let mut failed_chunks = 0;
    let mut unavailable_chunks = 0;

    if snapshot.chunks.is_empty() {
        for summary in snapshot
            .levels
            .iter()
            .filter_map(|level| level.summary.as_ref())
        {
            ready_chunks += summary.ready_chunks;
            pending_chunks += summary.pending_chunks;
            failed_chunks += summary.failed_chunks;
        }
    } else {
        for chunk in &snapshot.chunks {
            match chunk.status {
                GeneratedChunkStatus::Ready => ready_chunks += 1,
                GeneratedChunkStatus::Pending => pending_chunks += 1,
                GeneratedChunkStatus::FailedTransient | GeneratedChunkStatus::FailedPermanent => {
                    failed_chunks += 1
                }
                GeneratedChunkStatus::Unavailable => unavailable_chunks += 1,
            }
        }
    }

    let status = if failed_chunks > 0 || unavailable_chunks > 0 {
        DatasetHealthStatus::Degraded
    } else {
        DatasetHealthStatus::Healthy
    };
    let message = if failed_chunks > 0 {
        Some(format!("{failed_chunks} generated coarse chunks failed"))
    } else if unavailable_chunks > 0 {
        Some(format!(
            "{unavailable_chunks} generated coarse chunks are unavailable"
        ))
    } else if pending_chunks > 0 {
        Some(format!(
            "{pending_chunks} generated coarse chunks are pending"
        ))
    } else if snapshot.levels.is_empty() {
        Some("no generated coarse levels advertised".to_string())
    } else {
        Some("generated coarse is healthy".to_string())
    };

    DatasetGeneratedCoarseHealth {
        status,
        level_count: snapshot.levels.len(),
        ready_chunks,
        pending_chunks,
        failed_chunks,
        unavailable_chunks,
        message,
    }
}

fn combine_health(
    binding: DatasetHealthStatus,
    generated: DatasetHealthStatus,
) -> DatasetHealthStatus {
    if binding == DatasetHealthStatus::Unavailable {
        DatasetHealthStatus::Unavailable
    } else if generated == DatasetHealthStatus::Degraded {
        DatasetHealthStatus::Degraded
    } else {
        DatasetHealthStatus::Healthy
    }
}

fn backend_kind_for_url(url: &str) -> String {
    if is_local_dataset_url(url) {
        "local".to_string()
    } else if url.starts_with("gs://") {
        "gcs".to_string()
    } else if url.starts_with("s3://") {
        "s3".to_string()
    } else if url.starts_with("http://") || url.starts_with("https://") {
        "http".to_string()
    } else {
        "unknown".to_string()
    }
}

fn open_failure(
    stage: DatasetOpenStage,
    kind: DatasetOpenFailureKind,
    retryable: bool,
    message: impl Into<String>,
    detail: Option<String>,
) -> DatasetOpenFailureDiagnostic {
    DatasetOpenFailureDiagnostic {
        stage,
        kind,
        retryable,
        message: message.into(),
        detail,
    }
}

fn open_progress(
    stage: DatasetOpenStage,
    message: impl Into<String>,
    workspace_dataset_id: Option<DatasetId>,
    dataset_source_id: Option<String>,
    detail: Option<String>,
) -> DatasetOpenProgressDiagnostic {
    DatasetOpenProgressDiagnostic {
        stage,
        message: message.into(),
        workspace_dataset_id,
        dataset_source_id,
        detail,
    }
}

fn backend_open_failure(error: &lucida_store::backend::StoreError) -> DatasetOpenFailureDiagnostic {
    match error {
        lucida_store::backend::StoreError::UnsupportedScheme(_) => open_failure(
            DatasetOpenStage::BackendOpen,
            DatasetOpenFailureKind::UnsupportedScheme,
            false,
            error.to_string(),
            None,
        ),
        lucida_store::backend::StoreError::Metadata(message) => {
            let lower = message.to_ascii_lowercase();
            let kind = if lower.contains("bucket") || lower.contains("credential") {
                DatasetOpenFailureKind::CloudConfiguration
            } else {
                DatasetOpenFailureKind::MissingMetadata
            };
            open_failure(
                DatasetOpenStage::BackendOpen,
                kind,
                false,
                error.to_string(),
                None,
            )
        }
        lucida_store::backend::StoreError::ObjectStore(inner) => {
            let message = inner.to_string();
            let lower = message.to_ascii_lowercase();
            let (kind, retryable) = if is_not_found(inner) {
                (DatasetOpenFailureKind::MissingObject, false)
            } else if lower.contains("canonical")
                || lower.contains("no such file")
                || lower.contains("not a directory")
            {
                (DatasetOpenFailureKind::LocalPath, false)
            } else if lower.contains("permission")
                || lower.contains("forbidden")
                || lower.contains("unauthorized")
                || lower.contains("denied")
            {
                (DatasetOpenFailureKind::Permission, false)
            } else if lower.contains("credential")
                || lower.contains("token")
                || lower.contains("region")
                || lower.contains("bucket")
            {
                (DatasetOpenFailureKind::CloudConfiguration, false)
            } else if lower.contains("http") || lower.contains("status") {
                (DatasetOpenFailureKind::Http, true)
            } else {
                (DatasetOpenFailureKind::StorageBackend, true)
            };
            open_failure(
                DatasetOpenStage::BackendOpen,
                kind,
                retryable,
                format!("storage error: {message}"),
                None,
            )
        }
    }
}

fn import_failure(error: &dyn std::fmt::Display) -> DatasetOpenFailureDiagnostic {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    let kind = if lower.contains("codec")
        || lower.contains("blosc")
        || lower.contains("cname")
        || lower.contains("compressor")
    {
        DatasetOpenFailureKind::UnsupportedCodec
    } else if lower.contains("chunk")
        || lower.contains("axis")
        || lower.contains("non-prefix")
        || lower.contains("layout")
    {
        DatasetOpenFailureKind::UnsupportedLayout
    } else if lower.contains("missing") || lower.contains("not found") {
        DatasetOpenFailureKind::MissingMetadata
    } else if lower.contains("json")
        || lower.contains("metadata")
        || lower.contains("multiscale")
        || lower.contains("malformed")
    {
        DatasetOpenFailureKind::MalformedMetadata
    } else {
        DatasetOpenFailureKind::Import
    };
    open_failure(DatasetOpenStage::MetadataImport, kind, false, message, None)
}

fn open_success(
    url: &str,
    opened: &DatasetOpened,
    dataset_source_id: Option<String>,
) -> DatasetOpenSuccessDiagnostic {
    DatasetOpenSuccessDiagnostic {
        stage: DatasetOpenStage::Complete,
        source_url: url.to_string(),
        workspace_dataset_id: opened.manifest.dataset_id.clone(),
        dataset_source_id,
        message: "dataset opened and broadcast".to_string(),
    }
}

#[derive(Debug)]
struct OpenRemoteDatasetRequest {
    request_id: String,
    url: String,
}

/// Handle OpenRemoteDataset: open a StorageBackend, import dataset, broadcast DatasetOpened.
///
/// The incoming `url` is normalized once at entry via
/// [`lucida_content::url::normalize_dataset_url`]; every downstream
/// derivation (`dataset_id_for_url` for source identity,
/// `dataset_url_hash16` for cache identity, `backend::open`, the
/// binding's `source_url`, and the name extraction) uses the canonical
/// form. Workspace clients receive an opaque workspace-local
/// `DatasetId`; the source-derived id is retained only for membership
/// dedupe and shared source/cache routing. This makes spelling variants
/// of the same path dedup to one source — see
/// `wiki/decisions/0042-canonical-dataset-url-form.md` for the rationale.
#[tracing::instrument(
    name = "dataset_open",
    skip(session, tx, unicast_routes, proxy_config, workspace),
    fields(url = %request.url, client_id = %client_id)
)]
async fn handle_open_remote_dataset(
    client_id: ClientId,
    request: OpenRemoteDatasetRequest,
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    unicast_routes: UnicastRoutes,
    proxy_config: ProxyConfig,
    workspace: Option<WorkspaceClientContext>,
) {
    let OpenRemoteDatasetRequest { request_id, url } = request;

    // Normalize at the input boundary. Drive-letter case, slash
    // direction, `file://` prefix, UNC backslashes — see ADR-0042.
    // Idempotent (safe even though `backend::open` will also normalize),
    // and required *here* because `dataset_id_for_url` /
    // `dataset_url_hash16` must hash the canonical form for the dedup
    // short-circuit to fire across spelling variants.
    let canonical_url = normalize_dataset_url(&url);

    // Stable, content-derived source ID. This is intentionally not the
    // client-facing dataset ID inside a workspace: workspace document
    // state uses an opaque workspace-local ID so the same source can be
    // opened independently in different workspaces while sharing the
    // source/cache identity below.
    let dataset_source_id = dataset_id_for_url(&canonical_url);
    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::RequestReceived,
            "dataset open request received",
            None,
            Some(dataset_source_id.clone()),
            Some(format!("normalized source: {canonical_url}")),
        ),
        &unicast_routes,
    )
    .await;

    if let Some(ctx) = workspace.as_ref()
        && ctx.live.background_cancelled()
    {
        tracing::info!(
            client_id = %client_id,
            workspace_id = %ctx.live.workspace_id,
            url = %canonical_url,
            "open_remote_dataset.cancelled_workspace_runtime"
        );
        send_open_failed(
            client_id,
            &request_id,
            &canonical_url,
            open_failure(
                DatasetOpenStage::Authorization,
                DatasetOpenFailureKind::SessionClosed,
                true,
                "workspace runtime is closed",
                None,
            ),
            &unicast_routes,
        )
        .await;
        return;
    }

    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::Authorization,
            "checking workspace permission",
            None,
            Some(dataset_source_id.clone()),
            workspace
                .as_ref()
                .map(|ctx| format!("workspace: {}", ctx.live.workspace_id)),
        ),
        &unicast_routes,
    )
    .await;

    if let Some(ctx) = workspace.as_ref()
        && let Err(e) = ctx
            .manager
            .require_editor(&ctx.live.workspace_id, &ctx.principal)
            .await
    {
        tracing::warn!(
            client_id = %client_id,
            workspace_id = %ctx.live.workspace_id,
            url = %canonical_url,
            error = %e,
            "open_remote_dataset.forbidden"
        );
        send_open_failed(
            client_id,
            &request_id,
            &canonical_url,
            open_failure(
                DatasetOpenStage::Authorization,
                DatasetOpenFailureKind::Authorization,
                false,
                "workspace role cannot add datasets",
                Some(e.to_string()),
            ),
            &unicast_routes,
        )
        .await;
        return;
    }

    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::Authorization,
            "workspace permission accepted",
            None,
            Some(dataset_source_id.clone()),
            workspace
                .as_ref()
                .map(|ctx| format!("workspace: {}", ctx.live.workspace_id)),
        ),
        &unicast_routes,
    )
    .await;

    let existing_workspace_source = if let Some(ctx) = workspace.as_ref() {
        send_open_progress(
            client_id,
            &request_id,
            &canonical_url,
            open_progress(
                DatasetOpenStage::SourceLookup,
                "checking persisted workspace dataset source",
                None,
                Some(dataset_source_id.clone()),
                Some(format!("workspace: {}", ctx.live.workspace_id)),
            ),
            &unicast_routes,
        )
        .await;
        match ctx
            .manager
            .dataset_by_source(&ctx.live.workspace_id, &dataset_source_id)
            .await
        {
            Ok(source) => source,
            Err(e) => {
                tracing::error!(
                    client_id = %client_id,
                    workspace_id = %ctx.live.workspace_id,
                    dataset_source_id = %dataset_source_id,
                    url = %canonical_url,
                    error = %e,
                    "open_remote_dataset.source_lookup_failed"
                );
                send_open_failed(
                    client_id,
                    &request_id,
                    &canonical_url,
                    open_failure(
                        DatasetOpenStage::SourceLookup,
                        DatasetOpenFailureKind::WorkspaceLookup,
                        true,
                        "workspace dataset lookup failed",
                        Some(e.to_string()),
                    ),
                    &unicast_routes,
                )
                .await;
                return;
            }
        }
    } else {
        None
    };

    let dataset_id_key = existing_workspace_source
        .as_ref()
        .map(|source| source.workspace_dataset_id.clone())
        .unwrap_or_else(|| {
            if workspace.is_some() {
                new_workspace_dataset_id()
            } else {
                DatasetId(dataset_source_id.clone())
            }
        });
    let dataset_id = dataset_id_key.0.clone();
    let workspace_scoped = workspace.is_some();
    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::SourceLookup,
            "workspace dataset source resolved",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            existing_workspace_source
                .as_ref()
                .map(|source| format!("display name: {}", source.display_name)),
        ),
        &unicast_routes,
    )
    .await;

    // If we've already imported this URL in this session, reuse the binding.
    // Re-broadcast the existing DatasetOpened (held on the binding) so the
    // requesting client receives the same content graph + fetch descriptor
    // without re-importing.
    {
        let sess = session.lock().await;
        if let Some((existing_dataset_id, existing)) =
            find_loaded_binding(&sess, &dataset_id_key, &canonical_url, workspace_scoped)
        {
            let opened = existing.clone();
            let command = DocumentCommand::DatasetOpened(existing);
            let seq = sess.seq;
            drop(sess);
            send_open_progress(
                client_id,
                &request_id,
                &canonical_url,
                open_progress(
                    DatasetOpenStage::BindingBuild,
                    "reusing existing server binding",
                    Some(existing_dataset_id.clone()),
                    Some(dataset_source_id.clone()),
                    None,
                ),
                &unicast_routes,
            )
            .await;
            send_open_progress(
                client_id,
                &request_id,
                &canonical_url,
                open_progress(
                    DatasetOpenStage::Broadcast,
                    "broadcasting existing dataset to workspace clients",
                    Some(existing_dataset_id.clone()),
                    Some(dataset_source_id.clone()),
                    Some(format!("seq: {seq}")),
                ),
                &unicast_routes,
            )
            .await;
            let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };
            let _ = tx.send(BroadcastItem::CommandBroadcast {
                sender: u64::MAX,
                broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
                ack_json: String::new(),
            });
            tracing::info!(
                dataset_id = %existing_dataset_id,
                dataset_source_id = %dataset_source_id,
                url = %canonical_url,
                "open_remote_dataset.dedup_reuse"
            );
            send_open_succeeded(
                client_id,
                &request_id,
                &canonical_url,
                seq,
                opened.clone(),
                open_success(&canonical_url, &opened, Some(dataset_source_id.clone())),
                &unicast_routes,
            )
            .await;
            return;
        }
    }

    // Open storage backend. `backend::open` re-normalizes (idempotent)
    // and dispatches via `is_local_dataset_url`.
    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::BackendOpen,
            "opening dataset storage backend",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!("backend: {}", backend_kind_for_url(&canonical_url))),
        ),
        &unicast_routes,
    )
    .await;
    let store = match lucida_store::backend::open(&canonical_url) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "open_remote_dataset.backend_open_failed");
            send_open_failed(
                client_id,
                &request_id,
                &canonical_url,
                backend_open_failure(&e),
                &unicast_routes,
            )
            .await;
            return;
        }
    };

    // Extract dataset name from URL (last path component). Canonical
    // form is always forward-slash, so a single `rsplit('/')` works for
    // every platform.
    let name = existing_workspace_source
        .as_ref()
        .map(|source| source.display_name.clone())
        .unwrap_or_else(|| {
            canonical_url
                .rsplit('/')
                .find(|s| !s.is_empty())
                .unwrap_or("dataset")
                .to_string()
        });

    // Import dataset via the new pipeline.
    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::MetadataImport,
            "importing OME-Zarr metadata",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!("name: {name}")),
        ),
        &unicast_routes,
    )
    .await;
    tracing::info!(
        url = %canonical_url,
        id = %dataset_id,
        dataset_source_id = %dataset_source_id,
        name = %name,
        "importing dataset"
    );
    let result = match lucida_store::import::import_dataset(&store, &dataset_id, &name).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "open_remote_dataset.import_failed");
            send_open_failed(
                client_id,
                &request_id,
                &canonical_url,
                import_failure(&e),
                &unicast_routes,
            )
            .await;
            return;
        }
    };

    if let Some(ctx) = workspace.as_ref()
        && ctx.live.background_cancelled()
    {
        tracing::info!(
            client_id = %client_id,
            workspace_id = %ctx.live.workspace_id,
            dataset_id = %dataset_id,
            dataset_source_id = %dataset_source_id,
            "open_remote_dataset.cancelled_after_import"
        );
        return;
    }

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
    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::MetadataImport,
            "metadata import complete",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!(
                "entities: {n_entities}, images: {n_images}, first image levels: {n_levels}"
            )),
        ),
        &unicast_routes,
    )
    .await;

    // Build operational binding.
    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::BindingBuild,
            "building server chunk binding",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!(
                "binding images: {}",
                result.binding_seed.images.len()
            )),
        ),
        &unicast_routes,
    )
    .await;
    let cached = Arc::new(CachedStore::new(store.clone(), 512 * 1024 * 1024));
    let resolver = Arc::new(ChunkResolver::new(&result.binding_seed));
    let generated_config = GeneratedCoarseConfig {
        target_long_axis: proxy_config.generated_target_long_axis,
        chunk_long_axis: proxy_config.generated_chunk_long_axis,
        max_chunk_bytes: proxy_config.generated_max_chunk_bytes,
    };
    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::GeneratedCoarsePlanning,
            if proxy_config.generated_enabled {
                "planning generated coarse levels"
            } else {
                "generated coarse planning disabled"
            },
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            None,
        ),
        &unicast_routes,
    )
    .await;
    let generated_plans = if proxy_config.generated_enabled {
        plan_generated_coarse_for_manifest(&result.manifest, generated_config)
    } else {
        vec![]
    };
    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::GeneratedCoarsePlanning,
            "generated coarse planning complete",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!("planned levels: {}", generated_plans.len())),
        ),
        &unicast_routes,
    )
    .await;

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
    let url_hash16 = dataset_url_hash16(&canonical_url);
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
    let prefetch_live = workspace.as_ref().map(|ctx| ctx.live.clone());

    let binding = ServerBinding {
        source_url: canonical_url.clone(),
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
    let (seq, document) = {
        let mut sess = session.lock().await;
        if let Some((existing_dataset_id, existing)) =
            find_loaded_binding(&sess, &dataset_id_key, &canonical_url, workspace_scoped)
        {
            // Lost the race: another open completed the import. Drop our
            // duplicate binding/command and rebroadcast the canonical one.
            let seq = sess.seq;
            drop(sess);
            let broadcast_msg = ServerMessage::CommandBroadcast {
                seq,
                command: DocumentCommand::DatasetOpened(existing),
            };
            let opened = match &broadcast_msg {
                ServerMessage::CommandBroadcast {
                    command: DocumentCommand::DatasetOpened(opened),
                    ..
                } => opened.clone(),
                _ => unreachable!("constructed above"),
            };
            send_open_progress(
                client_id,
                &request_id,
                &canonical_url,
                open_progress(
                    DatasetOpenStage::BindingBuild,
                    "reusing binding from concurrent dataset open",
                    Some(existing_dataset_id.clone()),
                    Some(dataset_source_id.clone()),
                    None,
                ),
                &unicast_routes,
            )
            .await;
            send_open_progress(
                client_id,
                &request_id,
                &canonical_url,
                open_progress(
                    DatasetOpenStage::Broadcast,
                    "broadcasting existing dataset to workspace clients",
                    Some(existing_dataset_id.clone()),
                    Some(dataset_source_id.clone()),
                    Some(format!("seq: {seq}")),
                ),
                &unicast_routes,
            )
            .await;
            let _ = tx.send(BroadcastItem::CommandBroadcast {
                sender: u64::MAX,
                broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
                ack_json: String::new(),
            });
            tracing::info!(
                dataset_id = %existing_dataset_id,
                dataset_source_id = %dataset_source_id,
                "open_remote_dataset.lost_race"
            );
            send_open_succeeded(
                client_id,
                &request_id,
                &canonical_url,
                seq,
                opened.clone(),
                open_success(&canonical_url, &opened, Some(dataset_source_id.clone())),
                &unicast_routes,
            )
            .await;
            return;
        }
        let seq = sess.apply(command.clone());
        if !generated_initial_delta.levels.is_empty() {
            sess.apply_generated_availability_delta(
                dataset_id_key.clone(),
                generated_initial_delta.clone(),
            );
        }
        sess.record_binding_source(
            dataset_id_key.clone(),
            canonical_url.clone(),
            Some(dataset_source_id.clone()),
            name.clone(),
        );
        sess.clear_binding_restore_failure(&dataset_id_key);
        sess.server_bindings.insert(dataset_id_key.clone(), binding);
        let document = sess.document.clone();
        (seq, document)
    };

    if workspace.is_some() {
        send_open_progress(
            client_id,
            &request_id,
            &canonical_url,
            open_progress(
                DatasetOpenStage::WorkspacePersist,
                "persisting workspace dataset membership",
                Some(dataset_id_key.clone()),
                Some(dataset_source_id.clone()),
                Some(format!("seq: {seq}")),
            ),
            &unicast_routes,
        )
        .await;
    }

    if let Some(ctx) = workspace.as_ref()
        && let Err(e) = ctx
            .manager
            .persist_dataset_opened(
                &ctx.live,
                &dataset_id_key,
                &dataset_source_id,
                &canonical_url,
                &name,
                &ctx.principal,
                seq,
                &document,
            )
            .await
    {
        tracing::error!(
            client_id = %client_id,
            workspace_id = %ctx.live.workspace_id,
            dataset_id = %dataset_id,
            dataset_source_id = %dataset_source_id,
            error = %e,
            "open_remote_dataset.persist_failed"
        );
        send_open_failed(
            client_id,
            &request_id,
            &canonical_url,
            open_failure(
                DatasetOpenStage::WorkspacePersist,
                DatasetOpenFailureKind::Persistence,
                true,
                "workspace persistence failed",
                Some(e.to_string()),
            ),
            &unicast_routes,
        )
        .await;
        return;
    }

    if workspace.is_some() {
        send_open_progress(
            client_id,
            &request_id,
            &canonical_url,
            open_progress(
                DatasetOpenStage::WorkspacePersist,
                "workspace dataset membership persisted",
                Some(dataset_id_key.clone()),
                Some(dataset_source_id.clone()),
                Some(format!("seq: {seq}")),
            ),
            &unicast_routes,
        )
        .await;
    }

    // Broadcast to ALL clients including the requester.
    // Use u64::MAX as sender so no client matches — everyone gets the
    // CommandBroadcast (not an Ack), since the requester hasn't applied
    // the DatasetOpened locally.
    let opened = match &command {
        DocumentCommand::DatasetOpened(opened) => opened.clone(),
        _ => unreachable!("dataset open command must be DatasetOpened"),
    };
    let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };

    send_open_progress(
        client_id,
        &request_id,
        &canonical_url,
        open_progress(
            DatasetOpenStage::Broadcast,
            "broadcasting dataset to workspace clients",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!("seq: {seq}")),
        ),
        &unicast_routes,
    )
    .await;

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
    send_open_succeeded(
        client_id,
        &request_id,
        &canonical_url,
        seq,
        opened.clone(),
        open_success(&canonical_url, &opened, Some(dataset_source_id.clone())),
        &unicast_routes,
    )
    .await;

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
                    if prefetch_live
                        .as_ref()
                        .is_some_and(|live| live.background_cancelled())
                    {
                        tracing::info!(
                            dataset = %dataset_id_for_log,
                            "background proxy pre-generation cancelled"
                        );
                        return;
                    }
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
    let mut bytes: Vec<u8> = match cache.get_bytes(&obj_path).await {
        Ok(storage_bytes) => {
            // Decode storage compression → raw bytes (WireFormat::Raw for phase 1).
            // Shared with the proxy generator via [`crate::decode::decode_storage_bytes`].
            match decode_storage_bytes(&storage_bytes, level_info.compression) {
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
            }
        }
        Err(e) if is_not_found(&e) => {
            vec![0_u8; level_info.chunk_byte_layout.canonical_byte_size]
        }
        Err(e) => {
            eprintln!("server: failed to read chunk {chunk_key} for {dataset_id}: {e}");
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

fn is_not_found(error: &object_store::Error) -> bool {
    matches!(error, object_store::Error::NotFound { .. })
        || error.to_string().contains("not found")
        || error.to_string().contains("No such file or directory")
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

/// Send a dataset-open progress message to the requesting client.
async fn send_open_progress(
    client_id: ClientId,
    request_id: &str,
    url: &str,
    diagnostic: DatasetOpenProgressDiagnostic,
    unicast_routes: &UnicastRoutes,
) {
    tracing::info!(
        client_id = %client_id,
        request_id = %request_id,
        url = %url,
        stage = ?diagnostic.stage,
        message = %diagnostic.message,
        "open_remote_dataset.progress"
    );
    let msg = ServerMessage::DatasetOpenProgress {
        request_id: request_id.to_string(),
        url: url.to_string(),
        diagnostic,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send(Message::Text(json.into()));
    }
}

/// Send an OpenDatasetSucceeded message to the requesting client.
async fn send_open_succeeded(
    client_id: ClientId,
    request_id: &str,
    url: &str,
    seq: u64,
    opened: DatasetOpened,
    diagnostic: DatasetOpenSuccessDiagnostic,
    unicast_routes: &UnicastRoutes,
) {
    send_open_progress(
        client_id,
        request_id,
        url,
        open_progress(
            DatasetOpenStage::Complete,
            diagnostic.message.clone(),
            Some(diagnostic.workspace_dataset_id.clone()),
            diagnostic.dataset_source_id.clone(),
            Some(format!("seq: {seq}")),
        ),
        unicast_routes,
    )
    .await;
    tracing::info!(
        client_id = %client_id,
        request_id = %request_id,
        url = %url,
        seq,
        "open_remote_dataset.succeeded"
    );
    let msg = ServerMessage::OpenDatasetSucceeded {
        request_id: request_id.to_string(),
        url: url.to_string(),
        seq,
        opened,
        diagnostic: Some(diagnostic),
    };
    let json = serde_json::to_string(&msg).unwrap();
    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send(Message::Text(json.into()));
    }
}

/// Send an OpenDatasetFailed message to the requesting client.
async fn send_open_failed(
    client_id: ClientId,
    request_id: &str,
    url: &str,
    diagnostic: DatasetOpenFailureDiagnostic,
    unicast_routes: &UnicastRoutes,
) {
    tracing::warn!(
        client_id = %client_id,
        request_id = %request_id,
        url = %url,
        error = %diagnostic.message,
        stage = ?diagnostic.stage,
        kind = ?diagnostic.kind,
        retryable = diagnostic.retryable,
        "open_remote_dataset.failed"
    );
    let msg = ServerMessage::OpenDatasetFailed {
        request_id: request_id.to_string(),
        url: url.to_string(),
        error: diagnostic.message.clone(),
        diagnostic: Some(diagnostic),
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

    #[test]
    fn dataset_health_reports_recorded_restore_failure() {
        let manifest = single_image_manifest();
        let dataset_id = manifest.dataset_id.clone();
        let mut sess = Session::new();
        sess.document
            .manifests
            .insert(dataset_id.clone(), manifest.clone());
        sess.record_binding_restore_failure(
            dataset_id,
            "/data/missing.zarr".into(),
            Some("source-1".into()),
            manifest.name,
            open_failure(
                DatasetOpenStage::BackendOpen,
                DatasetOpenFailureKind::MissingObject,
                false,
                "object was not found",
                Some("zarr.json missing".into()),
            ),
        );

        let health = dataset_health_snapshot(&sess, None);

        assert_eq!(health.len(), 1);
        assert_eq!(health[0].status, DatasetHealthStatus::Unavailable);
        assert_eq!(health[0].source_url.as_deref(), Some("/data/missing.zarr"));
        assert_eq!(health[0].backend.as_deref(), Some("local"));
        assert_eq!(health[0].binding.status, DatasetHealthStatus::Unavailable);
        assert!(
            health[0]
                .binding
                .message
                .as_deref()
                .unwrap()
                .contains("object was not found")
        );
        assert!(
            health[0]
                .messages
                .iter()
                .any(|message| message.contains("last restore failure"))
        );
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
    async fn missing_source_chunk_is_served_as_zero_fill() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        routes.lock().await.insert(5, tx);
        let store =
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let cache = Arc::new(CachedStore::new(store, 1024));
        let level_info = crate::binding::LevelInfo {
            level_index: 0,
            compression: crate::decode::StorageCompression::None,
            chunk_shape: vec![1, 1, 1, 1, 2],
            chunk_byte_layout: lucida_store::layout::ChunkByteLayout {
                canonical_byte_size: 4,
                on_disk_byte_size: 4,
                byte_stride_t: 0,
                byte_stride_c: 0,
                chunk_size_t: 1,
                chunk_size_c: 1,
            },
        };

        serve_chunk_from_store(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "0/0/0/0/0/0",
            Some("missing"),
            Some(level_info),
            &cache,
            &routes,
        )
        .await;

        let msg = rx.recv().await.expect("message");
        let Message::Binary(buf) = msg else {
            panic!("expected binary chunk frame");
        };
        let buf = buf.as_ref();
        let key_len = u16::from_le_bytes(buf[4..6].try_into().unwrap()) as usize;
        assert_eq!(&buf[6 + key_len..], &[0, 0, 0, 0]);
    }

    #[tokio::test]
    async fn generated_ready_chunk_is_served_with_normal_chunk_frame() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        routes.lock().await.insert(5, tx);

        let cache = Arc::new(DerivedChunkCache::default());
        cache.seed_ready_chunk(
            ImageId("img1".into()),
            2,
            "2/0/0/0/0/0".into(),
            vec![9, 8, 7, 6],
        );

        serve_generated_chunk_request(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            2,
            "2/0/0/0/0/0",
            &cache,
            &routes,
        )
        .await;

        let msg = rx.recv().await.expect("message");
        let Message::Binary(buf) = msg else {
            panic!("expected binary chunk frame");
        };
        let buf = buf.as_ref();
        let client_id = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!(client_id, 5);
        let key_len = u16::from_le_bytes(buf[4..6].try_into().unwrap()) as usize;
        let key = std::str::from_utf8(&buf[6..6 + key_len]).unwrap();
        assert_eq!(key, "ds1/img1/2/0/0/0/0/0");
        assert_eq!(&buf[6 + key_len..], &[9, 8, 7, 6]);
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
