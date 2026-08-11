use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use lucida_content::url::normalize_dataset_url;
use lucida_content::{DatasetId, DatasetManifest, ImageId};
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ChunkMessage, ClientId, ClientMessage, PeerIdentity, ServerMessage};
use lucida_protocol::{
    AssetMessage, DatasetGeneratedCoarseCacheStats, DatasetGeneratedCoarseFailure,
    DatasetGeneratedCoarseHealth, DatasetHealthComponent, DatasetHealthStatus,
    DatasetOpenFailureDiagnostic, DatasetOpenFailureKind, DatasetOpenProgressDiagnostic,
    DatasetOpenStage, DatasetOpenSuccessDiagnostic, DatasetOpened, DatasetSourceCacheStats,
    DatasetSourceHealth, GeneratedAvailabilitySnapshot, GeneratedChunkStatus, SourceChunkStatus,
};
use lucida_proxy::{ProxyAsset, ProxyKind, ProxySpec};
use lucida_store::cache::CachedStore;
use lucida_store::import_types::ImportWarningKind;
use lucida_store::source_limiter::ReaderId;
use object_store::path::Path;
use tokio::sync::{Mutex, broadcast, mpsc};

use crate::dataset_open::{self, DatasetOpenContext, DatasetOpenOutcome, WorkspaceScope};
use crate::decode::decode_storage_bytes;
use crate::generated::{
    DerivedCacheStorage, DerivedCacheTelemetry, DerivedChunkCache, DerivedChunkLookup,
    GeneratedCoarseService,
};
use crate::open_diagnostics::{
    backend_kind_for_url, is_not_found, open_failure, open_progress, store_error_status,
};
use crate::proxy::{PROXY_TARGET_LONG_AXIS, ProxyGenerator};
use crate::session::Session;
use crate::workspace::{CommandApplyError, LiveWorkspace, WorkspaceError, WorkspaceManager};
use crate::{BroadcastItem, ProxyConfig, UnicastRoutes};

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
        Some(WorkspaceScope {
            live,
            manager,
            principal,
        }),
    )
    .await;
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

/// Serialize an applied `(seq, command)` pair into the broadcast/ack
/// envelope: the sender receives `Ack { seq }`, everyone else the
/// `CommandBroadcast`.
fn broadcast_applied_command(
    tx: &broadcast::Sender<BroadcastItem>,
    sender: ClientId,
    seq: u64,
    command: DocumentCommand,
) {
    let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };
    let ack_msg = ServerMessage::Ack { seq };
    let _ = tx.send(BroadcastItem::CommandBroadcast {
        sender,
        broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
        ack_json: serde_json::to_string(&ack_msg).unwrap(),
    });
}

async fn handle_client_inner(
    id: ClientId,
    ws: WebSocket,
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    unicast_routes: UnicastRoutes,
    proxy_config: ProxyConfig,
    workspace: Option<WorkspaceScope>,
) {
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Per-client unicast channel for targeted messages (chunk routing).
    let (unicast_tx, mut unicast_rx) = mpsc::unbounded_channel::<Message>();
    unicast_routes.lock().await.insert(id, unicast_tx);

    // Presentational identity for this peer's cursor (#540), authored from
    // the connection's authenticated principal. The non-workspace `/ws`
    // path has no principal, so anonymous peers join with `None` and render
    // via the numeric-id fallback. Sourced server-side (never client-sent)
    // so it can't be spoofed and is only shown to co-present peers.
    //
    // Privacy: the raw email is NOT broadcast — collaborator emails are
    // owner-only. `from_principal_parts` computes a single-grapheme
    // `initial` from the display name (or email local-part when blank)
    // server-side, so only the non-identifying name/avatar/initial cross
    // the wire to co-present (possibly non-owner) peers.
    let identity = workspace.as_ref().map(|ctx| {
        PeerIdentity::from_principal_parts(
            ctx.principal.display_name.clone(),
            ctx.principal.picture_url.clone(),
            &ctx.principal.email,
        )
    });

    // Lock session, subscribe (before unlock — no gap), add client, snapshot, unlock.
    let (snapshot_json, mut rx, peer_joined_json) = {
        let mut sess = session.lock().await;
        let rx = tx.subscribe();
        let presence = sess.add_client(id, identity);
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
    let outbound_session = Arc::clone(&session);
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
                            // This client's broadcast receiver overflowed and
                            // dropped `n` messages — among them possibly
                            // sequenced CommandBroadcasts, so its document has
                            // silently diverged. Push a fresh snapshot to
                            // repair it.
                            //
                            // Ordering discipline (mirrors the join path's
                            // subscribe-under-lock): `recv()` has ALREADY
                            // repositioned this receiver past the loss, so
                            // every message this client will never see was
                            // stamped — and applied to the session — before
                            // this point. Taking the session lock now yields a
                            // snapshot whose `seq` is >= every lost message's
                            // seq: no hole can open between the snapshot and
                            // the resume position. Retained items forwarded
                            // after the snapshot may carry seq <= the
                            // snapshot's; the client's seq discipline drops
                            // those instead of double-applying.
                            tracing::warn!(
                                client_id = %id,
                                skipped = n,
                                "ws.outbound.lagged_pushing_snapshot"
                            );
                            let snapshot_json = {
                                let sess = outbound_session.lock().await;
                                serde_json::to_string(&sess.snapshot(id)).unwrap()
                            };
                            if ws_tx
                                .send(Message::Text(snapshot_json.into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
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

    // Throttle for client-requested snapshots: serving one clones the whole
    // document under the session lock, so RequestSnapshot must not become a
    // cheap amplification lever. One per interval per client is plenty —
    // the web's own resync retry sits at 5s, well above this floor, and a
    // throttled client simply retries.
    const REQUEST_SNAPSHOT_MIN_INTERVAL: Duration = Duration::from_secs(1);
    let mut last_requested_snapshot: Option<Instant> = None;

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
                                // Workspace command authorization lives in
                                // WorkspaceManager, not here: a dataset rename
                                // has its own authorize + validate +
                                // exists-check + DB-sync path
                                // (`rename_dataset`); every other document
                                // command goes through
                                // `apply_document_command` (editor gate +
                                // apply + persist). This loop only translates
                                // the manager's verdict to the wire —
                                // broadcast the applied command so peers
                                // apply it live, or drop it with a log line.
                                if let DocumentCommand::RenameDataset { id: ds_id, name } = &command
                                {
                                    match ctx
                                        .manager
                                        .rename_dataset(&ctx.live, &ctx.principal, ds_id, name)
                                        .await
                                    {
                                        Ok((seq, applied)) => {
                                            broadcast_applied_command(&tx, id, seq, applied);
                                        }
                                        Err(e) => {
                                            tracing::warn!(
                                                client_id = %id,
                                                workspace_id = %ctx.live.workspace_id,
                                                error = %e,
                                                "workspace.command.rename_dataset_rejected"
                                            );
                                        }
                                    }
                                    continue;
                                }
                                match ctx
                                    .manager
                                    .apply_document_command(&ctx.live, &ctx.principal, command)
                                    .await
                                {
                                    Ok((seq, applied)) => {
                                        broadcast_applied_command(&tx, id, seq, applied);
                                    }
                                    Err(e @ CommandApplyError::Forbidden) => {
                                        tracing::warn!(
                                            client_id = %id,
                                            workspace_id = %ctx.live.workspace_id,
                                            error = %e,
                                            "workspace.command.forbidden"
                                        );
                                    }
                                    // A role-lookup store failure is not an
                                    // authorization verdict — no role was
                                    // read and nothing was applied — so it
                                    // gets its own event: operators should
                                    // see infrastructure trouble, not a
                                    // permissions decision or a persistence
                                    // fault.
                                    Err(e @ CommandApplyError::GateUnavailable(_)) => {
                                        tracing::error!(
                                            client_id = %id,
                                            workspace_id = %ctx.live.workspace_id,
                                            error = %e,
                                            "workspace.command.authorization_unavailable"
                                        );
                                    }
                                    Err(e @ CommandApplyError::PersistFailed(_)) => {
                                        tracing::error!(
                                            client_id = %id,
                                            workspace_id = %ctx.live.workspace_id,
                                            error = %e,
                                            "workspace.command.persist_failed"
                                        );
                                    }
                                }
                                continue;
                            }

                            // Non-workspace `/ws` session: this path has no
                            // workspace authorization by design — apply
                            // directly; nothing to persist.
                            let seq = {
                                let mut sess = session.lock().await;
                                sess.apply(command.clone())
                            };
                            broadcast_applied_command(&tx, id, seq, command);
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
                            // Authorization is the manager's
                            // (`dataset_source_for_retry` gates on editor
                            // before the lookup); here we only translate its
                            // verdict into the open-failure diagnostics.
                            let source = match ctx
                                .manager
                                .dataset_source_for_retry(
                                    &ctx.live.workspace_id,
                                    &ctx.principal,
                                    &dataset_id,
                                )
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
                                        dataset_retry_failure_diagnostic(e),
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
                        ClientMessage::RequestSnapshot => {
                            // Client-detected seq gap: answer with the same
                            // fresh-snapshot construction as the join path and
                            // the outbound loop's Lagged push. The snapshot is
                            // built under the session lock, so its `seq`
                            // covers every command applied so far; sequenced
                            // messages still in flight with seq <= that are
                            // dropped by the client's seq discipline, and
                            // everything newer keeps arriving on the live
                            // broadcast receiver — no hole, no double-apply.
                            if last_requested_snapshot
                                .is_some_and(|at| at.elapsed() < REQUEST_SNAPSHOT_MIN_INTERVAL)
                            {
                                tracing::debug!(client_id = %id, "request_snapshot.throttled");
                                continue;
                            }
                            last_requested_snapshot = Some(Instant::now());
                            tracing::info!(client_id = %id, "request_snapshot.received");
                            let snapshot_json = {
                                let sess = session.lock().await;
                                serde_json::to_string(&sess.snapshot(id)).unwrap()
                            };
                            let senders = unicast_routes.lock().await;
                            if let Some(sender) = senders.get(&id) {
                                let _ = sender.send(Message::Text(snapshot_json.into()));
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

fn dataset_health_snapshot(sess: &Session, filter: Option<&DatasetId>) -> Vec<DatasetSourceHealth> {
    sess.document
        .manifests
        .values()
        .filter(|manifest| filter.is_none_or(|id| &manifest.dataset_id == id))
        .map(|manifest| dataset_health_for_manifest(sess, manifest))
        .collect()
}

pub(crate) fn dataset_health_for_manifest(
    sess: &Session,
    manifest: &DatasetManifest,
) -> DatasetSourceHealth {
    let dataset_id = manifest.dataset_id.clone();
    let binding = sess.server_bindings.get(&dataset_id);
    let runtime = sess.binding_runtime.get(&dataset_id);
    let generated = generated_coarse_health(
        sess.generated_availability.get(&dataset_id),
        binding.map(|binding| binding.derived_chunks.telemetry()),
    );
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
    let source_cache_status = source_cache
        .as_ref()
        .map(|cache| {
            if cache.backend_errors > 0 {
                DatasetHealthStatus::Degraded
            } else {
                DatasetHealthStatus::Healthy
            }
        })
        .unwrap_or(DatasetHealthStatus::Healthy);
    let source_url = binding
        .map(|binding| binding.source_url.clone())
        .or_else(|| runtime.map(|state| state.source_url.clone()));
    let backend = source_url.as_deref().map(backend_kind_for_url);
    let mut messages = Vec::new();
    // A level the export never wrote reads as fill and renders as an all-zero
    // image, so a dataset carrying one is not healthy however well the server
    // is serving it — reporting `healthy` over a black viewport is exactly the
    // mis-read this is here to prevent. Other import warnings stay
    // informational and leave the status alone.
    let mut import_status = DatasetHealthStatus::Healthy;
    if let Some(binding) = binding {
        for warning in &binding.import_warnings {
            if warning.kind == ImportWarningKind::UnwrittenLevel {
                import_status = DatasetHealthStatus::Degraded;
            }
            messages.push(warning.message.clone());
        }
    }
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
    if let Some(cache) = &source_cache {
        if cache.backend_errors > 0 {
            messages.push(format!(
                "source cache saw {} backend errors while serving chunks",
                cache.backend_errors
            ));
        }
        if cache.used_percent >= 90 {
            messages.push(format!(
                "source cache is {}% full ({} / {} bytes)",
                cache.used_percent, cache.current_bytes, cache.max_bytes
            ));
        }
        if cache.evictions > 0 {
            messages.push(format!(
                "source cache evicted {} entries under its byte budget",
                cache.evictions
            ));
        }
    }
    if let Some(cache) = generated.cache.as_ref() {
        if cache.evictions > 0 {
            messages.push(format!(
                "generated coarse cache evicted {} level directories",
                cache.evictions
            ));
        }
        if let Some(used_percent) = cache.used_percent
            && used_percent >= 90
        {
            messages.push(format!(
                "generated coarse cache is {used_percent}% full ({} bytes)",
                cache.current_bytes
            ));
        }
    }

    DatasetSourceHealth {
        workspace_dataset_id: dataset_id,
        name: manifest.name.clone(),
        status: combine_health(
            combine_health(
                combine_health(binding_component.status, source_cache_status),
                generated.status,
            ),
            import_status,
        ),
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
        used_percent: cache_used_percent(stats.current_bytes as u64, Some(stats.max_bytes as u64))
            .unwrap_or(0),
        entry_count: stats.entry_count,
        hits: stats.hits,
        misses: stats.misses,
        evictions: stats.evictions,
        backend_errors: stats.backend_errors,
        source_reads: stats.source_reads,
        source_read_millis: stats.source_read_millis,
    }
}

fn generated_coarse_health(
    snapshot: Option<&GeneratedAvailabilitySnapshot>,
    cache: Option<DerivedCacheTelemetry>,
) -> DatasetGeneratedCoarseHealth {
    let cache = cache.map(generated_cache_stats_for_protocol);
    let Some(snapshot) = snapshot else {
        return DatasetGeneratedCoarseHealth {
            status: DatasetHealthStatus::Healthy,
            level_count: 0,
            ready_chunks: 0,
            pending_chunks: 0,
            failed_chunks: 0,
            unavailable_chunks: 0,
            message: Some("no generated coarse levels advertised".to_string()),
            cache,
            recent_failures: Vec::new(),
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
    let recent_failures = snapshot
        .chunks
        .iter()
        .filter(|chunk| {
            matches!(
                chunk.status,
                GeneratedChunkStatus::FailedTransient
                    | GeneratedChunkStatus::FailedPermanent
                    | GeneratedChunkStatus::Unavailable
            )
        })
        .rev()
        .take(5)
        .map(|chunk| DatasetGeneratedCoarseFailure {
            image_id: chunk.image_id.0.clone(),
            level_index: chunk.level_index,
            key: chunk.key.clone(),
            status: chunk.status,
            message: chunk.message.clone(),
        })
        .collect::<Vec<_>>();

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
        cache,
        recent_failures,
    }
}

fn generated_cache_stats_for_protocol(
    telemetry: DerivedCacheTelemetry,
) -> DatasetGeneratedCoarseCacheStats {
    DatasetGeneratedCoarseCacheStats {
        storage: match telemetry.storage {
            DerivedCacheStorage::Memory => "memory".to_string(),
            DerivedCacheStorage::Disk => "disk".to_string(),
        },
        current_bytes: telemetry.bytes,
        max_bytes: telemetry.budget_bytes,
        used_percent: cache_used_percent(telemetry.bytes, telemetry.budget_bytes),
        evictions: telemetry.evictions,
        root: telemetry.root_dir.map(|root| root.display().to_string()),
    }
}

fn cache_used_percent(current_bytes: u64, max_bytes: Option<u64>) -> Option<u8> {
    let max_bytes = max_bytes?;
    if max_bytes == 0 {
        return Some(0);
    }
    Some(
        ((current_bytes.saturating_mul(100) / max_bytes).min(100))
            .try_into()
            .unwrap_or(100),
    )
}

/// The worse of two component statuses.
///
/// Symmetric on purpose, so folding several components together cannot lose
/// one: the earlier form only looked for `Degraded` in its right-hand
/// argument, which meant a degraded source cache folded against a healthy
/// generated-coarse reported the dataset healthy.
fn combine_health(a: DatasetHealthStatus, b: DatasetHealthStatus) -> DatasetHealthStatus {
    if a == DatasetHealthStatus::Unavailable || b == DatasetHealthStatus::Unavailable {
        DatasetHealthStatus::Unavailable
    } else if a == DatasetHealthStatus::Degraded || b == DatasetHealthStatus::Degraded {
        DatasetHealthStatus::Degraded
    } else {
        DatasetHealthStatus::Healthy
    }
}

/// Map a [`WorkspaceManager::dataset_source_for_retry`] failure onto the
/// open-failure diagnostic vocabulary. `Forbidden` is an authorization
/// verdict and is final (not retryable). Every other failure is a store
/// error — and that deliberately includes the editor gate's own role
/// lookup failing: a transient store failure is not an authorization
/// denial, so it maps to the retryable lookup diagnostic, never to the
/// Authorization one.
fn dataset_retry_failure_diagnostic(error: WorkspaceError) -> DatasetOpenFailureDiagnostic {
    match &error {
        WorkspaceError::Forbidden => open_failure(
            DatasetOpenStage::Authorization,
            DatasetOpenFailureKind::Authorization,
            false,
            "workspace role cannot retry dataset bindings",
            Some(error.to_string()),
        ),
        _ => open_failure(
            DatasetOpenStage::SourceLookup,
            DatasetOpenFailureKind::WorkspaceLookup,
            true,
            "workspace dataset source lookup failed",
            Some(error.to_string()),
        ),
    }
}

#[derive(Debug)]
struct OpenRemoteDatasetRequest {
    request_id: String,
    url: String,
}

/// Handle OpenRemoteDataset over the socket: run the headless
/// [`dataset_open::open_dataset`] orchestration and adapt its per-stage
/// progress plus terminal success/failure diagnostics onto the requesting
/// client's unicast channel. All domain behavior — authorization, dedup,
/// import, binding construction, persistence, broadcast — lives in
/// [`crate::dataset_open`]; this function only moves messages.
async fn handle_open_remote_dataset(
    client_id: ClientId,
    request: OpenRemoteDatasetRequest,
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    unicast_routes: UnicastRoutes,
    proxy_config: ProxyConfig,
    workspace: Option<WorkspaceScope>,
) {
    let OpenRemoteDatasetRequest { request_id, url } = request;
    // Wire envelopes carry the canonical URL — the same (idempotent)
    // normalization the orchestration applies at its own entry.
    let canonical_url = normalize_dataset_url(&url);

    // Forward per-stage progress to the requesting client as it happens.
    // The forwarder drains fully (its sender is dropped first) before the
    // terminal success/failure message goes out, so per-client ordering
    // on the unicast channel is progress* → terminal.
    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();
    let forwarder = {
        let unicast_routes = Arc::clone(&unicast_routes);
        let request_id = request_id.clone();
        let canonical_url = canonical_url.clone();
        tokio::spawn(async move {
            while let Some(diagnostic) = progress_rx.recv().await {
                send_open_progress(
                    client_id,
                    &request_id,
                    &canonical_url,
                    diagnostic,
                    &unicast_routes,
                )
                .await;
            }
        })
    };

    let ctx = DatasetOpenContext {
        session,
        tx,
        proxy_config,
        workspace,
    };
    let result = dataset_open::open_dataset(client_id, &url, &ctx, &progress_tx).await;
    drop(progress_tx);
    let _ = forwarder.await;

    match result {
        Ok(DatasetOpenOutcome::Opened {
            seq,
            opened,
            diagnostic,
        }) => {
            send_open_succeeded(
                client_id,
                &request_id,
                &canonical_url,
                seq,
                *opened,
                diagnostic,
                &unicast_routes,
            )
            .await;
        }
        // The workspace runtime shut down mid-open: nothing more to send.
        Ok(DatasetOpenOutcome::Cancelled) => {}
        Err(diagnostic) => {
            send_open_failed(
                client_id,
                &request_id,
                &canonical_url,
                diagnostic,
                &unicast_routes,
            )
            .await;
        }
    }
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
    // Charged to the requesting client, so one client's collection-sized
    // backlog cannot delay another client's first chunk (#901).
    let mut bytes: Vec<u8> = match cache.get_bytes(&obj_path, ReaderId(client_id)).await {
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
            // A non-not-found store failure (revoked access, backend fault,
            // unreachable service) must reach the requesting client as an
            // explicit status frame: from its side the alternative is a
            // request timeout, which it has to treat as transient, so a
            // dead source would never surface.
            eprintln!("server: failed to read chunk {chunk_key} for {dataset_id}: {e}");
            send_source_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                store_error_status(&e),
                Some(e.to_string()),
                unicast_routes,
            )
            .await;
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

/// Unicast the failure status for a source chunk whose store read failed
/// (see the error arm in [`serve_chunk_from_store`]). Mirrors
/// [`send_generated_chunk_status`]: a TEXT frame to the requesting client,
/// while served bytes always travel as binary chunk frames.
async fn send_source_chunk_status(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    status: SourceChunkStatus,
    message: Option<String>,
    unicast_routes: &UnicastRoutes,
) {
    let msg = ServerMessage::SourceChunkStatus {
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
/// `kind_str` is `GroupProxy3D` or `TileProxy3D` (matching the JSON
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
        ProxyKind::GroupProxy3D => "GroupProxy3D",
        ProxyKind::TileProxy3D => "TileProxy3D",
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

    /// Health is a worst-of fold, and no component may be lost to argument
    /// order. The earlier form only looked for `Degraded` on the right, so
    /// `combine(Degraded, Healthy)` wrongly answered `Healthy` — which
    /// silently swallowed a degraded source cache.
    #[test]
    fn combine_health_is_symmetric_worst_of() {
        use DatasetHealthStatus::{Degraded, Healthy, Unavailable};

        assert_eq!(combine_health(Healthy, Healthy), Healthy);
        assert_eq!(combine_health(Degraded, Healthy), Degraded);
        assert_eq!(combine_health(Healthy, Degraded), Degraded);
        assert_eq!(combine_health(Unavailable, Healthy), Unavailable);
        assert_eq!(combine_health(Healthy, Unavailable), Unavailable);
        assert_eq!(combine_health(Degraded, Unavailable), Unavailable);
        assert_eq!(combine_health(Unavailable, Degraded), Unavailable);
    }
    use crate::test_fixtures::single_image_manifest;
    use lucida_content::EntityId;
    use lucida_proxy::{ProxyDtype, ProxyHeader};

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

    #[test]
    fn dataset_retry_forbidden_maps_to_authorization_denial() {
        let diag = dataset_retry_failure_diagnostic(WorkspaceError::Forbidden);
        assert_eq!(diag.stage, DatasetOpenStage::Authorization);
        assert_eq!(diag.kind, DatasetOpenFailureKind::Authorization);
        assert!(!diag.retryable, "a role denial is final, not retryable");
        assert_eq!(diag.message, "workspace role cannot retry dataset bindings");
        assert_eq!(diag.detail.as_deref(), Some("forbidden"));
    }

    #[test]
    fn dataset_retry_store_failure_maps_to_retryable_lookup() {
        // A store failure — INCLUDING the editor gate's role lookup
        // erroring — is infrastructure trouble, not an authorization
        // verdict: it must surface as the retryable lookup diagnostic.
        let diag = dataset_retry_failure_diagnostic(WorkspaceError::Store(
            crate::workspace::StoreError::Backend("connection pool closed".into()),
        ));
        assert_eq!(diag.stage, DatasetOpenStage::SourceLookup);
        assert_eq!(diag.kind, DatasetOpenFailureKind::WorkspaceLookup);
        assert!(diag.retryable);
        assert_eq!(diag.message, "workspace dataset source lookup failed");
        assert!(
            diag.detail
                .as_deref()
                .unwrap()
                .contains("connection pool closed")
        );
    }

    #[test]
    fn source_cache_stats_report_pressure_percent() {
        let stats = cache_stats_for_protocol(lucida_store::cache::CacheStats {
            max_bytes: 1000,
            current_bytes: 925,
            entry_count: 4,
            hits: 10,
            misses: 3,
            evictions: 2,
            backend_errors: 1,
            coalesced: 5,
            source_reads: 8,
            source_read_millis: 2_400,
        });

        assert_eq!(stats.used_percent, 92);
        assert_eq!(stats.backend_errors, 1);
        // The read cost an open pays is carried on the same health payload the
        // CLI and the debug panel already render.
        assert_eq!(stats.source_reads, 8);
        assert_eq!(stats.source_read_millis, 2_400);
    }

    #[test]
    fn generated_coarse_health_reports_cache_and_recent_failures() {
        let snapshot = GeneratedAvailabilitySnapshot {
            levels: vec![],
            chunks: vec![lucida_protocol::GeneratedChunkStatusUpdate {
                image_id: ImageId("img-1".into()),
                level_index: 3,
                key: "3/0/0/0/0/0".into(),
                status: GeneratedChunkStatus::FailedTransient,
                message: Some("temporary source error".into()),
            }],
        };
        let health = generated_coarse_health(
            Some(&snapshot),
            Some(DerivedCacheTelemetry {
                storage: DerivedCacheStorage::Disk,
                bytes: 950,
                budget_bytes: Some(1000),
                root_dir: Some(std::path::PathBuf::from("/tmp/generated")),
                evictions: 2,
            }),
        );

        assert_eq!(health.status, DatasetHealthStatus::Degraded);
        assert_eq!(health.failed_chunks, 1);
        assert_eq!(health.cache.as_ref().unwrap().storage, "disk");
        assert_eq!(health.cache.as_ref().unwrap().used_percent, Some(95));
        assert_eq!(
            health.cache.as_ref().unwrap().root.as_deref(),
            Some("/tmp/generated")
        );
        assert_eq!(health.recent_failures.len(), 1);
        assert_eq!(
            health.recent_failures[0].status,
            GeneratedChunkStatus::FailedTransient
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
        let key = proxy_response_key(&EntityId("tile-A1".into()), ProxyKind::TileProxy3D, 0, 0);
        assert_eq!(key, "proxy/tile-A1/TileProxy3D/T00000_C000");

        let group =
            proxy_response_key(&EntityId("group-B2".into()), ProxyKind::GroupProxy3D, 12, 3);
        assert_eq!(group, "proxy/group-B2/GroupProxy3D/T00012_C003");
    }

    #[test]
    fn proxy_kind_str_pins_variant_names() {
        assert_eq!(proxy_kind_str(ProxyKind::GroupProxy3D), "GroupProxy3D");
        assert_eq!(proxy_kind_str(ProxyKind::TileProxy3D), "TileProxy3D");
    }

    #[test]
    fn encode_proxy_frame_round_trips_header_and_voxels() {
        let asset = sample_asset([2, 3, 4]);
        let entity_id = EntityId("e1".into());
        let buf = encode_proxy_frame(7, &entity_id, ProxyKind::TileProxy3D, 5, 1, &asset)
            .expect("encode");

        // [client_id:u32 LE][key_len:u16 LE][key][header 64][voxels]
        assert!(buf.len() >= 4 + 2 + 64);
        let client_id = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!(client_id, 7);

        let key_len = u16::from_le_bytes(buf[4..6].try_into().unwrap()) as usize;
        let key_start = 6;
        let key_end = key_start + key_len;
        let key = std::str::from_utf8(&buf[key_start..key_end]).unwrap();
        assert_eq!(key, "proxy/e1/TileProxy3D/T00005_C001");

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
        // Not-found is sparse data, never a failure status frame.
        assert!(rx.try_recv().is_err());
    }

    /// Which error class [`FailingStore`] fabricates for every read.
    #[derive(Debug, Clone, Copy)]
    enum StoreFailure {
        PermissionDenied,
        Backend,
    }

    /// An `ObjectStore` whose reads always fail with the configured error
    /// class, standing in for a source whose credentials were revoked or
    /// whose backend is down after a successful open.
    #[derive(Debug)]
    struct FailingStore(StoreFailure);

    impl FailingStore {
        fn error(&self) -> object_store::Error {
            match self.0 {
                StoreFailure::PermissionDenied => object_store::Error::PermissionDenied {
                    path: "chunk".into(),
                    source: "403 Forbidden".to_string().into(),
                },
                StoreFailure::Backend => object_store::Error::Generic {
                    store: "failing-store",
                    source: "503 Service Unavailable".to_string().into(),
                },
            }
        }
    }

    impl std::fmt::Display for FailingStore {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "FailingStore({:?})", self.0)
        }
    }

    #[async_trait::async_trait]
    impl object_store::ObjectStore for FailingStore {
        async fn put_opts(
            &self,
            _location: &Path,
            _payload: object_store::PutPayload,
            _opts: object_store::PutOptions,
        ) -> object_store::Result<object_store::PutResult> {
            Err(self.error())
        }

        async fn put_multipart_opts(
            &self,
            _location: &Path,
            _opts: object_store::PutMultipartOptions,
        ) -> object_store::Result<Box<dyn object_store::MultipartUpload>> {
            Err(self.error())
        }

        async fn get_opts(
            &self,
            _location: &Path,
            _options: object_store::GetOptions,
        ) -> object_store::Result<object_store::GetResult> {
            Err(self.error())
        }

        async fn delete(&self, _location: &Path) -> object_store::Result<()> {
            Err(self.error())
        }

        fn list(
            &self,
            _prefix: Option<&Path>,
        ) -> futures_util::stream::BoxStream<'static, object_store::Result<object_store::ObjectMeta>>
        {
            futures_util::stream::empty().boxed()
        }

        async fn list_with_delimiter(
            &self,
            _prefix: Option<&Path>,
        ) -> object_store::Result<object_store::ListResult> {
            Err(self.error())
        }

        async fn copy(&self, _from: &Path, _to: &Path) -> object_store::Result<()> {
            Err(self.error())
        }

        async fn copy_if_not_exists(&self, _from: &Path, _to: &Path) -> object_store::Result<()> {
            Err(self.error())
        }
    }

    fn tiny_level_info() -> crate::binding::LevelInfo {
        crate::binding::LevelInfo {
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
        }
    }

    /// Drive `serve_chunk_from_store` against a [`FailingStore`] and return
    /// the single frame the requesting client received.
    async fn serve_against_failing_store(failure: StoreFailure) -> serde_json::Value {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        routes.lock().await.insert(7, tx);
        let store = Arc::new(FailingStore(failure)) as Arc<dyn object_store::ObjectStore>;
        let cache = Arc::new(CachedStore::new(store, 1024));

        serve_chunk_from_store(
            7,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "0/0/0/0/0/0",
            Some("some/object"),
            Some(tiny_level_info()),
            &cache,
            &routes,
        )
        .await;

        let msg = rx.recv().await.expect("status frame");
        let Message::Text(json) = msg else {
            panic!("expected text status frame");
        };
        assert!(rx.try_recv().is_err(), "the status must be the only frame");
        serde_json::from_str(&json).unwrap()
    }

    #[tokio::test]
    async fn present_source_chunk_is_served_as_binary_with_no_status_frame() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        routes.lock().await.insert(5, tx);
        let store = object_store::memory::InMemory::new();
        object_store::ObjectStore::put(
            &store,
            &Path::from("some/object"),
            object_store::PutPayload::from_static(&[1, 2, 3, 4]),
        )
        .await
        .unwrap();
        let cache = Arc::new(CachedStore::new(
            Arc::new(store) as Arc<dyn object_store::ObjectStore>,
            1024,
        ));

        serve_chunk_from_store(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "0/0/0/0/0/0",
            Some("some/object"),
            Some(tiny_level_info()),
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
        assert_eq!(&buf[6 + key_len..], &[1, 2, 3, 4]);
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn backend_store_error_serving_source_chunk_reports_unavailable() {
        let value = serve_against_failing_store(StoreFailure::Backend).await;
        assert_eq!(value["type"], "source_chunk_status");
        assert_eq!(value["dataset_id"], "ds1");
        assert_eq!(value["image_id"], "img1");
        assert_eq!(value["key"], "0/0/0/0/0/0");
        assert_eq!(value["status"], "unavailable");
        assert!(
            value["message"]
                .as_str()
                .expect("message string")
                .contains("503"),
        );
    }

    #[tokio::test]
    async fn permission_store_error_serving_source_chunk_reports_failed_permanent() {
        let value = serve_against_failing_store(StoreFailure::PermissionDenied).await;
        assert_eq!(value["type"], "source_chunk_status");
        assert_eq!(value["status"], "failed_permanent");
        assert!(
            value["message"]
                .as_str()
                .expect("message string")
                .contains("403"),
        );
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

    /// An `ObjectStore` whose every read takes a fixed time and then reports
    /// the object absent. Absent is enough: a not-found read still costs a
    /// full round trip and a full permit, which is exactly what is being
    /// queued for here.
    #[derive(Debug)]
    struct SlowAbsentStore {
        delay: std::time::Duration,
    }

    impl std::fmt::Display for SlowAbsentStore {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "SlowAbsentStore")
        }
    }

    #[async_trait::async_trait]
    impl object_store::ObjectStore for SlowAbsentStore {
        async fn put_opts(
            &self,
            _location: &Path,
            _payload: object_store::PutPayload,
            _opts: object_store::PutOptions,
        ) -> object_store::Result<object_store::PutResult> {
            unimplemented!("reads only")
        }

        async fn put_multipart_opts(
            &self,
            _location: &Path,
            _opts: object_store::PutMultipartOptions,
        ) -> object_store::Result<Box<dyn object_store::MultipartUpload>> {
            unimplemented!("reads only")
        }

        async fn get_opts(
            &self,
            location: &Path,
            _options: object_store::GetOptions,
        ) -> object_store::Result<object_store::GetResult> {
            tokio::time::sleep(self.delay).await;
            Err(object_store::Error::NotFound {
                path: location.to_string(),
                source: "absent".to_string().into(),
            })
        }

        async fn delete(&self, _location: &Path) -> object_store::Result<()> {
            unimplemented!("reads only")
        }

        fn list(
            &self,
            _prefix: Option<&Path>,
        ) -> futures_util::stream::BoxStream<'static, object_store::Result<object_store::ObjectMeta>>
        {
            futures_util::stream::empty().boxed()
        }

        async fn list_with_delimiter(
            &self,
            _prefix: Option<&Path>,
        ) -> object_store::Result<object_store::ListResult> {
            unimplemented!("reads only")
        }

        async fn copy(&self, _from: &Path, _to: &Path) -> object_store::Result<()> {
            unimplemented!("reads only")
        }

        async fn copy_if_not_exists(&self, _from: &Path, _to: &Path) -> object_store::Result<()> {
            unimplemented!("reads only")
        }
    }

    /// #901's acceptance criterion, guarded at the seam that decides it: the
    /// chunk handler must charge each read to its own client. A client opening
    /// a large collection queues thousands of reads at once, and a second
    /// client arriving mid-open must not wait behind that whole backlog.
    ///
    /// This is a test about *who* the permit goes to, so it asserts on
    /// ordering rather than on a stopwatch: the newcomer's chunk must arrive
    /// while the backlog is still draining, and the wait is bounded by the
    /// handful of in-flight reads ahead of it, not by the backlog's length.
    #[tokio::test]
    async fn one_clients_backlog_does_not_delay_another_clients_chunk() {
        const READ_MS: u64 = 100;
        const PERMITS: usize = 2;
        const BACKLOG: usize = 200;

        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (busy_tx, mut busy_rx) = mpsc::unbounded_channel();
        let (newcomer_tx, mut newcomer_rx) = mpsc::unbounded_channel();
        routes.lock().await.insert(1, busy_tx);
        routes.lock().await.insert(2, newcomer_tx);

        let limiter = lucida_store::source_limiter::SourceReadLimiter::new(PERMITS);
        let store = Arc::new(SlowAbsentStore {
            delay: std::time::Duration::from_millis(READ_MS),
        }) as Arc<dyn object_store::ObjectStore>;
        let cache = Arc::new(CachedStore::with_source_limiter(
            store,
            1024 * 1024,
            limiter.clone(),
        ));

        // Client 1 opens something large: a backlog of distinct chunks, all
        // wanted at once.
        for index in 0..BACKLOG {
            let cache = cache.clone();
            let routes = routes.clone();
            tokio::spawn(async move {
                serve_chunk_from_store(
                    1,
                    &DatasetId("ds1".into()),
                    &ImageId("img1".into()),
                    "0/0/0/0/0/0",
                    Some(&format!("busy-{index}")),
                    Some(tiny_level_info()),
                    &cache,
                    &routes,
                )
                .await;
            });
        }
        // Let the backlog reach the limiter before the newcomer arrives, so
        // this really is the "second client shows up last" case.
        while limiter.queued_reads() < BACKLOG - PERMITS {
            tokio::task::yield_now().await;
        }

        // Client 2 arrives wanting one chunk.
        let newcomer = tokio::spawn({
            let cache = cache.clone();
            let routes = routes.clone();
            async move {
                serve_chunk_from_store(
                    2,
                    &DatasetId("ds1".into()),
                    &ImageId("img1".into()),
                    "0/0/0/0/0/0",
                    Some("newcomer"),
                    Some(tiny_level_info()),
                    &cache,
                    &routes,
                )
                .await;
            }
        });

        // The fair answer is one permit turnaround; the budget is ten, which
        // is generous against a loaded machine and still an order of magnitude
        // under the 10 s (BACKLOG / PERMITS * READ_MS) that draining client 1's
        // backlog first would cost.
        tokio::time::timeout(std::time::Duration::from_millis(READ_MS * 10), newcomer)
            .await
            .expect("the newcomer waited behind the whole backlog")
            .expect("the newcomer's task ran");

        assert!(
            newcomer_rx.recv().await.is_some(),
            "the newcomer received its chunk"
        );

        // And the backlog really was still backed up — otherwise the test
        // would pass for the wrong reason.
        let mut delivered = 0;
        while busy_rx.try_recv().is_ok() {
            delivered += 1;
        }
        assert!(
            delivered < BACKLOG,
            "client 1's backlog had already drained ({delivered}/{BACKLOG}), so the \
             newcomer never actually had to be let in ahead of it"
        );
    }
}
