use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};

use axum::extract::ws::{Message, Utf8Bytes};
use lucida_core::protocol::{ClientId, ServerMessage};
use lucida_core::quota::BoundedJsonError;
use serde::Serialize;
use thiserror::Error;
use tokio::sync::{Notify, broadcast, mpsc};

pub const DEFAULT_OUTBOX_MESSAGES: usize = 128;
pub const DEFAULT_OUTBOX_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_BROADCAST_MESSAGES: usize = 64;
pub const DEFAULT_BROADCAST_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_PROCESS_OUTBOX_BYTES: usize = 256 * 1024 * 1024;
/// Tungstenite retains the capacity of its per-socket write Vec after flush.
/// Bound it to exactly one maximum application payload plus the largest
/// unmasked server-frame header; [`SocketWriteBudget`] accounts the retained
/// high-water allocation until socket teardown.
pub(crate) const MAX_SOCKET_WRITE_FRAME_BYTES: usize = DEFAULT_OUTBOX_BYTES + 10;
pub(crate) const MAX_SOCKET_RETAINED_CAPACITY_BYTES: usize = MAX_SOCKET_WRITE_FRAME_BYTES * 2;
const MIN_SOCKET_WRITE_CAPACITY_BYTES: usize = 8;
/// Largest server-generated control frame tungstenite can append to a
/// partially drained application frame (2-byte header + 125-byte payload).
const MAX_AUTOMATIC_CONTROL_FRAME_BYTES: usize = 127;

static PROCESS_OUTBOX_BUDGET: LazyLock<Arc<ProcessOutboxBudget>> =
    LazyLock::new(|| Arc::new(ProcessOutboxBudget::new(DEFAULT_PROCESS_OUTBOX_BYTES)));
static GLOBAL_REJECTED_FULL: AtomicU64 = AtomicU64::new(0);
static GLOBAL_REJECTED_OVERSIZED: AtomicU64 = AtomicU64::new(0);
static GLOBAL_REJECTED_REQUEST_WORK: AtomicU64 = AtomicU64::new(0);
static GLOBAL_SLOW_CONSUMER_TIMEOUTS: AtomicU64 = AtomicU64::new(0);

/// A frame whose byte reservation remains live until the caller has finished
/// writing it to the socket. Dequeueing is not the end of the memory lifetime:
/// a slow socket can retain the frame for the full send timeout.
pub(crate) struct OutboxMessage {
    message: Option<Message>,
    _reservation: OutboundReservation,
    connection_budget: Option<Arc<ConnectionWireBudget>>,
    // Durable broadcast acknowledgements can carry a pre-persist fallback
    // capability because their recipient planner is not known until dequeue.
    wire_reservation: Option<ProcessReservation>,
}

impl OutboxMessage {
    fn local(
        message: Message,
        reservation: ByteReservation,
        connection_budget: Arc<ConnectionWireBudget>,
    ) -> Self {
        Self {
            message: Some(message),
            _reservation: OutboundReservation::Local {
                _reservation: reservation,
            },
            connection_budget: Some(connection_budget),
            wire_reservation: None,
        }
    }

    fn broadcast(
        message: Message,
        storage: Arc<BroadcastStorage>,
        wire_reservation: Option<ProcessReservation>,
    ) -> Self {
        Self {
            message: Some(message),
            _reservation: OutboundReservation::Broadcast { _storage: storage },
            connection_budget: None,
            wire_reservation,
        }
    }

    pub(crate) fn message(&self) -> &Message {
        self.message.as_ref().expect("outbox message present")
    }

    /// Move the frame into the socket send while retaining this guard until
    /// the send future resolves. Callers must keep (and then drop) the guard.
    pub(crate) fn take_message(&mut self) -> Message {
        self.message.take().expect("queued message present")
    }
}

/// Per-socket high-water charge for tungstenite's retained write-buffer Vec.
/// Growing the buffer is admitted before send; the largest reservation stays
/// live until this guard is dropped with the socket, even after the frame has
/// flushed and tungstenite has cleared only the Vec length.
pub(crate) struct SocketWriteBudget {
    connection: Arc<ConnectionWireBudget>,
}

impl SocketWriteBudget {
    pub(crate) fn new(max_bytes: usize) -> Result<Self, OutboxSendError> {
        Self::with_process_budget(max_bytes, Arc::clone(&PROCESS_OUTBOX_BUDGET))
    }

    fn with_process_budget(
        max_bytes: usize,
        process_budget: Arc<ProcessOutboxBudget>,
    ) -> Result<Self, OutboxSendError> {
        Ok(Self {
            connection: ConnectionWireBudget::new(max_bytes, process_budget)?,
        })
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(
        max_bytes: usize,
        process_max_bytes: usize,
    ) -> Result<Self, OutboxSendError> {
        Self::with_process_budget(
            max_bytes,
            Arc::new(ProcessOutboxBudget::new(process_max_bytes)),
        )
    }

    pub(crate) fn admit(&mut self, message: &mut OutboxMessage) -> Result<(), OutboxSendError> {
        let connection = message
            .connection_budget
            .as_ref()
            .unwrap_or(&self.connection);
        debug_assert!(
            Arc::ptr_eq(connection, &self.connection) || message.connection_budget.is_none(),
            "targeted frame crossed connection planners"
        );
        self.connection.plan_payload(
            message_bytes(message.message()),
            message.wire_reservation.take(),
        )
    }

    #[cfg(test)]
    pub(crate) fn reserved_bytes(&self) -> usize {
        self.connection.planned_capacity.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn process_queued_bytes(&self) -> usize {
        self.connection
            .process_budget
            .queued_bytes
            .load(Ordering::Acquire)
    }

    pub(crate) fn overload_watch(&self) -> OutboxOverloadWatch {
        self.connection.overload_watch()
    }
}

struct ConnectionWireState {
    planned_capacity: usize,
    reservations: Vec<ProcessReservation>,
}

/// One process-accounted owner for a WebSocket's queued payloads and retained
/// tungstenite write Vec. Both priority lanes and the sink share this object,
/// which makes future high-water capacity a monotonic connection property
/// rather than a per-message multiplier.
struct ConnectionWireBudget {
    process_budget: Arc<ProcessOutboxBudget>,
    max_bytes: usize,
    queued_bytes: Arc<AtomicUsize>,
    overloaded: Arc<AtomicBool>,
    overload_notify: Arc<Notify>,
    planned_capacity: AtomicUsize,
    state: Mutex<ConnectionWireState>,
}

impl ConnectionWireBudget {
    fn new(
        max_bytes: usize,
        process_budget: Arc<ProcessOutboxBudget>,
    ) -> Result<Arc<Self>, OutboxSendError> {
        let connection = Arc::new(Self {
            process_budget: Arc::clone(&process_budget),
            max_bytes: max_bytes.max(1),
            queued_bytes: Arc::new(AtomicUsize::new(0)),
            overloaded: Arc::new(AtomicBool::new(false)),
            overload_notify: Arc::new(Notify::new()),
            planned_capacity: AtomicUsize::new(0),
            state: Mutex::new(ConnectionWireState {
                planned_capacity: 0,
                reservations: Vec::new(),
            }),
        });
        process_budget.register_connection(&connection);
        let baseline = reserve_process_bytes_owned(
            &process_budget,
            MAX_AUTOMATIC_CONTROL_FRAME_BYTES,
            connection.owner(),
        )
        .map_err(map_process_error)?;
        {
            let mut state = connection
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.planned_capacity = MAX_AUTOMATIC_CONTROL_FRAME_BYTES;
            state.reservations.push(baseline);
        }
        connection
            .planned_capacity
            .store(MAX_AUTOMATIC_CONTROL_FRAME_BYTES, Ordering::Release);
        Ok(connection)
    }

    fn owner(self: &Arc<Self>) -> ReservationOwner {
        ReservationOwner::Connection(Arc::as_ptr(self) as usize)
    }

    fn signal_pressure(&self) {
        self.overloaded.store(true, Ordering::Release);
        self.overload_notify.notify_waiters();
    }

    fn overload_watch(&self) -> OutboxOverloadWatch {
        OutboxOverloadWatch {
            overloaded: Arc::clone(&self.overloaded),
            notify: Arc::clone(&self.overload_notify),
        }
    }

    fn capacity_target(&self, payload: usize) -> Result<usize, OutboxSendError> {
        let needed = wire_frame_bytes(payload)?;
        socket_write_capacity_target(self.planned_capacity.load(Ordering::Acquire), needed)
    }

    fn intrinsic_total(&self, payload: usize) -> Result<usize, OutboxSendError> {
        payload
            .checked_add(self.capacity_target(payload)?)
            .ok_or(OutboxSendError::Oversized)
    }

    fn plan_payload(
        self: &Arc<Self>,
        payload: usize,
        prepared: Option<ProcessReservation>,
    ) -> Result<(), OutboxSendError> {
        self.plan_payload_with_reclaim(payload, prepared, true)
    }

    fn plan_payload_with_reclaim(
        self: &Arc<Self>,
        payload: usize,
        prepared: Option<ProcessReservation>,
        reclaim_on_full: bool,
    ) -> Result<(), OutboxSendError> {
        let needed = wire_frame_bytes(payload)?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let target = socket_write_capacity_target(state.planned_capacity, needed)?;
        let delta = target - state.planned_capacity;
        if delta == 0 {
            drop(prepared);
            return Ok(());
        }
        let reservation = match prepared {
            Some(mut prepared) if prepared.bytes >= delta => {
                prepared.transfer_to(self.owner());
                prepared.shrink_to(delta)
            }
            Some(mut prepared) => {
                prepared.transfer_to(self.owner());
                return Err(OutboxSendError::ReservationMismatch {
                    reserved: prepared.bytes,
                    actual: delta,
                });
            }
            None if reclaim_on_full => {
                reserve_process_bytes_owned(&self.process_budget, delta, self.owner())
                    .map_err(map_process_error)?
            }
            None => self
                .process_budget
                .try_reserve(delta, self.owner())
                .map_err(map_process_error)?,
        };
        state.reservations.push(reservation);
        state.planned_capacity = target;
        self.planned_capacity.store(target, Ordering::Release);
        Ok(())
    }
}

enum OutboundReservation {
    Local { _reservation: ByteReservation },
    Broadcast { _storage: Arc<BroadcastStorage> },
}

/// One exact charge against the process-wide outbound allocation boundary.
/// Every serialized or retained WebSocket payload owns one of these guards,
/// directly or through a shared broadcast storage allocation.
struct ProcessReservation {
    bytes: usize,
    owner: ReservationOwner,
    process_budget: Arc<ProcessOutboxBudget>,
}

impl Drop for ProcessReservation {
    fn drop(&mut self) {
        self.process_budget.release(self.bytes, self.owner);
    }
}

impl ProcessReservation {
    fn transfer_to(&mut self, owner: ReservationOwner) {
        if owner != self.owner {
            self.process_budget
                .transfer_owner(self.bytes, self.owner, owner);
            self.owner = owner;
        }
    }

    fn shrink_to(mut self, bytes: usize) -> Self {
        debug_assert!(bytes <= self.bytes);
        let released = self.bytes - bytes;
        if released > 0 {
            self.process_budget.release(released, self.owner);
            self.bytes = bytes;
        }
        self
    }
}

/// The paired local/process charge for one allocated outbound message. This
/// guard begins before allocation and is moved unchanged into the queued
/// message, so there is no gap between preflight and socket completion.
struct ByteReservation {
    bytes: usize,
    queued_bytes: Arc<AtomicUsize>,
    _process: ProcessReservation,
}

impl Drop for ByteReservation {
    fn drop(&mut self) {
        self.queued_bytes.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

/// Capacity reserved before constructing an outbound message. The channel
/// permit closes the count-limit race, while [`ByteReservation`] owns both
/// byte charges. Dropping this value at any failure point releases all three.
pub(crate) struct OutboxReservation {
    permit: Option<mpsc::OwnedPermit<OutboxMessage>>,
    byte_reservation: Option<ByteReservation>,
    connection_budget: Arc<ConnectionWireBudget>,
    receiver_open: Arc<Mutex<bool>>,
}

/// A message-count slot reserved when an operation is admitted, before
/// best-effort progress can fill the lane. Exact payload/process capacity is
/// attached only when the authoritative terminal is known.
pub(crate) struct ReservedUnicastSlot {
    permit: Arc<Mutex<Option<mpsc::OwnedPermit<OutboxMessage>>>>,
    connection_budget: Arc<ConnectionWireBudget>,
    receiver_open: Arc<Mutex<bool>>,
}

impl Clone for ReservedUnicastSlot {
    fn clone(&self) -> Self {
        Self {
            permit: Arc::clone(&self.permit),
            connection_budget: Arc::clone(&self.connection_budget),
            receiver_open: Arc::clone(&self.receiver_open),
        }
    }
}

/// A serialized, fully reserved targeted frame. Durable workflows prepare
/// this before persistence and publish it synchronously with their live
/// commit, so a large requester-only outcome cannot fail allocation after
/// durable state has advanced.
pub(crate) struct PreparedUnicast {
    slot: ReservedUnicastSlot,
    byte_reservation: Option<ByteReservation>,
    message: Option<Message>,
}

impl PreparedUnicast {
    pub(crate) fn publish(mut self) -> Result<(), OutboxSendError> {
        let permit = self
            .slot
            .permit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let Some(permit) = permit else {
            self.slot.connection_budget.signal_pressure();
            return Err(OutboxSendError::Closed);
        };
        let message = self
            .message
            .take()
            .expect("prepared unicast message present");
        let result = OutboxReservation {
            permit: Some(permit),
            byte_reservation: self.byte_reservation.take(),
            connection_budget: Arc::clone(&self.slot.connection_budget),
            receiver_open: Arc::clone(&self.slot.receiver_open),
        }
        .commit(message);
        if result.is_err() {
            self.slot.connection_budget.signal_pressure();
        }
        result
    }
}

impl OutboxReservation {
    fn bytes(&self) -> usize {
        self.byte_reservation
            .as_ref()
            .expect("outbox reservation present")
            .bytes
    }

    /// Commit only a message whose actual storage length exactly matches the
    /// preflight. Equality (rather than `<=`) makes stale or under-counting
    /// length calculations fail closed.
    pub(crate) fn commit(mut self, message: Message) -> Result<(), OutboxSendError> {
        let reserved = self.bytes();
        let actual = message_bytes(&message);
        if actual != reserved {
            return Err(OutboxSendError::ReservationMismatch { reserved, actual });
        }

        let receiver_open = self
            .receiver_open
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !*receiver_open {
            return Err(OutboxSendError::Closed);
        }

        let queued = OutboxMessage::local(
            message,
            self.byte_reservation
                .take()
                .expect("outbox byte reservation present"),
            Arc::clone(&self.connection_budget),
        );
        self.permit
            .take()
            .expect("outbox channel permit present")
            .send(queued);
        Ok(())
    }
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PreparedSendError<E> {
    Prepare(E),
    Outbox(OutboxSendError),
}

/// One allocator shared by every WebSocket outbox in this process. The
/// per-connection limits protect one reader; this second boundary prevents a
/// large population of individually bounded slow readers from multiplying
/// into unbounded resident memory.
#[derive(Debug)]
struct ProcessOutboxBudget {
    max_bytes: AtomicUsize,
    queued_bytes: AtomicUsize,
    peak_queued_bytes: AtomicUsize,
    owner_bytes: Mutex<HashMap<ReservationOwner, usize>>,
    rejected_full: AtomicU64,
    broadcast_rings: Mutex<Vec<Weak<BroadcastPressure>>>,
    connections: Mutex<Vec<Weak<ConnectionWireBudget>>>,
    connection_victims: AtomicU64,
    ring_victims: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ReservationOwner {
    Connection(usize),
    Broadcast(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessReserveError {
    /// The frame cannot fit even when no other process reservation is live.
    Oversized,
    /// The frame fits the configured maximum, but concurrent reservations
    /// currently consume the required headroom.
    Full,
}

impl ProcessOutboxBudget {
    fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes: AtomicUsize::new(max_bytes.max(1)),
            queued_bytes: AtomicUsize::new(0),
            peak_queued_bytes: AtomicUsize::new(0),
            owner_bytes: Mutex::new(HashMap::new()),
            rejected_full: AtomicU64::new(0),
            broadcast_rings: Mutex::new(Vec::new()),
            connections: Mutex::new(Vec::new()),
            connection_victims: AtomicU64::new(0),
            ring_victims: AtomicU64::new(0),
        }
    }

    fn configure(&self, max_bytes: usize) -> Result<(), &'static str> {
        if max_bytes < minimum_process_outbox_bytes() {
            return Err(
                "WebSocket process outbox budget must admit a coded empty close and its retained write capacity",
            );
        }
        if self.queued_bytes.load(Ordering::Acquire) != 0 {
            return Err("WebSocket process outbox budget cannot change after use");
        }
        self.max_bytes.store(max_bytes, Ordering::Release);
        Ok(())
    }

    fn try_reserve(
        self: &Arc<Self>,
        bytes: usize,
        owner: ReservationOwner,
    ) -> Result<ProcessReservation, ProcessReserveError> {
        if bytes > self.max_bytes.load(Ordering::Acquire) {
            return Err(ProcessReserveError::Oversized);
        }

        // One lock owns both the global total and its exact owner partition.
        // Victim selection and ring→connection transfers can therefore never
        // observe an unowned or double-owned reservation.
        let mut owners = self
            .owner_bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = self.queued_bytes.load(Ordering::Acquire);
        let Some(next) = current.checked_add(bytes) else {
            self.rejected_full.fetch_add(1, Ordering::Relaxed);
            return Err(ProcessReserveError::Full);
        };
        if next > self.max_bytes.load(Ordering::Acquire) {
            self.rejected_full.fetch_add(1, Ordering::Relaxed);
            return Err(ProcessReserveError::Full);
        }
        *owners.entry(owner).or_default() += bytes;
        self.queued_bytes.store(next, Ordering::Release);
        self.peak_queued_bytes.fetch_max(next, Ordering::Relaxed);
        Ok(ProcessReservation {
            bytes,
            owner,
            process_budget: Arc::clone(self),
        })
    }

    fn release(&self, bytes: usize, owner: ReservationOwner) {
        let mut owners = self
            .owner_bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let owned = owners.get_mut(&owner).expect("process reservation owner");
        *owned = owned
            .checked_sub(bytes)
            .expect("owner accounting underflow");
        if *owned == 0 {
            owners.remove(&owner);
        }
        self.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
    }

    fn transfer_owner(&self, bytes: usize, from: ReservationOwner, to: ReservationOwner) {
        let mut owners = self
            .owner_bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let from_bytes = owners.get_mut(&from).expect("source reservation owner");
        *from_bytes = from_bytes
            .checked_sub(bytes)
            .expect("owner transfer underflow");
        if *from_bytes == 0 {
            owners.remove(&from);
        }
        *owners.entry(to).or_default() += bytes;
    }

    #[cfg(test)]
    fn owned_bytes(&self, owner: ReservationOwner) -> usize {
        self.owner_bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&owner)
            .copied()
            .unwrap_or(0)
    }

    fn owner_snapshot(&self) -> (usize, HashMap<ReservationOwner, usize>) {
        let owners = self
            .owner_bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (self.queued_bytes.load(Ordering::Acquire), owners.clone())
    }

    fn register_broadcast_ring(&self, pressure: &Arc<BroadcastPressure>) {
        let mut rings = self
            .broadcast_rings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        rings.retain(|ring| ring.strong_count() > 0);
        rings.push(Arc::downgrade(pressure));
    }

    fn register_connection(&self, connection: &Arc<ConnectionWireBudget>) {
        let mut connections = self
            .connections
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        connections.retain(|connection| connection.strong_count() > 0);
        connections.push(Arc::downgrade(connection));
    }

    fn largest_holder(&self, requester: ReservationOwner) -> Option<PressureVictim> {
        let (_, owner_bytes) = self.owner_snapshot();
        let mut best: Option<(usize, bool, PressureVictim)> = None;
        {
            let mut connections = self
                .connections
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            connections.retain(|connection| connection.strong_count() > 0);
            for weak in connections.iter() {
                let Some(connection) = weak.upgrade() else {
                    continue;
                };
                let owner = connection.owner();
                let bytes = owner_bytes.get(&owner).copied().unwrap_or(0);
                consider_pressure_victim(
                    &mut best,
                    bytes,
                    owner == requester,
                    PressureVictim::Connection(connection),
                );
            }
        }
        {
            let mut rings = self
                .broadcast_rings
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            rings.retain(|ring| ring.strong_count() > 0);
            for weak in rings.iter() {
                let Some(ring) = weak.upgrade() else {
                    continue;
                };
                let owner = ring.owner();
                let bytes = owner_bytes.get(&owner).copied().unwrap_or(0);
                consider_pressure_victim(
                    &mut best,
                    bytes,
                    owner == requester,
                    PressureVictim::Ring(ring),
                );
            }
        }
        best.map(|(_, _, victim)| victim)
    }
}

/// Pick the true largest live owner. A non-requester only wins an exact tie,
/// avoiding needless self-close without allowing an idle peer baseline to
/// hide a much larger requester.
fn consider_pressure_victim(
    best: &mut Option<(usize, bool, PressureVictim)>,
    bytes: usize,
    requester: bool,
    victim: PressureVictim,
) {
    if bytes == 0 {
        return;
    }
    let replace = best.as_ref().is_none_or(|(best_bytes, best_requester, _)| {
        bytes > *best_bytes || (bytes == *best_bytes && *best_requester && !requester)
    });
    if replace {
        *best = Some((bytes, requester, victim));
    }
}

enum PressureVictim {
    Connection(Arc<ConnectionWireBudget>),
    Ring(Arc<BroadcastPressure>),
}

fn reserve_process_bytes_owned(
    process_budget: &Arc<ProcessOutboxBudget>,
    bytes: usize,
    requester: ReservationOwner,
) -> Result<ProcessReservation, ProcessReserveError> {
    match process_budget.try_reserve(bytes, requester) {
        Ok(reservation) => Ok(reservation),
        Err(ProcessReserveError::Full) => match process_budget.largest_holder(requester) {
            Some(PressureVictim::Ring(ring)) => {
                process_budget.ring_victims.fetch_add(1, Ordering::Relaxed);
                ring.flush();
                process_budget.try_reserve(bytes, requester)
            }
            Some(PressureVictim::Connection(connection)) => {
                process_budget
                    .connection_victims
                    .fetch_add(1, Ordering::Relaxed);
                connection.signal_pressure();
                Err(ProcessReserveError::Full)
            }
            None => Err(ProcessReserveError::Full),
        },
        Err(error) => Err(error),
    }
}

fn reserve_process_message_with_budget(
    message: Message,
    connection_budget: Arc<ConnectionWireBudget>,
) -> Result<OutboxMessage, OutboxSendError> {
    let bytes = message_bytes(&message);
    if connection_budget.intrinsic_total(bytes)?
        > connection_budget
            .process_budget
            .max_bytes
            .load(Ordering::Acquire)
    {
        return Err(OutboxSendError::Oversized);
    }
    connection_budget.plan_payload(bytes, None)?;
    let reservation = match reserve_local_process_bytes(
        &connection_budget.queued_bytes,
        connection_budget.max_bytes,
        &connection_budget.process_budget,
        bytes,
        connection_budget.owner(),
    ) {
        Ok(reservation) => reservation,
        Err(error) => {
            if matches!(error, OutboxSendError::Full) {
                connection_budget.signal_pressure();
            }
            return Err(error);
        }
    };
    Ok(OutboxMessage::local(
        message,
        reservation,
        connection_budget,
    ))
}

fn reserve_local_process_bytes(
    queued_bytes: &Arc<AtomicUsize>,
    max_bytes: usize,
    process_budget: &Arc<ProcessOutboxBudget>,
    bytes: usize,
    owner: ReservationOwner,
) -> Result<ByteReservation, OutboxSendError> {
    reserve_local_process_bytes_with_reclaim(
        queued_bytes,
        max_bytes,
        process_budget,
        bytes,
        owner,
        true,
    )
}

fn reserve_local_process_bytes_with_reclaim(
    queued_bytes: &Arc<AtomicUsize>,
    max_bytes: usize,
    process_budget: &Arc<ProcessOutboxBudget>,
    bytes: usize,
    owner: ReservationOwner,
    reclaim_on_full: bool,
) -> Result<ByteReservation, OutboxSendError> {
    if bytes > max_bytes || bytes > process_budget.max_bytes.load(Ordering::Acquire) {
        return Err(OutboxSendError::Oversized);
    }

    let mut current = queued_bytes.load(Ordering::Acquire);
    loop {
        let Some(next) = current.checked_add(bytes) else {
            return Err(OutboxSendError::Full);
        };
        if next > max_bytes {
            return Err(OutboxSendError::Full);
        }
        match queued_bytes.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => break,
            Err(observed) => current = observed,
        }
    }

    let process = match if reclaim_on_full {
        reserve_process_bytes_owned(process_budget, bytes, owner)
    } else {
        process_budget.try_reserve(bytes, owner)
    } {
        Ok(reservation) => reservation,
        Err(ProcessReserveError::Oversized) => {
            queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
            return Err(OutboxSendError::Oversized);
        }
        Err(ProcessReserveError::Full) => {
            queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
            return Err(OutboxSendError::ProcessFull);
        }
    };

    Ok(ByteReservation {
        bytes,
        queued_bytes: Arc::clone(queued_bytes),
        _process: process,
    })
}

/// Charge a direct control frame before it enters the bounded socket send.
/// Large data paths use the prepared APIs below so their allocation starts
/// only after this same process reservation succeeds.
pub(crate) fn reserve_process_message(
    message: Message,
    socket_budget: &SocketWriteBudget,
) -> Result<OutboxMessage, OutboxSendError> {
    reserve_process_message_with_budget(message, Arc::clone(&socket_budget.connection))
}

fn map_process_error(error: ProcessReserveError) -> OutboxSendError {
    match error {
        ProcessReserveError::Oversized => OutboxSendError::Oversized,
        ProcessReserveError::Full => OutboxSendError::ProcessFull,
    }
}

fn wire_frame_bytes(payload: usize) -> Result<usize, OutboxSendError> {
    let header = if payload <= 125 {
        2
    } else if payload <= u16::MAX as usize {
        4
    } else {
        10
    };
    payload
        .checked_add(header)
        .ok_or(OutboxSendError::Oversized)
}

/// Mirror `RawVec<u8>::grow_amortized` for tungstenite's write Vec. The
/// required value is the resulting Vec length, not merely the appended tail.
fn raw_vec_capacity_after(capacity: usize, required: usize) -> Result<usize, OutboxSendError> {
    if required <= capacity {
        return Ok(capacity);
    }
    let doubled = capacity.checked_mul(2).ok_or(OutboxSendError::Oversized)?;
    Ok(required.max(doubled).max(MIN_SOCKET_WRITE_CAPACITY_BYTES))
}

/// Conservative retained-capacity target for one application write.
///
/// Tungstenite may hold an automatic Pong/Close while the read half runs. If
/// an application frame drains only partially, `poll_flush` appends that
/// control frame to the same Vec. Model both RawVec growth transitions before
/// handing the application frame to the codec. When their combined logical
/// length would exceed tungstenite's configured write maximum, the codec
/// retains the control frame instead of appending it, so only the application
/// transition is possible.
fn socket_write_capacity_target(
    capacity: usize,
    application_frame_bytes: usize,
) -> Result<usize, OutboxSendError> {
    if application_frame_bytes > MAX_SOCKET_WRITE_FRAME_BYTES {
        return Err(OutboxSendError::Oversized);
    }
    let after_application = raw_vec_capacity_after(capacity, application_frame_bytes)?;
    let with_control = application_frame_bytes
        .checked_add(MAX_AUTOMATIC_CONTROL_FRAME_BYTES)
        .ok_or(OutboxSendError::Oversized)?;
    let target = if with_control <= MAX_SOCKET_WRITE_FRAME_BYTES {
        raw_vec_capacity_after(after_application, with_control)?
    } else {
        after_application
    };
    if target > MAX_SOCKET_RETAINED_CAPACITY_BYTES {
        return Err(OutboxSendError::Oversized);
    }
    Ok(target)
}

fn wire_capability_bytes(payload: usize) -> Result<usize, OutboxSendError> {
    let needed = wire_frame_bytes(payload)?;
    let with_control = needed
        .checked_add(MAX_AUTOMATIC_CONTROL_FRAME_BYTES)
        .ok_or(OutboxSendError::Oversized)?;
    let half_needed = needed / 2;
    let half_control = with_control / 2;
    // The planner target is piecewise linear in retained capacity; every
    // maximum delta occurs at one of the branch boundaries below. Evaluate
    // both sides of each boundary to derive a state-independent capability
    // for durable broadcast alternates whose recipient planner is unknown at
    // prepare time.
    let candidates = [
        MAX_AUTOMATIC_CONTROL_FRAME_BYTES,
        half_needed.saturating_sub(1),
        half_needed,
        half_needed.saturating_add(1),
        half_control.saturating_sub(1),
        half_control,
        half_control.saturating_add(1),
        needed.saturating_sub(1),
        needed,
        needed.saturating_add(1),
        with_control.saturating_sub(1),
        with_control,
        with_control.saturating_add(1),
        MAX_SOCKET_WRITE_FRAME_BYTES,
        MAX_SOCKET_RETAINED_CAPACITY_BYTES,
    ];
    let mut capability = 0usize;
    for capacity in candidates {
        if !(MAX_AUTOMATIC_CONTROL_FRAME_BYTES..=MAX_SOCKET_RETAINED_CAPACITY_BYTES)
            .contains(&capacity)
        {
            continue;
        }
        let target = socket_write_capacity_target(capacity, needed)?;
        capability = capability.max(target - capacity);
    }
    Ok(capability)
}

fn minimum_process_outbox_bytes() -> usize {
    // Each socket first owns the automatic-control baseline. Every fallback
    // is a coded close with an empty reason: two payload bytes plus the
    // planner target reachable from that baseline.
    2usize
        .checked_add(
            socket_write_capacity_target(
                MAX_AUTOMATIC_CONTROL_FRAME_BYTES,
                wire_frame_bytes(2).expect("coded close frame size"),
            )
            .expect("coded close capacity target"),
        )
        .expect("coded close admission fits usize")
}

/// Configure the process-wide allocator before accepting WebSocket clients.
///
/// This is a hard ceiling and is never silently inflated for control frames.
/// An unusually small value must therefore leave room for terminal status
/// messages as well as payloads; otherwise those statuses are themselves
/// rejected as intrinsically oversized, without an overload close.
pub fn configure_process_outbox_budget(max_bytes: usize) -> Result<(), &'static str> {
    PROCESS_OUTBOX_BUDGET.configure(max_bytes)
}

struct JsonLengthWriter {
    len: usize,
    limit: usize,
    exceeded: bool,
}

impl JsonLengthWriter {
    fn new(limit: usize) -> Self {
        Self {
            len: 0,
            limit,
            exceeded: false,
        }
    }
}

impl Write for JsonLengthWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let Some(next) = self.len.checked_add(buf.len()) else {
            self.exceeded = true;
            return Err(io::Error::other("JSON length overflow"));
        };
        if next > self.limit {
            self.exceeded = true;
            return Err(io::Error::other("JSON length limit exceeded"));
        }
        self.len = next;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn json_len_bounded<T>(value: &T, limit: usize) -> Result<usize, BoundedJsonError>
where
    T: Serialize + ?Sized,
{
    let mut writer = JsonLengthWriter::new(limit);
    if let Err(error) = serde_json::to_writer(&mut writer, value) {
        return if writer.exceeded {
            Err(BoundedJsonError::LimitExceeded { limit })
        } else {
            Err(BoundedJsonError::Serialize(error))
        };
    }
    Ok(writer.len)
}

struct ExactJsonWriter {
    bytes: Vec<u8>,
    expected: usize,
    attempted: usize,
    exceeded: bool,
}

impl ExactJsonWriter {
    fn new(expected: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(expected),
            expected,
            attempted: 0,
            exceeded: false,
        }
    }
}

impl Write for ExactJsonWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let Some(next) = self.bytes.len().checked_add(buf.len()) else {
            self.exceeded = true;
            self.attempted = usize::MAX;
            return Err(io::Error::other("JSON length overflow"));
        };
        self.attempted = next;
        if next > self.expected {
            self.exceeded = true;
            return Err(io::Error::other("JSON exceeded its reserved length"));
        }
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, Error)]
pub(crate) enum PreparedJsonError {
    #[error(transparent)]
    Json(#[from] BoundedJsonError),
    #[error(transparent)]
    Outbox(#[from] OutboxSendError),
}

fn encode_json_exact<T>(value: &T, expected: usize) -> Result<Utf8Bytes, PreparedJsonError>
where
    T: Serialize + ?Sized,
{
    let mut writer = ExactJsonWriter::new(expected);
    if let Err(error) = serde_json::to_writer(&mut writer, value) {
        if writer.exceeded {
            return Err(OutboxSendError::ReservationMismatch {
                reserved: expected,
                actual: writer.attempted,
            }
            .into());
        }
        return Err(BoundedJsonError::Serialize(error).into());
    }
    if writer.bytes.len() != expected {
        return Err(OutboxSendError::ReservationMismatch {
            reserved: expected,
            actual: writer.bytes.len(),
        }
        .into());
    }
    Ok(Utf8Bytes::try_from(writer.bytes).expect("serde_json always emits UTF-8"))
}

fn prepare_json_message_with_budget<T>(
    value: &T,
    limit: usize,
    connection_budget: Arc<ConnectionWireBudget>,
) -> Result<OutboxMessage, PreparedJsonError>
where
    T: Serialize + ?Sized,
{
    // The first pass only counts bytes. The exact process charge must succeed
    // before the second pass allocates the serialized payload.
    let bytes = json_len_bounded(value, limit)?;
    if connection_budget.intrinsic_total(bytes)?
        > connection_budget
            .process_budget
            .max_bytes
            .load(Ordering::Acquire)
    {
        return Err(OutboxSendError::Oversized.into());
    }
    connection_budget.plan_payload(bytes, None)?;
    let reservation = match reserve_local_process_bytes(
        &connection_budget.queued_bytes,
        connection_budget.max_bytes,
        &connection_budget.process_budget,
        bytes,
        connection_budget.owner(),
    ) {
        Ok(reservation) => reservation,
        Err(error) => {
            if matches!(error, OutboxSendError::Full) {
                connection_budget.signal_pressure();
            }
            return Err(error.into());
        }
    };
    let text = encode_json_exact(value, bytes)?;
    Ok(OutboxMessage::local(
        Message::Text(text),
        reservation,
        connection_budget,
    ))
}

pub(crate) fn prepare_json_message<T>(
    value: &T,
    limit: usize,
    socket_budget: &SocketWriteBudget,
) -> Result<OutboxMessage, PreparedJsonError>
where
    T: Serialize + ?Sized,
{
    prepare_json_message_with_budget(value, limit, Arc::clone(&socket_budget.connection))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BroadcastKind {
    CommandBroadcast { sender: Option<ClientId> },
    PresenceUpdate { sender: ClientId },
    CursorUpdate { sender: ClientId },
    PeerJoined { sender: ClientId },
    PeerLeft,
    FollowChanged,
    DatasetPresenceUpdate { sender: ClientId },
    GeneratedAvailabilityUpdate,
    WorkspaceArchived,
}

/// An outbound workspace event before serialization. Payloads stay typed all
/// the way to [`BroadcastSender::send`], so no producer can allocate a JSON
/// string before the ring's local/process byte reservation succeeds.
pub(crate) struct BroadcastEvent {
    kind: BroadcastKind,
    primary: ServerMessage,
    alternate: Option<ServerMessage>,
}

impl BroadcastEvent {
    pub(crate) fn command(
        sender: Option<ClientId>,
        broadcast: ServerMessage,
        acknowledgement: Option<ServerMessage>,
    ) -> Self {
        Self {
            kind: BroadcastKind::CommandBroadcast { sender },
            primary: broadcast,
            alternate: acknowledgement,
        }
    }

    pub(crate) fn presence(sender: ClientId, message: ServerMessage) -> Self {
        Self::single(BroadcastKind::PresenceUpdate { sender }, message)
    }

    pub(crate) fn cursor(sender: ClientId, message: ServerMessage) -> Self {
        Self::single(BroadcastKind::CursorUpdate { sender }, message)
    }

    pub(crate) fn peer_joined(sender: ClientId, message: ServerMessage) -> Self {
        Self::single(BroadcastKind::PeerJoined { sender }, message)
    }

    pub(crate) fn peer_left(message: ServerMessage) -> Self {
        Self::single(BroadcastKind::PeerLeft, message)
    }

    pub(crate) fn follow_changed(message: ServerMessage) -> Self {
        Self::single(BroadcastKind::FollowChanged, message)
    }

    pub(crate) fn dataset_presence(sender: ClientId, message: ServerMessage) -> Self {
        Self::single(BroadcastKind::DatasetPresenceUpdate { sender }, message)
    }

    pub(crate) fn generated_availability(message: ServerMessage) -> Self {
        Self::single(BroadcastKind::GeneratedAvailabilityUpdate, message)
    }

    pub(crate) fn workspace_archived(message: ServerMessage) -> Self {
        Self::single(BroadcastKind::WorkspaceArchived, message)
    }

    fn single(kind: BroadcastKind, message: ServerMessage) -> Self {
        Self {
            kind,
            primary: message,
            alternate: None,
        }
    }
}

struct BroadcastStorage {
    primary: Utf8Bytes,
    alternate: Option<Utf8Bytes>,
    alternate_wire: Mutex<Option<ProcessReservation>>,
    _reservation: ByteReservation,
}

/// One ring item. Clones share both immutable UTF-8 storage and its single
/// reservation; receiver fan-out therefore does not multiply owned strings.
#[derive(Clone)]
pub(crate) struct BroadcastItem {
    kind: BroadcastKind,
    storage: Arc<BroadcastStorage>,
}

impl BroadcastItem {
    #[cfg(test)]
    pub(crate) fn kind(&self) -> BroadcastKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn primary_json(&self) -> &str {
        self.storage.primary.as_str()
    }

    pub(crate) fn outbound_for(&self, recipient: ClientId) -> Option<OutboxMessage> {
        let (selected, alternate) = match self.kind {
            BroadcastKind::CommandBroadcast { sender } if sender == Some(recipient) => {
                (self.storage.alternate.as_ref()?, true)
            }
            BroadcastKind::PresenceUpdate { sender }
            | BroadcastKind::CursorUpdate { sender }
            | BroadcastKind::PeerJoined { sender }
            | BroadcastKind::DatasetPresenceUpdate { sender }
                if sender == recipient =>
            {
                return None;
            }
            _ => (&self.storage.primary, false),
        };
        let wire_reservation = if alternate {
            self.storage
                .alternate_wire
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
        } else {
            None
        };
        Some(OutboxMessage::broadcast(
            Message::Text(selected.clone()),
            Arc::clone(&self.storage),
            wire_reservation,
        ))
    }
}

#[derive(Clone)]
pub struct BroadcastSender {
    sender: broadcast::Sender<BroadcastEnvelope>,
    pressure: Arc<BroadcastPressure>,
    queued_bytes: Arc<AtomicUsize>,
    max_bytes: usize,
    process_budget: Arc<ProcessOutboxBudget>,
}

pub(crate) struct BroadcastReceiver {
    receiver: broadcast::Receiver<BroadcastEnvelope>,
    pressure: Arc<BroadcastPressure>,
    observed_pressure_epoch: u64,
}

/// Serialized, fully reserved permission to publish one workspace event.
/// Durable mutations acquire this capability before persistence/commit, then
/// consume it after commit without another fallible allocation boundary.
pub(crate) struct PreparedBroadcast {
    sender: broadcast::Sender<BroadcastEnvelope>,
    item: Option<BroadcastItem>,
}

impl PreparedBroadcast {
    pub(crate) fn publish(self) {
        if let Some(item) = self.item {
            // Failure now only means every receiver disappeared after
            // preparation. Dropping the returned item releases its charge;
            // there is no connected peer left to diverge.
            let _ = self.sender.send(BroadcastEnvelope::Item(item));
        }
    }
}

#[derive(Clone)]
enum BroadcastEnvelope {
    Item(BroadcastItem),
    Pressure,
}

struct BroadcastPressure {
    sender: broadcast::Sender<BroadcastEnvelope>,
    capacity: usize,
    epoch: AtomicU64,
}

impl BroadcastPressure {
    fn owner(self: &Arc<Self>) -> ReservationOwner {
        ReservationOwner::Broadcast(Arc::as_ptr(self) as usize)
    }

    fn flush(&self) {
        // Publish the epoch before overwriting the ring. A receiver that is
        // already behind may observe Tokio's generic Lagged error before a
        // Pressure envelope; the epoch makes that lag unambiguously fatal and
        // prevents an emergency flush from triggering a fresh full snapshot.
        self.epoch.fetch_add(1, Ordering::AcqRel);
        // `broadcast::Sender` retains its ring independently of receiver
        // progress. Overwrite every slot so old reservation guards release;
        // receivers either observe Pressure directly or Lagged across it.
        for _ in 0..self.capacity {
            let _ = self.sender.send(BroadcastEnvelope::Pressure);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BroadcastRecvError {
    Lagged(u64),
    Pressure,
    Closed,
}

#[derive(Debug, Error)]
pub(crate) enum BroadcastSendError {
    #[error(transparent)]
    Json(#[from] BoundedJsonError),
    #[error(transparent)]
    Outbox(#[from] OutboxSendError),
}

impl From<PreparedJsonError> for BroadcastSendError {
    fn from(error: PreparedJsonError) -> Self {
        match error {
            PreparedJsonError::Json(error) => Self::Json(error),
            PreparedJsonError::Outbox(error) => Self::Outbox(error),
        }
    }
}

pub(crate) fn broadcast_channel(max_messages: usize, max_bytes: usize) -> BroadcastSender {
    broadcast_channel_with_budget(max_messages, max_bytes, Arc::clone(&PROCESS_OUTBOX_BUDGET))
}

fn broadcast_channel_with_budget(
    max_messages: usize,
    max_bytes: usize,
    process_budget: Arc<ProcessOutboxBudget>,
) -> BroadcastSender {
    // Tokio rounds internally to a power of two. Normalize once and use the
    // same capacity for pressure flushing; otherwise (for example at 3 or 5)
    // a requested-count flush leaves rounded ring slots—and their guards—live.
    // Overflow falls back to the smallest safe ring instead of wrapping.
    let capacity = max_messages.max(1).checked_next_power_of_two().unwrap_or(1);
    let (sender, receiver) = broadcast::channel(capacity);
    drop(receiver);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let pressure = Arc::new(BroadcastPressure {
        sender: sender.clone(),
        capacity,
        epoch: AtomicU64::new(0),
    });
    process_budget.register_broadcast_ring(&pressure);
    BroadcastSender {
        sender,
        pressure,
        queued_bytes,
        max_bytes: max_bytes.max(1),
        process_budget,
    }
}

impl BroadcastSender {
    pub(crate) fn subscribe(&self) -> BroadcastReceiver {
        BroadcastReceiver {
            receiver: self.sender.subscribe(),
            observed_pressure_epoch: self.pressure.epoch.load(Ordering::Acquire),
            pressure: Arc::clone(&self.pressure),
        }
    }

    pub(crate) fn prepare(
        &self,
        event: BroadcastEvent,
    ) -> Result<PreparedBroadcast, BroadcastSendError> {
        if self.sender.receiver_count() == 0 {
            return Ok(PreparedBroadcast {
                sender: self.sender.clone(),
                item: None,
            });
        }

        let primary_len = self.preflight_len(&event.primary)?;
        let alternate_len = event
            .alternate
            .as_ref()
            .map(|message| self.preflight_len(message))
            .transpose()?
            .unwrap_or(0);
        let Some(bytes) = primary_len.checked_add(alternate_len) else {
            self.record_rejection(OutboxSendError::Oversized, usize::MAX);
            return Err(OutboxSendError::Oversized.into());
        };
        let mandatory_process_bytes = if event.alternate.is_some() {
            bytes
                .checked_add(wire_capability_bytes(alternate_len)?)
                .ok_or(BroadcastSendError::Outbox(OutboxSendError::Oversized))?
        } else {
            bytes
        };
        if mandatory_process_bytes > self.process_budget.max_bytes.load(Ordering::Acquire) {
            self.record_rejection(OutboxSendError::Oversized, mandatory_process_bytes);
            return Err(OutboxSendError::Oversized.into());
        }

        let reservation = match reserve_local_process_bytes(
            &self.queued_bytes,
            self.max_bytes,
            &self.process_budget,
            bytes,
            self.pressure.owner(),
        ) {
            Ok(reservation) => reservation,
            Err(error) => {
                self.record_rejection(error, bytes);
                if matches!(error, OutboxSendError::Full) {
                    self.signal_pressure();
                }
                return Err(error.into());
            }
        };

        let alternate_wire = if event.alternate.is_some() {
            let wire_bytes = wire_capability_bytes(alternate_len)?;
            match reserve_process_bytes_owned(
                &self.process_budget,
                wire_bytes,
                self.pressure.owner(),
            ) {
                Ok(reservation) => Some(reservation),
                Err(error) => {
                    let error = map_process_error(error);
                    self.record_rejection(error, alternate_len);
                    return Err(error.into());
                }
            }
        } else {
            None
        };

        let primary = encode_json_exact(&event.primary, primary_len)?;
        let alternate = event
            .alternate
            .as_ref()
            .map(|message| encode_json_exact(message, alternate_len))
            .transpose()?;
        let item = BroadcastItem {
            kind: event.kind,
            storage: Arc::new(BroadcastStorage {
                primary,
                alternate,
                alternate_wire: Mutex::new(alternate_wire),
                _reservation: reservation,
            }),
        };
        Ok(PreparedBroadcast {
            sender: self.sender.clone(),
            item: Some(item),
        })
    }

    pub(crate) fn send(&self, event: BroadcastEvent) -> Result<(), BroadcastSendError> {
        self.prepare(event)?.publish();
        Ok(())
    }

    fn preflight_len(&self, message: &ServerMessage) -> Result<usize, BroadcastSendError> {
        match json_len_bounded(message, self.max_bytes) {
            Ok(bytes) => Ok(bytes),
            Err(BoundedJsonError::LimitExceeded { .. }) => {
                self.record_rejection(OutboxSendError::Oversized, self.max_bytes.saturating_add(1));
                Err(OutboxSendError::Oversized.into())
            }
            Err(error) => Err(error.into()),
        }
    }

    fn signal_pressure(&self) {
        self.pressure.flush();
    }

    fn record_rejection(&self, error: OutboxSendError, message_bytes: usize) {
        match error {
            OutboxSendError::Full => {
                GLOBAL_REJECTED_FULL.fetch_add(1, Ordering::Relaxed);
            }
            OutboxSendError::Oversized => {
                GLOBAL_REJECTED_OVERSIZED.fetch_add(1, Ordering::Relaxed);
            }
            OutboxSendError::ProcessFull
            | OutboxSendError::Closed
            | OutboxSendError::ReservationMismatch { .. } => {}
        }
        tracing::warn!(
            message_bytes,
            queued_bytes = self.queued_bytes.load(Ordering::Acquire),
            max_bytes = self.max_bytes,
            process_queued_bytes = self.process_budget.queued_bytes.load(Ordering::Acquire),
            process_max_bytes = self.process_budget.max_bytes.load(Ordering::Acquire),
            reason = %error,
            "ws.broadcast_rejected"
        );
    }

    #[cfg(test)]
    pub(crate) fn queued_bytes(&self) -> usize {
        self.queued_bytes.load(Ordering::Acquire)
    }
}

impl BroadcastReceiver {
    fn pressure_advanced(&mut self) -> bool {
        let epoch = self.pressure.epoch.load(Ordering::Acquire);
        if epoch == self.observed_pressure_epoch {
            return false;
        }
        self.observed_pressure_epoch = epoch;
        true
    }

    pub(crate) async fn recv(&mut self) -> Result<BroadcastItem, BroadcastRecvError> {
        if self.pressure_advanced() {
            return Err(BroadcastRecvError::Pressure);
        }
        match self.receiver.recv().await {
            Ok(BroadcastEnvelope::Item(item)) => {
                if self.pressure_advanced() {
                    Err(BroadcastRecvError::Pressure)
                } else {
                    Ok(item)
                }
            }
            Ok(BroadcastEnvelope::Pressure) => {
                self.observed_pressure_epoch = self.pressure.epoch.load(Ordering::Acquire);
                Err(BroadcastRecvError::Pressure)
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                if self.pressure_advanced() {
                    Err(BroadcastRecvError::Pressure)
                } else {
                    Err(BroadcastRecvError::Lagged(skipped))
                }
            }
            Err(broadcast::error::RecvError::Closed) => Err(BroadcastRecvError::Closed),
        }
    }

    #[cfg(test)]
    pub(crate) fn try_recv(&mut self) -> Result<BroadcastItem, broadcast::error::TryRecvError> {
        match self.receiver.try_recv() {
            Ok(BroadcastEnvelope::Item(item)) => Ok(item),
            Ok(BroadcastEnvelope::Pressure) => Err(broadcast::error::TryRecvError::Lagged(1)),
            Err(error) => Err(error),
        }
    }
}

#[derive(Clone)]
pub struct UnicastSender {
    sender: mpsc::Sender<OutboxMessage>,
    queued_bytes: Arc<AtomicUsize>,
    max_bytes: usize,
    overloaded: Arc<AtomicBool>,
    overload_notify: Arc<Notify>,
    rejected_full: Arc<AtomicUsize>,
    rejected_oversized: Arc<AtomicUsize>,
    rejected_process_full: Arc<AtomicUsize>,
    process_budget: Arc<ProcessOutboxBudget>,
    connection_budget: Arc<ConnectionWireBudget>,
    receiver_open: Arc<Mutex<bool>>,
}

pub struct UnicastReceiver {
    receiver: mpsc::Receiver<OutboxMessage>,
    overloaded: Arc<AtomicBool>,
    overload_notify: Arc<Notify>,
    receiver_open: Arc<Mutex<bool>>,
    connection_budget: Arc<ConnectionWireBudget>,
}

#[derive(Clone)]
pub(crate) struct OutboxOverloadWatch {
    overloaded: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl OutboxOverloadWatch {
    pub(crate) async fn triggered(&self) {
        loop {
            if self.overloaded.load(Ordering::Acquire) {
                return;
            }
            let notified = self.notify.notified();
            if self.overloaded.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

impl Drop for UnicastReceiver {
    fn drop(&mut self) {
        *self
            .receiver_open
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboxMetricsSnapshot {
    pub queued_bytes: usize,
    pub rejected_full: usize,
    pub rejected_oversized: usize,
    pub rejected_process_full: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct WebSocketMetricsSnapshot {
    pub queued_bytes: usize,
    pub peak_queued_bytes: usize,
    pub rejected_outbox_full: u64,
    pub rejected_outbox_oversized: u64,
    pub rejected_outbox_process_full: u64,
    pub process_pressure_connection_victims: u64,
    pub process_pressure_ring_victims: u64,
    pub rejected_request_work: u64,
    pub slow_consumer_timeouts: u64,
}

pub fn websocket_metrics_snapshot() -> WebSocketMetricsSnapshot {
    WebSocketMetricsSnapshot {
        queued_bytes: PROCESS_OUTBOX_BUDGET.queued_bytes.load(Ordering::Acquire),
        peak_queued_bytes: PROCESS_OUTBOX_BUDGET
            .peak_queued_bytes
            .load(Ordering::Acquire),
        rejected_outbox_full: GLOBAL_REJECTED_FULL.load(Ordering::Relaxed),
        rejected_outbox_oversized: GLOBAL_REJECTED_OVERSIZED.load(Ordering::Relaxed),
        rejected_outbox_process_full: PROCESS_OUTBOX_BUDGET.rejected_full.load(Ordering::Relaxed),
        process_pressure_connection_victims: PROCESS_OUTBOX_BUDGET
            .connection_victims
            .load(Ordering::Relaxed),
        process_pressure_ring_victims: PROCESS_OUTBOX_BUDGET.ring_victims.load(Ordering::Relaxed),
        rejected_request_work: GLOBAL_REJECTED_REQUEST_WORK.load(Ordering::Relaxed),
        slow_consumer_timeouts: GLOBAL_SLOW_CONSUMER_TIMEOUTS.load(Ordering::Relaxed),
    }
}

pub(crate) fn record_rejected_request_work() {
    GLOBAL_REJECTED_REQUEST_WORK.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn record_slow_consumer_timeout() {
    GLOBAL_SLOW_CONSUMER_TIMEOUTS.fetch_add(1, Ordering::Relaxed);
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum OutboxSendError {
    #[error("outbound message exceeds the connection byte budget")]
    Oversized,
    #[error("outbound connection queue is full")]
    Full,
    #[error("outbound process queue is full")]
    ProcessFull,
    #[error("outbound connection is closed")]
    Closed,
    #[error("outbound reservation mismatch: reserved {reserved} bytes but message uses {actual}")]
    ReservationMismatch { reserved: usize, actual: usize },
}

pub fn unicast_channel(max_messages: usize, max_bytes: usize) -> (UnicastSender, UnicastReceiver) {
    unicast_channel_with_budget(max_messages, max_bytes, Arc::clone(&PROCESS_OUTBOX_BUDGET))
}

/// Build the bulk and correctness-control lanes for one socket. The lanes
/// have independent message-count bounds and overload signals, but every
/// queued or in-flight frame charges one shared per-connection byte counter.
/// This preserves priority without multiplying the documented connection
/// ceiling by the number of lanes.
pub(crate) fn connection_unicast_channels(
    bulk_messages: usize,
    control_messages: usize,
    max_bytes: usize,
    socket_budget: &SocketWriteBudget,
) -> (
    UnicastSender,
    UnicastReceiver,
    UnicastSender,
    UnicastReceiver,
) {
    let connection_budget = Arc::clone(&socket_budget.connection);
    debug_assert_eq!(connection_budget.max_bytes, max_bytes.max(1));
    let (bulk_tx, bulk_rx) =
        unicast_channel_with_allocators(bulk_messages, max_bytes, Arc::clone(&connection_budget));
    let (control_tx, control_rx) =
        unicast_channel_with_allocators(control_messages, max_bytes, connection_budget);
    (bulk_tx, bulk_rx, control_tx, control_rx)
}

#[cfg(test)]
fn connection_unicast_channels_with_process_budget(
    bulk_messages: usize,
    control_messages: usize,
    max_bytes: usize,
    process_budget: Arc<ProcessOutboxBudget>,
) -> (
    UnicastSender,
    UnicastReceiver,
    UnicastSender,
    UnicastReceiver,
) {
    let connection_budget =
        ConnectionWireBudget::new(max_bytes, process_budget).expect("isolated connection baseline");
    let (bulk_tx, bulk_rx) =
        unicast_channel_with_allocators(bulk_messages, max_bytes, Arc::clone(&connection_budget));
    let (control_tx, control_rx) =
        unicast_channel_with_allocators(control_messages, max_bytes, connection_budget);
    (bulk_tx, bulk_rx, control_tx, control_rx)
}

/// Build an isolated process budget for cross-module transport tests without
/// mutating the process-global allocator used by other concurrent tests.
#[cfg(test)]
pub(crate) fn unicast_channel_with_process_budget(
    max_messages: usize,
    max_bytes: usize,
    process_max_bytes: usize,
) -> (UnicastSender, UnicastReceiver) {
    unicast_channel_with_budget(
        max_messages,
        max_bytes,
        Arc::new(ProcessOutboxBudget::new(process_max_bytes)),
    )
}

/// Isolated allocator observer for cross-module lifecycle tests. Holding the
/// probe does not hold a connection owner or any reservation alive.
#[cfg(test)]
#[derive(Clone)]
pub(crate) struct ProcessOutboxBudgetProbe(Arc<ProcessOutboxBudget>);

#[cfg(test)]
impl ProcessOutboxBudgetProbe {
    pub(crate) fn queued_bytes(&self) -> usize {
        self.0.queued_bytes.load(Ordering::Acquire)
    }
}

#[cfg(test)]
pub(crate) fn unicast_channel_with_process_budget_probe(
    max_messages: usize,
    max_bytes: usize,
    process_max_bytes: usize,
) -> (UnicastSender, UnicastReceiver, ProcessOutboxBudgetProbe) {
    let process_budget = Arc::new(ProcessOutboxBudget::new(process_max_bytes));
    let (sender, receiver) =
        unicast_channel_with_budget(max_messages, max_bytes, Arc::clone(&process_budget));
    (sender, receiver, ProcessOutboxBudgetProbe(process_budget))
}

/// Build two isolated connections against the same allocator. Cross-module
/// tests use this to prove that work stalled under one bounded owner does not
/// consume another client's outbound capacity.
#[cfg(test)]
pub(crate) fn two_unicast_channels_with_process_budget(
    max_messages: usize,
    max_bytes: usize,
    process_max_bytes: usize,
) -> (
    (UnicastSender, UnicastReceiver),
    (UnicastSender, UnicastReceiver),
) {
    let process_budget = Arc::new(ProcessOutboxBudget::new(process_max_bytes));
    (
        unicast_channel_with_budget(max_messages, max_bytes, Arc::clone(&process_budget)),
        unicast_channel_with_budget(max_messages, max_bytes, process_budget),
    )
}

fn unicast_channel_with_budget(
    max_messages: usize,
    max_bytes: usize,
    process_budget: Arc<ProcessOutboxBudget>,
) -> (UnicastSender, UnicastReceiver) {
    let connection_budget = ConnectionWireBudget::new(max_bytes, process_budget)
        .expect("connection control-frame baseline");
    unicast_channel_with_allocators(max_messages, max_bytes, connection_budget)
}

fn unicast_channel_with_allocators(
    max_messages: usize,
    max_bytes: usize,
    connection_budget: Arc<ConnectionWireBudget>,
) -> (UnicastSender, UnicastReceiver) {
    let (sender, receiver) = mpsc::channel(max_messages.max(1));
    let queued_bytes = Arc::clone(&connection_budget.queued_bytes);
    let overloaded = Arc::clone(&connection_budget.overloaded);
    let overload_notify = Arc::clone(&connection_budget.overload_notify);
    let process_budget = Arc::clone(&connection_budget.process_budget);
    let receiver_open = Arc::new(Mutex::new(true));
    (
        UnicastSender {
            sender,
            queued_bytes: Arc::clone(&queued_bytes),
            max_bytes: max_bytes.max(1),
            overloaded: Arc::clone(&overloaded),
            overload_notify: Arc::clone(&overload_notify),
            rejected_full: Arc::new(AtomicUsize::new(0)),
            rejected_oversized: Arc::new(AtomicUsize::new(0)),
            rejected_process_full: Arc::new(AtomicUsize::new(0)),
            process_budget: Arc::clone(&process_budget),
            connection_budget: Arc::clone(&connection_budget),
            receiver_open: Arc::clone(&receiver_open),
        },
        UnicastReceiver {
            receiver,
            overloaded,
            overload_notify,
            receiver_open,
            connection_budget,
        },
    )
}

impl UnicastSender {
    pub(crate) fn overload_watch(&self) -> OutboxOverloadWatch {
        OutboxOverloadWatch {
            overloaded: Arc::clone(&self.overloaded),
            notify: Arc::clone(&self.overload_notify),
        }
    }

    pub(crate) fn force_overload_close(&self) {
        self.connection_budget.signal_pressure();
    }

    /// Reserve only a channel slot for one future authoritative terminal.
    /// Every accepted dataset-open owns one of these before it can emit
    /// progress, so progress can never consume the last terminal permit.
    pub(crate) async fn reserve_terminal_slot(
        &self,
    ) -> Result<ReservedUnicastSlot, OutboxSendError> {
        // Waiting here backpressures this connection's inbound request loop;
        // it does not start another open, retain another request, or mislabel
        // a healthy connection as slow merely because earlier terminals own
        // every slot.
        let permit = self
            .sender
            .clone()
            .reserve_owned()
            .await
            .map_err(|_| OutboxSendError::Closed)?;
        Ok(ReservedUnicastSlot {
            permit: Arc::new(Mutex::new(Some(permit))),
            connection_budget: Arc::clone(&self.connection_budget),
            receiver_open: Arc::clone(&self.receiver_open),
        })
    }

    /// Reserve message-count capacity plus the exact local and process byte
    /// charge before the caller allocates or copies a message.
    pub(crate) fn reserve(&self, bytes: usize) -> Result<OutboxReservation, OutboxSendError> {
        // This message can never fit an empty connection or an otherwise idle
        // process. `validate_intrinsic` records it without labelling the client
        // a slow consumer, so request handlers can still send a smaller
        // truthful resource-limit status.
        self.validate_intrinsic(bytes)?;

        let permit = match self.sender.clone().try_reserve_owned() {
            Ok(permit) => permit,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.record_rejection(OutboxSendError::Full, bytes, true);
                return Err(OutboxSendError::Full);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => return Err(OutboxSendError::Closed),
        };

        let byte_reservation = match reserve_local_process_bytes(
            &self.queued_bytes,
            self.max_bytes,
            &self.process_budget,
            bytes,
            self.connection_budget.owner(),
        ) {
            Ok(reservation) => reservation,
            Err(error) => {
                // Global pressure chooses and signals the largest actual
                // non-requester holder. Do not punish this attempted sender
                // merely because another connection or ring owns the bytes.
                let signal_overload = matches!(error, OutboxSendError::Full);
                self.record_rejection(error, bytes, signal_overload);
                return Err(error);
            }
        };

        if let Err(error) = self.connection_budget.plan_payload(bytes, None) {
            self.record_rejection(error, bytes, false);
            return Err(error);
        }

        Ok(OutboxReservation {
            permit: Some(permit),
            byte_reservation: Some(byte_reservation),
            connection_budget: Arc::clone(&self.connection_budget),
            receiver_open: Arc::clone(&self.receiver_open),
        })
    }

    /// Allocation-free intrinsic validation for work whose payload already
    /// lives under a different bounded-memory owner (for example source or
    /// generated chunk caches). This intentionally ignores current queue and
    /// process occupancy; callers acquire the real reservation immediately
    /// before frame encoding, never across backend/disk I/O.
    pub(crate) fn validate_intrinsic(&self, bytes: usize) -> Result<(), OutboxSendError> {
        let process_bytes = match self.connection_budget.intrinsic_total(bytes) {
            Ok(process_bytes) => process_bytes,
            Err(error) => {
                self.record_rejection(error, bytes, false);
                return Err(error);
            }
        };
        if bytes > self.max_bytes
            || process_bytes > self.process_budget.max_bytes.load(Ordering::Acquire)
        {
            let error = OutboxSendError::Oversized;
            // This is the allocation-free equivalent of `reserve`: callers
            // use it to reject an impossible response before backend or disk
            // I/O, so keep the rejection telemetry identical without
            // signalling slow-consumer pressure.
            self.record_rejection(error, bytes, false);
            Err(error)
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    pub(crate) fn process_queued_bytes(&self) -> usize {
        self.process_budget.queued_bytes.load(Ordering::Acquire)
    }

    #[cfg(test)]
    fn socket_write_budget(&self) -> SocketWriteBudget {
        SocketWriteBudget {
            connection: Arc::clone(&self.connection_budget),
        }
    }

    /// Reserve first, then construct and commit one exact-size message. This
    /// is the allocation-safe path for large payload encoders.
    #[cfg(test)]
    pub(crate) fn send_prepared<E>(
        &self,
        bytes: usize,
        prepare: impl FnOnce() -> Result<Message, E>,
    ) -> Result<(), PreparedSendError<E>> {
        let reservation = self.reserve(bytes).map_err(PreparedSendError::Outbox)?;
        let message = prepare().map_err(PreparedSendError::Prepare)?;
        reservation
            .commit(message)
            .map_err(PreparedSendError::Outbox)
    }

    /// Enqueue without waiting. Message count and serialized payload bytes are
    /// both hard limits; callers choose whether overload means retry, reject,
    /// or close rather than allowing a slow reader to grow process memory.
    pub fn send(&self, message: Message) -> Result<(), OutboxSendError> {
        let bytes = message_bytes(&message);
        self.reserve(bytes)?.commit(message)
    }

    /// Count JSON without allocating, reserve exact local/process capacity,
    /// then serialize directly into exact-capacity UTF-8 storage.
    pub(crate) fn send_json<T>(&self, value: &T, limit: usize) -> Result<(), PreparedJsonError>
    where
        T: Serialize + ?Sized,
    {
        let bytes = json_len_bounded(value, limit)?;
        let reservation = self.reserve(bytes)?;
        let text = encode_json_exact(value, bytes)?;
        reservation.commit(Message::Text(text))?;
        Ok(())
    }

    /// Best-effort observational JSON. Full count/local/process capacity is a
    /// bounded drop, never a slow-consumer signal and never a reason to evict
    /// an authoritative holder. Admitted progress remains FIFO.
    pub(crate) fn send_json_best_effort<T>(
        &self,
        value: &T,
        limit: usize,
    ) -> Result<(), PreparedJsonError>
    where
        T: Serialize + ?Sized,
    {
        let bytes = json_len_bounded(value, limit)?;
        if let Err(error) = self.validate_intrinsic(bytes) {
            return Err(error.into());
        }
        let permit = self
            .sender
            .clone()
            .try_reserve_owned()
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => OutboxSendError::Full,
                mpsc::error::TrySendError::Closed(_) => OutboxSendError::Closed,
            })?;
        let byte_reservation = reserve_local_process_bytes_with_reclaim(
            &self.queued_bytes,
            self.max_bytes,
            &self.process_budget,
            bytes,
            self.connection_budget.owner(),
            false,
        )?;
        self.connection_budget
            .plan_payload_with_reclaim(bytes, None, false)?;
        let text = encode_json_exact(value, bytes)?;
        OutboxReservation {
            permit: Some(permit),
            byte_reservation: Some(byte_reservation),
            connection_budget: Arc::clone(&self.connection_budget),
            receiver_open: Arc::clone(&self.receiver_open),
        }
        .commit(Message::Text(text))?;
        Ok(())
    }

    /// Attach exact byte/process capacity to an admission-time terminal slot.
    /// The slot is consumed only after both reservation and encoding succeed,
    /// allowing a smaller failure terminal to reuse it if success preparation
    /// is intrinsically impossible.
    pub(crate) fn prepare_json_in_slot<T>(
        &self,
        slot: &ReservedUnicastSlot,
        value: &T,
        limit: usize,
    ) -> Result<PreparedUnicast, PreparedJsonError>
    where
        T: Serialize + ?Sized,
    {
        debug_assert!(Arc::ptr_eq(
            &slot.connection_budget,
            &self.connection_budget
        ));
        if slot
            .permit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none()
        {
            return Err(OutboxSendError::Closed.into());
        }
        let bytes = json_len_bounded(value, limit)?;
        if let Err(error) = self.validate_intrinsic(bytes) {
            return Err(error.into());
        }
        let byte_reservation = match reserve_local_process_bytes(
            &self.queued_bytes,
            self.max_bytes,
            &self.process_budget,
            bytes,
            self.connection_budget.owner(),
        ) {
            Ok(reservation) => reservation,
            Err(error) => {
                let signal_overload = matches!(error, OutboxSendError::Full);
                self.record_rejection(error, bytes, signal_overload);
                return Err(error.into());
            }
        };
        if let Err(error) = self.connection_budget.plan_payload(bytes, None) {
            self.record_rejection(error, bytes, false);
            return Err(error.into());
        }
        let text = encode_json_exact(value, bytes)?;
        Ok(PreparedUnicast {
            slot: slot.clone(),
            byte_reservation: Some(byte_reservation),
            message: Some(Message::Text(text)),
        })
    }

    /// Enqueue a terminal/status JSON outcome, converting intrinsic payload
    /// or encoder failures into a small close instead of silently leaving the
    /// socket open without its authoritative result. Queue/process pressure
    /// already activates this lane's overload-close path.
    pub(crate) fn send_json_or_close<T>(
        &self,
        value: &T,
        limit: usize,
    ) -> Result<(), PreparedJsonError>
    where
        T: Serialize + ?Sized,
    {
        let result = self.send_json(value, limit);
        if let Err(error) = &result {
            let terminal = match error {
                PreparedJsonError::Json(BoundedJsonError::LimitExceeded { .. })
                | PreparedJsonError::Outbox(OutboxSendError::Oversized) => {
                    Some((1009, "server outcome exceeds the outbound limit"))
                }
                PreparedJsonError::Json(BoundedJsonError::Serialize(_))
                | PreparedJsonError::Outbox(OutboxSendError::ReservationMismatch { .. }) => {
                    Some((1011, "server outcome serialization failed"))
                }
                PreparedJsonError::Outbox(
                    OutboxSendError::Full | OutboxSendError::ProcessFull | OutboxSendError::Closed,
                ) => None,
            };
            if let Some((code, _reason)) = terminal {
                let _ = self.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code,
                    // The code carries the terminal semantics. An empty reason
                    // keeps this fallback at the allocator's exact 6-byte
                    // minimum (2 payload storage + 4 retained wire frame).
                    reason: "".into(),
                })));
            }
        }
        result
    }

    fn record_rejection(
        &self,
        error: OutboxSendError,
        message_bytes: usize,
        signal_overload: bool,
    ) {
        match error {
            OutboxSendError::Full => {
                self.rejected_full.fetch_add(1, Ordering::Relaxed);
                GLOBAL_REJECTED_FULL.fetch_add(1, Ordering::Relaxed);
            }
            OutboxSendError::Oversized => {
                self.rejected_oversized.fetch_add(1, Ordering::Relaxed);
                GLOBAL_REJECTED_OVERSIZED.fetch_add(1, Ordering::Relaxed);
            }
            OutboxSendError::ProcessFull => {
                self.rejected_process_full.fetch_add(1, Ordering::Relaxed);
            }
            OutboxSendError::Closed | OutboxSendError::ReservationMismatch { .. } => return,
        }
        if signal_overload {
            self.overloaded.store(true, Ordering::Release);
            self.overload_notify.notify_one();
        }
        tracing::warn!(
            message_bytes,
            queued_bytes = self.queued_bytes(),
            max_bytes = self.max_bytes,
            process_queued_bytes = self.process_budget.queued_bytes.load(Ordering::Acquire),
            process_max_bytes = self.process_budget.max_bytes.load(Ordering::Acquire),
            reason = %error,
            "ws.outbox_rejected"
        );
    }

    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes.load(Ordering::Acquire)
    }

    pub fn metrics(&self) -> OutboxMetricsSnapshot {
        OutboxMetricsSnapshot {
            queued_bytes: self.queued_bytes(),
            rejected_full: self.rejected_full.load(Ordering::Relaxed),
            rejected_oversized: self.rejected_oversized.load(Ordering::Relaxed),
            rejected_process_full: self.rejected_process_full.load(Ordering::Relaxed),
        }
    }
}

impl UnicastReceiver {
    pub(crate) fn take_overload_close(&mut self) -> Option<OutboxMessage> {
        if !self.overloaded.swap(false, Ordering::AcqRel) {
            return None;
        }
        // Serialize against commits holding an OwnedPermit. Once this flag is
        // false no pre-existing reservation can enqueue after the drain.
        *self
            .receiver_open
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
        // This connection is closing, so discard all queued payloads first.
        // Their guards release local/process capacity before the terminal
        // close is charged.
        self.receiver.close();
        while self.receiver.try_recv().is_ok() {}
        reserve_process_message_with_budget(overload_close(), Arc::clone(&self.connection_budget))
            .ok()
    }

    pub(crate) async fn recv_reserved(&mut self) -> Option<OutboxMessage> {
        loop {
            // `signal_pressure` uses `notify_waiters`, which deliberately does
            // not retain a permit for a future waiter. Register first, then
            // re-check the durable atomic state so a close signalled just
            // before this receive cannot be missed.
            let notify = Arc::clone(&self.overload_notify);
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(close) = self.take_overload_close() {
                return Some(close);
            }
            tokio::select! {
                biased;
                () = &mut notified => {
                    if let Some(close) = self.take_overload_close() {
                        return Some(close);
                    }
                }
                message = self.receiver.recv() => {
                    return message;
                }
            }
        }
    }

    #[cfg(test)]
    pub async fn recv(&mut self) -> Option<Message> {
        let mut reserved = self.recv_reserved().await?;
        Some(reserved.take_message())
    }

    #[cfg(test)]
    pub fn try_recv(&mut self) -> Result<Message, mpsc::error::TryRecvError> {
        self.receiver
            .try_recv()
            .map(|mut reserved| reserved.take_message())
    }
}

fn overload_close() -> Message {
    Message::Close(Some(axum::extract::ws::CloseFrame {
        code: 1013,
        // Keep the terminal control payload intrinsically admissible even in
        // deliberately tiny-budget tests. Code 1013 carries the semantics.
        reason: "".into(),
    }))
}

fn message_bytes(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        Message::Binary(bytes) | Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
        Message::Close(frame) => frame
            .as_ref()
            .map_or(2, |frame| 2usize.saturating_add(frame.reason.len())),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Barrier;

    use super::*;
    use serde::Serializer;

    #[tokio::test]
    async fn enforces_message_and_byte_limits_and_releases_accounting() {
        let (sender, mut receiver) = unicast_channel(2, 5);
        sender.send(Message::Binary(vec![1, 2, 3].into())).unwrap();
        assert_eq!(sender.queued_bytes(), 3);
        assert_eq!(
            sender.send(Message::Binary(vec![4, 5, 6].into())),
            Err(OutboxSendError::Full)
        );
        assert_eq!(sender.metrics().rejected_full, 1);
        assert!(matches!(receiver.recv().await, Some(Message::Close(_))));
        assert!(receiver.recv().await.is_none());
        assert_eq!(sender.queued_bytes(), 0);

        assert_eq!(
            sender.send(Message::Binary(vec![0; 6].into())),
            Err(OutboxSendError::Oversized)
        );
        assert_eq!(sender.metrics().rejected_oversized, 1);
    }

    #[tokio::test]
    async fn overload_close_signalled_before_receive_is_not_lost() {
        let (sender, mut receiver, budget) =
            unicast_channel_with_process_budget_probe(1, 1024, 4096);
        sender.force_overload_close();

        let message = tokio::time::timeout(std::time::Duration::from_millis(100), receiver.recv())
            .await
            .expect("durable overload state must wake a late receiver")
            .expect("overload must produce a coded close");
        assert!(matches!(message, Message::Close(_)));
        drop(message);
        drop(sender);
        drop(receiver);
        assert_eq!(budget.queued_bytes(), 0);
    }

    #[test]
    fn closed_receiver_releases_reserved_bytes() {
        let (sender, receiver) = unicast_channel(1, 8);
        drop(receiver);
        assert_eq!(
            sender.send(Message::Binary(vec![0; 4].into())),
            Err(OutboxSendError::Closed)
        );
        assert_eq!(sender.queued_bytes(), 0);
    }

    #[test]
    fn oversized_preflight_never_invokes_message_builder() {
        let budget = Arc::new(ProcessOutboxBudget::new(512));
        let (sender, receiver) = unicast_channel_with_budget(1, 4, Arc::clone(&budget));
        let invoked = AtomicBool::new(false);

        let result = sender.send_prepared(5, || {
            invoked.store(true, Ordering::Release);
            Ok::<_, ()>(Message::Binary(vec![0; 5].into()))
        });

        assert_eq!(
            result,
            Err(PreparedSendError::Outbox(OutboxSendError::Oversized))
        );
        assert!(!invoked.load(Ordering::Acquire));
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 127);
        drop(sender);
        drop(receiver);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn process_intrinsic_oversize_skips_builder_without_slow_consumer_close() {
        let budget = Arc::new(ProcessOutboxBudget::new(256));
        let (sender, mut receiver) = unicast_channel_with_budget(1, 16, Arc::clone(&budget));
        let invoked = AtomicBool::new(false);

        let result = sender.send_prepared(5, || {
            invoked.store(true, Ordering::Release);
            Ok::<_, ()>(Message::Binary(vec![0; 5].into()))
        });

        assert_eq!(
            result,
            Err(PreparedSendError::Outbox(OutboxSendError::Oversized))
        );
        assert!(!invoked.load(Ordering::Acquire));
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(sender.metrics().rejected_oversized, 1);
        assert_eq!(sender.metrics().rejected_process_full, 0);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 127);
        assert_eq!(budget.rejected_full.load(Ordering::Acquire), 0);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), receiver.recv())
                .await
                .is_err(),
            "a permanently inadmissible frame must not schedule an overload close"
        );
    }

    #[test]
    fn prepare_error_and_length_mismatch_release_every_reservation() {
        let budget = Arc::new(ProcessOutboxBudget::new(512));
        let (sender, receiver) = unicast_channel_with_budget(2, 16, Arc::clone(&budget));

        assert_eq!(
            sender.send_prepared(4, || Err::<Message, _>("encode failed")),
            Err(PreparedSendError::Prepare("encode failed"))
        );
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(
            budget.queued_bytes.load(Ordering::Acquire),
            sender
                .connection_budget
                .planned_capacity
                .load(Ordering::Acquire)
        );
        let mismatch = sender.send_prepared(4, || Ok::<_, ()>(Message::Binary(vec![0; 5].into())));
        assert_eq!(
            mismatch,
            Err(PreparedSendError::Outbox(
                OutboxSendError::ReservationMismatch {
                    reserved: 4,
                    actual: 5,
                }
            ))
        );
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(
            budget.queued_bytes.load(Ordering::Acquire),
            sender
                .connection_budget
                .planned_capacity
                .load(Ordering::Acquire)
        );
        drop(sender);
        drop(receiver);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn count_limit_rejection_does_not_add_or_leak_byte_charges() {
        let budget = Arc::new(ProcessOutboxBudget::new(512));
        let (sender, mut receiver) = unicast_channel_with_budget(1, 16, Arc::clone(&budget));
        sender.send(Message::Binary(vec![1; 4].into())).unwrap();
        let invoked = AtomicBool::new(false);

        let result = sender.send_prepared(3, || {
            invoked.store(true, Ordering::Release);
            Ok::<_, ()>(Message::Binary(vec![2; 3].into()))
        });
        assert_eq!(
            result,
            Err(PreparedSendError::Outbox(OutboxSendError::Full))
        );
        assert!(!invoked.load(Ordering::Acquire));
        assert_eq!(sender.queued_bytes(), 4);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 254 + 4);

        assert!(matches!(receiver.recv().await, Some(Message::Close(_))));
        assert!(receiver.recv().await.is_none());
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 254);
        drop(sender);
        drop(receiver);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn reserved_message_releases_when_receiver_closes_before_commit() {
        let budget = Arc::new(ProcessOutboxBudget::new(512));
        let (sender, receiver) = unicast_channel_with_budget(1, 8, Arc::clone(&budget));
        let reservation = sender.reserve(4).expect("reservation");
        assert_eq!(sender.queued_bytes(), 4);
        drop(receiver);

        assert_eq!(
            reservation.commit(Message::Binary(vec![0; 4].into())),
            Err(OutboxSendError::Closed)
        );
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 254);
        drop(sender);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn concurrent_preallocation_never_exceeds_local_or_process_budget() {
        let budget = Arc::new(ProcessOutboxBudget::new(263));
        let (sender, receiver) = unicast_channel_with_budget(16, 10, Arc::clone(&budget));
        let start = Arc::new(Barrier::new(9));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let sender = sender.clone();
            let start = Arc::clone(&start);
            workers.push(std::thread::spawn(move || {
                start.wait();
                sender.reserve(3).ok()
            }));
        }
        start.wait();

        let reservations: Vec<_> = workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(reservations.len(), 3);
        assert_eq!(sender.queued_bytes(), 9);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 254 + 9);
        assert!(sender.queued_bytes() <= 10);
        assert!(budget.queued_bytes.load(Ordering::Acquire) <= 263);
        drop(reservations);
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 254);
        drop(sender);
        drop(receiver);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn flood_remains_byte_bounded_and_drain_releases_every_reservation() {
        let (sender, mut receiver) = unicast_channel(256, 1_024);
        let payload = vec![7; 17];
        let mut admitted = 0usize;
        for _ in 0..10_000 {
            if sender.send(Message::Binary(payload.clone().into())).is_ok() {
                admitted += 1;
            }
            assert!(sender.queued_bytes() <= 1_024);
        }
        assert_eq!(admitted, 1_024 / payload.len());
        assert!(sender.metrics().rejected_full > 0);

        // Overload is delivered out-of-band after draining every admitted
        // frame and releasing its local/process guards.
        assert!(matches!(receiver.recv().await, Some(Message::Close(_))));
        assert!(receiver.recv().await.is_none());
        assert_eq!(sender.queued_bytes(), 0);
    }

    #[tokio::test]
    async fn process_pressure_closes_actual_holder_and_keeps_requester_open() {
        let budget = Arc::new(ProcessOutboxBudget::new(386));
        let (first, mut first_rx) = unicast_channel_with_budget(2, 8, Arc::clone(&budget));
        let (second, mut second_rx) = unicast_channel_with_budget(2, 8, Arc::clone(&budget));
        let first_pressure = first.overload_watch();
        let second_pressure = second.overload_watch();

        first.send(Message::Binary(vec![1, 2, 3].into())).unwrap();
        assert_eq!(
            second.send(Message::Binary(vec![4, 5, 6].into())),
            Err(OutboxSendError::ProcessFull),
        );
        assert_eq!(second.queued_bytes(), 0);
        assert_eq!(second.metrics().rejected_process_full, 1);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 384);
        first_pressure.triggered().await;
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(10),
                second_pressure.triggered()
            )
            .await
            .is_err(),
            "healthy requester must not inherit the holder's pressure"
        );
        assert_eq!(budget.connection_victims.load(Ordering::Acquire), 1);

        let close = first_rx.take_overload_close().expect("holder close");
        assert!(matches!(close.message(), Message::Close(Some(frame)) if frame.code == 1013));
        drop(close);
        drop(first);
        drop(first_rx);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 127);

        second.send(Message::Binary(vec![4, 5, 6].into())).unwrap();
        assert!(matches!(second_rx.recv().await, Some(Message::Binary(_))));
        drop(second);
        drop(second_rx);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn requester_is_pressure_fallback_when_it_is_the_only_holder() {
        let budget = Arc::new(ProcessOutboxBudget::new(260));
        let (sender, mut receiver) = unicast_channel_with_budget(4, 32, Arc::clone(&budget));
        let pressure = sender.overload_watch();
        sender.send(Message::Binary(vec![1; 4].into())).unwrap();
        sender.send(Message::Binary(vec![2].into())).unwrap();
        sender.send(Message::Binary(vec![3].into())).unwrap();
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 260);
        assert_eq!(
            sender.send(Message::Binary(vec![4].into())),
            Err(OutboxSendError::ProcessFull)
        );
        pressure.triggered().await;
        assert_eq!(budget.connection_victims.load(Ordering::Acquire), 1);
        let close = receiver.take_overload_close().expect("self-holder close");
        drop(close);
        drop(sender);
        drop(receiver);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn larger_requester_is_selected_over_an_idle_peer_baseline() {
        let budget = Arc::new(ProcessOutboxBudget::new(385));
        let (requester, mut requester_rx) = unicast_channel_with_budget(4, 32, Arc::clone(&budget));
        let (idle, idle_rx) = unicast_channel_with_budget(1, 8, Arc::clone(&budget));
        let requester_pressure = requester.overload_watch();
        let idle_pressure = idle.overload_watch();

        requester.send(Message::Binary(vec![1; 4].into())).unwrap();
        assert!(
            budget.owned_bytes(requester.connection_budget.owner())
                > budget.owned_bytes(idle.connection_budget.owner())
        );
        assert_eq!(
            requester.send(Message::Binary(vec![2].into())),
            Err(OutboxSendError::ProcessFull)
        );
        requester_pressure.triggered().await;
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(10),
                idle_pressure.triggered(),
            )
            .await
            .is_err(),
            "an idle peer baseline must not shield the true requester holder"
        );
        drop(requester_rx.take_overload_close());
        drop(requester);
        drop(requester_rx);
        drop(idle);
        drop(idle_rx);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn broadcast_payload_and_alternate_capability_make_ring_the_largest_holder() {
        let primary = ServerMessage::PeerLeft { client_id: 9 };
        let alternate = ServerMessage::OpenDatasetFailed {
            request_id: "ring-owner".into(),
            url: "safe source".into(),
            error: "x".repeat(512),
            diagnostic: None,
        };
        let primary_len = serde_json::to_vec(&primary).unwrap().len();
        let alternate_len = serde_json::to_vec(&alternate).unwrap().len();
        let payload_bytes = primary_len + alternate_len;
        let ring_bytes = payload_bytes + wire_capability_bytes(alternate_len).unwrap();
        assert!(ring_bytes > MAX_AUTOMATIC_CONTROL_FRAME_BYTES);

        let budget = Arc::new(ProcessOutboxBudget::new(
            MAX_AUTOMATIC_CONTROL_FRAME_BYTES + ring_bytes,
        ));
        let (connection, connection_rx) = unicast_channel_with_budget(1, 8, Arc::clone(&budget));
        let ring = broadcast_channel_with_budget(1, payload_bytes, Arc::clone(&budget));
        let mut ring_rx = ring.subscribe();
        ring.send(BroadcastEvent::command(Some(7), primary, Some(alternate)))
            .unwrap();

        assert_eq!(budget.owned_bytes(ring.pressure.owner()), ring_bytes);
        assert_eq!(
            budget.owned_bytes(connection.connection_budget.owner()),
            MAX_AUTOMATIC_CONTROL_FRAME_BYTES
        );
        connection
            .send(Message::Binary(vec![1].into()))
            .expect("flushing the true largest ring retries requester admission");
        assert!(matches!(
            ring_rx.recv().await,
            Err(BroadcastRecvError::Pressure)
        ));
        assert_eq!(budget.ring_victims.load(Ordering::Acquire), 1);
        assert_eq!(budget.owned_bytes(ring.pressure.owner()), 0);

        drop(ring_rx);
        drop(ring);
        drop(connection);
        drop(connection_rx);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn alternate_wire_admission_transfers_exact_owner_without_accounting_gap() {
        let primary = ServerMessage::PeerLeft { client_id: 9 };
        let alternate = ServerMessage::OpenDatasetFailed {
            request_id: "alternate-owner-transfer".into(),
            url: "safe source".into(),
            error: "x".repeat(512),
            diagnostic: None,
        };
        let primary_len = serde_json::to_vec(&primary).unwrap().len();
        let alternate_len = serde_json::to_vec(&alternate).unwrap().len();
        let payload_bytes = primary_len + alternate_len;
        let wire_capability = wire_capability_bytes(alternate_len).unwrap();
        let budget = Arc::new(ProcessOutboxBudget::new(16 * 1024));
        let mut socket =
            SocketWriteBudget::with_process_budget(4 * 1024, Arc::clone(&budget)).unwrap();
        let connection_owner = socket.connection.owner();
        let ring = broadcast_channel_with_budget(1, payload_bytes, Arc::clone(&budget));
        let ring_owner = ring.pressure.owner();
        let mut ring_rx = ring.subscribe();
        ring.send(BroadcastEvent::command(Some(7), primary, Some(alternate)))
            .unwrap();
        let item = ring_rx.recv().await.expect("broadcast item");
        let mut outbound = item.outbound_for(7).expect("targeted alternate");

        let (before_total, before_owners) = budget.owner_snapshot();
        assert_eq!(before_total, before_owners.values().sum::<usize>());
        assert_eq!(
            before_owners.get(&ring_owner),
            Some(&(payload_bytes + wire_capability))
        );
        assert_eq!(
            before_owners.get(&connection_owner),
            Some(&MAX_AUTOMATIC_CONTROL_FRAME_BYTES)
        );

        socket
            .admit(&mut outbound)
            .expect("alternate wire admission");
        let (after_total, after_owners) = budget.owner_snapshot();
        assert_eq!(after_total, after_owners.values().sum::<usize>());
        assert_eq!(after_owners.get(&ring_owner), Some(&payload_bytes));
        assert_eq!(
            after_owners.get(&connection_owner),
            Some(&socket.reserved_bytes())
        );
        assert_eq!(
            after_total,
            payload_bytes + socket.reserved_bytes(),
            "unused capability is released while the exact planner delta transfers"
        );

        drop(outbound);
        drop(item);
        ring.signal_pressure();
        drop(ring_rx);
        drop(ring);
        drop(socket);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn equal_queued_frames_share_one_planned_socket_high_water() {
        const FRAMES: usize = 128;
        let budget = Arc::new(ProcessOutboxBudget::new(512));
        let (sender, receiver) = unicast_channel_with_budget(FRAMES, FRAMES, Arc::clone(&budget));
        for _ in 0..FRAMES {
            sender.send(Message::Binary(vec![7].into())).unwrap();
        }
        assert_eq!(sender.queued_bytes(), FRAMES);
        assert_eq!(
            sender
                .connection_budget
                .planned_capacity
                .load(Ordering::Acquire),
            254
        );
        assert_eq!(
            budget.queued_bytes.load(Ordering::Acquire),
            254 + FRAMES,
            "wire high-water is charged once, not once per queued frame"
        );
        drop(receiver);
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 254);
        drop(sender);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn dequeued_frame_remains_charged_until_socket_send_guard_is_dropped() {
        let budget = Arc::new(ProcessOutboxBudget::new(512));
        let (first, mut first_rx) = unicast_channel_with_budget(1, 5, Arc::clone(&budget));

        first.send(Message::Binary(vec![1, 2, 3].into())).unwrap();
        let mut in_flight = first_rx.recv_reserved().await.expect("reserved frame");
        assert_eq!(first.queued_bytes(), 3);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 257);

        let message = in_flight.take_message();
        assert!(matches!(message, Message::Binary(_)));
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 257);
        drop(in_flight);
        assert_eq!(first.queued_bytes(), 0);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 254);
        drop(first);
        drop(first_rx);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    struct CountedJson<'a> {
        calls: &'a AtomicUsize,
        payload: &'a str,
    }

    impl Serialize for CountedJson<'_> {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            self.calls.fetch_add(1, Ordering::AcqRel);
            serializer.serialize_str(self.payload)
        }
    }

    fn peer_left_event(client_id: ClientId) -> BroadcastEvent {
        BroadcastEvent::peer_left(ServerMessage::PeerLeft { client_id })
    }

    fn peer_left_len(client_id: ClientId) -> usize {
        serde_json::to_vec(&ServerMessage::PeerLeft { client_id })
            .unwrap()
            .len()
    }

    #[test]
    fn mandatory_wire_capacity_rejects_before_json_materialization() {
        let budget = Arc::new(ProcessOutboxBudget::new(256));
        let (sender, _receiver) = unicast_channel_with_budget(2, 100, Arc::clone(&budget));
        let calls = AtomicUsize::new(0);
        // The 60-byte JSON fits the connection, but its payload plus the
        // connection planner's control-aware target cannot fit P=256.
        let payload = "x".repeat(58);
        let value = CountedJson {
            calls: &calls,
            payload: &payload,
        };

        assert!(matches!(
            sender.send_json(&value, 100),
            Err(PreparedJsonError::Outbox(OutboxSendError::Oversized))
        ));
        assert_eq!(
            calls.load(Ordering::Acquire),
            1,
            "only the allocation-free counting pass may run"
        );
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 127);
    }

    #[tokio::test]
    async fn control_and_bulk_share_one_local_cap_and_control_wins_ready_race() {
        let budget = Arc::new(ProcessOutboxBudget::new(512));
        let (bulk_tx, mut bulk_rx, control_tx, mut control_rx) =
            connection_unicast_channels_with_process_budget(1, 1, 16, Arc::clone(&budget));
        bulk_tx
            .send(Message::Binary(vec![7; 10].into()))
            .expect("bulk frame");
        control_tx.send_json(&"abc", 16).expect("control outcome");
        assert_eq!(bulk_tx.queued_bytes(), 15);
        assert_eq!(control_tx.queued_bytes(), 15);

        let mut control = tokio::select! {
            biased;
            message = control_rx.recv_reserved() => message.expect("control frame"),
            _ = bulk_rx.recv_reserved() => panic!("bulk must not overtake ready control"),
        };
        assert_eq!(
            bulk_tx.queued_bytes(),
            15,
            "dequeue remains locally charged"
        );
        let mut socket = bulk_tx.socket_write_budget();
        socket.admit(&mut control).expect("control wire admission");
        let _ = control.take_message();
        drop(control);
        assert_eq!(bulk_tx.queued_bytes(), 10);
        assert_eq!(
            socket.reserved_bytes(),
            socket_write_capacity_target(
                MAX_AUTOMATIC_CONTROL_FRAME_BYTES,
                wire_frame_bytes(5).unwrap(),
            )
            .unwrap()
        );

        let mut bulk = bulk_rx.recv_reserved().await.expect("bulk frame");
        socket.admit(&mut bulk).expect("bulk wire admission");
        let _ = bulk.take_message();
        drop(bulk);
        assert_eq!(bulk_tx.queued_bytes(), 0);
        let expected_socket = 254;
        assert_eq!(socket.reserved_bytes(), expected_socket);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), expected_socket);
        drop(socket);
        drop(bulk_tx);
        drop(control_tx);
        drop(bulk_rx);
        drop(control_rx);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn bulk_overload_watch_preempts_continuously_ready_broadcast_and_drains() {
        let budget = Arc::new(ProcessOutboxBudget::new(512));
        let (bulk_tx, mut bulk_rx) = unicast_channel_with_budget(1, 32, Arc::clone(&budget));
        let watch = bulk_tx.overload_watch();
        bulk_tx.send(Message::Binary(vec![1; 8].into())).unwrap();
        assert_eq!(
            bulk_tx.send(Message::Binary(vec![2; 8].into())),
            Err(OutboxSendError::Full)
        );
        let broadcast = broadcast_channel_with_budget(2, 64, Arc::clone(&budget));
        let mut broadcast_rx = broadcast.subscribe();
        broadcast.send(peer_left_event(7)).unwrap();

        tokio::select! {
            biased;
            () = watch.triggered() => {}
            _ = broadcast_rx.recv() => panic!("ready broadcast starved overload close"),
        }
        let close = bulk_rx.take_overload_close().expect("1013 close");
        assert!(matches!(close.message(), Message::Close(Some(frame)) if frame.code == 1013));
        drop(close);
        broadcast.signal_pressure();
        drop(broadcast_rx);
        drop(broadcast);
        assert_eq!(bulk_tx.queued_bytes(), 0);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 254);
        drop(bulk_tx);
        drop(bulk_rx);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn rounded_broadcast_rings_flush_every_retained_slot_across_workspaces() {
        for requested in [3usize, 5] {
            let capacity = requested.next_power_of_two();
            let bytes = peer_left_len(1);
            let budget = Arc::new(ProcessOutboxBudget::new(bytes * capacity));
            let first =
                broadcast_channel_with_budget(requested, bytes * capacity, Arc::clone(&budget));
            let mut first_rx = first.subscribe();
            let second =
                broadcast_channel_with_budget(requested, bytes * capacity, Arc::clone(&budget));
            let mut second_rx = second.subscribe();

            for client_id in 0..capacity as u32 {
                first.send(peer_left_event(client_id)).unwrap();
            }
            assert_eq!(first.queued_bytes(), bytes * capacity);
            second
                .prepare(peer_left_event(9))
                .expect("selected-ring reclaim retries admission")
                .publish();
            assert_eq!(first.queued_bytes(), 0, "requested capacity {requested}");
            assert_eq!(second.queued_bytes(), bytes);
            assert_eq!(budget.queued_bytes.load(Ordering::Acquire), bytes);
            assert!(matches!(
                first_rx.recv().await,
                Err(BroadcastRecvError::Pressure)
            ));
            assert!(second_rx.recv().await.is_ok(), "unrelated ring was flushed");
            assert_eq!(budget.ring_victims.load(Ordering::Acquire), 1);

            drop(first_rx);
            drop(second_rx);
            drop(first);
            drop(second);
            assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
        }
    }

    #[tokio::test]
    async fn pressure_epoch_turns_flush_induced_lag_into_close_without_snapshot_charge() {
        let bytes = peer_left_len(1);
        let budget = Arc::new(ProcessOutboxBudget::new(bytes * 8));
        let sender = broadcast_channel_with_budget(3, bytes * 8, Arc::clone(&budget));
        let mut receiver = sender.subscribe();
        for client_id in 0..4 {
            sender.send(peer_left_event(client_id)).unwrap();
        }
        sender.signal_pressure();
        assert!(matches!(
            receiver.recv().await,
            Err(BroadcastRecvError::Pressure)
        ));
        assert_eq!(
            budget.queued_bytes.load(Ordering::Acquire),
            0,
            "pressure recovery must not reserve a replacement snapshot"
        );
    }

    #[tokio::test]
    async fn fanout_wire_high_water_is_charged_per_recipient_until_socket_drop() {
        const RECIPIENTS: usize = 3;
        let payload_bytes = peer_left_len(44);
        let wire_bytes = socket_write_capacity_target(
            MAX_AUTOMATIC_CONTROL_FRAME_BYTES,
            wire_frame_bytes(payload_bytes).unwrap(),
        )
        .unwrap();
        let budget = Arc::new(ProcessOutboxBudget::new(4_096));
        let sender = broadcast_channel_with_budget(8, 1_024, Arc::clone(&budget));
        let mut receivers: Vec<_> = (0..RECIPIENTS).map(|_| sender.subscribe()).collect();
        sender.send(peer_left_event(44)).unwrap();

        let mut sockets = Vec::new();
        for receiver in &mut receivers {
            let item = receiver.recv().await.expect("broadcast item");
            let mut outbound = item.outbound_for(999).expect("recipient frame");
            let mut socket =
                SocketWriteBudget::with_process_budget(DEFAULT_OUTBOX_BYTES, Arc::clone(&budget))
                    .unwrap();
            socket.admit(&mut outbound).expect("wire capacity");
            let _ = outbound.take_message();
            drop(outbound);
            drop(item);
            sockets.push(socket);
        }
        sender.signal_pressure();
        assert_eq!(
            budget.queued_bytes.load(Ordering::Acquire),
            wire_bytes * RECIPIENTS,
            "flushed ring storage is gone but idle socket Vec capacity remains charged"
        );
        for socket in sockets {
            drop(socket);
        }
        drop(receivers);
        drop(sender);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn socket_high_water_models_raw_vec_doubling_and_releases_only_on_drop() {
        let budget = Arc::new(ProcessOutboxBudget::new(1_024));
        let mut socket =
            SocketWriteBudget::with_process_budget(DEFAULT_OUTBOX_BYTES, Arc::clone(&budget))
                .unwrap();

        let mut first = reserve_process_message_with_budget(
            Message::Binary(vec![0; 8].into()),
            Arc::clone(&socket.connection),
        )
        .unwrap();
        socket.admit(&mut first).unwrap();
        let _ = first.take_message();
        drop(first);
        let first_target = socket_write_capacity_target(
            MAX_AUTOMATIC_CONTROL_FRAME_BYTES,
            wire_frame_bytes(8).unwrap(),
        )
        .unwrap();
        assert_eq!(socket.reserved_bytes(), first_target);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), first_target);

        // A pending automatic control frame can append after a partial write;
        // model that second transition as well as the application frame.
        let mut second = reserve_process_message_with_budget(
            Message::Binary(vec![0; 198].into()),
            Arc::clone(&socket.connection),
        )
        .unwrap();
        socket.admit(&mut second).unwrap();
        let _ = second.take_message();
        drop(second);
        let second_target =
            socket_write_capacity_target(first_target, wire_frame_bytes(198).unwrap()).unwrap();
        assert_eq!(socket.reserved_bytes(), second_target);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), second_target);

        drop(socket);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn wire_capability_covers_every_reachable_control_append_transition() {
        for payload in 0..=2_048usize {
            let needed = wire_frame_bytes(payload).unwrap();
            let capability = wire_capability_bytes(payload).unwrap();
            for capacity in MAX_AUTOMATIC_CONTROL_FRAME_BYTES..=4_096 {
                let target = socket_write_capacity_target(capacity, needed).unwrap();
                let delta = target - capacity;
                assert!(
                    delta <= capability,
                    "payload={payload}, capacity={capacity}, needed={needed}, target={target}, capability={capability}"
                );
            }
        }

        // Header-boundary counterexample: payload 126 uses a 4-byte header,
        // so N=130. From the mandatory C=127 baseline, app growth reaches
        // 254 and one pending Pong grows it again to 508 (delta 381).
        assert_eq!(
            socket_write_capacity_target(MAX_AUTOMATIC_CONTROL_FRAME_BYTES, 130).unwrap(),
            508
        );
        assert!(wire_capability_bytes(126).unwrap() >= 381);
    }

    #[test]
    fn minimum_configured_budget_is_derived_from_coded_close_admission() {
        let minimum = minimum_process_outbox_bytes();
        assert_eq!(minimum, 2 + 254);
        let budget = ProcessOutboxBudget::new(1);
        assert!(budget.configure(minimum - 1).is_err());
        assert!(budget.configure(minimum).is_ok());
    }

    #[test]
    fn overload_close_serializes_with_preexisting_owned_permit_commit() {
        let budget = Arc::new(ProcessOutboxBudget::new(300));
        let (sender, mut receiver) = unicast_channel_with_budget(1, 32, Arc::clone(&budget));
        let reservation = sender.reserve(4).expect("held count permit");
        assert_eq!(
            sender.send(Message::Binary(vec![9].into())),
            Err(OutboxSendError::Full)
        );

        let gate = Arc::new(Barrier::new(2));
        let worker_gate = Arc::clone(&gate);
        let commit = std::thread::spawn(move || {
            worker_gate.wait();
            reservation.commit(Message::Binary(vec![1; 4].into()))
        });
        gate.wait();
        let close = receiver.take_overload_close().expect("1013 close");
        let result = commit.join().unwrap();
        assert!(matches!(result, Ok(()) | Err(OutboxSendError::Closed)));
        assert_eq!(
            sender.queued_bytes(),
            2,
            "terminal close remains locally charged"
        );
        drop(close);
        assert_eq!(sender.queued_bytes(), 0);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 254);
        drop(sender);
        drop(receiver);
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn aborting_stalled_precommit_work_releases_all_capability_bytes() {
        let budget = Arc::new(ProcessOutboxBudget::new(1_024));
        let sender = broadcast_channel_with_budget(4, 512, Arc::clone(&budget));
        let _receiver = sender.subscribe();
        let prepared = sender
            .prepare(BroadcastEvent::command(
                Some(7),
                ServerMessage::PeerLeft { client_id: 7 },
                Some(ServerMessage::Ack {
                    request_id: "paused-store".into(),
                    seq: 1,
                }),
            ))
            .expect("prepared durable outcome");
        assert!(budget.queued_bytes.load(Ordering::Acquire) > 0);
        let stalled = tokio::spawn(async move {
            let _prepared = prepared;
            std::future::pending::<()>().await;
        });
        stalled.abort();
        assert!(stalled.await.unwrap_err().is_cancelled());
        assert_eq!(budget.queued_bytes.load(Ordering::Acquire), 0);
    }
}
