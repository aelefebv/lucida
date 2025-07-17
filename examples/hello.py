import numpy as np
from lucida import lucida
import tifffile

def main():
    
    viewer = lucida.Viewer()    
    viewer.vwm.add_view("default", grid_xy=(1, 0), span_xy=(4, 4), camera_type="Fly")
    
    viewer.vwm.add_view("left", grid_xy=(0, 0), span_xy=(1, 4))
    viewer.vwm.add_view("minimap", grid_xy=(0, 4), span_xy=(1, 1))
    
    data = np.random.rand(20, 20, 30, 40, 50).astype(np.float32)  # 3D volume
    viewer.add_image(data, order="TCZYX",
                     colormap="viridis", interpolation="nearest")
    
    data = np.random.rand(30, 20, 100, 100).astype(np.float32)  # 2D volume
    viewer.add_image(data, order="TCYX")

    # im_path = r"D:\test_files\nellie_all_tests\yeast_3d_mitochondria.ome.tif"
    im_path = "/Users/austin/test_files/nellie_all_tests/yeast_3d_mitochondria.ome.tif"; order = "TZYX"
    # im_path = "/Users/austin/test_files/nellie_all_tests/test.tif"; order = "ZYX"
    im_data = tifffile.imread(im_path)
    viewer.add_image(im_data, order=order, layer_name="Yeast Mitochondria",
                     colormap="viridis", interpolation="nearest")
    viewer.run()