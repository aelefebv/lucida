#%%
ipython=False
try:
    from IPython.core.getipython import get_ipython
    ip = get_ipython()
    if ip is not None:
        ipython=True
        ip.run_line_magic("gui", "qt")
except Exception: pass
    
print(ipython)

from vispy import scene, app
from vispy.scene.visuals import Volume
from vispy.scene.widgets import Widget
from vispy.scene.widgets.viewbox import ViewBox
import numpy as np

# Initial sample 3D data
data = np.random.rand(64, 64, 64).astype(np.float32)

# Setup
app.use_app('pyqt6')
canvas = scene.SceneCanvas(keys='interactive', show=True)
central_widget: Widget = canvas.central_widget
view: ViewBox = central_widget.add_view()

# Create a Volume visual object once
volume = Volume(data, threshold=0.2, cmap='viridis')
view.add(volume)

# Use a 3D camera
view.camera = scene.cameras.TurntableCamera(fov=60)

# Set the real update after 2 seconds
# %%
new_data = np.random.rand(128, 128, 128)  # New random data
volume.set_data(new_data.astype(np.float32))
canvas.update()
# %%

from vispy.scene import Text
from vispy.app import Timer

# Add a text visual to display FPS
fps_text = Text('', color='white', font_size=14)
fps_text.pos = 0, 0  # Bottom right (approx.)
view.add(fps_text)
canvas.update()

# Update callback for FPS display
def update_fps(event):
    print(f"Canvas FPS: {canvas.fps:.1f}")
    fps_text.text = f"{canvas.fps:.1f} FPS"

# Resize callback to reposition the text on resize
@canvas.events.resize.connect
def on_resize(event):
    fps_text.pos = canvas.size[0] - 60, 20

# Timer to refresh the FPS text every 0.25 seconds
fps_timer = Timer(0.25, connect=update_fps, start=True)
view.add(fps_timer)

if not ipython:
    print("Running app.run() since not in IPython")
    app.run()