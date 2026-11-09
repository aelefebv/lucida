//! A dev-only throttle on the link between the server and its clients, so a
//! page on the same machine waits for its chunks the way a page across a
//! network does: every message on the session socket pays half a round trip
//! each way, and what the server sends a connection crosses at a capped rate.
//!
//! It sits on the server's end of the socket rather than in the browser's
//! network emulation. That holds it the same for every client, a page in
//! any browser, the CLI, or a run against a server someone else started,
//! and lets the server report it wherever it reports the source throttle.
//! Chrome's `Network.emulateNetworkConditions` does slow the socket, but not
//! to its settings: in Chrome 156 a cold open's chunks crossed at about
//! 0.15 MB/s whether it was set to 2 MB/s or to 12.5 MB/s.
//!
//! Off unless installed, and nothing installs it unless the server is told
//! to: a deployment that never sets it sends at full speed.

use std::collections::VecDeque;
use std::future::Future;
use std::num::NonZeroU64;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll, ready};
use std::time::Duration;

use axum::extract::ws::Message;
use futures_util::future::Either;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use lucida_protocol::LinkThrottleReport;
use lucida_store::backend::CLIENT_FETCH_TIMEOUT;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{Instant, Sleep};

/// The most chunk bytes the web client keeps in flight, its
/// `cpuBytesInFlight` ceiling in `lucida-web/src/deviceBudget.ts`. A chunk
/// request sent behind a full window waits for all of it to cross the link.
const CLIENT_MAX_BYTES_IN_FLIGHT: u64 = 32 * 1024 * 1024;

/// A named starting point for the throttle's settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum LinkThrottleProfile {
    /// No throttle: the page and the server on one machine.
    Local,
    /// A page on a typical office or home link to a server in its own
    /// country.
    Broadband,
}

impl LinkThrottleProfile {
    pub fn name(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Broadband => "broadband",
        }
    }

    pub fn settings(self) -> LinkThrottleSettings {
        match self {
            Self::Local => LinkThrottleSettings::OFF,
            // The FCC's fixed broadband benchmark is 100 Mbit/s down
            // (2024 Section 706 Report, FCC 24-27). The round trip is a
            // home's own to its ISP, a median 7-14 ms idle on fiber and
            // more on cable (FCC, Thirteenth Measuring Broadband America
            // Fixed Broadband Report), plus a region away: Azure's P50 from
            // East US is 19 ms to North Central US and 28 ms to Central US
            // ("Azure network round-trip latency statistics", July 2026).
            Self::Broadband => LinkThrottleSettings {
                latency: Duration::from_millis(40),
                bytes_per_sec: NonZeroU64::new(12_500_000),
            },
        }
    }
}

/// What the throttle does to the session socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkThrottleSettings {
    /// Added to every round trip, half to each direction.
    pub latency: Duration,
    /// The cap on what the server sends one connection. `None` is no cap.
    pub bytes_per_sec: Option<NonZeroU64>,
}

impl LinkThrottleSettings {
    pub const OFF: Self = Self {
        latency: Duration::ZERO,
        bytes_per_sec: None,
    };

    fn is_off(&self) -> bool {
        *self == Self::OFF
    }

    /// The longest a chunk request can wait on the link: its round trip,
    /// behind a full in-flight window.
    fn worst_wait(&self) -> Duration {
        let drain = self.bytes_per_sec.map_or(Duration::ZERO, |rate| {
            Duration::from_secs_f64(CLIENT_MAX_BYTES_IN_FLIGHT as f64 / rate.get() as f64)
        });
        self.latency.saturating_add(drain)
    }
}

/// What an operator asked for: a profile, and any value set by hand, which
/// replaces the profile's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LinkThrottleConfig {
    pub profile: Option<LinkThrottleProfile>,
    pub latency_ms: Option<u64>,
    /// Zero lifts the cap.
    pub bytes_per_sec: Option<u64>,
}

/// Why a throttle configuration was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkThrottleConfigError {
    /// The page gives a chunk request [`CLIENT_FETCH_TIMEOUT`] from when it
    /// sends it, and the server's own read, which the source throttle can
    /// slow by seconds, needs its share. A link that can take half of that
    /// would time requests out and measure the retries.
    WouldTimeOut { wait_ms: u64, limit_ms: u64 },
}

impl std::fmt::Display for LinkThrottleConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WouldTimeOut { wait_ms, limit_ms } => write!(
                f,
                "link throttle round trip plus the time {} MiB in flight takes to cross is \
                 {wait_ms} ms, at or past the {limit_ms} ms the link may take of the page's \
                 chunk timeout",
                CLIENT_MAX_BYTES_IN_FLIGHT / (1024 * 1024)
            ),
        }
    }
}

impl std::error::Error for LinkThrottleConfigError {}

impl LinkThrottleConfig {
    /// The throttle this asks for, or `None` when it asks for none.
    pub fn resolve(self) -> Result<Option<LinkThrottle>, LinkThrottleConfigError> {
        let base = self
            .profile
            .map_or(LinkThrottleSettings::OFF, LinkThrottleProfile::settings);
        let settings = LinkThrottleSettings {
            latency: self.latency_ms.map_or(base.latency, Duration::from_millis),
            bytes_per_sec: self
                .bytes_per_sec
                .map_or(base.bytes_per_sec, NonZeroU64::new),
        };
        if settings.is_off() {
            return Ok(None);
        }
        let limit = CLIENT_FETCH_TIMEOUT / 2;
        let wait = settings.worst_wait();
        if wait >= limit {
            return Err(LinkThrottleConfigError::WouldTimeOut {
                wait_ms: wait.as_millis() as u64,
                limit_ms: limit.as_millis() as u64,
            });
        }
        // A profile is named only while its values are its own, so a label
        // never names a profile the numbers beside it are not.
        let profile = self
            .profile
            .filter(|profile| profile.settings() == settings);
        Ok(Some(LinkThrottle { profile, settings }))
    }
}

/// A throttle in force. Each connection paces its own sends, since each
/// client has a link of its own.
#[derive(Debug)]
pub struct LinkThrottle {
    profile: Option<LinkThrottleProfile>,
    settings: LinkThrottleSettings,
}

impl LinkThrottle {
    pub fn report(&self) -> LinkThrottleReport {
        LinkThrottleReport {
            profile: self.profile.map(|profile| profile.name().to_string()),
            latency_ms: self.settings.latency.as_millis() as u64,
            bytes_per_sec: self.settings.bytes_per_sec.map(NonZeroU64::get),
        }
    }

    fn one_way(&self) -> Duration {
        self.settings.latency / 2
    }
}

static INSTALLED: OnceLock<Arc<LinkThrottle>> = OnceLock::new();

/// Throttle every session socket opened from now on. Returns false, and
/// changes nothing, when one is already installed.
pub fn install(throttle: LinkThrottle) -> bool {
    INSTALLED.set(Arc::new(throttle)).is_ok()
}

/// The installed throttle's report, or `None` when the server sends at full
/// speed.
pub fn report() -> Option<LinkThrottleReport> {
    INSTALLED.get().map(|throttle| throttle.report())
}

/// The sending half of a connection's socket, behind the installed
/// throttle, and the task that writes to the socket when there is one. The
/// task outlives the sink by at most half a round trip: await it for
/// everything sent to have reached the socket.
pub fn outbound<S>(socket: S) -> (OutboundLink<S>, Option<JoinHandle<()>>)
where
    S: Sink<Message, Error = axum::Error> + Send + Unpin + 'static,
{
    match INSTALLED.get() {
        Some(throttle) => {
            let (sink, writer) = paced(socket, Arc::clone(throttle));
            (Either::Right(sink), Some(writer))
        }
        None => (Either::Left(socket), None),
    }
}

/// The receiving half of a connection's socket, behind the installed
/// throttle.
pub fn inbound<S>(socket: S) -> Either<S, Delayed<S>>
where
    S: Stream + Unpin,
{
    match INSTALLED.get() {
        Some(throttle) => Either::Right(Delayed::new(socket, throttle.one_way())),
        None => Either::Left(socket),
    }
}

pub type OutboundLink<S> = Either<S, PacedSink>;

/// What [`paced`] returns for the outbound loop to send through.
pub type PacedSink = Pin<Box<dyn Sink<Message, Error = axum::Error> + Send>>;

/// A send returns once the message's bytes have left at the link's rate, so
/// a backlog waits in the connection's queue, under its budget, as it would
/// behind a real socket. The latency is added after that, by the writer,
/// without holding up the next send: messages in flight overlap, as on a
/// real link, rather than paying a round trip each in turn.
fn paced<S>(socket: S, throttle: Arc<LinkThrottle>) -> (PacedSink, JoinHandle<()>)
where
    S: Sink<Message, Error = axum::Error> + Send + Unpin + 'static,
{
    let (due_tx, mut due_rx) = mpsc::unbounded_channel::<(Instant, Message)>();
    let writer = tokio::spawn(async move {
        let mut socket = socket;
        while let Some((due, message)) = due_rx.recv().await {
            tokio::time::sleep_until(due).await;
            if socket.send(message).await.is_err() {
                break;
            }
        }
    });
    let pacer = Pacer {
        rate: throttle.settings.bytes_per_sec,
        free_at: None,
    };
    let one_way = throttle.one_way();
    let sink = futures_util::sink::unfold(
        (due_tx, pacer),
        move |(due_tx, mut pacer), message: Message| async move {
            let sent = pacer.send(payload_len(&message)).await;
            due_tx
                .send((sent + one_way, message))
                .map_err(|_| axum::Error::new("the link throttle's writer stopped"))?;
            Ok((due_tx, pacer))
        },
    );
    (Box::pin(sink), writer)
}

/// One connection's share of the link's rate.
struct Pacer {
    rate: Option<NonZeroU64>,
    /// When the bytes already sent will have left.
    free_at: Option<Instant>,
}

impl Pacer {
    /// Wait for `bytes` to leave, and return when they had.
    async fn send(&mut self, bytes: usize) -> Instant {
        let now = Instant::now();
        let Some(rate) = self.rate else {
            return now;
        };
        let start = self.free_at.map_or(now, |free| free.max(now));
        let done = start + Duration::from_secs_f64(bytes as f64 / rate.get() as f64);
        self.free_at = Some(done);
        tokio::time::sleep_until(done).await;
        done
    }
}

fn payload_len(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        Message::Binary(bytes) => bytes.len(),
        Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
        Message::Close(_) => 0,
    }
}

/// `inner`, each item handed on half a round trip after it arrived. The
/// page's messages are requests and acknowledgements of a few hundred bytes,
/// so this direction has no bandwidth cap.
pub struct Delayed<S: Stream> {
    inner: S,
    one_way: Duration,
    queue: VecDeque<(Instant, S::Item)>,
    ended: bool,
    timer: Pin<Box<Sleep>>,
}

impl<S: Stream> Delayed<S> {
    fn new(inner: S, one_way: Duration) -> Self {
        Self {
            inner,
            one_way,
            queue: VecDeque::new(),
            ended: false,
            timer: Box::pin(tokio::time::sleep_until(Instant::now())),
        }
    }
}

impl<S> Stream for Delayed<S>
where
    S: Stream + Unpin,
    S::Item: Unpin,
{
    type Item = S::Item;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<S::Item>> {
        let this = self.get_mut();
        // Read everything waiting, so each item's clock starts when it
        // arrived and not when the one ahead of it was handed on.
        while !this.ended {
            match this.inner.poll_next_unpin(cx) {
                Poll::Ready(Some(item)) => {
                    this.queue.push_back((Instant::now() + this.one_way, item));
                }
                Poll::Ready(None) => this.ended = true,
                Poll::Pending => break,
            }
        }
        let Some(&(due, _)) = this.queue.front() else {
            return if this.ended {
                Poll::Ready(None)
            } else {
                Poll::Pending
            };
        };
        if this.timer.deadline() != due {
            this.timer.as_mut().reset(due);
        }
        ready!(this.timer.as_mut().poll(cx));
        Poll::Ready(this.queue.pop_front().map(|(_, item)| item))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    fn config(
        profile: Option<LinkThrottleProfile>,
        latency_ms: Option<u64>,
        bytes_per_sec: Option<u64>,
    ) -> LinkThrottleConfig {
        LinkThrottleConfig {
            profile,
            latency_ms,
            bytes_per_sec,
        }
    }

    fn throttle(latency_ms: u64, bytes_per_sec: Option<u64>) -> Arc<LinkThrottle> {
        Arc::new(LinkThrottle {
            profile: None,
            settings: LinkThrottleSettings {
                latency: Duration::from_millis(latency_ms),
                bytes_per_sec: bytes_per_sec.and_then(NonZeroU64::new),
            },
        })
    }

    /// A sink that records when each message reached it.
    fn recording_socket() -> (
        impl Sink<Message, Error = axum::Error> + Send + Unpin + 'static,
        mpsc::UnboundedReceiver<(Instant, Message)>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        let sink = futures_util::sink::unfold(tx, |tx, message: Message| async move {
            let _ = tx.send((Instant::now(), message));
            Ok::<_, axum::Error>(tx)
        });
        (Box::pin(sink), rx)
    }

    fn binary(len: usize) -> Message {
        Message::Binary(vec![0u8; len].into())
    }

    #[test]
    fn nothing_set_and_the_local_profile_are_both_off() {
        assert!(LinkThrottleConfig::default().resolve().unwrap().is_none());
        let local = config(Some(LinkThrottleProfile::Local), None, None);
        assert!(local.resolve().unwrap().is_none());
    }

    #[test]
    fn a_profile_reports_its_name_until_a_value_is_set_by_hand() {
        let profile = config(Some(LinkThrottleProfile::Broadband), None, None);
        let report = profile.resolve().unwrap().unwrap().report();
        assert_eq!(report.profile.as_deref(), Some("broadband"));
        assert_eq!(
            (report.latency_ms, report.bytes_per_sec),
            (40, Some(12_500_000))
        );

        let edited = LinkThrottleConfig {
            bytes_per_sec: Some(0),
            ..profile
        };
        let report = edited.resolve().unwrap().unwrap().report();
        assert_eq!(report.profile, None);
        assert_eq!(report.latency_ms, 40, "a value not set keeps the profile's");
        assert_eq!(report.bytes_per_sec, None, "zero lifts the cap");
    }

    #[test]
    fn a_link_that_could_time_out_a_chunk_request_is_refused() {
        // 32 MiB at 4 MB/s is 8.4 s, past the 5 s the link may take.
        let slow = config(None, Some(20), Some(4_000_000));
        assert!(matches!(
            slow.resolve(),
            Err(LinkThrottleConfigError::WouldTimeOut {
                limit_ms: 5_000,
                ..
            })
        ));
        let distant = config(None, Some(5_000), None);
        assert!(distant.resolve().is_err());
        let profile = config(Some(LinkThrottleProfile::Broadband), None, None);
        assert!(profile.resolve().is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn messages_overlap_on_the_link_and_arrive_in_order() {
        let (socket, mut arrivals) = recording_socket();
        let (mut sink, writer) = paced(socket, throttle(100, None));
        let started = Instant::now();
        for len in [10, 20, 30] {
            sink.send(binary(len)).await.unwrap();
        }
        drop(sink);
        writer.await.unwrap();
        let mut lens = Vec::new();
        while let Ok((at, message)) = arrivals.try_recv() {
            // Half the round trip each, not one after another.
            assert_eq!(at - started, Duration::from_millis(50));
            lens.push(payload_len(&message));
        }
        assert_eq!(lens, [10, 20, 30]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_bytes_cross_at_the_capped_rate() {
        let (socket, mut arrivals) = recording_socket();
        let (mut sink, writer) = paced(socket, throttle(0, Some(1_000_000)));
        let started = Instant::now();
        sink.send(binary(400_000)).await.unwrap();
        assert_eq!(
            started.elapsed(),
            Duration::from_millis(400),
            "a send holds the sender while its bytes leave"
        );
        sink.send(binary(100_000)).await.unwrap();
        drop(sink);
        writer.await.unwrap();
        let first = arrivals.try_recv().unwrap().0;
        let second = arrivals.try_recv().unwrap().0;
        assert_eq!(first - started, Duration::from_millis(400));
        assert_eq!(second - started, Duration::from_millis(500));
    }

    #[tokio::test(start_paused = true)]
    async fn what_the_client_sends_arrives_half_a_round_trip_later() {
        let started = Instant::now();
        let mut delayed = Delayed::new(stream::iter([1, 2, 3]), Duration::from_millis(30));
        let mut arrived = Vec::new();
        while let Some(item) = delayed.next().await {
            arrived.push((item, started.elapsed()));
        }
        let at = Duration::from_millis(30);
        assert_eq!(arrived, [(1, at), (2, at), (3, at)]);
    }
}
