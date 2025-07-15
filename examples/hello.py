
from PySide6.QtCore import Qt
import numpy as np

from lucida.backend.viewer_controller import ViewerController
from vispy.scene.visuals import Volume

from lucida import lucida

def main():
    viewer = lucida.Viewer()
    viewer.vc.add_view(0, 0, "Arcball")
    viewer.vc.add_view(0, 1)
    
    data = np.random.rand(30, 40, 50).astype(np.float32)  # 3D volume
    vols = []
    for view in viewer.vc.views:
        vol = Volume(data, interpolation='nearest', cmap='viridis')
        print("Setting camera for view", view)
        view.add(vol)
        vols.append(vol)
    volume_center = np.array(data.shape) / 2
    clipping_plane_normal = np.array([0.71, 0.71, 0])
    clipping_plane = np.array([[volume_center, clipping_plane_normal]])
    vols[0].clipping_planes = clipping_plane
    
    # Add a third view from the clipping plane's perspective
    viewer.vc.add_view(1, 0)
    clipping_view = viewer.vc.views[-1]  # Get the newly added view

    # Create volume for the clipping plane view
    clipping_vol = Volume(data, interpolation='nearest', cmap='viridis')
    clipping_vol.clipping_planes = clipping_plane
    clipping_view.add(clipping_vol)
    vols.append(clipping_vol)

    for view in viewer.vc.views:
        view.camera.center = tuple(volume_center.tolist())
        view.camera.set_range(x=(0, data.shape[2]), y=(0, data.shape[1]), z=(0, data.shape[0]))
    # Position camera at clipping plane position looking along the normal
    clipping_view.camera.center = tuple(volume_center.tolist())
    # Set camera azimuth and elevation to align with clipping plane normal
    # Calculate angles from the normal vector
    azimuth = np.degrees(np.arctan2(-clipping_plane_normal[0], clipping_plane_normal[1]))
    elevation = np.degrees(np.arcsin(clipping_plane_normal[2] / np.linalg.norm(clipping_plane_normal)))
    clipping_view.camera.azimuth = azimuth
    clipping_view.camera.elevation = elevation
    print(clipping_view.camera.get_state())
    
    new_view = viewer.vc.add_view(1, 1)
    new_view.add(Volume(
        data,
        raycasting_mode='plane',
        method='mip',
        plane_thickness=10.0,
        plane_position=volume_center.tolist(),
        plane_normal=(0, 0.71, 0.71),
        interpolation='nearest',
        cmap='viridis',
        clim=(0, 1),
    ))
    new_view.camera.center = tuple(volume_center.tolist())
    new_view.camera.set_range(x=(0, data.shape[2]), y=(0, data.shape[1]), z=(0, data.shape[0]))

    viewer.window.show()
    viewer.app.exec()