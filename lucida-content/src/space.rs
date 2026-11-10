use serde::{Deserialize, Serialize};

/// Where a dataset's frame sits in physical space, as its source declares it.
///
/// The frame is the level-0 sample grid of the dataset's first image, with a
/// collection's members at their layout positions. Its spacing is that image's
/// level-0 scale, so the scale, the units here and the origin together place
/// every sample.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PhysicalSpace {
    /// The unit each spatial axis is measured in, `[z, y, x]`, as the source
    /// names it, or `None` where it names none.
    #[serde(default)]
    pub units: [Option<String>; 3],
    /// The physical point at the frame's origin, `[z, y, x]`, in those units.
    #[serde(default)]
    pub origin: [f64; 3],
}

impl PhysicalSpace {
    /// Whether the source declared nothing a placement could use.
    pub fn is_unset(&self) -> bool {
        self.units.iter().all(Option::is_none) && self.origin.iter().all(|&o| o == 0.0)
    }

    /// Meters per declared unit along `[z, y, x]`, or `None` unless X and Y
    /// both name a length unit. Only then can the frame be compared with
    /// another dataset's in physical terms. A Z axis without a length unit of
    /// its own is taken to share X's, since a single plane has no Z extent to
    /// measure.
    pub fn meters_per_unit(&self) -> Option<[f64; 3]> {
        let [z, y, x] = &self.units;
        let x = meters_per(x.as_deref()?)?;
        let y = meters_per(y.as_deref()?)?;
        let z = z.as_deref().and_then(meters_per).unwrap_or(x);
        Some([z, y, x])
    }
}

/// Meters in one `unit`: the length units OME-Zarr names, and the few
/// abbreviations writers commonly put in their place. `None` for anything
/// else.
pub fn meters_per(unit: &str) -> Option<f64> {
    let meters = match unit.trim() {
        "yottameter" => 1e24,
        "zettameter" => 1e21,
        "exameter" => 1e18,
        "petameter" => 1e15,
        "terameter" => 1e12,
        "gigameter" => 1e9,
        "megameter" => 1e6,
        "kilometer" | "km" => 1e3,
        "hectometer" => 1e2,
        "decameter" => 1e1,
        "meter" | "m" => 1.0,
        "decimeter" => 1e-1,
        "centimeter" | "cm" => 1e-2,
        "millimeter" | "mm" => 1e-3,
        "micrometer" | "micron" | "um" | "\u{b5}m" | "\u{3bc}m" => 1e-6,
        "nanometer" | "nm" => 1e-9,
        "angstrom" | "\u{c5}" => 1e-10,
        "picometer" => 1e-12,
        "femtometer" => 1e-15,
        "attometer" => 1e-18,
        "zeptometer" => 1e-21,
        "yoctometer" => 1e-24,
        "inch" => 0.0254,
        "foot" => 0.3048,
        "yard" => 0.9144,
        "mile" => 1609.344,
        "parsec" => 3.085_677_581_491_367e16,
        _ => return None,
    };
    Some(meters)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space(units: [Option<&str>; 3]) -> PhysicalSpace {
        PhysicalSpace {
            units: units.map(|u| u.map(str::to_string)),
            origin: [0.0; 3],
        }
    }

    #[test]
    fn length_units_convert_to_meters() {
        assert_eq!(meters_per("micrometer"), Some(1e-6));
        assert_eq!(meters_per("\u{b5}m"), Some(1e-6));
        assert_eq!(meters_per("nanometer"), Some(1e-9));
        assert_eq!(meters_per("meter"), Some(1.0));
        assert_eq!(meters_per("second"), None);
        assert_eq!(meters_per(""), None);
    }

    #[test]
    fn a_frame_has_a_physical_scale_only_when_x_and_y_name_lengths() {
        let full = space([Some("nanometer"), Some("micrometer"), Some("micrometer")]);
        assert_eq!(full.meters_per_unit(), Some([1e-9, 1e-6, 1e-6]));

        let flat = space([None, Some("micrometer"), Some("micrometer")]);
        assert_eq!(flat.meters_per_unit(), Some([1e-6, 1e-6, 1e-6]));

        assert_eq!(space([None, None, None]).meters_per_unit(), None);
        assert_eq!(
            space([None, Some("micrometer"), None]).meters_per_unit(),
            None
        );
        assert_eq!(
            space([None, Some("pixel"), Some("pixel")]).meters_per_unit(),
            None
        );
    }

    #[test]
    fn unset_means_no_units_and_a_zero_origin() {
        assert!(PhysicalSpace::default().is_unset());
        assert!(!space([None, None, Some("meter")]).is_unset());
        let moved = PhysicalSpace {
            units: [None, None, None],
            origin: [0.0, 1.0, 0.0],
        };
        assert!(!moved.is_unset());
    }
}
