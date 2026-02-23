from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

AxisRole = Literal["x", "y", "z", "c", "t", "other"]
SelectorDirection = Literal[-1, 1]
ContrastPolicy = Literal["fixed", "percentile"]


class ModelBase(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AxisDef(ModelBase):
    name: str = Field(min_length=1)
    role: AxisRole
    size: int = Field(ge=1)
    unit: str | None = None
    scale: float | None = None
    translation: float | None = None
    direction: SelectorDirection | None = 1


class SuggestedContrast(ModelBase):
    min: float | None = None
    max: float | None = None
    policy: ContrastPolicy | None = None
    p_low: float | None = None
    p_high: float | None = None


class ChannelDef(ModelBase):
    index: int = Field(ge=0)
    name: str | None = None
    color_rgba: tuple[
        float,
        float,
        float,
        float,
    ] | None = None
    suggested_contrast: SuggestedContrast | None = None
    suggested_gamma: float | None = None

    @field_validator("color_rgba")
    @classmethod
    def validate_color_rgba(
        cls, value: tuple[float, float, float, float] | None
    ) -> tuple[float, float, float, float] | None:
        if value is None:
            return None
        if len(value) != 4:
            raise ValueError("color_rgba must include 4 components.")
        if any(component < 0 or component > 1 for component in value):
            raise ValueError("color_rgba components must be within [0, 1].")
        return value


class MultiscaleLevelDef(ModelBase):
    level: int = Field(ge=0)
    path: str = Field(min_length=1)
    shape: list[int] = Field(min_length=1)
    chunks: list[int] = Field(min_length=1)
    downsample_factors: list[float] | None = None
    dtype: str | None = None

    @field_validator("shape", "chunks")
    @classmethod
    def validate_positive_int_lists(cls, value: list[int]) -> list[int]:
        if any(item < 1 for item in value):
            raise ValueError("shape and chunks values must be >= 1.")
        return value

    @field_validator("downsample_factors")
    @classmethod
    def validate_downsample_factors(cls, value: list[float] | None) -> list[float] | None:
        if value is None:
            return None
        if any(item < 1 for item in value):
            raise ValueError("downsample_factors values must be >= 1.")
        return value


class MultiscaleImageDef(ModelBase):
    name: str = Field(min_length=1)
    axes_order: list[str] = Field(min_length=1)
    levels: list[MultiscaleLevelDef] = Field(min_length=1)


class DatasetHints(ModelBase):
    recommended_tile_px: tuple[int, int] | None = None
    is_remote: bool | None = None

    @field_validator("recommended_tile_px")
    @classmethod
    def validate_recommended_tile_px(
        cls, value: tuple[int, int] | None
    ) -> tuple[int, int] | None:
        if value is None:
            return None
        if value[0] < 64 or value[1] < 64:
            raise ValueError("recommended_tile_px values must be >= 64.")
        return value


class DatasetSummary(ModelBase):
    schema_version: Literal[1] = 1
    dataset_id: str = Field(min_length=1)
    uri: str = Field(min_length=1)
    opened_at: datetime | None = None
    axes: list[AxisDef] = Field(min_length=1)
    shape: list[int] = Field(min_length=1)
    dtype: str = Field(min_length=1)
    world_units: str | None = "micron"
    channels: list[ChannelDef] | None = None
    multiscales: list[MultiscaleImageDef] = Field(min_length=1)
    hints: DatasetHints | None = None
    raw_metadata: dict[str, Any] | None = None

    @field_validator("shape")
    @classmethod
    def validate_shape(cls, value: list[int]) -> list[int]:
        if any(item < 1 for item in value):
            raise ValueError("shape values must be >= 1.")
        return value
