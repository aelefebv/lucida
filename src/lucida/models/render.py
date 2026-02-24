from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .api import ApiWarning
from .view_state import AxisSelector


class ModelBase(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RenderOutputSpec(ModelBase):
    format: Literal["png"] = "png"
    delivery: Literal["inline_base64"] = "inline_base64"
    width_px: int = Field(ge=1)
    height_px: int = Field(ge=1)


class RenderImageRequest(ModelBase):
    schema_version: Literal[1] = 1
    view_id: str = Field(min_length=1)
    session_id: str | None = Field(default=None, min_length=1)
    request_id: str | None = Field(default=None, min_length=1)
    overrides_json_patch: list[dict[str, Any]] | None = None
    output: RenderOutputSpec


class RenderImageArtifact(ModelBase):
    role: Literal["main"] = "main"
    mime: Literal["image/png"] = "image/png"
    width_px: int = Field(ge=1)
    height_px: int = Field(ge=1)
    delivery: Literal["inline_base64"] = "inline_base64"
    bytes_base64: str = Field(min_length=1)
    sha256: str = Field(min_length=1)


class RenderTimingMs(ModelBase):
    total: float = Field(ge=0)
    io: float = Field(default=0, ge=0)
    decode: float = Field(default=0, ge=0)
    gpu_upload: float = Field(default=0, ge=0)
    render: float = Field(default=0, ge=0)


class RenderMeta(ModelBase):
    dataset_id: str = Field(min_length=1)
    multiscale_name: str = Field(min_length=1)
    pyramid_level_used: int = Field(ge=0)
    selectors_applied: list[AxisSelector] = Field(default_factory=list)
    timing_ms: RenderTimingMs


class RenderImageResponse(ModelBase):
    schema_version: Literal[1] = 1
    request_id: str = Field(min_length=1)
    render_id: str = Field(min_length=1)
    status: Literal["ok"] = "ok"
    completion: float = Field(default=1.0, ge=0, le=1)
    view_id: str = Field(min_length=1)
    state_hash: str = Field(min_length=1)
    state_version: int = Field(ge=0)
    images: list[RenderImageArtifact] = Field(min_length=1)
    meta: RenderMeta
    warnings: list[ApiWarning] = Field(default_factory=list)
