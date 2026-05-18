//! Pure-compute proxy generation for Lucida.
//!
//! A *proxy* is a small low-resolution placeholder volume that stands in
//! for either a single field's downsampled image (`FieldProxy3D`) or an
//! aggregated well composed of multiple fields (`WellProxy3D`). Proxies
//! let the renderer show *something* immediately while detail chunks
//! stream in.
//!
//! This crate is intentionally I/O-free and async-free: it consumes a
//! [`DatasetManifest`] plus a caller-supplied [`ProxySourceData`] and emits
//! [`ProxyAsset`]s. Storage, fetching, and serving live elsewhere.
//!
//! [`DatasetManifest`]: lucida_content::DatasetManifest

pub use generate::{EstimateError, GenerateError, estimate_proxy_dims, generate_proxy};
pub use header::{read_header, source_content_hash, write_header};
pub use source::{FieldVolume, ProxySourceData, SourceError};
pub use spec::{ALGORITHM_VERSION, ProxyAsset, ProxyDtype, ProxyHeader, ProxyKind, ProxySpec};

mod generate;
mod header;
mod source;
mod spec;
