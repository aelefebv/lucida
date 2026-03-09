#%%
from lucida import Viewer

v = Viewer()
v.start()

# Check our server-assigned ID
print(v.client_id)  # e.g. 1

# See who else is connected
print(v.peer_ids())  # e.g. [2, 3]
print(v.peers)       # full presence data (camera, view, display, following)

#%% Following a peer

# Start following peer 2 — your viewport syncs to theirs in real-time
v.follow(0)

# Confirm
print(v.follow_target)  # 2

# As peer 2 pans/zooms/changes slice, your scene updates automatically
print(v.center())  # matches peer 2's center
print(v.z())       # matches peer 2's z-slice

#%% Breaking follow

# Follow breaks automatically when you issue any viewport command:

v.follow(0)
v.pan(10, 0)            # breaks follow, moves independently
print(v.follow_target)  # None

#%% Or break it explicitly:

v.follow(0)
v.unfollow()
print(v.follow_target)  # None

# %%
