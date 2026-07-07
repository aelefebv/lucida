//! Proxy spec types: kinds, request specs, generated assets, and on-disk
//! header descriptors.
//!
//! These types are pure data — no I/O, no async. They describe *what* a
//! proxy is and *what shape* its bytes take.

use serde::{Deserialize, Serialize};

use lucida_content::EntityId;

/// Bumped any time the proxy generation algorithm changes in a way that
/// invalidates previously-stored proxies. Stored in [`ProxyHeader`] and
/// checked on read.
pub const ALGORITHM_VERSION: u32 = 1;

/// What kind of proxy to build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProxyKind {
    /// Aggregate all child tiles of a group into a single low-res volume in
    /// group coordinate space.
    GroupProxy3D,
    /// Downsample a single tile's image into a low-res volume in voxel
    /// space.
    TileProxy3D,
}

/// Request spec for a proxy build. This is the input to [`crate::generate_proxy`].
///
/// `target_long_axis` is a soft cap on the longest output dimension; other
/// axes scale proportionally and are never upsampled past the source.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProxySpec {
    pub entity_id: EntityId,
    pub kind: ProxyKind,
    pub t: u32,
    pub c: u32,
    pub target_long_axis: u32,
}

/// A built proxy: header plus packed voxel data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyAsset {
    pub header: ProxyHeader,
    pub voxels: Vec<u16>,
}

/// On-disk-friendly header for a proxy. Round-trips through
/// [`crate::write_header`] / [`crate::read_header`] to a fixed 64-byte
/// little-endian binary layout.
///
/// `dims` is in `[Z, Y, X]` order — proxies are 3D regardless of source
/// rank, so T/C are not part of the geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyHeader {
    pub algorithm_version: u32,
    pub source_content_hash: [u8; 32],
    /// `[Z, Y, X]` voxel counts.
    pub dims: [u32; 3],
    pub dtype: ProxyDtype,
}

/// Voxel datatype. MVP only supports U16; the enum exists so future
/// formats slot in without breaking the header layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProxyDtype {
    U16,
}

impl ProxyDtype {
    /// Stable wire-format code used in the binary header.
    pub(crate) fn as_u32(self) -> u32 {
        match self {
            ProxyDtype::U16 => 0,
        }
    }

    pub(crate) fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(ProxyDtype::U16),
            _ => None,
        }
    }
}
