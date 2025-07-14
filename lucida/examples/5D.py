import numpy as np
from vispy import scene, app
from vispy.app import Timer
from vispy.scene.visuals import Volume

# ------ SETTINGS ------
NUM_T = 10
NUM_C = 3
VOLUME_SHAPE = (64, 64, 64)

# Simulate 5D dataset: (Z, Y, X, T, C)
data = np.random.rand(*VOLUME_SHAPE, NUM_T, NUM_C).astype(np.float32)

# Initial time/channel
t_index = 0
c_index = 0

# ------ CANVAS & VIEW ------
app.use_app('glfw')
canvas = scene.SceneCanvas(keys='interactive', show=True)
view = canvas.central_widget.add_view()
view.camera = scene.cameras.TurntableCamera(fov=60)

# ------ VOLUME VISUAL ------
volume = Volume(data[..., t_index, c_index],
                        threshold=0.2, cmap='viridis')
view.add(volume)
volume.method = 'mip'  # Or 'iso' for isosurface

# ------ SLIDER LOGIC (COMMAND LINE) ------
def update_volume(t=None, c=None):
    global t_index, c_index
    if t is not None:
        t_index = t % NUM_T
    if c is not None:
        c_index = c % NUM_C
    volume.set_data(data[..., t_index, c_index])
    # update
    canvas.update()


# ------ KEYBOARD CONTROLS ------
@canvas.connect
def on_key_press(event):
    global t_index, c_index, autoplay
    if event.key.name in ['Right', 'D']:
        print(f"Time index: {t_index} -> {(t_index + 1) % NUM_T}, Channel index: {c_index}")
        update_volume(t=(t_index + 1))
    elif event.key.name in ['Left', 'A']:
        update_volume(t=(t_index - 1))
    elif event.key.name in ['Up', 'W']:
        update_volume(c=(c_index + 1))
    elif event.key.name in ['Down', 'S']:
        update_volume(c=(c_index - 1))
    elif event.key.name == 'Space':
        autoplay = not autoplay
        timer.start() if autoplay else timer.stop()
    elif event.key.name == 'R':
        view.camera.set_range()

# ------ AUTOPLAY TIMER ------
autoplay = False
def on_timer(event):
    update_volume(t=(t_index + 1))
    

timer = Timer(interval=0.3, connect=on_timer, start=False)

# ------ INFO ------
print("""
🧠 Controls:
  → or D: next time point
  ← or A: previous time point
  ↑ or W: next channel
  ↓ or S: previous channel
  Space: toggle autoplay
  R: reset view
""")

# ------ RUN ------
if __name__ == '__main__':
    app.run()