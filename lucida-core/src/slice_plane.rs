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

use std::ops::Range;

use lucida_content::{LevelGeometry, SpatialAxis};
use serde::{Deserialize, Serialize};

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

/// How one image lies in a slice view: the plane, and how many world units a
/// level-0 sample spans along the axis across the screen and the one down it.
///
/// The slice camera's world is level-0 samples along X and Y, where a layout
/// places images, and a slice view of X and Y stays in samples. Z has no
/// place in a layout, so a plane that draws it scales it by its physical
/// spacing against the other axis on screen, and the plane draws at its
/// physical aspect.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SliceFrame {
    pub plane: SlicePlane,
    pub scales: [f64; 2],
}

impl SliceFrame {
    /// The frame an image with this level 0 lies in, cut by `plane`.
    pub fn of(plane: SlicePlane, level0: &LevelGeometry) -> Self {
        let [across, down, _] = plane.axes();
        let spacing = |axis: SpatialAxis| level0.scale[axis.tczyx()];
        let z_scale = if down.is_z() {
            let ratio = spacing(SpatialAxis::Z) / spacing(across);
            if ratio.is_finite() && ratio > 0.0 {
                ratio
            } else {
                1.0
            }
        } else {
            1.0
        };
        Self {
            plane,
            scales: [1.0, z_scale],
        }
    }

    /// The frame of an XY view, where every image is in samples.
    pub fn xy() -> Self {
        Self {
            plane: SlicePlane::Xy,
            scales: [1.0, 1.0],
        }
    }

    /// World units per level-0 sample along `axis`. The cut axis is in
    /// samples.
    fn axis_scale(&self, axis: SpatialAxis) -> f64 {
        let [across, down, _] = self.plane.axes();
        if axis == across {
            self.scales[0]
        } else if axis == down {
            self.scales[1]
        } else {
            1.0
        }
    }

    /// The box an image at layout `position` with level-0 `shape` (`[x, y,
    /// z]`) covers in the slice camera's space, as `[across, down, cut]`
    /// corners. The layout places it along X and Y; along Z it starts at 0.
    pub fn image_box(&self, position: [f64; 2], shape: [f64; 3]) -> ([f64; 3], [f64; 3]) {
        let offset = [position[0], position[1], 0.0];
        let mut min = [0.0; 3];
        let mut max = [0.0; 3];
        for (i, axis) in self.plane.axes().into_iter().enumerate() {
            let a = axis.xyz();
            let s = self.axis_scale(axis);
            let start = if i == 2 { 0.0 } else { offset[a] * s };
            min[i] = start;
            max[i] = start + shape[a] * s;
        }
        (min, max)
    }

    /// The level-0 sample box a view of `world` bounds (`[min_across,
    /// min_down, max_across, max_down]`) cutting `planes` reads, as `[x, y,
    /// z]` minima and maxima. The axes on screen are in layout samples. The
    /// cut axis is in the image's own samples, since every image is cut at
    /// the same plane, as every image is cut at the same Z.
    pub fn sample_box(&self, world: [f64; 4], planes: &Range<u32>) -> ([f64; 3], [f64; 3]) {
        let [across, down, cut] = self.plane.axes();
        let mut min = [0.0; 3];
        let mut max = [0.0; 3];
        for (axis, lo, hi) in [(across, world[0], world[2]), (down, world[1], world[3])] {
            let s = self.axis_scale(axis);
            min[axis.xyz()] = lo / s;
            max[axis.xyz()] = hi / s;
        }
        min[cut.xyz()] = planes.start as f64;
        max[cut.xyz()] = planes.end as f64;
        (min, max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level0(scale_zyx: [f64; 3]) -> LevelGeometry {
        LevelGeometry {
            level_index: 0,
            shape: [1, 1, 100, 200, 300],
            chunk_shape: [1, 1, 10, 20, 30],
            grid_shape: [1, 1, 10, 10, 10],
            scale: [1.0, 1.0, scale_zyx[0], scale_zyx[1], scale_zyx[2]],
        }
    }

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
    fn a_side_view_draws_z_at_its_physical_spacing_against_the_axis_beside_it() {
        let deep = level0([4.0, 0.5, 2.0]);
        assert_eq!(SliceFrame::of(SlicePlane::Xy, &deep).scales, [1.0, 1.0]);
        assert_eq!(SliceFrame::of(SlicePlane::Xz, &deep).scales, [1.0, 2.0]);
        assert_eq!(SliceFrame::of(SlicePlane::Yz, &deep).scales, [1.0, 8.0]);
        // A spacing that is missing or broken draws in samples.
        let broken = level0([0.0, 1.0, 1.0]);
        assert_eq!(SliceFrame::of(SlicePlane::Xz, &broken).scales, [1.0, 1.0]);
    }

    #[test]
    fn an_image_box_places_x_and_y_by_layout_and_scales_z() {
        let frame = SliceFrame::of(SlicePlane::Xz, &level0([4.0, 1.0, 1.0]));
        let (min, max) = frame.image_box([10.0, 20.0], [300.0, 200.0, 100.0]);
        assert_eq!(min, [10.0, 0.0, 0.0]);
        assert_eq!(max, [310.0, 400.0, 200.0]);
        let (min, max) = SliceFrame::xy().image_box([10.0, 20.0], [300.0, 200.0, 100.0]);
        assert_eq!((min, max), ([10.0, 20.0, 0.0], [310.0, 220.0, 100.0]));
    }

    #[test]
    fn a_sample_box_undoes_the_z_scale_and_takes_the_cut_planes() {
        let frame = SliceFrame::of(SlicePlane::Yz, &level0([4.0, 1.0, 1.0]));
        let (min, max) = frame.sample_box([5.0, -40.0, 50.0, 400.0], &(7..8));
        assert_eq!(min, [7.0, 5.0, -10.0]);
        assert_eq!(max, [8.0, 50.0, 100.0]);
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
