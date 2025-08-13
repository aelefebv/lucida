from pyglm import glm

class Camera:
    def __init__(self, 
                 position = glm.vec3(0.0, 0.0, 3.0),   # a bit back
                 front =    glm.vec3(0.0, 0.0, -1.0),  # looking through z
                 up =       glm.vec3(0.0, 1.0, 0.0),  # y is up
                 fov = 45.0,
                 aspect_ratio = 1.0,
                 speed = 0.05,
                ):
        self.position = position
        self.forward = front
        self.up = up
        self.right = self._get_right()
        self.fov = fov
        self.aspect_ratio = aspect_ratio
        self.speed = speed
        
    def apply_force(self, force: glm.vec3):
        """Apply a force to the camera position."""
        self.position += force * self.speed
        
    def _get_right(self):
        """Get the right vector of the camera."""
        return glm.normalize(glm.cross(self.forward, self.up))