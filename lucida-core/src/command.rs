use serde::{Deserialize, Serialize};

use lucida_content::{DatasetId, LayoutId, LayoutSpec};
use lucida_protocol::RegisterDataset;

use crate::camera::Camera;
use crate::scene::{BlendMode, Colormap, RenderMode, Scene};

/// Commands that mutate shared document state (datasets).
/// These are sequenced, persisted, and broadcast to all clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DocumentCommand {
    RegisterDataset(RegisterDataset),
    RemoveDataset { id: DatasetId },
    RegisterLayout {
        dataset_id: DatasetId,
        layout: LayoutSpec,
    },
    SetActiveLayout {
        dataset_id: DatasetId,
        layout_id: LayoutId,
    },
}

/// Commands that mutate local-only viewport/display state.
/// These are applied locally and emitted as presence updates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ViewportCommand {
    // Mode
    #[serde(rename = "set_mode_slice")]
    SetMode2D,
    #[serde(rename = "set_mode_arcball")]
    SetMode3D,
    #[serde(rename = "set_mode_fly")]
    SetModeFly,
    // Viewport
    SetViewport { width: u32, height: u32 },
    // 2D camera
    Pan { dx: f64, dy: f64 },
    ZoomBy { factor: f64 },
    SetCenter { x: f64, y: f64 },
    SetZoom { value: f64 },
    // 3D camera
    #[serde(rename = "arcball_rotate")]
    Rotate3D { d_theta: f64, d_phi: f64 },
    #[serde(rename = "arcball_zoom")]
    Zoom3D { delta: f64 },
    #[serde(rename = "arcball_pan")]
    Pan3D { dx: f64, dy: f64 },
    // Fly camera
    FlyTick {
        dt: f64,
        forward: f64,
        right: f64,
        up: f64,
        yaw: f64,
        pitch: f64,
        roll: f64,
    },
    // View state
    SetZ { z: u32 },
    SetZRange { start: u32, end: u32 },
    SetT { t: u32 },
    SetC { c: u32 },
    // Display
    SetContrast { min: f64, max: f64 },
    SetGamma { gamma: f64 },
    // Per-dataset display
    SetDatasetOrder { order: Vec<String> },
    SetDatasetVisible { dataset_id: String, visible: bool },
    SetDatasetOpacity { dataset_id: String, opacity: f32 },
    SetDatasetContrast { dataset_id: String, min: f64, max: f64 },
    SetDatasetGamma { dataset_id: String, gamma: f64 },
    SetDatasetBlendMode { dataset_id: String, blend_mode: BlendMode },
    SetDatasetRenderMode { dataset_id: String, render_mode: RenderMode },
    // Multi-channel
    SetMultiChannel { enabled: bool },
    SetChannelVisible { dataset_id: String, channel: u32, visible: bool },
    SetChannelColormap { dataset_id: String, channel: u32, colormap: Colormap },
    SetChannelContrast { dataset_id: String, channel: u32, min: f64, max: f64 },
    SetChannelGamma { dataset_id: String, channel: u32, gamma: f64 },
    SetChannelBlendMode { dataset_id: String, blend_mode: BlendMode },
}

/// Wrapper enum for serde compatibility. Deserializes from the same
/// JSON format as before (e.g. `{"type":"pan","dx":10.0,"dy":-5.0}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Command {
    Document(DocumentCommand),
    Viewport(ViewportCommand),
}

impl From<DocumentCommand> for Command {
    fn from(cmd: DocumentCommand) -> Self {
        Command::Document(cmd)
    }
}

impl From<ViewportCommand> for Command {
    fn from(cmd: ViewportCommand) -> Self {
        Command::Viewport(cmd)
    }
}

impl Scene {
    pub fn apply(&mut self, cmd: Command) {
        match cmd {
            Command::Document(doc_cmd) => {
                // Handle Scene-level side effects for document commands.
                // SetActiveLayout needs special ordering: apply doc state first,
                // then rebuild derived. All others do side effects first, then apply.
                if let DocumentCommand::SetActiveLayout { dataset_id, .. } = &doc_cmd {
                    let dataset_id = dataset_id.clone();
                    self.document.apply(doc_cmd);
                    if let Some(content) = self.document.content_graphs.get(&dataset_id) {
                        let layout = crate::scene::resolve_layout(
                            content,
                            self.document.registered_layouts.get(&dataset_id),
                            self.document.active_layout_ids.get(&dataset_id),
                        );
                        let derived = crate::scene::build_derived_state(content, &layout);
                        self.derived.insert(dataset_id, derived);
                    }
                    return;
                }
                match &doc_cmd {
                    DocumentCommand::RegisterDataset(reg) => {
                        let dataset_id = reg.content.dataset_id.clone();

                        // Dataset ordering
                        if !self.dataset_order.contains(&dataset_id) {
                            self.dataset_order.push(dataset_id.clone());
                        }

                        // Channel count from first image's C dimension
                        let channel_count = reg.content.images().first()
                            .and_then(|img| img.multiscale.levels.first())
                            .map(|l| l.shape[1] as usize)
                            .unwrap_or(1);

                        // Display settings
                        self.dataset_settings.entry(dataset_id.clone())
                            .or_insert_with(|| {
                                let mut s = crate::scene::DatasetDisplaySettings::default();
                                s.channel_settings = (0..channel_count)
                                    .map(|i| crate::scene::ChannelSettings {
                                        colormap: Colormap::default_for_channel(i),
                                        ..Default::default()
                                    })
                                    .collect();
                                s
                            });

                        // Build derived state
                        let layout = crate::scene::resolve_layout(
                            &reg.content,
                            self.document.registered_layouts.get(&dataset_id),
                            self.document.active_layout_ids.get(&dataset_id),
                        );
                        let derived = crate::scene::build_derived_state(&reg.content, &layout);
                        self.derived.insert(dataset_id, derived);

                        self.epochs.content += 1;
                        self.epochs.layout += 1;
                    }
                    DocumentCommand::RemoveDataset { id } => {
                        self.dataset_order.retain(|s| s != id);
                        self.dataset_settings.remove(id);
                        self.derived.remove(id);

                        self.epochs.content += 1;
                        self.epochs.layout += 1;
                    }
                    DocumentCommand::RegisterLayout { .. } => {
                        // Document state update happens below via self.document.apply().
                        // No derived rebuild needed for register alone.
                    }
                    DocumentCommand::SetActiveLayout { .. } => {
                        unreachable!("handled above");
                    }
                }
                self.document.apply(doc_cmd);
            }
            Command::Viewport(vp_cmd) => self.apply_viewport(vp_cmd),
        }
    }

    fn apply_viewport(&mut self, cmd: ViewportCommand) {
        match cmd {
            ViewportCommand::SetMode2D => {
                self.set_mode_2d();
                self.epochs.view += 1;
            }
            ViewportCommand::SetMode3D => {
                self.set_mode_3d();
                self.epochs.view += 1;
            }
            ViewportCommand::SetModeFly => {
                self.set_mode_fly();
                self.epochs.view += 1;
            }
            ViewportCommand::SetViewport { width, height } => {
                self.inner_set_viewport(width, height);
                self.epochs.view += 1;
            }
            ViewportCommand::Pan { dx, dy } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.pan(dx, dy);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::ZoomBy { factor } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.zoom_by(factor);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::SetCenter { x, y } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.center = [x, y];
                }
                self.epochs.view += 1;
            }
            ViewportCommand::SetZoom { value } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.zoom = value;
                }
                self.epochs.view += 1;
            }
            ViewportCommand::Rotate3D { d_theta, d_phi } => {
                if let Camera::Arcball(ref mut v) = self.camera {
                    v.rotate(d_theta, d_phi);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::Zoom3D { delta } => {
                if let Camera::Arcball(ref mut v) = self.camera {
                    v.zoom(delta);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::Pan3D { dx, dy } => {
                if let Camera::Arcball(ref mut v) = self.camera {
                    v.pan(dx, dy);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::FlyTick { dt, forward, right, up, yaw, pitch, roll } => {
                if let Camera::Fly(ref mut v) = self.camera {
                    v.fly_tick(dt, forward, right, up, yaw, pitch, roll);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::SetZ { z } => {
                self.view.set_z(z);
                self.epochs.selection += 1;
            }
            ViewportCommand::SetZRange { start, end } => {
                self.view.set_z_range(start..end);
                self.epochs.selection += 1;
            }
            ViewportCommand::SetT { t } => {
                self.view.t = t;
                self.epochs.selection += 1;
            }
            ViewportCommand::SetC { c } => {
                self.view.c = c;
                self.epochs.selection += 1;
            }
            ViewportCommand::SetContrast { min, max } => {
                self.display.contrast_min = min;
                self.display.contrast_max = max;
                self.epochs.selection += 1;
            }
            ViewportCommand::SetGamma { gamma } => {
                self.display.gamma = gamma;
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetOrder { order } => {
                self.dataset_order = order.into_iter().map(DatasetId).collect();
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetVisible { dataset_id, visible } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.visible = visible;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetOpacity { dataset_id, opacity } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.opacity = opacity;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetContrast { dataset_id, min, max } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.contrast_min = min;
                    s.contrast_max = max;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetGamma { dataset_id, gamma } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.gamma = gamma;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetBlendMode {
                dataset_id,
                blend_mode,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.blend_mode = blend_mode;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetRenderMode {
                dataset_id,
                render_mode,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.render_mode = render_mode;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetMultiChannel { enabled } => {
                self.view.multi_channel = enabled;
                self.epochs.selection += 1;
            }
            ViewportCommand::SetChannelVisible { dataset_id, channel, visible } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.ensure_channel(channel as usize).visible = visible;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetChannelColormap { dataset_id, channel, colormap } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.ensure_channel(channel as usize).colormap = colormap;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetChannelContrast { dataset_id, channel, min, max } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    let ch = s.ensure_channel(channel as usize);
                    ch.contrast_min = min;
                    ch.contrast_max = max;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetChannelGamma { dataset_id, channel, gamma } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.ensure_channel(channel as usize).gamma = gamma;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetChannelBlendMode { dataset_id, blend_mode } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.channel_blend_mode = blend_mode;
                }
                self.epochs.selection += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::test_helpers;

    #[test]
    fn viewport_command_round_trips_through_json() {
        let cmd = ViewportCommand::Pan { dx: 10.0, dy: -5.0 };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"pan","dx":10.0,"dy":-5.0}"#);
        let _parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn command_wrapper_round_trips_viewport() {
        let cmd = Command::Viewport(ViewportCommand::Pan { dx: 10.0, dy: -5.0 });
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"pan","dx":10.0,"dy":-5.0}"#);
        let parsed: Command = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, Command::Viewport(ViewportCommand::Pan { .. })));
    }

    #[test]
    fn command_wrapper_round_trips_document() {
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        let cmd = Command::Document(DocumentCommand::RegisterDataset(reg));
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"register_dataset\""));
        let parsed: Command = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, Command::Document(DocumentCommand::RegisterDataset(_))));
    }

    #[test]
    fn apply_pan_updates_center() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::Pan { dx: 100.0, dy: 0.0 }.into());
        if let Camera::Slice(ref v) = scene.camera {
            assert_eq!(v.center, [100.0, 0.0]);
        } else {
            panic!("expected Slice");
        }
    }

    #[test]
    fn apply_set_z_updates_view() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::SetZ { z: 42 }.into());
        assert_eq!(scene.view.z_range, 42..43);
    }

    #[test]
    fn apply_set_mode_3d_switches_camera() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::SetMode3D.into());
        assert!(matches!(scene.camera, Camera::Arcball(_)));
    }

    #[test]
    fn register_dataset_command_round_trips() {
        let reg = test_helpers::make_register_dataset("ds1", "test dataset", 1);
        let cmd = DocumentCommand::RegisterDataset(reg);
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"register_dataset\""));
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::RegisterDataset(r) => {
                assert_eq!(r.content.dataset_id, DatasetId("ds1".into()));
                assert_eq!(r.content.name, "test dataset");
            }
            _ => panic!("expected RegisterDataset"),
        }
    }

    #[test]
    fn remove_dataset_command_round_trips() {
        let cmd = DocumentCommand::RemoveDataset { id: DatasetId("ds1".into()) };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"remove_dataset\""));
        let _parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn apply_register_dataset_populates_scene() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        assert_eq!(scene.document.content_graphs.len(), 1);
        assert!(scene.document.content_graphs.contains_key(&DatasetId("ds1".into())));
        assert!(scene.derived.contains_key(&DatasetId("ds1".into())));
    }

    #[test]
    fn set_dataset_order_round_trips() {
        let cmd = ViewportCommand::SetDatasetOrder { order: vec!["a".into(), "b".into()] };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_dataset_order\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetDatasetOrder { order } => assert_eq!(order, vec!["a", "b"]),
            _ => panic!("expected SetDatasetOrder"),
        }
    }

    #[test]
    fn set_dataset_visible_round_trips() {
        let cmd = ViewportCommand::SetDatasetVisible { dataset_id: "ds1".into(), visible: false };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_dataset_visible\""));
        let _parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn set_dataset_blend_mode_round_trips() {
        let cmd = ViewportCommand::SetDatasetBlendMode {
            dataset_id: "ds1".into(),
            blend_mode: crate::scene::BlendMode::Additive,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"additive\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetDatasetBlendMode { blend_mode, .. } => {
                assert_eq!(blend_mode, crate::scene::BlendMode::Additive);
            }
            _ => panic!("expected SetDatasetBlendMode"),
        }
    }

    #[test]
    fn set_dataset_render_mode_round_trips() {
        let cmd = ViewportCommand::SetDatasetRenderMode {
            dataset_id: "ds1".into(),
            render_mode: crate::scene::RenderMode::MaxIntensity,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"max_intensity\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetDatasetRenderMode { render_mode, .. } => {
                assert_eq!(render_mode, crate::scene::RenderMode::MaxIntensity);
            }
            _ => panic!("expected SetDatasetRenderMode"),
        }
    }

    #[test]
    fn apply_set_dataset_visible_updates_settings() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        assert!(scene.dataset_settings[&DatasetId("ds1".into())].visible);
        scene.apply(ViewportCommand::SetDatasetVisible { dataset_id: "ds1".into(), visible: false }.into());
        assert!(!scene.dataset_settings[&DatasetId("ds1".into())].visible);
    }

    #[test]
    fn apply_set_dataset_opacity_updates_settings() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        assert_eq!(scene.dataset_settings[&DatasetId("ds1".into())].opacity, 1.0);
        scene.apply(ViewportCommand::SetDatasetOpacity { dataset_id: "ds1".into(), opacity: 0.5 }.into());
        assert_eq!(scene.dataset_settings[&DatasetId("ds1".into())].opacity, 0.5);
    }

    #[test]
    fn apply_remove_dataset_removes_from_scene() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        assert_eq!(scene.document.content_graphs.len(), 1);
        scene.apply(DocumentCommand::RemoveDataset { id: DatasetId("ds1".into()) }.into());
        assert!(scene.document.content_graphs.is_empty());
    }

    #[test]
    fn document_state_apply_register_dataset() {
        let mut doc = crate::scene::DocumentState::default();
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        doc.apply(DocumentCommand::RegisterDataset(reg));
        assert_eq!(doc.content_graphs.len(), 1);
        assert!(doc.content_graphs.contains_key(&DatasetId("ds1".into())));
    }

    #[test]
    fn document_state_apply_remove_dataset() {
        let mut doc = crate::scene::DocumentState::default();
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        doc.apply(DocumentCommand::RegisterDataset(reg));
        assert_eq!(doc.content_graphs.len(), 1);
        doc.apply(DocumentCommand::RemoveDataset { id: DatasetId("ds1".into()) });
        assert!(doc.content_graphs.is_empty());
    }

    #[test]
    fn viewport_commands_are_not_document_commands() {
        // These should all deserialize as ViewportCommand, not DocumentCommand
        let cmds = vec![
            r#"{"type":"set_dataset_order","order":[]}"#,
            r#"{"type":"set_dataset_visible","dataset_id":"x","visible":true}"#,
            r#"{"type":"pan","dx":1.0,"dy":2.0}"#,
        ];
        for json in cmds {
            assert!(serde_json::from_str::<DocumentCommand>(json).is_err(),
                "should not parse as DocumentCommand: {}", json);
            assert!(serde_json::from_str::<ViewportCommand>(json).is_ok(),
                "should parse as ViewportCommand: {}", json);
        }
    }

    // --- Colormap / Channel tests ---

    #[test]
    fn colormap_serde_round_trips() {
        use crate::scene::Colormap;
        let all = vec![
            Colormap::Gray, Colormap::Magenta, Colormap::Green, Colormap::Cyan,
            Colormap::Red, Colormap::Blue, Colormap::Yellow, Colormap::Viridis,
            Colormap::Inferno, Colormap::Plasma, Colormap::Magma, Colormap::Turbo,
            Colormap::Hot, Colormap::Cool, Colormap::Jet,
        ];
        for cm in &all {
            let json = serde_json::to_string(cm).unwrap();
            let parsed: Colormap = serde_json::from_str(&json).unwrap();
            assert_eq!(*cm, parsed);
        }
    }

    #[test]
    fn channel_settings_serde_round_trips() {
        use crate::scene::{ChannelSettings, Colormap};
        let cs = ChannelSettings {
            visible: false,
            colormap: Colormap::Viridis,
            contrast_min: 100.0,
            contrast_max: 50000.0,
            gamma: 0.8,
        };
        let json = serde_json::to_string(&cs).unwrap();
        let parsed: ChannelSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.visible, false);
        assert_eq!(parsed.colormap, Colormap::Viridis);
        assert_eq!(parsed.contrast_min, 100.0);
        assert_eq!(parsed.contrast_max, 50000.0);
        assert_eq!(parsed.gamma, 0.8);
    }

    #[test]
    fn set_multi_channel_round_trips() {
        let cmd = ViewportCommand::SetMultiChannel { enabled: true };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_multi_channel\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetMultiChannel { enabled } => assert!(enabled),
            _ => panic!("expected SetMultiChannel"),
        }
    }

    #[test]
    fn set_channel_visible_round_trips() {
        let cmd = ViewportCommand::SetChannelVisible {
            dataset_id: "ds1".into(),
            channel: 2,
            visible: false,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_channel_visible\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetChannelVisible { dataset_id, channel, visible } => {
                assert_eq!(dataset_id, "ds1");
                assert_eq!(channel, 2);
                assert!(!visible);
            }
            _ => panic!("expected SetChannelVisible"),
        }
    }

    #[test]
    fn set_channel_colormap_round_trips() {
        let cmd = ViewportCommand::SetChannelColormap {
            dataset_id: "ds1".into(),
            channel: 0,
            colormap: crate::scene::Colormap::Viridis,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"viridis\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetChannelColormap { colormap, .. } => {
                assert_eq!(colormap, crate::scene::Colormap::Viridis);
            }
            _ => panic!("expected SetChannelColormap"),
        }
    }

    #[test]
    fn set_channel_contrast_round_trips() {
        let cmd = ViewportCommand::SetChannelContrast {
            dataset_id: "ds1".into(),
            channel: 1,
            min: 50.0,
            max: 30000.0,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_channel_contrast\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetChannelContrast { dataset_id, channel, min, max } => {
                assert_eq!(dataset_id, "ds1");
                assert_eq!(channel, 1);
                assert_eq!(min, 50.0);
                assert_eq!(max, 30000.0);
            }
            _ => panic!("expected SetChannelContrast"),
        }
    }

    #[test]
    fn set_channel_gamma_round_trips() {
        let cmd = ViewportCommand::SetChannelGamma {
            dataset_id: "ds1".into(),
            channel: 0,
            gamma: 2.2,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_channel_gamma\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetChannelGamma { dataset_id, channel, gamma } => {
                assert_eq!(dataset_id, "ds1");
                assert_eq!(channel, 0);
                assert_eq!(gamma, 2.2);
            }
            _ => panic!("expected SetChannelGamma"),
        }
    }

    #[test]
    fn set_channel_blend_mode_round_trips() {
        let cmd = ViewportCommand::SetChannelBlendMode {
            dataset_id: "ds1".into(),
            blend_mode: crate::scene::BlendMode::Additive,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"additive\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetChannelBlendMode { dataset_id, blend_mode } => {
                assert_eq!(dataset_id, "ds1");
                assert_eq!(blend_mode, crate::scene::BlendMode::Additive);
            }
            _ => panic!("expected SetChannelBlendMode"),
        }
    }

    #[test]
    fn apply_set_multi_channel_updates_view() {
        let mut scene = Scene::new([800, 600]);
        assert!(!scene.view.multi_channel);
        scene.apply(ViewportCommand::SetMultiChannel { enabled: true }.into());
        assert!(scene.view.multi_channel);
        scene.apply(ViewportCommand::SetMultiChannel { enabled: false }.into());
        assert!(!scene.view.multi_channel);
    }

    #[test]
    fn apply_set_channel_colormap_updates_settings() {
        use crate::scene::Colormap;
        let mut scene = Scene::new([800, 600]);
        // Register a dataset with 2 channels
        let reg = test_helpers::make_register_dataset("ds1", "test", 2);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        // Verify default colormap assignments
        let ds_id = DatasetId("ds1".into());
        assert_eq!(scene.dataset_settings[&ds_id].channel_settings[0].colormap, Colormap::Magenta);
        assert_eq!(scene.dataset_settings[&ds_id].channel_settings[1].colormap, Colormap::Green);
        // Apply SetChannelColormap
        scene.apply(ViewportCommand::SetChannelColormap {
            dataset_id: "ds1".into(),
            channel: 1,
            colormap: Colormap::Viridis,
        }.into());
        assert_eq!(scene.dataset_settings[&ds_id].channel_settings[1].colormap, Colormap::Viridis);
    }

    #[test]
    fn register_dataset_initializes_channel_settings() {
        use crate::scene::Colormap;
        let mut scene = Scene::new([800, 600]);
        // Register with 4 channels
        let reg = test_helpers::make_register_dataset("ds1", "test", 4);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        let ds_id = DatasetId("ds1".into());
        let ch = &scene.dataset_settings[&ds_id].channel_settings;
        assert_eq!(ch.len(), 4);
        // Cycling: Magenta, Green, Cyan, Magenta
        assert_eq!(ch[0].colormap, Colormap::Magenta);
        assert_eq!(ch[1].colormap, Colormap::Green);
        assert_eq!(ch[2].colormap, Colormap::Cyan);
        assert_eq!(ch[3].colormap, Colormap::Magenta);
        // All visible by default
        for c in ch {
            assert!(c.visible);
            assert_eq!(c.contrast_min, 0.0);
            assert_eq!(c.contrast_max, 65535.0);
            assert_eq!(c.gamma, 1.0);
        }
    }

    // --- Epoch tests ---

    #[test]
    fn register_dataset_bumps_content_and_layout_epochs() {
        let mut scene = Scene::new([800, 600]);
        assert_eq!(scene.epochs.content, 0);
        assert_eq!(scene.epochs.layout, 0);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        assert_eq!(scene.epochs.content, 1);
        assert_eq!(scene.epochs.layout, 1);
        assert_eq!(scene.epochs.view, 0);
        assert_eq!(scene.epochs.selection, 0);
    }

    #[test]
    fn remove_dataset_bumps_content_and_layout_epochs() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        scene.apply(DocumentCommand::RemoveDataset { id: DatasetId("ds1".into()) }.into());
        assert_eq!(scene.epochs.content, 2);
        assert_eq!(scene.epochs.layout, 2);
    }

    #[test]
    fn pan_bumps_only_view_epoch() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::Pan { dx: 10.0, dy: 0.0 }.into());
        assert_eq!(scene.epochs.view, 1);
        assert_eq!(scene.epochs.content, 0);
        assert_eq!(scene.epochs.layout, 0);
        assert_eq!(scene.epochs.selection, 0);
    }

    #[test]
    fn set_t_bumps_only_selection_epoch() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::SetT { t: 5 }.into());
        assert_eq!(scene.epochs.selection, 1);
        assert_eq!(scene.epochs.view, 0);
        assert_eq!(scene.epochs.content, 0);
        assert_eq!(scene.epochs.layout, 0);
    }

    #[test]
    fn epochs_increase_monotonically() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::Pan { dx: 1.0, dy: 0.0 }.into());
        scene.apply(ViewportCommand::Pan { dx: 1.0, dy: 0.0 }.into());
        scene.apply(ViewportCommand::Pan { dx: 1.0, dy: 0.0 }.into());
        assert_eq!(scene.epochs.view, 3);
    }

    #[test]
    fn scene_epochs_serde_round_trip() {
        use crate::epoch::SceneEpochs;
        let epochs = SceneEpochs { content: 1, layout: 2, view: 3, selection: 4 };
        let json = serde_json::to_string(&epochs).unwrap();
        let parsed: SceneEpochs = serde_json::from_str(&json).unwrap();
        assert_eq!(epochs, parsed);
    }

    #[test]
    fn dataset_display_settings_backward_compat() {
        // Deserialize JSON without channel_settings or channel_blend_mode
        let json = r#"{
            "visible": true,
            "opacity": 1.0,
            "contrast_min": 0.0,
            "contrast_max": 65535.0,
            "gamma": 1.0,
            "blend_mode": "alpha"
        }"#;
        let settings: crate::scene::DatasetDisplaySettings = serde_json::from_str(json).unwrap();
        assert!(settings.channel_settings.is_empty());
        assert_eq!(settings.channel_blend_mode, crate::scene::BlendMode::Additive);
    }

    // --- Layout registration and switching tests ---

    #[test]
    fn register_layout_command_serde_round_trip() {
        use lucida_content::{LayoutId, LayoutSpec, layout::EntityPlacement, EntityId};
        let cmd = DocumentCommand::RegisterLayout {
            dataset_id: DatasetId("ds1".into()),
            layout: LayoutSpec {
                id: LayoutId("custom".into()),
                name: "Custom Layout".into(),
                placements: vec![EntityPlacement {
                    entity_id: EntityId("e1".into()),
                    position: [10.0, 20.0],
                }],
            },
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"register_layout\""));
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::RegisterLayout { dataset_id, layout } => {
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(layout.id, LayoutId("custom".into()));
                assert_eq!(layout.name, "Custom Layout");
                assert_eq!(layout.placements.len(), 1);
            }
            _ => panic!("expected RegisterLayout"),
        }
    }

    #[test]
    fn set_active_layout_command_serde_round_trip() {
        use lucida_content::LayoutId;
        let cmd = DocumentCommand::SetActiveLayout {
            dataset_id: DatasetId("ds1".into()),
            layout_id: LayoutId("layout-2".into()),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_active_layout\""));
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::SetActiveLayout { dataset_id, layout_id } => {
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(layout_id, LayoutId("layout-2".into()));
            }
            _ => panic!("expected SetActiveLayout"),
        }
    }

    #[test]
    fn register_layout_makes_it_available() {
        use lucida_content::{LayoutId, LayoutSpec, layout::EntityPlacement, EntityId};
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());

        let layout = LayoutSpec {
            id: LayoutId("new-layout".into()),
            name: "New Layout".into(),
            placements: vec![EntityPlacement {
                entity_id: EntityId("ds1-entity".into()),
                position: [100.0, 200.0],
            }],
        };
        scene.apply(DocumentCommand::RegisterLayout {
            dataset_id: DatasetId("ds1".into()),
            layout,
        }.into());

        let ds_id = DatasetId("ds1".into());
        assert!(scene.document.registered_layouts.contains_key(&ds_id));
        let layouts = &scene.document.registered_layouts[&ds_id];
        assert_eq!(layouts.len(), 1);
        assert_eq!(layouts[0].id, LayoutId("new-layout".into()));
        assert_eq!(layouts[0].name, "New Layout");
    }

    #[test]
    fn set_active_layout_rebuilds_derived_state() {
        use lucida_content::{LayoutId, LayoutSpec, layout::EntityPlacement, EntityId};
        let mut scene = Scene::new([800, 600]);

        // Register a plate dataset with two members
        let reg = test_helpers::make_plate_register_dataset(
            "plate", "plate",
            vec![
                ("m1", [0.0, 0.0]),
                ("m2", [256.0, 0.0]),
            ],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 256, 256],
        );
        scene.apply(DocumentCommand::RegisterDataset(reg).into());

        let ds_id = DatasetId("plate".into());
        // Verify initial positions
        let derived = &scene.derived[&ds_id];
        assert_eq!(derived.members[0].position, [0.0, 0.0]);
        assert_eq!(derived.members[1].position, [256.0, 0.0]);

        // Register a layout with different positions
        let alt_layout = LayoutSpec {
            id: LayoutId("alt".into()),
            name: "Alternative".into(),
            placements: vec![
                EntityPlacement { entity_id: EntityId("m1".into()), position: [500.0, 500.0] },
                EntityPlacement { entity_id: EntityId("m2".into()), position: [1000.0, 500.0] },
            ],
        };
        scene.apply(DocumentCommand::RegisterLayout {
            dataset_id: ds_id.clone(),
            layout: alt_layout,
        }.into());

        // Set the alt layout as active
        scene.apply(DocumentCommand::SetActiveLayout {
            dataset_id: ds_id.clone(),
            layout_id: LayoutId("alt".into()),
        }.into());

        // Verify positions changed
        let derived = &scene.derived[&ds_id];
        assert_eq!(derived.members[0].position, [500.0, 500.0]);
        assert_eq!(derived.members[1].position, [1000.0, 500.0]);
        assert_eq!(derived.active_layout.id, LayoutId("alt".into()));
    }

    #[test]
    fn set_active_layout_updates_active_layout_ids() {
        use lucida_content::LayoutId;
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());

        let ds_id = DatasetId("ds1".into());
        assert!(!scene.document.active_layout_ids.contains_key(&ds_id));

        scene.apply(DocumentCommand::SetActiveLayout {
            dataset_id: ds_id.clone(),
            layout_id: LayoutId("some-layout".into()),
        }.into());

        assert_eq!(
            scene.document.active_layout_ids[&ds_id],
            LayoutId("some-layout".into()),
        );
    }

    #[test]
    fn unknown_layout_id_is_no_op_for_derived() {
        use lucida_content::LayoutId;
        let mut scene = Scene::new([800, 600]);

        // Register a plate dataset with a known default layout
        let reg = test_helpers::make_plate_register_dataset(
            "plate", "plate",
            vec![
                ("m1", [0.0, 0.0]),
                ("m2", [256.0, 0.0]),
            ],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 256, 256],
        );
        scene.apply(DocumentCommand::RegisterDataset(reg).into());

        let ds_id = DatasetId("plate".into());
        let positions_before: Vec<[f64; 2]> = scene.derived[&ds_id]
            .members.iter().map(|m| m.position).collect();

        // Set an unknown layout ID
        scene.apply(DocumentCommand::SetActiveLayout {
            dataset_id: ds_id.clone(),
            layout_id: LayoutId("nonexistent".into()),
        }.into());

        // active_layout_ids should be updated
        assert_eq!(
            scene.document.active_layout_ids[&ds_id],
            LayoutId("nonexistent".into()),
        );
        // But derived state should use fallback (default layout), positions unchanged
        let positions_after: Vec<[f64; 2]> = scene.derived[&ds_id]
            .members.iter().map(|m| m.position).collect();
        assert_eq!(positions_before, positions_after);
    }
}
