//! Per-level chunk byte-layout helper.
//!
//! Computes whether a level's on-disk chunks need to be byte-sliced down to
//! the canonical 5D chunk shape, and returns the byte size to slice to.
//!
//! Background: when an OME-Zarr has non-canonical axes (e.g. CZI's `m`), the
//! recent pin-fix (PRD #444) injects a `"0"` into the on-disk Zarr v3 chunk
//! path so the chunk file is found, but the file itself can contain more than
//! the canonical 5D chunk's worth of bytes if the pinned axis has chunk_size
//! > 1. This helper detects that case and tells [`crate::serve_chunk`-style
//! callers] to truncate the decompressed bytes to a contiguous prefix.
//!
//! The "contiguous prefix" approach only works when the pinned slice
//! coincides with the first `canonical_byte_size` bytes of the on-disk chunk
//! in C-order. The eligibility rule (see [`compute_chunk_byte_layout`]) covers
//! all CZI-style `[t, c, z, m, y, x]` exports where pinned axes precede the
//! canonical spatial axes; non-prefix layouts (e.g. `[..., y, m, x]`) are
//! rejected with a clear error so we fail at import time, not at chunk fetch.

use lucida_content::PinnedAxis;
use serde::{Deserialize, Serialize};

use crate::backend::StoreError;

/// How many bytes one decompressed on-disk chunk holds, and how many of those
/// bytes correspond to the canonical 5D chunk's `m=0` (etc.) slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkByteLayout {
    /// Bytes the canonical 5D pipeline expects per chunk
    /// (= product of canonical chunk dims × dtype size).
    pub canonical_byte_size: usize,
    /// Bytes one full decompressed on-disk chunk holds
    /// (= product of all raw chunk dims × dtype size).
    pub on_disk_byte_size: usize,
    /// `true` if `canonical_byte_size != on_disk_byte_size` and the decode
    /// pipeline must truncate to the canonical prefix. `false` for canonical
    /// 5D datasets and for 6D-with-m where the pinned axis has chunk_size 1.
    pub needs_slicing: bool,
}

/// Compute [`ChunkByteLayout`] for one level. Errors when the pinned axes are
/// not in a contiguous-prefix-sliceable position; the message names the
/// offending axis so users know what to look for in their OME-Zarr metadata.
///
/// `axes` is the raw OME axes list (e.g. `["t","c","z","m","y","x"]`).
/// `chunk_shape` parallels `axes` (one entry per axis).
/// `pinned` is the canonical `PinnedAxis` list from
/// [`lucida_content::normalize::classify_axes`].
///
/// Eligibility rule: in the raw axes list, after eliminating axes whose
/// `chunk_shape` entry is 1 (those don't iterate within the chunk), every
/// pinned axis must precede every canonical axis. When this holds, in C-order
/// byte layout the slice with all pinned coordinates equal to `pinned_index`
/// (always 0 today) coincides with the first `canonical_byte_size` bytes.
pub fn compute_chunk_byte_layout(
    axes: &[String],
    chunk_shape: &[u64],
    dtype_size: u8,
    pinned: &[PinnedAxis],
) -> Result<ChunkByteLayout, StoreError> {
    if axes.len() != chunk_shape.len() {
        return Err(StoreError::Metadata(format!(
            "axes/chunk_shape length mismatch: axes has {} entries, chunk_shape has {}",
            axes.len(),
            chunk_shape.len(),
        )));
    }

    let pinned_names: std::collections::HashSet<String> = pinned
        .iter()
        .map(|p| p.name.to_lowercase())
        .collect();

    // Per-axis byte-size product across all axes; same for canonical-only.
    // Use u128 for the intermediate product to defensively avoid overflow on
    // pathological inputs, then check the result fits in usize.
    let mut on_disk: u128 = dtype_size as u128;
    let mut canonical: u128 = dtype_size as u128;
    for (i, name) in axes.iter().enumerate() {
        let dim = chunk_shape[i] as u128;
        on_disk = on_disk.saturating_mul(dim);
        if !pinned_names.contains(&name.to_lowercase()) {
            canonical = canonical.saturating_mul(dim);
        }
    }

    let on_disk_byte_size = usize::try_from(on_disk).map_err(|_| {
        StoreError::Metadata("chunk byte size exceeds usize".to_string())
    })?;
    let canonical_byte_size = usize::try_from(canonical).map_err(|_| {
        StoreError::Metadata("canonical chunk byte size exceeds usize".to_string())
    })?;

    let needs_slicing = on_disk_byte_size != canonical_byte_size;

    // Prefix-eligibility: among non-trivial (chunk_size > 1) axes, every
    // pinned axis must come before every canonical axis. A pinned axis with
    // chunk_size 1 is trivially fine (it doesn't iterate, so it doesn't break
    // the byte layout); same for canonical chunk_size 1.
    if needs_slicing {
        let mut seen_canonical_with_chunk_gt_1 = false;
        for (i, name) in axes.iter().enumerate() {
            if chunk_shape[i] <= 1 {
                continue;
            }
            let is_pinned = pinned_names.contains(&name.to_lowercase());
            if is_pinned {
                if seen_canonical_with_chunk_gt_1 {
                    return Err(StoreError::Metadata(format!(
                        "axis '{}' (chunk_size {}) is non-canonical and falls in a non-prefix position; \
                         contiguous-prefix slicing requires all pinned axes to come before any canonical \
                         spatial axis with chunk_size > 1 (axes order: {:?})",
                        name, chunk_shape[i], axes,
                    )));
                }
            } else {
                seen_canonical_with_chunk_gt_1 = true;
            }
        }
    }

    Ok(ChunkByteLayout {
        canonical_byte_size,
        on_disk_byte_size,
        needs_slicing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn axes(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn pinned(name: &str, size: u64) -> PinnedAxis {
        PinnedAxis {
            name: name.to_string(),
            size,
            pinned_index: 0,
        }
    }

    #[test]
    fn canonical_5d_no_slicing() {
        let layout = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "y", "x"]),
            &[1, 1, 1, 256, 256],
            2,
            &[],
        )
        .unwrap();
        assert!(!layout.needs_slicing);
        assert_eq!(layout.canonical_byte_size, 256 * 256 * 2);
        assert_eq!(layout.on_disk_byte_size, layout.canonical_byte_size);
    }

    #[test]
    fn six_d_with_m_chunk_size_2_slices() {
        // The user's CZI export.
        let layout = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "m", "y", "x"]),
            &[1, 1, 1, 2, 2048, 1504],
            2,
            &[pinned("m", 6)],
        )
        .unwrap();
        assert!(layout.needs_slicing);
        assert_eq!(layout.canonical_byte_size, 2048 * 1504 * 2);
        assert_eq!(layout.on_disk_byte_size, 2 * 2048 * 1504 * 2);
    }

    #[test]
    fn six_d_with_m_chunk_size_1_no_slicing() {
        let layout = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "m", "y", "x"]),
            &[1, 1, 1, 1, 2048, 1504],
            2,
            &[pinned("m", 6)],
        )
        .unwrap();
        assert!(!layout.needs_slicing);
        assert_eq!(layout.canonical_byte_size, 2048 * 1504 * 2);
        assert_eq!(layout.on_disk_byte_size, layout.canonical_byte_size);
    }

    #[test]
    fn multi_pinned_eligible_when_pinned_precede_canonicals() {
        // [t, c, m, s, y, x] — both m and s are pinned, both come before y, x.
        let layout = compute_chunk_byte_layout(
            &axes(&["t", "c", "m", "s", "y", "x"]),
            &[1, 1, 2, 2, 2048, 1504],
            2,
            &[pinned("m", 4), pinned("s", 6)],
        )
        .unwrap();
        assert!(layout.needs_slicing);
        assert_eq!(layout.canonical_byte_size, 2048 * 1504 * 2);
        assert_eq!(layout.on_disk_byte_size, 2 * 2 * 2048 * 1504 * 2);
    }

    #[test]
    fn mixed_size_1_canonicals_dont_break_eligibility() {
        // [t, c, m, y, s, x] with y_chunk=1 — y doesn't iterate, so s coming
        // after y is fine for prefix slicing.
        let layout = compute_chunk_byte_layout(
            &axes(&["t", "c", "m", "y", "s", "x"]),
            &[1, 1, 2, 1, 2, 1504],
            2,
            &[pinned("m", 4), pinned("s", 4)],
        )
        .unwrap();
        assert!(layout.needs_slicing);
    }

    #[test]
    fn rejects_pinned_after_canonical_chunked_axis() {
        // [t, c, z, y, m, x] with m_chunk=2 — m sits between y and x with
        // y_chunk > 1, so prefix slicing won't work.
        let err = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "y", "m", "x"]),
            &[1, 1, 1, 2048, 2, 1504],
            2,
            &[pinned("m", 4)],
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains('\''), "error should quote the axis name: {msg}");
        assert!(msg.contains('m'), "error should name 'm': {msg}");
        assert!(msg.contains("non-prefix"), "error should say 'non-prefix': {msg}");
    }

    #[test]
    fn rejects_pinned_innermost_position() {
        // [t, c, z, y, x, m] with m as the fastest-varying axis.
        let err = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "y", "x", "m"]),
            &[1, 1, 1, 2048, 1504, 2],
            2,
            &[pinned("m", 4)],
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains('m'), "error should name 'm': {msg}");
    }

    #[test]
    fn rejects_when_one_of_multi_pinned_is_in_bad_position() {
        // [t, c, m, y, s, x] with y_chunk > 1. m is fine (before y), but s
        // comes after y, so the layout is rejected and the error names s.
        let err = compute_chunk_byte_layout(
            &axes(&["t", "c", "m", "y", "s", "x"]),
            &[1, 1, 2, 2, 2, 1504],
            2,
            &[pinned("m", 4), pinned("s", 4)],
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains('s'), "error should name 's': {msg}");
    }

    #[test]
    fn rejects_axes_chunk_shape_length_mismatch() {
        let err =
            compute_chunk_byte_layout(&axes(&["t", "c", "z", "y", "x"]), &[1, 1, 1], 2, &[])
                .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("length mismatch"), "{msg}");
    }
}
