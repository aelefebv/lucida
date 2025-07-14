from vispy import scene, app
from vispy.scene.visuals import Volume
import numpy as np

# Sample 3D data
data = np.random.rand(64, 64, 64).astype(np.float32)
app.use_app('glfw')
canvas = scene.SceneCanvas(keys='interactive', show=True)
view = canvas.central_widget.add_view()
volume = Volume(data, threshold=0.2, cmap='viridis')
view.add(volume)

# Use a 3D camera
view.camera = scene.cameras.TurntableCamera(fov=60)

app.run()