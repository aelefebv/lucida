pub mod backend;
pub mod cache;
pub mod ingest;
pub mod metadata;

/// Convert a logical chunk key `"level/t/c/z/y/x"` to the on-disk Zarr v3
/// store path `"{level}/c/{t}/{c}/{z}/{y}/{x}"`.
pub fn chunk_key_to_store_path(key: &str) -> String {
    let parts: Vec<&str> = key.splitn(6, '/').collect();
    if parts.len() == 6 {
        format!(
            "{}/c/{}/{}/{}/{}/{}",
            parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
        )
    } else {
        key.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_key_standard() {
        assert_eq!(
            chunk_key_to_store_path("2/0/1/5/3/2"),
            "2/c/0/1/5/3/2"
        );
    }

    #[test]
    fn chunk_key_short_fallback() {
        assert_eq!(chunk_key_to_store_path("foo/bar"), "foo/bar");
    }
}
