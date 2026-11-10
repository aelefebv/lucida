use serde::{Deserialize, Serialize};

/// A spatial axis of an image: the axes a chunk key names after `t` and `c`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpatialAxis {
    X,
    Y,
    #[default]
    Z,
}

impl SpatialAxis {
    /// The axis's index into an `[x, y, z]` triple.
    pub fn xyz(self) -> usize {
        match self {
            SpatialAxis::X => 0,
            SpatialAxis::Y => 1,
            SpatialAxis::Z => 2,
        }
    }

    /// The axis's index into a `[t, c, z, y, x]` shape.
    pub fn tczyx(self) -> usize {
        4 - self.xyz()
    }

    pub fn is_z(&self) -> bool {
        *self == SpatialAxis::Z
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_axis_indexes_both_orders_and_reads_as_its_lowercase_name() {
        assert_eq!(SpatialAxis::X.xyz(), 0);
        assert_eq!(SpatialAxis::X.tczyx(), 4);
        assert_eq!(SpatialAxis::Z.tczyx(), 2);
        assert_eq!(serde_json::to_string(&SpatialAxis::Y).unwrap(), "\"y\"");
        assert_eq!(SpatialAxis::default(), SpatialAxis::Z);
    }
}
