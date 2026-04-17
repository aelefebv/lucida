//! Fixed 64-byte binary header for stored proxies, plus a deterministic
//! source-content hash used to detect when a proxy is stale.
//!
//! Layout (little-endian):
//!
//! ```text
//!  0..4    magic              "LPRX"
//!  4..8    algorithm version  u32
//!  8..20   dims [Z, Y, X]     u32 × 3
//! 20..24   dtype code         u32
//! 24..56   source hash        [u8; 32]
//! 56..64   reserved           zeros
//! ```

use std::io::{self, Read, Write};

use blake3::Hasher;
use lucida_content::{ContentGraph, EntityId, EntityKind, ImageSpec};

use crate::spec::{ALGORITHM_VERSION, ProxyDtype, ProxyHeader};

const MAGIC: [u8; 4] = *b"LPRX";
const HEADER_LEN: usize = 64;

/// Write a [`ProxyHeader`] to `w` as a 64-byte little-endian record.
///
/// The on-disk algorithm version is taken from the header (callers should
/// fill it with [`ALGORITHM_VERSION`]); we don't override it so tests can
/// construct mismatched headers.
pub fn write_header<W: Write>(w: &mut W, header: &ProxyHeader) -> io::Result<()> {
    let mut buf = [0u8; HEADER_LEN];

    buf[0..4].copy_from_slice(&MAGIC);
    buf[4..8].copy_from_slice(&header.algorithm_version.to_le_bytes());

    for (i, &d) in header.dims.iter().enumerate() {
        let off = 8 + i * 4;
        buf[off..off + 4].copy_from_slice(&d.to_le_bytes());
    }

    buf[20..24].copy_from_slice(&header.dtype.as_u32().to_le_bytes());
    buf[24..56].copy_from_slice(&header.source_content_hash);
    // bytes 56..64 stay zeroed (reserved)

    w.write_all(&buf)
}

/// Read a [`ProxyHeader`] from `r`. Returns `InvalidData` on magic
/// mismatch, version mismatch, or unknown dtype.
pub fn read_header<R: Read>(r: &mut R) -> io::Result<ProxyHeader> {
    let mut buf = [0u8; HEADER_LEN];
    r.read_exact(&mut buf)?;

    let mut magic = [0u8; 4];
    magic.copy_from_slice(&buf[0..4]);
    if magic != MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("bad proxy header magic: {magic:?}"),
        ));
    }

    let algorithm_version = u32::from_le_bytes(buf[4..8].try_into().unwrap());
    if algorithm_version != ALGORITHM_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "proxy algorithm version mismatch: file={algorithm_version}, expected={ALGORITHM_VERSION}"
            ),
        ));
    }

    let dims = [
        u32::from_le_bytes(buf[8..12].try_into().unwrap()),
        u32::from_le_bytes(buf[12..16].try_into().unwrap()),
        u32::from_le_bytes(buf[16..20].try_into().unwrap()),
    ];

    let dtype_code = u32::from_le_bytes(buf[20..24].try_into().unwrap());
    let dtype = ProxyDtype::from_u32(dtype_code).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown proxy dtype code: {dtype_code}"),
        )
    })?;

    let mut source_content_hash = [0u8; 32];
    source_content_hash.copy_from_slice(&buf[24..56]);

    Ok(ProxyHeader {
        algorithm_version,
        source_content_hash,
        dims,
        dtype,
    })
}

/// Compute a stable 32-byte content hash for the inputs that determine a
/// proxy's voxel data.
///
/// Inputs hashed (in order):
/// - The entity ID and its kind.
/// - For a Well: each child Field's ID (sorted), parent transform matrices,
///   and full multiscale geometry of each field's image.
/// - For a Field/Image: its own (self → self) transform if any, plus the
///   image multiscale geometry.
/// - The `(t, c)` selectors.
///
/// The hash is invariant under graph reconstruction: rebuilding the same
/// content yields the same hash. Modifying any contributing transform or
/// level metadata changes the hash.
pub fn source_content_hash(
    content: &ContentGraph,
    entity_id: &EntityId,
    t: u32,
    c: u32,
) -> [u8; 32] {
    let mut hasher = Hasher::new();

    hasher.update(b"lucida-proxy/source-content/v1");
    hasher.update(&t.to_le_bytes());
    hasher.update(&c.to_le_bytes());
    hasher.update(entity_id.0.as_bytes());
    hasher.update(b"\0");

    let entity = content.entities().iter().find(|e| &e.id == entity_id);
    let entity_kind_tag: u8 = match entity.map(|e| &e.kind) {
        Some(EntityKind::Image) => 0,
        Some(EntityKind::Well) => 1,
        Some(EntityKind::Field) => 2,
        None => 0xFF,
    };
    hasher.update(&[entity_kind_tag]);

    // Collect the set of "contributing" entities in a deterministic order:
    // - For Well: all Field children (sorted by id), then the well itself.
    // - For Field/Image: just the entity itself.
    let mut contributors: Vec<&EntityId> = Vec::new();
    if let Some(e) = entity {
        if matches!(e.kind, EntityKind::Well) {
            let mut child_ids: Vec<&EntityId> = content
                .entities()
                .iter()
                .filter(|c| c.parent.as_ref() == Some(entity_id))
                .filter(|c| matches!(c.kind, EntityKind::Field))
                .map(|c| &c.id)
                .collect();
            child_ids.sort_by(|a, b| a.0.cmp(&b.0));
            contributors.extend(child_ids);
        }
    }
    contributors.push(entity_id);

    for cid in &contributors {
        hasher.update(b"\nentity:");
        hasher.update(cid.0.as_bytes());

        // Transforms touching this entity, sorted for determinism.
        let mut edges: Vec<(&str, &str, [f64; 16])> = content
            .transforms()
            .iter()
            .filter(|edge| &edge.from == *cid || &edge.to == *cid)
            .map(|edge| (edge.from.0.as_str(), edge.to.0.as_str(), *edge.transform.matrix()))
            .collect();
            edges.sort_by(|a, b| a.0.cmp(b.0).then_with(|| a.1.cmp(b.1)));
        for (from, to, matrix) in edges {
            hasher.update(b"\nedge:");
            hasher.update(from.as_bytes());
            hasher.update(b"->");
            hasher.update(to.as_bytes());
            for v in matrix {
                hasher.update(&v.to_le_bytes());
            }
        }

        // Image geometry, sorted for determinism.
        let mut owned_images: Vec<&ImageSpec> = content
            .images()
            .iter()
            .filter(|img| &img.owner == *cid)
            .collect();
        owned_images.sort_by(|a, b| a.image_id.0.cmp(&b.image_id.0));
        for img in owned_images {
            hasher.update(b"\nimage:");
            hasher.update(img.image_id.0.as_bytes());
            hasher.update(b"\ndtype:");
            // DataType is small + Copy + Eq; serialize via debug for stability.
            hasher.update(format!("{:?}", img.multiscale.data_type).as_bytes());
            for axis in &img.multiscale.axes {
                hasher.update(b"\naxis:");
                hasher.update(axis.name.as_bytes());
                hasher.update(b":");
                hasher.update(format!("{:?}", axis.kind).as_bytes());
            }
            for lvl in &img.multiscale.levels {
                hasher.update(b"\nlevel:");
                hasher.update(&lvl.level_index.to_le_bytes());
                for v in lvl.shape {
                    hasher.update(&v.to_le_bytes());
                }
                for v in lvl.chunk_shape {
                    hasher.update(&v.to_le_bytes());
                }
                for v in lvl.grid_shape {
                    hasher.update(&v.to_le_bytes());
                }
                for v in lvl.scale {
                    hasher.update(&v.to_le_bytes());
                }
            }
        }
    }

    *hasher.finalize().as_bytes()
}
