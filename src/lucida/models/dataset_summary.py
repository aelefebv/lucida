"""Pydantic models for dataset-level metadata returned by OME-Zarr readers."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

AxisRole = Literal["x", "y", "z", "c", "t", "other"]
SelectorDirection = Literal[-1, 1]
ContrastPolicy = Literal["fixed", "percentile"]


class ModelBase(BaseModel):
    """Shared base model with strict field validation.

    Attributes
    ----------
    model_config:
        Pydantic v2 model configuration that forbids extra fields.
    """
    model_config = ConfigDict(extra="forbid")


class AxisDef(ModelBase):
    """Axis metadata for a dataset dimension.

    Attributes
    ----------
    name:
        Axis identifier.
    role:
        Canonical role (x, y, z, c, t, other).
    size:
        Number of elements along this axis.
    unit:
        Optional physical unit string.
    scale:
        Optional spatial scale.
    translation:
        Optional axis translation offset.
    direction:
        Axis orientation direction (1 or -1).
    """
    name: str = Field(min_length=1)
    role: AxisRole
    size: int = Field(ge=1)
    unit: str | None = None
    scale: float | None = None
    translation: float | None = None
    direction: SelectorDirection | None = 1


class SuggestedContrast(ModelBase):
    """Optional channel contrast hints.

    Attributes
    ----------
    min:
        Optional minimum display value.
    max:
        Optional maximum display value.
    policy:
        Contrast policy.
    p_low:
        Percentile low when in percentile policy.
    p_high:
        Percentile high when in percentile policy.
    """
    min: float | None = None
    max: float | None = None
    policy: ContrastPolicy | None = None
    p_low: float | None = None
    p_high: float | None = None


class ChannelDef(ModelBase):
    """Channel configuration and optional display metadata.

    Attributes
    ----------
    index:
        Channel index.
    name:
        Optional channel name.
    color_rgba:
        Optional display color.
    suggested_contrast:
        Optional contrast hint.
    suggested_gamma:
        Optional gamma hint.
    """
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
        """Validate RGBA components are present and normalized.

        Parameters
        ----------
        value:
            RGBA tuple or ``None``.

        Returns
        -------
        tuple[float, float, float, float] | None
            Validated RGBA values.
        """
        if value is None:
            return None
        if len(value) != 4:
            raise ValueError("color_rgba must include 4 components.")
        if any(component < 0 or component > 1 for component in value):
            raise ValueError("color_rgba components must be within [0, 1].")
        return value


class MultiscaleLevelDef(ModelBase):
    """One multiscale level with shape/chunk/downsample descriptors.

    Attributes
    ----------
    level:
        Pyramid level number.
    path:
        Relative array path.
    shape:
        Array shape at this level.
    chunks:
        Chunk sizes.
    downsample_factors:
        Optional inferred or metadata-provided downsample factors.
    dtype:
        Optional dtype string.
    """
    level: int = Field(ge=0)
    path: str = Field(min_length=1)
    shape: list[int] = Field(min_length=1)
    chunks: list[int] = Field(min_length=1)
    downsample_factors: list[float] | None = None
    dtype: str | None = None

    @field_validator("shape", "chunks")
    @classmethod
    def validate_positive_int_lists(cls, value: list[int]) -> list[int]:
        """Validate list values are strictly positive.

        Parameters
        ----------
        value:
            List of integer dimensions or chunk sizes.

        Returns
        -------
        list[int]
            Validated list of strictly positive integers.
        """
        if any(item < 1 for item in value):
            raise ValueError("shape and chunks values must be >= 1.")
        return value

    @field_validator("downsample_factors")
    @classmethod
    def validate_downsample_factors(cls, value: list[float] | None) -> list[float] | None:
        """Validate downsample factors are non-degenerate and >=1.

        Parameters
        ----------
        value:
            Optional list of downsample multipliers.

        Returns
        -------
        list[float] | None
            Validated list of downsample factors.
        """
        if value is None:
            return None
        if any(item < 1 for item in value):
            raise ValueError("downsample_factors values must be >= 1.")
        return value


class MultiscaleImageDef(ModelBase):
    """Collection of related pyramid levels for one multiscale.

    Attributes
    ----------
    name:
        Multiscale name.
    axes_order:
        Axis name order for level arrays.
    levels:
        Ordered list of pyramid levels.
    """
    name: str = Field(min_length=1)
    axes_order: list[str] = Field(min_length=1)
    levels: list[MultiscaleLevelDef] = Field(min_length=1)


class DatasetHints(ModelBase):
    """Optional ingest/usage hints for dataset clients.

    Attributes
    ----------
    recommended_tile_px:
        Suggested tile size.
    is_remote:
        Whether the source URI is remote.
    """
    recommended_tile_px: tuple[int, int] | None = None
    is_remote: bool | None = None

    @field_validator("recommended_tile_px")
    @classmethod
    def validate_recommended_tile_px(
        cls, value: tuple[int, int] | None
    ) -> tuple[int, int] | None:
        """Validate recommended tile dims are at least 64.

        Parameters
        ----------
        value:
            Suggested tile width/height pair.

        Returns
        -------
        tuple[int, int] | None
            Validated tile dimensions.
        """
        if value is None:
            return None
        if value[0] < 64 or value[1] < 64:
            raise ValueError("recommended_tile_px values must be >= 64.")
        return value


class DatasetSummary(ModelBase):
    """Summary of an opened dataset suitable for session-scoped workflows.

    Attributes
    ----------
    schema_version:
        API schema version.
    dataset_id:
        Dataset identifier.
    uri:
        Source URI.
    opened_at:
        Last-open timestamp.
    axes:
        Axis definitions.
    shape:
        Base shape.
    dtype:
        Array dtype.
    world_units:
        Optional units for physical dimensions.
    channels:
        Optional channel definitions.
    multiscales:
        Multiscale image definitions.
    hints:
        Optional usage hints.
    raw_metadata:
        Raw metadata snapshot.
    """
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
        """Validate shape entries are positive.

        Parameters
        ----------
        value:
            Dataset shape tuple/list values.

        Returns
        -------
        list[int]
            Validated shape values.
        """
        if any(item < 1 for item in value):
            raise ValueError("shape values must be >= 1.")
        return value
