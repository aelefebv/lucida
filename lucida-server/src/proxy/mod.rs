//! Server-side proxy infrastructure: on-disk cache + bounded-concurrency
//! generator.
//!
//! `lucida-proxy` is the pure-compute algorithm crate: given an in-memory
//! `ProxySourceData` and a `DatasetManifest`, it produces a `ProxyAsset`.
//! This module wraps that with the production server's I/O concerns:
//!
//! - [`ProxyCache`] persists generated proxies under a per-dataset directory
//!   keyed by the dataset URL hash, validates headers on read, and writes
//!   new files atomically.
//! - [`ProxyGenerator`] dedups in-flight requests for the same `ProxySpec`,
//!   bounds concurrency via a semaphore, and orchestrates async fetches of
//!   source chunks before invoking the synchronous generation algorithm.
//! - [`ServerProxySource`] adapts the server's `CachedStore` + decode helpers
//!   to the `ProxySourceData` trait by pre-fetching and decoding all required
//!   chunks for one `(image, t, c, level)` request.
//!
//! ## Async/sync boundary
//!
//! `ProxySourceData::read_field_volume` is **synchronous** by design — the
//! generation algorithm in `lucida-proxy` is pure compute and async-free.
//! Production reads need async I/O against `CachedStore`. We resolve this
//! by having [`ProxyGenerator::request`] **pre-fetch** all chunks the
//! requested proxy needs into a [`ServerProxySource`] (an in-memory
//! collection) *before* calling [`generate_proxy`], so the trait impl never
//! has to do I/O. This avoids `tokio::block_on` deadlocks and keeps the
//! algorithm crate runtime-agnostic.
//!
//! ## Priority queue
//!
//! The MVP exposes a `priority: u8` parameter on [`ProxyGenerator::request`]
//! for API stability but **does not yet order requests by priority**. The
//! tokio `Semaphore` provides bounded concurrency in FIFO order. A real
//! priority scheduler is a future enhancement.
//!
//! [`generate_proxy`]: lucida_proxy::generate_proxy

mod cache;
mod generator;
mod server_source;

pub use cache::ProxyCache;
pub use generator::{GeneratorError, ProxyGenerator};
pub(crate) use server_source::fetch_dense_volume;
pub use server_source::{BuildSourceError, ServerProxySource, build_server_proxy_source};
