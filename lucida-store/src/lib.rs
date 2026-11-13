pub mod backend;
pub mod cache;
pub(crate) mod coarse;
pub mod codec;
pub(crate) mod collection_checks;
pub(crate) mod collection_geometry;
pub mod fill;
pub mod import;
pub mod import_types;
pub mod ingest;
pub mod layout;
pub(crate) mod local_reads;
pub mod metadata_reads;
pub(crate) mod parse;
pub mod shard;
pub mod source_limiter;
pub mod source_policy;
pub mod source_throttle;
#[cfg(test)]
pub(crate) mod test_support;
pub(crate) mod unwritten;
pub mod zarr_roots;
pub(crate) mod zarr_v2;

use lucida_content::ChunkKey;
use serde::{Deserialize, Serialize};

use crate::backend::StoreError;

/// The canonical 5D axis names in order.
const ALL_DIMS: [&str; 5] = ["t", "c", "z", "y", "x"];

/// How an array names the object holding each chunk, from its chunk grid
/// coordinates: Zarr v3's `default` encoding, `c/0/1/2`, or the `v2` one,
/// `0.1.2`, which every Zarr v2 array uses. Either may separate the
/// coordinates with `/` or `.`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChunkKeyEncoding {
    Default { separator: char },
    V2 { separator: char },
}

impl Default for ChunkKeyEncoding {
    fn default() -> Self {
        ChunkKeyEncoding::Default { separator: '/' }
    }
}

impl ChunkKeyEncoding {
    /// Parse an array's `chunk_key_encoding`. An array that declares none
    /// uses the default encoding.
    pub fn parse(value: Option<&serde_json::Value>) -> Result<Self, StoreError> {
        let Some(value) = value else {
            return Ok(Self::default());
        };
        let name = value.get("name").and_then(|n| n.as_str()).ok_or_else(|| {
            StoreError::malformed_metadata(format!("chunk_key_encoding {value} has no name"))
        })?;
        let separator = value
            .get("configuration")
            .and_then(|c| c.get("separator"))
            .map(|s| match s.as_str() {
                Some("/") => Ok('/'),
                Some(".") => Ok('.'),
                _ => Err(StoreError::unsupported_layout(format!(
                    "chunk_key_encoding separator {s} not supported (use \"/\" or \".\")"
                ))),
            })
            .transpose()?;
        match name {
            "default" => Ok(ChunkKeyEncoding::Default {
                separator: separator.unwrap_or('/'),
            }),
            "v2" => Ok(ChunkKeyEncoding::V2 {
                separator: separator.unwrap_or('.'),
            }),
            other => Err(StoreError::unsupported_layout(format!(
                "chunk_key_encoding '{other}' not supported (use default or v2)"
            ))),
        }
    }

    /// The store path of the chunk at `coords` in the chunk grid of the
    /// array at `array_path`.
    pub fn store_path(self, array_path: impl std::fmt::Display, coords: &[u64]) -> String {
        let join = |separator: char| {
            coords
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(&separator.to_string())
        };
        match self {
            ChunkKeyEncoding::Default { .. } if coords.is_empty() => format!("{array_path}/c"),
            ChunkKeyEncoding::Default { separator } => {
                format!("{array_path}/c{separator}{}", join(separator))
            }
            ChunkKeyEncoding::V2 { .. } if coords.is_empty() => format!("{array_path}/0"),
            ChunkKeyEncoding::V2 { separator } => format!("{array_path}/{}", join(separator)),
        }
    }
}

/// Convert a chunk key to the store path of its object: one coordinate per
/// axis actually on disk, in raw axes order, named by `encoding` under
/// `level_path`, the level's array path. The examples below are in the
/// default encoding, with `{level}` for the level's path.
///
/// The key carries `t` and `c` as sample coordinates and `z`, `y`, `x` as
/// chunk-grid coordinates, so `t` and `c` are divided by their on-disk
/// chunk size. `chunk_shape` parallels `axes`.
///
/// - canonical-equal `["t","c","z","y","x"]` → `"{level}/c/{t}/{c}/{z}/{y}/{x}"`
/// - canonical-subset `["c","y","x"]` → `"{level}/c/{c}/{y}/{x}"` (only the dims that exist)
/// - canonical-superset `["t","c","z","m","y","x"]` → `"{level}/c/{t}/{c}/{z}/0/{y}/{x}"`
///   (a `"0"` is injected for each non-canonical axis — these axes are pinned
///   to index 0; see `lucida-content::normalize` for the canonical set)
pub fn chunk_key_to_store_path(
    key: &ChunkKey,
    level_path: &str,
    axes: &[String],
    chunk_shape: &[u64],
    encoding: ChunkKeyEncoding,
) -> String {
    encoding.store_path(level_path, &chunk_key_grid_coords(key, axes, chunk_shape))
}

/// The on-disk chunk-grid coordinate a chunk key names, one coordinate per
/// on-disk axis. The rules are those of [`chunk_key_to_store_path`]: a `t`
/// or `c` is divided by the on-disk chunk size on that axis, and a
/// non-canonical axis is pinned to `0`.
pub(crate) fn chunk_key_grid_coords(
    key: &ChunkKey,
    axes: &[String],
    chunk_shape: &[u64],
) -> Vec<u64> {
    let canonical = [key.t, key.c, key.z, key.y, key.x];
    axes.iter()
        .enumerate()
        .map(|(axis_idx, name)| {
            let Some(canon_idx) = ALL_DIMS.iter().position(|d| d.eq_ignore_ascii_case(name)) else {
                return 0;
            };
            let value = canonical[canon_idx];
            let bundled = (canon_idx == 0 || canon_idx == 1)
                && axis_idx < chunk_shape.len()
                && chunk_shape[axis_idx] > 1;
            if bundled {
                value / chunk_shape[axis_idx]
            } else {
                value
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn axes(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn key(key: &str) -> ChunkKey {
        ChunkKey::parse(key).unwrap()
    }

    /// The path of `key`'s object in the default encoding, with the level
    /// index as its array path.
    fn default_path(key: &ChunkKey, axes: &[String], chunk_shape: &[u64]) -> String {
        let level = key.level.to_string();
        chunk_key_to_store_path(key, &level, axes, chunk_shape, ChunkKeyEncoding::default())
    }

    #[test]
    fn a_chunk_s_object_is_named_under_its_level_s_path() {
        let path = chunk_key_to_store_path(
            &key("1/0/0/0/2/3"),
            "scale1/image",
            &axes(&["y", "x"]),
            &[1, 1],
            ChunkKeyEncoding::default(),
        );
        assert_eq!(path, "scale1/image/c/2/3");
    }

    #[test]
    fn each_chunk_key_encoding_names_its_objects() {
        let parse = |value: serde_json::Value| ChunkKeyEncoding::parse(Some(&value)).unwrap();
        let cases = [
            (ChunkKeyEncoding::parse(None).unwrap(), "2/c/0/1/5"),
            (parse(serde_json::json!({"name": "default"})), "2/c/0/1/5"),
            (
                parse(serde_json::json!({"name": "default", "configuration": {"separator": "."}})),
                "2/c.0.1.5",
            ),
            (parse(serde_json::json!({"name": "v2"})), "2/0.1.5"),
            (
                parse(serde_json::json!({"name": "v2", "configuration": {"separator": "/"}})),
                "2/0/1/5",
            ),
        ];
        let axes = axes(&["c", "y", "x"]);
        for (encoding, expected) in cases {
            let path =
                chunk_key_to_store_path(&key("2/0/0/0/1/5"), "2", &axes, &[1, 1, 1], encoding);
            assert_eq!(path, expected, "{encoding:?}");
        }
    }

    #[test]
    fn an_unknown_chunk_key_encoding_is_refused_by_name() {
        let err =
            ChunkKeyEncoding::parse(Some(&serde_json::json!({"name": "hashed"}))).unwrap_err();
        assert!(err.to_string().contains("hashed"), "{err}");
        let err = ChunkKeyEncoding::parse(Some(
            &serde_json::json!({"name": "v2", "configuration": {"separator": "-"}}),
        ))
        .unwrap_err();
        assert!(err.to_string().contains('-'), "{err}");
    }

    #[test]
    fn chunk_key_standard_5d() {
        // Full 5D axes — same result as legacy behavior.
        assert_eq!(
            default_path(
                &key("2/0/1/5/3/2"),
                &axes(&["t", "c", "z", "y", "x"]),
                &[1, 1, 1, 1, 1]
            ),
            "2/c/0/1/5/3/2"
        );
    }

    #[test]
    fn chunk_key_3d_cyx() {
        // axes = [c, y, x]. Chunk key still 5D: "level/t/c/z/y/x".
        // Only c, y, x coords should appear in the store path.
        // Key: "0/0/2/0/10/5" → level=0, t=0, c=2, z=0, y=10, x=5
        // Store path should be "0/c/2/10/5" (only c, y, x)
        assert_eq!(
            default_path(&key("0/0/2/0/10/5"), &axes(&["c", "y", "x"]), &[1, 1, 1]),
            "0/c/2/10/5"
        );
    }

    #[test]
    fn chunk_key_3d_zyx() {
        // axes = [z, y, x]. Key: "1/0/0/3/4/5" → level=1, t=0, c=0, z=3, y=4, x=5
        // Store path: "1/c/3/4/5"
        assert_eq!(
            default_path(&key("1/0/0/3/4/5"), &axes(&["z", "y", "x"]), &[1, 1, 1]),
            "1/c/3/4/5"
        );
    }

    #[test]
    fn chunk_key_4d_czyx() {
        // axes = [c, z, y, x]. Key: "0/0/1/5/3/2" → level=0, t=0, c=1, z=5, y=3, x=2
        // Store path: "0/c/1/5/3/2" (all except t)
        assert_eq!(
            default_path(
                &key("0/0/1/5/3/2"),
                &axes(&["c", "z", "y", "x"]),
                &[1, 1, 1, 1]
            ),
            "0/c/1/5/3/2"
        );
    }

    #[test]
    fn chunk_key_2d_yx() {
        // axes = [y, x]. Key: "0/0/0/0/7/3" → level=0, y=7, x=3
        // Store path: "0/c/7/3"
        assert_eq!(
            default_path(&key("0/0/0/0/7/3"), &axes(&["y", "x"]), &[1, 1]),
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
            default_path(
                &key("0/0/3/0/0/0"),
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
            default_path(
                &key("1/0/2/5/4/3"),
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
            default_path(&key("2/0/0/0/8/4"), &axes(&["m", "y", "x"]), &[1, 1, 1]),
            "2/c/0/8/4"
        );
    }

    #[test]
    fn chunk_key_case_insensitive_axes() {
        // Mixed-case axis names should be treated identically to lowercase
        // (matches `lucida-content::normalize::axis_index` semantics).
        // axes = [T, C, Z, M, Y, X]. Key: "0/0/3/0/0/0".
        assert_eq!(
            default_path(
                &key("0/0/3/0/0/0"),
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
            default_path(
                &key("0/0/3/0/0/0"),
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
            default_path(
                &key("0/0/7/0/0/0"),
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
            default_path(
                &key("0/5/0/0/0/0"),
                &axes(&["t", "c", "z", "y", "x"]),
                &[3, 1, 1, 1024, 1024]
            ),
            "0/c/1/0/0/0/0"
        );
    }
}
