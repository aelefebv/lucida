#%%
import numpy as np
import lucida

# Sample 3D data
data = np.random.rand(23, 10, 1000, 1000).astype(np.float32)
viewer = lucida.Viewer()
viewer.add_image(data, cmap='viridis', interp='nearest', order='TZYX')
viewer.run()