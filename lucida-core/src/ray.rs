use serde::{Deserialize, Serialize};

use lucida_content::{EntityId, ImageId};

#[derive(Debug, Clone)]
pub struct Ray {
    pub origin: [f64; 3],
    pub direction: [f64; 3], // normalized
}

/// Result of a ray pick — the closest entity hit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RayHit {
    pub entity_id: EntityId,
    pub image_id: ImageId,
    pub world_position: [f64; 3],
    pub distance: f64,
}

impl Ray {
    pub fn new(origin: [f64; 3], direction: [f64; 3]) -> Self {
        let len = (direction[0] * direction[0]
            + direction[1] * direction[1]
            + direction[2] * direction[2])
            .sqrt();
        let dir = if len > 1e-12 {
            [direction[0] / len, direction[1] / len, direction[2] / len]
        } else {
            [0.0, 0.0, 1.0]
        };
        Ray {
            origin,
            direction: dir,
        }
    }

    /// Intersect this ray with the axis-aligned unit cube [0,1]^3.
    /// Returns the distance to the entry point, or None if no intersection.
    pub fn intersect_unit_cube(&self) -> Option<f64> {
        let mut tmin = f64::NEG_INFINITY;
        let mut tmax = f64::INFINITY;

        for i in 0..3 {
            if self.direction[i].abs() < 1e-12 {
                // Ray parallel to slab — check if origin is inside
                if self.origin[i] < 0.0 || self.origin[i] > 1.0 {
                    return None;
                }
            } else {
                let inv_d = 1.0 / self.direction[i];
                let mut t0 = (0.0 - self.origin[i]) * inv_d;
                let mut t1 = (1.0 - self.origin[i]) * inv_d;
                if inv_d < 0.0 {
                    std::mem::swap(&mut t0, &mut t1);
                }
                tmin = tmin.max(t0);
                tmax = tmax.min(t1);
                if tmin > tmax {
                    return None;
                }
            }
        }

        if tmax < 0.0 {
            return None; // Box is behind the ray
        }

        Some(if tmin >= 0.0 { tmin } else { tmax })
    }
}

/// Transform a ray by a 4x4 matrix (column-major, f32).
/// Used to move a world-space ray into member-local space via inv_model.
pub fn transform_ray(ray: &Ray, matrix: &[f32; 16]) -> Ray {
    let m = matrix;
    // Transform origin (point, w=1)
    let ox = m[0] as f64 * ray.origin[0]
        + m[4] as f64 * ray.origin[1]
        + m[8] as f64 * ray.origin[2]
        + m[12] as f64;
    let oy = m[1] as f64 * ray.origin[0]
        + m[5] as f64 * ray.origin[1]
        + m[9] as f64 * ray.origin[2]
        + m[13] as f64;
    let oz = m[2] as f64 * ray.origin[0]
        + m[6] as f64 * ray.origin[1]
        + m[10] as f64 * ray.origin[2]
        + m[14] as f64;

    // Transform direction (vector, w=0)
    let dx = m[0] as f64 * ray.direction[0]
        + m[4] as f64 * ray.direction[1]
        + m[8] as f64 * ray.direction[2];
    let dy = m[1] as f64 * ray.direction[0]
        + m[5] as f64 * ray.direction[1]
        + m[9] as f64 * ray.direction[2];
    let dz = m[2] as f64 * ray.direction[0]
        + m[6] as f64 * ray.direction[1]
        + m[10] as f64 * ray.direction[2];

    Ray::new([ox, oy, oz], [dx, dy, dz])
}

/// Transform a point by a 4x4 matrix (column-major, f32).
pub fn transform_point(point: &[f64; 3], matrix: &[f32; 16]) -> [f64; 3] {
    let m = matrix;
    [
        m[0] as f64 * point[0] + m[4] as f64 * point[1] + m[8] as f64 * point[2] + m[12] as f64,
        m[1] as f64 * point[0] + m[5] as f64 * point[1] + m[9] as f64 * point[2] + m[13] as f64,
        m[2] as f64 * point[0] + m[6] as f64 * point[1] + m[10] as f64 * point[2] + m[14] as f64,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ray_through_unit_cube_center() {
        let ray = Ray::new([0.5, 0.5, -1.0], [0.0, 0.0, 1.0]);
        let t = ray.intersect_unit_cube().unwrap();
        assert!((t - 1.0).abs() < 1e-10);
    }

    #[test]
    fn ray_misses_unit_cube() {
        let ray = Ray::new([2.0, 2.0, -1.0], [0.0, 0.0, 1.0]);
        assert!(ray.intersect_unit_cube().is_none());
    }

    #[test]
    fn ray_from_inside_cube() {
        let ray = Ray::new([0.5, 0.5, 0.5], [0.0, 0.0, 1.0]);
        let t = ray.intersect_unit_cube().unwrap();
        assert!(t >= 0.0); // Should hit the exit face
    }

    #[test]
    fn ray_behind_cube() {
        let ray = Ray::new([0.5, 0.5, 2.0], [0.0, 0.0, 1.0]); // pointing away
        assert!(ray.intersect_unit_cube().is_none());
    }

    #[test]
    fn ray_hit_serde_round_trip() {
        let hit = RayHit {
            entity_id: EntityId::from("e1"),
            image_id: ImageId::from("i1"),
            world_position: [1.0, 2.0, 3.0],
            distance: 5.0,
        };
        let json = serde_json::to_string(&hit).unwrap();
        let parsed: RayHit = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.entity_id, hit.entity_id);
        assert_eq!(parsed.distance, hit.distance);
    }

    #[test]
    fn transform_ray_identity() {
        let identity: [f32; 16] = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let ray = Ray::new([1.0, 2.0, 3.0], [0.0, 0.0, 1.0]);
        let transformed = transform_ray(&ray, &identity);
        for i in 0..3 {
            assert!(
                (transformed.origin[i] - ray.origin[i]).abs() < 1e-10,
                "origin mismatch at {i}"
            );
            assert!(
                (transformed.direction[i] - ray.direction[i]).abs() < 1e-10,
                "direction mismatch at {i}"
            );
        }
    }

    #[test]
    fn transform_point_with_translation() {
        // Translation matrix: translate by (10, 20, 30)
        let m: [f32; 16] = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 10.0, 20.0, 30.0, 1.0,
        ];
        let p = [1.0, 2.0, 3.0];
        let result = transform_point(&p, &m);
        assert!((result[0] - 11.0).abs() < 1e-10);
        assert!((result[1] - 22.0).abs() < 1e-10);
        assert!((result[2] - 33.0).abs() < 1e-10);
    }

    #[test]
    fn ray_direction_is_normalized() {
        let ray = Ray::new([0.0, 0.0, 0.0], [3.0, 4.0, 0.0]);
        let len = (ray.direction[0] * ray.direction[0]
            + ray.direction[1] * ray.direction[1]
            + ray.direction[2] * ray.direction[2])
            .sqrt();
        assert!((len - 1.0).abs() < 1e-10);
    }

    #[test]
    fn ray_zero_direction_defaults() {
        let ray = Ray::new([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]);
        assert_eq!(ray.direction, [0.0, 0.0, 1.0]);
    }
}
