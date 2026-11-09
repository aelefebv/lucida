//! A local filesystem store whose reads run on threads of their own.
//!
//! object_store reads a local file as two tasks on tokio's blocking pool, and
//! that pool queues every task behind one lock, which each of its threads
//! takes again after every task. During a burst of reads the lock changes
//! hands constantly. An async worker queueing the next read blocks on it
//! whenever the thread holding it is waiting for a CPU, and every task queued
//! on that worker waits too. Here a read is one job, handed over through a
//! channel whose sender never waits for these threads, and done on a thread
//! outside the runtime, where object_store does its file I/O inline.

use std::any::Any;
use std::ops::Range;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};

use bytes::Bytes;
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use object_store::local::LocalFileSystem;
use object_store::path::Path;
use object_store::{
    CopyOptions, GetOptions, GetResult, GetResultPayload, ListResult, MultipartUpload, ObjectMeta,
    ObjectStore, PutMultipartOptions, PutOptions, PutPayload, PutResult, RenameOptions,
};
use tokio::sync::oneshot;

/// `store`, its reads moved onto the read threads.
pub fn on_read_threads(store: LocalFileSystem) -> Arc<dyn ObjectStore> {
    Arc::new(LocalReads {
        inner: Arc::new(store),
    })
}

#[derive(Debug)]
struct LocalReads {
    inner: Arc<LocalFileSystem>,
}

impl std::fmt::Display for LocalReads {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LocalReads({})", self.inner)
    }
}

/// A read's result, less the file: the read threads read it to the end.
struct Read {
    meta: ObjectMeta,
    range: Range<u64>,
    attributes: object_store::Attributes,
    bytes: Bytes,
}

#[async_trait::async_trait]
impl ObjectStore for LocalReads {
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
        // A head wants no bytes, and reading them to the end below would.
        if options.head {
            return self.inner.get_opts(location, options).await;
        }
        let (inner, location) = (Arc::clone(&self.inner), location.clone());
        let read = on_a_read_thread(move || {
            futures_executor::block_on(async move {
                let result = inner.get_opts(&location, options).await?;
                let (meta, range, attributes) = (
                    result.meta.clone(),
                    result.range.clone(),
                    result.attributes.clone(),
                );
                let bytes = result.bytes().await?;
                Ok::<_, object_store::Error>(Read {
                    meta,
                    range,
                    attributes,
                    bytes,
                })
            })
        })
        .await?;
        Ok(GetResult {
            payload: GetResultPayload::Stream(
                futures_util::stream::once(async move { Ok(read.bytes) }).boxed(),
            ),
            meta: read.meta,
            range: read.range,
            attributes: read.attributes,
            extensions: Default::default(),
        })
    }

    async fn get_ranges(
        &self,
        location: &Path,
        ranges: &[Range<u64>],
    ) -> object_store::Result<Vec<Bytes>> {
        let (inner, location, ranges) =
            (Arc::clone(&self.inner), location.clone(), ranges.to_vec());
        on_a_read_thread(move || {
            futures_executor::block_on(async move { inner.get_ranges(&location, &ranges).await })
        })
        .await
    }

    fn delete_stream(
        &self,
        locations: BoxStream<'static, object_store::Result<Path>>,
    ) -> BoxStream<'static, object_store::Result<Path>> {
        self.inner.delete_stream(locations)
    }

    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        self.inner.list(prefix)
    }

    fn list_with_offset(
        &self,
        prefix: Option<&Path>,
        offset: &Path,
    ) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        self.inner.list_with_offset(prefix, offset)
    }

    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> object_store::Result<ListResult> {
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

type Job = Box<dyn FnOnce() + Send>;

/// Run `read` on a read thread and wait for its answer. A read whose caller
/// stopped waiting before a thread took it is dropped unread.
async fn on_a_read_thread<T, F>(read: F) -> T
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (answer, answered) = oneshot::channel::<Result<T, Box<dyn Any + Send>>>();
    let job: Job = Box::new(move || {
        if !answer.is_closed() {
            let _ = answer.send(catch_unwind(AssertUnwindSafe(read)));
        }
    });
    read_threads()
        .send(job)
        .expect("the read threads live as long as the process");
    match answered.await {
        Ok(Ok(value)) => value,
        Ok(Err(panic)) => resume_unwind(panic),
        Err(_) => unreachable!("a read thread runs or skips every job, and answers each it runs"),
    }
}

/// The read threads' queue. Sending never waits on them: only a thread taking
/// the next job holds the receiver.
///
/// There is a thread for every read the source-read bound admits at once, so
/// these threads never hold back a read that bound let through. The first
/// thread starts the others, so the async worker making the first read does
/// not wait for them all to be created.
fn read_threads() -> &'static mpsc::Sender<Job> {
    static JOBS: OnceLock<mpsc::Sender<Job>> = OnceLock::new();
    JOBS.get_or_init(|| {
        let (jobs, queue) = mpsc::channel::<Job>();
        let queue = Arc::new(Mutex::new(queue));
        let threads = crate::cache::max_source_reads().max(1);
        let first = Arc::clone(&queue);
        spawn_read_thread(move || {
            for _ in 1..threads {
                let queue = Arc::clone(&first);
                spawn_read_thread(move || take_jobs(&queue));
            }
            take_jobs(&first);
        });
        jobs
    })
}

fn spawn_read_thread(run: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .name("lucida-local-read".into())
        .spawn(run)
        .expect("spawn a read thread");
}

fn take_jobs(queue: &Mutex<mpsc::Receiver<Job>>) {
    loop {
        let next = queue.lock().unwrap().recv();
        match next {
            Ok(job) => job(),
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use object_store::ObjectStoreExt;

    use super::*;

    fn store_with(files: &[(&str, &[u8])]) -> (tempfile::TempDir, Arc<dyn ObjectStore>) {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in files {
            std::fs::write(dir.path().join(name), bytes).unwrap();
        }
        let store = LocalFileSystem::new_with_prefix(dir.path()).unwrap();
        (dir, on_read_threads(store))
    }

    #[tokio::test]
    async fn a_read_returns_the_file_and_its_metadata() {
        let (_dir, store) = store_with(&[("a", b"hello")]);
        let result = store.get(&Path::from("a")).await.unwrap();
        assert_eq!(result.meta.size, 5);
        assert_eq!(result.range, 0..5);
        assert_eq!(result.bytes().await.unwrap(), Bytes::from_static(b"hello"));
    }

    #[tokio::test]
    async fn ranges_and_suffixes_read_only_their_bytes() {
        let (_dir, store) = store_with(&[("a", b"0123456789")]);
        let path = Path::from("a");
        let range = store.get_range(&path, 2..5).await.unwrap();
        assert_eq!(range, Bytes::from_static(b"234"));
        let suffix = store
            .get_opts(
                &path,
                GetOptions {
                    range: Some(object_store::GetRange::Suffix(3)),
                    ..GetOptions::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(suffix.range, 7..10);
        assert_eq!(suffix.bytes().await.unwrap(), Bytes::from_static(b"789"));
        let ranges = store.get_ranges(&path, &[0..2, 8..10]).await.unwrap();
        assert_eq!(
            ranges,
            vec![Bytes::from_static(b"01"), Bytes::from_static(b"89")]
        );
    }

    #[tokio::test]
    async fn a_missing_file_is_not_found() {
        let (_dir, store) = store_with(&[]);
        let error = store.get(&Path::from("missing")).await.unwrap_err();
        assert!(
            matches!(error, object_store::Error::NotFound { .. }),
            "{error}"
        );
    }

    #[tokio::test]
    async fn the_read_runs_off_the_runtime() {
        // object_store does its file I/O inline only outside a runtime, which
        // is the point of these threads.
        let caller = std::thread::current().id();
        let (in_runtime, thread) = on_a_read_thread(|| {
            (
                tokio::runtime::Handle::try_current().is_ok(),
                std::thread::current().id(),
            )
        })
        .await;
        assert!(!in_runtime);
        assert_ne!(thread, caller);
    }
}
