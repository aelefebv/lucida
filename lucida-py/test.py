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
# Remote mode — data was loaded by another client (e.g. the web viewer):

v = Viewer()
v.start()
v.follow(1)  # follow the peer viewing data

# No store_path → fetches chunks through the server
vd = v.read_viewport()
print(vd.data.shape)
# %%
import matplotlib.pyplot as plt
plt.imshow(vd.data[50])  # show the first Z-slice
# %%
# %%
