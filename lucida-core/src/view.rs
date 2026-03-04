/// Selected indices for non-displayed dimensions.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewState {
    pub z: u32,
    pub t: u32,
    pub c: u32,
}

impl ViewState {
    pub fn new() -> Self {
        Self { z: 0, t: 0, c: 0 }
    }

    pub fn set_slice(&mut self, axis: &str, index: u32) -> Result<(), String> {
        match axis {
            "z" => self.z = index,
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
        assert_eq!(v.z, 0);
        assert_eq!(v.t, 0);
        assert_eq!(v.c, 0);
    }

    #[test]
    fn set_slice_updates_correct_axis() {
        let mut v = ViewState::new();
        v.set_slice("z", 42).unwrap();
        assert_eq!(v.z, 42);
        assert_eq!(v.t, 0);
    }

    #[test]
    fn set_slice_rejects_unknown_axis() {
        let mut v = ViewState::new();
        assert!(v.set_slice("q", 1).is_err());
    }
}
