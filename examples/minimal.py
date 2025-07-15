import numpy as np
from lucida import Viewer

def main() -> None:
    viewer = Viewer()
    viewer.set_logging(stdout=True, level="DEBUG")
    
    data = np.random.rand(20, 30, 40, 50).astype(np.float32)  # 3D volume
    viewer.add_image(data, order="TZYX", cmap="viridis", interp="linear")
    
    data2 = np.random.rand(100, 100).astype(np.float32)  # 2D image
    viewer.add_image(data2, order="YX", cmap="grays", interp="nearest")
    
    print("Starting viewer...")
    viewer.run()
