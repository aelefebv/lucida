use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::scene::{BlendMode, Dataset, Layer, RenderMode, Scene};
use crate::transform;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    // Mode
    #[serde(rename = "set_mode_2d")]
    SetMode2D,
    #[serde(rename = "set_mode_3d")]
    SetMode3D,
    // Viewport
    SetViewport { width: u32, height: u32 },
    // 2D camera
    Pan { dx: f64, dy: f64 },
    ZoomBy { factor: f64 },
    SetCenter { x: f64, y: f64 },
    SetZoom { value: f64 },
    // 3D camera
    #[serde(rename = "rotate_3d")]
    Rotate3D { d_theta: f64, d_phi: f64 },
    #[serde(rename = "zoom_3d")]
    Zoom3D { delta: f64 },
    #[serde(rename = "pan_3d")]
    Pan3D { dx: f64, dy: f64 },
    // View state
    SetZ { z: u32 },
    SetZRange { start: u32, end: u32 },
    SetT { t: u32 },
    SetC { c: u32 },
    // Volume
    SetVolumeScale { shape: [u32; 3], scale: [f64; 3] },
    // Dataset management
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
    // Display
    SetContrast { min: f64, max: f64 },
    SetGamma { gamma: f64 },
    // Per-layer display
    SetLayerOrder { order: Vec<String> },
    SetLayerVisible { dataset_id: String, visible: bool },
    SetLayerOpacity { dataset_id: String, opacity: f32 },
    SetLayerContrast { dataset_id: String, min: f64, max: f64 },
    SetLayerGamma { dataset_id: String, gamma: f64 },
    SetLayerBlendMode { dataset_id: String, blend_mode: BlendMode },
    SetLayerRenderMode { dataset_id: String, render_mode: RenderMode },
}

impl Command {
    /// Returns `true` if this command mutates shared document state (datasets).
    /// Document commands are sequenced, persisted, and broadcast to all clients.
    /// Viewport/display commands are local-only and emitted as presence.
    pub fn is_document_command(&self) -> bool {
        matches!(
            self,
            Command::AddDataset { .. }
                | Command::RemoveDataset { .. }
                | Command::SetVolumeScale { .. }
        )
    }
}

impl Scene {
    pub fn apply(&mut self, cmd: Command) {
        match cmd {
            Command::SetMode2D => self.set_mode_2d(),
            Command::SetMode3D => self.set_mode_3d(),
            Command::SetViewport { width, height } => self.camera.set_viewport(width, height),
            Command::Pan { dx, dy } => {
                if let Camera::View2D(ref mut v) = self.camera {
                    v.pan(dx, dy);
                }
            }
            Command::ZoomBy { factor } => {
                if let Camera::View2D(ref mut v) = self.camera {
                    v.zoom_by(factor);
                }
            }
            Command::SetCenter { x, y } => {
                if let Camera::View2D(ref mut v) = self.camera {
                    v.center = [x, y];
                }
            }
            Command::SetZoom { value } => {
                if let Camera::View2D(ref mut v) = self.camera {
                    v.zoom = value;
                }
            }
            Command::Rotate3D { d_theta, d_phi } => {
                if let Camera::View3D(ref mut v) = self.camera {
                    v.rotate(d_theta, d_phi);
                }
            }
            Command::Zoom3D { delta } => {
                if let Camera::View3D(ref mut v) = self.camera {
                    v.zoom(delta);
                }
            }
            Command::Pan3D { dx, dy } => {
                if let Camera::View3D(ref mut v) = self.camera {
                    v.pan(dx, dy);
                }
            }
            Command::SetZ { z } => self.view.set_z(z),
            Command::SetZRange { start, end } => self.view.set_z_range(start..end),
            Command::SetT { t } => self.view.t = t,
            Command::SetC { c } => self.view.c = c,
            Command::SetVolumeScale { shape, scale } => self.set_volume_scale(shape, scale),
            Command::AddDataset {
                id,
                name,
                layers,
                volume_shape,
                volume_scale,
                client_metadata,
            } => {
                let volume_transform =
                    if let (Some(shape), Some(scale)) = (volume_shape, volume_scale) {
                        Some(transform::compute_volume_transform(shape, scale))
                    } else {
                        None
                    };
                self.add_dataset(Dataset {
                    id,
                    name,
                    layers,
                    volume_transform,
                    volume_shape,
                    client_metadata,
                });
            }
            Command::RemoveDataset { id } => {
                self.remove_dataset(&id);
            }
            Command::SetContrast { min, max } => {
                self.display.contrast_min = min;
                self.display.contrast_max = max;
            }
            Command::SetGamma { gamma } => {
                self.display.gamma = gamma;
            }
            Command::SetLayerOrder { order } => {
                self.layer_order = order;
            }
            Command::SetLayerVisible { dataset_id, visible } => {
                if let Some(s) = self.layer_settings.get_mut(&dataset_id) {
                    s.visible = visible;
                }
            }
            Command::SetLayerOpacity { dataset_id, opacity } => {
                if let Some(s) = self.layer_settings.get_mut(&dataset_id) {
                    s.opacity = opacity;
                }
            }
            Command::SetLayerContrast { dataset_id, min, max } => {
                if let Some(s) = self.layer_settings.get_mut(&dataset_id) {
                    s.contrast_min = min;
                    s.contrast_max = max;
                }
            }
            Command::SetLayerGamma { dataset_id, gamma } => {
                if let Some(s) = self.layer_settings.get_mut(&dataset_id) {
                    s.gamma = gamma;
                }
            }
            Command::SetLayerBlendMode { dataset_id, blend_mode } => {
                if let Some(s) = self.layer_settings.get_mut(&dataset_id) {
                    s.blend_mode = blend_mode;
                }
            }
            Command::SetLayerRenderMode { dataset_id, render_mode } => {
                if let Some(s) = self.layer_settings.get_mut(&dataset_id) {
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
    fn command_round_trips_through_json() {
        let cmd = Command::Pan { dx: 10.0, dy: -5.0 };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"pan","dx":10.0,"dy":-5.0}"#);
        let _parsed: Command = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn apply_pan_updates_center() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(Command::Pan { dx: 100.0, dy: 0.0 });
        if let Camera::View2D(ref v) = scene.camera {
            assert_eq!(v.center, [100.0, 0.0]);
        } else {
            panic!("expected View2D");
        }
    }

    #[test]
    fn apply_set_z_updates_view() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(Command::SetZ { z: 42 });
        assert_eq!(scene.view.z_range, 42..43);
    }

    #[test]
    fn apply_set_mode_3d_switches_camera() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(Command::SetMode3D);
        assert!(matches!(scene.camera, Camera::View3D(_)));
    }

    #[test]
    fn add_dataset_command_round_trips() {
        let cmd = Command::AddDataset {
            id: "ds1".into(),
            name: "test dataset".into(),
            layers: vec![],
            volume_shape: Some([100, 200, 300]),
            volume_scale: Some([1.0, 0.5, 0.5]),
            client_metadata: Some(serde_json::json!({"dtype": "uint16"})),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"add_dataset\""));
        let parsed: Command = serde_json::from_str(&json).unwrap();
        match parsed {
            Command::AddDataset { id, name, volume_shape, client_metadata, .. } => {
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
        let cmd = Command::RemoveDataset { id: "ds1".into() };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"remove_dataset\""));
        let _parsed: Command = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn apply_add_dataset_populates_scene() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(Command::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            layers: vec![],
            volume_shape: Some([100, 200, 300]),
            volume_scale: Some([1.0, 1.0, 1.0]),
            client_metadata: None,
        });
        assert_eq!(scene.document.datasets.len(), 1);
        assert_eq!(scene.document.datasets[0].id, "ds1");
        assert!(scene.document.datasets[0].volume_transform.is_some());
        assert_eq!(scene.document.datasets[0].volume_shape, Some([100, 200, 300]));
    }

    #[test]
    fn set_layer_order_round_trips() {
        let cmd = Command::SetLayerOrder { order: vec!["a".into(), "b".into()] };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_layer_order\""));
        let parsed: Command = serde_json::from_str(&json).unwrap();
        match parsed {
            Command::SetLayerOrder { order } => assert_eq!(order, vec!["a", "b"]),
            _ => panic!("expected SetLayerOrder"),
        }
    }

    #[test]
    fn set_layer_visible_round_trips() {
        let cmd = Command::SetLayerVisible { dataset_id: "ds1".into(), visible: false };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_layer_visible\""));
        let _parsed: Command = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn set_layer_blend_mode_round_trips() {
        let cmd = Command::SetLayerBlendMode {
            dataset_id: "ds1".into(),
            blend_mode: crate::scene::BlendMode::Additive,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"additive\""));
        let parsed: Command = serde_json::from_str(&json).unwrap();
        match parsed {
            Command::SetLayerBlendMode { blend_mode, .. } => {
                assert_eq!(blend_mode, crate::scene::BlendMode::Additive);
            }
            _ => panic!("expected SetLayerBlendMode"),
        }
    }

    #[test]
    fn layer_commands_are_not_document_commands() {
        let cmds: Vec<Command> = vec![
            Command::SetLayerOrder { order: vec![] },
            Command::SetLayerVisible { dataset_id: "x".into(), visible: true },
            Command::SetLayerOpacity { dataset_id: "x".into(), opacity: 0.5 },
            Command::SetLayerContrast { dataset_id: "x".into(), min: 0.0, max: 1.0 },
            Command::SetLayerGamma { dataset_id: "x".into(), gamma: 1.0 },
            Command::SetLayerBlendMode { dataset_id: "x".into(), blend_mode: crate::scene::BlendMode::Max },
            Command::SetLayerRenderMode { dataset_id: "x".into(), render_mode: crate::scene::RenderMode::MaxIntensity },
        ];
        for cmd in cmds {
            assert!(!cmd.is_document_command(), "expected not document command: {:?}", cmd);
        }
    }

    #[test]
    fn set_layer_render_mode_round_trips() {
        let cmd = Command::SetLayerRenderMode {
            dataset_id: "ds1".into(),
            render_mode: crate::scene::RenderMode::MaxIntensity,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"max_intensity\""));
        let parsed: Command = serde_json::from_str(&json).unwrap();
        match parsed {
            Command::SetLayerRenderMode { render_mode, .. } => {
                assert_eq!(render_mode, crate::scene::RenderMode::MaxIntensity);
            }
            _ => panic!("expected SetLayerRenderMode"),
        }
    }

    #[test]
    fn apply_set_layer_visible_updates_settings() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(Command::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            client_metadata: None,
        });
        assert!(scene.layer_settings["ds1"].visible);
        scene.apply(Command::SetLayerVisible { dataset_id: "ds1".into(), visible: false });
        assert!(!scene.layer_settings["ds1"].visible);
    }

    #[test]
    fn apply_set_layer_opacity_updates_settings() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(Command::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            client_metadata: None,
        });
        assert_eq!(scene.layer_settings["ds1"].opacity, 1.0);
        scene.apply(Command::SetLayerOpacity { dataset_id: "ds1".into(), opacity: 0.5 });
        assert_eq!(scene.layer_settings["ds1"].opacity, 0.5);
    }

    #[test]
    fn apply_remove_dataset_removes_from_scene() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(Command::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            client_metadata: None,
        });
        assert_eq!(scene.document.datasets.len(), 1);
        scene.apply(Command::RemoveDataset { id: "ds1".into() });
        assert!(scene.document.datasets.is_empty());
    }
}
