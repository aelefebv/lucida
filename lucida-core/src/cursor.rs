//! Peer cursor geometry computation for GPU rendering.

use serde::{Deserialize, Serialize};

use crate::camera::{Camera, View3D};
use crate::camera::ray_aabb_hit;
use crate::mat4::{invert4_f64, normalize3, unproject};
use crate::scene::Scene;

const PEER_COLORS: [[f32; 3]; 8] = [
    [1.0, 0.420, 0.420],   // #FF6B6B
    [0.306, 0.804, 0.769], // #4ECDC4
    [1.0, 0.902, 0.427],   // #FFE66D
    [0.659, 0.902, 0.812], // #A8E6CF
    [1.0, 0.545, 0.580],   // #FF8B94
    [0.710, 0.918, 0.843], // #B5EAD7
    [0.780, 0.808, 0.918], // #C7CEEA
    [0.973, 0.710, 0.0],   // #F8B500
];

pub fn peer_color(client_id: u64) -> [f32; 3] {
    PEER_COLORS[(client_id as usize) % PEER_COLORS.len()]
}

#[derive(Deserialize)]
pub struct PeerInput {
    pub id: u64,
    pub cursor: Option<[f64; 2]>,
    pub mode: String,
    #[serde(default)]
    pub camera: Option<Camera>,
    #[serde(default)]
    pub view_z: Option<u32>,
}

#[derive(Serialize)]
pub struct CursorOutput {
    /// Each cursor is 16 floats: [pos/start(4), color(4), end_point(4), marker(4)]
    pub gpu: Vec<[f32; 16]>,
    pub labels: Vec<LabelOutput>,
}

#[derive(Serialize)]
pub struct LabelOutput {
    pub id: u64,
    pub sx: f64,
    pub sy: f64,
}

/// Unproject a normalized screen coordinate [0-1] through a View3D camera
/// to produce a ray (origin, direction) in world space.
fn unproject_cursor_ray(view: &View3D, nx: f64, ny: f64) -> Option<([f64; 3], [f64; 3])> {
    let ndc_x = nx * 2.0 - 1.0;
    let ndc_y = 1.0 - ny * 2.0; // screen Y=0 top → NDC Y=1 top

    let inv_vp = invert4_f64(view.view_proj_f64());

    let near_pt = unproject(&[ndc_x, ndc_y, -1.0], &inv_vp);
    let far_pt = unproject(&[ndc_x, ndc_y, 1.0], &inv_vp);

    let dir = [
        far_pt[0] - near_pt[0],
        far_pt[1] - near_pt[1],
        far_pt[2] - near_pt[2],
    ];
    let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    if len < 1e-12 {
        return None;
    }

    Some((near_pt, normalize3(dir)))
}

/// Intersect a ray with z = z_unit in unit [0,1]^3 space.
/// Returns the (x_unit, y_unit) intersection point, or None if the ray is parallel.
fn ray_z_intersect(
    ro: [f64; 3],
    rd: [f64; 3],
    z_unit: f64,
) -> Option<(f64, f64)> {
    if rd[2].abs() < 1e-12 {
        return None;
    }
    let t = (z_unit - ro[2]) / rd[2];
    if t < 0.0 {
        return None; // intersection behind the camera
    }
    let x = ro[0] + t * rd[0];
    let y = ro[1] + t * rd[1];
    Some((x, y))
}

/// Transform a point from world space to unit [0,1]^3 space using inv_model.
fn transform_point_f64(p: [f64; 3], m: &[f64; 16]) -> [f64; 3] {
    let x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    let y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    let z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    let w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if w.abs() < 1e-12 {
        [x, y, z]
    } else {
        [x / w, y / w, z / w]
    }
}

/// Find where a ray exits the unit [0,1]^3 box from an interior point.
fn ray_aabb_exit(origin: [f64; 3], dir: [f64; 3]) -> [f64; 3] {
    let mut t_far = f64::INFINITY;
    for i in 0..3 {
        if dir[i].abs() < 1e-12 { continue; }
        let t = if dir[i] > 0.0 {
            (1.0 - origin[i]) / dir[i]
        } else {
            -origin[i] / dir[i]
        };
        t_far = t_far.min(t);
    }
    let t = t_far.max(0.0);
    [
        origin[0] + t * dir[0],
        origin[1] + t * dir[1],
        origin[2] + t * dir[2],
    ]
}

/// Transform a direction vector (w=0) from world space using inv_model.
fn transform_dir_f64(d: [f64; 3], m: &[f64; 16]) -> [f64; 3] {
    [
        m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
        m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
        m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
    ]
}

/// Project a world-space point to screen coords through a View3D camera.
/// Uses `screen_size` (CSS pixels) instead of `view.viewport` (device pixels)
/// so coordinates match the HTML overlay positioning.
fn project_to_screen(point: [f64; 3], view: &View3D, screen_w: f64, screen_h: f64) -> Option<(f64, f64)> {
    let vp = view.view_proj_f64();
    let x = vp[0] * point[0] + vp[4] * point[1] + vp[8] * point[2] + vp[12];
    let y = vp[1] * point[0] + vp[5] * point[1] + vp[9] * point[2] + vp[13];
    let w = vp[3] * point[0] + vp[7] * point[1] + vp[11] * point[2] + vp[15];
    if w <= 0.0 {
        return None; // behind camera
    }
    let ndc_x = x / w;
    let ndc_y = y / w;
    let sx = (ndc_x * 0.5 + 0.5) * screen_w;
    let sy = (0.5 - ndc_y * 0.5) * screen_h; // flip Y
    Some((sx, sy))
}

/// Helper to create a crosshair cursor entry (16 floats).
fn make_crosshair(x: f32, y: f32, r: f32, g: f32, b: f32) -> [f32; 16] {
    [
        x, y, 0.0, 0.0, // position (voxel), type=0 (crosshair)
        r, g, b, 0.9,   // color
        0.0, 0.0, 0.0, 0.0, // end_point (unused)
        0.0, 0.0, 0.0, 0.0, // marker (unused)
    ]
}

/// Helper to create a ray cursor entry (16 floats).
fn make_ray(
    start: [f32; 3], end: [f32; 3], marker: [f32; 3],
    r: f32, g: f32, b: f32,
) -> [f32; 16] {
    [
        start[0], start[1], start[2], 1.0, // position = start, type=1 (ray)
        r, g, b, 0.9,                       // color
        end[0], end[1], end[2], 0.0,         // end_point
        marker[0], marker[1], marker[2], 0.0, // marker
    ]
}

/// Convert voxel coords to world space via model matrix.
fn voxel_to_world(x: f64, y: f64, z: f64, shape: [u32; 3], model: &[f64; 16]) -> [f32; 3] {
    let unit = [
        x / shape[2] as f64,
        1.0 - y / shape[1] as f64, // flip Y
        z / shape[0] as f64,
    ];
    let w = transform_point_f64(unit, model);
    [w[0] as f32, w[1] as f32, w[2] as f32]
}

/// Compute peer cursor geometry for the GPU and screen positions for labels.
///
/// Each GPU cursor is 16 floats: `[position(4), color(4), end_point(4), marker(4)]`
pub fn compute_peer_cursors(scene: &Scene, peers: &[PeerInput], my_id: u64, screen_w: f64, screen_h: f64) -> CursorOutput {
    let local_mode = match &scene.camera {
        Camera::View2D(_) => "2d",
        Camera::View3D(_) => "3d",
    };

    let volume_shape = scene.volume_shape().copied();
    let inv_model_f64: Option<[f64; 16]> = scene.volume_transform().map(|t| {
        t.inv_model.map(|v| v as f64)
    });
    let model_f64: Option<[f64; 16]> = scene.volume_transform().map(|t| {
        t.model.map(|v| v as f64)
    });

    let identity: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];

    let mut output = CursorOutput {
        gpu: Vec::new(),
        labels: Vec::new(),
    };

    for peer in peers {
        if peer.id == my_id {
            continue;
        }
        let cursor = match peer.cursor {
            Some(c) => c,
            None => continue,
        };

        let [r, g, b] = peer_color(peer.id);

        if peer.mode == local_mode {
            if local_mode == "2d" {
                // 2D→2D: pass through voxel coords as crosshair
                output.gpu.push(make_crosshair(cursor[0] as f32, cursor[1] as f32, r, g, b));

                if let Camera::View2D(v) = &scene.camera {
                    let sx = (cursor[0] - v.center[0]) * v.zoom + v.viewport[0] as f64 / 2.0;
                    let sy = (cursor[1] - v.center[1]) * v.zoom + v.viewport[1] as f64 / 2.0;
                    output.labels.push(LabelOutput { id: peer.id, sx, sy });
                }
            } else {
                // Case B: 3D→3D — unproject peer's cursor, clip to volume, render as ray
                let peer_view3d = match &peer.camera {
                    Some(Camera::View3D(v)) => v,
                    _ => continue,
                };

                let (ro_world, rd_world) = match unproject_cursor_ray(peer_view3d, cursor[0], cursor[1]) {
                    Some(r) => r,
                    None => continue,
                };

                let inv_m = inv_model_f64.as_ref().unwrap_or(&identity);
                let model = model_f64.as_ref().unwrap_or(&identity);
                let ro_unit = transform_point_f64(ro_world, inv_m);
                let rd_unit = normalize3(transform_dir_f64(rd_world, inv_m));

                // Compute ray segment through or near the volume
                let (start_unit, end_unit, marker_unit) =
                    if let Some(hit_point) = ray_aabb_hit(ro_unit, rd_unit, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]) {
                        // Ray hits volume: entry to exit with overshoot
                        let t_past = 0.01;
                        let interior = [
                            hit_point[0] + rd_unit[0] * t_past,
                            hit_point[1] + rd_unit[1] * t_past,
                            hit_point[2] + rd_unit[2] * t_past,
                        ];
                        let exit_point = ray_aabb_exit(interior, rd_unit);
                        let dx = exit_point[0] - hit_point[0];
                        let dy = exit_point[1] - hit_point[1];
                        let dz = exit_point[2] - hit_point[2];
                        let ray_len = (dx * dx + dy * dy + dz * dz).sqrt();
                        let overshoot = ray_len * 0.5;
                        (
                            [hit_point[0] - rd_unit[0] * overshoot,
                             hit_point[1] - rd_unit[1] * overshoot,
                             hit_point[2] - rd_unit[2] * overshoot],
                            [exit_point[0] + rd_unit[0] * overshoot,
                             exit_point[1] + rd_unit[1] * overshoot,
                             exit_point[2] + rd_unit[2] * overshoot],
                            hit_point,
                        )
                    } else {
                        // Ray misses volume: show ray near the volume center
                        let center = [0.5, 0.5, 0.5];
                        // Find closest point on ray to volume center
                        let oc = [center[0] - ro_unit[0], center[1] - ro_unit[1], center[2] - ro_unit[2]];
                        let t_closest = oc[0] * rd_unit[0] + oc[1] * rd_unit[1] + oc[2] * rd_unit[2];
                        let mid = [
                            ro_unit[0] + rd_unit[0] * t_closest,
                            ro_unit[1] + rd_unit[1] * t_closest,
                            ro_unit[2] + rd_unit[2] * t_closest,
                        ];
                        let half_len = 1.0; // unit-cube diagonal ≈ 1.73, use 1.0 for each side
                        (
                            [mid[0] - rd_unit[0] * half_len,
                             mid[1] - rd_unit[1] * half_len,
                             mid[2] - rd_unit[2] * half_len],
                            [mid[0] + rd_unit[0] * half_len,
                             mid[1] + rd_unit[1] * half_len,
                             mid[2] + rd_unit[2] * half_len],
                            mid,
                        )
                    };

                let start = transform_point_f64(start_unit, model);
                let end = transform_point_f64(end_unit, model);
                let marker = transform_point_f64(marker_unit, model);
                let marker_world = [marker[0] as f32, marker[1] as f32, marker[2] as f32];

                output.gpu.push(make_ray(
                    [start[0] as f32, start[1] as f32, start[2] as f32],
                    [end[0] as f32, end[1] as f32, end[2] as f32],
                    marker_world,
                    r, g, b,
                ));

                if let Camera::View3D(local_v) = &scene.camera {
                    if let Some((sx, sy)) = project_to_screen(marker, local_v, screen_w, screen_h) {
                        output.labels.push(LabelOutput { id: peer.id, sx, sy });
                    }
                }
            }
        } else if peer.mode == "3d" && local_mode == "2d" {
            // Case C: 3D peer → 2D local
            let view3d = match &peer.camera {
                Some(Camera::View3D(v)) => v,
                _ => continue,
            };

            let (ro_world, rd_world) = match unproject_cursor_ray(view3d, cursor[0], cursor[1]) {
                Some(r) => r,
                None => continue,
            };

            let inv_m = inv_model_f64.as_ref().unwrap_or(&identity);
            let ro_unit = transform_point_f64(ro_world, inv_m);
            let rd_unit = normalize3(transform_dir_f64(rd_world, inv_m));

            let shape = volume_shape.unwrap_or([1, 1, 1]);
            let local_z = scene.view.z_range.start;
            let z_unit = (local_z as f64 + 0.5) / shape[0] as f64;

            if let Some((x_unit, y_unit)) = ray_z_intersect(ro_unit, rd_unit, z_unit) {
                let x_voxel = x_unit * shape[2] as f64;
                let y_voxel = (1.0 - y_unit) * shape[1] as f64;

                if x_voxel >= 0.0
                    && x_voxel <= shape[2] as f64
                    && y_voxel >= 0.0
                    && y_voxel <= shape[1] as f64
                {
                    output.gpu.push(make_crosshair(x_voxel as f32, y_voxel as f32, r, g, b));

                    if let Camera::View2D(v) = &scene.camera {
                        let sx = (x_voxel - v.center[0]) * v.zoom + v.viewport[0] as f64 / 2.0;
                        let sy = (y_voxel - v.center[1]) * v.zoom + v.viewport[1] as f64 / 2.0;
                        output.labels.push(LabelOutput { id: peer.id, sx, sy });
                    }
                }
            }
        } else if peer.mode == "2d" && local_mode == "3d" {
            // Case A: 2D peer → 3D local — vertical ray through the volume
            let shape = volume_shape.unwrap_or([1, 1, 1]);
            let model = model_f64.as_ref().unwrap_or(&identity);

            let peer_view = match &peer.camera {
                Some(Camera::View2D(_)) => true,
                _ => true, // mode=="2d" so assume View2D even if camera missing
            };
            if !peer_view { continue; }

            // Peer's cursor is in voxel coords (x, y). Get their Z from their view.
            let peer_z = peer.view_z.unwrap_or(0) as f64;
            let x = cursor[0];
            let y = cursor[1];

            // Ray endpoints: vertical line extending 50% past dataset on each side
            let overshoot = shape[0] as f64 * 0.5;
            let start = voxel_to_world(x, y, -overshoot, shape, model);
            let end = voxel_to_world(x, y, shape[0] as f64 + overshoot, shape, model);
            let marker = voxel_to_world(x, y, peer_z + 0.5, shape, model);

            output.gpu.push(make_ray(start, end, marker, r, g, b));

            // Project marker to screen for label
            if let Camera::View3D(local_v) = &scene.camera {
                let marker_f64 = [marker[0] as f64, marker[1] as f64, marker[2] as f64];
                if let Some((sx, sy)) = project_to_screen(marker_f64, local_v, screen_w, screen_h) {
                    output.labels.push(LabelOutput { id: peer.id, sx, sy });
                }
            }
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::{Camera, View3D};
    use crate::scene::Scene;

    fn scene_2d(viewport: [u32; 2]) -> Scene {
        Scene::new(viewport)
    }

    fn scene_2d_with_shape(viewport: [u32; 2], shape: [u32; 3]) -> Scene {
        let mut scene = Scene::new(viewport);
        scene.set_volume_scale(shape, [1.0, 1.0, 1.0]);
        scene
    }

    fn scene_3d_with_shape(viewport: [u32; 2], shape: [u32; 3]) -> Scene {
        let mut scene = Scene::new(viewport);
        scene.set_volume_scale(shape, [1.0, 1.0, 1.0]);
        scene.set_mode_3d();
        scene
    }

    fn peer(id: u64, cursor: Option<[f64; 2]>, mode: &str) -> PeerInput {
        PeerInput { id, cursor, mode: mode.into(), camera: None, view_z: None }
    }

    fn peer_with_camera(id: u64, cursor: Option<[f64; 2]>, camera: Camera) -> PeerInput {
        let mode = match &camera { Camera::View2D(_) => "2d", Camera::View3D(_) => "3d" };
        PeerInput { id, cursor, mode: mode.into(), camera: Some(camera), view_z: None }
    }

    // --- 2D→2D tests ---

    #[test]
    fn filters_self() {
        let scene = scene_2d([800, 600]);
        let result = compute_peer_cursors(&scene, &[peer(1, Some([100.0, 200.0]), "2d")], 1, 800.0, 600.0);
        assert!(result.gpu.is_empty());
    }

    #[test]
    fn filters_no_cursor() {
        let scene = scene_2d([800, 600]);
        let result = compute_peer_cursors(&scene, &[peer(2, None, "2d")], 1, 800.0, 600.0);
        assert!(result.gpu.is_empty());
    }

    #[test]
    fn filters_cross_mode_without_camera() {
        let scene = scene_2d([800, 600]);
        let result = compute_peer_cursors(&scene, &[peer(2, Some([0.5, 0.5]), "3d")], 1, 800.0, 600.0);
        assert!(result.gpu.is_empty());
    }

    #[test]
    fn basic_2d_cursor() {
        let scene = scene_2d([800, 600]);
        let result = compute_peer_cursors(&scene, &[peer(2, Some([100.0, 200.0]), "2d")], 1, 800.0, 600.0);
        assert_eq!(result.gpu.len(), 1);
        let gpu = &result.gpu[0];
        assert_eq!(gpu[0], 100.0); // pos_x
        assert_eq!(gpu[1], 200.0); // pos_y
        assert_eq!(gpu[3], 0.0);   // type=crosshair
        assert_eq!(gpu[7], 0.9);   // alpha
    }

    #[test]
    fn screen_position_at_center() {
        let scene = scene_2d([800, 600]);
        let result = compute_peer_cursors(&scene, &[peer(2, Some([0.0, 0.0]), "2d")], 1, 800.0, 600.0);
        let label = &result.labels[0];
        assert_eq!(label.sx, 400.0);
        assert_eq!(label.sy, 300.0);
    }

    #[test]
    fn screen_position_with_zoom() {
        let mut scene = scene_2d([800, 600]);
        if let Camera::View2D(ref mut v) = scene.camera {
            v.zoom = 2.0;
            v.center = [50.0, 50.0];
        }
        let result = compute_peer_cursors(&scene, &[peer(2, Some([100.0, 100.0]), "2d")], 1, 800.0, 600.0);
        let label = &result.labels[0];
        assert_eq!(label.sx, 500.0);
        assert_eq!(label.sy, 400.0);
    }

    #[test]
    fn multiple_peers() {
        let scene = scene_2d([800, 600]);
        let peers = vec![
            peer(2, Some([10.0, 20.0]), "2d"),
            peer(3, Some([30.0, 40.0]), "2d"),
            peer(4, None, "2d"),
        ];
        let result = compute_peer_cursors(&scene, &peers, 1, 800.0, 600.0);
        assert_eq!(result.gpu.len(), 2);
    }

    #[test]
    fn color_wraps_around() {
        assert_eq!(peer_color(0), peer_color(8));
    }

    // --- 3D→2D tests (Case C) ---

    #[test]
    fn peer_3d_to_local_2d_center_screen() {
        let mut scene = scene_2d_with_shape([800, 600], [100, 200, 300]);
        scene.view.set_z(50);

        let peers = vec![peer_with_camera(
            2, Some([0.5, 0.5]),
            Camera::View3D(View3D::new([800, 600])),
        )];
        let result = compute_peer_cursors(&scene, &peers, 1, 800.0, 600.0);
        assert_eq!(result.gpu.len(), 1);
        let gpu = &result.gpu[0];
        assert!(gpu[0] >= 0.0 && gpu[0] <= 300.0, "x_voxel: {}", gpu[0]);
        assert!(gpu[1] >= 0.0 && gpu[1] <= 200.0, "y_voxel: {}", gpu[1]);
        assert_eq!(gpu[3], 0.0); // crosshair type
    }

    #[test]
    fn peer_3d_to_local_2d_no_camera_skipped() {
        let scene = scene_2d_with_shape([800, 600], [100, 200, 300]);
        let result = compute_peer_cursors(&scene, &[peer(2, Some([0.5, 0.5]), "3d")], 1, 800.0, 600.0);
        assert!(result.gpu.is_empty());
    }

    // --- 2D→3D tests (Case A) ---

    #[test]
    fn peer_2d_to_local_3d_produces_ray() {
        let scene = scene_3d_with_shape([800, 600], [100, 200, 300]);
        let mut p = peer(2, Some([150.0, 100.0]), "2d");
        p.view_z = Some(50);
        let result = compute_peer_cursors(&scene, &[p], 1, 800.0, 600.0);
        assert_eq!(result.gpu.len(), 1);
        let gpu = &result.gpu[0];
        assert_eq!(gpu[3], 1.0); // type=ray
        // Start and end should have different Z
        assert_ne!(gpu[2], gpu[10], "ray start.z != end.z");
    }

    #[test]
    fn peer_2d_to_local_3d_marker_between_endpoints() {
        let scene = scene_3d_with_shape([800, 600], [100, 200, 300]);
        let mut p = peer(2, Some([150.0, 100.0]), "2d");
        p.view_z = Some(50);
        let result = compute_peer_cursors(&scene, &[p], 1, 800.0, 600.0);
        let gpu = &result.gpu[0];
        let start_z = gpu[2];
        let end_z = gpu[10];
        let marker_z = gpu[14];
        let (min_z, max_z) = if start_z < end_z { (start_z, end_z) } else { (end_z, start_z) };
        assert!(marker_z >= min_z && marker_z <= max_z,
            "marker z={} should be between start z={} and end z={}", marker_z, start_z, end_z);
    }

    // --- 3D→3D tests (Case B) ---

    #[test]
    fn peer_3d_to_local_3d_produces_ray() {
        let scene = scene_3d_with_shape([800, 600], [100, 200, 300]);
        // Peer with a different View3D camera
        let mut peer_cam = View3D::new([800, 600]);
        peer_cam.theta = 1.0; // different angle
        let peers = vec![peer_with_camera(
            2, Some([0.5, 0.5]),
            Camera::View3D(peer_cam),
        )];
        let result = compute_peer_cursors(&scene, &peers, 1, 800.0, 600.0);
        assert_eq!(result.gpu.len(), 1);
        let gpu = &result.gpu[0];
        assert_eq!(gpu[3], 1.0); // type=ray
    }

    #[test]
    fn peer_3d_to_local_3d_no_camera_skipped() {
        let scene = scene_3d_with_shape([800, 600], [100, 200, 300]);
        let result = compute_peer_cursors(&scene, &[peer(2, Some([0.5, 0.5]), "3d")], 1, 800.0, 600.0);
        assert!(result.gpu.is_empty());
    }

    // --- Helper function tests ---

    #[test]
    fn unproject_ray_valid() {
        let view = View3D::new([800, 600]);
        let result = unproject_cursor_ray(&view, 0.5, 0.5);
        assert!(result.is_some());
        let (_, dir) = result.unwrap();
        let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
        assert!((len - 1.0).abs() < 1e-6);
    }

    #[test]
    fn ray_z_intersect_basic() {
        let (x, y) = ray_z_intersect([0.5, 0.5, 0.0], [0.0, 0.0, 1.0], 0.5).unwrap();
        assert!((x - 0.5).abs() < 1e-10);
        assert!((y - 0.5).abs() < 1e-10);
    }

    #[test]
    fn ray_z_intersect_parallel() {
        assert!(ray_z_intersect([0.5, 0.5, 0.0], [1.0, 0.0, 0.0], 0.5).is_none());
    }

    #[test]
    fn ray_z_intersect_behind() {
        assert!(ray_z_intersect([0.5, 0.5, 1.0], [0.0, 0.0, 1.0], 0.5).is_none());
    }
}
