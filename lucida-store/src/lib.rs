pub mod backend;
pub mod budget;
pub mod cache;
pub(crate) mod coarse;
pub mod codec;
pub mod import;
pub mod import_types;
pub mod ingest;
mod label_discovery;
pub mod layout;
mod metadata;
pub(crate) mod parse;

use std::{fmt, str::FromStr};

/// The canonical 5D axis names in order.
const ALL_DIMS: [&str; 5] = ["t", "c", "z", "y", "x"];

/// Stable reason a client-provided chunk key was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkKeyErrorCategory {
    Shape,
    Syntax,
    Bounds,
}

/// Path-addressed chunk-key failure.  The original key is deliberately not
/// retained or displayed: it may contain credentials or path-like attacker
/// input and is never needed to derive a storage object path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkKeyError {
    pub category: ChunkKeyErrorCategory,
    pub path: &'static str,
    pub message: String,
}

impl ChunkKeyError {
    fn new(
        category: ChunkKeyErrorCategory,
        path: &'static str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            category,
            path,
            message: message.into(),
        }
    }
}

impl fmt::Display for ChunkKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} ({:?})", self.path, self.message, self.category)
    }
}

impl std::error::Error for ChunkKeyError {}

/// The only accepted wire chunk-key representation.
///
/// Coordinates are parsed before any storage lookup.  Keeping them numeric
/// makes it impossible for traversal text or an extra path segment to reach
/// object-store path construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkKey {
    pub level: u32,
    pub t: u64,
    pub c: u64,
    pub z: u64,
    pub y: u64,
    pub x: u64,
}

impl ChunkKey {
    pub const COMPONENT_COUNT: usize = 6;

    pub fn canonical_coords(self) -> [u64; 5] {
        [self.t, self.c, self.z, self.y, self.x]
    }

    /// Derive a Zarr object path using only validated numeric coordinates and
    /// import-owned axis metadata.
    pub fn to_store_path(
        self,
        axes: &[String],
        chunk_shape: &[u64],
    ) -> Result<String, ChunkKeyError> {
        if axes.is_empty() || axes.len() != chunk_shape.len() {
            return Err(ChunkKeyError::new(
                ChunkKeyErrorCategory::Shape,
                "binding.axes",
                format!(
                    "axes/chunk_shape rank mismatch: {} axes, {} chunk dimensions",
                    axes.len(),
                    chunk_shape.len()
                ),
            ));
        }
        if axes.len() > 32 {
            return Err(ChunkKeyError::new(
                ChunkKeyErrorCategory::Bounds,
                "binding.axes",
                "axis rank exceeds 32",
            ));
        }
        if chunk_shape.contains(&0) {
            return Err(ChunkKeyError::new(
                ChunkKeyErrorCategory::Bounds,
                "binding.chunk_shape",
                "chunk dimensions must be positive",
            ));
        }

        let canonical = self.canonical_coords();
        let mut coordinates = Vec::with_capacity(axes.len());
        for (axis_index, name) in axes.iter().enumerate() {
            if name.is_empty() || name.contains('/') || matches!(name.as_str(), "." | "..") {
                return Err(ChunkKeyError::new(
                    ChunkKeyErrorCategory::Syntax,
                    "binding.axes",
                    "axis names must be nonempty path-safe components",
                ));
            }
            let coordinate = ALL_DIMS
                .iter()
                .position(|dimension| dimension.eq_ignore_ascii_case(name))
                .map(|canonical_index| {
                    let value = canonical[canonical_index];
                    if canonical_index < 2 {
                        value / chunk_shape[axis_index]
                    } else {
                        value
                    }
                })
                .unwrap_or(0);
            coordinates.push(coordinate.to_string());
        }
        Ok(format!("{}/c/{}", self.level, coordinates.join("/")))
    }
}

impl FromStr for ChunkKey {
    type Err = ChunkKeyError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        let parts: Vec<&str> = raw.split('/').collect();
        if parts.len() != Self::COMPONENT_COUNT {
            return Err(ChunkKeyError::new(
                ChunkKeyErrorCategory::Shape,
                "chunk_key",
                format!(
                    "expected {} numeric components; found {}",
                    Self::COMPONENT_COUNT,
                    parts.len()
                ),
            ));
        }
        if parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return Err(ChunkKeyError::new(
                ChunkKeyErrorCategory::Syntax,
                "chunk_key",
                "every component must be a nonempty unsigned decimal integer",
            ));
        }
        let parse_u64 = |index: usize| {
            parts[index].parse::<u64>().map_err(|_| {
                ChunkKeyError::new(
                    ChunkKeyErrorCategory::Bounds,
                    "chunk_key",
                    format!("component {index} exceeds u64"),
                )
            })
        };
        let level_value = parse_u64(0)?;
        let level = u32::try_from(level_value).map_err(|_| {
            ChunkKeyError::new(
                ChunkKeyErrorCategory::Bounds,
                "chunk_key.level",
                "level exceeds u32",
            )
        })?;
        Ok(Self {
            level,
            t: parse_u64(1)?,
            c: parse_u64(2)?,
            z: parse_u64(3)?,
            y: parse_u64(4)?,
            x: parse_u64(5)?,
        })
    }
}

/// Convert a logical chunk key `"level/t/c/z/y/x"` to the on-disk Zarr v3
/// store path. The on-disk path always follows the dataset's raw axes order,
/// emitting one coordinate per dimension actually present on disk.
///
/// The wire chunk key encodes `t` and `c` as **voxel coordinates** (e.g.
/// `c=3` means channel 3) and `z`, `y`, `x` as **chunk-grid coordinates**
/// (e.g. `y=3` means the 3rd chunk row). For typical OME-Zarrs with
/// `chunk_shape[t] == chunk_shape[c] == 1`, the two interpretations
/// coincide. When `chunk_shape[t] > 1` or `chunk_shape[c] > 1`, this
/// function divides the wire `t`/`c` value by the on-disk chunk size to
/// produce the correct disk-grid coordinate. See
/// `wiki/gotchas/wire-chunk-key-conventions.md`.
///
/// `chunk_shape` parallels `axes` (one entry per on-disk axis).
///
/// Three cases handled uniformly by walking the raw `axes` list in order:
/// - canonical-equal `["t","c","z","y","x"]` → `"{level}/c/{t}/{c}/{z}/{y}/{x}"`
/// - canonical-subset `["c","y","x"]` → `"{level}/c/{c}/{y}/{x}"` (only the dims that exist)
/// - canonical-superset `["t","c","z","m","y","x"]` → `"{level}/c/{t}/{c}/{z}/0/{y}/{x}"`
///   (a `"0"` is injected for each non-canonical axis — these axes are pinned
///   to index 0; see `lucida-content::normalize` for the canonical set)
pub fn chunk_key_to_store_path(key: &str, axes: &[String], chunk_shape: &[u64]) -> String {
    chunk_key_to_store_path_checked(key, axes, chunk_shape).unwrap_or_default()
}

/// Strict variant used at request boundaries.  Invalid input never becomes a
/// store-relative path and callers receive a stable typed failure.
pub fn chunk_key_to_store_path_checked(
    key: &str,
    axes: &[String],
    chunk_shape: &[u64],
) -> Result<String, ChunkKeyError> {
    key.parse::<ChunkKey>()?.to_store_path(axes, chunk_shape)
}

/// Legacy 5D convenience wrapper — assumes all 5 axes are present and
/// `chunk_shape[t] == chunk_shape[c] == 1`.
pub fn chunk_key_to_store_path_5d(key: &str) -> String {
    let full: Vec<String> = ALL_DIMS.iter().map(|s| s.to_string()).collect();
    chunk_key_to_store_path(key, &full, &[1, 1, 1, 1, 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn axes(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn chunk_key_standard_5d() {
        // Full 5D axes — same result as legacy behavior.
        assert_eq!(
            chunk_key_to_store_path(
                "2/0/1/5/3/2",
                &axes(&["t", "c", "z", "y", "x"]),
                &[1, 1, 1, 1, 1]
            ),
            "2/c/0/1/5/3/2"
        );
    }

    #[test]
    fn chunk_key_5d_convenience() {
        assert_eq!(chunk_key_to_store_path_5d("2/0/1/5/3/2"), "2/c/0/1/5/3/2");
    }

    #[test]
    fn chunk_key_short_fallback() {
        let error = chunk_key_to_store_path_checked(
            "foo/bar",
            &axes(&["t", "c", "z", "y", "x"]),
            &[1, 1, 1, 1, 1],
        )
        .unwrap_err();
        assert_eq!(error.category, ChunkKeyErrorCategory::Shape);
        assert_eq!(
            chunk_key_to_store_path(
                "foo/bar",
                &axes(&["t", "c", "z", "y", "x"]),
                &[1, 1, 1, 1, 1]
            ),
            ""
        );
    }

    #[test]
    fn typed_chunk_key_rejects_traversal_extra_segments_and_overflow() {
        for key in [
            "0/0/0/0/../0",
            "0/0/0/0/0/0/secret",
            "0/0/0/0/0/18446744073709551616",
        ] {
            assert!(key.parse::<ChunkKey>().is_err(), "accepted {key}");
        }
    }

    #[test]
    fn chunk_key_3d_cyx() {
        // axes = [c, y, x]. Chunk key still 5D: "level/t/c/z/y/x".
        // Only c, y, x coords should appear in the store path.
        // Key: "0/0/2/0/10/5" → level=0, t=0, c=2, z=0, y=10, x=5
        // Store path should be "0/c/2/10/5" (only c, y, x)
        assert_eq!(
            chunk_key_to_store_path("0/0/2/0/10/5", &axes(&["c", "y", "x"]), &[1, 1, 1]),
            "0/c/2/10/5"
        );
    }

    #[test]
    fn chunk_key_3d_zyx() {
        // axes = [z, y, x]. Key: "1/0/0/3/4/5" → level=1, t=0, c=0, z=3, y=4, x=5
        // Store path: "1/c/3/4/5"
        assert_eq!(
            chunk_key_to_store_path("1/0/0/3/4/5", &axes(&["z", "y", "x"]), &[1, 1, 1]),
            "1/c/3/4/5"
        );
    }

    #[test]
    fn chunk_key_4d_czyx() {
        // axes = [c, z, y, x]. Key: "0/0/1/5/3/2" → level=0, t=0, c=1, z=5, y=3, x=2
        // Store path: "0/c/1/5/3/2" (all except t)
        assert_eq!(
            chunk_key_to_store_path("0/0/1/5/3/2", &axes(&["c", "z", "y", "x"]), &[1, 1, 1, 1]),
            "0/c/1/5/3/2"
        );
    }

    #[test]
    fn chunk_key_2d_yx() {
        // axes = [y, x]. Key: "0/0/0/0/7/3" → level=0, y=7, x=3
        // Store path: "0/c/7/3"
        assert_eq!(
            chunk_key_to_store_path("0/0/0/0/7/3", &axes(&["y", "x"]), &[1, 1]),
            "0/c/7/3"
        );
    }

    #[test]
    fn chunk_key_6d_with_m() {
        // axes = [t, c, z, m, y, x] — CZI mosaic case.
        // Key: "0/0/3/0/0/0" → level=0, t=0, c=3, z=0, y=0, x=0.
        // m is non-canonical — pinned to "0" in the on-disk path.
        // Store path: "0/c/0/3/0/0/0/0" (6 coords, "0" injected at m position).
        assert_eq!(
            chunk_key_to_store_path(
                "0/0/3/0/0/0",
                &axes(&["t", "c", "z", "m", "y", "x"]),
                &[1, 1, 1, 1, 1, 1]
            ),
            "0/c/0/3/0/0/0/0"
        );
    }

    #[test]
    fn chunk_key_7d_with_two_non_canonical() {
        // axes = [t, c, z, m, s, y, x] — two non-canonical axes between z and y.
        // Key: "1/0/2/5/4/3" → level=1, t=0, c=2, z=5, y=4, x=3.
        // Both m and s pinned to "0".
        // Store path: "1/c/0/2/5/0/0/4/3" (7 coords, two "0"s).
        assert_eq!(
            chunk_key_to_store_path(
                "1/0/2/5/4/3",
                &axes(&["t", "c", "z", "m", "s", "y", "x"]),
                &[1, 1, 1, 1, 1, 1, 1]
            ),
            "1/c/0/2/5/0/0/4/3"
        );
    }

    #[test]
    fn chunk_key_3d_with_m() {
        // axes = [m, y, x] — single non-canonical axis among 3D.
        // Key: "2/0/0/0/8/4" → level=2, y=8, x=4.
        // m pinned to "0".
        // Store path: "2/c/0/8/4" (3 coords, "0" at m).
        assert_eq!(
            chunk_key_to_store_path("2/0/0/0/8/4", &axes(&["m", "y", "x"]), &[1, 1, 1]),
            "2/c/0/8/4"
        );
    }

    #[test]
    fn chunk_key_case_insensitive_axes() {
        // Mixed-case axis names should be treated identically to lowercase
        // (matches `lucida-content::normalize::axis_index` semantics).
        // axes = [T, C, Z, M, Y, X]. Key: "0/0/3/0/0/0".
        assert_eq!(
            chunk_key_to_store_path(
                "0/0/3/0/0/0",
                &axes(&["T", "C", "Z", "M", "Y", "X"]),
                &[1, 1, 1, 1, 1, 1]
            ),
            "0/c/0/3/0/0/0/0"
        );
    }

    // t/c bundling cases.

    #[test]
    fn chunk_key_c_bundled_divides_channel() {
        // lif_test.ome.zarr: 5 channels in one on-disk chunk along c.
        // Wire c=3 / chunk_c=5 = 0 (disk c-coord).
        assert_eq!(
            chunk_key_to_store_path(
                "0/0/3/0/0/0",
                &axes(&["t", "c", "z", "y", "x"]),
                &[1, 5, 1, 1024, 1024]
            ),
            "0/c/0/0/0/0/0"
        );
    }

    #[test]
    fn chunk_key_c_bundled_addresses_second_disk_chunk() {
        // Hypothetical 7 channels (chunked 5-per-chunk) — wire c=7 spans
        // into the 2nd disk chunk: 7/5 = 1.
        assert_eq!(
            chunk_key_to_store_path(
                "0/0/7/0/0/0",
                &axes(&["t", "c", "z", "y", "x"]),
                &[1, 5, 1, 1024, 1024]
            ),
            "0/c/0/1/0/0/0"
        );
    }

    #[test]
    fn chunk_key_t_bundled_divides_timepoint() {
        // 3 timepoints in one on-disk chunk along t.
        // Wire t=5 / chunk_t=3 = 1 (disk t-coord).
        assert_eq!(
            chunk_key_to_store_path(
                "0/5/0/0/0/0",
                &axes(&["t", "c", "z", "y", "x"]),
                &[3, 1, 1, 1024, 1024]
            ),
            "0/c/1/0/0/0/0"
        );
    }
}
