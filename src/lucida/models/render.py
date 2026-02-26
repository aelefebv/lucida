from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .api import ApiWarning
from .view_state import AxisSelector, ViewState


class ModelBase(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RenderOutputSpec(ModelBase):
    format: Literal["png", "raw_rgba"] = "png"
    delivery: Literal["inline_base64", "file_path"] = "inline_base64"
    file_path: str | None = None
    width_px: int = Field(ge=1)
    height_px: int = Field(ge=1)

    @model_validator(mode="after")
    def validate_format_delivery(self) -> "RenderOutputSpec":
        if self.format == "raw_rgba" and self.delivery != "inline_base64":
            raise ValueError("raw_rgba format supports only inline_base64 delivery.")
        return self


class RenderImageRequest(ModelBase):
    schema_version: Literal[1] = 1
    view_id: str | None = Field(default=None, min_length=1)
    view_state: ViewState | None = None
    session_id: str | None = Field(default=None, min_length=1)
    request_id: str | None = Field(default=None, min_length=1)
    overrides_json_patch: list[dict[str, Any]] | None = None
    output: RenderOutputSpec

    @model_validator(mode="after")
    def validate_view_reference_one_of(self) -> "RenderImageRequest":
        has_view_id = self.view_id is not None
        has_view_state = self.view_state is not None
        if has_view_id == has_view_state:
            raise ValueError("Exactly one of view_id or view_state must be provided.")
        return self


class RenderImageArtifact(ModelBase):
    role: Literal["main"] = "main"
    mime: Literal["image/png", "application/x-raw-rgba"] = "image/png"
    pixel_format: Literal["rgba8"] | None = None
    bytes_per_pixel: int | None = Field(default=None, ge=1)
    row_stride_bytes: int | None = Field(default=None, ge=1)
    width_px: int = Field(ge=1)
    height_px: int = Field(ge=1)
    delivery: Literal["inline_base64", "file_path"] = "inline_base64"
    bytes_base64: str | None = Field(default=None, min_length=1)
    file_path: str | None = Field(default=None, min_length=1)
    sha256: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_delivery_payload(self) -> "RenderImageArtifact":
        if self.delivery == "inline_base64":
            if self.bytes_base64 is None or self.file_path is not None:
                raise ValueError(
                    "inline_base64 delivery requires bytes_base64 and forbids file_path."
                )
        elif self.file_path is None or self.bytes_base64 is not None:
            raise ValueError(
                "file_path delivery requires file_path and forbids bytes_base64."
            )
        if self.mime == "application/x-raw-rgba":
            if self.pixel_format != "rgba8" or self.bytes_per_pixel != 4:
                raise ValueError(
                    "application/x-raw-rgba artifacts require pixel_format=rgba8 and bytes_per_pixel=4."
                )
            if self.row_stride_bytes is None:
                raise ValueError(
                    "application/x-raw-rgba artifacts require row_stride_bytes.",
                )
        return self


class RenderTimingStagesMs(ModelBase):
    chunk_fetch: float = Field(default=0, ge=0)
    chunk_decode: float = Field(default=0, ge=0)
    sample: float = Field(default=0, ge=0)
    compose: float = Field(default=0, ge=0)
    encode: float = Field(default=0, ge=0)
    gpu_compute: float = Field(default=0, ge=0)
    gpu_readback: float = Field(default=0, ge=0)


class RenderTimingMs(ModelBase):
    total: float = Field(ge=0)
    io: float = Field(default=0, ge=0)
    decode: float = Field(default=0, ge=0)
    gpu_upload: float = Field(default=0, ge=0)
    render: float = Field(default=0, ge=0)
    stages: RenderTimingStagesMs | None = None


class RenderMeta(ModelBase):
    dataset_id: str = Field(min_length=1)
    multiscale_name: str = Field(min_length=1)
    pyramid_level_used: int = Field(ge=0)
    selectors_applied: list[AxisSelector] = Field(default_factory=list)
    backend_used: Literal["cpu", "gpu"]
    timing_ms: RenderTimingMs


class RenderImageResponse(ModelBase):
    schema_version: Literal[1] = 1
    request_id: str = Field(min_length=1)
    render_id: str = Field(min_length=1)
    status: Literal["ok"] = "ok"
    completion: float = Field(default=1.0, ge=0, le=1)
    view_id: str | None = Field(default=None, min_length=1)
    state_hash: str = Field(min_length=1)
    state_version: int | None = Field(default=None, ge=0)
    images: list[RenderImageArtifact] = Field(min_length=1)
    meta: RenderMeta
    warnings: list[ApiWarning] = Field(default_factory=list)
