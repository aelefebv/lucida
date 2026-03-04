use std::ops::Range;

/// Selected indices for non-displayed dimensions.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewState {
    /// Z slab range. A single slice is a range of length 1 (e.g. 42..43).
    pub z_range: Range<u32>,
    pub t: u32,
    pub c: u32,
}

impl ViewState {
    pub fn new() -> Self {
        Self {
            z_range: 0..1,
            t: 0,
            c: 0,
        }
    }

    /// Set a single z slice (slab of thickness 1).
    pub fn set_z(&mut self, index: u32) {
        self.z_range = index..index + 1;
    }

    /// Set a z slab range.
    pub fn set_z_range(&mut self, range: Range<u32>) {
        self.z_range = range;
    }

    pub fn set_slice(&mut self, axis: &str, index: u32) -> Result<(), String> {
        match axis {
            "z" => self.set_z(index),
            "t" => self.t = index,
            "c" => self.c = index,
            _ => return Err(format!("unknown axis: {axis}")),
        }
        Ok(())
    }
}

impl Default for ViewState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_view_starts_at_zero() {
        let v = ViewState::new();
        assert_eq!(v.z_range, 0..1);
        assert_eq!(v.t, 0);
        assert_eq!(v.c, 0);
    }

    #[test]
    fn set_slice_updates_z_as_single_plane() {
        let mut v = ViewState::new();
        v.set_slice("z", 42).unwrap();
        assert_eq!(v.z_range, 42..43);
        assert_eq!(v.t, 0);
    }

    #[test]
    fn set_z_range_for_slab() {
        let mut v = ViewState::new();
        v.set_z_range(10..20);
        assert_eq!(v.z_range, 10..20);
    }

    #[test]
    fn set_slice_rejects_unknown_axis() {
        let mut v = ViewState::new();
        assert!(v.set_slice("q", 1).is_err());
    }
}
