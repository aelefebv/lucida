//! A dev-only throttle on source reads, so a dataset on local disk loads the
//! way one in object storage does: every request waits a latency, and the
//! bytes it reads share one bandwidth cap.
//!
//! It wraps the storage backend, below the source cache, so a cache hit
//! costs nothing and every read that reaches a source pays, whatever the
//! source is. It adds to what the backend itself costs, so it models a
//! remote source only on top of a fast one.
//!
//! Off unless installed, and nothing installs it unless the server is told
//! to: a deployment that never sets it reads at full speed.

use std::hash::BuildHasher;
use std::num::NonZeroU64;
use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use lucida_protocol::SourceThrottleReport;
use object_store::path::Path;
use object_store::{
    CopyOptions, GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta, ObjectStore,
    PutMultipartOptions, PutOptions, PutPayload, PutResult, RenameOptions,
};

use crate::backend::SOURCE_REQUEST_TIMEOUT;

/// A named starting point for the throttle's settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum SourceThrottleProfile {
    /// No throttle: the source's own speed.
    Local,
    /// A server in the same region as its object store.
    ObjectStore,
    /// A server reaching its object store across a continent.
    Remote,
}

impl SourceThrottleProfile {
    pub fn name(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::ObjectStore => "object-store",
            Self::Remote => "remote",
        }
    }

    pub fn settings(self) -> SourceThrottleSettings {
        match self {
            Self::Local => SourceThrottleSettings::OFF,
            // AWS, "Best Practices Design Patterns: Optimizing Amazon S3
            // Performance": small-object and first-byte latencies of
            // "roughly 100-200 milliseconds", and one concurrent request per
            // 85-90 MB/s, about 15 of them to fill a 10 Gb/s NIC. lucida
            // reads at least 16 at a time, so the cap is that NIC.
            Self::ObjectStore => SourceThrottleSettings {
                latency: Duration::from_millis(100),
                jitter: Duration::from_millis(100),
                bytes_per_sec: NonZeroU64::new(1_250_000_000),
            },
            // The same store across a continent: its own 100-200 ms plus a
            // round trip of about 80 ms. Azure's published P50 round trips
            // ("Azure network round-trip latency statistics", July 2026) are
            // 69 ms from East US to West US and 83 ms from East US to West
            // Europe. The cap is the ~18 MiB/s a real remote link flattened at
            // in the sweep behind `DEFAULT_MIN_SOURCE_READS`.
            Self::Remote => SourceThrottleSettings {
                latency: Duration::from_millis(180),
                jitter: Duration::from_millis(100),
                bytes_per_sec: NonZeroU64::new(18 * 1024 * 1024),
            },
        }
    }
}

/// What the throttle does to each request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceThrottleSettings {
    /// Added to every request.
    pub latency: Duration,
    /// The most added on top of `latency`, drawn uniformly per request.
    pub jitter: Duration,
    /// The cap on every source read together. `None` is no cap.
    pub bytes_per_sec: Option<NonZeroU64>,
}

impl SourceThrottleSettings {
    pub const OFF: Self = Self {
        latency: Duration::ZERO,
        jitter: Duration::ZERO,
        bytes_per_sec: None,
    };

    fn is_off(&self) -> bool {
        *self == Self::OFF
    }
}

/// What an operator asked for: a profile, and any value set by hand, which
/// replaces the profile's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SourceThrottleConfig {
    pub profile: Option<SourceThrottleProfile>,
    pub latency_ms: Option<u64>,
    pub jitter_ms: Option<u64>,
    /// Zero lifts the cap.
    pub bytes_per_sec: Option<u64>,
}

/// Why a throttle configuration was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceThrottleConfigError {
    /// A delay this long is one a real source request would fail on, and
    /// past the client's own timeout the client gives up and asks again
    /// while the first read is still waiting.
    DelayTooLong { delay_ms: u64, limit_ms: u64 },
}

impl std::fmt::Display for SourceThrottleConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DelayTooLong { delay_ms, limit_ms } => write!(
                f,
                "source throttle latency plus jitter is {delay_ms} ms, at or past the \
                 {limit_ms} ms a remote source request may take before it fails"
            ),
        }
    }
}

impl std::error::Error for SourceThrottleConfigError {}

impl SourceThrottleConfig {
    /// The throttle this asks for, or `None` when it asks for none.
    pub fn resolve(self) -> Result<Option<SourceThrottle>, SourceThrottleConfigError> {
        let base = self
            .profile
            .map_or(SourceThrottleSettings::OFF, SourceThrottleProfile::settings);
        let settings = SourceThrottleSettings {
            latency: self.latency_ms.map_or(base.latency, Duration::from_millis),
            jitter: self.jitter_ms.map_or(base.jitter, Duration::from_millis),
            bytes_per_sec: self
                .bytes_per_sec
                .map_or(base.bytes_per_sec, NonZeroU64::new),
        };
        if settings.is_off() {
            return Ok(None);
        }
        let delay = settings.latency.saturating_add(settings.jitter);
        if delay >= SOURCE_REQUEST_TIMEOUT {
            return Err(SourceThrottleConfigError::DelayTooLong {
                delay_ms: delay.as_millis() as u64,
                limit_ms: SOURCE_REQUEST_TIMEOUT.as_millis() as u64,
            });
        }
        // A profile is named only while its values are its own, so a label
        // never names a profile the numbers beside it are not.
        let profile = self
            .profile
            .filter(|profile| profile.settings() == settings);
        Ok(Some(SourceThrottle::new(profile, settings)))
    }
}

/// A throttle in force: the settings, and the state the requests share.
#[derive(Debug)]
pub struct SourceThrottle {
    profile: Option<SourceThrottleProfile>,
    settings: SourceThrottleSettings,
    /// When the modelled link next has no bytes queued on it.
    link_free_at: Mutex<Option<Instant>>,
    draws: AtomicU64,
    seed: std::collections::hash_map::RandomState,
}

impl SourceThrottle {
    pub fn new(profile: Option<SourceThrottleProfile>, settings: SourceThrottleSettings) -> Self {
        Self {
            profile,
            settings,
            link_free_at: Mutex::new(None),
            draws: AtomicU64::new(0),
            seed: Default::default(),
        }
    }

    pub fn report(&self) -> SourceThrottleReport {
        SourceThrottleReport {
            profile: self.profile.map(|profile| profile.name().to_string()),
            latency_ms: self.settings.latency.as_millis() as u64,
            jitter_ms: self.settings.jitter.as_millis() as u64,
            bytes_per_sec: self.settings.bytes_per_sec.map(NonZeroU64::get),
        }
    }

    fn request_delay(&self) -> Duration {
        let SourceThrottleSettings {
            latency, jitter, ..
        } = self.settings;
        if jitter.is_zero() {
            return latency;
        }
        let draw = self
            .seed
            .hash_one(self.draws.fetch_add(1, Ordering::Relaxed));
        // The top 53 bits as a fraction in [0, 1).
        let fraction = (draw >> 11) as f64 / (1u64 << 53) as f64;
        latency + jitter.mul_f64(fraction)
    }

    async fn request(&self) {
        let delay = self.request_delay();
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
    }

    /// Wait for `bytes` to cross the link. The link is one queue for the
    /// whole process, as a real one is: reads that overlap share the cap
    /// rather than each getting all of it, so raising the read concurrency
    /// cannot buy bandwidth the link does not have.
    async fn transfer(&self, bytes: u64) {
        let Some(rate) = self.settings.bytes_per_sec else {
            return;
        };
        if bytes == 0 {
            return;
        }
        let cost = Duration::from_secs_f64(bytes as f64 / rate.get() as f64);
        let done = {
            let mut free_at = self.link_free_at.lock().unwrap();
            let now = Instant::now();
            let start = free_at.map_or(now, |free| free.max(now));
            let done = start + cost;
            *free_at = Some(done);
            done
        };
        tokio::time::sleep_until(tokio::time::Instant::from_std(done)).await;
    }
}

/// One for the process, as the link it models is: every source shares the
/// cap, so two datasets read together split it.
static INSTALLED: OnceLock<Arc<SourceThrottle>> = OnceLock::new();

/// Throttle every source opened through [`crate::backend::open_permitted`]
/// from now on. Returns false, and changes nothing, when one is already
/// installed.
pub fn install(throttle: SourceThrottle) -> bool {
    INSTALLED.set(Arc::new(throttle)).is_ok()
}

/// The installed throttle's report, or `None` when sources read unthrottled.
pub fn report() -> Option<SourceThrottleReport> {
    INSTALLED.get().map(|throttle| throttle.report())
}

/// `store` behind the installed throttle, or `store` itself when there is none.
pub(crate) fn throttled(store: Arc<dyn ObjectStore>) -> Arc<dyn ObjectStore> {
    match INSTALLED.get() {
        Some(throttle) => with_throttle(store, Arc::clone(throttle)),
        None => store,
    }
}

fn with_throttle(
    store: Arc<dyn ObjectStore>,
    throttle: Arc<SourceThrottle>,
) -> Arc<dyn ObjectStore> {
    Arc::new(ThrottledStore {
        inner: store,
        throttle,
    })
}

#[derive(Debug)]
struct ThrottledStore {
    inner: Arc<dyn ObjectStore>,
    throttle: Arc<SourceThrottle>,
}

impl std::fmt::Display for ThrottledStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Throttled({})", self.inner)
    }
}

/// Every request pays the latency, a not-found included, since a real one
/// costs a round trip too. Only the bytes a read returns cross the link: a
/// HEAD has none. Sources are read-only to the server, so writes pass
/// straight through.
#[async_trait::async_trait]
impl ObjectStore for ThrottledStore {
    async fn put_opts(
        &self,
        location: &Path,
        payload: PutPayload,
        opts: PutOptions,
    ) -> object_store::Result<PutResult> {
        self.inner.put_opts(location, payload, opts).await
    }

    async fn put_multipart_opts(
        &self,
        location: &Path,
        opts: PutMultipartOptions,
    ) -> object_store::Result<Box<dyn MultipartUpload>> {
        self.inner.put_multipart_opts(location, opts).await
    }

    async fn get_opts(
        &self,
        location: &Path,
        options: GetOptions,
    ) -> object_store::Result<GetResult> {
        self.throttle.request().await;
        let head = options.head;
        let result = self.inner.get_opts(location, options).await?;
        if !head {
            self.throttle
                .transfer(result.range.end - result.range.start)
                .await;
        }
        Ok(result)
    }

    /// One request for every range, as a merged read is one request.
    async fn get_ranges(
        &self,
        location: &Path,
        ranges: &[Range<u64>],
    ) -> object_store::Result<Vec<Bytes>> {
        self.throttle.request().await;
        let slices = self.inner.get_ranges(location, ranges).await?;
        let bytes = slices.iter().map(|slice| slice.len() as u64).sum();
        self.throttle.transfer(bytes).await;
        Ok(slices)
    }

    fn delete_stream(
        &self,
        locations: BoxStream<'static, object_store::Result<Path>>,
    ) -> BoxStream<'static, object_store::Result<Path>> {
        self.inner.delete_stream(locations)
    }

    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        delayed(Arc::clone(&self.throttle), self.inner.list(prefix))
    }

    fn list_with_offset(
        &self,
        prefix: Option<&Path>,
        offset: &Path,
    ) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        delayed(
            Arc::clone(&self.throttle),
            self.inner.list_with_offset(prefix, offset),
        )
    }

    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> object_store::Result<ListResult> {
        self.throttle.request().await;
        self.inner.list_with_delimiter(prefix).await
    }

    async fn copy_opts(
        &self,
        from: &Path,
        to: &Path,
        options: CopyOptions,
    ) -> object_store::Result<()> {
        self.inner.copy_opts(from, to, options).await
    }

    async fn rename_opts(
        &self,
        from: &Path,
        to: &Path,
        options: RenameOptions,
    ) -> object_store::Result<()> {
        self.inner.rename_opts(from, to, options).await
    }
}

/// `listing`, after one request's latency.
fn delayed<T: Send + 'static>(
    throttle: Arc<SourceThrottle>,
    listing: BoxStream<'static, T>,
) -> BoxStream<'static, T> {
    futures_util::stream::once(async move {
        throttle.request().await;
        listing
    })
    .flatten()
    .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use object_store::ObjectStoreExt;
    use object_store::memory::InMemory;

    fn settings(
        latency_ms: u64,
        jitter_ms: u64,
        bytes_per_sec: Option<u64>,
    ) -> SourceThrottleSettings {
        SourceThrottleSettings {
            latency: Duration::from_millis(latency_ms),
            jitter: Duration::from_millis(jitter_ms),
            bytes_per_sec: bytes_per_sec.and_then(NonZeroU64::new),
        }
    }

    async fn store_with(
        throttle: SourceThrottleSettings,
        objects: &[(&str, usize)],
    ) -> Arc<dyn ObjectStore> {
        let inner = InMemory::new();
        for (path, len) in objects {
            inner
                .put(&Path::from(*path), PutPayload::from(vec![7u8; *len]))
                .await
                .unwrap();
        }
        with_throttle(
            Arc::new(inner),
            Arc::new(SourceThrottle::new(None, throttle)),
        )
    }

    #[test]
    fn nothing_set_and_the_local_profile_are_both_off() {
        assert!(SourceThrottleConfig::default().resolve().unwrap().is_none());
        let local = SourceThrottleConfig {
            profile: Some(SourceThrottleProfile::Local),
            ..Default::default()
        };
        assert!(local.resolve().unwrap().is_none());
    }

    #[test]
    fn a_profile_reports_its_name_until_a_value_is_set_by_hand() {
        let profile = SourceThrottleConfig {
            profile: Some(SourceThrottleProfile::Remote),
            ..Default::default()
        };
        let report = profile.resolve().unwrap().unwrap().report();
        assert_eq!(report.profile.as_deref(), Some("remote"));
        assert_eq!(report.latency_ms, 180);
        assert_eq!(report.bytes_per_sec, Some(18 * 1024 * 1024));

        let edited = SourceThrottleConfig {
            latency_ms: Some(40),
            bytes_per_sec: Some(0),
            ..profile
        };
        let report = edited.resolve().unwrap().unwrap().report();
        assert_eq!(report.profile, None);
        assert_eq!(report.latency_ms, 40);
        assert_eq!(report.jitter_ms, 100, "a value not set keeps the profile's");
        assert_eq!(report.bytes_per_sec, None, "zero lifts the cap");
    }

    #[test]
    fn a_value_alone_turns_the_throttle_on() {
        let config = SourceThrottleConfig {
            latency_ms: Some(25),
            ..Default::default()
        };
        let report = config.resolve().unwrap().unwrap().report();
        assert_eq!((report.profile, report.latency_ms), (None, 25));
    }

    #[test]
    fn a_delay_a_real_request_would_fail_on_is_refused() {
        let config = SourceThrottleConfig {
            latency_ms: Some(4_000),
            jitter_ms: Some(1_000),
            ..Default::default()
        };
        assert!(matches!(
            config.resolve(),
            Err(SourceThrottleConfigError::DelayTooLong {
                delay_ms: 5_000,
                ..
            })
        ));
    }

    #[test]
    fn jitter_stays_between_the_latency_and_the_latency_plus_jitter() {
        let throttle = SourceThrottle::new(None, settings(50, 20, None));
        let delays: Vec<Duration> = (0..200).map(|_| throttle.request_delay()).collect();
        for delay in &delays {
            assert!(*delay >= Duration::from_millis(50) && *delay <= Duration::from_millis(70));
        }
        assert!(
            delays.iter().any(|delay| *delay != delays[0]),
            "jitter varies"
        );
    }

    #[tokio::test]
    async fn every_request_waits_the_latency_a_head_and_a_miss_included() {
        let store = store_with(settings(60, 0, None), &[("object", 16)]).await;
        let started = Instant::now();
        store.get(&Path::from("object")).await.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(60));

        let started = Instant::now();
        store.head(&Path::from("object")).await.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(60));

        let started = Instant::now();
        assert!(store.get(&Path::from("missing")).await.is_err());
        assert!(started.elapsed() >= Duration::from_millis(60));
    }

    #[tokio::test]
    async fn a_read_takes_its_bytes_over_the_bandwidth() {
        let store = store_with(settings(0, 0, Some(1_000_000)), &[("object", 400_000)]).await;
        let started = Instant::now();
        let bytes = store
            .get(&Path::from("object"))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(bytes.len(), 400_000);
        assert!(started.elapsed() >= Duration::from_millis(400));

        // A range pays for its own bytes, not the object's.
        let started = Instant::now();
        store
            .get_range(&Path::from("object"), 0..10_000)
            .await
            .unwrap();
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_millis(10) && elapsed < Duration::from_millis(300));
    }

    #[tokio::test]
    async fn overlapping_reads_share_the_cap() {
        let store = store_with(
            settings(0, 0, Some(1_000_000)),
            &[("a", 100_000), ("b", 100_000)],
        )
        .await;
        let started = Instant::now();
        let (a, b) = (Path::from("a"), Path::from("b"));
        let (a, b) = tokio::join!(store.get(&a), store.get(&b));
        a.unwrap();
        b.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[tokio::test]
    async fn a_merged_read_pays_the_latency_and_all_of_its_bytes() {
        let store = store_with(settings(80, 0, Some(1_000_000)), &[("shard", 100_000)]).await;
        let started = Instant::now();
        let slices = store
            .get_ranges(&Path::from("shard"), &[0..50_000, 50_000..100_000])
            .await
            .unwrap();
        assert_eq!(slices.len(), 2);
        assert!(started.elapsed() >= Duration::from_millis(180));
    }
}
