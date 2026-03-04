/// Camera state: where we're looking and how zoomed in.
#[derive(Debug, Clone, PartialEq)]
pub struct Camera {
    /// Center of the viewport in world coordinates.
    pub center: [f64; 2],
    /// Zoom level. 1.0 = native resolution, 2.0 = 2x magnification.
    pub zoom: f64,
    /// Viewport size in screen pixels.
    pub viewport: [u32; 2],
}

impl Camera {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            center: [0.0, 0.0],
            zoom: 1.0,
            viewport,
        }
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        self.center[0] += dx / self.zoom;
        self.center[1] += dy / self.zoom;
    }

    pub fn zoom_by(&mut self, factor: f64) {
        self.zoom *= factor;
    }

    /// The visible region in world coordinates: (min_x, min_y, max_x, max_y).
    pub fn world_bounds(&self) -> [f64; 4] {
        let half_w = (self.viewport[0] as f64) / (2.0 * self.zoom);
        let half_h = (self.viewport[1] as f64) / (2.0 * self.zoom);
        [
            self.center[0] - half_w,
            self.center[1] - half_h,
            self.center[0] + half_w,
            self.center[1] + half_h,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_camera_centered_at_origin() {
        let cam = Camera::new([800, 600]);
        assert_eq!(cam.center, [0.0, 0.0]);
        assert_eq!(cam.zoom, 1.0);
    }

    #[test]
    fn pan_moves_center_in_world_space() {
        let mut cam = Camera::new([800, 600]);
        cam.pan(100.0, -50.0);
        assert_eq!(cam.center, [100.0, -50.0]);
    }

    #[test]
    fn pan_is_scaled_by_zoom() {
        let mut cam = Camera::new([800, 600]);
        cam.zoom = 2.0;
        cam.pan(100.0, 0.0);
        // At 2x zoom, 100 screen pixels = 50 world units
        assert_eq!(cam.center[0], 50.0);
    }

    #[test]
    fn world_bounds_at_default_zoom() {
        let cam = Camera::new([800, 600]);
        let [min_x, min_y, max_x, max_y] = cam.world_bounds();
        assert_eq!(min_x, -400.0);
        assert_eq!(min_y, -300.0);
        assert_eq!(max_x, 400.0);
        assert_eq!(max_y, 300.0);
    }

    #[test]
    fn world_bounds_shrink_when_zoomed_in() {
        let mut cam = Camera::new([800, 600]);
        cam.zoom_by(2.0);
        let [min_x, min_y, max_x, max_y] = cam.world_bounds();
        assert_eq!(min_x, -200.0);
        assert_eq!(min_y, -150.0);
        assert_eq!(max_x, 200.0);
        assert_eq!(max_y, 150.0);
    }
}
