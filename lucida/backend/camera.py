import numpy as np
from vispy.scene.cameras import FlyCamera
from vispy.visuals.filters.clipping_planes import PlanesClipper
from vispy.scene.visuals import Plane
from vispy.visuals.transforms import MatrixTransform

class LucidaFlyCamera(FlyCamera):
    def __init__(self, *, debug_plane=True, **kwargs):
        super().__init__(**kwargs)
        
        self.plane_clipper = PlanesClipper()
        
        self.transform.changed.connect(self._update_plane)

    def _update_plane(self, event=None):
        clip_distance = 0.5 * self.scale_factor
        n = np.array(self.rotation.inverse().rotate_point((0, 0, -1)), dtype=np.float32)
        n /= np.linalg.norm(n)           # normal
        p = np.array(self.center, dtype=np.float32) + n * clip_distance

        self.plane_clipper.clipping_planes = np.array([[p, n]], dtype=np.float32)
        
