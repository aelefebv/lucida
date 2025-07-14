#%%
import numpy as np
import lucida

# Sample 3D data
data = np.random.rand(23, 10, 1000, 1000).astype(np.float32)

viewer = lucida.Viewer()
viewer.set_logging(stdout=True, level="INFO")  # turn on logging to stdout
im_layer = viewer.add_image(data, cmap='viridis', interp='nearest', order='TZYX')
im_layer.set_index('T', 5)  # set time index to 5
viewer.run()