use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::scene::{BlendMode, Colormap, DatasetKind, DatasetMember, Layer, RenderMode, Scene};

/// Commands that mutate shared document state (datasets).
/// These are sequenced, persisted, and broadcast to all clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DocumentCommand {
    AddDataset {
        id: String,
        name: String,
        #[serde(default)]
        kind: DatasetKind,
        layers: Vec<Layer>,
        volume_shape: Option<[u32; 3]>,
        volume_scale: Option<[f64; 3]>,
        #[serde(default)]
        members: Vec<DatasetMember>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_metadata: Option<serde_json::Value>,
    },
    RemoveDataset {
        id: String,
    },
    SetVolumeScale {
        shape: [u32; 3],
        scale: [f64; 3],
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
                match &doc_cmd {
                    DocumentCommand::AddDataset { id, layers, .. } => {
                        if !self.dataset_order.contains(id) {
                            self.dataset_order.push(id.clone());
                        }
                        self.dataset_settings
                            .entry(id.clone())
                            .or_insert_with(Default::default);
                        // Lazy-initialize channel_settings from layer count.
                        if let Some(s) = self.dataset_settings.get_mut(id) {
                            if s.channel_settings.is_empty() {
                                s.channel_settings = layers.iter().enumerate().map(|(i, _)| {
                                    crate::scene::ChannelSettings {
                                        colormap: Colormap::default_for_channel(i),
                                        ..Default::default()
                                    }
                                }).collect();
                            }
                        }
                    }
                    DocumentCommand::RemoveDataset { id } => {
                        self.dataset_order.retain(|s| s != id);
                        self.dataset_settings.remove(id);
                    }
                    DocumentCommand::SetVolumeScale { .. } => {}
                }
                self.document.apply(doc_cmd);
            }
            Command::Viewport(vp_cmd) => self.apply_viewport(vp_cmd),
        }
    }

    fn apply_viewport(&mut self, cmd: ViewportCommand) {
        match cmd {
            ViewportCommand::SetMode2D => self.set_mode_2d(),
            ViewportCommand::SetMode3D => self.set_mode_3d(),
            ViewportCommand::SetModeFly => self.set_mode_fly(),
            ViewportCommand::SetViewport { width, height } => {
                self.camera.set_viewport(width, height)
            }
            ViewportCommand::Pan { dx, dy } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.pan(dx, dy);
                }
            }
            ViewportCommand::ZoomBy { factor } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.zoom_by(factor);
                }
            }
            ViewportCommand::SetCenter { x, y } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.center = [x, y];
                }
            }
            ViewportCommand::SetZoom { value } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.zoom = value;
                }
            }
            ViewportCommand::Rotate3D { d_theta, d_phi } => {
                if let Camera::Arcball(ref mut v) = self.camera {
                    v.rotate(d_theta, d_phi);
                }
            }
            ViewportCommand::Zoom3D { delta } => {
                if let Camera::Arcball(ref mut v) = self.camera {
                    v.zoom(delta);
                }
            }
            ViewportCommand::Pan3D { dx, dy } => {
                if let Camera::Arcball(ref mut v) = self.camera {
                    v.pan(dx, dy);
                }
            }
            ViewportCommand::FlyTick { dt, forward, right, up, yaw, pitch, roll } => {
                if let Camera::Fly(ref mut v) = self.camera {
                    v.fly_tick(dt, forward, right, up, yaw, pitch, roll);
                }
            }
            ViewportCommand::SetZ { z } => self.view.set_z(z),
            ViewportCommand::SetZRange { start, end } => self.view.set_z_range(start..end),
            ViewportCommand::SetT { t } => self.view.t = t,
            ViewportCommand::SetC { c } => self.view.c = c,
            ViewportCommand::SetContrast { min, max } => {
                self.display.contrast_min = min;
                self.display.contrast_max = max;
            }
            ViewportCommand::SetGamma { gamma } => {
                self.display.gamma = gamma;
            }
            ViewportCommand::SetDatasetOrder { order } => {
                self.dataset_order = order;
            }
            ViewportCommand::SetDatasetVisible { dataset_id, visible } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    s.visible = visible;
                }
            }
            ViewportCommand::SetDatasetOpacity { dataset_id, opacity } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    s.opacity = opacity;
                }
            }
            ViewportCommand::SetDatasetContrast { dataset_id, min, max } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    s.contrast_min = min;
                    s.contrast_max = max;
                }
            }
            ViewportCommand::SetDatasetGamma { dataset_id, gamma } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    s.gamma = gamma;
                }
            }
            ViewportCommand::SetDatasetBlendMode {
                dataset_id,
                blend_mode,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    s.blend_mode = blend_mode;
                }
            }
            ViewportCommand::SetDatasetRenderMode {
                dataset_id,
                render_mode,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    s.render_mode = render_mode;
                }
            }
            ViewportCommand::SetMultiChannel { enabled } => {
                self.view.multi_channel = enabled;
            }
            ViewportCommand::SetChannelVisible { dataset_id, channel, visible } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    s.ensure_channel(channel as usize).visible = visible;
                }
            }
            ViewportCommand::SetChannelColormap { dataset_id, channel, colormap } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    s.ensure_channel(channel as usize).colormap = colormap;
                }
            }
            ViewportCommand::SetChannelContrast { dataset_id, channel, min, max } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    let ch = s.ensure_channel(channel as usize);
                    ch.contrast_min = min;
                    ch.contrast_max = max;
                }
            }
            ViewportCommand::SetChannelGamma { dataset_id, channel, gamma } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    s.ensure_channel(channel as usize).gamma = gamma;
                }
            }
            ViewportCommand::SetChannelBlendMode { dataset_id, blend_mode } => {
                if let Some(s) = self.dataset_settings.get_mut(&dataset_id) {
                    s.channel_blend_mode = blend_mode;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let cmd = Command::Document(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            members: Vec::new(),
            client_metadata: None,
        });
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"add_dataset\""));
        let parsed: Command = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, Command::Document(DocumentCommand::AddDataset { .. })));
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
    fn add_dataset_command_round_trips() {
        let cmd = DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test dataset".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_shape: Some([100, 200, 300]),
            volume_scale: Some([1.0, 0.5, 0.5]),
            members: Vec::new(),
            client_metadata: Some(serde_json::json!({"dtype": "uint16"})),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"add_dataset\""));
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::AddDataset { id, name, volume_shape, client_metadata, .. } => {
                assert_eq!(id, "ds1");
                assert_eq!(name, "test dataset");
                assert_eq!(volume_shape, Some([100, 200, 300]));
                assert!(client_metadata.is_some());
            }
            _ => panic!("expected AddDataset"),
        }
    }

    #[test]
    fn remove_dataset_command_round_trips() {
        let cmd = DocumentCommand::RemoveDataset { id: "ds1".into() };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"remove_dataset\""));
        let _parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn apply_add_dataset_populates_scene() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_shape: Some([100, 200, 300]),
            volume_scale: Some([1.0, 1.0, 1.0]),
            members: Vec::new(),
            client_metadata: None,
        }.into());
        assert_eq!(scene.document.datasets.len(), 1);
        assert_eq!(scene.document.datasets[0].id, "ds1");
        assert!(scene.document.datasets[0].volume_transform.is_some());
        assert_eq!(scene.document.datasets[0].volume_shape, Some([100, 200, 300]));
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
        scene.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            members: Vec::new(),
            client_metadata: None,
        }.into());
        assert!(scene.dataset_settings["ds1"].visible);
        scene.apply(ViewportCommand::SetDatasetVisible { dataset_id: "ds1".into(), visible: false }.into());
        assert!(!scene.dataset_settings["ds1"].visible);
    }

    #[test]
    fn apply_set_dataset_opacity_updates_settings() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            members: Vec::new(),
            client_metadata: None,
        }.into());
        assert_eq!(scene.dataset_settings["ds1"].opacity, 1.0);
        scene.apply(ViewportCommand::SetDatasetOpacity { dataset_id: "ds1".into(), opacity: 0.5 }.into());
        assert_eq!(scene.dataset_settings["ds1"].opacity, 0.5);
    }

    #[test]
    fn apply_remove_dataset_removes_from_scene() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            members: Vec::new(),
            client_metadata: None,
        }.into());
        assert_eq!(scene.document.datasets.len(), 1);
        scene.apply(DocumentCommand::RemoveDataset { id: "ds1".into() }.into());
        assert!(scene.document.datasets.is_empty());
    }

    #[test]
    fn document_state_apply_add_dataset() {
        let mut doc = crate::scene::DocumentState { datasets: Vec::new() };
        doc.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_shape: Some([100, 200, 300]),
            volume_scale: Some([1.0, 1.0, 1.0]),
            members: Vec::new(),
            client_metadata: None,
        });
        assert_eq!(doc.datasets.len(), 1);
        assert_eq!(doc.datasets[0].id, "ds1");
        assert!(doc.datasets[0].volume_transform.is_some());
    }

    #[test]
    fn document_state_apply_remove_dataset() {
        let mut doc = crate::scene::DocumentState { datasets: Vec::new() };
        doc.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            members: Vec::new(),
            client_metadata: None,
        });
        assert_eq!(doc.datasets.len(), 1);
        doc.apply(DocumentCommand::RemoveDataset { id: "ds1".into() });
        assert!(doc.datasets.is_empty());
    }

    #[test]
    fn document_state_apply_set_volume_scale() {
        let mut doc = crate::scene::DocumentState { datasets: Vec::new() };
        doc.apply(DocumentCommand::SetVolumeScale {
            shape: [100, 200, 300],
            scale: [1.0, 0.5, 0.5],
        });
        assert_eq!(doc.datasets.len(), 1);
        assert_eq!(doc.datasets[0].volume_shape, Some([100, 200, 300]));
        assert!(doc.datasets[0].volume_transform.is_some());
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
        use crate::scene::{Colormap, Layer};
        let mut scene = Scene::new([800, 600]);
        scene.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers: vec![
                Layer {
                    name: "ch0".into(),
                    visible: true,
                    num_levels: 1,
                    chunk_size: [1, 256, 256],
                    data_shape: [1, 256, 256],
                    level_info: vec![],
                },
                Layer {
                    name: "ch1".into(),
                    visible: true,
                    num_levels: 1,
                    chunk_size: [1, 256, 256],
                    data_shape: [1, 256, 256],
                    level_info: vec![],
                },
            ],
            volume_shape: None,
            volume_scale: None,
            members: Vec::new(),
            client_metadata: None,
        }.into());
        // Verify default colormap assignments
        assert_eq!(scene.dataset_settings["ds1"].channel_settings[0].colormap, Colormap::Magenta);
        assert_eq!(scene.dataset_settings["ds1"].channel_settings[1].colormap, Colormap::Green);
        // Apply SetChannelColormap
        scene.apply(ViewportCommand::SetChannelColormap {
            dataset_id: "ds1".into(),
            channel: 1,
            colormap: Colormap::Viridis,
        }.into());
        assert_eq!(scene.dataset_settings["ds1"].channel_settings[1].colormap, Colormap::Viridis);
    }

    #[test]
    fn add_dataset_initializes_channel_settings() {
        use crate::scene::{Colormap, Layer};
        let mut scene = Scene::new([800, 600]);
        let layers = vec![
            Layer { name: "DAPI".into(), visible: true, num_levels: 1, chunk_size: [1, 256, 256], data_shape: [1, 256, 256], level_info: vec![] },
            Layer { name: "GFP".into(), visible: true, num_levels: 1, chunk_size: [1, 256, 256], data_shape: [1, 256, 256], level_info: vec![] },
            Layer { name: "RFP".into(), visible: true, num_levels: 1, chunk_size: [1, 256, 256], data_shape: [1, 256, 256], level_info: vec![] },
            Layer { name: "Cy5".into(), visible: true, num_levels: 1, chunk_size: [1, 256, 256], data_shape: [1, 256, 256], level_info: vec![] },
        ];
        scene.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers,
            volume_shape: None,
            volume_scale: None,
            members: Vec::new(),
            client_metadata: None,
        }.into());
        let ch = &scene.dataset_settings["ds1"].channel_settings;
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
}
