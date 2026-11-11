//! A view's scale bar: how long a stretch of the screen is in the top
//! dataset the view draws, rounded to a length that reads at a glance.
//!
//! The measure is that dataset's own: its declared lengths when it declares
//! units, its samples otherwise. Two datasets placed by their declared
//! lengths therefore read alike wherever each is drawn, whatever their
//! sample sizes.

use lucida_content::{DatasetId, SpatialAxis};
use serde::Serialize;

use crate::camera::Camera;
use crate::view::ViewId;

use super::{CutReach, Scene};

/// The longest an arm grows, in CSS pixels.
const MAX_ARM_PIXELS: f64 = 120.0;
/// The shortest cap an arm keeps in a small view, in CSS pixels.
const MIN_ARM_PIXELS: f64 = 32.0;
/// How much of a view's width, or height, one arm may take.
const ARM_SHARE: f64 = 0.25;
/// Below this relative difference two measures are one: float error, not
/// a stretched axis.
const SAME_MEASURE: f64 = 1e-6;

/// What a scale bar counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Measure {
    /// Physical length, in meters.
    Length,
    /// Samples of the dataset, which declares no length units.
    Samples,
}

/// One arm of a scale bar: a stretch along one axis of the screen.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Arm {
    /// The dataset's axis the arm lies along. `None` in a volume view, where
    /// the screen's axes follow no one axis of the data.
    pub axis: Option<SpatialAxis>,
    /// The CSS pixels the arm spans.
    pub pixels: f64,
    /// Its length as it reads, such as `50 µm` or `20 samples`.
    pub label: String,
}

/// What a view's scale bar shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScaleBar {
    /// The dataset it measures: the top layer the view draws.
    pub dataset_id: DatasetId,
    pub measure: Measure,
    /// Meters, or samples, per CSS pixel across the screen and down it.
    pub per_pixel: [f64; 2],
    /// The arm across the screen.
    pub across: Arm,
    /// The arm down the screen, only when that axis measures differently,
    /// as a side view of data with stretched samples does.
    pub down: Option<Arm>,
    /// The reading holds only at the depth of the arcball's orbit center:
    /// a perspective view draws nearer things larger.
    pub at_orbit_center: bool,
    /// A person scaled the dataset by hand along an axis the bar measures,
    /// so it reads the dataset's declared lengths as that scale draws them.
    pub scaled_by_hand: bool,
}

impl Scene {
    /// What `view`'s scale bar shows, or `None` when no reading would be
    /// true: no dataset drawn, a fly camera, which has no depth to read at,
    /// or a volume view of a dataset whose axes measure differently, since a
    /// turned view mixes them.
    pub fn scale_bar(&self, view: ViewId) -> Option<ScaleBar> {
        let shown = self.view(view)?;
        let dataset_id = self.scale_bar_dataset(view)?;
        let placed = self.placed(dataset_id)?;
        let sample_meters = self.derived.get(dataset_id)?.frame.sample_meters();
        let measure = match sample_meters {
            Some(_) => Measure::Length,
            None => Measure::Samples,
        };
        // What one unit of the camera's space measures along each of the
        // dataset's axes, in meters or samples. Its placement carries any
        // scale a person gave it, so the reading follows that scale.
        let per_unit = |frame_to_space: &crate::placement::Affine| -> Option<[f64; 3]> {
            let mut out = [0.0; 3];
            for (i, value) in out.iter_mut().enumerate() {
                let scale = frame_to_space.scale[i].abs();
                let sample = sample_meters.map_or(1.0, |m| m[i]);
                *value = sample / scale;
                if !value.is_finite() || *value <= 0.0 {
                    return None;
                }
            }
            Some(out)
        };
        let ratio = self.pixel_ratio.unwrap_or(1.0);
        let [width, height] = shown.camera.viewport().map(|v| f64::from(v) / ratio);
        let across_cap = arm_cap(width);
        let down_cap = arm_cap(height);
        let hand_scale = self
            .user_transform(dataset_id)
            .map_or([1.0; 3], |transform| transform.scale);
        let scaled_by_hand = |axes: &[SpatialAxis]| axes.iter().any(|a| hand_scale[a.xyz()] != 1.0);
        match &shown.camera {
            Camera::Slice(slice) => {
                // The slice zoom is device pixels per scene-frame unit.
                let units_per_pixel = ratio / slice.zoom;
                let per_unit = per_unit(&placed.to_scene)?;
                let [across_axis, down_axis, _] = slice.plane.axes();
                let across = per_unit[across_axis.xyz()] * units_per_pixel;
                let down = per_unit[down_axis.xyz()] * units_per_pixel;
                let stretched = !same(across, down);
                Some(ScaleBar {
                    dataset_id: dataset_id.clone(),
                    measure,
                    per_pixel: [across, down],
                    across: arm(measure, Some(across_axis), across, across_cap)?,
                    down: match stretched {
                        true => Some(arm(measure, Some(down_axis), down, down_cap)?),
                        false => None,
                    },
                    at_orbit_center: false,
                    scaled_by_hand: scaled_by_hand(&[across_axis, down_axis]),
                })
            }
            Camera::Arcball(arcball) => {
                let per_unit = per_unit(&placed.to_world)?;
                if !same(per_unit[0], per_unit[1]) || !same(per_unit[0], per_unit[2]) {
                    return None;
                }
                // Device pixels per world unit in the plane of the target.
                let units_per_pixel = ratio / arcball.effective_zoom();
                let length = per_unit[0] * units_per_pixel;
                Some(ScaleBar {
                    dataset_id: dataset_id.clone(),
                    measure,
                    per_pixel: [length, length],
                    across: arm(measure, None, length, across_cap)?,
                    down: None,
                    at_orbit_center: true,
                    scaled_by_hand: scaled_by_hand(&[
                        SpatialAxis::X,
                        SpatialAxis::Y,
                        SpatialAxis::Z,
                    ]),
                })
            }
            Camera::Fly(_) => None,
        }
    }

    /// The top layer `view` draws where it is drawn at all: not hidden, set
    /// aside, missed by the cut, or hidden by a blink, and with an image.
    fn scale_bar_dataset(&self, view: ViewId) -> Option<&DatasetId> {
        let shown = self.view(view)?;
        let ids: Vec<&DatasetId> = self.layer_ids().collect();
        ids.into_iter().rev().find(|id| {
            let has_image = self
                .derived
                .get(*id)
                .is_some_and(|d| d.members.iter().any(|m| !m.levels.is_empty()));
            let blinked_away = shown
                .comparison
                .as_ref()
                .and_then(|c| c.span(id))
                .is_some_and(|[from, to]| to <= from);
            has_image
                && !blinked_away
                && self.draws(view, id)
                && self
                    .resolved_layer(view, id)
                    .is_some_and(|layer| layer.visible)
                && self.layer_reach(view, id) != Some(CutReach::Outside)
        })
    }
}

/// The longest an arm may grow in a view `extent` CSS pixels long.
fn arm_cap(extent: f64) -> f64 {
    (extent * ARM_SHARE).clamp(MIN_ARM_PIXELS, MAX_ARM_PIXELS)
}

fn same(a: f64, b: f64) -> bool {
    (a - b).abs() <= SAME_MEASURE * a.abs().max(b.abs())
}

/// An arm along `axis` at `per_pixel` meters or samples per CSS pixel: the
/// longest readable length that spans no more than `cap` pixels.
fn arm(measure: Measure, axis: Option<SpatialAxis>, per_pixel: f64, cap: f64) -> Option<Arm> {
    let length = Readable::at_most(per_pixel * cap)?;
    Some(Arm {
        axis,
        pixels: length.value() / per_pixel,
        label: length.label(measure),
    })
}

/// A length of `digit × 10^exponent`, `digit` being 1, 2 or 5, the steps a
/// reader can compare and halve in their head.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Readable {
    digit: u8,
    exponent: i32,
}

/// SI lengths a label reads in, by their power of ten: steps of a thousand,
/// so a readable length always reads as 1 to 500 of one of them.
const LENGTH_UNITS: [(i32, &str); 6] = [
    (-12, "pm"),
    (-9, "nm"),
    (-6, "\u{b5}m"),
    (-3, "mm"),
    (0, "m"),
    (3, "km"),
];

/// A physical coordinate of `meters`, as `48.5 \u{b5}m`: in the SI unit that
/// puts it between 1 and 1000, with as many decimals as tell apart two
/// coordinates `resolution` meters apart. One with no length reads in the
/// unit of its resolution.
pub(crate) fn coordinate_label(meters: f64, resolution: f64) -> String {
    let magnitude = if meters.abs() > 0.0 {
        meters.abs()
    } else {
        resolution
    };
    let exponent = if magnitude.is_finite() && magnitude > 0.0 {
        magnitude.log10().floor() as i32
    } else {
        0
    };
    let (power, symbol) = LENGTH_UNITS
        .iter()
        .rev()
        .find(|(power, _)| *power <= exponent)
        .unwrap_or(&LENGTH_UNITS[0]);
    let unit = 10f64.powi(*power);
    let step = resolution / unit;
    let decimals = if step.is_finite() && step > 0.0 {
        ((-step.log10()).ceil() + 1.0).clamp(0.0, 6.0) as usize
    } else {
        0
    };
    format!("{:.*} {symbol}", decimals, meters / unit)
}

/// Lengths past these powers of ten get no bar, since no unit reads them.
const EXPONENT_RANGE: std::ops::RangeInclusive<i32> = -30..=30;

impl Readable {
    /// The largest readable length no longer than `limit`.
    fn at_most(limit: f64) -> Option<Self> {
        if !limit.is_finite() || limit <= 0.0 {
            return None;
        }
        let mut exponent = limit.log10().floor() as i32;
        let mut mantissa = limit / 10f64.powi(exponent);
        // `log10` can land a hair either side of a whole power of ten.
        if mantissa >= 10.0 {
            exponent += 1;
            mantissa /= 10.0;
        } else if mantissa < 1.0 {
            exponent -= 1;
            mantissa *= 10.0;
        }
        let mantissa = mantissa * (1.0 + 1e-9);
        let digit = if mantissa >= 5.0 {
            5
        } else if mantissa >= 2.0 {
            2
        } else {
            1
        };
        EXPONENT_RANGE
            .contains(&exponent)
            .then_some(Readable { digit, exponent })
    }

    fn value(self) -> f64 {
        f64::from(self.digit) * 10f64.powi(self.exponent)
    }

    /// How the length reads: in the SI unit that puts it between 1 and
    /// 1000, or in samples.
    fn label(self, measure: Measure) -> String {
        match measure {
            Measure::Length => {
                let (power, symbol) = LENGTH_UNITS
                    .iter()
                    .rev()
                    .find(|(power, _)| *power <= self.exponent)
                    .unwrap_or(&LENGTH_UNITS[0]);
                format!("{} {symbol}", decimal(self.digit, self.exponent - power))
            }
            Measure::Samples => {
                let noun = if self.digit == 1 && self.exponent == 0 {
                    "sample"
                } else {
                    "samples"
                };
                format!("{} {noun}", decimal(self.digit, self.exponent))
            }
        }
    }
}

/// `digit × 10^exponent` written out exactly, as `500` or `0.02`.
fn decimal(digit: u8, exponent: i32) -> String {
    if exponent >= 0 {
        format!("{digit}{}", "0".repeat(exponent as usize))
    } else {
        format!("0.{}{digit}", "0".repeat((-exponent - 1) as usize))
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::PhysicalSpace;

    use super::super::test_helpers::make_dataset_opened_with_shape;
    use super::*;
    use crate::command::{DocumentCommand, ViewportCommand};
    use crate::mat4::{cross3, normalize3};
    use crate::slice_plane::SlicePlane;
    use crate::view::ViewLayout;

    /// A single image of `shape` `[z, y, x]` samples, each `spacing` `[z, y,
    /// x]` long in `unit`, or in no unit.
    fn open(scene: &mut Scene, id: &str, shape: [u64; 3], spacing: [f64; 3], unit: Option<&str>) {
        let mut opened = make_dataset_opened_with_shape(
            id,
            id,
            1,
            [1, 1, shape[0], shape[1], shape[2]],
            [1, 1, 16, 64, 64],
            1,
        );
        for image in opened.manifest.images_mut() {
            image.multiscale.levels[0].scale = [1.0, 1.0, spacing[0], spacing[1], spacing[2]];
        }
        let unit = unit.map(str::to_string);
        opened.manifest = opened.manifest.with_space(PhysicalSpace {
            units: [unit.clone(), unit.clone(), unit],
            origin: [0.0; 3],
        });
        scene.apply(DocumentCommand::DatasetOpened(opened).into());
    }

    fn apply(scene: &mut Scene, command: ViewportCommand) {
        scene.apply(command.into());
    }

    /// A canvas of 800 by 600 CSS pixels at `ratio`.
    fn scene_at(ratio: f64) -> Scene {
        let size = [(800.0 * ratio) as u32, (600.0 * ratio) as u32];
        let mut scene = Scene::new(size);
        apply(
            &mut scene,
            ViewportCommand::SetViewport {
                width: size[0],
                height: size[1],
                pixel_ratio: Some(ratio),
            },
        );
        scene
    }

    fn set_zoom(scene: &mut Scene, zoom: f64) {
        if let Camera::Slice(slice) = &mut scene.active_view_mut().camera {
            slice.set_zoom(zoom);
        }
    }

    fn bar(scene: &Scene) -> ScaleBar {
        scene.scale_bar(scene.active_view().id()).expect("a bar")
    }

    #[test]
    fn readable_lengths_step_one_two_five() {
        let read = |limit: f64| {
            let r = Readable::at_most(limit).unwrap();
            (r.digit, r.exponent)
        };
        assert_eq!(read(1.0), (1, 0));
        assert_eq!(read(1.99), (1, 0));
        assert_eq!(read(2.0), (2, 0));
        assert_eq!(read(4.99), (2, 0));
        assert_eq!(read(5.0), (5, 0));
        assert_eq!(read(1000.0), (1, 3));
        assert_eq!(read(0.03), (2, -2));
        assert_eq!(read(1e-3), (1, -3));
        assert_eq!(Readable::at_most(0.0), None);
        assert_eq!(Readable::at_most(f64::NAN), None);
        assert_eq!(Readable::at_most(1e40), None);
    }

    #[test]
    fn a_length_reads_in_the_unit_that_puts_it_between_one_and_a_thousand() {
        let label = |digit, exponent| Readable { digit, exponent }.label(Measure::Length);
        assert_eq!(label(5, -5), "50 \u{b5}m");
        assert_eq!(label(2, -4), "200 \u{b5}m");
        assert_eq!(label(1, -3), "1 mm");
        assert_eq!(label(5, -10), "500 pm");
        assert_eq!(label(2, -9), "2 nm");
        assert_eq!(label(1, 4), "10 km");
        assert_eq!(label(5, -14), "0.05 pm");
        let samples = |digit, exponent| Readable { digit, exponent }.label(Measure::Samples);
        assert_eq!(samples(1, 0), "1 sample");
        assert_eq!(samples(5, -1), "0.5 samples");
        assert_eq!(samples(2, 2), "200 samples");
    }

    #[test]
    fn a_slice_view_reads_the_physical_length_of_its_pixels_at_any_ratio() {
        for ratio in [1.0, 2.0] {
            let mut scene = scene_at(ratio);
            open(
                &mut scene,
                "a",
                [1, 256, 256],
                [1.0, 0.5, 0.5],
                Some("micrometer"),
            );
            // Two device pixels per sample: a CSS pixel is 0.25 µm at ratio 1,
            // and at ratio 2 the same CSS size shows 0.5 µm per CSS pixel.
            set_zoom(&mut scene, 2.0);
            let bar = bar(&scene);
            let per_pixel = 0.5e-6 * ratio / 2.0;
            assert!((bar.per_pixel[0] - per_pixel).abs() < 1e-15, "{bar:?}");
            assert_eq!(bar.measure, Measure::Length);
            assert_eq!(bar.down, None);
            assert!(!bar.at_orbit_center);
            // The arm is as long on screen as the length its label names.
            let expected = if ratio == 1.0 {
                (20e-6, "20 \u{b5}m")
            } else {
                (50e-6, "50 \u{b5}m")
            };
            assert_eq!(bar.across.label, expected.1);
            assert!((bar.across.pixels - expected.0 / per_pixel).abs() < 1e-9);
            assert!(bar.across.pixels <= MAX_ARM_PIXELS);
        }
    }

    #[test]
    fn views_of_datasets_with_different_sample_sizes_agree() {
        let mut scene = scene_at(1.0);
        open(
            &mut scene,
            "fine",
            [1, 256, 256],
            [1.0, 0.5, 0.5],
            Some("micrometer"),
        );
        open(
            &mut scene,
            "coarse",
            [1, 128, 128],
            [1.0, 1.0, 1.0],
            Some("micrometer"),
        );
        apply(
            &mut scene,
            ViewportCommand::SetViewLayout {
                layout: ViewLayout::Columns,
            },
        );
        let [left, right] = [scene.views()[0].id(), scene.views()[1].id()];
        for (view, id) in [(left, "fine"), (right, "coarse")] {
            apply(&mut scene, ViewportCommand::SetActiveView { view });
            apply(
                &mut scene,
                ViewportCommand::SetViewDatasets {
                    view,
                    datasets: crate::view::ViewDatasets::Only(vec![DatasetId::from(id)]),
                },
            );
            set_zoom(&mut scene, 1.5);
        }
        let left_bar = scene.scale_bar(left).unwrap();
        let right_bar = scene.scale_bar(right).unwrap();
        assert_eq!(left_bar.dataset_id, DatasetId::from("fine"));
        assert_eq!(right_bar.dataset_id, DatasetId::from("coarse"));
        assert!((left_bar.per_pixel[0] - right_bar.per_pixel[0]).abs() < 1e-18);
        assert_eq!(left_bar.across, right_bar.across);
    }

    #[test]
    fn a_side_view_of_stretched_samples_reads_each_axis() {
        // No units, and Z samples four times as long as X and Y: the side
        // view draws Z four times as tall, so a pixel down holds a quarter
        // of the samples a pixel across does.
        let mut scene = scene_at(1.0);
        open(&mut scene, "a", [64, 256, 256], [4.0, 1.0, 1.0], None);
        scene.set_slice_plane(SlicePlane::Xz);
        set_zoom(&mut scene, 1.0);
        let bar = bar(&scene);
        assert_eq!(bar.measure, Measure::Samples);
        assert_eq!(bar.per_pixel, [1.0, 0.25]);
        assert_eq!(bar.across.axis, Some(SpatialAxis::X));
        assert_eq!(bar.across.label, "100 samples");
        assert_eq!(bar.across.pixels, 100.0);
        let down = bar.down.expect("a down arm");
        assert_eq!(down.axis, Some(SpatialAxis::Z));
        assert_eq!(down.label, "20 samples");
        assert_eq!(down.pixels, 80.0);
    }

    #[test]
    fn a_side_view_of_physical_lengths_reads_one_length() {
        let mut scene = scene_at(1.0);
        open(
            &mut scene,
            "a",
            [64, 256, 256],
            [2.0, 0.5, 0.5],
            Some("micrometer"),
        );
        scene.set_slice_plane(SlicePlane::Yz);
        set_zoom(&mut scene, 1.0);
        let bar = bar(&scene);
        assert_eq!(bar.down, None);
        assert_eq!(bar.across.axis, Some(SpatialAxis::Y));
        assert_eq!(bar.across.label, "50 \u{b5}m");
    }

    #[test]
    fn the_top_drawn_layer_is_measured() {
        let mut scene = scene_at(1.0);
        open(
            &mut scene,
            "under",
            [1, 64, 64],
            [1.0, 1.0, 1.0],
            Some("micrometer"),
        );
        open(&mut scene, "over", [1, 64, 64], [1.0, 1.0, 1.0], None);
        let view = scene.active_view().id();
        assert_eq!(
            scene.scale_bar(view).unwrap().dataset_id,
            DatasetId::from("over")
        );
        scene.apply(
            crate::command::ViewportCommand::SetDatasetVisible {
                dataset_id: "over".into(),
                visible: false,
            }
            .into(),
        );
        assert_eq!(
            scene.scale_bar(view).unwrap().dataset_id,
            DatasetId::from("under")
        );
    }

    #[test]
    fn a_volume_view_reads_at_the_orbit_center_when_every_axis_agrees() {
        let mut scene = scene_at(2.0);
        open(
            &mut scene,
            "a",
            [64, 256, 256],
            [2.0, 0.5, 0.5],
            Some("micrometer"),
        );
        scene.set_mode_3d();
        let bar = bar(&scene);
        assert!(bar.at_orbit_center);
        assert_eq!(bar.down, None);
        let camera = &scene.active_view().camera;
        let Camera::Arcball(arcball) = camera else {
            panic!("an arcball");
        };
        // A stretch across the screen at the orbit center projects to as
        // many CSS pixels as the bar says. World space divides lengths by
        // the largest extent, 128 µm here.
        let right = normalize3(cross3(arcball.forward_direction(), arcball.up_vector()));
        let world = 0.1;
        let end: [f64; 3] = std::array::from_fn(|i| arcball.target[i] + right[i] * world);
        let [from, to] = [arcball.target, end].map(|p| camera.project_to_screen(p).unwrap());
        let css = (to[0] - from[0]).hypot(to[1] - from[1]) / 2.0;
        let per_pixel = world * 128e-6 / css;
        assert!(
            (bar.per_pixel[0] - per_pixel).abs() < 1e-9 * per_pixel,
            "{bar:?}"
        );
        scene.set_mode_fly();
        assert_eq!(scene.scale_bar(scene.active_view().id()), None);
    }

    #[test]
    fn a_dataset_scaled_by_hand_reads_its_lengths_as_drawn_and_says_so() {
        let mut scene = scene_at(1.0);
        open(
            &mut scene,
            "a",
            [64, 256, 256],
            [2.0, 0.5, 0.5],
            Some("micrometer"),
        );
        set_zoom(&mut scene, 1.0);
        let before = bar(&scene);
        assert!(!before.scaled_by_hand);
        // Twice as tall on Z only: an XY view measures nothing it changed.
        let z_only = crate::placement::UserTransform {
            scale: [1.0, 1.0, 2.0],
            ..crate::placement::UserTransform::IDENTITY
        };
        scene
            .document
            .set_user_transform(DatasetId::from("a"), z_only);
        assert_eq!(bar(&scene), before);
        // Twice as wide and tall: a pixel shows half the length it did.
        let doubled = crate::placement::UserTransform {
            scale: [2.0, 2.0, 1.0],
            ..crate::placement::UserTransform::IDENTITY
        };
        scene
            .document
            .set_user_transform(DatasetId::from("a"), doubled);
        let after = bar(&scene);
        assert!(after.scaled_by_hand);
        assert!((after.per_pixel[0] - before.per_pixel[0] / 2.0).abs() < 1e-18);
    }

    #[test]
    fn a_volume_view_of_stretched_samples_shows_no_bar() {
        let mut scene = scene_at(1.0);
        open(&mut scene, "a", [64, 256, 256], [4.0, 1.0, 1.0], None);
        scene.set_mode_3d();
        assert_eq!(scene.scale_bar(scene.active_view().id()), None);
    }

    #[test]
    fn a_view_with_nothing_drawn_shows_no_bar() {
        let scene = scene_at(1.0);
        assert_eq!(scene.scale_bar(scene.active_view().id()), None);
    }
}
