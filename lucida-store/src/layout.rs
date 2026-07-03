//! Per-level chunk byte-layout helper.
//!
//! Computes the byte range within the decompressed on-disk chunk that
//! corresponds to one wire-format chunk (1 t, 1 c, all z, all y, all x).
//! Two cases produce non-trivial slices:
//!
//! 1. **Pinned axes**. When an OME-Zarr has non-canonical axes (e.g.
//!    CZI's `m`), the on-disk chunk file may bundle multiple
//!    pinned-index slices together. Pinned-index 0 is always picked, and
//!    when its chunk_size > 1 the canonical bytes are the prefix of the
//!    on-disk bytes.
//!
//! 2. **Canonical-indexed axes** (`t` / `c`). When the canonical axis
//!    itself has chunk_size > 1, the on-disk chunk holds N
//!    timepoints/channels concatenated. The wire chunk key addresses
//!    one timepoint/channel; the server picks the right one by
//!    computing an intra-chunk offset.
//!
//! Both cases are handled uniformly by [`ChunkByteLayout::slice_range`],
//! which takes the intra-chunk `(t, c)` indices and returns the
//! `(offset, size)` byte range to extract from the decompressed bytes.
//! For the canonical-5D case (no pinned axes, chunk_size 1 on t and c),
//! the result is `(0, canonical_byte_size)` — equivalent to the old
//! "no slicing needed" path.
//!
//! The contiguous-slice approach has an eligibility constraint: in the
//! raw axes order, every "outer" axis (pinned ∪ canonical-indexed t,c)
//! with chunk_size > 1 must precede every "inner" axis (canonical-kept
//! z,y,x) with chunk_size > 1. When violated, [`compute_chunk_byte_layout`]
//! returns an error naming the offending axis so import fails loudly
//! rather than producing wrong pixels at chunk-fetch time.

use lucida_content::PinnedAxis;
use serde::{Deserialize, Serialize};

use crate::backend::StoreError;

/// How the canonical wire-chunk slice is laid out within the decompressed
/// on-disk chunk bytes.
///
/// `byte_stride_t` and `byte_stride_c` are the C-order byte distances
/// between consecutive indices on the canonical-indexed axes. They are 0
/// when the axis is absent from the on-disk layout or when its
/// `chunk_size == 1` (in which case the modulo is irrelevant).
/// `chunk_size_t` and `chunk_size_c` are carried on the layout so
/// [`Self::slice_range`] can take wire voxel coords directly and reduce
/// them to intra-chunk indices in one place.
///
/// For canonical 5D datasets with `chunk_shape[t] == chunk_shape[c] == 1`,
/// all callers see `slice_range(_, _) == (0, canonical_byte_size)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkByteLayout {
    /// Bytes the canonical 5D pipeline expects per wire chunk request
    /// (= product of kept canonical chunk dims [z, y, x] × dtype size).
    /// One wire chunk request always returns this many bytes regardless
    /// of how the on-disk chunk packs t/c/m/etc.
    pub canonical_byte_size: usize,
    /// Bytes one full decompressed on-disk chunk holds (= product of all
    /// raw chunk dims × dtype size). Used as a defensive bound check at
    /// the slice site.
    pub on_disk_byte_size: usize,
    /// C-order byte stride for the canonical `t` axis within the on-disk
    /// chunk. 0 if `t` is absent or its chunk_size is 1.
    pub byte_stride_t: usize,
    /// C-order byte stride for the canonical `c` axis within the on-disk
    /// chunk. 0 if `c` is absent or its chunk_size is 1.
    pub byte_stride_c: usize,
    /// On-disk chunk size on the `t` axis (1 if `t` is absent). Used to
    /// reduce wire `t` to an intra-chunk index inside [`Self::slice_range`].
    pub chunk_size_t: u64,
    /// On-disk chunk size on the `c` axis (1 if `c` is absent).
    pub chunk_size_c: u64,
}

impl ChunkByteLayout {
    /// Compute the `(offset, size)` byte range for one wire chunk request.
    ///
    /// `wire_t` and `wire_c` are the voxel coordinates from the wire chunk
    /// key (e.g. `c=3` means channel 3). The function reduces them to
    /// intra-chunk indices via `wire_value % chunk_size`. For typical
    /// OME-Zarrs (chunk_size 1 on t and c), the result is always
    /// `(0, canonical_byte_size)`.
    pub fn slice_range(&self, wire_t: u64, wire_c: u64) -> (usize, usize) {
        let intra_t = if self.chunk_size_t > 1 {
            wire_t % self.chunk_size_t
        } else {
            0
        };
        let intra_c = if self.chunk_size_c > 1 {
            wire_c % self.chunk_size_c
        } else {
            0
        };
        let offset = (intra_t as usize)
            .saturating_mul(self.byte_stride_t)
            .saturating_add((intra_c as usize).saturating_mul(self.byte_stride_c));
        (offset, self.canonical_byte_size)
    }
}

/// Compute [`ChunkByteLayout`] for one level. Errors when any chunk
/// dimension is zero (Zarr v3 forbids it, and every byte quantity here
/// would collapse to an empty on-disk chunk) or when the axes order is
/// not contiguous-prefix-sliceable; either way the message names the
/// offending axis so users know what to look for in their OME-Zarr
/// metadata.
///
/// `axes` is the raw OME axes list (e.g. `["t","c","z","m","y","x"]`).
/// `chunk_shape` parallels `axes` (one entry per axis).
/// `pinned` is the canonical `PinnedAxis` list from
/// [`lucida_content::normalize::classify_axes`].
///
/// Eligibility rule: in the raw axes list, after eliminating axes whose
/// `chunk_shape` entry is 1, every "outer" axis (pinned ∪ canonical
/// indexed `t`/`c`) must precede every "inner" axis (canonical kept
/// `z`/`y`/`x`). When this holds, in C-order byte layout one wire-chunk
/// slice is a contiguous range whose offset is determined entirely by
/// the intra-chunk `(t, c)` indices.
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

    // Zarr v3 requires every chunk dimension to be at least 1 on every axis,
    // including non-canonical (pinned) ones. A zero would make every byte
    // quantity below meaningless — in particular an on_disk_byte_size of 0,
    // which no slice-site bound check could ever satisfy.
    if let Some(i) = chunk_shape.iter().position(|&d| d == 0) {
        return Err(StoreError::Metadata(format!(
            "axis '{}' has a zero chunk dimension; Zarr v3 requires every \
             chunk dimension to be at least 1 (chunk_shape: {chunk_shape:?}, \
             axes order: {axes:?})",
            axes[i],
        )));
    }

    let pinned_names: std::collections::HashSet<String> =
        pinned.iter().map(|p| p.name.to_lowercase()).collect();

    // Per-axis byte-size product across all axes (on_disk) and across just
    // the kept canonical axes z/y/x (canonical). t and c are "indexed" —
    // one wire chunk request returns 1 t × 1 c worth, so they contribute
    // factor 1 to canonical regardless of their on-disk chunk size.
    // Use u128 for the intermediate product to defensively avoid overflow
    // on pathological inputs, then check the result fits in usize.
    let mut on_disk: u128 = dtype_size as u128;
    let mut canonical: u128 = dtype_size as u128;
    for (i, name) in axes.iter().enumerate() {
        let dim = chunk_shape[i] as u128;
        let lower = name.to_lowercase();
        on_disk = on_disk.saturating_mul(dim);
        if is_kept_canonical(&lower) {
            canonical = canonical.saturating_mul(dim);
        }
    }

    let on_disk_byte_size = usize::try_from(on_disk)
        .map_err(|_| StoreError::Metadata("chunk byte size exceeds usize".to_string()))?;
    let canonical_byte_size = usize::try_from(canonical)
        .map_err(|_| StoreError::Metadata("canonical chunk byte size exceeds usize".to_string()))?;

    // Complements the zero-dimension check above: refuse any layout whose
    // on-disk chunks hold zero bytes (e.g. a zero dtype size), since such a
    // level could never stream a valid chunk.
    if on_disk_byte_size == 0 {
        return Err(StoreError::Metadata(format!(
            "on-disk chunk byte size is 0 (chunk_shape: {chunk_shape:?}, \
             dtype size {dtype_size}); chunks must hold at least one byte"
        )));
    }

    // Compute byte strides for the canonical-indexed axes (t, c) by
    // walking right-to-left and accumulating dtype_size × ∏ inner dims.
    let mut byte_stride_t: usize = 0;
    let mut byte_stride_c: usize = 0;
    let mut current_stride: u128 = dtype_size as u128;
    for i in (0..axes.len()).rev() {
        let lower = axes[i].to_lowercase();
        match lower.as_str() {
            "t" => {
                byte_stride_t = usize::try_from(current_stride)
                    .map_err(|_| StoreError::Metadata("t byte stride exceeds usize".to_string()))?;
            }
            "c" => {
                byte_stride_c = usize::try_from(current_stride)
                    .map_err(|_| StoreError::Metadata("c byte stride exceeds usize".to_string()))?;
            }
            _ => {}
        }
        let dim = chunk_shape[i] as u128;
        current_stride = current_stride.saturating_mul(dim);
    }

    // Look up the chunk_size on t and c (default 1 when the axis is
    // absent — semantically a single index). Zero out the corresponding
    // stride when the chunk_size is 1 so `slice_range` can short-circuit.
    let t_idx = axes.iter().position(|a| a.eq_ignore_ascii_case("t"));
    let chunk_size_t = t_idx.map(|i| chunk_shape[i]).unwrap_or(1);
    if chunk_size_t <= 1 {
        byte_stride_t = 0;
    }
    let c_idx = axes.iter().position(|a| a.eq_ignore_ascii_case("c"));
    let chunk_size_c = c_idx.map(|i| chunk_shape[i]).unwrap_or(1);
    if chunk_size_c <= 1 {
        byte_stride_c = 0;
    }

    // Eligibility: among chunk_size > 1 axes, every outer (pinned ∪
    // canonical-indexed t,c) must precede every inner (canonical-kept
    // z,y,x). Equivalent to: once we've seen a kept-canonical axis with
    // chunk_size > 1, no subsequent axis may be outer with chunk_size > 1.
    let mut seen_inner_with_chunk_gt_1 = false;
    for (i, name) in axes.iter().enumerate() {
        if chunk_shape[i] <= 1 {
            continue;
        }
        let lower = name.to_lowercase();
        let is_pinned = pinned_names.contains(&lower);
        let is_indexed = is_canonical_indexed(&lower);
        let is_outer = is_pinned || is_indexed;
        if is_outer {
            if seen_inner_with_chunk_gt_1 {
                let kind = if is_pinned {
                    "non-canonical (pinned)"
                } else {
                    "canonical-indexed (t/c)"
                };
                return Err(StoreError::Metadata(format!(
                    "axis '{}' (chunk_size {}) is {} and falls in a non-prefix position; \
                     contiguous slicing requires all indexed and pinned axes to precede any \
                     kept canonical axis (z, y, x) with chunk_size > 1 (axes order: {:?})",
                    name, chunk_shape[i], kind, axes,
                )));
            }
        } else {
            // Kept canonical (z, y, x) with chunk_size > 1.
            seen_inner_with_chunk_gt_1 = true;
        }
    }

    Ok(ChunkByteLayout {
        canonical_byte_size,
        on_disk_byte_size,
        byte_stride_t,
        byte_stride_c,
        chunk_size_t,
        chunk_size_c,
    })
}

fn is_kept_canonical(lower_name: &str) -> bool {
    matches!(lower_name, "z" | "y" | "x")
}

fn is_canonical_indexed(lower_name: &str) -> bool {
    matches!(lower_name, "t" | "c")
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
        assert_eq!(layout.canonical_byte_size, 256 * 256 * 2);
        assert_eq!(layout.on_disk_byte_size, layout.canonical_byte_size);
        assert_eq!(layout.byte_stride_t, 0);
        assert_eq!(layout.byte_stride_c, 0);
        assert_eq!(layout.slice_range(0, 0), (0, 256 * 256 * 2));
    }

    #[test]
    fn six_d_with_m_chunk_size_2_slices() {
        // The CZI export fixture (6D with m pinned).
        let layout = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "m", "y", "x"]),
            &[1, 1, 1, 2, 2048, 1504],
            2,
            &[pinned("m", 6)],
        )
        .unwrap();
        assert_eq!(layout.canonical_byte_size, 2048 * 1504 * 2);
        assert_eq!(layout.on_disk_byte_size, 2 * 2048 * 1504 * 2);
        // Strides are 0 because chunk_size on t and c is 1.
        assert_eq!(layout.byte_stride_t, 0);
        assert_eq!(layout.byte_stride_c, 0);
        // Pinned m=0 prefix slice — same as old needs_slicing + truncate.
        assert_eq!(layout.slice_range(0, 0), (0, 2048 * 1504 * 2));
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
        assert_eq!(layout.canonical_byte_size, 2048 * 1504 * 2);
        assert_eq!(layout.on_disk_byte_size, layout.canonical_byte_size);
        assert_eq!(layout.byte_stride_t, 0);
        assert_eq!(layout.byte_stride_c, 0);
        assert_eq!(layout.slice_range(0, 0), (0, 2048 * 1504 * 2));
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
        // canonical = z(absent)=1 × y=1 × x=1504 × dtype = 1504 × 2.
        assert_eq!(layout.canonical_byte_size, 1504 * 2);
        // on_disk = m=2 × y=1 × s=2 × x=1504 × dtype = 4 × 1504 × 2.
        assert_eq!(layout.on_disk_byte_size, 4 * 1504 * 2);
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
        assert!(
            msg.contains('\''),
            "error should quote the axis name: {msg}"
        );
        assert!(msg.contains('m'), "error should name 'm': {msg}");
        assert!(
            msg.contains("non-prefix"),
            "error should say 'non-prefix': {msg}"
        );
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
        let err = compute_chunk_byte_layout(&axes(&["t", "c", "z", "y", "x"]), &[1, 1, 1], 2, &[])
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("length mismatch"), "{msg}");
    }

    #[test]
    fn rejects_zero_chunk_dim_on_pinned_axis() {
        // [t, c, z, m, y, x] with chunk_m = 0: the zero sits on the pinned
        // axis, which a normalized-5D view of the chunk_shape would drop —
        // the raw check here must reject it and name the axis.
        let err = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "m", "y", "x"]),
            &[1, 1, 1, 0, 64, 64],
            2,
            &[pinned("m", 6)],
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("'m'"), "error should name 'm': {msg}");
        assert!(
            msg.contains("zero chunk dimension"),
            "error should call out the zero chunk dimension: {msg}"
        );
    }

    #[test]
    fn rejects_zero_chunk_dim_on_canonical_axis() {
        let err = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "y", "x"]),
            &[1, 1, 1, 0, 256],
            2,
            &[],
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("'y'"), "error should name 'y': {msg}");
        assert!(
            msg.contains("zero chunk dimension"),
            "error should call out the zero chunk dimension: {msg}"
        );
    }

    #[test]
    fn rejects_layout_with_zero_byte_chunks() {
        // Every dimension is >= 1 but a dtype size of 0 still collapses the
        // byte sizes to nothing; the layout must be refused rather than admit
        // on_disk_byte_size == 0.
        let err = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "y", "x"]),
            &[1, 1, 1, 64, 64],
            0,
            &[],
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("byte size is 0"),
            "error should call out the empty byte size: {msg}"
        );
    }

    // Canonical-indexed (t, c) chunk_size > 1 cases.

    #[test]
    fn lif_test_shape_c_bundled() {
        // The lif_test.ome.zarr fixture: 5 channels in one chunk.
        let layout = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "y", "x"]),
            &[1, 5, 1, 1024, 1024],
            2,
            &[],
        )
        .unwrap();
        // canonical = 1 × 1024 × 1024 × 2 (one channel's worth)
        assert_eq!(layout.canonical_byte_size, 1024 * 1024 * 2);
        // on_disk = 5 channels × canonical = 10 MB
        assert_eq!(layout.on_disk_byte_size, 5 * 1024 * 1024 * 2);
        // byte_stride_c = bytes per increment of c = 1 z × 1024 y × 1024 x × 2
        assert_eq!(layout.byte_stride_c, 1024 * 1024 * 2);
        // byte_stride_t = 0 because chunk_t == 1
        assert_eq!(layout.byte_stride_t, 0);
        assert_eq!(layout.chunk_size_c, 5);
        assert_eq!(layout.chunk_size_t, 1);
        // slice_range for wire c=3: offset = 3 × 2 MB = 6 MB
        assert_eq!(
            layout.slice_range(0, 3),
            (3 * 1024 * 1024 * 2, 1024 * 1024 * 2)
        );
        // wire c=7 wraps to intra c=2 (7 % 5)
        assert_eq!(
            layout.slice_range(0, 7),
            (2 * 1024 * 1024 * 2, 1024 * 1024 * 2)
        );
    }

    #[test]
    fn timepoint_bundled() {
        // Hypothetical 3-timepoints-per-chunk OME-Zarr.
        let layout = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "y", "x"]),
            &[3, 1, 1, 1024, 1024],
            2,
            &[],
        )
        .unwrap();
        assert_eq!(layout.canonical_byte_size, 1024 * 1024 * 2);
        assert_eq!(layout.on_disk_byte_size, 3 * 1024 * 1024 * 2);
        // byte_stride_t = 1 c × 1 z × 1024 y × 1024 x × 2 = 2 MB
        assert_eq!(layout.byte_stride_t, 1024 * 1024 * 2);
        // byte_stride_c = 0 because chunk_c == 1
        assert_eq!(layout.byte_stride_c, 0);
        assert_eq!(layout.chunk_size_t, 3);
        // slice_range for wire t=2: offset = 2 × 2 MB = 4 MB
        assert_eq!(
            layout.slice_range(2, 0),
            (2 * 1024 * 1024 * 2, 1024 * 1024 * 2)
        );
    }

    #[test]
    fn multi_axis_bundled() {
        // 2 timepoints × 5 channels × 3 z-slices per chunk.
        let layout = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "y", "x"]),
            &[2, 5, 3, 64, 64],
            2,
            &[],
        )
        .unwrap();
        // canonical = 3 z × 64 y × 64 x × 2 = 24576 bytes
        assert_eq!(layout.canonical_byte_size, 3 * 64 * 64 * 2);
        // on_disk = 2 × 5 × 24576 = 245760
        assert_eq!(layout.on_disk_byte_size, 2 * 5 * 3 * 64 * 64 * 2);
        // byte_stride_c = 3 × 64 × 64 × 2 = 24576 (canonical, since z, y, x inner)
        assert_eq!(layout.byte_stride_c, 3 * 64 * 64 * 2);
        // byte_stride_t = 5 × 24576 = 122880
        assert_eq!(layout.byte_stride_t, 5 * 3 * 64 * 64 * 2);
        assert_eq!(layout.chunk_size_t, 2);
        assert_eq!(layout.chunk_size_c, 5);
        // slice_range for wire (t=1, c=2): offset = 1 × 122880 + 2 × 24576 = 172032
        assert_eq!(
            layout.slice_range(1, 2),
            (5 * 3 * 64 * 64 * 2 + 2 * 3 * 64 * 64 * 2, 3 * 64 * 64 * 2)
        );
    }

    #[test]
    fn canonical_indexed_plus_pinned() {
        // [t, c, z, m, y, x] with chunk_c=5 and chunk_m=2: both outer (c is
        // canonical-indexed, m is pinned), both before y, x. Eligible.
        let layout = compute_chunk_byte_layout(
            &axes(&["t", "c", "z", "m", "y", "x"]),
            &[1, 5, 1, 2, 1024, 1024],
            2,
            &[pinned("m", 4)],
        )
        .unwrap();
        // canonical = 1 z × 1024 y × 1024 x × 2 = 2 MB
        assert_eq!(layout.canonical_byte_size, 1024 * 1024 * 2);
        // on_disk = 5 c × 2 m × canonical = 20 MB
        assert_eq!(layout.on_disk_byte_size, 5 * 2 * 1024 * 1024 * 2);
        // byte_stride_c = 1 z × 2 m × 1024 y × 1024 x × 2 = 4 MB
        assert_eq!(layout.byte_stride_c, 2 * 1024 * 1024 * 2);
        // For wire c=3 with m pinned to 0: offset = 3 × 4 MB = 12 MB; size = 2 MB
        assert_eq!(
            layout.slice_range(0, 3),
            (3 * 2 * 1024 * 1024 * 2, 1024 * 1024 * 2)
        );
    }

    #[test]
    fn rejects_canonical_indexed_after_kept_canonical() {
        // [t, z, c, y, x] with both z_chunk > 1 and c_chunk > 1 — z (kept,
        // chunk>1) comes before c (indexed, chunk>1). Slicing one channel
        // requires gathering across z-blocks; not contiguous.
        let err = compute_chunk_byte_layout(
            &axes(&["t", "z", "c", "y", "x"]),
            &[1, 3, 5, 1024, 1024],
            2,
            &[],
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains('c'), "error should name 'c': {msg}");
        assert!(
            msg.contains("non-prefix"),
            "error should say 'non-prefix': {msg}"
        );
        assert!(
            msg.contains("canonical-indexed"),
            "error should classify the axis: {msg}"
        );
    }

    #[test]
    fn rejects_pinned_after_kept_canonical_with_canonical_indexed_chunked() {
        // [t, c, y, m, x] with chunk_y > 1 and chunk_m > 1: m (pinned) comes
        // after y (kept, chunk>1). Same kind of non-prefix layout failure.
        let err = compute_chunk_byte_layout(
            &axes(&["t", "c", "y", "m", "x"]),
            &[1, 5, 1024, 2, 1024],
            2,
            &[pinned("m", 4)],
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains('m'), "error should name 'm': {msg}");
        assert!(msg.contains("non-prefix"), "{msg}");
    }

    #[test]
    fn axis_absent_means_zero_stride() {
        // [c, y, x] (no t, no z) with chunk_c = 4.
        let layout =
            compute_chunk_byte_layout(&axes(&["c", "y", "x"]), &[4, 100, 200], 2, &[]).unwrap();
        // canonical = 100 × 200 × 2 = 40000
        assert_eq!(layout.canonical_byte_size, 100 * 200 * 2);
        assert_eq!(layout.on_disk_byte_size, 4 * 100 * 200 * 2);
        assert_eq!(layout.byte_stride_t, 0);
        assert_eq!(layout.byte_stride_c, 100 * 200 * 2);
        assert_eq!(layout.chunk_size_t, 1);
        assert_eq!(layout.chunk_size_c, 4);
        // wire t=99 is irrelevant (axis absent → modulo-reduced to 0).
        assert_eq!(
            layout.slice_range(99, 2),
            (2 * 100 * 200 * 2, 100 * 200 * 2)
        );
    }
}
