//! The plane a slice view cuts, and the arithmetic every layer of the slice
//! path shares for it.
//!
//! A slice view draws two volume axes on screen, one across and one down, and
//! cuts the third at one plane. The planner picks the chunk along the cut
//! axis, the page cuts the plane from it, and the render worker files it by
//! that plane, so all three map a full-resolution plane to a level's plane
//! through [`slice_level_plane`]. The render worker's twin is
//! `lucida-web/src/renderer/slicePlane.ts`. If the two disagree, a delivery
//! is refused and sent again forever.

use lucida_content::SpatialAxis;
use serde::{Deserialize, Serialize};

use crate::placement::Affine;

/// The plane a slice view cuts.
///
/// Z is drawn down the screen whenever it is on screen, so both side views
/// stand the volume upright.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlicePlane {
    #[default]
    Xy,
    Xz,
    Yz,
}

impl SlicePlane {
    pub const ALL: [SlicePlane; 3] = [SlicePlane::Xy, SlicePlane::Xz, SlicePlane::Yz];

    pub fn is_xy(&self) -> bool {
        *self == SlicePlane::Xy
    }

    /// The axis drawn across the screen, the one drawn down it, and the one
    /// cut.
    pub fn axes(self) -> [SpatialAxis; 3] {
        match self {
            SlicePlane::Xy => [SpatialAxis::X, SpatialAxis::Y, SpatialAxis::Z],
            SlicePlane::Xz => [SpatialAxis::X, SpatialAxis::Z, SpatialAxis::Y],
            SlicePlane::Yz => [SpatialAxis::Y, SpatialAxis::Z, SpatialAxis::X],
        }
    }

    /// The axis the view cuts, along which its axis position moves.
    pub fn cut(self) -> SpatialAxis {
        self.axes()[2]
    }

    /// How far one sample of a frame `frame_to_scene` places reaches on
    /// screen: the smaller of its extents along the two axes this plane
    /// draws. A slice zoom times this is device pixels per sample, measured
    /// on the densest axis so the level chosen errs coarse, as
    /// [`Affine::plane_sample`] does for XY.
    pub fn sample_extent(self, frame_to_scene: &Affine) -> f64 {
        let [across, down, _] = self.axes();
        let scale = |axis: SpatialAxis| frame_to_scene.scale[axis.xyz()].abs();
        scale(across).min(scale(down))
    }
}

impl std::str::FromStr for SlicePlane {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text.to_ascii_lowercase().as_str() {
            "xy" => Ok(SlicePlane::Xy),
            "xz" => Ok(SlicePlane::Xz),
            "yz" => Ok(SlicePlane::Yz),
            _ => Err(format!("a slice plane is xy, xz or yz, not {text}")),
        }
    }
}

impl std::fmt::Display for SlicePlane {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            SlicePlane::Xy => "xy",
            SlicePlane::Xz => "xz",
            SlicePlane::Yz => "yz",
        })
    }
}

/// The plane at a level `level_extent` planes deep along the cut axis that
/// holds the center of the full-resolution plane `full_res_index`, the plane
/// nearest-sample filtering reads. Integer arithmetic, so no plane lands one
/// short of an exact boundary.
pub fn slice_level_plane(full_res_index: u64, full_res_extent: u64, level_extent: u64) -> u64 {
    let last = level_extent.saturating_sub(1);
    if level_extent == full_res_extent || full_res_extent == 0 {
        return full_res_index.min(last);
    }
    ((2 * full_res_index + 1) * level_extent / (2 * full_res_extent)).min(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_level_plane_takes_the_level_plane_under_the_plane_center() {
        assert_eq!(slice_level_plane(16, 100, 50), 8);
        assert_eq!(slice_level_plane(17, 100, 50), 8);
        assert_eq!(slice_level_plane(99, 100, 50), 49);
        assert_eq!(slice_level_plane(2, 10, 4), 1);
        assert_eq!(slice_level_plane(15, 23, 23), 15);
        assert_eq!(slice_level_plane(40, 32, 16), 15);
    }

    #[test]
    fn each_plane_cuts_the_axis_it_leaves_off_the_screen() {
        assert_eq!(SlicePlane::Xy.cut(), SpatialAxis::Z);
        assert_eq!(SlicePlane::Xz.cut(), SpatialAxis::Y);
        assert_eq!(SlicePlane::Yz.cut(), SpatialAxis::X);
        assert_eq!(SlicePlane::Xz.axes()[1], SpatialAxis::Z);
        assert_eq!(SlicePlane::Yz.axes()[1], SpatialAxis::Z);
    }

    #[test]
    fn a_plane_measures_a_sample_on_the_densest_axis_it_draws() {
        let placed = Affine {
            scale: [0.5, 2.0, 4.0],
            offset: [0.0; 3],
        };
        assert_eq!(SlicePlane::Xy.sample_extent(&placed), 0.5);
        assert_eq!(SlicePlane::Xz.sample_extent(&placed), 0.5);
        assert_eq!(SlicePlane::Yz.sample_extent(&placed), 2.0);
        assert_eq!(SlicePlane::Xy.sample_extent(&placed), placed.plane_sample());
    }

    #[test]
    fn a_plane_reads_and_writes_as_its_lowercase_name() {
        for plane in SlicePlane::ALL {
            let text = plane.to_string();
            assert_eq!(text.parse::<SlicePlane>(), Ok(plane));
            assert_eq!(
                serde_json::to_string(&plane).unwrap(),
                format!("\"{text}\"")
            );
        }
        assert!("zz".parse::<SlicePlane>().is_err());
    }
}
