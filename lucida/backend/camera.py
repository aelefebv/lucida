import numpy as np
from vispy import app
from vispy.scene.cameras import FlyCamera
from vispy.visuals.filters.clipping_planes import PlanesClipper
from vispy.scene.visuals import Volume

class LucidaFlyCamera(FlyCamera):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        
        self._clipper = PlanesClipper(coord_system='visual')
        self._plane = np.empty((1, 2, 3), dtype=np.float32)
        self.transform.changed.connect(self._update_clipping)
        
        self._volumes: list[Volume] = []
        # self.timertimer = app.Timer(interval = 0.5, connect=self._update_clipping, start=True)
        
    def register_volume(self, volume):
        """Register a volume to be clipped by this camera."""
        self._volumes.append(volume)

    def _update_clipping(self, event=None):
        n = self.rotation.inverse().rotate_point((0, 0, -1))
        n /= np.linalg.norm(n) 
        
        p = self.center + n * self.scale_factor
        self._plane[0, 0] = p
        self._plane[0, 1] = n
        
        self._clipper.clipping_planes = self._plane
        for volume in self._volumes:
            volume.clipping_planes = self._plane
