pub mod backend;
pub mod cache;
pub(crate) mod coarse;
pub mod codec;
pub mod import;
pub mod import_types;
pub mod ingest;
pub mod layout;
pub(crate) mod parse;

/// The canonical 5D axis names in order.
const ALL_DIMS: [&str; 5] = ["t", "c", "z", "y", "x"];

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
/// produce the correct disk-grid coordinate.
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
    let parts: Vec<&str> = key.splitn(6, '/').collect();
    if parts.len() != 6 {
        return key.to_string();
    }
    // parts[0] = level, parts[1..6] = canonical 5D coords in t,c,z,y,x order.
    let coords: Vec<String> = axes
        .iter()
        .enumerate()
        .map(|(axis_idx, name)| {
            let canonical_pos = ALL_DIMS.iter().position(|d| d.eq_ignore_ascii_case(name));
            match canonical_pos {
                None => "0".to_string(),
                Some(canon_idx) => {
                    let wire_value = parts[canon_idx + 1];
                    // For t (canon_idx 0) and c (canon_idx 1), wire is voxel
                    // coord — divide by chunk_shape on this axis to get the
                    // disk-grid coord. For z, y, x the wire is already a
                    // disk-grid coord; chunk_shape divisor is 1 (no-op).
                    if (canon_idx == 0 || canon_idx == 1)
                        && axis_idx < chunk_shape.len()
                        && chunk_shape[axis_idx] > 1
                    {
                        match wire_value.parse::<u64>() {
                            Ok(v) => (v / chunk_shape[axis_idx]).to_string(),
                            Err(_) => wire_value.to_string(),
                        }
                    } else {
                        wire_value.to_string()
                    }
                }
            }
        })
        .collect();
    format!("{}/c/{}", parts[0], coords.join("/"))
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
        assert_eq!(
            chunk_key_to_store_path(
                "foo/bar",
                &axes(&["t", "c", "z", "y", "x"]),
                &[1, 1, 1, 1, 1]
            ),
            "foo/bar"
        );
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
