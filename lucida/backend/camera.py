import math
import numpy as np
from vispy.scene.cameras import FlyCamera
from vispy.visuals.filters.clipping_planes import PlanesClipper
from vispy.scene.visuals import Volume
from vispy.util import keys
from vispy.scene.events import SceneMouseEvent
from vispy.app.canvas import MouseEvent
from vispy.util.quaternion import Quaternion


class LucidaFlyCamera(FlyCamera):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.auto_roll = False
        
        self._keymap = {
            'W': (+1, 1), 'S': (-1, 1),  # forward/backward
            'D': (+1, 2), 'A': (-1, 2),  # strafe right/left
            'E': (+1, 3), 'Q': (-1, 3),  # strafe up/down
         
            'I': (+1, 4), 'K': (-1, 4),  # pitch up/down
            'L': (+1, 5), 'J': (-1, 5),  # yaw right/left
            'U': (+1, 6), 'O': (-1, 6),  # rotate CW/CCW
         
            keys.SPACE: (0, 1, 2, 3),  # 0 means brake, apply to translation
        }
        
        self._volumes_to_clip: list[Volume] = []
        self._clipper = PlanesClipper(coord_system='scene')
        self._clipper_plane = np.empty((1, 2, 3), dtype=np.float32)
        self._clipper_distance = 100  # Distance from the camera to the clipping plane'
        self._clipper_center = self.center
        self._clipper_rotation = self.rotation
        self._clipper_on_camera = True
        self._clipper_rotating = False
        
        self.transform.changed.connect(self._on_transform_changed)
        
    def register_volume_to_clip(self, volume):
        """Register a volume to be clipped by this camera."""
        self._volumes_to_clip.append(volume)
        
    def viewbox_mouse_event(self, event):
        """
        Handle mouse events in the viewbox. Mostly used to override the default behavior.
        Also adds clipping plane control.
        """
        if not isinstance(event, SceneMouseEvent):
            return
        if event.handled or not self.interactive:
            return
        
        # Type assertion to tell the type checker this attribute exists, since stub is incomplete
        mouse_evt: MouseEvent | None = getattr(event, 'mouse_event', None)
        
        if event.type == 'mouse_wheel' and mouse_evt:
            self._handle_scroll_event(event, mouse_evt)
            
        if event.type == 'mouse_press' and mouse_evt:
            self._handle_mouse_press_event(event, mouse_evt)

        if event.type == 'mouse_release' and mouse_evt:
            self._handle_mouse_release_event(event, mouse_evt)
        elif not self._timer.running:  # type: ignore
            # Ensure the timer runs
            self._timer.start()  # type: ignore
            
        if event.type == 'mouse_move' and mouse_evt:
            self._handle_mouse_move_event(event, mouse_evt)

        # Make transform be updated on the next timer tick.
        # By doing it at timer tick, we avoid shaky behavior
        self._update_from_mouse = True
        
    def _on_transform_changed(self, event=None):
        if not self._clipper_rotating and self._clipper_on_camera:
            self._clipper_rotation = self.rotation
        self._update_clipping(event)

    def _update_clipping(self, event=None):
        # if not self._clipper_on_camera: return
        n = self._clipper_rotation.inverse().rotate_point((0, 0, -1))
        n /= np.linalg.norm(n) 
        
        if self._clipper_on_camera:
            self._clipper_center = self.center
            
        self._clipper_plane[0, 0] = self._clipper_center + n * self._clipper_distance
        self._clipper_plane[0, 1] = n
        
        self._clipper.clipping_planes = self._clipper_plane
        for volume in self._volumes_to_clip:
            volume.clipping_planes = self._clipper_plane
            
    def _handle_scroll_event(self, event: SceneMouseEvent, mouse_evt: MouseEvent):
        dist_mult = 0.25
        if keys.SHIFT in mouse_evt.modifiers:  # speed up clip distance movement if shift is held
            dist_mult = 5
        self._clipper_distance -= event.delta[1] * dist_mult
        
    def _handle_mouse_press_event(self, event: SceneMouseEvent, mouse_evt: MouseEvent):
        event.handled = True
        
        right_click = 2 in event.buttons
        middle_click = 3 in event.buttons
        if right_click:
            self._clipper_rotation = self.rotation
        if middle_click:
            self._reset_clipper()
        
    def _handle_mouse_release_event(self, event: SceneMouseEvent, mouse_evt: MouseEvent):
        # Reset the event value on mouse release
        self._event_value = None
        # Apply rotation
        self._rotation1 = (self._rotation2 * self._rotation1).normalize()
        self._rotation2 = Quaternion()
        event.handled = True
        
        if self._clipper_rotating:
            self._clipper_rotating = False
            self._clipper_on_camera = False
            
        
    def _handle_mouse_move_event(self, event: SceneMouseEvent, mouse_evt: MouseEvent):
        if event.press_event is None:
            return
        if not event.buttons:
            return

        # Prepare
        modifiers = mouse_evt.modifiers
        pos1 = mouse_evt.press_event.pos
        pos2 = mouse_evt.pos
        w, h = self._viewbox.size  # type: ignore

        left_click = 1 in event.buttons
        right_click = 2 in event.buttons
        if (left_click or right_click) and not modifiers:
            # get normalized delta values
            d_az = -float(pos2[0] - pos1[0]) / w
            d_el = +float(pos2[1] - pos1[1]) / h
            
            # Apply gain
            d_az *= - 0.5 * math.pi
            d_el *= + 0.5 * math.pi
            
            # Create temporary quaternions
            q_az = Quaternion.create_from_axis_angle(d_az, 0, 1, 0)
            q_el = Quaternion.create_from_axis_angle(d_el, 1, 0, 0)

            rotation = (q_el.normalize() * q_az).normalize()
            if left_click:
                # Rotate the camera
                # apply to global quaternion
                self._rotation2 = rotation
                event.handled = True
        
            elif right_click:
                # Rotate the clipping plane and unstick it from the camera
                self._clipper_rotation = rotation
                self._clipper_rotating = True
                self._update_clipping(event)
                
    def _reset_clipper(self):
        """Reset the clipper to its initial state."""
        self._clipper_distance = 100
        self._clipper_rotation = self.rotation
        self._clipper_on_camera = True
        self._clipper_rotating = False
        self._update_clipping()
        
    def reset(self):
        """Reset the camera to its initial state (including clipper)."""
        super().reset()
        self._reset_clipper()
        