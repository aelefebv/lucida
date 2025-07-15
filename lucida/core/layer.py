from __future__ import annotations
from dataclasses import dataclass, field
from typing import Mapping
import numpy as np
from vispy.scene.visuals import Volume, Image

from lucida.core.events import Event
from lucida.core.signal_bus import SignalBus

Slice = dict[str, int]  # e.g. {"T": 3, "C": 1}

@dataclass(slots=True, frozen=True)
class LayerUpdateEvent(Event):
    layer: Layer
    changed: str  # e.g. "indices", "data", "colormap"
    _ignore_attrs = {"layer"}  # avoid logging full layer data
    __log__ = True
    

@dataclass(slots=True)
class Layer:
    data: np.ndarray  # the full  N-D array
    order: str  # axis-label string, e.g."TCZYX"
    bus: SignalBus 
    name: str = "layer"
    colormap: str = "grays"
    interpolation: str = "nearest"
    visual: Volume | Image | None = None  # optional, if you want to force a specific visual class (Volume/Image)

    # public state for "extra" dims
    indices: Slice = field(default_factory=dict)   # which slice on each non-render dim
                                                   # e.g. {"T":0,"C":1}

    # Public API
    def as_render_array(self) -> np.ndarray:
        """Return a 2-D (YX) or 3-D (ZYX) view according to current indices."""
        # figure out axes to keep
        keep = ("Z" in self.order) and "ZYX" or "YX"
        need_axes = [a for a in keep if a in self.order]
        if any(k not in self.order for k in need_axes):
            raise ValueError("Need at least Y & X, plus Z if 3-D.")

        slicer = []
        for dim in self.order:
            if dim in need_axes:
                slicer.append(slice(None))
            else:
                slicer.append(self.indices.get(dim, 0))
        view = self.data[tuple(slicer)]  # no copy

        # move axes so they end in YX or ZYX
        present = [d for d,s in zip(self.order, slicer) if isinstance(s, slice)]
        axis_order = [present.index(d) for d in need_axes]
        return np.transpose(view, axis_order)

    def set_index(self, dim: str, idx: int) -> None:
        if dim not in self.order or dim in "ZYX":
            raise ValueError(f"Cannot index dim {dim!r}")
        self.indices[dim] = idx
        self.bus.emit(LayerUpdateEvent(layer=self, changed="indices"))

    def set_colormap(self, cm: str) -> None:
        self.colormap = cm
        
    @property
    def shape_by_dim(self) -> Mapping[str, int]:
        """
        Mapping of dimension letter → axis length, based on this layer’s
        declared order string.

        Example
        -------
        >>> layer.order        # "TCYX"
        >>> layer.data.shape   # (23, 10, 512, 512)
        >>> layer.shape_by_dim
        {'T': 23, 'C': 10, 'Y': 512, 'X': 512}
        """
        return {d: self.data.shape[i] for i, d in enumerate(self.order)}
    
    # ----- Internals
    def __eq__(self, other: object) -> bool: 
        return self is other

    __hash__ = object.__hash__
        
class LabelsLayer(Layer):  # segmentation masks
    opacity: float = 0.5