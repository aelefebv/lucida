use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, Stream, StreamExt};
use lucida_content::url::DatasetLocation;
use lucida_content::{ChunkKey, DatasetId, DatasetManifest, ImageId};
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{
    ChunkMessage, ClientId, ClientMessage, CommandRejection, MessageRejection, PeerIdentity,
    ServerMessage,
};
use lucida_protocol::codec::{BytesCodec, ChunkPlanes, ChunkRelayReport, CodecSet};
use lucida_protocol::{
    ChunkFailureKind, DatasetGeneratedCoarseCacheStats, DatasetGeneratedCoarseFailure,
    DatasetGeneratedCoarseHealth, DatasetHealthComponent, DatasetHealthStatus,
    DatasetImportWarning, DatasetOpenFailureDiagnostic, DatasetOpenFailureKind,
    DatasetOpenProgressDiagnostic, DatasetOpenStage, DatasetOpenSuccessDiagnostic, DatasetOpened,
    DatasetSourceCacheStats, DatasetSourceHealth, GeneratedAvailabilitySnapshot,
    GeneratedChunkStatus, ServerPhase, TimingRowFamily, TimingRowOutcome,
};
use lucida_store::cache::CachedStore;
use lucida_store::source_limiter::{ReaderId, RequestLabel};
use tokio::sync::{broadcast, mpsc};

use crate::binding::ChunkResolver;
use crate::chunk_read::{ChunkRead, ChunkReadError, fetch_chunk};
use crate::chunk_serves::ChunkServes;
use crate::connection::{ClientSender, CloseSignal, client_queue};
use crate::dataset_open::{self, DatasetOpenContext, DatasetOpenOutcome, WorkspaceScope};
use crate::decode_pool::DecodePool;
use crate::generated::{
    DerivedCacheStorage, DerivedCacheTelemetry, DerivedChunkCache, DerivedChunkLookup,
    GeneratedCoarseService,
};
use crate::inbox::{self, InboxStore, Report as InboxReport};
use crate::link_throttle;
use crate::open_diagnostics::{
    backend_kind_for_url, location_failure, open_failure, open_progress,
};
use crate::session::Session;
use crate::timing::{FLUSH_INTERVAL, MetadataReadSink, RequestProbe, TimingBuffer};
use crate::wire_chunk::{PRODUCED_CODEC, PlaneCut, compress_produced};
use crate::workspace::{CommandApplyError, LiveWorkspace, WorkspaceError, WorkspaceManager};
use crate::{BroadcastItem, GeneratedConfig, UnicastRoutes};

/// Serve one workspace socket until it closes.
pub async fn handle_workspace_client(
    id: ClientId,
    ws: WebSocket,
    live: Arc<LiveWorkspace>,
    manager: Arc<WorkspaceManager>,
    principal: AuthPrincipal,
    relay_chunks: bool,
) {
    let generated_config = manager.generated_config();
    handle_client_inner(
        id,
        ws,
        generated_config,
        WorkspaceScope {
            live,
            manager,
            principal,
        },
        relay_chunks,
    )
    .await;
}

/// Tell `sender` its document command was refused.
fn reject_command(
    tx: &broadcast::Sender<BroadcastItem>,
    sender: ClientId,
    reason: CommandRejection,
) {
    let msg = ServerMessage::CommandRejected { reason };
    let _ = tx.send(BroadcastItem::CommandRejected {
        sender,
        json: serde_json::to_string(&msg).unwrap(),
    });
}

fn rename_rejection(error: &WorkspaceError) -> CommandRejection {
    match error {
        WorkspaceError::Forbidden => CommandRejection::Forbidden,
        WorkspaceError::NotFound | WorkspaceError::Archived | WorkspaceError::BadRequest(_) => {
            CommandRejection::Invalid
        }
        WorkspaceError::Store(_) => CommandRejection::Unavailable,
    }
}

async fn handle_client_inner(
    id: ClientId,
    ws: WebSocket,
    generated_config: GeneratedConfig,
    ctx: WorkspaceScope,
    relay_chunks: bool,
) {
    let session = Arc::clone(&ctx.live.session);
    let tx = ctx.live.tx.clone();
    let unicast_routes = Arc::clone(&ctx.live.unicast_routes);
    let (ws_tx, ws_rx) = ws.split();
    let (mut ws_tx, link_writer) = link_throttle::outbound(ws_tx);
    let mut ws_rx = link_throttle::inbound(ws_rx);

    // Per-client unicast queue for targeted messages (chunk routing). It
    // also carries the close signal anything in the server can raise.
    let (unicast_tx, mut unicast_rx) = client_queue();
    let mut outbound_close = unicast_tx.close_signal();
    let mut inbound_close = unicast_tx.close_signal();
    unicast_routes.lock().await.insert(id, unicast_tx.clone());
    ctx.manager
        .attach_connection(&ctx.live, id, &ctx.principal, unicast_tx.clone())
        .await;

    // This connection's server-side lifecycle rows. Scoped to the connection
    // rather than the process, so a client can only ever be handed rows its
    // own requests produced — no queue depth, no peer rates, no
    // peer dataset identities.
    let timings = Arc::new(TimingBuffer::new());
    let chunk_serves = ChunkServes::new();
    // What this connection said it decodes, so a chunk can reach it still
    // encoded. Nothing until it says, and nothing at all when the relay
    // policy keeps this connection's chunks decoded.
    let mut chunk_codecs = CodecSet::default();
    let chunk_relay = ChunkRelayReport {
        setting: ctx.manager.runtime_config().chunk_relay,
        relays: relay_chunks,
    };

    // Presentational identity for this peer's cursor, authored server-side
    // from the authenticated principal so it cannot be spoofed.
    //
    // The raw email is never broadcast, since collaborator emails are
    // owner-only. Only the name, avatar, and a single-grapheme initial
    // cross the wire.
    let identity = PeerIdentity::from_principal_parts(
        ctx.principal.display_name.clone(),
        ctx.principal.picture_url.clone(),
        &ctx.principal.email,
    );

    // Lock session, subscribe (before unlock — no gap), add client, snapshot, unlock.
    let (snapshot_json, mut rx, peer_joined_json) = {
        let mut sess = session.lock().await;
        let rx = tx.subscribe();
        let presence = sess.add_client(id, Some(identity));
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
        tracing::info!(client_id = %id, "ws.connection.snapshot_send_failed");
        let mut sess = session.lock().await;
        sess.remove_client(id);
        unicast_routes.lock().await.remove(&id);
        ctx.live.detach_connection(id);
        return;
    }

    // Broadcast PeerJoined to others.
    let _ = tx.send(BroadcastItem::PeerJoined {
        sender: id,
        json: peer_joined_json,
    });

    // Outbound: forward broadcast + unicast messages to this client, and
    // flush its buffered timing rows on the ticker.
    let outbound_session = Arc::clone(&session);
    let outbound_timings = Arc::clone(&timings);
    let mut outbound = tokio::spawn(async move {
        let mut flush_tick = tokio::time::interval(FLUSH_INTERVAL);
        // A tick missed while the socket was busy is not worth catching up
        // on: the next tick carries whatever accumulated meanwhile.
        flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            // A requested close goes out next, ahead of anything still
            // queued: the connection is ending, and the backlog may be why.
            if let Some(close) = outbound_close.current() {
                tracing::warn!(
                    client_id = %id,
                    code = close.frame.code,
                    reason = %close.frame.reason,
                    "ws.connection.closed_by_server"
                );
                if let Some(notice) = close.notice {
                    let _ = ws_tx.send(Message::Text(notice.into())).await;
                }
                let _ = ws_tx.send(Message::Close(Some(close.frame))).await;
                break;
            }
            tokio::select! {
                _ = outbound_close.requested() => continue,
                _ = flush_tick.tick() => {
                    if !flush_timings(&outbound_timings, &mut ws_tx).await {
                        break;
                    }
                }
                _ = outbound_timings.wait_for_early_flush() => {
                    if !flush_timings(&outbound_timings, &mut ws_tx).await {
                        break;
                    }
                }
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
                                BroadcastItem::CommandRejected { sender, json } => {
                                    if *sender != id { continue; }
                                    json
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
                            // This receiver overflowed and dropped `n`
                            // messages, possibly sequenced CommandBroadcasts,
                            // so push a fresh snapshot to repair the document.
                            //
                            // `recv()` has already moved past the loss, so
                            // every lost message was applied before this
                            // point and a snapshot taken under the session
                            // lock has `seq` >= all of them. The client's seq
                            // check drops retained items at or below it.
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
        // Behind a link throttle the last messages are still crossing it.
        drop(ws_tx);
        if let Some(writer) = link_writer {
            let _ = writer.await;
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
    while let Some(msg) = next_inbound(id, &mut ws_rx, &mut inbound_close).await {
        match msg {
            Message::Text(text) => {
                // Every offset a labelled request reports is relative to
                // here — the frame off the socket, before it is parsed or
                // routed. Routing tries each message shape in turn, and
                // under a burst of thousands of chunk requests that parse is
                // a real cost, so it sits inside the row rather than before
                // it (`ServerPhase::Arrival`).
                let arrival = Instant::now();
                let json = text.to_string();

                // Try as ClientMessage (new protocol).
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&json) {
                    match client_msg {
                        ClientMessage::Command { command } => {
                            // All commands in ClientMessage are DocumentCommands
                            // by construction — no runtime guard needed.
                            if matches!(command, DocumentCommand::DatasetOpened(_)) {
                                tracing::warn!(
                                    client_id = %id,
                                    workspace_id = %ctx.live.workspace_id,
                                    "workspace.command.rejected_client_dataset_opened"
                                );
                                reject_command(&tx, id, CommandRejection::Invalid);
                                continue;
                            }
                            // Authorization lives in WorkspaceManager:
                            // `rename_dataset` for a dataset rename,
                            // `apply_document_command` for everything
                            // else. The manager broadcasts what it applies;
                            // this loop tells the sender what it refused.
                            if let DocumentCommand::RenameDataset { id: ds_id, name } = &command {
                                match ctx
                                    .manager
                                    .rename_dataset(&ctx.live, &ctx.principal, id, ds_id, name)
                                    .await
                                {
                                    Ok(_) => {}
                                    Err(e) => {
                                        tracing::warn!(
                                            client_id = %id,
                                            workspace_id = %ctx.live.workspace_id,
                                            error = %e,
                                            "workspace.command.rename_dataset_rejected"
                                        );
                                        if !unicast_tx.close_requested() {
                                            reject_command(&tx, id, rename_rejection(&e));
                                        }
                                    }
                                }
                                continue;
                            }
                            match ctx
                                .manager
                                .apply_document_command(&ctx.live, &ctx.principal, id, command)
                                .await
                            {
                                Ok(_) => {}
                                Err(e @ CommandApplyError::Forbidden) => {
                                    tracing::warn!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        error = %e,
                                        "workspace.command.forbidden"
                                    );
                                    reject_command(&tx, id, CommandRejection::Forbidden);
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
                                    reject_command(&tx, id, CommandRejection::Unavailable);
                                }
                                Err(e @ CommandApplyError::PersistFailed(_)) => {
                                    tracing::error!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        error = %e,
                                        "workspace.command.persist_failed"
                                    );
                                    // A stale write closes this socket with the
                                    // refusal as its notice; once more would
                                    // only race the close.
                                    if !unicast_tx.close_requested() {
                                        reject_command(&tx, id, CommandRejection::Unavailable);
                                    }
                                }
                            }
                        }
                        ClientMessage::Presence {
                            camera,
                            view,
                            display,
                            views,
                        } => {
                            {
                                let mut sess = session.lock().await;
                                sess.update_presence(
                                    id,
                                    camera.clone(),
                                    view.clone(),
                                    display.clone(),
                                    views.clone(),
                                );
                            }
                            let update = ServerMessage::PresenceUpdate {
                                client_id: id,
                                camera,
                                view,
                                display,
                                views,
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
                            let generated_config_clone = generated_config.clone();
                            let scope = ctx.clone();
                            let timings_clone = Arc::clone(&timings);
                            let request = OpenRemoteDatasetRequest { request_id, url };
                            tokio::spawn(async move {
                                handle_open_remote_dataset(
                                    id,
                                    request,
                                    generated_config_clone,
                                    scope,
                                    timings_clone,
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
                                source_throttle: lucida_store::source_throttle::report(),
                                link_throttle: link_throttle::report(),
                                chunk_relay: Some(chunk_relay),
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
                            let generated_config_clone = generated_config.clone();
                            let scope = ctx.clone();
                            let timings_clone = Arc::clone(&timings);
                            let request = OpenRemoteDatasetRequest {
                                request_id,
                                url: source.canonical_url,
                            };
                            tokio::spawn(async move {
                                handle_open_remote_dataset(
                                    id,
                                    request,
                                    generated_config_clone,
                                    scope,
                                    timings_clone,
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
                                reject_message(
                                    id,
                                    Rejected {
                                        message_type: Some("request_snapshot".into()),
                                        ..Rejected::new(
                                            MessageRejection::Throttled,
                                            "a snapshot was sent under a second ago; ask again later",
                                        )
                                    },
                                    &unicast_routes,
                                )
                                .await;
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
                        ClientMessage::WatchSubscribe { history } => {
                            // Asked for history, the relay hands this
                            // connection the ring and its end marker before
                            // registering it, all under the session lock, so
                            // the recent past arrives ahead of the live items
                            // with no gap and no repeat.
                            let sender = unicast_routes.lock().await.get(&id).cloned();
                            let Some(sender) = sender else { continue };
                            let (replayed, subscribers) = {
                                let mut sess = session.lock().await;
                                let replayed = sess.watch.subscribe(id, sender, history);
                                (replayed, sess.watch.subscribers())
                            };
                            tracing::info!(
                                client_id = %id,
                                history,
                                replayed = replayed.len(),
                                from_seq = replayed.first().copied().unwrap_or(0),
                                subscribers,
                                "watch.subscribed"
                            );
                        }
                        ClientMessage::WatchPublish { item } => {
                            // Nothing here reads the item: the server relays a
                            // watch stream and computes nothing over it.
                            let mut sess = session.lock().await;
                            sess.watch.publish(id, item);
                        }
                        ClientMessage::SendReport { request_id, bundle } => {
                            // Somebody pressed **Send report**. Nothing else
                            // reaches this arm: no run closing, no schedule,
                            // and no other message produces one.
                            let Some(store) = ctx.manager.inbox() else {
                                send_report_failed(
                                    id,
                                    request_id,
                                    "this server keeps no inbox".to_string(),
                                    &unicast_routes,
                                )
                                .await;
                                continue;
                            };
                            // Off the inbound loop, as an open is: the
                            // bundle is megabytes and the write is a real
                            // one, and nothing else this client sends
                            // should queue behind somebody's report.
                            let workspace_id = ctx.live.workspace_id.clone();
                            let principal = ctx.principal.clone();
                            let unicast_routes_clone = Arc::clone(&unicast_routes);
                            tokio::spawn(async move {
                                store_report(
                                    id,
                                    request_id,
                                    &bundle,
                                    &workspace_id,
                                    &principal,
                                    store.as_ref(),
                                    &unicast_routes_clone,
                                )
                                .await;
                            });
                        }
                    }
                    continue;
                }

                // Try as ChunkMessage.
                if let Ok(chunk_msg) = serde_json::from_str::<ChunkMessage>(&json) {
                    match chunk_msg {
                        ChunkMessage::ChunkRequest {
                            rid,
                            dataset_id,
                            image_id,
                            key,
                            planes,
                            plane_axis,
                        } => {
                            let planes = planes.map(|range| ChunkPlanes {
                                axis: plane_axis,
                                range,
                            });
                            let mut probe = RequestProbe::arrived(
                                rid,
                                TimingRowFamily::Chunk,
                                arrival,
                                Arc::clone(&timings),
                            );
                            probe.mark(ServerPhase::Arrival);
                            let failed = SourceChunkFailure {
                                client_id: id,
                                dataset_id: &dataset_id,
                                image_id: &image_id,
                                key: &key,
                                client: &unicast_tx,
                            };
                            let chunk_key = match ChunkKey::parse(&key) {
                                Ok(chunk_key) => chunk_key,
                                Err(error) => {
                                    failed
                                        .send(ChunkFailureKind::MalformedKey, &error, probe)
                                        .await;
                                    continue;
                                }
                            };
                            let level = chunk_key.level;
                            // The lookup takes the shared session mutex, so
                            // every chunk request from every client in the
                            // workspace serialises here. It looks free and is
                            // not, which is why it earns a slot.
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
                                        ChunkDispatch::Source {
                                            resolver: Arc::clone(&b.resolver),
                                            cache: Arc::clone(&b.cache),
                                        }
                                    }
                                })
                            };
                            probe.mark(ServerPhase::BindingLookup);
                            match dispatch {
                                Some(ChunkDispatch::Source { resolver, cache }) => {
                                    let client = unicast_tx.clone();
                                    chunk_serves.spawn(rid, async move {
                                        serve_chunk_from_store(
                                            id,
                                            &dataset_id,
                                            &image_id,
                                            &chunk_key,
                                            planes,
                                            &resolver,
                                            &cache,
                                            &client,
                                            chunk_codecs,
                                            probe,
                                        )
                                        .await;
                                    });
                                }
                                // A generated chunk goes whole even when the
                                // request named planes, which it holds.
                                Some(ChunkDispatch::Generated {
                                    level,
                                    derived_chunks,
                                    generated_service,
                                }) => {
                                    let client = unicast_tx.clone();
                                    chunk_serves.spawn(rid, async move {
                                        generated_service
                                            .enqueue_chunk_request(id, &image_id, level, &key)
                                            .await;
                                        serve_generated_chunk_request(
                                            id,
                                            &dataset_id,
                                            &image_id,
                                            level,
                                            &key,
                                            &derived_chunks,
                                            &client,
                                            chunk_codecs,
                                            probe,
                                        )
                                        .await;
                                    });
                                }
                                // The phases past the lookup stay unset: the
                                // request never reached them.
                                None => {
                                    failed
                                        .send(
                                            ChunkFailureKind::UnknownDataset,
                                            &format!("this session holds no dataset {dataset_id}"),
                                            probe,
                                        )
                                        .await;
                                }
                            }
                        }
                        ChunkMessage::ChunkFetch { .. } => {
                            reject_message(
                                id,
                                Rejected {
                                    message_type: Some("chunk_fetch".into()),
                                    ..Rejected::new(
                                        MessageRejection::UnknownType,
                                        "only the server sends chunk_fetch",
                                    )
                                },
                                &unicast_routes,
                            )
                            .await;
                        }
                        ChunkMessage::ChunkCancel { rids } => {
                            let dropped = chunk_serves.cancel(&rids);
                            tracing::debug!(
                                client_id = %id,
                                cancelled = rids.len(),
                                dropped,
                                "ws.chunk_cancel"
                            );
                        }
                        ChunkMessage::ChunkCodecs { codecs } => {
                            tracing::debug!(
                                client_id = %id,
                                ?codecs,
                                relays = relay_chunks,
                                "ws.chunk_codecs"
                            );
                            if relay_chunks {
                                chunk_codecs = codecs.into_iter().collect();
                            }
                        }
                    }
                    continue;
                }

                let rejected = unparsed_rejection(&json);
                tracing::warn!(
                    client_id = %id,
                    reason = ?rejected.reason,
                    message_type = rejected.message_type.as_deref().unwrap_or(""),
                    error = %rejected.message,
                    "ws.inbound.rejected"
                );
                // A command the sender may have applied optimistically is
                // answered in order with its other commands' acks, so the
                // sender can tell which one this was and undo it.
                if rejected.message_type.as_deref() == Some("command") {
                    reject_command(&tx, id, CommandRejection::Invalid);
                } else {
                    reject_message(id, rejected, &unicast_routes).await;
                }
            }
            // Every client message is JSON text. Binary frames flow only
            // from the server, so one arriving here carries nothing to act
            // on.
            Message::Binary(_) => {
                reject_message(
                    id,
                    Rejected::new(
                        MessageRejection::BinaryFrame,
                        "the server reads only text messages",
                    ),
                    &unicast_routes,
                )
                .await;
            }
            _ => {}
        }
    }

    // Cleanup on disconnect. A close the server asked for is written by the
    // outbound task behind whatever the socket already holds, so give it a
    // bounded moment to get through. Inbound frames are read and dropped
    // meanwhile: a client blocked writing to us cannot read the close.
    //
    // Wait for the client's side to end as well, with its close reply or
    // its EOF. Dropping the socket while its frames are still unread makes
    // the OS reset the connection, and the reset can discard the close
    // frame before the client reads it.
    if unicast_tx.close_requested() {
        let drain = async { while let Some(Ok(_)) = ws_rx.next().await {} };
        let _ = tokio::time::timeout(CLOSE_FLUSH_TIMEOUT, async {
            let _ = tokio::join!(&mut outbound, drain);
        })
        .await;
    }
    outbound.abort();
    chunk_serves.cancel_all();
    unicast_routes.lock().await.remove(&id);
    ctx.live.detach_connection(id);
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
        // A subscriber's connection is its subscription: a returning watcher
        // subscribes again, and a publishing page's toggle is off after a
        // reconnect.
        sess.watch.unsubscribe(id);
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

    tracing::info!(client_id = %id, "ws.connection.closed");
}

/// How long a server-side close may take to reach the client before the
/// connection is torn down regardless. A client that has not read by then
/// sees the connection drop without the reason.
const CLOSE_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// The next frame the client sent, or `None` once the connection should end:
/// the client closed it, a read failed (an oversized message among them), or
/// the server asked to close it.
async fn next_inbound<S>(id: ClientId, ws_rx: &mut S, close: &mut CloseSignal) -> Option<Message>
where
    S: Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    tokio::select! {
        next = ws_rx.next() => match next {
            Some(Ok(msg)) => Some(msg),
            Some(Err(e)) => {
                tracing::info!(client_id = %id, error = %e, "ws.inbound.read_failed");
                None
            }
            None => None,
        },
        _ = close.requested() => None,
    }
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
    // A warning that says the data is shown wrong, such as an unwritten level
    // drawing black or tiles padded with fill, makes the dataset unhealthy
    // however well the server is serving it: reporting `healthy` over wrong
    // pixels is the mis-read this is here to prevent. Other import warnings
    // stay informational and leave the status alone.
    let mut import_status = DatasetHealthStatus::Healthy;
    let mut import_warnings = Vec::new();
    if let Some(binding) = binding {
        for warning in &binding.import_warnings {
            let degrades = warning.kind.degrades_health();
            if degrades {
                import_status = DatasetHealthStatus::Degraded;
            }
            messages.push(warning.message.clone());
            import_warnings.push(DatasetImportWarning {
                kind: warning.kind.into(),
                target: warning.target.clone(),
                message: warning.message.clone(),
                degrades,
            });
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
        import_warnings,
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
        absent_reads: stats.absent_reads,
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
/// a `Degraded` on either side.
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
#[allow(clippy::too_many_arguments)]
async fn handle_open_remote_dataset(
    client_id: ClientId,
    request: OpenRemoteDatasetRequest,
    generated_config: GeneratedConfig,
    workspace: WorkspaceScope,
    timings: Arc<TimingBuffer>,
) {
    let unicast_routes = Arc::clone(&workspace.live.unicast_routes);
    let OpenRemoteDatasetRequest { request_id, url } = request;
    // A location that does not parse is refused here, echoing the input as
    // given; past this point every envelope carries the canonical URL.
    let location = match DatasetLocation::parse(&url) {
        Ok(location) => location,
        Err(error) => {
            send_open_failed(
                client_id,
                &request_id,
                &url,
                location_failure(&error),
                &unicast_routes,
            )
            .await;
            return;
        }
    };
    let canonical_url = location.as_str().to_string();

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
        generated_config,
        source_policy: workspace.manager.source_policy(),
        workspace,
    };
    // Every metadata object this open reads files a row against the open's
    // own `request_id`, on the requesting connection's buffer. Scoped
    // around the whole orchestration rather than around the import alone:
    // the binding build probes the store too, and an open's cost is what
    // the open read, not what one of its steps read.
    //
    // Rows travel on the timing ticker as the reads happen, so an open that
    // *fails* still carries them — the case whose timing is most worth
    // having.
    let result = lucida_store::metadata_reads::observing(
        Arc::new(MetadataReadSink::new(&request_id, timings)),
        dataset_open::open_dataset(client_id, &location, &ctx, &progress_tx),
    )
    .await;
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

/// Send this connection's buffered timing rows, if any. Returns `false` when
/// the socket is gone, which ends the outbound loop exactly as a failed
/// broadcast send does.
///
/// Rows buffered for a connection that dies are discarded, never replayed:
/// replay would need retention across connections — the thing batching
/// deletes — and re-identification of a returning client. The browser knows
/// it reconnected, so the browser declares the gap.
async fn flush_timings<S>(buffer: &TimingBuffer, ws_tx: &mut S) -> bool
where
    S: SinkExt<Message> + Unpin,
{
    let Some(batch) = buffer.take_batch() else {
        return true;
    };
    let json = serde_json::to_string(&ServerMessage::TimingBatch { batch }).unwrap();
    ws_tx.send(Message::Text(json.into())).await.is_ok()
}

enum ChunkDispatch {
    Source {
        resolver: Arc<ChunkResolver>,
        cache: Arc<CachedStore>,
    },
    Generated {
        level: u32,
        derived_chunks: Arc<DerivedChunkCache>,
        generated_service: Arc<GeneratedCoarseService>,
    },
}

/// Every exit files the probe's row. An absent chunk is delivered as fill
/// like any other chunk; every failure reaches the client as a status frame.
///
/// `planes`, when the request named them, are sent in place of the whole
/// chunk. The stored chunk is read and decoded whole either way, since a
/// stored chunk's codecs cover all of it.
// Internal helper threading per-request state from the dispatch site;
// extracting a struct would just push the bundle one frame up.
#[allow(clippy::too_many_arguments)]
async fn serve_chunk_from_store(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &ChunkKey,
    planes: Option<ChunkPlanes>,
    resolver: &ChunkResolver,
    cache: &CachedStore,
    client: &ClientSender,
    codecs: CodecSet,
    mut probe: RequestProbe,
) {
    let fail = |error: ChunkReadError, probe: RequestProbe| async move {
        SourceChunkFailure {
            client_id,
            dataset_id,
            image_id,
            key: &chunk_key.to_string(),
            client,
        }
        .send(error.failure_kind(), &error, probe)
        .await;
    };
    // Charged to the requesting client, so one client's collection-sized
    // backlog cannot delay another client's first chunk, and labelled
    // with the request, so a wait behind the source-read cap is attributable
    // to it rather than only to a client.
    let fetched = match fetch_chunk(
        resolver,
        cache,
        image_id,
        chunk_key,
        ReaderId(client_id),
        RequestLabel(probe.rid()),
        Some(&mut probe),
    )
    .await
    {
        Ok(fetched) => fetched,
        Err(error) => return fail(error, probe).await,
    };

    // Decoding and framing are CPU work. On an async worker, a burst of them
    // holds up every other task on the runtime, other requests' dispatch
    // among them, so they wait for a decode thread instead. The frame is
    // queued from there too, so the client's bytes never wait for this task
    // to be polled again.
    let cut = planes
        .and_then(|planes| PlaneCut::new(planes, resolver.chunk_dims(image_id, chunk_key.level)?));
    let (dataset, image, key, client_queue) = (
        dataset_id.clone(),
        image_id.clone(),
        *chunk_key,
        client.clone(),
    );
    let failed = DecodePool::global()
        .run(ReaderId(client_id), move || {
            // The wait ends when a decode thread takes the work, so starting
            // that thread counts as waiting rather than as decompression.
            probe.mark(ServerPhase::DecodeWait);
            let buf = if let Some(cut) = cut {
                match fetched.decode(Some(&mut probe)) {
                    Ok(read) => plane_frame(client_id, &dataset, &image, key, codecs, cut, read),
                    Err(error) => return Some((error, probe)),
                }
            } else if let Some((stored, chain)) = fetched.relayable(codecs) {
                encode_chunk_frame(client_id, &dataset, &image, key, None, chain, stored)
            } else {
                match fetched.decode(Some(&mut probe)) {
                    Ok(ChunkRead::Present(bytes)) => {
                        encode_chunk_frame(client_id, &dataset, &image, key, None, &[], &bytes)
                    }
                    // An absent chunk's fill is the server's own making, so
                    // it crosses the link as a generated chunk does.
                    Ok(absent) => produced_frame(
                        client_id,
                        &dataset,
                        &image,
                        key,
                        None,
                        codecs,
                        &absent.into_bytes(),
                    ),
                    Err(error) => return Some((error, probe)),
                }
            };
            probe.mark(ServerPhase::SliceEncode);
            hand_off(&client_queue, buf, probe);
            None
        })
        .await;
    if let Some((error, probe)) = failed {
        fail(error, probe).await;
    }
}

/// Queue a chunk frame for its client and file the row as delivered.
fn hand_off(client: &ClientSender, frame: Vec<u8>, mut probe: RequestProbe) {
    let _ = client.send(Message::Binary(frame.into()));
    // Handoff is terminal: the socket write happens in another task behind
    // an unbounded queue and is not observable from here.
    probe.mark(ServerPhase::Handoff);
    probe.finish(TimingRowOutcome::Delivered);
}

// Internal helper threading per-request state from the dispatch site.
#[allow(clippy::too_many_arguments)]
async fn serve_generated_chunk_request(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    level: u32,
    chunk_key: &str,
    derived_chunks: &Arc<DerivedChunkCache>,
    client: &ClientSender,
    codecs: CodecSet,
    mut probe: RequestProbe,
) {
    // A generated chunk never touches the source store, so its permit,
    // read and decompress slots stay unset rather than reading as zero.
    probe.mark(ServerPhase::Dispatch);
    let lookup = derived_chunks.lookup(image_id, level, chunk_key);
    probe.mark(ServerPhase::CacheLookup);
    match lookup {
        DerivedChunkLookup::Ready(bytes) => {
            // Framing copies the whole chunk, so it takes a decode thread as
            // a source chunk's does.
            let (dataset, image, key, client_queue) = (
                dataset_id.clone(),
                image_id.clone(),
                chunk_key.to_string(),
                client.clone(),
            );
            DecodePool::global()
                .run(ReaderId(client_id), move || {
                    probe.mark(ServerPhase::DecodeWait);
                    let buf =
                        produced_frame(client_id, &dataset, &image, key, None, codecs, &bytes);
                    probe.mark(ServerPhase::SliceEncode);
                    hand_off(&client_queue, buf, probe);
                })
                .await;
        }
        DerivedChunkLookup::Status { status, message } => {
            send_generated_chunk_status(dataset_id, image_id, chunk_key, status, message, client);
            // The row ends honestly and no chunk ever arrives, so this
            // label's browser row terminates without a delivery. `NotReady`
            // is what stops a reader charging that open bracket to the
            // server as a stall.
            probe.mark(ServerPhase::Handoff);
            probe.finish(TimingRowOutcome::NotReady);
        }
    }
}

/// The source chunk request a failure answers.
struct SourceChunkFailure<'a> {
    client_id: ClientId,
    dataset_id: &'a DatasetId,
    image_id: &'a ImageId,
    /// The key as the request spelled it, which is what the client matches
    /// the reply against.
    key: &'a str,
    client: &'a ClientSender,
}

impl SourceChunkFailure<'_> {
    /// Log the failure, send the requester its status frame, and file the
    /// row. A request that ends without bytes always ends here: from the
    /// client's side the alternative is a timeout, which it has to treat as
    /// transient, so a failure that will repeat would never surface.
    ///
    /// The frame is TEXT, while served bytes always travel as binary chunk
    /// frames.
    async fn send(
        self,
        kind: ChunkFailureKind,
        error: &(dyn std::fmt::Display + Sync),
        mut probe: RequestProbe,
    ) {
        let status = kind.status();
        tracing::warn!(
            client_id = %self.client_id,
            dataset = %self.dataset_id,
            image = %self.image_id,
            chunk_key = %self.key,
            kind = ?kind,
            status = ?status,
            error = %error,
            "chunk.request.failed"
        );
        let msg = ServerMessage::SourceChunkStatus {
            dataset_id: self.dataset_id.clone(),
            image_id: self.image_id.clone(),
            key: self.key.to_string(),
            status,
            kind: Some(kind),
            message: Some(error.to_string()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let _ = self.client.send(Message::Text(json.into()));
        probe.mark(ServerPhase::Handoff);
        probe.finish(TimingRowOutcome::Failed);
    }
}

/// What a [`ServerMessage::MessageRejected`] says, before it is sent.
struct Rejected {
    request_id: Option<String>,
    rid: Option<u32>,
    message_type: Option<String>,
    reason: MessageRejection,
    message: String,
}

impl Rejected {
    fn new(reason: MessageRejection, message: impl Into<String>) -> Self {
        Rejected {
            request_id: None,
            rid: None,
            message_type: None,
            reason,
            message: message.into(),
        }
    }

    fn into_message(self) -> ServerMessage {
        ServerMessage::MessageRejected {
            request_id: self.request_id,
            rid: self.rid,
            message_type: self.message_type,
            reason: self.reason,
            message: self.message,
        }
    }
}

/// Tell a client the server did not act on a message it sent.
async fn reject_message(client_id: ClientId, rejected: Rejected, unicast_routes: &UnicastRoutes) {
    send_to_client(client_id, rejected.into_message(), unicast_routes).await;
}

/// Why a text message matched no message the server reads, with whatever
/// identifiers could still be read off it so the client can match the reply
/// to what it sent.
fn unparsed_rejection(json: &str) -> Rejected {
    let Ok(serde_json::Value::Object(fields)) = serde_json::from_str::<serde_json::Value>(json)
    else {
        return Rejected::new(
            MessageRejection::Malformed,
            "the message is not a JSON object",
        );
    };
    let message_type = fields
        .get("type")
        .and_then(|t| t.as_str())
        .map(str::to_string);
    let (reason, message) = match message_type.as_deref() {
        None => (
            MessageRejection::Malformed,
            "the message has no type".to_string(),
        ),
        Some(t) if CLIENT_MESSAGE_TYPES.contains(&t) => (
            MessageRejection::Malformed,
            format!("the {t} message does not have the fields its type requires"),
        ),
        Some(t) => (
            MessageRejection::UnknownType,
            format!("the server does not read messages of type {t:?}"),
        ),
    };
    Rejected {
        request_id: fields
            .get("request_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        rid: fields
            .get("rid")
            .and_then(|v| v.as_u64())
            .and_then(|rid| u32::try_from(rid).ok()),
        message_type,
        reason,
        message,
    }
}

/// The `type` of every message a client sends, so a known type with bad
/// fields reads as malformed rather than unknown.
const CLIENT_MESSAGE_TYPES: &[&str] = &[
    "command",
    "presence",
    "cursor",
    "follow",
    "steer",
    "open_remote_dataset",
    "dataset_health",
    "dataset_retry",
    "viewer_interest",
    "request_snapshot",
    "dataset_presence",
    "watch_subscribe",
    "watch_publish",
    "send_report",
    "chunk_request",
    "chunk_fetch",
    "chunk_cancel",
    "chunk_codecs",
];

fn send_generated_chunk_status(
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    status: GeneratedChunkStatus,
    message: Option<String>,
    client: &ClientSender,
) {
    let msg = ServerMessage::GeneratedChunkStatus {
        dataset_id: dataset_id.clone(),
        image_id: image_id.clone(),
        key: chunk_key.to_string(),
        status,
        message,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let _ = client.send(Message::Text(json.into()));
}

/// A frame for bytes the server made itself, a generated chunk, an absent
/// chunk's fill or planes cut from a chunk, compressed for a client that
/// decodes [`PRODUCED_CODEC`] when that saves enough.
fn produced_frame(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: impl std::fmt::Display,
    planes: Option<ChunkPlanes>,
    codecs: CodecSet,
    bytes: &[u8],
) -> Vec<u8> {
    match compress_produced(codecs, bytes) {
        Some(compressed) => encode_chunk_frame(
            client_id,
            dataset_id,
            image_id,
            chunk_key,
            planes,
            &[PRODUCED_CODEC],
            &compressed,
        ),
        None => encode_chunk_frame(
            client_id,
            dataset_id,
            image_id,
            chunk_key,
            planes,
            &[],
            bytes,
        ),
    }
}

/// A frame for the planes `cut` takes of a decoded chunk. The stored codecs
/// cover the whole chunk, so planes cross the link as bytes the server made.
/// A chunk that does not split into its planes goes whole, as it would have.
fn plane_frame(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: ChunkKey,
    codecs: CodecSet,
    cut: PlaneCut,
    read: ChunkRead,
) -> Vec<u8> {
    let frame = |planes, bytes: &[u8]| {
        produced_frame(
            client_id, dataset_id, image_id, chunk_key, planes, codecs, bytes,
        )
    };
    match read {
        ChunkRead::Present(bytes) => match cut.cut(&bytes) {
            Some(planes) => frame(Some(cut.planes()), &planes),
            None => encode_chunk_frame(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                None,
                &[],
                &bytes,
            ),
        },
        ChunkRead::Absent { len, fill } => match cut.len_of(len) {
            Some(planes_len) => frame(Some(cut.planes()), &fill.bytes(planes_len)),
            None => frame(None, &fill.bytes(len)),
        },
    }
}

/// A chunk frame for `bytes`, still in `codecs` when there are any and some
/// planes of the chunk when `planes` names them; see
/// [`lucida_protocol::codec::encode_chunk_frame`] for the layout.
fn encode_chunk_frame(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: impl std::fmt::Display,
    planes: Option<ChunkPlanes>,
    codecs: &[BytesCodec],
    bytes: &[u8],
) -> Vec<u8> {
    let composite_key = format!("{dataset_id}/{image_id}/{chunk_key}");
    lucida_protocol::codec::encode_chunk_frame(
        client_id as u32,
        &composite_key,
        planes,
        codecs,
        bytes,
    )
}

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

/// Put one **Send report**'s bundle in the workspace inbox and tell the
/// sender where it landed, or why nothing was kept.
///
/// The sender always hears back. A report that silently went nowhere is
/// the one outcome this action must not have: whoever pressed it is
/// about to tell somebody the report is there.
async fn store_report(
    client_id: ClientId,
    request_id: String,
    bundle: &str,
    workspace_id: &str,
    principal: &AuthPrincipal,
    store: &dyn InboxStore,
    unicast_routes: &UnicastRoutes,
) {
    let report = InboxReport {
        workspace_id,
        sender_email: &principal.email,
        sender_name: &principal.display_name,
        // The text as it arrived. The inbox stores these bytes, so what
        // the CLI fetches is what the page produced.
        bundle_json: bundle,
        now: chrono::Utc::now(),
    };
    match inbox::receive(store, report).await {
        Ok(entry) => {
            tracing::info!(
                client_id = %client_id,
                request_id = %request_id,
                workspace_id = %workspace_id,
                entry_id = %entry.id,
                size_bytes = entry.size_bytes,
                "inbox.report_stored"
            );
            let expires_at = entry
                .expires_at
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            send_to_client(
                client_id,
                ServerMessage::ReportSent {
                    request_id,
                    entry_id: entry.id,
                    expires_at,
                },
                unicast_routes,
            )
            .await;
        }
        Err(error) => {
            send_report_failed(client_id, request_id, error.to_string(), unicast_routes).await;
        }
    }
}

/// Tell the sender nothing was kept, and why, in the sentence the
/// monitor shows under the action.
async fn send_report_failed(
    client_id: ClientId,
    request_id: String,
    error: String,
    unicast_routes: &UnicastRoutes,
) {
    tracing::warn!(
        client_id = %client_id,
        request_id = %request_id,
        error = %error,
        "inbox.report_failed"
    );
    send_to_client(
        client_id,
        ServerMessage::ReportFailed { request_id, error },
        unicast_routes,
    )
    .await;
}

/// Send one message to one client's own connection.
async fn send_to_client(
    client_id: ClientId,
    message: ServerMessage,
    unicast_routes: &UnicastRoutes,
) {
    let json = serde_json::to_string(&message).unwrap();
    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send(Message::Text(json.into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A probe wired to a buffer the test can read back, so what a serve path
    /// *declares* about its own outcome is asserted rather than assumed.
    fn test_probe(rid: u32, buffer: &Arc<TimingBuffer>) -> RequestProbe {
        RequestProbe::arrived(
            rid,
            TimingRowFamily::Chunk,
            Instant::now(),
            Arc::clone(buffer),
        )
    }

    /// A socket that is already gone: every send fails, as one to a closed
    /// connection does.
    struct DeadSocket;

    impl futures_util::Sink<Message> for DeadSocket {
        type Error = ();

        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Err(()))
        }

        fn start_send(self: std::pin::Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            Err(())
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Err(()))
        }

        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Err(()))
        }
    }

    fn chunk_row(rid: u32) -> crate::timing::ServedRow {
        let mut phases = [lucida_protocol::PHASE_UNSET; lucida_protocol::SERVER_PHASES.len()];
        phases[0] = 5;
        crate::timing::ServedRow {
            key: crate::timing::RowKey::Label(rid),
            family: TimingRowFamily::Chunk,
            outcome: TimingRowOutcome::Delivered,
            phases,
            backend_bytes: None,
            coalesced_onto: lucida_protocol::LABEL_NONE,
            dispatch_offset_us: 0,
            duration_us: 0,
            metadata_phase: None,
        }
    }

    /// The outcome of the one row a serve filed.
    fn sole_outcome(buffer: &TimingBuffer) -> TimingRowOutcome {
        let batch = buffer.take_batch().expect("the serve filed a row");
        assert_eq!(batch.len(), 1, "one served request is one row");
        batch.outcome[0]
    }

    #[tokio::test]
    async fn a_flush_sends_one_columnar_message_and_a_quiet_tick_sends_nothing() {
        let buffer = TimingBuffer::new();
        let mut socket: Vec<Message> = Vec::new();

        assert!(flush_timings(&buffer, &mut socket).await);
        assert!(socket.is_empty(), "an empty tick puts nothing on the wire");

        let mut phases = [lucida_protocol::PHASE_UNSET; lucida_protocol::SERVER_PHASES.len()];
        phases[0] = 5;
        buffer.record(crate::timing::ServedRow {
            key: crate::timing::RowKey::Label(41),
            family: TimingRowFamily::Chunk,
            outcome: TimingRowOutcome::Delivered,
            phases,
            backend_bytes: None,
            coalesced_onto: lucida_protocol::LABEL_NONE,
            dispatch_offset_us: 0,
            duration_us: 0,
            metadata_phase: None,
        });

        assert!(flush_timings(&buffer, &mut socket).await);
        assert_eq!(socket.len(), 1, "a flush window is one message");
        let Message::Text(json) = &socket[0] else {
            panic!("timing batches travel as text");
        };
        let parsed: ServerMessage = serde_json::from_str(json).unwrap();
        let ServerMessage::TimingBatch { batch } = parsed else {
            panic!("expected a timing batch");
        };
        assert_eq!(batch.rid, vec![41]);
        assert_eq!(batch.arrival_us, vec![5]);
    }

    #[tokio::test]
    async fn rows_buffered_for_a_dead_connection_are_discarded_never_replayed() {
        let buffer = TimingBuffer::new();
        buffer.record(chunk_row(41));

        assert!(
            !flush_timings(&buffer, &mut DeadSocket).await,
            "a dead socket ends the outbound loop"
        );
        // Replay would need retention across connections and re-identification
        // of a returning client. The browser declares the gap instead.
        assert!(
            buffer.take_batch().is_none(),
            "the rows went with the connection rather than waiting for the next one"
        );
    }

    /// Health is a worst-of fold, and no component may be lost to argument
    /// order: `combine(Degraded, Healthy)` must answer `Degraded`.
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
    use crate::test_fixtures::{
        FailingStore, StoreFailure, four_byte_level, image_seed, single_image_manifest,
    };
    use object_store::path::Path;

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
        // A store failure — including the editor gate's role lookup
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
            absent_reads: 3,
            coalesced: 5,
            source_reads: 8,
            source_read_millis: 2_400,
        });

        assert_eq!(stats.used_percent, 92);
        assert_eq!(stats.backend_errors, 1);
        assert_eq!(stats.absent_reads, 3);
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
            histograms: vec![],
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

    #[test]
    fn encode_chunk_frame_uses_normal_chunk_key_envelope() {
        let dataset_id = DatasetId("ds1".into());
        let image_id = ImageId("img1".into());
        let buf = encode_chunk_frame(
            9,
            &dataset_id,
            &image_id,
            "2/0/0/0/0/0",
            None,
            &[],
            &[1, 2, 3],
        );

        let client_id = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        assert_eq!(client_id, 9);
        let key_len = u16::from_le_bytes(buf[4..6].try_into().unwrap()) as usize;
        let key = std::str::from_utf8(&buf[6..6 + key_len]).unwrap();
        assert_eq!(key, "ds1/img1/2/0/0/0/0/0");
        assert_eq!(&buf[6 + key_len..], &[1, 2, 3]);
    }

    #[tokio::test]
    async fn missing_source_chunk_is_served_as_zero_fill() {
        let (tx, mut rx) = client_queue();
        let store =
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let cache = Arc::new(CachedStore::new(store, 1024));

        let timings = Arc::new(TimingBuffer::new());
        serve_chunk_from_store(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            &key("0/0/0/0/0/0"),
            None,
            &tiny_resolver(),
            &cache,
            &tx,
            CodecSet::default(),
            test_probe(1, &timings),
        )
        .await;

        assert_eq!(
            sole_outcome(&timings),
            TimingRowOutcome::Delivered,
            "a zero-filled sparse chunk is a delivery, not a failure"
        );

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

    /// Serve one key of `image` from `store` and return the single text
    /// frame the requesting client received, after checking the row failed.
    async fn serve_and_expect_status(
        image: &str,
        key: &str,
        resolver: &ChunkResolver,
        store: Arc<dyn object_store::ObjectStore>,
    ) -> serde_json::Value {
        let (tx, mut rx) = client_queue();
        let cache = Arc::new(CachedStore::new(store, 1024));

        let timings = Arc::new(TimingBuffer::new());
        serve_chunk_from_store(
            7,
            &DatasetId("ds1".into()),
            &ImageId(image.into()),
            &self::key(key),
            None,
            resolver,
            &cache,
            &tx,
            CodecSet::default(),
            test_probe(1, &timings),
        )
        .await;

        assert_eq!(sole_outcome(&timings), TimingRowOutcome::Failed);
        let msg = rx.recv().await.expect("status frame");
        let Message::Text(json) = msg else {
            panic!("expected text status frame");
        };
        assert!(rx.try_recv().is_err(), "the status must be the only frame");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "source_chunk_status");
        assert_eq!(value["key"], key);
        value
    }

    /// An in-memory store holding `bytes` where `key` of the tiny resolver's
    /// image lives.
    async fn store_with(
        resolver: &ChunkResolver,
        key: &str,
        bytes: &'static [u8],
    ) -> Arc<dyn object_store::ObjectStore> {
        let store = object_store::memory::InMemory::new();
        let location = resolver
            .resolve(&ImageId("img1".into()), &self::key(key))
            .unwrap();
        object_store::ObjectStoreExt::put(
            &store,
            location.path(),
            object_store::PutPayload::from_static(bytes),
        )
        .await
        .unwrap();
        Arc::new(store)
    }

    #[tokio::test]
    async fn unknown_image_sends_a_permanent_status() {
        let value = serve_and_expect_status(
            "not-bound",
            "0/0/0/0/0/0",
            &tiny_resolver(),
            Arc::new(object_store::memory::InMemory::new()),
        )
        .await;
        assert_eq!(value["kind"], "unknown_image");
        assert_eq!(value["status"], "failed_permanent");
    }

    #[tokio::test]
    async fn unknown_level_sends_a_permanent_status() {
        let value = serve_and_expect_status(
            "img1",
            "3/0/0/0/0/0",
            &tiny_resolver(),
            Arc::new(object_store::memory::InMemory::new()),
        )
        .await;
        assert_eq!(value["kind"], "unknown_level");
        assert_eq!(value["status"], "failed_permanent");
    }

    #[tokio::test]
    async fn corrupt_chunk_sends_a_permanent_status() {
        let mut level = four_byte_level();
        level.compression =
            crate::decode::StorageCompression::compressed(lucida_store::codec::BytesCodec::Lz4, 2);
        let resolver = ChunkResolver::new(&image_seed("img1", vec![level]));
        let store = store_with(&resolver, "0/0/0/0/0/0", &[4, 0, 0, 0, 0xff, 0xff]).await;

        let value = serve_and_expect_status("img1", "0/0/0/0/0/0", &resolver, store).await;
        assert_eq!(value["kind"], "corrupt_chunk");
        assert_eq!(value["status"], "failed_permanent");
        assert!(value["message"].as_str().unwrap().contains("lz4"));
    }

    #[tokio::test]
    async fn wrong_size_chunk_sends_a_permanent_status() {
        let resolver = tiny_resolver();
        let store = store_with(&resolver, "0/0/0/0/0/0", &[1, 2]).await;

        let value = serve_and_expect_status("img1", "0/0/0/0/0/0", &resolver, store).await;
        assert_eq!(value["kind"], "wrong_size");
        assert_eq!(value["status"], "failed_permanent");
    }

    #[test]
    fn a_message_that_matches_nothing_is_rejected_with_what_could_be_read() {
        let not_json = unparsed_rejection("not json");
        assert_eq!(not_json.reason, MessageRejection::Malformed);
        assert_eq!(not_json.message_type, None);

        let unknown = unparsed_rejection(r#"{"type":"frobnicate","request_id":"r-1"}"#);
        assert_eq!(unknown.reason, MessageRejection::UnknownType);
        assert_eq!(unknown.message_type.as_deref(), Some("frobnicate"));
        assert_eq!(unknown.request_id.as_deref(), Some("r-1"));

        let bad_fields = unparsed_rejection(r#"{"type":"chunk_request","rid":9,"key":"0/0"}"#);
        assert_eq!(bad_fields.reason, MessageRejection::Malformed);
        assert_eq!(bad_fields.message_type.as_deref(), Some("chunk_request"));
        assert_eq!(bad_fields.rid, Some(9));

        let untyped = unparsed_rejection(r#"{"request_id":"r-2"}"#);
        assert_eq!(untyped.reason, MessageRejection::Malformed);
        assert_eq!(untyped.request_id.as_deref(), Some("r-2"));
    }

    /// The list that tells a malformed message from an unknown type holds
    /// every type a client sends: each client fixture's type is in it.
    #[test]
    fn every_client_message_type_is_known_to_the_rejection() {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../wire-fixtures/session");
        let mut seen = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            let text = std::fs::read_to_string(&path).unwrap();
            let is_client = serde_json::from_str::<ClientMessage>(&text).is_ok()
                || serde_json::from_str::<ChunkMessage>(&text).is_ok();
            if !is_client {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            let message_type = value["type"].as_str().unwrap().to_string();
            assert!(
                CLIENT_MESSAGE_TYPES.contains(&message_type.as_str()),
                "{} has type {message_type}, which the rejection reads as unknown",
                path.display()
            );
            seen.insert(message_type);
        }
        assert!(
            seen.len() >= 15,
            "only {} client types in the fixtures",
            seen.len()
        );
    }

    fn tiny_resolver() -> ChunkResolver {
        ChunkResolver::new(&image_seed("img1", vec![four_byte_level()]))
    }

    fn key(key: &str) -> ChunkKey {
        ChunkKey::parse(key).unwrap()
    }

    /// Drive `serve_chunk_from_store` against a [`FailingStore`] and return
    /// the single frame the requesting client received.
    async fn serve_against_failing_store(failure: StoreFailure) -> serde_json::Value {
        let (tx, mut rx) = client_queue();
        let store = Arc::new(FailingStore(failure)) as Arc<dyn object_store::ObjectStore>;
        let cache = Arc::new(CachedStore::new(store, 1024));

        let timings = Arc::new(TimingBuffer::new());
        serve_chunk_from_store(
            7,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            &key("0/0/0/0/0/0"),
            None,
            &tiny_resolver(),
            &cache,
            &tx,
            CodecSet::default(),
            test_probe(1, &timings),
        )
        .await;

        assert_eq!(sole_outcome(&timings), TimingRowOutcome::Failed);

        let msg = rx.recv().await.expect("status frame");
        let Message::Text(json) = msg else {
            panic!("expected text status frame");
        };
        assert!(rx.try_recv().is_err(), "the status must be the only frame");
        serde_json::from_str(&json).unwrap()
    }

    #[tokio::test]
    async fn present_source_chunk_is_served_as_binary_with_no_status_frame() {
        let (tx, mut rx) = client_queue();
        let store = object_store::memory::InMemory::new();
        let resolver = tiny_resolver();
        let location = resolver
            .resolve(&ImageId("img1".into()), &key("0/0/0/0/0/0"))
            .unwrap();
        object_store::ObjectStoreExt::put(
            &store,
            location.path(),
            object_store::PutPayload::from_static(&[1, 2, 3, 4]),
        )
        .await
        .unwrap();
        let cache = Arc::new(CachedStore::new(
            Arc::new(store) as Arc<dyn object_store::ObjectStore>,
            1024,
        ));

        let timings = Arc::new(TimingBuffer::new());
        serve_chunk_from_store(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            &key("0/0/0/0/0/0"),
            None,
            &resolver,
            &cache,
            &tx,
            CodecSet::default(),
            test_probe(1, &timings),
        )
        .await;

        assert_eq!(
            sole_outcome(&timings),
            TimingRowOutcome::Delivered,
            "the served bytes are handed off"
        );

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
        assert_eq!(value["kind"], "storage_backend");
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
        assert_eq!(value["kind"], "permission");
        assert!(
            value["message"]
                .as_str()
                .expect("message string")
                .contains("403"),
        );
    }

    #[tokio::test]
    async fn generated_ready_chunk_is_served_with_normal_chunk_frame() {
        let (tx, mut rx) = client_queue();

        let cache = Arc::new(DerivedChunkCache::default());
        cache.seed_ready_chunk(
            ImageId("img1".into()),
            2,
            "2/0/0/0/0/0".into(),
            vec![9, 8, 7, 6],
        );

        let timings = Arc::new(TimingBuffer::new());
        serve_generated_chunk_request(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            2,
            "2/0/0/0/0/0",
            &cache,
            &tx,
            CodecSet::default(),
            test_probe(1, &timings),
        )
        .await;

        assert_eq!(
            sole_outcome(&timings),
            TimingRowOutcome::Delivered,
            "a ready generated chunk is delivered"
        );

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

    /// A generated chunk is the server's own making, so it crosses the link
    /// compressed for a client that decodes lz4, and decodes to what it was.
    #[tokio::test]
    async fn a_generated_chunk_crosses_compressed_to_a_client_that_decodes_lz4() {
        let (tx, mut rx) = client_queue();
        let cache = Arc::new(DerivedChunkCache::default());
        let samples: Vec<u8> = (0..4096u32).map(|i| (i / 64) as u8).collect();
        cache.seed_ready_chunk(
            ImageId("img1".into()),
            2,
            "2/0/0/0/0/0".into(),
            samples.clone(),
        );

        let timings = Arc::new(TimingBuffer::new());
        serve_generated_chunk_request(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            2,
            "2/0/0/0/0/0",
            &cache,
            &tx,
            [lucida_protocol::codec::ChunkCodec::Lz4]
                .into_iter()
                .collect(),
            test_probe(1, &timings),
        )
        .await;

        assert_eq!(sole_outcome(&timings), TimingRowOutcome::Delivered);
        let Message::Binary(buf) = rx.recv().await.expect("message") else {
            panic!("expected binary chunk frame");
        };
        let frame = lucida_protocol::codec::parse_chunk_frame(&buf).unwrap();
        assert_eq!(frame.composite_key, "ds1/img1/2/0/0/0/0/0");
        assert_eq!(frame.codecs, [PRODUCED_CODEC]);
        assert!(frame.payload.len() < samples.len() / 4);
        assert_eq!(
            lucida_core::chunk_codec::decode_relayed(&frame.codecs, frame.payload, samples.len())
                .unwrap(),
            samples
        );
    }

    /// The generated-chunk asymmetry: the server answers with a status, no
    /// binary frame ever arrives, and the requester's bracket stays open. The
    /// row has to say so — read as an ordinary unfinished serve it would look
    /// like the server stalled, which is the one mis-attribution a tool whose
    /// job is attributing stalls to a side cannot afford.
    #[tokio::test]
    async fn a_not_ready_generated_answer_is_recorded_as_not_ready() {
        let (tx, mut rx) = client_queue();
        let cache = Arc::new(DerivedChunkCache::default());

        let timings = Arc::new(TimingBuffer::new());
        serve_generated_chunk_request(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            2,
            "2/0/0/0/0/0",
            &cache,
            &tx,
            CodecSet::default(),
            test_probe(1, &timings),
        )
        .await;

        assert_eq!(sole_outcome(&timings), TimingRowOutcome::NotReady);
        assert!(
            matches!(rx.recv().await, Some(Message::Text(_))),
            "a status frame, not bytes"
        );
    }

    #[tokio::test]
    async fn generated_pending_status_is_sent_as_text() {
        let (tx, mut rx) = client_queue();

        send_generated_chunk_status(
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "2/0/0/0/0/0",
            GeneratedChunkStatus::Pending,
            None,
            &tx,
        );

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

        fn delete_stream(
            &self,
            _locations: futures_util::stream::BoxStream<'static, object_store::Result<Path>>,
        ) -> futures_util::stream::BoxStream<'static, object_store::Result<Path>> {
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

        async fn copy_opts(
            &self,
            _from: &Path,
            _to: &Path,
            _options: object_store::CopyOptions,
        ) -> object_store::Result<()> {
            unimplemented!("reads only")
        }
    }

    /// The chunk handler must charge each read to its own client. A client opening
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

        let (busy_tx, mut busy_rx) = client_queue();
        let (newcomer_tx, mut newcomer_rx) = client_queue();

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
        let resolver = Arc::new(tiny_resolver());
        for index in 0..BACKLOG {
            let resolver = Arc::clone(&resolver);
            let cache = cache.clone();
            let busy_tx = busy_tx.clone();
            tokio::spawn(async move {
                serve_chunk_from_store(
                    1,
                    &DatasetId("ds1".into()),
                    &ImageId("img1".into()),
                    &key(&format!("0/0/0/0/0/{index}")),
                    None,
                    &resolver,
                    &cache,
                    &busy_tx,
                    CodecSet::default(),
                    test_probe(1, &Arc::new(TimingBuffer::new())),
                )
                .await;
            });
        }
        // Let the backlog reach the limiter before the newcomer arrives, so
        // this really is the "second client shows up last" case.
        while limiter.queued_reads() < BACKLOG - PERMITS {
            tokio::task::yield_now().await;
        }

        // Client 2 arrives wanting a chunk none of the backlog asked for, so
        // it cannot ride one of client 1's in-flight reads.
        let newcomer = tokio::spawn({
            let resolver = Arc::clone(&resolver);
            let cache = cache.clone();
            async move {
                serve_chunk_from_store(
                    2,
                    &DatasetId("ds1".into()),
                    &ImageId("img1".into()),
                    &key("0/0/0/0/1/0"),
                    None,
                    &resolver,
                    &cache,
                    &newcomer_tx,
                    CodecSet::default(),
                    test_probe(2, &Arc::new(TimingBuffer::new())),
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
