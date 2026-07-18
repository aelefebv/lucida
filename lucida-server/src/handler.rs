use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use lucida_content::{DatasetId, DatasetManifest, ImageId};
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{
    ChunkMessage, ClientId, ClientMessage, CommandFailureCode, OpenedDatasetSummary, PeerIdentity,
    ServerMessage,
};
use lucida_core::quota::{
    MAX_CLIENT_MESSAGE_BYTES, MAX_EPHEMERAL_MESSAGE_BYTES, MAX_SNAPSHOT_JSON_BYTES,
};
use lucida_core::scene::CommandValidationCategory;
use lucida_protocol::{
    DatasetGeneratedCoarseCacheStats, DatasetGeneratedCoarseFailure, DatasetGeneratedCoarseHealth,
    DatasetHealthComponent, DatasetHealthStatus, DatasetOpenFailureDiagnostic,
    DatasetOpenFailureKind, DatasetOpenProgressDiagnostic, DatasetOpenStage,
    DatasetOpenSuccessDiagnostic, DatasetOpened, DatasetSourceCacheStats, DatasetSourceHealth,
    FailureCode, FailureDescriptor, GeneratedAvailabilityIndex, GeneratedChunkStatus,
    SourceChunkStatus, chunk_frame_len, encode_chunk_frame,
};
use lucida_store::budget::MemoryCategory;
use lucida_store::cache::CachedStore;
use object_store::path::Path;
use tokio::sync::{Mutex, OwnedRwLockReadGuard, Semaphore};
use tokio::task::JoinHandle;

use crate::dataset_open::{
    self, DatasetOpenContext, DatasetOpenOutcome, DatasetOpenProgressSender, DatasetOpenTerminal,
    WorkspaceScope,
};
use crate::decode::decode_storage_bytes_exact;
use crate::generated_coarse::{
    DerivedCacheStorage, DerivedCacheTelemetry, DerivedChunkCache, DerivedChunkLookup,
    GeneratedCoarseService, GeneratedReadyBytes,
};
use crate::health::RuntimeLifecycle;
use crate::open_diagnostics::{backend_kind_for_url, is_not_found, open_failure, open_progress};
use crate::outbox::{
    DEFAULT_OUTBOX_BYTES, DEFAULT_OUTBOX_MESSAGES, OutboxMessage, OutboxReservation,
    OutboxSendError, PreparedJsonError, SocketWriteBudget, UnicastSender,
    connection_unicast_channels, prepare_json_message, record_rejected_request_work,
    record_slow_consumer_timeout, reserve_process_message,
};
use crate::session::Session;
use crate::workspace::{
    CommandApplyError, ConnectionAdmissionError, WorkspaceAttachment, WorkspaceConnectionLease,
    WorkspaceError, WorkspaceManager,
};
use crate::{
    BroadcastEvent, BroadcastRecvError, BroadcastSender, DatasetRuntimeConfig, UnicastRoutes,
};

#[cfg(test)]
use lucida_content::{
    GeneratedLevelInfo, GeneratedLevelProvenance, GeneratedLevelRole, LevelGeometry,
};
#[cfg(test)]
use lucida_protocol::{GeneratedAvailabilitySnapshot, GeneratedLevelAvailability};

/// Process/runtime dependencies shared by every workspace WebSocket connection.
struct ClientRuntime {
    session: Arc<Mutex<Session>>,
    tx: BroadcastSender,
    unicast_routes: UnicastRoutes,
    dataset_runtime: DatasetRuntimeConfig,
    lifecycle: RuntimeLifecycle,
}

impl ClientRuntime {
    fn new(
        session: Arc<Mutex<Session>>,
        tx: BroadcastSender,
        unicast_routes: UnicastRoutes,
        dataset_runtime: DatasetRuntimeConfig,
        lifecycle: RuntimeLifecycle,
    ) -> Self {
        Self {
            session,
            tx,
            unicast_routes,
            dataset_runtime,
            lifecycle,
        }
    }
}

pub async fn handle_workspace_client(
    id: ClientId,
    ws: WebSocket,
    attachment: WorkspaceAttachment,
    manager: Arc<WorkspaceManager>,
    principal: AuthPrincipal,
    lifecycle: RuntimeLifecycle,
) {
    let live = Arc::clone(attachment.live());
    let session = Arc::clone(&live.session);
    let tx = live.tx.clone();
    let unicast_routes = Arc::clone(&live.unicast_routes);
    let dataset_runtime = manager.dataset_runtime();
    let runtime = ClientRuntime::new(session, tx, unicast_routes, dataset_runtime, lifecycle);
    handle_client_inner(
        id,
        ws,
        runtime,
        WorkspaceScope {
            live,
            manager,
            principal,
        },
        &attachment,
    )
    .await;
    drop(attachment);
}

async fn send_command_nack(
    client_id: ClientId,
    request_id: String,
    code: CommandFailureCode,
    message: &'static str,
    retryable: bool,
    sender: &UnicastSender,
) {
    let nack = ServerMessage::Nack {
        request_id,
        code,
        message: message.to_string(),
        retryable,
    };
    let _ = client_id;
    let _ = send_json_or_close(sender, &nack, DEFAULT_OUTBOX_BYTES);
}

/// Terminal/status outcomes must never disappear while the socket remains
/// open. Queue/process pressure already drives the lane's 1013 overload path;
/// intrinsic JSON oversize or encoder failure instead gets a small explicit
/// close that is independently admissible.
fn send_json_or_close<T>(
    sender: &UnicastSender,
    value: &T,
    limit: usize,
) -> Result<(), PreparedJsonError>
where
    T: serde::Serialize + ?Sized,
{
    sender.send_json_or_close(value, limit)
}

fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 128
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

const MAX_CONNECTION_REQUEST_TASKS: usize = 32;
const MAX_PRINCIPAL_REQUEST_TASKS: usize = 64;
const OUTBOUND_SEND_TIMEOUT: Duration = Duration::from_secs(10);
static PRINCIPAL_REQUEST_BUDGETS: OnceLock<StdMutex<HashMap<String, Weak<Semaphore>>>> =
    OnceLock::new();
static REJECTED_REQUEST_TASKS: AtomicU64 = AtomicU64::new(0);

fn principal_request_budget(principal: &str) -> Arc<Semaphore> {
    let budgets = PRINCIPAL_REQUEST_BUDGETS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut budgets = budgets.lock().expect("principal request budget lock");
    budgets.retain(|_, budget| budget.strong_count() > 0);
    if let Some(budget) = budgets.get(principal).and_then(Weak::upgrade) {
        return budget;
    }
    let budget = Arc::new(Semaphore::new(MAX_PRINCIPAL_REQUEST_TASKS));
    budgets.insert(principal.to_string(), Arc::downgrade(&budget));
    budget
}

fn spawn_connection_task<F>(
    tasks: &mut Vec<JoinHandle<()>>,
    principal_budget: &Arc<Semaphore>,
    future: F,
) -> bool
where
    F: Future<Output = ()> + Send + 'static,
{
    tasks.retain(|task| !task.is_finished());
    if tasks.len() >= MAX_CONNECTION_REQUEST_TASKS {
        REJECTED_REQUEST_TASKS.fetch_add(1, Ordering::Relaxed);
        record_rejected_request_work();
        return false;
    }
    let Ok(permit) = Arc::clone(principal_budget).try_acquire_owned() else {
        REJECTED_REQUEST_TASKS.fetch_add(1, Ordering::Relaxed);
        record_rejected_request_work();
        return false;
    };
    tasks.push(tokio::spawn(async move {
        let _permit = permit;
        future.await;
    }));
    true
}

fn spawn_authorized_connection_task<F, Fut>(
    tasks: &mut Vec<JoinHandle<()>>,
    principal_budget: &Arc<Semaphore>,
    access: &WorkspaceConnectionLease,
    future: F,
) -> bool
where
    F: FnOnce(OwnedRwLockReadGuard<()>) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let access = access.clone();
    spawn_connection_task(tasks, principal_budget, async move {
        let Some(operation_permit) = access.begin_operation().await else {
            return;
        };
        let future = future(operation_permit);
        tokio::select! {
            biased;
            () = access.revoked() => {}
            () = future => {}
        }
    })
}

async fn send_reserved_socket_bounded(
    sender: &mut SplitSink<WebSocket, Message>,
    wire_budget: &mut SocketWriteBudget,
    mut reserved: OutboxMessage,
) -> bool {
    // Tungstenite formats/copies the payload into this recipient's private
    // write buffer. Charge that copy independently from the original queue or
    // shared broadcast-ring storage, and hold both guards through flush.
    let Ok(()) = wire_budget.admit(&mut reserved) else {
        tracing::warn!("ws.socket_write_reservation_failed");
        return false;
    };
    let message = reserved.take_message();
    let pressure = wire_budget.overload_watch();
    let result = tokio::select! {
        biased;
        () = pressure.triggered() => return false,
        result = tokio::time::timeout(OUTBOUND_SEND_TIMEOUT, sender.send(message)) => result,
    };
    match result {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            tracing::debug!(error = %error, "ws.outbound_send_failed");
            false
        }
        Err(_) => {
            record_slow_consumer_timeout();
            tracing::warn!(
                timeout_ms = OUTBOUND_SEND_TIMEOUT.as_millis(),
                "ws.slow_consumer_send_timeout"
            );
            false
        }
    }
}

async fn send_socket_bounded(
    sender: &mut SplitSink<WebSocket, Message>,
    wire_budget: &mut SocketWriteBudget,
    message: Message,
) -> bool {
    let Ok(reserved) = reserve_process_message(message, wire_budget) else {
        tracing::warn!("ws.outbound_control_reservation_failed");
        return false;
    };
    send_reserved_socket_bounded(sender, wire_budget, reserved).await
}

enum CodecControlRequest {
    Message(Message, tokio::sync::oneshot::Sender<bool>),
    /// Tungstenite queued the peer-close reply while the read half observed
    /// `ClosedByPeer`; writing a second Close would now be `SendAfterClosing`.
    /// The sole sink owner must only flush that automatic reply.
    FlushAutomatic(tokio::sync::oneshot::Sender<bool>),
}

/// Hand an automatic-codec replacement frame to the sole socket writer and
/// wait until its bounded send has actually completed. The inbound loop does
/// not poll another Ping or Close while this future is pending, so the codec
/// can retain at most one automatic control frame behind an application write.
async fn send_codec_control_and_wait(
    sender: &tokio::sync::mpsc::Sender<CodecControlRequest>,
    message: Message,
    timeout: Duration,
) -> bool {
    let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();
    if sender
        .send(CodecControlRequest::Message(message, completion_tx))
        .await
        .is_err()
    {
        return false;
    }
    matches!(
        tokio::time::timeout(timeout, completion_rx).await,
        Ok(Ok(true))
    )
}

async fn flush_automatic_control_and_wait(
    sender: &tokio::sync::mpsc::Sender<CodecControlRequest>,
    timeout: Duration,
) -> bool {
    let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();
    if sender
        .send(CodecControlRequest::FlushAutomatic(completion_tx))
        .await
        .is_err()
    {
        return false;
    }
    matches!(
        tokio::time::timeout(timeout, completion_rx).await,
        Ok(Ok(true))
    )
}

async fn flush_sink_bounded<S, Item>(
    sender: &mut S,
    pressure: crate::outbox::OutboxOverloadWatch,
    timeout: Duration,
) -> bool
where
    S: futures_util::Sink<Item> + Unpin,
    S::Error: std::fmt::Display,
{
    let result = tokio::select! {
        biased;
        () = pressure.triggered() => return false,
        result = tokio::time::timeout(timeout, sender.flush()) => result,
    };
    match result {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            tracing::debug!(error = %error, "ws.outbound_flush_failed");
            false
        }
        Err(_) => {
            record_slow_consumer_timeout();
            tracing::warn!(
                timeout_ms = timeout.as_millis(),
                "ws.slow_consumer_flush_timeout"
            );
            false
        }
    }
}

async fn send_reserved_socket_bounded_while_authorized(
    sender: &mut SplitSink<WebSocket, Message>,
    wire_budget: &mut SocketWriteBudget,
    message: OutboxMessage,
    access: &WorkspaceConnectionLease,
) -> bool {
    let Some(_operation_permit) = access.begin_operation().await else {
        return false;
    };
    send_reserved_socket_bounded_with_authorization_watch(sender, wire_budget, message, access)
        .await
}

async fn send_reserved_socket_bounded_with_authorization_watch(
    sender: &mut SplitSink<WebSocket, Message>,
    wire_budget: &mut SocketWriteBudget,
    message: OutboxMessage,
    access: &WorkspaceConnectionLease,
) -> bool {
    tokio::select! {
        biased;
        () = access.revoked() => false,
        sent = send_reserved_socket_bounded(sender, wire_budget, message) => sent,
    }
}

async fn handle_client_inner(
    id: ClientId,
    ws: WebSocket,
    runtime: ClientRuntime,
    workspace: WorkspaceScope,
    attachment: &WorkspaceAttachment,
) {
    let ClientRuntime {
        session,
        tx,
        unicast_routes,
        dataset_runtime,
        lifecycle,
    } = runtime;
    let (mut ws_tx, mut ws_rx) = ws.split();
    let Ok(mut socket_write_budget) = SocketWriteBudget::new(DEFAULT_OUTBOX_BYTES) else {
        tracing::warn!(client_id = %id, "ws.connection_wire_baseline_rejected");
        return;
    };
    let principal_key = workspace.principal.email.trim().to_ascii_lowercase();
    let principal_request_budget = principal_request_budget(&principal_key);
    let ctx = &workspace;

    // The HTTP upgrade has already been authorized, but membership/link/auth
    // state may have changed before the async WebSocket callback ran. Register
    // the captured attachment capability before subscribing or sending a
    // snapshot; the manager atomically revalidates stale workspace epochs and
    // rejects stale credential epochs.
    let connection_access = match ctx
        .manager
        .register_attachment_connection(attachment, id, &ctx.principal)
        .await
    {
        Ok(access) => access,
        Err(error) => {
            let (code, reason) = match error {
                ConnectionAdmissionError::WorkspaceLimit
                | ConnectionAdmissionError::PrincipalLimit => {
                    (1013, "workspace connection limit reached")
                }
                ConnectionAdmissionError::AccessRevoked => (1008, "workspace access revoked"),
            };
            tracing::warn!(client_id = %id, error = %error, "ws.connection_admission_rejected");
            let _ = send_socket_bounded(
                &mut ws_tx,
                &mut socket_write_budget,
                Message::Close(Some(CloseFrame {
                    code,
                    reason: reason.into(),
                })),
            )
            .await;
            return;
        }
    };

    let Some(initialization_permit) = connection_access.begin_operation().await else {
        let _ = send_socket_bounded(
            &mut ws_tx,
            &mut socket_write_budget,
            Message::Close(Some(CloseFrame {
                code: 1008,
                reason: "workspace access revoked".into(),
            })),
        )
        .await;
        workspace.live.unregister_connection(id).await;
        return;
    };

    // Per-client unicast channel for targeted messages (chunk routing).
    // Correctness-control traffic has its own tiny lane ahead of workspace
    // broadcast and bulk/status unicast. Both lanes share this connection's
    // byte allocator (including in-flight guards) and the process allocator,
    // so priority does not multiply either memory ceiling.
    let (unicast_tx, mut unicast_rx, control_tx, mut control_rx) = connection_unicast_channels(
        DEFAULT_OUTBOX_MESSAGES,
        4,
        DEFAULT_OUTBOX_BYTES,
        &socket_write_budget,
    );
    let bulk_overload = unicast_tx.overload_watch();
    unicast_routes.lock().await.insert(id, unicast_tx);
    if connection_access.is_revoked() {
        let _ = send_socket_bounded(
            &mut ws_tx,
            &mut socket_write_budget,
            Message::Close(Some(CloseFrame {
                code: 1008,
                reason: "workspace access revoked".into(),
            })),
        )
        .await;
        unicast_routes.lock().await.remove(&id);
        workspace.live.unregister_connection(id).await;
        return;
    }

    // Presentational identity for this peer's cursor (#540), authored from
    // the connection's authenticated principal. Sourced server-side (never
    // client-sent) so it can't be spoofed and is only shown to co-present peers.
    //
    // Privacy: the raw email is NOT broadcast — collaborator emails are
    // owner-only. `from_principal_parts` computes a single-grapheme
    // `initial` from the display name (or email local-part when blank)
    // server-side, so only the non-identifying name/avatar/initial cross
    // the wire to co-present (possibly non-owner) peers.
    let identity = Some({
        PeerIdentity::from_principal_parts(
            workspace.principal.display_name.clone(),
            workspace.principal.picture_url.clone(),
            &workspace.principal.email,
        )
    });

    // Lock session, subscribe (before unlock — no gap), add client, snapshot, unlock.
    let (snapshot, mut rx, peer_joined) = {
        let mut sess = session.lock().await;
        let rx = tx.subscribe();
        let presence = sess.add_client(id, identity);
        let snapshot = prepare_snapshot(&sess, id, &socket_write_budget);
        let peer_joined = ServerMessage::PeerJoined {
            client_id: id,
            presence,
        };
        (snapshot, rx, peer_joined)
    };
    let snapshot = match snapshot {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let (code, reason) = snapshot_close(&error);
            tracing::error!(client_id = %id, error = %error, "ws.snapshot_prepare_failed");
            let _ = send_socket_bounded(
                &mut ws_tx,
                &mut socket_write_budget,
                Message::Close(Some(CloseFrame {
                    code,
                    reason: reason.into(),
                })),
            )
            .await;
            let mut sess = session.lock().await;
            sess.remove_client(id);
            unicast_routes.lock().await.remove(&id);
            workspace.live.unregister_connection(id).await;
            return;
        }
    };

    // Send snapshot as first message.
    if !send_reserved_socket_bounded_with_authorization_watch(
        &mut ws_tx,
        &mut socket_write_budget,
        snapshot,
        &connection_access,
    )
    .await
    {
        tracing::warn!(client_id = %id, "ws.snapshot_send_failed");
        let mut sess = session.lock().await;
        sess.remove_client(id);
        unicast_routes.lock().await.remove(&id);
        workspace.live.unregister_connection(id).await;
        return;
    }

    // Broadcast PeerJoined to others.
    let _ = tx.send(BroadcastEvent::peer_joined(id, peer_joined));
    drop(initialization_permit);

    // Outbound: forward broadcast + unicast messages to this client.
    let outbound_session = Arc::clone(&session);
    let outbound_access = connection_access.clone();
    // Tungstenite queues automatic Pong/Close frames while reading. Route one
    // explicit replacement through the sole sink owner and wait for its
    // flush before polling another inbound frame; repeated client Pings can
    // therefore never accumulate behind a blocked application write.
    let (codec_control_tx, mut codec_control_rx) =
        tokio::sync::mpsc::channel::<CodecControlRequest>(1);
    let mut outbound = tokio::spawn(async move {
        let draining = lifecycle.wait_for_draining();
        tokio::pin!(draining);
        loop {
            tokio::select! {
                biased;
                () = outbound_access.revoked() => {
                    let _ = send_socket_bounded(
                        &mut ws_tx,
                        &mut socket_write_budget,
                        Message::Close(Some(axum::extract::ws::CloseFrame {
                            code: 1008,
                            reason: "workspace access revoked".into(),
                        })),
                    )
                    .await;
                    break;
                }
                () = &mut draining => {
                    let _ = send_socket_bounded(
                        &mut ws_tx,
                        &mut socket_write_budget,
                        Message::Close(Some(axum::extract::ws::CloseFrame {
                            code: 1012,
                            reason: "server restarting".into(),
                        })),
                    )
                    .await;
                    break;
                }
                control = codec_control_rx.recv() => {
                    let Some(control) = control else {
                        break;
                    };
                    let (sent, completion) = match control {
                        CodecControlRequest::Message(message, completion) => {
                            let sent = send_socket_bounded(
                                &mut ws_tx,
                                &mut socket_write_budget,
                                message,
                            )
                            .await;
                            (sent, completion)
                        }
                        CodecControlRequest::FlushAutomatic(completion) => {
                            let pressure = socket_write_budget.overload_watch();
                            let sent = flush_sink_bounded(
                                &mut ws_tx,
                                pressure,
                                OUTBOUND_SEND_TIMEOUT,
                            )
                            .await;
                            (sent, completion)
                        }
                    };
                    let _ = completion.send(sent);
                    if !sent {
                        break;
                    }
                }
                () = bulk_overload.triggered() => {
                    tracing::warn!(client_id = %id, "ws.bulk_outbox_pressure_closing");
                    if let Some(close) = unicast_rx.take_overload_close() {
                        let _ = send_reserved_socket_bounded_while_authorized(
                            &mut ws_tx,
                            &mut socket_write_budget,
                            close,
                            &outbound_access,
                        )
                        .await;
                    }
                    break;
                }
                msg = control_rx.recv_reserved() => {
                    match msg {
                        Some(reserved) => {
                            let closing = matches!(reserved.message(), Message::Close(_));
                            let sent = send_reserved_socket_bounded_while_authorized(
                                &mut ws_tx,
                                &mut socket_write_budget,
                                reserved,
                                &outbound_access,
                            )
                            .await;
                            if !sent || closing {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                result = rx.recv() => {
                    match result {
                        Ok(item) => {
                            let Some(message) = item.outbound_for(id) else {
                                continue;
                            };
                            if !send_reserved_socket_bounded_while_authorized(
                                &mut ws_tx,
                                &mut socket_write_budget,
                                message,
                                &outbound_access,
                            )
                            .await
                            {
                                break;
                            }
                        }
                        Err(BroadcastRecvError::Lagged(n)) => {
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
                            let snapshot = {
                                let sess = outbound_session.lock().await;
                                prepare_snapshot(&sess, id, &socket_write_budget)
                            };
                            let snapshot = match snapshot {
                                Ok(snapshot) => snapshot,
                                Err(error) => {
                                    let (code, reason) = snapshot_close(&error);
                                    tracing::error!(
                                        client_id = %id,
                                        error = %error,
                                        "ws.resync_snapshot_prepare_failed"
                                    );
                                    let _ = send_socket_bounded(
                                        &mut ws_tx,
                                        &mut socket_write_budget,
                                        Message::Close(Some(CloseFrame {
                                            code,
                                            reason: reason.into(),
                                        })),
                                    )
                                    .await;
                                    break;
                                }
                            };
                            if !send_reserved_socket_bounded_while_authorized(
                                &mut ws_tx,
                                &mut socket_write_budget,
                                snapshot,
                                &outbound_access,
                            )
                            .await
                            {
                                break;
                            }
                        }
                        Err(BroadcastRecvError::Pressure) => {
                            tracing::warn!(client_id = %id, "ws.broadcast_pressure_closing");
                            let _ = send_socket_bounded(
                                &mut ws_tx,
                                &mut socket_write_budget,
                                Message::Close(Some(CloseFrame {
                                    code: 1013,
                                    reason: "outbound process capacity exceeded".into(),
                                })),
                            )
                            .await;
                            break;
                        }
                        Err(BroadcastRecvError::Closed) => break,
                    }
                }
                msg = unicast_rx.recv_reserved() => {
                    match msg {
                        Some(reserved) => {
                            let closing = matches!(reserved.message(), Message::Close(_));
                            let sent = send_reserved_socket_bounded_while_authorized(
                                &mut ws_tx,
                                &mut socket_write_budget,
                                reserved,
                                &outbound_access,
                            )
                            .await;
                            if !sent {
                                break;
                            }
                            if closing {
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
    let mut request_tasks: Vec<JoinHandle<()>> = Vec::new();

    // Inbound: parse client messages, apply/route.
    loop {
        let incoming = tokio::select! {
            biased;
            () = connection_access.revoked() => break,
            _ = &mut outbound => break,
            incoming = ws_rx.next() => incoming,
        };
        let Some(Ok(msg)) = incoming else {
            break;
        };
        if connection_access.is_revoked() {
            break;
        }
        let Some(_operation_permit) = connection_access.begin_operation().await else {
            break;
        };
        if let Some(bytes) = message_payload_len(&msg)
            && bytes > MAX_CLIENT_MESSAGE_BYTES
        {
            tracing::warn!(
                client_id = %id,
                bytes,
                limit = MAX_CLIENT_MESSAGE_BYTES,
                "ws.inbound_message_limit_exceeded"
            );
            let _ = control_tx.send(Message::Close(Some(CloseFrame {
                code: 1009,
                reason: "client message exceeds the server limit".into(),
            })));
            break;
        }
        match msg {
            Message::Text(text) => {
                let json = text.to_string();

                // Try as ClientMessage (new protocol).
                if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&json) {
                    if is_retained_ephemeral_message(&client_msg)
                        && json.len() > MAX_EPHEMERAL_MESSAGE_BYTES
                    {
                        tracing::warn!(
                            client_id = %id,
                            bytes = json.len(),
                            limit = MAX_EPHEMERAL_MESSAGE_BYTES,
                            "ws.ephemeral_message_limit_exceeded"
                        );
                        let _ = control_tx.send(Message::Close(Some(CloseFrame {
                            code: 1009,
                            reason: "presence message exceeds the server limit".into(),
                        })));
                        break;
                    }
                    if let Some(request_id) = non_command_request_id(&client_msg)
                        && !valid_request_id(request_id)
                    {
                        tracing::warn!(client_id = %id, "ws.request_id_rejected");
                        let _ = control_tx.send(Message::Close(Some(CloseFrame {
                            code: 1008,
                            reason: "request_id is invalid".into(),
                        })));
                        break;
                    }
                    match client_msg {
                        ClientMessage::InverseCommand {
                            request_id,
                            target_operation_id,
                            expected_revision,
                        } => {
                            let Ok(_request_permit) =
                                Arc::clone(&principal_request_budget).try_acquire_owned()
                            else {
                                REJECTED_REQUEST_TASKS.fetch_add(1, Ordering::Relaxed);
                                record_rejected_request_work();
                                send_command_nack(
                                    id,
                                    request_id,
                                    CommandFailureCode::ResourceLimit,
                                    "server request capacity is temporarily full",
                                    true,
                                    &control_tx,
                                )
                                .await;
                                continue;
                            };
                            match ctx
                                .manager
                                .apply_inverse_command(
                                    &ctx.live,
                                    &ctx.principal,
                                    target_operation_id,
                                    expected_revision,
                                )
                                .await
                            {
                                Ok((seq, _command)) => {
                                    tracing::info!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        operation_id = seq,
                                        inverse_of = target_operation_id,
                                        request_id = %request_id,
                                        "workspace.command.inverse_applied"
                                    );
                                }
                                Err(error) => {
                                    let (code, message, retryable) = match &error {
                                        CommandApplyError::Forbidden => (
                                            CommandFailureCode::Forbidden,
                                            "only the operation author may undo it",
                                            false,
                                        ),
                                        CommandApplyError::GateUnavailable(_) => (
                                            CommandFailureCode::AuthorizationUnavailable,
                                            "command authorization is temporarily unavailable",
                                            true,
                                        ),
                                        CommandApplyError::Rejected(_) => (
                                            CommandFailureCode::InvalidRequest,
                                            "inverse command failed validation",
                                            false,
                                        ),
                                        CommandApplyError::Conflict(_) => (
                                            CommandFailureCode::Conflict,
                                            "undo target changed or is not safely reversible",
                                            false,
                                        ),
                                        CommandApplyError::PersistFailed(_) => (
                                            CommandFailureCode::PersistenceUnavailable,
                                            "inverse command could not be durably persisted",
                                            true,
                                        ),
                                        CommandApplyError::OutboundUnavailable => (
                                            CommandFailureCode::ResourceLimit,
                                            "outbound process capacity is temporarily full",
                                            true,
                                        ),
                                    };
                                    tracing::warn!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        target_operation_id,
                                        expected_revision,
                                        error = %error,
                                        "workspace.command.inverse_rejected"
                                    );
                                    send_command_nack(
                                        id,
                                        request_id,
                                        code,
                                        message,
                                        retryable,
                                        &control_tx,
                                    )
                                    .await;
                                }
                            }
                        }
                        ClientMessage::Command {
                            request_id,
                            command,
                        } => {
                            // An omitted id is the pre-correlation command
                            // envelope and remains accepted during migration.
                            // Explicit non-empty ids must satisfy the current
                            // bounded vocabulary before they can be echoed.
                            if !request_id.is_empty() && !valid_request_id(&request_id) {
                                // Echo only admitted ids; an oversized/malformed
                                // value cannot become an amplification payload.
                                send_command_nack(
                                    id,
                                    String::new(),
                                    CommandFailureCode::InvalidRequest,
                                    "command request_id is invalid",
                                    false,
                                    &control_tx,
                                )
                                .await;
                                continue;
                            }
                            // DatasetOpened may replace a manifest when a
                            // source generation changes, so its document-level
                            // apply semantics are intentionally upsert. It is
                            // nevertheless server-authored on every session
                            // surface; clients must use OpenRemoteDataset.
                            if matches!(command, DocumentCommand::DatasetOpened(_)) {
                                tracing::warn!(
                                    client_id = %id,
                                    "session.command.rejected_client_dataset_opened"
                                );
                                send_command_nack(
                                    id,
                                    request_id,
                                    CommandFailureCode::InvalidRequest,
                                    "dataset_opened is server-authored",
                                    false,
                                    &control_tx,
                                )
                                .await;
                                continue;
                            }
                            let Ok(_request_permit) =
                                Arc::clone(&principal_request_budget).try_acquire_owned()
                            else {
                                REJECTED_REQUEST_TASKS.fetch_add(1, Ordering::Relaxed);
                                record_rejected_request_work();
                                send_command_nack(
                                    id,
                                    request_id,
                                    CommandFailureCode::ResourceLimit,
                                    "server request capacity is temporarily full",
                                    true,
                                    &control_tx,
                                )
                                .await;
                                continue;
                            };
                            // All commands in ClientMessage are DocumentCommands
                            // by construction — no runtime guard needed.
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
                            if let DocumentCommand::RenameDataset { id: ds_id, name } = &command {
                                match ctx
                                    .manager
                                    .rename_dataset_published(
                                        &ctx.live,
                                        &ctx.principal,
                                        id,
                                        request_id.clone(),
                                        ds_id,
                                        name,
                                    )
                                    .await
                                {
                                    Ok((_seq, _applied)) => {}
                                    Err(e) => {
                                        tracing::warn!(
                                            client_id = %id,
                                            workspace_id = %ctx.live.workspace_id,
                                            error = %e,
                                            "workspace.command.rename_dataset_rejected"
                                        );
                                        let (code, message, retryable) = match e {
                                            WorkspaceError::Forbidden => (
                                                CommandFailureCode::Forbidden,
                                                "workspace role cannot apply this command",
                                                false,
                                            ),
                                            WorkspaceError::BadRequest(_) => (
                                                CommandFailureCode::InvalidRequest,
                                                "dataset rename is invalid",
                                                false,
                                            ),
                                            WorkspaceError::Store(_) => (
                                                CommandFailureCode::PersistenceUnavailable,
                                                "dataset rename could not be persisted",
                                                true,
                                            ),
                                            WorkspaceError::OutboundUnavailable => (
                                                CommandFailureCode::ResourceLimit,
                                                "outbound process capacity is temporarily full",
                                                true,
                                            ),
                                            _ => (
                                                CommandFailureCode::Conflict,
                                                "dataset rename target is unavailable",
                                                false,
                                            ),
                                        };
                                        send_command_nack(
                                            id,
                                            request_id,
                                            code,
                                            message,
                                            retryable,
                                            &control_tx,
                                        )
                                        .await;
                                    }
                                }
                                continue;
                            }
                            match ctx
                                .manager
                                .apply_document_command_published(
                                    &ctx.live,
                                    &ctx.principal,
                                    id,
                                    request_id.clone(),
                                    command,
                                )
                                .await
                            {
                                Ok((_seq, _applied)) => {}
                                Err(e @ CommandApplyError::Forbidden) => {
                                    tracing::warn!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        error = %e,
                                        "workspace.command.forbidden"
                                    );
                                    send_command_nack(
                                        id,
                                        request_id,
                                        CommandFailureCode::Forbidden,
                                        "workspace role or ownership policy denied the command",
                                        false,
                                        &control_tx,
                                    )
                                    .await;
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
                                    send_command_nack(
                                        id,
                                        request_id,
                                        CommandFailureCode::AuthorizationUnavailable,
                                        "command authorization is temporarily unavailable",
                                        true,
                                        &control_tx,
                                    )
                                    .await;
                                }
                                Err(CommandApplyError::Rejected(validation)) => {
                                    tracing::warn!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        error = %validation,
                                        "workspace.command.rejected"
                                    );
                                    let (code, message) = command_validation_failure(&validation);
                                    send_command_nack(
                                        id,
                                        request_id,
                                        code,
                                        message,
                                        false,
                                        &control_tx,
                                    )
                                    .await;
                                }
                                Err(e @ CommandApplyError::Conflict(_)) => {
                                    tracing::warn!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        error = %e,
                                        "workspace.command.conflict"
                                    );
                                    send_command_nack(
                                        id,
                                        request_id,
                                        CommandFailureCode::Conflict,
                                        "command conflicts with current workspace state",
                                        false,
                                        &control_tx,
                                    )
                                    .await;
                                }
                                Err(e @ CommandApplyError::PersistFailed(_)) => {
                                    tracing::error!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        error = %e,
                                        "workspace.command.persist_failed"
                                    );
                                    send_command_nack(
                                        id,
                                        request_id,
                                        CommandFailureCode::PersistenceUnavailable,
                                        "command could not be durably persisted",
                                        true,
                                        &control_tx,
                                    )
                                    .await;
                                }
                                Err(e @ CommandApplyError::OutboundUnavailable) => {
                                    tracing::warn!(
                                        client_id = %id,
                                        workspace_id = %ctx.live.workspace_id,
                                        error = %e,
                                        "workspace.command.outbound_capacity_unavailable"
                                    );
                                    send_command_nack(
                                        id,
                                        request_id,
                                        CommandFailureCode::ResourceLimit,
                                        "outbound process capacity is temporarily full",
                                        true,
                                        &control_tx,
                                    )
                                    .await;
                                }
                            }
                            continue;
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
                            let _ = tx.send(BroadcastEvent::presence(id, update));
                        }
                        ClientMessage::Cursor {
                            position,
                            dataset_id,
                        } => {
                            {
                                let mut sess = session.lock().await;
                                sess.update_cursor(id, position, dataset_id.clone());
                            }
                            let update = ServerMessage::CursorUpdate {
                                client_id: id,
                                position,
                                dataset_id,
                            };
                            let _ = tx.send(BroadcastEvent::cursor(id, update));
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
                                let _ = tx.send(BroadcastEvent::follow_changed(msg));
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
                                let _ = tx.send(BroadcastEvent::follow_changed(msg));
                            }
                        }
                        ClientMessage::OpenRemoteDataset { request_id, url } => {
                            let redacted_source =
                                dataset_runtime.source_policy.redact_untrusted(&url);
                            tracing::info!(
                                client_id = %id,
                                request_id = %request_id,
                                source = %redacted_source,
                                "open_remote_dataset.received"
                            );
                            let terminal_slot = match control_tx.reserve_terminal_slot().await {
                                Ok(slot) => slot,
                                Err(_) => continue,
                            };
                            let terminal = DatasetOpenTerminal::new(
                                request_id.clone(),
                                control_tx.clone(),
                                terminal_slot,
                            );
                            let context = OpenRemoteDatasetContext {
                                session: Arc::clone(&session),
                                tx: tx.clone(),
                                terminal: terminal.clone(),
                                dataset_runtime: dataset_runtime.clone(),
                                workspace: workspace.clone(),
                            };
                            let overload_request_id = request_id.clone();
                            let overload_source = redacted_source;
                            let request = OpenRemoteDatasetRequest { request_id, url };
                            if !spawn_authorized_connection_task(
                                &mut request_tasks,
                                &principal_request_budget,
                                &connection_access,
                                move |operation_permit| async move {
                                    handle_open_remote_dataset(
                                        id,
                                        request,
                                        context,
                                        operation_permit,
                                    )
                                    .await;
                                },
                            ) {
                                send_open_failed_reserved(
                                    id,
                                    &overload_request_id,
                                    &overload_source,
                                    open_failure(
                                        DatasetOpenStage::RequestReceived,
                                        DatasetOpenFailureKind::ResourceLimit,
                                        true,
                                        "server request capacity is temporarily full",
                                        None,
                                    ),
                                    &terminal,
                                )
                                .await;
                            }
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
                            let _ = send_json_or_close(&control_tx, &msg, DEFAULT_OUTBOX_BYTES);
                        }
                        ClientMessage::DatasetRetry {
                            request_id,
                            dataset_id,
                        } => {
                            let terminal_slot = match control_tx.reserve_terminal_slot().await {
                                Ok(slot) => slot,
                                Err(_) => continue,
                            };
                            let terminal = DatasetOpenTerminal::new(
                                request_id.clone(),
                                control_tx.clone(),
                                terminal_slot,
                            );
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
                                    send_open_failed_reserved(
                                        id,
                                        &request_id,
                                        dataset_id.as_ref(),
                                        open_failure(
                                            DatasetOpenStage::SourceLookup,
                                            DatasetOpenFailureKind::UnknownDataset,
                                            false,
                                            "workspace dataset source was not found",
                                            None,
                                        ),
                                        &terminal,
                                    )
                                    .await;
                                    continue;
                                }
                                Err(e) => {
                                    send_open_failed_reserved(
                                        id,
                                        &request_id,
                                        dataset_id.as_ref(),
                                        dataset_retry_failure_diagnostic(e),
                                        &terminal,
                                    )
                                    .await;
                                    continue;
                                }
                            };

                            let redacted_source = dataset_runtime
                                .source_policy
                                .redact_untrusted(source.identity.locator.as_str());
                            tracing::info!(
                                client_id = %id,
                                request_id = %request_id,
                                workspace_dataset_id = %dataset_id,
                                source = %redacted_source,
                                "dataset_retry.received"
                            );
                            let context = OpenRemoteDatasetContext {
                                session: Arc::clone(&session),
                                tx: tx.clone(),
                                terminal: terminal.clone(),
                                dataset_runtime: dataset_runtime.clone(),
                                workspace: workspace.clone(),
                            };
                            let overload_request_id = request_id.clone();
                            let request = OpenRemoteDatasetRequest {
                                request_id,
                                url: source.identity.locator.into_string(),
                            };
                            if !spawn_authorized_connection_task(
                                &mut request_tasks,
                                &principal_request_budget,
                                &connection_access,
                                move |operation_permit| async move {
                                    handle_open_remote_dataset(
                                        id,
                                        request,
                                        context,
                                        operation_permit,
                                    )
                                    .await;
                                },
                            ) {
                                send_open_failed_reserved(
                                    id,
                                    &overload_request_id,
                                    &redacted_source,
                                    open_failure(
                                        DatasetOpenStage::RequestReceived,
                                        DatasetOpenFailureKind::ResourceLimit,
                                        true,
                                        "server request capacity is temporarily full",
                                        None,
                                    ),
                                    &terminal,
                                )
                                .await;
                            }
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
                            let result = {
                                let sess = session.lock().await;
                                control_tx
                                    .send_json(&sess.snapshot_view(id), MAX_SNAPSHOT_JSON_BYTES)
                            };
                            if let Err(error) = result {
                                let (code, reason) = snapshot_close(&error);
                                tracing::error!(
                                    client_id = %id,
                                    error = %error,
                                    "ws.requested_snapshot_prepare_failed"
                                );
                                let _ = control_tx.send(Message::Close(Some(CloseFrame {
                                    code,
                                    reason: reason.into(),
                                })));
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
                            let _ = tx.send(BroadcastEvent::dataset_presence(id, update));
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
                            let parsed_key = match key.parse::<lucida_store::ChunkKey>() {
                                Ok(parsed) => parsed,
                                Err(error) => {
                                    let failure =
                                        crate::binding::ChunkResolveError::InvalidKey(error);
                                    send_source_chunk_status(
                                        id,
                                        &dataset_id,
                                        &image_id,
                                        &key,
                                        failure.failure(),
                                        Some(failure.public_message().to_string()),
                                        &unicast_routes,
                                    )
                                    .await;
                                    continue;
                                }
                            };
                            // Look up the server binding for this dataset.
                            let level = parsed_key.level;
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
                                            resolved: b.resolver.resolve_checked(&image_id, &key),
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
                                    let request_dataset_id = dataset_id.clone();
                                    let request_image_id = image_id.clone();
                                    let request_key = key.clone();
                                    if !spawn_authorized_connection_task(
                                        &mut request_tasks,
                                        &principal_request_budget,
                                        &connection_access,
                                        move |operation_permit| async move {
                                            let _operation_permit = operation_permit;
                                            serve_chunk_from_store(
                                                id,
                                                &request_dataset_id,
                                                &request_image_id,
                                                &request_key,
                                                resolved,
                                                level_info,
                                                &cache,
                                                &unicast_routes_clone,
                                            )
                                            .await;
                                        },
                                    ) {
                                        send_source_chunk_status(
                                            id,
                                            &dataset_id,
                                            &image_id,
                                            &key,
                                            FailureDescriptor::new(
                                                FailureCode::ResourceLimit,
                                                true,
                                            ),
                                            Some(
                                                "server request capacity is temporarily full"
                                                    .into(),
                                            ),
                                            &unicast_routes,
                                        )
                                        .await;
                                    }
                                }
                                Some(ChunkDispatch::Generated {
                                    level,
                                    derived_chunks,
                                    generated_service,
                                }) => {
                                    let unicast_routes_clone = Arc::clone(&unicast_routes);
                                    let request_dataset_id = dataset_id.clone();
                                    let request_image_id = image_id.clone();
                                    let request_key = key.clone();
                                    if !spawn_authorized_connection_task(
                                        &mut request_tasks,
                                        &principal_request_budget,
                                        &connection_access,
                                        move |operation_permit| async move {
                                            let _operation_permit = operation_permit;
                                            generated_service
                                                .enqueue_chunk_request(
                                                    &request_image_id,
                                                    level,
                                                    &request_key,
                                                )
                                                .await;
                                            serve_generated_chunk_request(
                                                id,
                                                &request_dataset_id,
                                                &request_image_id,
                                                level,
                                                &request_key,
                                                &derived_chunks,
                                                &unicast_routes_clone,
                                            )
                                            .await;
                                        },
                                    ) {
                                        send_generated_chunk_status(
                                            id,
                                            &dataset_id,
                                            &image_id,
                                            &key,
                                            GeneratedChunkStatus::FailedTransient,
                                            Some(FailureDescriptor::new(
                                                FailureCode::ResourceLimit,
                                                true,
                                            )),
                                            Some(
                                                "server request capacity is temporarily full"
                                                    .into(),
                                            ),
                                            &unicast_routes,
                                        )
                                        .await;
                                    }
                                }
                                None => {
                                    send_source_chunk_status(
                                        id,
                                        &dataset_id,
                                        &image_id,
                                        &key,
                                        FailureDescriptor::new(FailureCode::UnknownDataset, false),
                                        Some("dataset binding is not available".into()),
                                        &unicast_routes,
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                    continue;
                }

                tracing::warn!(client_id = %id, "ws.message_unrecognized");
            }
            Message::Binary(_) => {
                // Binary frames are server-to-client chunk responses only.
                // Client-originated binary relay was part of the retired
                // data-source/proxy protocol and now fails closed.
                tracing::warn!(client_id = %id, "ws.client_binary_frame_rejected");
            }
            Message::Ping(payload) => {
                if !send_codec_control_and_wait(
                    &codec_control_tx,
                    Message::Pong(payload),
                    OUTBOUND_SEND_TIMEOUT.saturating_mul(2),
                )
                .await
                {
                    break;
                }
            }
            Message::Close(frame) => {
                tracing::debug!(client_id = %id, ?frame, "ws.peer_close_received");
                let _ = flush_automatic_control_and_wait(
                    &codec_control_tx,
                    OUTBOUND_SEND_TIMEOUT.saturating_mul(2),
                )
                .await;
                break;
            }
            Message::Pong(_) => {}
        }
    }

    // Cleanup on disconnect.
    outbound.abort();
    for task in &request_tasks {
        task.abort();
    }
    for task in request_tasks {
        let _ = task.await;
    }
    unicast_routes.lock().await.remove(&id);
    workspace.live.unregister_connection(id).await;
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
    let affected_followers = {
        let mut sess = session.lock().await;
        sess.remove_client(id)
    };

    // Broadcast PeerLeft.
    let _ = tx.send(BroadcastEvent::peer_left(ServerMessage::PeerLeft {
        client_id: id,
    }));

    // Broadcast FollowChanged for any followers that were redirected.
    for follower_id in affected_followers {
        let msg = ServerMessage::FollowChanged {
            client_id: follower_id,
            target: None,
        };
        let _ = tx.send(BroadcastEvent::follow_changed(msg));
    }

    tracing::info!(
        client_id = %id,
        workspace_id = %workspace.live.workspace_id,
        "ws.client_disconnected"
    );
}

fn command_validation_failure(
    error: &lucida_core::scene::CommandValidationError,
) -> (CommandFailureCode, &'static str) {
    if error.category == CommandValidationCategory::ResourceLimit {
        (
            CommandFailureCode::ResourceLimit,
            "command exceeds collaborative resource limits",
        )
    } else {
        (
            CommandFailureCode::InvalidRequest,
            "command failed validation",
        )
    }
}

fn prepare_snapshot(
    session: &Session,
    client_id: ClientId,
    socket_budget: &SocketWriteBudget,
) -> Result<OutboxMessage, PreparedJsonError> {
    prepare_json_message(
        &session.snapshot_view(client_id),
        MAX_SNAPSHOT_JSON_BYTES,
        socket_budget,
    )
}

fn snapshot_close(error: &PreparedJsonError) -> (u16, &'static str) {
    match error {
        PreparedJsonError::Json(lucida_core::quota::BoundedJsonError::LimitExceeded { .. }) => {
            (1009, "workspace snapshot exceeds the server limit")
        }
        PreparedJsonError::Outbox(
            OutboxSendError::Oversized | OutboxSendError::Full | OutboxSendError::ProcessFull,
        ) => (1013, "outbound process capacity exceeded"),
        PreparedJsonError::Json(lucida_core::quota::BoundedJsonError::Serialize(_))
        | PreparedJsonError::Outbox(
            OutboxSendError::Closed | OutboxSendError::ReservationMismatch { .. },
        ) => (1011, "workspace snapshot serialization failed"),
    }
}

fn message_payload_len(message: &Message) -> Option<usize> {
    match message {
        Message::Text(text) => Some(text.len()),
        Message::Binary(bytes) => Some(bytes.len()),
        _ => None,
    }
}

fn is_retained_ephemeral_message(message: &ClientMessage) -> bool {
    matches!(
        message,
        ClientMessage::Presence { .. }
            | ClientMessage::DatasetPresence { .. }
            | ClientMessage::ViewerInterest { .. }
    )
}

fn non_command_request_id(message: &ClientMessage) -> Option<&str> {
    match message {
        ClientMessage::InverseCommand { request_id, .. }
        | ClientMessage::OpenRemoteDataset { request_id, .. }
        | ClientMessage::DatasetHealth { request_id, .. }
        | ClientMessage::DatasetRetry { request_id, .. } => Some(request_id),
        _ => None,
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

fn dataset_health_for_manifest(sess: &Session, manifest: &DatasetManifest) -> DatasetSourceHealth {
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
        .map(|binding| binding.source.identity.locator.to_string())
        .or_else(|| runtime.map(|state| state.source_url.clone()));
    let backend = source_url.as_deref().map(backend_kind_for_url);
    let mut messages = Vec::new();
    if let Some(binding) = binding {
        messages.extend(binding.import_warnings.iter().cloned());
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
                "generated coarse cache is {used_percent}% full ({} charged bytes)",
                cache.current_bytes
            ));
        }
        if let Some(used_percent) = cache.entry_used_percent
            && used_percent >= 90
        {
            messages.push(format!(
                "generated coarse cache is {used_percent}% full by filesystem entries ({} entries)",
                cache.entry_count
            ));
        }
    }

    DatasetSourceHealth {
        workspace_dataset_id: dataset_id,
        name: manifest.name.clone(),
        status: combine_health(
            combine_health(binding_component.status, source_cache_status),
            generated.status,
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
    }
}

fn generated_coarse_health(
    index: Option<&GeneratedAvailabilityIndex>,
    cache: Option<DerivedCacheTelemetry>,
) -> DatasetGeneratedCoarseHealth {
    let cache = cache.map(generated_cache_stats_for_protocol);
    let cache_accounting_healthy = cache
        .as_ref()
        .is_none_or(|telemetry| telemetry.accounting_healthy);
    let Some(index) = index else {
        return DatasetGeneratedCoarseHealth {
            status: if cache_accounting_healthy {
                DatasetHealthStatus::Healthy
            } else {
                DatasetHealthStatus::Degraded
            },
            level_count: 0,
            ready_chunks: 0,
            pending_chunks: 0,
            failed_chunks: 0,
            unavailable_chunks: 0,
            message: Some(if cache_accounting_healthy {
                "no generated coarse levels advertised".to_string()
            } else {
                "generated coarse cache accounting is unavailable; writes are disabled".to_string()
            }),
            cache,
            recent_failures: Vec::new(),
        };
    };
    let snapshot = index.snapshot();

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
            failure: chunk.failure,
            message: chunk.message.clone(),
        })
        .collect::<Vec<_>>();

    let status = if !cache_accounting_healthy || failed_chunks > 0 || unavailable_chunks > 0 {
        DatasetHealthStatus::Degraded
    } else {
        DatasetHealthStatus::Healthy
    };
    let message = if !cache_accounting_healthy {
        Some("generated coarse cache accounting is unavailable; writes are disabled".to_string())
    } else if failed_chunks > 0 {
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
        entry_count: telemetry.entries,
        max_entries: telemetry.entry_budget,
        entry_used_percent: cache_used_percent(telemetry.entries, telemetry.entry_budget),
        evictions: telemetry.evictions,
        root: telemetry.root_dir.map(|root| root.display().to_string()),
        accounting_healthy: telemetry.accounting_healthy,
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

struct OpenRemoteDatasetContext {
    session: Arc<Mutex<Session>>,
    tx: BroadcastSender,
    terminal: DatasetOpenTerminal,
    dataset_runtime: DatasetRuntimeConfig,
    workspace: WorkspaceScope,
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
    context: OpenRemoteDatasetContext,
    operation_permit: OwnedRwLockReadGuard<()>,
) {
    let OpenRemoteDatasetRequest { request_id, url } = request;
    let OpenRemoteDatasetContext {
        session,
        tx,
        terminal,
        dataset_runtime,
        workspace,
    } = context;
    // Until admission succeeds, even a syntactically valid locator is
    // untrusted: it may contain credentials or a sensitive object/path.
    // Progress and failure envelopes therefore use a deliberately lossy
    // description. A successful terminal envelope can use the canonical URL
    // returned by the admission boundary.
    let safe_source = dataset_runtime.source_policy.redact_untrusted(&url);

    // Progress and terminal share one FIFO priority lane. This preserves
    // progress* -> exactly one terminal even while broadcast/bulk traffic is
    // continuously ready.
    let progress_tx = DatasetOpenProgressSender::new(
        request_id.clone(),
        safe_source.clone(),
        terminal.sender.clone(),
    );

    let ctx = DatasetOpenContext {
        session,
        tx,
        dataset_runtime,
        workspace,
        terminal: Some(terminal.clone()),
        #[cfg(test)]
        publication_barrier: None,
        #[cfg(test)]
        post_persist_barrier: None,
        #[cfg(test)]
        panic_commit_task: false,
    };
    let result = dataset_open::open_dataset_with_operation_permit(
        client_id,
        &url,
        &ctx,
        &progress_tx,
        operation_permit,
    )
    .await;

    match result {
        Ok(DatasetOpenOutcome::Opened {
            seq,
            opened,
            diagnostic,
            terminal_precommitted,
        }) => {
            if !terminal_precommitted {
                let admitted_url = diagnostic.source_url.clone();
                send_open_succeeded(
                    client_id,
                    &request_id,
                    &admitted_url,
                    seq,
                    *opened,
                    diagnostic,
                    &terminal,
                )
                .await;
            }
        }
        Ok(DatasetOpenOutcome::Cancelled) => {
            send_open_failed_reserved(
                client_id,
                &request_id,
                &safe_source,
                open_failure(
                    DatasetOpenStage::Complete,
                    DatasetOpenFailureKind::SessionClosed,
                    true,
                    "dataset open was cancelled because the session closed",
                    None,
                ),
                &terminal,
            )
            .await;
        }
        Err(diagnostic) => {
            send_open_failed_reserved(client_id, &request_id, &safe_source, diagnostic, &terminal)
                .await;
        }
    }
}

enum ChunkDispatch {
    Source {
        resolved: Result<String, crate::binding::ChunkResolveError>,
        level_info: Option<crate::binding::LevelInfo>,
        cache: Arc<CachedStore>,
    },
    Generated {
        level: u32,
        derived_chunks: Arc<DerivedChunkCache>,
        generated_service: Arc<GeneratedCoarseService>,
    },
}

/// Parse the wire `(t, c)` voxel coordinates from a canonical chunk key
/// (`"{level}/t/c/z/y/x"`). Malformed keys are rejected rather than being
/// silently redirected to the first timepoint and channel.
fn parse_t_c_from_chunk_key(key: &str) -> Option<(u64, u64)> {
    let mut parts = key.split('/');
    parts.next()?.parse::<u32>().ok()?;
    let t = parts.next()?.parse().ok()?;
    let c = parts.next()?.parse().ok()?;
    Some((t, c))
}

/// Read a chunk from a CachedStore and send it to the requesting client.
///
/// `object_path` is the typed result of resolving the object-store path. An
/// unknown image, malformed key, or bounds violation is preserved as its
/// exact protocol failure instead of being collapsed into a missing path.
///
/// `level_info` carries per-level compression, on-disk chunk_shape, and
/// the canonical-byte slice layout. The wire `(t, c)` coords are parsed
/// from `chunk_key` and reduced to intra-chunk indices via
/// `wire_value % chunk_shape[axis]`; the resulting `(offset, size)` from
/// [`ChunkByteLayout::checked_slice_range`] picks the requested timepoint/channel
/// out of the decompressed on-disk chunk.
#[derive(Debug)]
enum ChunkResponseSendError {
    Frame(lucida_protocol::ChunkFrameError),
    Outbox(OutboxSendError),
}

/// Validate the exact transport footprint without acquiring any outbound
/// queue/process reservation. Chunk bytes remain owned by the source or
/// generated-cache memory budget while backend I/O runs; the egress
/// reservation is acquired only immediately before encoding.
fn validate_chunk_frame(
    sender: &UnicastSender,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    payload_len: usize,
) -> Result<usize, ChunkResponseSendError> {
    let frame_len = chunk_frame_len(dataset_id, image_id, chunk_key, payload_len)
        .map_err(ChunkResponseSendError::Frame)?;
    sender
        .validate_intrinsic(frame_len)
        .map_err(ChunkResponseSendError::Outbox)?;
    Ok(frame_len)
}

/// Encode after the exact frame length has been charged,
/// then transfer that unchanged charge into the queue.
fn enqueue_chunk_frame(
    reservation: OutboxReservation,
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    payload: &[u8],
) -> Result<(), ChunkResponseSendError> {
    let frame = encode_chunk_frame(client_id, dataset_id, image_id, chunk_key, payload)
        .map_err(ChunkResponseSendError::Frame)?;
    reservation
        .commit(Message::Binary(frame.into()))
        .map_err(ChunkResponseSendError::Outbox)
}

// Internal helper threading per-request state from the dispatch site;
// extracting a struct would just push the bundle one frame up.
#[allow(clippy::too_many_arguments)]
async fn serve_chunk_from_store(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    object_path: Result<String, crate::binding::ChunkResolveError>,
    level_info: Option<crate::binding::LevelInfo>,
    cache: &Arc<CachedStore>,
    unicast_routes: &UnicastRoutes,
) {
    let object_path = match object_path {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(
                dataset = %dataset_id,
                image = %image_id,
                key = chunk_key,
                error = %error,
                "chunk.resolve_rejected"
            );
            send_source_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                error.failure(),
                Some(error.public_message().to_string()),
                unicast_routes,
            )
            .await;
            return;
        }
    };

    let Some(level_info) = level_info else {
        send_source_chunk_status(
            client_id,
            dataset_id,
            image_id,
            chunk_key,
            FailureDescriptor::new(FailureCode::MissingChunkMetadata, false),
            Some("chunk level is missing validated storage metadata".to_string()),
            unicast_routes,
        )
        .await;
        return;
    };

    // Import admission is the primary guard, but binding metadata is
    // serializable and older persisted values must be treated as untrusted at
    // the allocation boundary too. Validate before the reservation, backend
    // read, decoder, and especially the sparse zero-fill allocation.
    if let Err(error) = level_info.chunk_byte_layout.validate_admitted() {
        send_source_chunk_status(
            client_id,
            dataset_id,
            image_id,
            chunk_key,
            error.failure(),
            Some(error.public_message()),
            unicast_routes,
        )
        .await;
        return;
    }

    // The selected source slice has a validated, exact wire length. Reject an
    // intrinsically impossible response before the store read/decode, but do
    // not reserve egress capacity while those independently bounded owners
    // are doing I/O or payload work.
    let Some((wire_t, wire_c)) = parse_t_c_from_chunk_key(chunk_key) else {
        send_source_chunk_status(
            client_id,
            dataset_id,
            image_id,
            chunk_key,
            FailureDescriptor::new(FailureCode::InvalidChunkKey, false),
            Some("chunk key is malformed".to_string()),
            unicast_routes,
        )
        .await;
        return;
    };
    let range = match level_info
        .chunk_byte_layout
        .checked_slice_range(wire_t, wire_c)
    {
        Ok(range) if range.end <= level_info.chunk_byte_layout.on_disk_byte_size => range,
        Ok(range) => {
            send_source_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                FailureDescriptor::new(FailureCode::ChunkOutOfBounds, false),
                Some(format!(
                    "validated chunk slice {}..{} exceeds admitted size {}",
                    range.start, range.end, level_info.chunk_byte_layout.on_disk_byte_size
                )),
                unicast_routes,
            )
            .await;
            return;
        }
        Err(error) => {
            send_source_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                FailureDescriptor::new(FailureCode::ChunkOutOfBounds, false),
                Some(format!("invalid chunk byte layout: {error}")),
                unicast_routes,
            )
            .await;
            return;
        }
    };
    let sender = {
        let senders = unicast_routes.lock().await;
        senders.get(&client_id).cloned()
    };
    let Some(sender) = sender else {
        return;
    };
    let frame_len =
        match validate_chunk_frame(&sender, dataset_id, image_id, chunk_key, range.len()) {
            Ok(frame_len) => frame_len,
            Err(ChunkResponseSendError::Outbox(OutboxSendError::Oversized)) => {
                send_source_chunk_status(
                    client_id,
                    dataset_id,
                    image_id,
                    chunk_key,
                    FailureDescriptor::new(FailureCode::ResourceLimit, false),
                    Some("chunk response exceeds the configured transport limit".to_string()),
                    unicast_routes,
                )
                .await;
                return;
            }
            Err(ChunkResponseSendError::Frame(error)) => {
                tracing::error!(
                    client_id,
                    dataset = %dataset_id,
                    image = %image_id,
                    key = chunk_key,
                    error = %error,
                    "chunk.frame_preflight_failed"
                );
                send_source_chunk_status(
                    client_id,
                    dataset_id,
                    image_id,
                    chunk_key,
                    FailureDescriptor::new(FailureCode::Protocol, false),
                    Some("chunk response could not be framed".to_string()),
                    unicast_routes,
                )
                .await;
                return;
            }
            Err(ChunkResponseSendError::Outbox(error)) => {
                tracing::warn!(
                    client_id,
                    dataset = %dataset_id,
                    image = %image_id,
                    key = chunk_key,
                    error = %error,
                    "chunk.outbox_rejected"
                );
                return;
            }
        };

    tracing::trace!(dataset = %dataset_id, image = %image_id, key = chunk_key, path = %object_path, "serving chunk");
    let Some(_decoded_reservation) = cache.reserve_resident(
        MemoryCategory::Decoded,
        level_info.chunk_byte_layout.on_disk_byte_size,
    ) else {
        send_source_chunk_status(
            client_id,
            dataset_id,
            image_id,
            chunk_key,
            FailureDescriptor::new(FailureCode::ResourceLimit, true),
            Some("process memory budget is full; retry this chunk".to_string()),
            unicast_routes,
        )
        .await;
        return;
    };
    let obj_path = Path::from(object_path.as_str());
    let bytes: Vec<u8> = match cache.get_bytes(&obj_path).await {
        Ok(storage_bytes) => {
            // Decode storage compression to the exact import-admitted size.
            // No codec header or streaming decoder may expand this allocation.
            match decode_storage_bytes_exact(
                &storage_bytes,
                level_info.compression,
                level_info.chunk_byte_layout.on_disk_byte_size,
            ) {
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
                    tracing::warn!(
                        client_id,
                        dataset = %dataset_id,
                        image = %image_id,
                        key = chunk_key,
                        error = %e,
                        "chunk.decode_failed"
                    );
                    send_source_chunk_status(
                        client_id,
                        dataset_id,
                        image_id,
                        chunk_key,
                        e.failure(),
                        Some(format!("source chunk failed validated decoding: {e}")),
                        unicast_routes,
                    )
                    .await;
                    return;
                }
            }
        }
        Err(e) if is_not_found(&e) => {
            vec![0_u8; level_info.chunk_byte_layout.on_disk_byte_size]
        }
        Err(e) => {
            // A non-not-found store failure (revoked access, backend fault,
            // unreachable service) must reach the requesting client as an
            // explicit status frame: from its side the alternative is a
            // request timeout, which it has to treat as transient, so a
            // dead source would never surface.
            tracing::warn!(
                dataset = %dataset_id,
                image = %image_id,
                key = chunk_key,
                error = %e,
                "chunk.source_read_failed"
            );
            let terminal = lucida_store::backend::StoreError::from(e);
            send_source_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                terminal.failure(),
                Some(terminal.public_message()),
                unicast_routes,
            )
            .await;
            return;
        }
    };

    // The preflight range was checked against the admitted decoded size;
    // retain this runtime check before slicing backend-supplied bytes.
    if range.end > bytes.len() {
        send_source_chunk_status(
            client_id,
            dataset_id,
            image_id,
            chunk_key,
            FailureDescriptor::new(FailureCode::ChunkOutOfBounds, false),
            Some(format!(
                "validated chunk slice {}..{} exceeds decoded size {}",
                range.start,
                range.end,
                bytes.len()
            )),
            unicast_routes,
        )
        .await;
        return;
    }
    let reservation = match sender.reserve(frame_len) {
        Ok(reservation) => reservation,
        Err(OutboxSendError::Oversized) => {
            send_source_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                FailureDescriptor::new(FailureCode::ResourceLimit, false),
                Some("chunk response exceeds the configured transport limit".to_string()),
                unicast_routes,
            )
            .await;
            return;
        }
        Err(error) => {
            // Drop the independently bounded decoded payload without pinning
            // any hypothetical egress capacity across its read. Process
            // pressure independently targets the actual largest holder.
            tracing::warn!(
                client_id,
                dataset = %dataset_id,
                image = %image_id,
                key = chunk_key,
                error = %error,
                "chunk.outbox_rejected"
            );
            return;
        }
    };
    match enqueue_chunk_frame(
        reservation,
        client_id,
        dataset_id,
        image_id,
        chunk_key,
        &bytes[range],
    ) {
        Ok(()) => {}
        Err(ChunkResponseSendError::Outbox(OutboxSendError::Oversized)) => {
            send_source_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                FailureDescriptor::new(FailureCode::ResourceLimit, false),
                Some("chunk response exceeds the configured transport limit".to_string()),
                unicast_routes,
            )
            .await;
        }
        Err(ChunkResponseSendError::Frame(error)) => {
            tracing::error!(
                client_id,
                dataset = %dataset_id,
                image = %image_id,
                key = chunk_key,
                error = %error,
                "chunk.frame_encode_failed"
            );
            send_source_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                FailureDescriptor::new(FailureCode::Protocol, false),
                Some("chunk response could not be framed".to_string()),
                unicast_routes,
            )
            .await;
        }
        Err(ChunkResponseSendError::Outbox(
            error @ OutboxSendError::ReservationMismatch { .. },
        )) => {
            tracing::error!(
                client_id,
                dataset = %dataset_id,
                image = %image_id,
                key = chunk_key,
                error = %error,
                "chunk.frame_encode_failed"
            );
            send_source_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                FailureDescriptor::new(FailureCode::Protocol, false),
                Some("chunk response could not be framed".to_string()),
                unicast_routes,
            )
            .await;
        }
        Err(ChunkResponseSendError::Outbox(error)) => {
            tracing::warn!(
                client_id,
                dataset = %dataset_id,
                image = %image_id,
                key = chunk_key,
                error = %error,
                "chunk.outbox_rejected"
            );
        }
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
        DerivedChunkLookup::Ready(ready) => {
            let sender = {
                let senders = unicast_routes.lock().await;
                senders.get(&client_id).cloned()
            };
            let Some(sender) = sender else {
                return;
            };
            let frame_len =
                match validate_chunk_frame(&sender, dataset_id, image_id, chunk_key, ready.len()) {
                    Ok(frame_len) => frame_len,
                    Err(ChunkResponseSendError::Outbox(OutboxSendError::Oversized)) => {
                        send_generated_chunk_status(
                            client_id,
                            dataset_id,
                            image_id,
                            chunk_key,
                            GeneratedChunkStatus::FailedPermanent,
                            Some(FailureDescriptor::new(FailureCode::ResourceLimit, false)),
                            Some(
                                "chunk response exceeds the configured transport limit".to_string(),
                            ),
                            unicast_routes,
                        )
                        .await;
                        return;
                    }
                    Err(ChunkResponseSendError::Frame(error)) => {
                        tracing::error!(
                            client_id,
                            dataset = %dataset_id,
                            image = %image_id,
                            key = chunk_key,
                            error = %error,
                            "chunk.frame_preflight_failed"
                        );
                        send_generated_chunk_status(
                            client_id,
                            dataset_id,
                            image_id,
                            chunk_key,
                            GeneratedChunkStatus::FailedPermanent,
                            Some(FailureDescriptor::new(FailureCode::Protocol, false)),
                            Some("generated chunk response could not be framed".to_string()),
                            unicast_routes,
                        )
                        .await;
                        return;
                    }
                    Err(ChunkResponseSendError::Outbox(error)) => {
                        tracing::warn!(
                            client_id,
                            dataset = %dataset_id,
                            image = %image_id,
                            key = chunk_key,
                            error = %error,
                            "chunk.outbox_rejected"
                        );
                        return;
                    }
                };
            let read_result = ready.read_async().await;
            let Some(bytes) = resolve_generated_chunk_read(
                read_result,
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                unicast_routes,
            )
            .await
            else {
                return;
            };
            let reservation = match sender.reserve(frame_len) {
                Ok(reservation) => reservation,
                Err(OutboxSendError::Oversized) => {
                    send_generated_chunk_status(
                        client_id,
                        dataset_id,
                        image_id,
                        chunk_key,
                        GeneratedChunkStatus::FailedPermanent,
                        Some(FailureDescriptor::new(FailureCode::ResourceLimit, false)),
                        Some("chunk response exceeds the configured transport limit".to_string()),
                        unicast_routes,
                    )
                    .await;
                    return;
                }
                Err(error) => {
                    tracing::warn!(
                        client_id,
                        dataset = %dataset_id,
                        image = %image_id,
                        key = chunk_key,
                        error = %error,
                        "chunk.outbox_rejected"
                    );
                    return;
                }
            };
            match enqueue_chunk_frame(
                reservation,
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                &bytes,
            ) {
                Ok(()) => {}
                Err(ChunkResponseSendError::Frame(error)) => {
                    tracing::error!(
                        client_id,
                        dataset = %dataset_id,
                        image = %image_id,
                        key = chunk_key,
                        error = %error,
                        "chunk.frame_encode_failed"
                    );
                    send_generated_chunk_status(
                        client_id,
                        dataset_id,
                        image_id,
                        chunk_key,
                        GeneratedChunkStatus::FailedPermanent,
                        Some(FailureDescriptor::new(FailureCode::Protocol, false)),
                        Some("generated chunk response could not be framed".to_string()),
                        unicast_routes,
                    )
                    .await;
                }
                Err(ChunkResponseSendError::Outbox(
                    error @ OutboxSendError::ReservationMismatch { .. },
                )) => {
                    tracing::error!(
                        client_id,
                        dataset = %dataset_id,
                        image = %image_id,
                        key = chunk_key,
                        error = %error,
                        "chunk.frame_encode_failed"
                    );
                    send_generated_chunk_status(
                        client_id,
                        dataset_id,
                        image_id,
                        chunk_key,
                        GeneratedChunkStatus::FailedPermanent,
                        Some(FailureDescriptor::new(FailureCode::Protocol, false)),
                        Some("generated chunk response could not be framed".to_string()),
                        unicast_routes,
                    )
                    .await;
                }
                Err(ChunkResponseSendError::Outbox(error)) => {
                    tracing::warn!(
                        client_id,
                        dataset = %dataset_id,
                        image = %image_id,
                        key = chunk_key,
                        error = %error,
                        "chunk.outbox_rejected"
                    );
                }
            }
        }
        DerivedChunkLookup::Status {
            status,
            failure,
            message,
        } => {
            send_generated_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                status,
                failure.or_else(|| status.failure_descriptor()),
                message,
                unicast_routes,
            )
            .await;
        }
    }
}

async fn resolve_generated_chunk_read(
    read_result: Result<std::io::Result<Option<GeneratedReadyBytes>>, tokio::task::JoinError>,
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    unicast_routes: &UnicastRoutes,
) -> Option<GeneratedReadyBytes> {
    match read_result {
        Ok(Ok(Some(bytes))) => Some(bytes),
        Ok(Ok(None)) => {
            send_generated_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                GeneratedChunkStatus::Unavailable,
                Some(FailureDescriptor::new(FailureCode::Persistence, true)),
                Some(
                    "generated chunk was superseded or evicted before it could be read".to_string(),
                ),
                unicast_routes,
            )
            .await;
            None
        }
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::OutOfMemory => {
            send_generated_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                GeneratedChunkStatus::Unavailable,
                Some(FailureDescriptor::new(FailureCode::ResourceLimit, true)),
                Some("process memory budget is full; retry this chunk".to_string()),
                unicast_routes,
            )
            .await;
            None
        }
        Ok(Err(error)) => {
            tracing::warn!(
                client_id,
                dataset = %dataset_id,
                image = %image_id,
                key = chunk_key,
                error = %error,
                "generated_chunk.disk_read_failed"
            );
            send_generated_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                GeneratedChunkStatus::FailedTransient,
                Some(FailureDescriptor::new(FailureCode::Persistence, true)),
                Some("generated chunk could not be read from the derived cache".to_string()),
                unicast_routes,
            )
            .await;
            None
        }
        Err(error) => {
            tracing::error!(
                client_id,
                dataset = %dataset_id,
                image = %image_id,
                key = chunk_key,
                error = %error,
                "generated_chunk.blocking_read_failed"
            );
            send_generated_chunk_status(
                client_id,
                dataset_id,
                image_id,
                chunk_key,
                GeneratedChunkStatus::FailedTransient,
                Some(FailureDescriptor::new(FailureCode::Persistence, true)),
                Some("generated chunk reader stopped before completing the request".to_string()),
                unicast_routes,
            )
            .await;
            None
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
    failure: FailureDescriptor,
    message: Option<String>,
    unicast_routes: &UnicastRoutes,
) {
    let status = if failure.retryable {
        SourceChunkStatus::Unavailable
    } else {
        SourceChunkStatus::FailedPermanent
    };
    let msg = ServerMessage::SourceChunkStatus {
        dataset_id: dataset_id.clone(),
        image_id: image_id.clone(),
        key: chunk_key.to_string(),
        status,
        failure,
        message,
    };
    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send_json(&msg, DEFAULT_OUTBOX_BYTES);
    }
}

// Transport adapter: the explicit identity tuple mirrors the wire envelope
// and keeps status, descriptor, and message adjacent at every call site.
#[allow(clippy::too_many_arguments)]
async fn send_generated_chunk_status(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    status: GeneratedChunkStatus,
    failure: Option<FailureDescriptor>,
    message: Option<String>,
    unicast_routes: &UnicastRoutes,
) {
    let msg = ServerMessage::GeneratedChunkStatus {
        dataset_id: dataset_id.clone(),
        image_id: image_id.clone(),
        key: chunk_key.to_string(),
        status,
        failure,
        message,
    };
    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send_json(&msg, DEFAULT_OUTBOX_BYTES);
    }
}

/// Send a dataset-open progress message to the requesting client.
async fn send_open_progress(
    client_id: ClientId,
    request_id: &str,
    url: &str,
    diagnostic: DatasetOpenProgressDiagnostic,
    sender: &UnicastSender,
) {
    tracing::info!(
        client_id = %client_id,
        request_id = %request_id,
        stage = ?diagnostic.stage,
        message = %diagnostic.message,
        "open_remote_dataset.progress"
    );
    let msg = ServerMessage::DatasetOpenProgress {
        request_id: request_id.to_string(),
        url: url.to_string(),
        diagnostic,
    };
    let _ = sender.send_json_best_effort(&msg, DEFAULT_OUTBOX_BYTES);
}

/// Send an OpenDatasetSucceeded message to the requesting client.
async fn send_open_succeeded(
    client_id: ClientId,
    request_id: &str,
    url: &str,
    seq: u64,
    opened: DatasetOpened,
    diagnostic: DatasetOpenSuccessDiagnostic,
    terminal: &DatasetOpenTerminal,
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
        &terminal.sender,
    )
    .await;
    tracing::info!(
        client_id = %client_id,
        request_id = %request_id,
        seq,
        "open_remote_dataset.succeeded"
    );
    let summary = OpenedDatasetSummary {
        workspace_dataset_id: opened.manifest.dataset_id.clone(),
        name: opened.manifest.name.clone(),
        image_count: opened.manifest.images().len(),
        entity_count: opened.manifest.entities().len(),
    };
    let msg = ServerMessage::OpenDatasetSucceeded {
        request_id: request_id.to_string(),
        url: url.to_string(),
        seq,
        summary: Some(summary),
        opened: Some(opened),
        diagnostic: Some(diagnostic),
    };
    let _ = terminal.publish_json(&msg, DEFAULT_OUTBOX_BYTES);
}

/// Publish an authoritative dataset-open failure through the message-count
/// slot reserved when the request was admitted. Best-effort progress may own
/// every other control-lane permit without suppressing this terminal.
async fn send_open_failed_reserved(
    client_id: ClientId,
    request_id: &str,
    url: &str,
    diagnostic: DatasetOpenFailureDiagnostic,
    terminal: &DatasetOpenTerminal,
) {
    tracing::warn!(
        client_id = %client_id,
        request_id = %request_id,
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
    let _ = terminal.publish_json(&msg, DEFAULT_OUTBOX_BYTES);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset_open::ProgressSink;
    use crate::outbox::{
        UnicastReceiver, two_unicast_channels_with_process_budget, unicast_channel,
        unicast_channel_with_process_budget,
    };
    use crate::test_fixtures::single_image_manifest;

    fn dataset_opened_fixture(opener: ClientId) -> DatasetOpened {
        let manifest = single_image_manifest();
        let image_id = manifest.images()[0].image_id.clone();
        DatasetOpened {
            manifest,
            fetch: lucida_protocol::FetchSource::Proxied(lucida_protocol::ProxiedFetchDescriptor {
                images: vec![lucida_protocol::ProxiedImageSpec {
                    image_id,
                    wire_format: lucida_protocol::WireFormat::Raw {
                        data_type: lucida_content::DataType::Uint16,
                    },
                }],
            }),
            opener_client_id: Some(opener),
        }
    }

    async fn receive_server_messages(
        receiver: &mut UnicastReceiver,
        count: usize,
    ) -> Vec<ServerMessage> {
        let mut messages = Vec::with_capacity(count);
        for _ in 0..count {
            let Message::Text(text) = receiver.recv().await.expect("control-lane message") else {
                panic!("dataset-open control lane emitted a non-JSON frame")
            };
            messages.push(serde_json::from_str(text.as_str()).expect("valid server message"));
        }
        messages
    }

    fn rapid_progress(index: usize) -> DatasetOpenProgressDiagnostic {
        open_progress(
            DatasetOpenStage::MetadataImport,
            format!("rapid progress {index}"),
            None,
            None,
            None,
        )
    }

    fn resource_failure(message: impl Into<String>) -> DatasetOpenFailureDiagnostic {
        open_failure(
            DatasetOpenStage::MetadataImport,
            DatasetOpenFailureKind::ResourceLimit,
            true,
            message,
            None,
        )
    }

    fn generated_level_fixture(image_id: &str, level_index: u32) -> GeneratedLevelAvailability {
        GeneratedLevelAvailability {
            image_id: ImageId(image_id.into()),
            info: GeneratedLevelInfo {
                level_index,
                role: GeneratedLevelRole::Coarse,
                provenance: GeneratedLevelProvenance::default(),
            },
            level: LevelGeometry {
                level_index,
                shape: [1; 5],
                chunk_shape: [1; 5],
                grid_shape: [1; 5],
                scale: [1.0; 5],
            },
            summary: None,
        }
    }

    #[tokio::test]
    async fn principal_request_budget_rejects_parallel_work_across_connections() {
        let budget = Arc::new(Semaphore::new(1));
        let mut first_connection = Vec::new();
        let mut second_connection = Vec::new();
        let (_release, wait) = tokio::sync::oneshot::channel::<()>();
        assert!(spawn_connection_task(
            &mut first_connection,
            &budget,
            async move {
                let _ = wait.await;
            },
        ));
        assert!(!spawn_connection_task(
            &mut second_connection,
            &budget,
            async {},
        ));
        let task = first_connection.pop().unwrap();
        task.abort();
        let _ = task.await;
        assert!(
            spawn_connection_task(&mut second_connection, &budget, async {}),
            "disconnect cancellation must immediately return the principal permit"
        );
        for task in second_connection {
            task.abort();
        }
    }

    #[tokio::test]
    async fn per_connection_request_task_count_is_a_hard_ceiling() {
        let budget = Arc::new(Semaphore::new(MAX_CONNECTION_REQUEST_TASKS + 1));
        let mut tasks = Vec::new();
        let gate = Arc::new(tokio::sync::Notify::new());
        for _ in 0..MAX_CONNECTION_REQUEST_TASKS {
            let gate = Arc::clone(&gate);
            assert!(spawn_connection_task(&mut tasks, &budget, async move {
                gate.notified().await;
            }));
        }
        assert!(!spawn_connection_task(&mut tasks, &budget, async {}));
        assert_eq!(tasks.len(), MAX_CONNECTION_REQUEST_TASKS);
        for task in tasks {
            task.abort();
        }
    }

    #[tokio::test]
    async fn repeated_ping_waits_for_each_bounded_pong_flush() {
        let mut socket_budget =
            SocketWriteBudget::new_for_test(1_024, 4_096).expect("isolated socket budget");
        let initial_capacity = socket_budget.reserved_bytes();
        assert_eq!(socket_budget.process_queued_bytes(), initial_capacity);
        let (control_tx, mut control_rx) = tokio::sync::mpsc::channel::<CodecControlRequest>(1);

        let producer = tokio::spawn(async move {
            assert!(
                send_codec_control_and_wait(
                    &control_tx,
                    Message::Pong(vec![1_u8; 125].into()),
                    Duration::from_secs(5),
                )
                .await
            );
            assert!(
                send_codec_control_and_wait(
                    &control_tx,
                    Message::Pong(vec![2_u8; 125].into()),
                    Duration::from_secs(5),
                )
                .await
            );
        });

        let CodecControlRequest::Message(first_message, first_completion) =
            control_rx.recv().await.unwrap()
        else {
            panic!("Ping must request an explicit Pong")
        };
        let mut first = reserve_process_message(first_message, &socket_budget).unwrap();
        socket_budget.admit(&mut first).unwrap();
        let one_pong_capacity = socket_budget.reserved_bytes();
        let one_pong_process_bytes = socket_budget.process_queued_bytes();
        assert!(one_pong_capacity > initial_capacity);
        tokio::task::yield_now().await;
        assert!(
            control_rx.try_recv().is_err(),
            "the next Ping cannot be polled and forwarded before this Pong flushes"
        );

        // `send_socket_bounded` drops its payload guard before acknowledging
        // completion to the reader.
        drop(first);
        first_completion.send(true).unwrap();
        let CodecControlRequest::Message(second_message, second_completion) =
            tokio::time::timeout(Duration::from_secs(1), control_rx.recv())
                .await
                .expect("second Pong follows the first completion")
                .unwrap()
        else {
            panic!("Ping must request an explicit Pong")
        };
        let mut second = reserve_process_message(second_message, &socket_budget).unwrap();
        socket_budget.admit(&mut second).unwrap();
        assert_eq!(
            socket_budget.reserved_bytes(),
            one_pong_capacity,
            "repeated Pings reuse one connection high-water, not one buffer per Ping"
        );
        assert_eq!(
            socket_budget.process_queued_bytes(),
            one_pong_process_bytes,
            "only one explicit/automatic-control replacement is live at once"
        );

        drop(second);
        second_completion.send(true).unwrap();
        producer.await.unwrap();
        assert_eq!(
            socket_budget.process_queued_bytes(),
            one_pong_capacity,
            "flushed payloads release while the socket's retained Vec remains charged"
        );
    }

    #[tokio::test]
    async fn peer_close_flushes_tungstenite_automatic_reply_without_second_close() {
        use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
        use tokio_tungstenite::tungstenite::protocol::Role;

        // Capacity 1 forces the close frame through partial/WouldBlock writes;
        // 1024 covers the initially-ready sink path that previously attempted
        // a second Close and hit SendAfterClosing.
        for io_capacity in [1, 1_024] {
            let (server_io, client_io) = tokio::io::duplex(io_capacity);
            let (server, client) = tokio::join!(
                tokio_tungstenite::WebSocketStream::from_raw_socket(server_io, Role::Server, None,),
                tokio_tungstenite::WebSocketStream::from_raw_socket(client_io, Role::Client, None,),
            );
            let (mut server_tx, mut server_rx) = server.split();
            let (mut client_tx, mut client_rx) = client.split();

            let client_close =
                tokio::spawn(async move { client_tx.send(TungsteniteMessage::Close(None)).await });
            let incoming = tokio::time::timeout(Duration::from_secs(1), server_rx.next())
                .await
                .expect("server observes peer Close")
                .expect("peer frame")
                .expect("valid close frame");
            assert!(matches!(incoming, TungsteniteMessage::Close(_)));
            client_close.await.unwrap().unwrap();

            // Reading the Close has already put tungstenite in ClosedByPeer
            // and queued its reply. The client must read concurrently for the
            // one-byte duplex variant to make progress through WouldBlock.
            let client_reply = tokio::spawn(async move { client_rx.next().await });
            let socket_budget =
                SocketWriteBudget::new_for_test(1_024, 4_096).expect("socket budget");
            assert!(
                flush_sink_bounded::<_, TungsteniteMessage>(
                    &mut server_tx,
                    socket_budget.overload_watch(),
                    Duration::from_secs(1),
                )
                .await,
                "automatic close reply flushes at duplex capacity {io_capacity}"
            );
            let reply = tokio::time::timeout(Duration::from_secs(1), client_reply)
                .await
                .expect("client receives automatic reply")
                .unwrap()
                .expect("client stream item")
                .expect("valid close reply");
            assert!(matches!(reply, TungsteniteMessage::Close(_)));
        }
    }

    #[tokio::test]
    async fn rapid_progress_keeps_reserved_success_terminal_last_in_four_slot_lane() {
        let (sender, mut receiver) =
            unicast_channel_with_process_budget(4, DEFAULT_OUTBOX_BYTES, 4 * 1024 * 1024);
        let pressure = sender.overload_watch();
        let slot = sender.reserve_terminal_slot().await.expect("terminal slot");
        let terminal = DatasetOpenTerminal::new("rapid-success".into(), sender.clone(), slot);
        let progress = DatasetOpenProgressSender::new(
            "rapid-success".into(),
            "safe source".into(),
            sender.clone(),
        );

        // Keep the receiver intentionally unpolled: the first three progress
        // observations fill the non-terminal permits and every later one is
        // a bounded best-effort drop.
        for index in 0..8 {
            progress.emit(rapid_progress(index));
        }
        let opened = dataset_opened_fixture(7);
        let diagnostic = crate::open_diagnostics::open_success("safe source", &opened, None);
        send_open_succeeded(
            7,
            "rapid-success",
            "safe source",
            11,
            opened,
            diagnostic,
            &terminal,
        )
        .await;

        assert_eq!(sender.metrics().rejected_full, 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), pressure.triggered())
                .await
                .is_err(),
            "best-effort progress drops must not schedule a 1013 close"
        );
        let messages = receive_server_messages(&mut receiver, 4).await;
        for (index, message) in messages[..3].iter().enumerate() {
            assert!(matches!(
                message,
                ServerMessage::DatasetOpenProgress { diagnostic, .. }
                    if diagnostic.message == format!("rapid progress {index}")
            ));
        }
        assert!(matches!(
            &messages[3],
            ServerMessage::OpenDatasetSucceeded { request_id, seq, .. }
                if request_id == "rapid-success" && *seq == 11
        ));
        assert!(
            receiver.try_recv().is_err(),
            "terminal is emitted exactly once"
        );
    }

    #[tokio::test]
    async fn rapid_progress_keeps_reserved_failure_terminal_last_in_four_slot_lane() {
        let (sender, mut receiver) =
            unicast_channel_with_process_budget(4, DEFAULT_OUTBOX_BYTES, 4 * 1024 * 1024);
        let pressure = sender.overload_watch();
        let slot = sender.reserve_terminal_slot().await.expect("terminal slot");
        let terminal = DatasetOpenTerminal::new("rapid-failure".into(), sender.clone(), slot);
        let progress = DatasetOpenProgressSender::new(
            "rapid-failure".into(),
            "safe source".into(),
            sender.clone(),
        );

        for index in 0..8 {
            progress.emit(rapid_progress(index));
        }
        send_open_failed_reserved(
            7,
            "rapid-failure",
            "safe source",
            resource_failure("rapid import failed"),
            &terminal,
        )
        .await;

        assert_eq!(sender.metrics().rejected_full, 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), pressure.triggered())
                .await
                .is_err(),
            "best-effort progress drops must not schedule a 1013 close"
        );
        let messages = receive_server_messages(&mut receiver, 4).await;
        for (index, message) in messages[..3].iter().enumerate() {
            assert!(matches!(
                message,
                ServerMessage::DatasetOpenProgress { diagnostic, .. }
                    if diagnostic.message == format!("rapid progress {index}")
            ));
        }
        assert!(matches!(
            &messages[3],
            ServerMessage::OpenDatasetFailed { request_id, error, .. }
                if request_id == "rapid-failure" && error == "rapid import failed"
        ));
        assert!(
            receiver.try_recv().is_err(),
            "terminal is emitted exactly once"
        );
    }

    #[tokio::test]
    async fn mandatory_terminal_process_full_forces_requester_overload_close() {
        // Two automatic-control baselines (127 each), plus the holder's
        // three-byte payload and 127-byte planner growth, exactly fill 384.
        let ((holder, holder_rx), (requester, mut requester_rx)) =
            two_unicast_channels_with_process_budget(4, DEFAULT_OUTBOX_BYTES, 384);
        let holder_pressure = holder.overload_watch();
        let requester_pressure = requester.overload_watch();
        let slot = requester
            .reserve_terminal_slot()
            .await
            .expect("requester terminal slot");
        let terminal = DatasetOpenTerminal::new("process-full".into(), requester.clone(), slot);
        holder
            .send(Message::Binary(vec![1, 2, 3].into()))
            .expect("fill process budget from the true holder");

        let message = ServerMessage::OpenDatasetFailed {
            request_id: "process-full".into(),
            url: "safe source".into(),
            error: "capacity exhausted".into(),
            diagnostic: None,
        };
        assert!(matches!(
            terminal.publish_json(&message, DEFAULT_OUTBOX_BYTES),
            Err(PreparedJsonError::Outbox(OutboxSendError::ProcessFull))
        ));
        holder_pressure.triggered().await;
        requester_pressure.triggered().await;

        // The first allocation failure correctly chooses the actual holder;
        // the authoritative-terminal wrapper additionally closes the
        // requester so it cannot remain open with no outcome.
        drop(holder);
        drop(holder_rx);
        let close = requester_rx
            .take_overload_close()
            .expect("requester 1013 after holder releases capacity");
        assert!(matches!(close.message(), Message::Close(Some(frame)) if frame.code == 1013));
        drop(close);
    }

    #[tokio::test]
    async fn dataset_open_early_terminals_restore_their_single_reserved_slot() {
        for path in [
            "import failure",
            "retry lookup failure",
            "spawn rejection",
            "session cancellation",
        ] {
            let (sender, mut receiver) =
                unicast_channel_with_process_budget(1, DEFAULT_OUTBOX_BYTES, 1024 * 1024);
            let slot = sender.reserve_terminal_slot().await.expect(path);
            let terminal = DatasetOpenTerminal::new(path.into(), sender.clone(), slot);
            send_open_failed_reserved(7, path, "safe source", resource_failure(path), &terminal)
                .await;
            let messages = receive_server_messages(&mut receiver, 1).await;
            assert!(matches!(
                &messages[0],
                ServerMessage::OpenDatasetFailed { request_id, .. } if request_id == path
            ));
            let restored =
                tokio::time::timeout(Duration::from_millis(100), sender.reserve_terminal_slot())
                    .await
                    .unwrap_or_else(|_| panic!("{path} leaked its reserved slot"))
                    .expect("lane remains open");
            drop(restored);
        }

        let (sender, mut receiver) =
            unicast_channel_with_process_budget(1, DEFAULT_OUTBOX_BYTES, 1024 * 1024);
        let slot = sender.reserve_terminal_slot().await.expect("dedup slot");
        let terminal = DatasetOpenTerminal::new("dedup success".into(), sender.clone(), slot);
        let opened = dataset_opened_fixture(7);
        let diagnostic = crate::open_diagnostics::open_success("safe source", &opened, None);
        send_open_succeeded(
            7,
            "dedup success",
            "safe source",
            1,
            opened,
            diagnostic,
            &terminal,
        )
        .await;
        let messages = receive_server_messages(&mut receiver, 1).await;
        assert!(matches!(
            &messages[0],
            ServerMessage::OpenDatasetSucceeded { request_id, .. }
                if request_id == "dedup success"
        ));
        let restored =
            tokio::time::timeout(Duration::from_millis(100), sender.reserve_terminal_slot())
                .await
                .expect("dedup success leaked its reserved slot")
                .expect("lane remains open");
        drop(restored);

        let (sender, receiver) =
            unicast_channel_with_process_budget(1, DEFAULT_OUTBOX_BYTES, 1024 * 1024);
        let slot = sender
            .reserve_terminal_slot()
            .await
            .expect("unpublished terminal slot");
        drop(DatasetOpenTerminal::new(
            "early abort".into(),
            sender.clone(),
            slot,
        ));
        let restored =
            tokio::time::timeout(Duration::from_millis(100), sender.reserve_terminal_slot())
                .await
                .expect("dropping an unpublished terminal leaked its slot")
                .expect("lane remains open");
        drop(restored);
        drop(receiver);
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
        });

        assert_eq!(stats.used_percent, 92);
        assert_eq!(stats.backend_errors, 1);
    }

    #[test]
    fn generated_coarse_health_reports_cache_and_recent_failures() {
        let snapshot = GeneratedAvailabilitySnapshot {
            levels: vec![generated_level_fixture("img-1", 3)],
            chunks: vec![lucida_protocol::GeneratedChunkStatusUpdate {
                image_id: ImageId("img-1".into()),
                level_index: 3,
                key: "3/0/0/0/0/0".into(),
                status: GeneratedChunkStatus::FailedTransient,
                failure: Some(FailureDescriptor::new(FailureCode::StorageBackend, true)),
                message: Some("temporary source error".into()),
            }],
        };
        let index = GeneratedAvailabilityIndex::from_snapshot(snapshot);
        let health = generated_coarse_health(
            Some(&index),
            Some(DerivedCacheTelemetry {
                storage: DerivedCacheStorage::Disk,
                bytes: 950,
                budget_bytes: Some(1000),
                entries: 95,
                entry_budget: Some(100),
                root_dir: Some(std::path::PathBuf::from("/tmp/generated")),
                evictions: 2,
                accounting_healthy: true,
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
    fn generated_coarse_health_exposes_fail_closed_cache_accounting() {
        let health = generated_coarse_health(
            None,
            Some(DerivedCacheTelemetry {
                storage: DerivedCacheStorage::Disk,
                bytes: 1_024,
                budget_bytes: Some(512),
                entries: 101,
                entry_budget: Some(100),
                root_dir: Some(std::path::PathBuf::from("/tmp/generated")),
                evictions: 0,
                accounting_healthy: false,
            }),
        );

        assert_eq!(health.status, DatasetHealthStatus::Degraded);
        assert!(!health.cache.as_ref().unwrap().accounting_healthy);
        assert_eq!(
            health.message.as_deref(),
            Some("generated coarse cache accounting is unavailable; writes are disabled")
        );
    }

    #[test]
    fn encode_chunk_frame_uses_normal_chunk_key_envelope() {
        let dataset_id = DatasetId("ds1".into());
        let image_id = ImageId("img1".into());
        let buf = encode_chunk_frame(9, &dataset_id, &image_id, "2/0/0/0/0/0", &[1, 2, 3]).unwrap();

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
        let (tx, mut rx) = unicast_channel(DEFAULT_OUTBOX_MESSAGES, DEFAULT_OUTBOX_BYTES);
        routes.lock().await.insert(5, tx);
        let store =
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let cache = Arc::new(CachedStore::new(store, 1024));
        let level_info = crate::binding::LevelInfo {
            level_index: 0,
            compression: crate::decode::StorageCompression::None,
            chunk_shape: vec![1, 1, 1, 1, 2],
            shape: [1, 1, 1, 1, 2],
            grid_shape: [1, 1, 1, 1, 1],
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
            Ok("missing".into()),
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

    #[tokio::test]
    async fn restored_oversized_layout_is_rejected_before_sparse_zero_fill() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = unicast_channel(DEFAULT_OUTBOX_MESSAGES, DEFAULT_OUTBOX_BYTES);
        routes.lock().await.insert(5, tx);
        let store =
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        // A deliberately huge process budget makes this test decisive: without
        // allocation-boundary layout validation, the reservation would succeed
        // and the missing-object path would attempt an enormous vec allocation.
        let cache = Arc::new(CachedStore::new(store, usize::MAX));
        let level_info = crate::binding::LevelInfo {
            level_index: 0,
            compression: crate::decode::StorageCompression::None,
            chunk_shape: vec![1, 1, 1, 1, 1],
            shape: [1; 5],
            grid_shape: [1; 5],
            chunk_byte_layout: lucida_store::layout::ChunkByteLayout {
                canonical_byte_size: 1,
                on_disk_byte_size: usize::MAX,
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
            Ok("missing".into()),
            Some(level_info),
            &cache,
            &routes,
        )
        .await;

        let Message::Text(json) = rx.recv().await.expect("terminal status") else {
            panic!("oversized restored metadata must not produce a binary allocation");
        };
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "source_chunk_status");
        assert_eq!(value["category"], "bounds");
        assert_eq!(value["code"], "unsupported_layout");
        assert_eq!(value["retryable"], false);
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn malformed_chunk_key_corpus_performs_zero_backend_reads() {
        use lucida_store::codec::StorageCompression;
        use lucida_store::import_types::{ImageBindingSeed, LevelBindingInfo, ServerBindingSeed};
        use lucida_store::layout::ChunkByteLayout;

        let image_id = ImageId("img1".into());
        let level_info = LevelBindingInfo {
            level_index: 0,
            compression: StorageCompression::None,
            chunk_shape: vec![1, 1, 1, 1, 1],
            shape: [16; 5],
            grid_shape: [16; 5],
            chunk_byte_layout: ChunkByteLayout {
                canonical_byte_size: 1,
                on_disk_byte_size: 1,
                byte_stride_t: 0,
                byte_stride_c: 0,
                chunk_size_t: 1,
                chunk_size_c: 1,
            },
        };
        let resolver = crate::binding::ChunkResolver::new(&ServerBindingSeed {
            images: vec![ImageBindingSeed {
                image_id: image_id.clone(),
                axes_names: ["t", "c", "z", "y", "x"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                store_prefix: None,
                levels: vec![level_info.clone()],
            }],
        });
        let cache = Arc::new(CachedStore::new(
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>,
            1_024,
        ));
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = unicast_channel(DEFAULT_OUTBOX_MESSAGES, DEFAULT_OUTBOX_BYTES);
        routes.lock().await.insert(5, tx);

        let mut malformed = vec![
            String::new(),
            "foo/bar".into(),
            "0/0/0/0/../0".into(),
            "0/0/0/0/0/0/secret".into(),
            "0/0/0/0/0/18446744073709551616".into(),
            "-1/0/0/0/0/0".into(),
        ];
        for value in 0..128_u64 {
            malformed.push(format!("1/0/0/0/0/{value}"));
            malformed.push(format!("0/0/0/0/{}/0", 16 + value));
        }

        for key in malformed {
            let object_path = resolver.resolve_checked(&image_id, &key);
            assert!(object_path.is_err(), "malformed key resolved: {key}");
            serve_chunk_from_store(
                5,
                &DatasetId("ds1".into()),
                &image_id,
                &key,
                object_path,
                Some(level_info.clone()),
                &cache,
                &routes,
            )
            .await;
            assert!(matches!(rx.recv().await, Some(Message::Text(_))));
        }

        let stats = cache.stats();
        assert_eq!(stats.hits, 0);
        assert_eq!(stats.misses, 0, "rejected keys reached the backend cache");
        assert_eq!(stats.backend_errors, 0);
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

    /// A memory store whose first source read remains paused until the test
    /// releases it. The pause sits below `CachedStore`, at the same async
    /// boundary as a slow remote object-store request.
    #[derive(Debug)]
    struct BlockingStore {
        inner: object_store::memory::InMemory,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    impl std::fmt::Display for BlockingStore {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("BlockingStore")
        }
    }

    #[async_trait::async_trait]
    impl object_store::ObjectStore for BlockingStore {
        async fn put_opts(
            &self,
            location: &Path,
            payload: object_store::PutPayload,
            opts: object_store::PutOptions,
        ) -> object_store::Result<object_store::PutResult> {
            self.inner.put_opts(location, payload, opts).await
        }

        async fn put_multipart_opts(
            &self,
            location: &Path,
            opts: object_store::PutMultipartOptions,
        ) -> object_store::Result<Box<dyn object_store::MultipartUpload>> {
            self.inner.put_multipart_opts(location, opts).await
        }

        async fn get_opts(
            &self,
            location: &Path,
            options: object_store::GetOptions,
        ) -> object_store::Result<object_store::GetResult> {
            self.entered.notify_one();
            self.release.notified().await;
            self.inner.get_opts(location, options).await
        }

        fn delete_stream(
            &self,
            locations: futures_util::stream::BoxStream<
                'static,
                object_store::Result<object_store::path::Path>,
            >,
        ) -> futures_util::stream::BoxStream<'static, object_store::Result<object_store::path::Path>>
        {
            self.inner.delete_stream(locations)
        }

        fn list(
            &self,
            prefix: Option<&Path>,
        ) -> futures_util::stream::BoxStream<'static, object_store::Result<object_store::ObjectMeta>>
        {
            self.inner.list(prefix)
        }

        async fn list_with_delimiter(
            &self,
            prefix: Option<&Path>,
        ) -> object_store::Result<object_store::ListResult> {
            self.inner.list_with_delimiter(prefix).await
        }

        async fn copy_opts(
            &self,
            from: &Path,
            to: &Path,
            options: object_store::CopyOptions,
        ) -> object_store::Result<()> {
            self.inner.copy_opts(from, to, options).await
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

        fn delete_stream(
            &self,
            locations: futures_util::stream::BoxStream<
                'static,
                object_store::Result<object_store::path::Path>,
            >,
        ) -> futures_util::stream::BoxStream<'static, object_store::Result<object_store::path::Path>>
        {
            let failure = self.0;
            locations
                .map(move |location| {
                    location?;
                    Err(FailingStore(failure).error())
                })
                .boxed()
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

        async fn copy_opts(
            &self,
            _from: &Path,
            _to: &Path,
            _options: object_store::CopyOptions,
        ) -> object_store::Result<()> {
            Err(self.error())
        }
    }

    fn tiny_level_info() -> crate::binding::LevelInfo {
        crate::binding::LevelInfo {
            level_index: 0,
            compression: crate::decode::StorageCompression::None,
            chunk_shape: vec![1, 1, 1, 1, 2],
            shape: [1, 1, 1, 1, 2],
            grid_shape: [1, 1, 1, 1, 1],
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
        let (tx, mut rx) = unicast_channel(DEFAULT_OUTBOX_MESSAGES, DEFAULT_OUTBOX_BYTES);
        routes.lock().await.insert(7, tx);
        let store = Arc::new(FailingStore(failure)) as Arc<dyn object_store::ObjectStore>;
        let cache = Arc::new(CachedStore::new(store, 1024));

        serve_chunk_from_store(
            7,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "0/0/0/0/0/0",
            Ok("some/object".into()),
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
        let (tx, mut rx) = unicast_channel(DEFAULT_OUTBOX_MESSAGES, DEFAULT_OUTBOX_BYTES);
        routes.lock().await.insert(5, tx);
        let store = object_store::memory::InMemory::new();
        object_store::ObjectStoreExt::put(
            &store,
            &Path::from("some/object"),
            object_store::PutPayload::from_static(&[1, 2, 3, 4]),
        )
        .await
        .unwrap();
        let cache = Arc::new(CachedStore::new(
            Arc::new(store) as Arc<dyn object_store::ObjectStore>,
            4_096,
        ));

        serve_chunk_from_store(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "0/0/0/0/0/0",
            Ok("some/object".into()),
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
    async fn stalled_source_read_leaves_shared_egress_budget_for_another_client() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let ((source_tx, mut source_rx), (other_tx, mut other_rx)) =
            two_unicast_channels_with_process_budget(4, 1_024, 1_600);
        let source_observer = source_tx.clone();
        routes.lock().await.insert(5, source_tx);
        let process_baseline = source_observer.process_queued_bytes();

        let inner = object_store::memory::InMemory::new();
        object_store::ObjectStoreExt::put(
            &inner,
            &Path::from("some/object"),
            object_store::PutPayload::from(vec![1_u8; 400]),
        )
        .await
        .unwrap();
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let entered_wait = entered.notified();
        let cache = Arc::new(CachedStore::new(
            Arc::new(BlockingStore {
                inner,
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
            }) as Arc<dyn object_store::ObjectStore>,
            4_096,
        ));
        let mut level_info = tiny_level_info();
        level_info.chunk_shape = vec![1, 1, 1, 1, 200];
        level_info.shape = [1, 1, 1, 1, 200];
        level_info.chunk_byte_layout.canonical_byte_size = 400;
        level_info.chunk_byte_layout.on_disk_byte_size = 400;

        let source_routes = Arc::clone(&routes);
        let source_task = tokio::spawn(async move {
            serve_chunk_from_store(
                5,
                &DatasetId("ds1".into()),
                &ImageId("img1".into()),
                "0/0/0/0/0/0",
                Ok("some/object".into()),
                Some(level_info),
                &cache,
                &source_routes,
            )
            .await;
        });
        tokio::time::timeout(Duration::from_secs(1), entered_wait)
            .await
            .expect("source read reached the blocking backend");

        assert_eq!(source_observer.queued_bytes(), 0);
        assert_eq!(
            source_observer.process_queued_bytes(),
            process_baseline,
            "a backend read may own cache memory, but no payload or socket-plan bytes"
        );

        other_tx
            .send(Message::Binary(vec![2_u8; 400].into()))
            .expect("the other client retains its independently admissible capacity");
        assert!(source_observer.process_queued_bytes() > process_baseline);
        assert!(matches!(other_rx.recv().await, Some(Message::Binary(_))));
        drop(other_tx);
        drop(other_rx);

        release.notify_one();
        source_task.await.unwrap();
        assert!(matches!(source_rx.recv().await, Some(Message::Binary(_))));
    }

    #[tokio::test]
    async fn source_chunk_over_transport_limit_returns_resource_status_without_close() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = unicast_channel(4, 512);
        routes.lock().await.insert(5, tx);
        let store = object_store::memory::InMemory::new();
        object_store::ObjectStoreExt::put(
            &store,
            &Path::from("some/object"),
            object_store::PutPayload::from(vec![3_u8; 600]),
        )
        .await
        .unwrap();
        let cache = Arc::new(CachedStore::new(
            Arc::new(store) as Arc<dyn object_store::ObjectStore>,
            4_096,
        ));
        let mut level_info = tiny_level_info();
        level_info.chunk_shape = vec![1, 1, 1, 1, 300];
        level_info.shape = [1, 1, 1, 1, 300];
        level_info.chunk_byte_layout.canonical_byte_size = 600;
        level_info.chunk_byte_layout.on_disk_byte_size = 600;

        serve_chunk_from_store(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "0/0/0/0/0/0",
            Ok("some/object".into()),
            Some(level_info),
            &cache,
            &routes,
        )
        .await;

        let Message::Text(json) = rx.recv().await.expect("resource status") else {
            panic!("oversized response must return text, not allocate a binary frame");
        };
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "source_chunk_status");
        assert_eq!(value["status"], "failed_permanent");
        // Source-status descriptors are flattened for compatibility with the
        // common failure-response envelope.
        assert_eq!(value["code"], "resource_limit");
        assert_eq!(value["retryable"], false);
        assert!(
            rx.try_recv().is_err(),
            "intrinsic size is not a slow client"
        );
        let stats = cache.stats();
        assert_eq!(stats.hits, 0);
        assert_eq!(stats.misses, 0, "over-limit response reached the store");
    }

    #[tokio::test]
    async fn source_chunk_over_process_transport_limit_is_permanent_before_cache_read() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        // The binary frame fits the connection's 1 KiB payload budget but its
        // payload-plus-socket high-water can never fit the isolated 1 KiB
        // process budget. The terminal status remains deliverable.
        let (tx, mut rx) = unicast_channel_with_process_budget(4, 1_024, 1_024);
        let metrics = tx.clone();
        routes.lock().await.insert(5, tx);
        let cache = Arc::new(CachedStore::new(
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>,
            4_096,
        ));
        let mut level_info = tiny_level_info();
        level_info.chunk_shape = vec![1, 1, 1, 1, 300];
        level_info.shape = [1, 1, 1, 1, 300];
        level_info.chunk_byte_layout.canonical_byte_size = 600;
        level_info.chunk_byte_layout.on_disk_byte_size = 600;

        serve_chunk_from_store(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "0/0/0/0/0/0",
            Ok("some/object".into()),
            Some(level_info),
            &cache,
            &routes,
        )
        .await;

        let Message::Text(json) = rx.recv().await.expect("resource status") else {
            panic!("process-intrinsic oversize must return a text status");
        };
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "source_chunk_status");
        assert_eq!(value["status"], "failed_permanent");
        assert_eq!(value["code"], "resource_limit");
        assert_eq!(value["retryable"], false);
        let stats = cache.stats();
        assert_eq!(stats.hits, 0);
        assert_eq!(
            stats.misses, 0,
            "process-intrinsic oversize reached the store"
        );
        assert_eq!(stats.backend_errors, 0);
        assert_eq!(metrics.metrics().rejected_oversized, 1);
        assert_eq!(metrics.metrics().rejected_process_full, 0);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), rx.recv())
                .await
                .is_err(),
            "process-intrinsic oversize must not schedule a slow-consumer close"
        );
    }

    #[tokio::test]
    async fn source_decode_failure_returns_one_terminal_structured_status() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        // The failed binary response nearly fills this outbox. Its preflight
        // reservation must be released before the small terminal status is
        // queued, otherwise this would be misreported as a slow consumer.
        let (tx, mut rx) = unicast_channel(4, 512);
        routes.lock().await.insert(5, tx);
        let store = object_store::memory::InMemory::new();
        object_store::ObjectStoreExt::put(
            &store,
            &Path::from("some/object"),
            object_store::PutPayload::from_static(&[1, 2, 3]),
        )
        .await
        .unwrap();
        let cache = Arc::new(CachedStore::new(
            Arc::new(store) as Arc<dyn object_store::ObjectStore>,
            4_096,
        ));
        let mut level_info = tiny_level_info();
        level_info.compression = crate::decode::StorageCompression::Lz4;
        level_info.chunk_shape = vec![1, 1, 1, 1, 200];
        level_info.shape = [1, 1, 1, 1, 200];
        level_info.chunk_byte_layout.canonical_byte_size = 400;
        level_info.chunk_byte_layout.on_disk_byte_size = 400;

        serve_chunk_from_store(
            5,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "0/0/0/0/0/0",
            Ok("some/object".into()),
            Some(level_info),
            &cache,
            &routes,
        )
        .await;

        let Message::Text(json) = rx.recv().await.expect("terminal status") else {
            panic!("decode failure must return a text status, never silence or bytes");
        };
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "source_chunk_status");
        assert_eq!(value["status"], "failed_permanent");
        assert_eq!(value["category"], "codec");
        assert_eq!(value["code"], "decode_failure");
        assert_eq!(value["retryable"], false);
        assert!(
            value["message"]
                .as_str()
                .unwrap()
                .contains("failed validated decoding")
        );
        assert!(
            rx.try_recv().is_err(),
            "one request has one terminal outcome"
        );
    }

    #[tokio::test]
    async fn backend_store_error_serving_source_chunk_reports_unavailable() {
        let value = serve_against_failing_store(StoreFailure::Backend).await;
        assert_eq!(value["type"], "source_chunk_status");
        assert_eq!(value["dataset_id"], "ds1");
        assert_eq!(value["image_id"], "img1");
        assert_eq!(value["key"], "0/0/0/0/0/0");
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["category"], "source");
        assert_eq!(value["code"], "storage_backend");
        assert_eq!(value["retryable"], true);
        assert_eq!(value["message"], "dataset storage backend is unavailable");
        assert!(!value.to_string().contains("503"));
    }

    #[tokio::test]
    async fn permission_store_error_serving_source_chunk_reports_failed_permanent() {
        let value = serve_against_failing_store(StoreFailure::PermissionDenied).await;
        assert_eq!(value["type"], "source_chunk_status");
        assert_eq!(value["status"], "failed_permanent");
        assert_eq!(value["category"], "authorization");
        assert_eq!(value["code"], "permission");
        assert_eq!(value["retryable"], false);
        assert_eq!(value["message"], "dataset source access was denied");
        assert!(!value.to_string().contains("403"));
    }

    #[tokio::test]
    async fn generated_ready_chunk_is_served_with_normal_chunk_frame() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = unicast_channel(DEFAULT_OUTBOX_MESSAGES, DEFAULT_OUTBOX_BYTES);
        routes.lock().await.insert(5, tx);

        let cache = Arc::new(DerivedChunkCache::default());
        cache.upsert_level(generated_level_fixture("img1", 2));
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
    async fn generated_chunk_over_transport_limit_returns_resource_status_without_close() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = unicast_channel(4, 512);
        routes.lock().await.insert(5, tx);

        let cache = Arc::new(DerivedChunkCache::default());
        cache.upsert_level(generated_level_fixture("img1", 2));
        cache.seed_ready_chunk(
            ImageId("img1".into()),
            2,
            "2/0/0/0/0/0".into(),
            vec![7; 600],
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

        let Message::Text(json) = rx.recv().await.expect("resource status") else {
            panic!("oversized generated response must return text");
        };
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "generated_chunk_status");
        assert_eq!(value["status"], "failed_permanent");
        // Generated statuses retain the optional descriptor as a nested
        // field, unlike the flattened source-status envelope.
        assert_eq!(value["failure"]["code"], "resource_limit");
        assert_eq!(value["failure"]["retryable"], false);
        assert!(
            rx.try_recv().is_err(),
            "intrinsic size is not a slow client"
        );
    }

    #[tokio::test]
    async fn disk_generated_chunk_over_transport_limit_is_rejected_before_payload_read() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = unicast_channel(4, 512);
        let metrics = tx.clone();
        routes.lock().await.insert(5, tx);

        let dir = tempfile::tempdir().unwrap();
        let resident = lucida_store::cache::SharedObjectCache::new(4_096, 4_096);
        let cache = Arc::new(DerivedChunkCache::new_on_disk_with_budgets(
            dir.path().to_path_buf(),
            [71; 16],
            None,
            Arc::clone(&resident),
        ));
        cache.upsert_level(generated_level_fixture("img1", 2));
        cache
            .put_ready_chunk_atomic(
                "identity",
                ImageId("img1".into()),
                2,
                "2/0/0/0/0/0".into(),
                vec![7; 600],
            )
            .unwrap();
        let before = resident.memory_snapshot();
        assert_eq!(cache.disk_payload_read_attempts(), 0);

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

        let Message::Text(json) = rx.recv().await.expect("resource status") else {
            panic!("oversized generated response must return text");
        };
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "generated_chunk_status");
        assert_eq!(value["status"], "failed_permanent");
        assert_eq!(value["failure"]["code"], "resource_limit");
        assert_eq!(value["failure"]["retryable"], false);
        assert_eq!(
            cache.disk_payload_read_attempts(),
            0,
            "transport rejection must not read the disk payload"
        );
        assert_eq!(
            resident.memory_snapshot().generated_ready_bytes,
            before.generated_ready_bytes,
            "transport rejection must not reserve or allocate generated payload memory"
        );
        assert_eq!(metrics.metrics().rejected_oversized, 1);
        assert_eq!(metrics.metrics().rejected_process_full, 0);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), rx.recv())
                .await
                .is_err(),
            "intrinsic disk payload size must not schedule a slow-consumer close"
        );
    }

    #[tokio::test]
    async fn disk_generated_memory_pressure_releases_outbox_before_resource_status() {
        let dir = tempfile::tempdir().unwrap();
        let writer = DerivedChunkCache::new_on_disk_with_budgets(
            dir.path().to_path_buf(),
            [72; 16],
            None,
            lucida_store::cache::SharedObjectCache::new(4_096, 4_096),
        );
        writer.upsert_level(generated_level_fixture("img1", 2));
        writer
            .put_ready_chunk_atomic(
                "identity",
                ImageId("img1".into()),
                2,
                "2/0/0/0/0/0".into(),
                vec![7; 400],
            )
            .unwrap();

        let resident = lucida_store::cache::SharedObjectCache::new(0, 0);
        let cache = Arc::new(DerivedChunkCache::new_on_disk_with_budgets(
            dir.path().to_path_buf(),
            [72; 16],
            None,
            Arc::clone(&resident),
        ));
        cache.upsert_level(generated_level_fixture("img1", 2));
        assert!(
            cache
                .load_ready_chunk(
                    "identity",
                    ImageId("img1".into()),
                    2,
                    "2/0/0/0/0/0".into(),
                    400,
                )
                .unwrap()
        );

        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = unicast_channel(4, 512);
        routes.lock().await.insert(5, tx);
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

        let Message::Text(json) = rx.recv().await.expect("resource status") else {
            panic!("memory pressure must return text");
        };
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["failure"]["code"], "resource_limit");
        assert_eq!(value["failure"]["retryable"], true);
        assert_eq!(cache.disk_payload_read_attempts(), 0);
        assert_eq!(resident.memory_snapshot().generated_ready_bytes, 0);
        assert!(
            rx.try_recv().is_err(),
            "one request has one terminal result"
        );
    }

    #[tokio::test]
    async fn generated_blocking_reader_panic_never_reserves_outbox_before_status() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = unicast_channel_with_process_budget(4, 512, 4_096);
        let sender = tx.clone();
        routes.lock().await.insert(5, tx);
        let dataset_id = DatasetId("ds1".into());
        let image_id = ImageId("img1".into());
        let chunk_key = "2/0/0/0/0/0";
        let ready = crate::generated_coarse::GeneratedChunkReadHandle::panicking_for_test(400);
        let process_baseline = sender.process_queued_bytes();
        validate_chunk_frame(&sender, &dataset_id, &image_id, chunk_key, ready.len())
            .expect("binary response is intrinsically admissible");
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(
            sender.process_queued_bytes(),
            process_baseline,
            "preflight must not reserve payload or grow the socket plan"
        );
        let read_result = ready.read_async().await;
        assert!(read_result.is_err(), "injected panic must become JoinError");

        assert!(
            resolve_generated_chunk_read(
                read_result,
                5,
                &dataset_id,
                &image_id,
                chunk_key,
                &routes,
            )
            .await
            .is_none()
        );

        let Message::Text(json) = rx.recv().await.expect("transient status") else {
            panic!("blocking reader failure must return text");
        };
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "generated_chunk_status");
        assert_eq!(value["status"], "failed_transient");
        assert_eq!(value["failure"]["code"], "persistence");
        assert_eq!(value["failure"]["retryable"], true);
        assert!(
            rx.try_recv().is_err(),
            "reader failure must not schedule an overload close"
        );
    }

    #[tokio::test]
    async fn generated_chunk_over_process_transport_limit_is_permanent_without_close() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = unicast_channel_with_process_budget(4, 1_024, 1_024);
        let metrics = tx.clone();
        routes.lock().await.insert(5, tx);

        let cache = Arc::new(DerivedChunkCache::default());
        cache.upsert_level(generated_level_fixture("img1", 2));
        cache.seed_ready_chunk(
            ImageId("img1".into()),
            2,
            "2/0/0/0/0/0".into(),
            vec![7; 600],
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

        let Message::Text(json) = rx.recv().await.expect("resource status") else {
            panic!("process-intrinsic generated oversize must return text");
        };
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "generated_chunk_status");
        assert_eq!(value["status"], "failed_permanent");
        assert_eq!(value["failure"]["code"], "resource_limit");
        assert_eq!(value["failure"]["retryable"], false);
        assert_eq!(metrics.metrics().rejected_oversized, 1);
        assert_eq!(metrics.metrics().rejected_process_full, 0);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), rx.recv())
                .await
                .is_err(),
            "process-intrinsic generated oversize must not schedule a slow-consumer close"
        );
    }

    #[tokio::test]
    async fn generated_pending_status_is_sent_as_text() {
        let routes: UnicastRoutes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = unicast_channel(DEFAULT_OUTBOX_MESSAGES, DEFAULT_OUTBOX_BYTES);
        routes.lock().await.insert(3, tx);

        send_generated_chunk_status(
            3,
            &DatasetId("ds1".into()),
            &ImageId("img1".into()),
            "2/0/0/0/0/0",
            GeneratedChunkStatus::Pending,
            None,
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
