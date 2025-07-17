import numpy as np
from vispy import app, scene
from vispy.visuals.filters import ShaderFilter

# Create a synthetic 3D volume (e.g., Gaussian blob)
data = np.random.normal(size=(64, 64, 64), loc=0.5, scale=0.15).astype(np.float32)

# Create canvas with 3D view and FlyCamera
canvas = scene.SceneCanvas(keys='interactive', size=(800, 600), show=True)
view = canvas.central_widget.add_view()
view.camera = scene.cameras.FlyCamera(fov=60, distance=2.0)
view.camera.up = '+y'

# Add volume
volume = scene.visuals.Volume(data, parent=view.scene, threshold=0.3, emulate_texture=True)

# Define GLSL clipping shader
clip_shader = """
uniform vec4 u_clip_plane;
void modify_main() {
    if (dot($position.xyz, u_clip_plane.xyz) - u_clip_plane.w < 0.0) {
        discard;
    }
}
"""

# Create and attach shader filter
shader_filter = ShaderFilter(clip_shader)
volume.attach(shader_filter)

# Update clipping plane on every frame
def on_timer(event):
    cam = view.camera
    # Camera forward direction in world space
    view_dir = cam.transform.map([0, 0, -1, 0])[:3]
    view_dir /= np.linalg.norm(view_dir)

    # Camera position in world space
    cam_pos = cam.transform.map([0, 0, 0, 1])[:3]

    # Distance = dot(normal, position)
    distance = np.dot(view_dir, cam_pos)

    # Update shader uniform
    shader_filter.shader['u_clip_plane'] = tuple(view_dir) + (distance,)

# Start timer
timer = app.Timer('auto', connect=on_timer, start=True)

# Run
if __name__ == '__main__':
    app.run()
