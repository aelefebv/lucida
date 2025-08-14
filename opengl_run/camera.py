from pyglm import glm

class Camera:
    def __init__(self, position = glm.vec3(), 
                 fov=45.0, aspect_ratio=1.0, near=0.1, far=100.0,
                 speed=2.5, sensitivity=1):
        self.position = position
        self.speed = speed
        self.sensitivity = sensitivity
        self.fov = fov
        self.aspect_ratio = aspect_ratio
        
        self.orientation = glm.quat(1.0, 0.0, 0.0, 0.0)  # identity quaternion (w, x, y, z)
        
        self.near = near
        self.far = far
        
        self.right: glm.vec3   = glm.vec3(1.0, 0.0, 0.0)  # right vector
        self.up: glm.vec3      = glm.vec3(0.0, 1.0, 0.0)
        self.forward: glm.vec3 = glm.vec3(0.0, 0.0, -1.0)  # looking down the negative z-axis
        self._update_basis()
        
        self.yaw = 0.0  # pivot around y-axis (horizontal rotation)
        self.pitch = 0.0  # pivot around x-axis (vertical rotation)
        self.roll = 0.0  # pivot around z-axis (roll.. rotation)
        
        self.applied_forces = glm.vec3()  # forces applied to the camera position
        
        self.proj = self._update_projection_matrix()
        
    def apply_force(self, force: glm.vec3):
        """Apply a force to the camera position."""
        self.applied_forces += force
        
    def _get_right(self):
        """Get the right vector of the camera."""
        return glm.normalize(glm.cross(self.forward, self.up))
    
    def _update_basis(self):
        self.right   = glm.normalize(self.orientation * glm.vec3(1, 0, 0))  # type: ignore
        self.up      = glm.normalize(self.orientation * glm.vec3(0, 1, 0))  # type: ignore
        self.forward = glm.normalize(self.orientation * glm.vec3(0, 0, -1))  # type: ignore
        
    def rotate(self, yaw_d: float, pitch_d: float, roll_d: float):
        yaw_q   = glm.angleAxis(glm.radians(yaw_d   * self.sensitivity), self.up)
        pitch_q = glm.angleAxis(glm.radians(pitch_d * self.sensitivity), self.right)
        roll_q  = glm.angleAxis(glm.radians(roll_d  * self.sensitivity), self.forward)
        
        dq = roll_q * pitch_q * yaw_q
        self.orientation = glm.normalize(dq * self.orientation)
        self._update_basis()
        
    def update(self, dt: float):
        """Update the camera position based on pressed keys."""
        self.position += self.applied_forces * self.speed * dt
        self.applied_forces = glm.vec3()  # reset forces
        
    def set_fov(self, fov: float):
        """Set the field of view."""
        self.fov = max(1.0, min(fov, 179.0))
        self._update_projection_matrix()
        print(f"FOV set to: {self.fov}")
        
    def set_near(self, near: float):
        """Set the near clipping plane."""
        self.near = max(0.01, near)
        self.near = min(self.near, self.far - 0.01)
        self._update_projection_matrix()
        
    def _update_projection_matrix(self):
        """Update the projection matrix based on the current FOV and aspect ratio."""
        self.proj = glm.perspective(glm.radians(self.fov), self.aspect_ratio, self.near, self.far)
        return self.proj
    