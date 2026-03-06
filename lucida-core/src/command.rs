use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::scene::Scene;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    // Mode
    SetMode2D,
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
}
