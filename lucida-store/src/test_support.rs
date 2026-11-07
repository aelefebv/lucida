//! Test doubles shared by this crate's unit tests.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::BoxStream;
use object_store::path::Path;
use object_store::{
    GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta, ObjectStore,
    PutMultipartOptions, PutOptions, PutPayload, PutResult,
};

/// An in-memory `ObjectStore` that counts what reaches the backend: reads,
/// presence probes, and how many reads overlapped. It can also delay every
/// read, to make coalescing and concurrency observable, and be toggled to
/// fail every read.
#[derive(Debug)]
pub(crate) struct CountingStore {
    inner: Arc<dyn ObjectStore>,
    /// Object and range reads.
    pub(crate) get_count: Arc<AtomicUsize>,
    /// HEAD requests, however issued.
    pub(crate) head_count: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    pub(crate) max_active: Arc<AtomicUsize>,
    delay_ms: u64,
    pub(crate) fail: Arc<AtomicBool>,
}

impl CountingStore {
    pub(crate) fn new(delay_ms: u64) -> Self {
        Self {
            inner: Arc::new(object_store::memory::InMemory::new()),
            get_count: Arc::new(AtomicUsize::new(0)),
            head_count: Arc::new(AtomicUsize::new(0)),
            active: Arc::new(AtomicUsize::new(0)),
            max_active: Arc::new(AtomicUsize::new(0)),
            delay_ms,
            fail: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) async fn seed(&self, path: &str, bytes: impl AsRef<[u8]>) {
        let payload = PutPayload::from(Bytes::copy_from_slice(bytes.as_ref()));
        self.inner.put(&Path::from(path), payload).await.unwrap();
    }
}

impl std::fmt::Display for CountingStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CountingStore({})", self.inner)
    }
}

#[async_trait::async_trait]
impl ObjectStore for CountingStore {
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
        // A HEAD phrased as a bodiless GET is still a HEAD.
        if options.head {
            self.head_count.fetch_add(1, Ordering::SeqCst);
        } else {
            self.get_count.fetch_add(1, Ordering::SeqCst);
        }
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        if self.delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
        }
        let result = if self.fail.load(Ordering::SeqCst) {
            Err(object_store::Error::Generic {
                store: "counting",
                source: "injected failure".into(),
            })
        } else {
            self.inner.get_opts(location, options).await
        };
        self.active.fetch_sub(1, Ordering::SeqCst);
        result
    }

    async fn head(&self, location: &Path) -> object_store::Result<ObjectMeta> {
        self.head_count.fetch_add(1, Ordering::SeqCst);
        self.inner.head(location).await
    }

    async fn delete(&self, location: &Path) -> object_store::Result<()> {
        self.inner.delete(location).await
    }

    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        self.inner.list(prefix)
    }

    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> object_store::Result<ListResult> {
        self.inner.list_with_delimiter(prefix).await
    }

    async fn copy(&self, from: &Path, to: &Path) -> object_store::Result<()> {
        self.inner.copy(from, to).await
    }

    async fn copy_if_not_exists(&self, from: &Path, to: &Path) -> object_store::Result<()> {
        self.inner.copy_if_not_exists(from, to).await
    }
}
