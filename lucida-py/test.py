#%%
from lucida import Viewer

v = Viewer()
v.start()

# Check our server-assigned ID
print(v.client_id)  # e.g. 1

# See who else is connected
print(v.peer_ids())  # e.g. [2, 3]
print(v.peers)       # full presence data (camera, view, display, following)

#%%
follow = 1

#%% Following a peer

# Start following peer 2 — your viewport syncs to theirs in real-time
v.follow(follow)

# Confirm
print(v.follow_target)  # 2

# As peer 2 pans/zooms/changes slice, your scene updates automatically
print(v.center())  # matches peer 2's center
print(v.z())       # matches peer 2's z-slice

#%% Breaking follow

# Follow breaks automatically when you issue any viewport command:

v.follow(follow)
v.pan(10, 0)            # breaks follow, moves independently
print(v.follow_target)  # None

#%% Or break it explicitly:

v.follow(follow)
v.unfollow()
print(v.follow_target)  # None

# %%
v.follow(follow)
vd = v.read_viewport()
print(vd.data.shape)

# %% Local mode data retrieval
from lucida import Viewer

v = Viewer()
v.start()

# Set up a layer so chunk_plan() knows the grid
# (or follow a peer who already loaded data)
v.follow(1)

vd = v.read_viewport("/path/to/dataset.ome.zarr")
print(vd.data.shape)   # e.g. (17, 128, 256) — Z, Y, X
print(vd.origin)       # (0, 0, 0) — voxel offset at this level
print(vd.level)        # 0

# It's a regular numpy array
import numpy as np
print(np.mean(vd.data))

#%%
from lucida import Viewer
# Remote mode — data was loaded by another client (e.g. the web viewer):

v = Viewer()
v.start()
#%%
v.follow(3)  # follow the peer viewing data

# No store_path → fetches chunks through the server
vd = v.read_viewport()
print(vd.data.shape)
# %%
import matplotlib.pyplot as plt
plt.imshow(vd.data[50])  # show the first Z-slice
# %%
# %%
from lucida import Viewer                                                                       
v = Viewer()
v.start()        
v.peers
#%%
v.follow(2)                                                                                     
# List datasets                                                                                 
print(v.datasets)  # [{id: "abc", name: "CT", ...}, {id: "def", name: "MR", ...}]               

#%%
# Read by index                                                                                 
vd0 = v.read_viewport(dataset='yeast_3d_mitochondria_large.ome.zarr')      

#%%
import matplotlib.pyplot as plt
plt.imshow(vd0.data[12])  # show the first Z-slice

#%%                                                          
vd0 = v.read_viewport(dataset=0)                                                                
vd1 = v.read_viewport(dataset=1)                                                                

# Read by name                                                                                  
# vd = v.read_viewport(dataset="CT")                                                              

# Read by id                                                                                    
# vd = v.read_viewport(dataset="abc")                                                             

# Per-dataset chunk plan                                                                        
plan = v.chunk_plan_for(dataset=0)
# %%
import scipy.ndimage as ndi
# Apply a Gaussian filter to the data
filtered = ndi.gaussian_filter(vd0.data, sigma=3)
vd0.data = filtered
# %%
ds_id = v.write_viewport(vd0, name="filtered2")
# %%
import numpy as np
masked = filtered > 102
vd0.data = masked.astype(np.uint16) * 255
ds_id = v.write_viewport(vd0, name="masked")
# TODO: bug where only uint16 works. uint8 and bool both break.

# %%
