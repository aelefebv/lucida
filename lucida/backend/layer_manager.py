import numpy as np
import typing
if typing.TYPE_CHECKING:
    from lucida.backend.view_manager import View
from lucida.core.events import DimIndexChanged
from lucida.core.signal_bus import SignalBus
from vispy.scene.visuals import Volume, Image

Slice = dict[str, int]  # e.g. {"T": 3, "C": 1}

class Layer:
    def __init__(self, bus: SignalBus, *, 
                 data: np.ndarray, order: str,
                 name: str, 
                 visual: Volume | Image | None = None,
                 colormap: str = "grays",
                 interpolation: str = "nearest"):
        self._bus = bus
        self.data = data
        self.order = order
        self.name = name
        self.colormap = colormap
        self.interpolation = interpolation
        self.visual = visual
        
        self.indices: Slice = {}
        self._subscribe_to_events()
        self.render_shape: tuple | None = None
        
    # ----- PUBLIC API
    def as_render_array(self) -> np.ndarray:
        """Return a 2-D (YX) or 3-D (ZYX) view according to current indices."""
        keep = ("Z" in self.order) and "ZYX" or "YX"
        need_axes = [axis for axis in keep if axis in self.order]
        if any(k not in self.order for k in need_axes):
            raise ValueError("Need at least Y & X, plus Z if 3-D.")

        slicer = []
        for dim in self.order:
            if dim in need_axes:  # keep everything in this axis (i.e. Z, Y, and X)
                slicer.append(slice(None))
            else:  # Can only display one slice from these dimensions at a time
                idx = self.indices.get(dim, 0)
                # Ensure index is within bounds, otherwise use the first or last index
                max_idx = self.data.shape[self.order.index(dim)] - 1
                min_idx = 0
                idx = max(min(idx, max_idx), min_idx)
                slicer.append(idx)
                
        view = self.data[tuple(slicer)]
        present = [d for d, s in zip(self.order, slicer) if isinstance(s, slice)]
        axis_order = [present.index(d) for d in need_axes]
        out_view = np.transpose(view, axes=axis_order)
        self.render_shape = out_view.shape
        return out_view
    
    # ----- PRIVATE API
    def _subscribe_to_events(self):
        """Subscribe to relevant events."""
        self._bus.subscribe(DimIndexChanged, self._on_dim_index_changed)
        
    def _on_dim_index_changed(self, ev: DimIndexChanged) -> None:
        """Handle dimension index changes."""
        self._set_index(ev.dim, ev.value)
        
    def _set_index(self, dim: str, idx: int) -> None:
        """Set the index for a specific dimension."""
        if dim not in self.order or dim in "ZYX":
            return
        self.indices[dim] = idx
        self._update_layer()
        
    def _update_layer(self) -> None:
        if self.visual is None:
            return
        self.visual.cmap = self.colormap
        self.visual.interpolation = self.interpolation
        self.visual.set_data(self.as_render_array())
        
    def __eq__(self, other: object) -> bool: 
        return self is other

    __hash__ = object.__hash__

class LayerManager:
    def __init__(self, bus: SignalBus, view):
        self._bus = bus
        self.view: 'View' = view
        self.layers: dict[str, Layer] = {}
        
    def add_layer(self, layer: Layer) -> Volume | Image:
        """Add a layer to the manager and update the view."""
        if layer.name in self.layers:
            layer.name += "+"
        
        arr = layer.as_render_array()
        if arr.ndim not in (2, 3):
            raise ValueError("Layer data must be 2-D or 3-D after slicing.")
        if arr.ndim == 2:
            visual = Image(arr, cmap=layer.colormap, interpolation=layer.interpolation)
        else:
            visual = Volume(arr, cmap=layer.colormap, threshold=0.0,
                            method='iso', interpolation=layer.interpolation,
                            relative_step_size=0.1)
        layer.visual = visual
        self.layers[layer.name] = layer
        return layer.visual
        