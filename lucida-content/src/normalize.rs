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
}
