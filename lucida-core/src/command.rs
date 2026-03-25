use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::scene::{BlendMode, Layer, RenderMode, Scene};

/// Commands that mutate shared document state (datasets).
/// These are sequenced, persisted, and broadcast to all clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DocumentCommand {
    AddDataset {
        id: String,
        name: String,
        layers: Vec<Layer>,
        volume_shape: Option<[u32; 3]>,
        volume_scale: Option<[f64; 3]>,
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
                    DocumentCommand::AddDataset { id, .. } => {
                        if !self.dataset_order.contains(id) {
                            self.dataset_order.push(id.clone());
                        }
                        self.dataset_settings
                            .entry(id.clone())
                            .or_insert_with(Default::default);
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
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
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
            layers: vec![],
            volume_shape: Some([100, 200, 300]),
            volume_scale: Some([1.0, 0.5, 0.5]),
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
            layers: vec![],
            volume_shape: Some([100, 200, 300]),
            volume_scale: Some([1.0, 1.0, 1.0]),
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
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
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
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
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
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
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
            layers: vec![],
            volume_shape: Some([100, 200, 300]),
            volume_scale: Some([1.0, 1.0, 1.0]),
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
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
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
}
