//! A viewer profile is a view the server keeps for a client that holds no live
//! viewer, such as the CLI or the Python client. [`ProfileScene`] opens one
//! over the workspace document and changes it the way the viewer's controls
//! would, so every such client gets the same clamps, defaults and framing.

use std::fmt;

use indexmap::IndexMap;
use lucida_content::{DatasetId, LayoutId};

use crate::camera::Camera;
use crate::command::{Command, ViewportCommand};
use crate::saved_view::{SAVED_VIEW_VERSION, SavedView};
use crate::scene::{DocumentState, Scene};

/// The canvas a view is framed for when no client has reported one.
pub const FITTED_VIEWPORT: [u32; 2] = [1440, 900];

/// A stored view opened over the document it addresses.
#[derive(Debug, Clone)]
pub struct ProfileScene {
    pub scene: Scene,
    /// Per-dataset auto-contrast. The web client keeps it outside the scene,
    /// and a page that opens this view refits every dataset not marked
    /// `false`, which would undo a hand-set contrast.
    auto_contrast: IndexMap<DatasetId, bool>,
}

impl ProfileScene {
    /// Open `view` over `document`. Datasets the view does not mention take
    /// the settings a freshly opened dataset gets, and entries for datasets
    /// the document no longer holds are dropped.
    pub fn open(document: &DocumentState, view: &SavedView) -> Self {
        let mut scene = Scene::new(view.camera.viewport());
        scene.camera = view.camera.clone();
        // A stored camera must not hand the scene a state its own mutators
        // could never produce.
        scene.camera.sanitize();
        scene.view = view.view.clone();
        scene.display = view.display.clone();
        scene.dataset_order = view.dataset_order.clone();
        scene.dataset_settings = view.dataset_settings.clone().into_iter().collect();
        scene.load_document(document.clone());
        let auto_contrast = view
            .auto_contrast
            .iter()
            .filter(|(id, _)| document.manifests.contains_key(*id))
            .map(|(id, on)| (id.clone(), *on))
            .collect();
        Self {
            scene,
            auto_contrast,
        }
    }

    /// The view a new profile starts from when the workspace names no default
    /// saved view: the visible datasets framed in 2D at [`FITTED_VIEWPORT`],
    /// or the blank camera when nothing is visible.
    pub fn fitted(document: &DocumentState) -> Self {
        let mut scene = Scene::new(FITTED_VIEWPORT);
        scene.load_document(document.clone());
        // An empty workspace has nothing to frame and keeps the blank camera.
        let _ = scene.frame_visible_2d(FITTED_VIEWPORT);
        Self::from(scene)
    }

    /// Apply `command` as the viewer's controls would.
    ///
    /// A 3D camera command switches the camera into the mode it drives, as
    /// the viewer's own 3D controls do. A 2D camera command on a 3D camera is
    /// refused rather than dropped, so a caller never reads an unchanged view
    /// as a moved one. Indices are checked against the visible datasets and
    /// values against what the controls can produce, and nothing changes when
    /// a check fails.
    pub fn apply(&mut self, command: ViewportCommand) -> Result<(), ProfileCommandError> {
        self.check(&command)?;
        match &command {
            ViewportCommand::Rotate3D { .. }
            | ViewportCommand::Zoom3D { .. }
            | ViewportCommand::Pan3D { .. } => {
                self.scene
                    .apply(Command::Viewport(ViewportCommand::SetMode3D));
            }
            ViewportCommand::FlyTick { .. } => {
                self.scene
                    .apply(Command::Viewport(ViewportCommand::SetModeFly));
            }
            ViewportCommand::SetChannelContrast { dataset_id, .. }
            | ViewportCommand::SetDatasetContrast { dataset_id, .. } => {
                // A hand-set limit stops auto-contrast for the dataset, as it
                // does in the viewer.
                self.auto_contrast
                    .insert(DatasetId(dataset_id.clone()), false);
            }
            _ => {}
        }
        let command = match command {
            ViewportCommand::SetDatasetOrder { order } => ViewportCommand::SetDatasetOrder {
                order: self.completed_order(order),
            },
            other => other,
        };
        self.scene.apply(Command::Viewport(command));
        Ok(())
    }

    /// The stored form of this view. It addresses datasets by workspace id
    /// and carries no source URLs.
    pub fn saved_view(&self) -> SavedView {
        let scene = &self.scene;
        SavedView {
            v: SAVED_VIEW_VERSION,
            datasets: Vec::new(),
            active_layouts: active_layouts(&scene.document),
            camera: scene.camera.clone(),
            view: scene.view.clone(),
            display: scene.display.clone(),
            dataset_order: scene.dataset_order.clone(),
            // In layer order, so the same view always serializes the same.
            dataset_settings: scene
                .dataset_order
                .iter()
                .filter_map(|id| {
                    let settings = scene.dataset_settings.get(id)?;
                    Some((id.clone(), settings.clone()))
                })
                .collect(),
            auto_contrast: self.auto_contrast.clone(),
        }
    }

    /// `order` first, then every dataset it leaves out, in their current
    /// order, so naming one dataset raises it without dropping the rest.
    fn completed_order(&self, order: Vec<String>) -> Vec<String> {
        let mut completed: Vec<String> = Vec::with_capacity(self.scene.dataset_order.len());
        for id in order
            .into_iter()
            .chain(self.scene.dataset_order.iter().map(|id| id.0.clone()))
        {
            if !completed.contains(&id) {
                completed.push(id);
            }
        }
        completed
    }

    fn check(&self, command: &ViewportCommand) -> Result<(), ProfileCommandError> {
        use ProfileCommandError as E;
        let scene = &self.scene;
        let moves_slice_camera = matches!(
            command,
            ViewportCommand::Pan { .. }
                | ViewportCommand::ZoomBy { .. }
                | ViewportCommand::SetCenter { .. }
                | ViewportCommand::SetZoom { .. }
        );
        if moves_slice_camera && !matches!(scene.camera, Camera::Slice(_)) {
            return Err(E::NeedsSliceCamera {
                mode: camera_mode_name(&scene.camera),
            });
        }
        if !command.inputs_finite() {
            return Err(E::InvalidValue("every number must be finite".into()));
        }
        match command {
            ViewportCommand::ZoomBy { factor } if *factor <= 0.0 => {
                return Err(E::InvalidValue("zoom factor must be positive".into()));
            }
            ViewportCommand::SetZoom { value } if *value <= 0.0 => {
                return Err(E::InvalidValue("zoom must be positive".into()));
            }
            ViewportCommand::SetViewport { width, height, .. } if *width == 0 || *height == 0 => {
                return Err(E::InvalidValue(
                    "viewport width and height must be positive".into(),
                ));
            }
            ViewportCommand::FlyTick { dt, .. } if *dt < 0.0 => {
                return Err(E::InvalidValue("fly tick dt must be non-negative".into()));
            }
            ViewportCommand::SetZRange { start, end } if end <= start => {
                return Err(E::InvalidValue(
                    "Z range end must be greater than start".into(),
                ));
            }
            ViewportCommand::SetContrast { min, max }
            | ViewportCommand::SetDatasetContrast { min, max, .. }
            | ViewportCommand::SetChannelContrast { min, max, .. }
                if max <= min =>
            {
                return Err(E::InvalidValue(
                    "contrast max must be greater than min".into(),
                ));
            }
            ViewportCommand::SetGamma { gamma }
            | ViewportCommand::SetDatasetGamma { gamma, .. }
            | ViewportCommand::SetChannelGamma { gamma, .. }
                if *gamma <= 0.0 =>
            {
                return Err(E::InvalidValue("gamma must be positive".into()));
            }
            ViewportCommand::SetDatasetOpacity { opacity, .. }
                if !(0.0..=1.0).contains(opacity) =>
            {
                return Err(E::InvalidValue("opacity must be between 0 and 1".into()));
            }
            _ => {}
        }
        if let Some(bounds) = visible_index_bounds(scene) {
            match command {
                ViewportCommand::SetZ { z } if *z >= bounds.z => {
                    return Err(E::IndexOutOfRange {
                        axis: 'Z',
                        requested: *z,
                        count: bounds.z,
                    });
                }
                ViewportCommand::SetZRange { start, end }
                    if *start >= bounds.z || *end > bounds.z =>
                {
                    return Err(E::ZRangeOutOfRange {
                        start: *start,
                        end: *end,
                        count: bounds.z,
                    });
                }
                ViewportCommand::SetT { t } if *t >= bounds.t => {
                    return Err(E::IndexOutOfRange {
                        axis: 'T',
                        requested: *t,
                        count: bounds.t,
                    });
                }
                _ => {}
            }
        }
        match command {
            ViewportCommand::SetDatasetOrder { order } => {
                for id in order {
                    self.known_dataset(id)?;
                }
            }
            ViewportCommand::SetDatasetVisible { dataset_id, .. }
            | ViewportCommand::SetDatasetOpacity { dataset_id, .. }
            | ViewportCommand::SetDatasetContrast { dataset_id, .. }
            | ViewportCommand::SetDatasetGamma { dataset_id, .. }
            | ViewportCommand::SetDatasetBlendMode { dataset_id, .. }
            | ViewportCommand::SetDatasetRenderMode { dataset_id, .. }
            | ViewportCommand::SetDatasetDetailLevelOverride { dataset_id, .. }
            | ViewportCommand::SetChannelBlendMode { dataset_id, .. }
            | ViewportCommand::CenterOnVoxel3D { dataset_id, .. } => {
                self.known_dataset(dataset_id)?;
            }
            ViewportCommand::SetChannelSolo {
                dataset_id,
                channel,
            } => {
                let manifest = self.known_dataset(dataset_id)?;
                if let Some(channel) = channel {
                    check_channel(manifest, dataset_id, *channel)?;
                }
            }
            ViewportCommand::SetChannelVisible {
                dataset_id,
                channel,
                ..
            }
            | ViewportCommand::SetChannelColormap {
                dataset_id,
                channel,
                ..
            }
            | ViewportCommand::SetChannelName {
                dataset_id,
                channel,
                ..
            }
            | ViewportCommand::SetChannelContrast {
                dataset_id,
                channel,
                ..
            }
            | ViewportCommand::SetChannelGamma {
                dataset_id,
                channel,
                ..
            } => {
                let manifest = self.known_dataset(dataset_id)?;
                check_channel(manifest, dataset_id, *channel)?;
            }
            ViewportCommand::SetLabelVisible {
                dataset_id, label, ..
            }
            | ViewportCommand::SetLabelOpacity {
                dataset_id, label, ..
            } => {
                let manifest = self.known_dataset(dataset_id)?;
                let count = manifest.label_specs().len().min(u32::MAX as usize) as u32;
                if *label >= count {
                    return Err(E::LabelOutOfRange {
                        dataset_id: dataset_id.clone(),
                        requested: *label,
                        count,
                    });
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn known_dataset(
        &self,
        dataset_id: &str,
    ) -> Result<&lucida_content::DatasetManifest, ProfileCommandError> {
        self.scene
            .document
            .manifests
            .get(&DatasetId(dataset_id.to_string()))
            .ok_or_else(|| ProfileCommandError::UnknownDataset(dataset_id.to_string()))
    }
}

impl From<Scene> for ProfileScene {
    /// A scene with no stored auto-contrast, such as one rebuilt from a live
    /// client's presence.
    fn from(scene: Scene) -> Self {
        Self {
            scene,
            auto_contrast: IndexMap::new(),
        }
    }
}

/// Why [`ProfileScene::apply`] refused a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileCommandError {
    /// A 2D camera command while the camera is 3D.
    NeedsSliceCamera {
        mode: &'static str,
    },
    /// A value the viewer's controls cannot produce.
    InvalidValue(String),
    /// A Z or T index past the largest count among the visible datasets.
    IndexOutOfRange {
        axis: char,
        requested: u32,
        count: u32,
    },
    ZRangeOutOfRange {
        start: u32,
        end: u32,
        count: u32,
    },
    UnknownDataset(String),
    NoChannels(String),
    ChannelOutOfRange {
        dataset_id: String,
        requested: u32,
        count: u32,
    },
    LabelOutOfRange {
        dataset_id: String,
        requested: u32,
        count: u32,
    },
}

impl ProfileCommandError {
    /// Whether the command names a dataset, channel or label the workspace
    /// lacks, as against asking for a value or mode that is never valid.
    pub fn is_missing_resource(&self) -> bool {
        matches!(
            self,
            Self::UnknownDataset(_)
                | Self::NoChannels(_)
                | Self::ChannelOutOfRange { .. }
                | Self::LabelOutOfRange { .. }
        )
    }
}

impl fmt::Display for ProfileCommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NeedsSliceCamera { mode } => write!(
                f,
                "this command moves the 2D slice camera, and the camera is {mode}; \
                 switch to slice mode or use the {mode} camera commands"
            ),
            Self::InvalidValue(message) => f.write_str(message),
            Self::IndexOutOfRange {
                axis,
                requested,
                count,
            } => write!(
                f,
                "visible datasets have {count} {axis} value(s); requested {axis} index {requested}"
            ),
            Self::ZRangeOutOfRange { start, end, count } => write!(
                f,
                "visible datasets have {count} Z plane(s); requested Z range {start}..{end}"
            ),
            Self::UnknownDataset(id) => write!(f, "the workspace holds no dataset {id:?}"),
            Self::NoChannels(id) => write!(f, "dataset {id:?} has no image channel metadata"),
            Self::ChannelOutOfRange {
                dataset_id,
                requested,
                count,
            } => write!(
                f,
                "dataset {dataset_id:?} has {count} channels; channel {requested} was requested"
            ),
            Self::LabelOutOfRange {
                dataset_id,
                requested,
                count,
            } => write!(
                f,
                "dataset {dataset_id:?} has {count} labels; label {requested} was requested"
            ),
        }
    }
}

impl std::error::Error for ProfileCommandError {}

/// Why [`Scene::frame_visible_2d`] could not frame the view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    EmptyViewport,
    NothingVisible,
    DegenerateExtent,
}

impl FrameError {
    pub fn is_missing_resource(&self) -> bool {
        !matches!(self, Self::EmptyViewport)
    }
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::EmptyViewport => "overview viewport must be positive",
            Self::NothingVisible => "no visible image dataset is available for overview",
            Self::DegenerateExtent => "visible image dataset has invalid XY dimensions",
        })
    }
}

impl std::error::Error for FrameError {}

impl Scene {
    /// Frame every visible image in a 2D camera on a `viewport` canvas, at the
    /// middle Z plane.
    pub fn frame_visible_2d(&mut self, viewport: [u32; 2]) -> Result<(), FrameError> {
        if viewport[0] == 0 || viewport[1] == 0 {
            return Err(FrameError::EmptyViewport);
        }
        let bounds = self
            .visible_content_bounds_2d()
            .ok_or(FrameError::NothingVisible)?;
        let width = bounds.width();
        let height = bounds.height();
        if width <= 0.0 || height <= 0.0 {
            return Err(FrameError::DegenerateExtent);
        }

        let zoom_x = viewport[0] as f64 / width;
        let zoom_y = viewport[1] as f64 / height;
        let zoom = zoom_x.min(zoom_y).max(f64::EPSILON) * 0.9;
        for command in [
            ViewportCommand::SetMode2D,
            ViewportCommand::SetViewport {
                width: viewport[0],
                height: viewport[1],
                pixel_ratio: None,
            },
            ViewportCommand::SetCenter {
                x: bounds.center_x(),
                y: bounds.center_y(),
            },
            ViewportCommand::SetZoom { value: zoom },
            ViewportCommand::SetZ {
                z: bounds.max_depth.saturating_sub(1) / 2,
            },
        ] {
            self.apply(Command::Viewport(command));
        }
        Ok(())
    }
}

fn camera_mode_name(camera: &Camera) -> &'static str {
    match camera {
        Camera::Slice(_) => "slice",
        Camera::Arcball(_) => "arcball",
        Camera::Fly(_) => "fly",
    }
}

/// The layout each dataset shows: the active one, else the manifest default,
/// else its first source layout.
fn active_layouts(document: &DocumentState) -> IndexMap<DatasetId, LayoutId> {
    document
        .manifests
        .iter()
        .filter_map(|(dataset_id, manifest)| {
            let layout = document
                .active_layout_ids
                .get(dataset_id)
                .or(manifest.default_layout_id.as_ref())
                .or_else(|| manifest.source_layouts().first().map(|layout| &layout.id))?;
            Some((dataset_id.clone(), layout.clone()))
        })
        .collect()
}

fn check_channel(
    manifest: &lucida_content::DatasetManifest,
    dataset_id: &str,
    channel: u32,
) -> Result<(), ProfileCommandError> {
    let count = manifest
        .images()
        .first()
        .and_then(|image| image.multiscale.levels.first())
        .map(|level| saturating_count(level.shape[1]))
        .ok_or_else(|| ProfileCommandError::NoChannels(dataset_id.to_string()))?;
    if channel >= count {
        return Err(ProfileCommandError::ChannelOutOfRange {
            dataset_id: dataset_id.to_string(),
            requested: channel,
            count,
        });
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct IndexBounds {
    t: u32,
    z: u32,
}

/// The deepest T and Z counts among the visible datasets. Each layer clamps
/// the scene's index into its own extent and says so, so only an index no
/// layer reaches is refused. `None` when nothing visible has image data.
fn visible_index_bounds(scene: &Scene) -> Option<IndexBounds> {
    let mut bounds: Option<IndexBounds> = None;
    for id in &scene.dataset_order {
        let visible = scene.dataset_settings.get(id).is_none_or(|s| s.visible);
        if !visible {
            continue;
        }
        let Some(level) = scene
            .document
            .manifests
            .get(id)
            .and_then(|manifest| manifest.images().first())
            .and_then(|image| image.multiscale.levels.first())
        else {
            continue;
        };
        let current = IndexBounds {
            t: saturating_count(level.shape[0]),
            z: saturating_count(level.shape[2]),
        };
        bounds = Some(match bounds {
            Some(existing) => IndexBounds {
                t: existing.t.max(current.t),
                z: existing.z.max(current.z),
            },
            None => current,
        });
    }
    bounds
}

fn saturating_count(value: u64) -> u32 {
    value.min(u32::MAX as u64) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::DocumentCommand;
    use crate::scene::test_helpers::{
        make_dataset_opened_with_labels, make_dataset_opened_with_shape,
    };
    use crate::scene::{Colormap, LabelSettings};

    fn document() -> DocumentState {
        let mut document = DocumentState::default();
        document.apply(DocumentCommand::DatasetOpened(
            make_dataset_opened_with_shape(
                "wds-a",
                "a.zarr",
                3,
                [2, 3, 40, 512, 256],
                [1, 1, 16, 64, 64],
                1,
            ),
        ));
        document
    }

    fn opened() -> ProfileScene {
        ProfileScene::fitted(&document())
    }

    #[test]
    fn a_fitted_view_frames_the_visible_datasets_at_the_fitted_canvas() {
        let profile = opened();
        let Camera::Slice(slice) = &profile.scene.camera else {
            panic!("expected a slice camera, got {:?}", profile.scene.camera);
        };
        assert_eq!(slice.viewport, FITTED_VIEWPORT);
        assert_eq!(slice.center, [128.0, 256.0]);
        let limiting = FITTED_VIEWPORT[1] as f64 / 512.0;
        assert!((slice.zoom - limiting * 0.9).abs() < 1e-12);
        assert_eq!(profile.scene.view.z_range, 19..20);
    }

    #[test]
    fn opening_a_view_seeds_unmentioned_datasets_with_the_open_defaults() {
        let view = SavedView::empty([800, 600]);
        let profile = ProfileScene::open(&document(), &view);
        let settings = &profile.scene.dataset_settings[&DatasetId("wds-a".into())];
        let colormaps: Vec<_> = settings
            .channel_settings
            .iter()
            .map(|c| c.colormap)
            .collect();
        assert_eq!(
            colormaps,
            vec![Colormap::Magenta, Colormap::Green, Colormap::Cyan]
        );
        assert_eq!(profile.scene.dataset_order, vec![DatasetId("wds-a".into())]);
    }

    #[test]
    fn opening_a_view_seeds_labels_with_their_names() {
        let mut document = DocumentState::default();
        document.apply(DocumentCommand::DatasetOpened(
            make_dataset_opened_with_labels("wds-l", "l.zarr", 1, 2),
        ));
        let profile = ProfileScene::open(&document, &SavedView::empty([800, 600]));
        let settings = &profile.scene.dataset_settings[&DatasetId("wds-l".into())];
        assert_eq!(settings.label_names, vec!["label-0", "label-1"]);
        assert_eq!(settings.label_settings, vec![LabelSettings::default(); 2]);
    }

    #[test]
    fn opening_drops_datasets_the_document_no_longer_holds() {
        let mut view = opened().saved_view();
        view.dataset_order.push(DatasetId("wds-gone".into()));
        view.auto_contrast
            .insert(DatasetId("wds-gone".into()), false);
        let profile = ProfileScene::open(&document(), &view);
        assert_eq!(profile.scene.dataset_order, vec![DatasetId("wds-a".into())]);
        assert!(profile.saved_view().auto_contrast.is_empty());
    }

    #[test]
    fn a_pan_goes_through_the_core_clamps() {
        let mut profile = opened();
        profile
            .apply(ViewportCommand::SetZoom { value: 1.0 })
            .unwrap();
        profile
            .apply(ViewportCommand::Pan { dx: 1e300, dy: 0.0 })
            .unwrap();
        let Camera::Slice(slice) = &profile.scene.camera else {
            panic!("expected a slice camera");
        };
        assert!(slice.center[0].is_finite());
    }

    #[test]
    fn a_3d_command_switches_the_camera_into_arcball() {
        let mut profile = opened();
        profile
            .apply(ViewportCommand::Rotate3D {
                d_theta: 0.5,
                d_phi: 0.0,
            })
            .unwrap();
        assert!(matches!(profile.scene.camera, Camera::Arcball(_)));
    }

    #[test]
    fn a_2d_camera_command_on_a_3d_camera_is_refused_and_changes_nothing() {
        let mut profile = opened();
        profile.apply(ViewportCommand::SetMode3D).unwrap();
        let before = profile.saved_view();
        let error = profile
            .apply(ViewportCommand::Pan { dx: 4.0, dy: 0.0 })
            .unwrap_err();
        assert_eq!(
            error,
            ProfileCommandError::NeedsSliceCamera { mode: "arcball" }
        );
        assert_eq!(profile.saved_view(), before);
    }

    #[test]
    fn indices_are_checked_against_the_visible_datasets() {
        let mut profile = opened();
        assert!(profile.apply(ViewportCommand::SetZ { z: 39 }).is_ok());
        let error = profile.apply(ViewportCommand::SetZ { z: 40 }).unwrap_err();
        assert!(!error.is_missing_resource());
        assert_eq!(
            error.to_string(),
            "visible datasets have 40 Z value(s); requested Z index 40"
        );
        assert!(profile.apply(ViewportCommand::SetT { t: 2 }).is_err());
        assert!(
            profile
                .apply(ViewportCommand::SetZRange { start: 30, end: 41 })
                .is_err()
        );
    }

    #[test]
    fn a_channel_past_the_dataset_s_count_is_a_missing_resource() {
        let mut profile = opened();
        let error = profile
            .apply(ViewportCommand::SetChannelVisible {
                dataset_id: "wds-a".into(),
                channel: 3,
                visible: false,
            })
            .unwrap_err();
        assert!(error.is_missing_resource());
        let settings = &profile.scene.dataset_settings[&DatasetId("wds-a".into())];
        assert_eq!(settings.channel_settings.len(), 3);
    }

    #[test]
    fn a_solo_past_the_layer_s_channels_is_a_missing_resource() {
        let mut profile = opened();
        let solo = |channel| ViewportCommand::SetChannelSolo {
            dataset_id: "wds-a".into(),
            channel,
        };
        assert!(
            profile
                .apply(solo(Some(3)))
                .unwrap_err()
                .is_missing_resource()
        );
        profile.apply(solo(Some(2))).unwrap();
        profile.apply(solo(None)).unwrap();
        let settings = &profile.scene.dataset_settings[&DatasetId("wds-a".into())];
        assert_eq!(settings.solo, None);
    }

    #[test]
    fn an_index_any_visible_layer_reaches_is_accepted() {
        let mut document = document();
        document.apply(DocumentCommand::DatasetOpened(
            make_dataset_opened_with_shape(
                "wds-b",
                "b.zarr",
                1,
                [5, 1, 4, 64, 64],
                [1, 1, 4, 64, 64],
                1,
            ),
        ));
        let mut profile = ProfileScene::fitted(&document);
        assert!(profile.apply(ViewportCommand::SetZ { z: 39 }).is_ok());
        assert!(profile.apply(ViewportCommand::SetT { t: 4 }).is_ok());
        assert!(profile.apply(ViewportCommand::SetT { t: 5 }).is_err());
    }

    #[test]
    fn an_unknown_dataset_is_a_missing_resource() {
        let error = opened()
            .apply(ViewportCommand::SetDatasetVisible {
                dataset_id: "wds-missing".into(),
                visible: false,
            })
            .unwrap_err();
        assert!(error.is_missing_resource());
    }

    #[test]
    fn values_the_controls_cannot_produce_are_refused() {
        let mut profile = opened();
        for command in [
            ViewportCommand::ZoomBy { factor: 0.0 },
            ViewportCommand::SetDatasetOpacity {
                dataset_id: "wds-a".into(),
                opacity: 1.5,
            },
            ViewportCommand::SetChannelGamma {
                dataset_id: "wds-a".into(),
                channel: 0,
                gamma: 0.0,
            },
            ViewportCommand::SetChannelContrast {
                dataset_id: "wds-a".into(),
                channel: 0,
                min: 10.0,
                max: 10.0,
            },
        ] {
            let error = profile.apply(command).unwrap_err();
            assert!(matches!(error, ProfileCommandError::InvalidValue(_)));
        }
    }

    #[test]
    fn a_hand_set_contrast_stops_auto_contrast_and_survives_a_round_trip() {
        let mut profile = opened();
        profile
            .apply(ViewportCommand::SetChannelContrast {
                dataset_id: "wds-a".into(),
                channel: 1,
                min: 100.0,
                max: 900.0,
            })
            .unwrap();
        let view = profile.saved_view();
        assert_eq!(
            view.auto_contrast.get(&DatasetId("wds-a".into())),
            Some(&false)
        );

        let mut reopened = ProfileScene::open(&document(), &view);
        reopened
            .apply(ViewportCommand::Pan { dx: 1.0, dy: 0.0 })
            .unwrap();
        let settings = &reopened.saved_view().dataset_settings[&DatasetId("wds-a".into())];
        assert_eq!(settings.channel_settings[1].contrast_max, 900.0);
        assert_eq!(
            reopened
                .saved_view()
                .auto_contrast
                .get(&DatasetId("wds-a".into())),
            Some(&false)
        );
    }

    #[test]
    fn naming_one_dataset_in_an_order_keeps_the_rest_after_it() {
        let mut document = document();
        document.apply(DocumentCommand::DatasetOpened(
            make_dataset_opened_with_shape(
                "wds-b",
                "b.zarr",
                1,
                [1, 1, 1, 64, 64],
                [1, 1, 1, 64, 64],
                1,
            ),
        ));
        let mut profile = ProfileScene::fitted(&document);
        profile
            .apply(ViewportCommand::SetDatasetOrder {
                order: vec!["wds-b".into()],
            })
            .unwrap();
        assert_eq!(
            profile.scene.dataset_order,
            vec![DatasetId("wds-b".into()), DatasetId("wds-a".into())]
        );
    }

    #[test]
    fn the_stored_view_round_trips() {
        let mut profile = opened();
        profile
            .apply(ViewportCommand::SetChannelColormap {
                dataset_id: "wds-a".into(),
                channel: 0,
                colormap: Colormap::Viridis,
            })
            .unwrap();
        let view = profile.saved_view();
        assert_eq!(ProfileScene::open(&document(), &view).saved_view(), view);
    }
}
