pub mod backend;
pub mod cache;
pub mod import;
pub mod import_types;
pub mod ingest;
pub(crate) mod parse;

/// The canonical 5D axis names in order.
const ALL_DIMS: [&str; 5] = ["t", "c", "z", "y", "x"];

/// Convert a logical chunk key `"level/t/c/z/y/x"` to the on-disk Zarr v3
/// store path, including only the dimensions that actually exist in the dataset.
///
/// When `axes` contains all 5 dimensions `["t","c","z","y","x"]`, the result is
/// identical to the legacy format: `"{level}/c/{t}/{c}/{z}/{y}/{x}"`.
///
/// For datasets with fewer axes (e.g. `["c","y","x"]`), the canonical chunk key
/// still uses all 5 slots `"level/t/c/z/y/x"` (with 0 for missing dims), but
/// the on-disk path only includes the axes that exist.
pub fn chunk_key_to_store_path(key: &str, axes: &[String]) -> String {
    let parts: Vec<&str> = key.splitn(6, '/').collect();
    if parts.len() == 6 {
        // parts[0] = level, parts[1..6] = t, c, z, y, x (canonical 5D order)
        let coords: Vec<&str> = ALL_DIMS
            .iter()
            .enumerate()
            .filter(|(_, dim)| axes.iter().any(|a| a.as_str() == **dim))
            .map(|(i, _)| parts[i + 1]) // +1 to skip the level part
            .collect();
        format!("{}/c/{}", parts[0], coords.join("/"))
    } else {
        key.to_string()
    }
}

/// Legacy 5D convenience wrapper — assumes all 5 axes are present.
pub fn chunk_key_to_store_path_5d(key: &str) -> String {
    let full: Vec<String> = ALL_DIMS.iter().map(|s| s.to_string()).collect();
    chunk_key_to_store_path(key, &full)
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
            chunk_key_to_store_path("2/0/1/5/3/2", &axes(&["t", "c", "z", "y", "x"])),
            "2/c/0/1/5/3/2"
        );
    }

    #[test]
    fn chunk_key_5d_convenience() {
        assert_eq!(
            chunk_key_to_store_path_5d("2/0/1/5/3/2"),
            "2/c/0/1/5/3/2"
        );
    }

    #[test]
    fn chunk_key_short_fallback() {
        assert_eq!(
            chunk_key_to_store_path("foo/bar", &axes(&["t", "c", "z", "y", "x"])),
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
            chunk_key_to_store_path("0/0/2/0/10/5", &axes(&["c", "y", "x"])),
            "0/c/2/10/5"
        );
    }

    #[test]
    fn chunk_key_3d_zyx() {
        // axes = [z, y, x]. Key: "1/0/0/3/4/5" → level=1, t=0, c=0, z=3, y=4, x=5
        // Store path: "1/c/3/4/5"
        assert_eq!(
            chunk_key_to_store_path("1/0/0/3/4/5", &axes(&["z", "y", "x"])),
            "1/c/3/4/5"
        );
    }

    #[test]
    fn chunk_key_4d_czyx() {
        // axes = [c, z, y, x]. Key: "0/0/1/5/3/2" → level=0, t=0, c=1, z=5, y=3, x=2
        // Store path: "0/c/1/5/3/2" (all except t)
        assert_eq!(
            chunk_key_to_store_path("0/0/1/5/3/2", &axes(&["c", "z", "y", "x"])),
            "0/c/1/5/3/2"
        );
    }

    #[test]
    fn chunk_key_2d_yx() {
        // axes = [y, x]. Key: "0/0/0/0/7/3" → level=0, y=7, x=3
        // Store path: "0/c/7/3"
        assert_eq!(
            chunk_key_to_store_path("0/0/0/0/7/3", &axes(&["y", "x"])),
            "0/c/7/3"
        );
    }
}
