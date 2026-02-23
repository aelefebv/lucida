"""Pydantic models that describe the client-facing view state."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


AxisSelectorKind = Literal["index", "range", "set"]
RenderMode = Literal["2d", "3d"]


class ModelBase(BaseModel):
    """Shared base model with strict schema validation.

    Attributes
    ----------
    model_config:
        Pydantic v2 model configuration that forbids extra fields.
    """
    model_config = ConfigDict(extra="forbid")


class DatasetRef(ModelBase):
    """Reference to a dataset used by a view.

    Attributes
    ----------
    dataset_id:
        Dataset identifier.
    multiscale_name:
        Name of the multiscale used by the layer/view.
    """
    dataset_id: str = Field(min_length=1)
    multiscale_name: str = Field(min_length=1)


class Viewport(ModelBase):
    """Target pixel extent for rendering output.

    Attributes
    ----------
    width_px:
        Viewport width.
    height_px:
        Viewport height.
    pixel_ratio:
        Device pixel ratio.
    """
    width_px: int = Field(ge=1)
    height_px: int = Field(ge=1)
    pixel_ratio: float = Field(default=1.0, ge=0.5)


class AxisSelector(ModelBase):
    """Selector applied to a single axis.

    Attributes
    ----------
    axis:
        Axis name.
    kind:
        Selector kind (index, range, set).
    index:
        Single index when ``kind='index'``.
    start:
        Range start when ``kind='range'``.
    end_exclusive:
        Range end when ``kind='range'``.
    indices:
        Set entries when ``kind='set'``.
    clamp:
        Whether out-of-range values should be clamped.
    """
    axis: str = Field(min_length=1)
    kind: AxisSelectorKind
    index: int | None = Field(default=None, ge=0)
    start: int | None = Field(default=None, ge=0)
    end_exclusive: int | None = Field(default=None, ge=1)
    indices: list[int] | None = None
    clamp: bool = True

    @model_validator(mode="after")
    def validate_selector_shape(self) -> "AxisSelector":
        """Validate required fields based on selector kind.

        Returns
        -------
        AxisSelector
            Validated selector instance.
        """
        if self.kind == "index":
            if self.index is None:
                raise ValueError("index selector requires index.")
            return self
        if self.kind == "range":
            if self.start is None or self.end_exclusive is None:
                raise ValueError("range selector requires start and end_exclusive.")
            return self
        if self.kind == "set":
            if self.indices is None:
                raise ValueError("set selector requires indices.")
            return self
        return self


class SlabSettings(ModelBase):
    """Settings for slab or MIP-style sampling along a slice axis.

    Attributes
    ----------
    thickness_vox:
        Number of voxels combined into one slab.
    mode:
        Reduction mode for slab sampling.
    """
    thickness_vox: int = Field(default=1, ge=1)
    mode: Literal["single", "mip", "mean"] = "single"


class SliceSettings(ModelBase):
    """Slice geometry configuration.

    Attributes
    ----------
    axis:
        Axis used for slicing.
    index:
        Slice index.
    slab:
        Optional slab definition.
    """
    axis: str | None = None
    index: int | None = Field(default=None, ge=0)
    slab: SlabSettings | None = None


class Camera2D(ModelBase):
    """2D camera center/zoom state.

    Attributes
    ----------
    center_world:
        Center point in world coordinates.
    zoom:
        Zoom factor.
    rotation_deg:
        Rotation in degrees.
    """
    center_world: tuple[float, float]
    zoom: float = Field(ge=0.000001)
    rotation_deg: float = 0.0


class View2D(ModelBase):
    """2D view configuration and selected slice.

    Attributes
    ----------
    plane:
        Viewing plane (xy, xz, yz).
    slice:
        Slice settings.
    camera:
        Camera state.
    """
    plane: Literal["xy", "xz", "yz"] = "xy"
    slice: SliceSettings | None = None
    camera: Camera2D


class LayerSource(ModelBase):
    """Optional source path for a layer.

    Attributes
    ----------
    multiscale_name:
        Dataset multiscale this layer uses.
    array_path:
        Array path inside the dataset.
    """
    multiscale_name: str | None = None
    array_path: str | None = None


class ChannelContrast(ModelBase):
    """Per-channel contrast policy used by image layers.

    Attributes
    ----------
    policy:
        Contrast policy.
    min:
        Optional minimum value.
    max:
        Optional maximum value.
    p_low:
        Low percentile for percentile policy.
    p_high:
        High percentile for percentile policy.
    """
    policy: Literal["fixed", "percentile"] = "percentile"
    min: float | None = None
    max: float | None = None
    p_low: float = 1.0
    p_high: float = 99.0


class ImageChannelSettings(ModelBase):
    """Per-channel rendering settings.

    Attributes
    ----------
    index:
        Channel index.
    enabled:
        Enable flag.
    color_rgba:
        Optional RGBA override.
    contrast:
        Optional contrast settings.
    gamma:
        Gamma correction value.
    """
    index: int = Field(ge=0)
    enabled: bool
    color_rgba: tuple[float, float, float, float] | None = None
    contrast: ChannelContrast | None = None
    gamma: float = Field(default=1.0, ge=0.01)


class ImageLayerSettings(ModelBase):
    """Image layer rendering controls.

    Attributes
    ----------
    channel_mode:
        Rendering mode for channels.
    channels:
        Channel settings.
    interpolation:
        Interpolation mode.
    """
    channel_mode: Literal["single", "rgb", "composite"] = "composite"
    channels: list[ImageChannelSettings] = Field(default_factory=list)
    interpolation: Literal["nearest", "linear"] = "linear"


class LabelLayerSettings(ModelBase):
    """Label layer rendering controls.

    Attributes
    ----------
    outline:
        Draw outlines.
    outline_width_px:
        Outline width in pixels.
    show_fill:
        Fill label regions.
    """
    outline: bool = True
    outline_width_px: int = Field(default=1, ge=0)
    show_fill: bool = True


class LayerState(ModelBase):
    """Layer state entry in a view.

    Attributes
    ----------
    layer_id:
        Unique layer identifier.
    type:
        Layer type.
    dataset_id:
        Optional dataset source id.
    source:
        Optional source metadata.
    visible:
        Visibility flag.
    opacity:
        Opacity in [0,1].
    image:
        Optional image settings.
    labels:
        Optional label settings.
    """
    layer_id: str = Field(min_length=1)
    type: Literal["image", "labels", "annotations"]
    dataset_id: str | None = None
    source: LayerSource | None = None
    visible: bool
    opacity: float = Field(ge=0, le=1)
    image: ImageLayerSettings | None = None
    labels: LabelLayerSettings | None = None


class RenderSettings(ModelBase):
    """Optional global render settings.

    Attributes
    ----------
    background_rgba:
        Background color.
    """
    background_rgba: tuple[float, float, float, float] | None = None


class PerformanceHints(ModelBase):
    """Rendering quality and resource hint settings.

    Attributes
    ----------
    quality:
        Target render quality.
    target_frame_ms:
        Desired frame-time target in ms.
    progressive:
        Enable progressive rendering.
    lod_mode:
        Level-of-detail strategy.
    fixed_level:
        Explicit LOD level when ``lod_mode='fixed'``.
    max_cpu_cache_bytes:
        CPU cache limit.
    max_gpu_cache_bytes:
        GPU cache limit.
    prefer_gpu:
        Prefer GPU rendering.
    """
    quality: Literal["draft", "final"] = "draft"
    target_frame_ms: int = Field(default=200, ge=1)
    progressive: bool = True
    lod_mode: Literal["auto", "fixed"] = "auto"
    fixed_level: int | None = Field(default=None, ge=0)
    max_cpu_cache_bytes: int | None = Field(default=None, ge=0)
    max_gpu_cache_bytes: int | None = Field(default=None, ge=0)
    prefer_gpu: bool = True


class ViewState(ModelBase):
    """Complete serialized state for a view.

    Attributes
    ----------
    schema_version:
        API schema version.
    view_id:
        View identifier.
    session_id:
        Owning session id.
    created_at:
        Creation timestamp.
    mode:
        Render mode.
    datasets:
        Dataset references.
    viewport:
        Output viewport.
    selectors:
        Axis selectors.
    view_2d:
        2D view config.
    view_3d:
        Optional 3D view config.
    layers:
        Layer configuration list.
    render_settings:
        Optional render-level settings.
    performance:
        Optional performance hints.
    state_hash:
        Stable view-state hash.
    state_version:
        Monotonic version number.
    """
    schema_version: Literal[1] = 1
    view_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    created_at: datetime | None = None
    mode: RenderMode
    datasets: list[DatasetRef] = Field(min_length=1)
    viewport: Viewport
    selectors: list[AxisSelector] = Field(min_length=1)
    view_2d: View2D | None = None
    view_3d: dict[str, Any] | None = None
    layers: list[LayerState] = Field(min_length=1)
    render_settings: RenderSettings | None = None
    performance: PerformanceHints | None = None
    state_hash: str | None = None
    state_version: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_mode_dependencies(self) -> "ViewState":
        """Validate that mode-specific fields are present.

        Returns
        -------
        ViewState
            Validated view state.
        """
        if self.mode == "2d" and self.view_2d is None:
            raise ValueError("mode=2d requires view_2d.")
        if self.mode == "3d" and self.view_3d is None:
            raise ValueError("mode=3d requires view_3d.")
        return self
