import numpy as np
from vispy import app
from vispy.scene.cameras import FlyCamera
from vispy.visuals.filters.clipping_planes import PlanesClipper
from vispy.scene.visuals import Volume
from vispy.util import keys

class LucidaFlyCamera(FlyCamera):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.auto_roll = False
        
        self._clipper = PlanesClipper(coord_system='visual')
        self._plane = np.empty((1, 2, 3), dtype=np.float32)
        self.transform.changed.connect(self._update_clipping)
        
        self._volumes: list[Volume] = []
        
        self._keymap = {
            'W': (+1, 1), 'S': (-1, 1),  # forward/backward
            'D': (+1, 2), 'A': (-1, 2),  # strafe right/left
            'Q': (+1, 6), 'E': (-1, 6),  # rotate CW/CCW
         
            'I': (+1, 4), 'K': (-1, 4),  # pitch up/down
            'L': (+1, 5), 'J': (-1, 5),  # yaw right/left
            'O': (+1, 3), 'U': (-1, 3),  # strafe up/down
         
            keys.SPACE: (0, 1, 2, 3),  # 0 means brake, apply to translation
        }
        
    def register_volume(self, volume):
        """Register a volume to be clipped by this camera."""
        self._volumes.append(volume)

    def _update_clipping(self, event=None):
        n = self.rotation.inverse().rotate_point((0, 0, -1))
        n /= np.linalg.norm(n) 
        
        p = self.center + n * (self.scale_factor * 0.5)
        self._plane[0, 0] = p
        self._plane[0, 1] = n
        
        self._clipper.clipping_planes = self._plane
        for volume in self._volumes:
            volume.clipping_planes = self._plane
