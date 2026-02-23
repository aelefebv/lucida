from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


AxisSelectorKind = Literal["index", "range", "set"]
RenderMode = Literal["2d", "3d"]


class ModelBase(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DatasetRef(ModelBase):
    dataset_id: str = Field(min_length=1)
    multiscale_name: str = Field(min_length=1)


class Viewport(ModelBase):
    width_px: int = Field(ge=1)
    height_px: int = Field(ge=1)
    pixel_ratio: float = Field(default=1.0, ge=0.5)


class AxisSelector(ModelBase):
    axis: str = Field(min_length=1)
    kind: AxisSelectorKind
    index: int | None = Field(default=None, ge=0)
    start: int | None = Field(default=None, ge=0)
    end_exclusive: int | None = Field(default=None, ge=1)
    indices: list[int] | None = None
    clamp: bool = True

    @model_validator(mode="after")
    def validate_selector_shape(self) -> "AxisSelector":
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
    thickness_vox: int = Field(default=1, ge=1)
    mode: Literal["single", "mip", "mean"] = "single"


class SliceSettings(ModelBase):
    axis: str | None = None
    index: int | None = Field(default=None, ge=0)
    slab: SlabSettings | None = None


class Camera2D(ModelBase):
    center_world: tuple[float, float]
    zoom: float = Field(ge=0.000001)
    rotation_deg: float = 0.0


class View2D(ModelBase):
    plane: Literal["xy", "xz", "yz"] = "xy"
    slice: SliceSettings | None = None
    camera: Camera2D


class LayerSource(ModelBase):
    multiscale_name: str | None = None
    array_path: str | None = None


class ChannelContrast(ModelBase):
    policy: Literal["fixed", "percentile"] = "percentile"
    min: float | None = None
    max: float | None = None
    p_low: float = 1.0
    p_high: float = 99.0


class ImageChannelSettings(ModelBase):
    index: int = Field(ge=0)
    enabled: bool
    color_rgba: tuple[float, float, float, float] | None = None
    contrast: ChannelContrast | None = None
    gamma: float = Field(default=1.0, ge=0.01)


class ImageLayerSettings(ModelBase):
    channel_mode: Literal["single", "rgb", "composite"] = "composite"
    channels: list[ImageChannelSettings] = Field(default_factory=list)
    interpolation: Literal["nearest", "linear"] = "linear"


class LabelLayerSettings(ModelBase):
    outline: bool = True
    outline_width_px: int = Field(default=1, ge=0)
    show_fill: bool = True


class LayerState(ModelBase):
    layer_id: str = Field(min_length=1)
    type: Literal["image", "labels", "annotations"]
    dataset_id: str | None = None
    source: LayerSource | None = None
    visible: bool
    opacity: float = Field(ge=0, le=1)
    image: ImageLayerSettings | None = None
    labels: LabelLayerSettings | None = None


class RenderSettings(ModelBase):
    background_rgba: tuple[float, float, float, float] | None = None


class PerformanceHints(ModelBase):
    quality: Literal["draft", "final"] = "draft"
    target_frame_ms: int = Field(default=200, ge=1)
    progressive: bool = True
    lod_mode: Literal["auto", "fixed"] = "auto"
    fixed_level: int | None = Field(default=None, ge=0)
    max_cpu_cache_bytes: int | None = Field(default=None, ge=0)
    max_gpu_cache_bytes: int | None = Field(default=None, ge=0)
    prefer_gpu: bool = True


class ViewState(ModelBase):
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
        if self.mode == "2d" and self.view_2d is None:
            raise ValueError("mode=2d requires view_2d.")
        if self.mode == "3d" and self.view_3d is None:
            raise ValueError("mode=3d requires view_3d.")
        return self
