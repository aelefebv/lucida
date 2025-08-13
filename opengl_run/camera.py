from pyglm import glm
import glfw

class Camera:
    def __init__(self, 
                 position = glm.vec3(0.0, 0.0, 3.0),   # a bit back
                 front =    glm.vec3(0.0, 0.0, -1.0),  # looking through z
                 up =       glm.vec3(0.0, 1.0, 0.0),  # y is up
                 fov = 45.0,
                 aspect_ratio = 1.0,
                 speed = 2.5,
                ):
        self.position = position
        self.forward = front
        self.up = up
        self.right = self._get_right()
        self.fov = fov
        self.aspect_ratio = aspect_ratio
        self.speed = speed
        
        self.applied_forces = glm.vec3()  # forces applied to the camera position
        
    def apply_force(self, force: glm.vec3):
        """Apply a force to the camera position."""
        self.applied_forces += force
        
    def _get_right(self):
        """Get the right vector of the camera."""
        return glm.normalize(glm.cross(self.forward, self.up))
    
    def update(self, pressed_keys: set, dt: float):
        """Update the camera position based on pressed keys."""
        if glfw.KEY_W in pressed_keys:
            self.apply_force(self.forward)
        if glfw.KEY_A in pressed_keys:
            self.apply_force(-self.right)
        if glfw.KEY_S in pressed_keys:
            self.apply_force(-self.forward)
        if glfw.KEY_D in pressed_keys:
            self.apply_force(self.right)
        if glfw.KEY_Q in pressed_keys:
            self.apply_force(-self.up)
        if glfw.KEY_E in pressed_keys:
            self.apply_force(self.up)
            
        # Update the camera position
        self.position += self.applied_forces * self.speed * dt
        self.applied_forces = glm.vec3()  # reset forces
            