//! Server-side proxy infrastructure: an on-disk cache and a
//! bounded-concurrency generator around the pure-compute `lucida-proxy`
//! crate.
//!
//! `ProxySourceData::read_tile_volume` is synchronous, but production reads
//! are async. [`ProxyGenerator::request`] pre-fetches every chunk a proxy
//! needs into a [`ServerProxySource`] before calling [`generate_proxy`], so
//! the trait impl never does I/O and nothing calls `block_on`. Requests are
//! served FIFO; the `priority` argument is not yet used.
//!
//! [`generate_proxy`]: lucida_proxy::generate_proxy

mod cache;
mod catalog;
mod generator;
mod server_source;

pub use cache::ProxyCache;
pub(crate) use catalog::{PROXY_TARGET_LONG_AXIS, proxy_catalog_entries_for_manifest};
pub use generator::{GeneratorError, ProxyGenerator};
pub use server_source::{BuildSourceError, ServerProxySource, build_server_proxy_source};
pub(crate) use server_source::{VolumeRegion, fetch_volume_region};
