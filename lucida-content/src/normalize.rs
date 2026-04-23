use crate::image::PinnedAxis;

/// Maps an axis name to its canonical 5D index: t=0, c=1, z=2, y=3, x=4.
pub fn axis_index(name: &str) -> Option<usize> {
    match name.to_lowercase().as_str() {
        "t" => Some(0),
        "c" => Some(1),
        "z" => Some(2),
        "y" => Some(3),
        "x" => Some(4),
        _ => None,
    }
}

/// Classification of a raw OME-Zarr axes list against the canonical 5D set.
///
/// `canonical_names` preserves the raw order of canonical axes (subset of
/// `{t,c,z,y,x}`); `pinned` lists the non-canonical axes with their raw size
/// and the index they were pinned to (always `0` today).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AxisLayout {
    pub canonical_names: Vec<String>,
    pub pinned: Vec<PinnedAxis>,
}

/// Split a raw OME-Zarr axes list into its canonical members and the
/// non-canonical members that should be pinned to a fixed index when reading
/// chunks. Sizes for pinned axes come from the matching position in
/// `raw_shape`; if `raw_shape` is shorter than `axes_names` the missing sizes
/// fall back to `0` (defensive — should not happen in valid OME-Zarr).
pub fn classify_axes(axes_names: &[String], raw_shape: &[u64]) -> AxisLayout {
    let mut canonical_names = Vec::new();
    let mut pinned = Vec::new();
    for (i, name) in axes_names.iter().enumerate() {
        if axis_index(name).is_some() {
            canonical_names.push(name.clone());
        } else {
            pinned.push(PinnedAxis {
                name: name.clone(),
                size: raw_shape.get(i).copied().unwrap_or(0),
                pinned_index: 0,
            });
        }
    }
    AxisLayout {
        canonical_names,
        pinned,
    }
}

/// Pad an N-dimensional u64 array to 5D [T, C, Z, Y, X].
/// Missing axes get `fill`.
pub fn normalize_to_5d(values: &[u64], axes: &[String], fill: u64) -> [u64; 5] {
    let mut result = [fill; 5];
    for (i, name) in axes.iter().enumerate() {
        if let Some(idx) = axis_index(name) {
            if i < values.len() {
                result[idx] = values[i];
            }
        }
    }
    result
}

/// Pad an N-dimensional f64 array to 5D [T, C, Z, Y, X].
/// Missing axes get `fill`.
pub fn normalize_f64_to_5d(values: &[f64], axes: &[String], fill: f64) -> [f64; 5] {
    let mut result = [fill; 5];
    for (i, name) in axes.iter().enumerate() {
        if let Some(idx) = axis_index(name) {
            if i < values.len() {
                result[idx] = values[i];
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn axes(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    // --- normalize_to_5d tests ---

    #[test]
    fn full_5d_axes() {
        let result = normalize_to_5d(
            &[1, 2, 3, 4, 5],
            &axes(&["t", "c", "z", "y", "x"]),
            0,
        );
        assert_eq!(result, [1, 2, 3, 4, 5]);
    }

    #[test]
    fn three_d_axes_zyx() {
        let result = normalize_to_5d(
            &[10, 20, 30],
            &axes(&["z", "y", "x"]),
            1,
        );
        assert_eq!(result, [1, 1, 10, 20, 30]);
    }

    #[test]
    fn two_d_axes_yx() {
        let result = normalize_to_5d(
            &[100, 200],
            &axes(&["y", "x"]),
            1,
        );
        assert_eq!(result, [1, 1, 1, 100, 200]);
    }

    #[test]
    fn empty_axes() {
        let result = normalize_to_5d(&[], &axes(&[]), 1);
        assert_eq!(result, [1, 1, 1, 1, 1]);
    }

    // --- normalize_f64_to_5d tests ---

    #[test]
    fn f64_full_5d_axes() {
        let result = normalize_f64_to_5d(
            &[1.0, 2.0, 3.0, 4.0, 5.0],
            &axes(&["t", "c", "z", "y", "x"]),
            0.0,
        );
        assert_eq!(result, [1.0, 2.0, 3.0, 4.0, 5.0]);
    }

    #[test]
    fn f64_three_d_axes_zyx() {
        let result = normalize_f64_to_5d(
            &[10.0, 20.0, 30.0],
            &axes(&["z", "y", "x"]),
            1.0,
        );
        assert_eq!(result, [1.0, 1.0, 10.0, 20.0, 30.0]);
    }

    #[test]
    fn f64_two_d_axes_yx() {
        let result = normalize_f64_to_5d(
            &[100.0, 200.0],
            &axes(&["y", "x"]),
            1.0,
        );
        assert_eq!(result, [1.0, 1.0, 1.0, 100.0, 200.0]);
    }

    #[test]
    fn f64_empty_axes() {
        let result = normalize_f64_to_5d(&[], &axes(&[]), 1.0);
        assert_eq!(result, [1.0, 1.0, 1.0, 1.0, 1.0]);
    }

    // --- classify_axes tests ---

    #[test]
    fn classify_canonical_only() {
        let layout = classify_axes(&axes(&["t", "c", "z", "y", "x"]), &[1, 2, 3, 4, 5]);
        assert_eq!(layout.canonical_names, vec!["t", "c", "z", "y", "x"]);
        assert!(layout.pinned.is_empty());
    }

    #[test]
    fn classify_sub_canonical() {
        let layout = classify_axes(&axes(&["c", "y", "x"]), &[2, 100, 200]);
        assert_eq!(layout.canonical_names, vec!["c", "y", "x"]);
        assert!(layout.pinned.is_empty());
    }

    #[test]
    fn classify_single_non_canonical_m() {
        let layout = classify_axes(
            &axes(&["t", "c", "z", "m", "y", "x"]),
            &[1, 4, 1, 6, 2048, 1504],
        );
        assert_eq!(layout.canonical_names, vec!["t", "c", "z", "y", "x"]);
        assert_eq!(
            layout.pinned,
            vec![PinnedAxis {
                name: "m".to_string(),
                size: 6,
                pinned_index: 0,
            }]
        );
    }

    #[test]
    fn classify_multiple_non_canonical() {
        let layout = classify_axes(
            &axes(&["t", "c", "z", "m", "s", "y", "x"]),
            &[1, 2, 3, 4, 5, 6, 7],
        );
        assert_eq!(layout.canonical_names, vec!["t", "c", "z", "y", "x"]);
        assert_eq!(
            layout.pinned,
            vec![
                PinnedAxis { name: "m".to_string(), size: 4, pinned_index: 0 },
                PinnedAxis { name: "s".to_string(), size: 5, pinned_index: 0 },
            ]
        );
    }

    #[test]
    fn classify_all_non_canonical() {
        let layout = classify_axes(&axes(&["a", "b"]), &[10, 20]);
        assert!(layout.canonical_names.is_empty());
        assert_eq!(
            layout.pinned,
            vec![
                PinnedAxis { name: "a".to_string(), size: 10, pinned_index: 0 },
                PinnedAxis { name: "b".to_string(), size: 20, pinned_index: 0 },
            ]
        );
    }

    #[test]
    fn classify_case_insensitive() {
        let layout = classify_axes(
            &axes(&["T", "C", "Z", "M", "Y", "X"]),
            &[1, 4, 1, 6, 2048, 1504],
        );
        assert_eq!(layout.canonical_names, vec!["T", "C", "Z", "Y", "X"]);
        assert_eq!(
            layout.pinned,
            vec![PinnedAxis {
                name: "M".to_string(),
                size: 6,
                pinned_index: 0,
            }]
        );
    }

    #[test]
    fn classify_short_raw_shape_falls_back_to_zero() {
        // Defensive: if raw_shape is shorter than axes_names, missing sizes are 0.
        let layout = classify_axes(&axes(&["m", "y", "x"]), &[]);
        assert_eq!(
            layout.pinned,
            vec![PinnedAxis { name: "m".to_string(), size: 0, pinned_index: 0 }]
        );
    }
}
