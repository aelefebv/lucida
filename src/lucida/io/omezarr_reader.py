"""OME-Zarr metadata reader with validation and best-effort normalization."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import fsspec
import numpy as np
import zarr

from lucida.errors import LucidaError
from lucida.models.api import ApiWarning
from lucida.models.dataset_summary import (
    AxisDef,
    ChannelDef,
    MultiscaleImageDef,
    MultiscaleLevelDef,
    SuggestedContrast,
)

_AXIS_TYPES = {"x", "y", "z", "c", "t"}


@dataclass(slots=True)
class OMEZarrReadResult:
    """Container for OME-Zarr metadata extracted from a store.

    Attributes
    ----------
    axes:
        Parsed axes metadata.
    shape:
        Shape of the base multiscale level.
    dtype:
        Numpy dtype for arrays.
    channels:
        Parsed channel definitions.
    multiscales:
        Parsed multiscale image definitions.
    raw_metadata:
        Collected raw metadata for diagnostics.
    recommended_tile_px:
        Suggested tile dimensions.
    """
    axes: list[AxisDef]
    shape: list[int]
    dtype: str
    channels: list[ChannelDef]
    multiscales: list[MultiscaleImageDef]
    raw_metadata: dict[str, Any]
    recommended_tile_px: tuple[int, int] | None


def read_omezarr(
    uri: str,
    include_full_raw_metadata: bool = False,
) -> tuple[OMEZarrReadResult, list[ApiWarning]]:
    """Read and normalize multiscale metadata from an OME-Zarr dataset URI.

    Parameters
    ----------
    uri:
        URI of the OME-Zarr dataset.
    include_full_raw_metadata:
        Include full root and array metadata when true.

    Returns
    -------
    tuple[OMEZarrReadResult, list[ApiWarning]]
        Parsed dataset summary and warnings.
    """
    warnings: list[ApiWarning] = []
    try:
        mapper = fsspec.get_mapper(uri)
        root = zarr.open_group(store=mapper, mode="r")
    except Exception as exc:  # pragma: no cover - error path tested via service
        raise LucidaError(
            code="dataset_open_failed",
            message="Failed to open dataset store.",
            details={"uri": uri, "reason": str(exc)},
            status_code=400,
        ) from exc

    root_attrs = _to_json_compatible(_attrs_dict(root.attrs))
    multiscales_raw = root_attrs.get("multiscales")
    if not isinstance(multiscales_raw, list) or not multiscales_raw:
        raise LucidaError(
            code="invalid_omezarr",
            message="Dataset is missing required OME-Zarr multiscales metadata.",
            details={"uri": uri},
            status_code=422,
        )

    parsed_multiscales: list[MultiscaleImageDef] = []
    first_axes: list[AxisDef] | None = None
    first_shape: list[int] | None = None
    first_dtype: str | None = None
    level_metadata: list[dict[str, Any]] = []

    for multiscale_index, multiscale_raw in enumerate(multiscales_raw):
        if not isinstance(multiscale_raw, dict):
            raise LucidaError(
                code="invalid_omezarr",
                message="Invalid multiscale metadata entry.",
                details={"multiscale_index": multiscale_index},
                status_code=422,
            )

        multiscale_name = multiscale_raw.get("name")
        if not isinstance(multiscale_name, str) or not multiscale_name:
            multiscale_name = f"multiscale_{multiscale_index}"
            warnings.append(
                ApiWarning(
                    code="multiscale_name_inferred",
                    message="Multiscale name was missing; generated fallback name.",
                    details={"multiscale_index": multiscale_index, "name": multiscale_name},
                )
            )

        datasets_raw = multiscale_raw.get("datasets")
        if not isinstance(datasets_raw, list) or not datasets_raw:
            raise LucidaError(
                code="invalid_omezarr",
                message="Multiscale metadata is missing datasets.",
                details={"multiscale_index": multiscale_index},
                status_code=422,
            )

        level_defs: list[MultiscaleLevelDef] = []
        base_shape: list[int] | None = None
        base_scale: list[float] | None = None
        base_translation: list[float] | None = None

        for level_index, dataset_raw in enumerate(datasets_raw):
            if not isinstance(dataset_raw, dict):
                raise LucidaError(
                    code="invalid_omezarr",
                    message="Invalid multiscale dataset entry.",
                    details={"multiscale_index": multiscale_index, "level": level_index},
                    status_code=422,
                )

            path = dataset_raw.get("path")
            if not isinstance(path, str) or not path:
                raise LucidaError(
                    code="invalid_omezarr",
                    message="Multiscale dataset entry is missing path.",
                    details={"multiscale_index": multiscale_index, "level": level_index},
                    status_code=422,
                )

            try:
                array = root[path]
            except Exception as exc:
                raise LucidaError(
                    code="invalid_omezarr",
                    message="Dataset level path could not be opened.",
                    details={
                        "multiscale_index": multiscale_index,
                        "level": level_index,
                        "path": path,
                        "reason": str(exc),
                    },
                    status_code=422,
                ) from exc

            shape = [int(dim) for dim in array.shape]
            chunks = _normalize_chunks(array.chunks, shape)
            dtype = str(array.dtype)

            transformations = dataset_raw.get("coordinateTransformations")
            level_scale = _extract_transform_values(transformations, "scale")
            level_translation = _extract_transform_values(transformations, "translation")

            if level_index == 0:
                base_shape = shape
                base_scale = level_scale
                base_translation = level_translation

            downsample_factors, used_fallback = _compute_downsample_factors(
                base_shape=base_shape,
                level_shape=shape,
                base_scale=base_scale,
                level_scale=level_scale,
                level_index=level_index,
            )

            if used_fallback:
                warnings.append(
                    ApiWarning(
                        code="downsample_factors_inferred",
                        message="Downsample factors were inferred from level shape.",
                        details={
                            "multiscale_index": multiscale_index,
                            "level": level_index,
                            "path": path,
                        },
                    )
                )

            level_defs.append(
                MultiscaleLevelDef(
                    level=level_index,
                    path=path,
                    shape=shape,
                    chunks=chunks,
                    downsample_factors=downsample_factors,
                    dtype=dtype,
                )
            )

            level_metadata.append(
                {
                    "multiscale_name": multiscale_name,
                    "multiscale_index": multiscale_index,
                    "level": level_index,
                    "path": path,
                    "coordinate_transformations": transformations,
                    "array_attrs": _collect_array_attrs(
                        attrs=_attrs_dict(array.attrs),
                        include_full=include_full_raw_metadata,
                    ),
                }
            )

        assert base_shape is not None
        axes_order, axis_defs = _parse_axes(
            axes_raw=multiscale_raw.get("axes"),
            shape=base_shape,
            base_scale=base_scale,
            base_translation=base_translation,
            warnings=warnings,
            multiscale_index=multiscale_index,
        )

        parsed_multiscales.append(
            MultiscaleImageDef(name=multiscale_name, axes_order=axes_order, levels=level_defs)
        )

        if first_axes is None:
            first_axes = axis_defs
            first_shape = level_defs[0].shape
            first_dtype = level_defs[0].dtype

    if first_axes is None or first_shape is None or first_dtype is None:
        raise LucidaError(
            code="invalid_omezarr",
            message="Failed to parse OME-Zarr metadata.",
            details={"uri": uri},
            status_code=422,
        )

    channels = _parse_channels(root_attrs.get("omero"), warnings)
    recommended_tile_px = _infer_recommended_tile_px(first_axes, parsed_multiscales[0].levels[0].chunks)

    raw_metadata = {
        "root": (
            root_attrs
            if include_full_raw_metadata
            else {k: root_attrs[k] for k in ("multiscales", "omero") if k in root_attrs}
        ),
        "levels": level_metadata,
    }

    return (
        OMEZarrReadResult(
            axes=first_axes,
            shape=first_shape,
            dtype=first_dtype,
            channels=channels,
            multiscales=parsed_multiscales,
            raw_metadata=raw_metadata,
            recommended_tile_px=recommended_tile_px,
        ),
        warnings,
    )


def _attrs_dict(attrs: Any) -> dict[str, Any]:
    """Convert Zarr attributes-like objects into dictionaries.

    Parameters
    ----------
    attrs:
        Raw attributes object.
    """
    if hasattr(attrs, "asdict"):
        raw = attrs.asdict()
        if isinstance(raw, dict):
            return raw
    if isinstance(attrs, dict):
        return attrs
    return dict(attrs)


def _normalize_chunks(chunks: Any, shape: list[int]) -> list[int]:
    """Normalize chunk metadata to a list aligned with array shape.

    Parameters
    ----------
    chunks:
        Raw chunks metadata from Zarr.
    shape:
        Array shape used if chunks are missing.
    """
    if chunks is None:
        return shape
    if isinstance(chunks, tuple):
        return [int(c) for c in chunks]
    if isinstance(chunks, list):
        return [int(c) for c in chunks]
    return shape


def _extract_transform_values(
    transformations: Any,
    transform_type: str,
) -> list[float] | None:
    """Extract transformation vectors from coordinate transformation metadata.

    Parameters
    ----------
    transformations:
        Iterable of transformation dictionaries.
    transform_type:
        Requested transform key (e.g., ``scale`` or ``translation``).
    """
    if not isinstance(transformations, list):
        return None
    for transformation in transformations:
        if not isinstance(transformation, dict):
            continue
        if transformation.get("type") != transform_type:
            continue
        values = transformation.get(transform_type)
        if not isinstance(values, list):
            continue
        parsed: list[float] = []
        for value in values:
            try:
                parsed.append(float(value))
            except (TypeError, ValueError):
                return None
        return parsed
    return None


def _compute_downsample_factors(
    *,
    base_shape: list[int] | None,
    level_shape: list[int],
    base_scale: list[float] | None,
    level_scale: list[float] | None,
    level_index: int,
) -> tuple[list[float], bool]:
    """Compute downsample factors for a multiscale level.

    Parameters
    ----------
    base_shape:
        Shape of level 0.
    level_shape:
        Shape for the requested level.
    base_scale:
        Scale metadata for level 0.
    level_scale:
        Scale metadata for the requested level.
    level_index:
        Current pyramid level index.
    """
    if level_index == 0:
        return [1.0 for _ in level_shape], False

    if (
        base_scale is not None
        and level_scale is not None
        and len(base_scale) == len(level_scale)
        and len(level_scale) == len(level_shape)
    ):
        factors: list[float] = []
        for base, level in zip(base_scale, level_scale, strict=True):
            if base == 0:
                factors.append(1.0)
            else:
                factors.append(max(1.0, float(level) / float(base)))
        return factors, False

    if base_shape is None or len(base_shape) != len(level_shape):
        return [1.0 for _ in level_shape], True

    return [max(1.0, float(b) / float(l)) for b, l in zip(base_shape, level_shape, strict=True)], True


def _parse_axes(
    *,
    axes_raw: Any,
    shape: list[int],
    base_scale: list[float] | None,
    base_translation: list[float] | None,
    warnings: list[ApiWarning],
    multiscale_index: int,
) -> tuple[list[str], list[AxisDef]]:
    """Parse axes metadata and return axis order plus axis definitions.

    Parameters
    ----------
    axes_raw:
        Raw axis descriptors from metadata.
    shape:
        Shape for positional fallback.
    base_scale:
        Base-level scale values.
    base_translation:
        Base-level translation values.
    warnings:
        Warning accumulator for inferred metadata decisions.
    multiscale_index:
        Index of the multiscale being parsed.
    """
    if not isinstance(axes_raw, list) or len(axes_raw) != len(shape):
        warnings.append(
            ApiWarning(
                code="axes_metadata_inferred",
                message="Axes metadata is missing or incompatible; generated generic axes.",
                details={"multiscale_index": multiscale_index},
            )
        )
        axes_raw = [f"axis_{i}" for i in range(len(shape))]

    axes_order: list[str] = []
    axes: list[AxisDef] = []

    for index, axis_raw in enumerate(axes_raw):
        axis_name: str
        axis_type: str | None = None
        unit: str | None = None
        direction_value: int | None = 1

        if isinstance(axis_raw, dict):
            axis_name = str(axis_raw.get("name") or f"axis_{index}")
            axis_type_raw = axis_raw.get("type")
            if isinstance(axis_type_raw, str):
                axis_type = axis_type_raw.lower()
            unit_raw = axis_raw.get("unit")
            if isinstance(unit_raw, str):
                unit = unit_raw
            direction_raw = axis_raw.get("direction")
            if isinstance(direction_raw, int) and direction_raw in (-1, 1):
                direction_value = direction_raw
        elif isinstance(axis_raw, str):
            axis_name = axis_raw
        else:
            axis_name = f"axis_{index}"

        axis_role = _resolve_axis_role(axis_type=axis_type, axis_name=axis_name)
        if axis_role == "other":
            warnings.append(
                ApiWarning(
                    code="axis_role_inferred",
                    message="Axis role could not be determined and was set to 'other'.",
                    details={"multiscale_index": multiscale_index, "axis": axis_name},
                )
            )

        scale = base_scale[index] if base_scale is not None and index < len(base_scale) else None
        translation = (
            base_translation[index]
            if base_translation is not None and index < len(base_translation)
            else None
        )

        axes_order.append(axis_name)
        axes.append(
            AxisDef(
                name=axis_name,
                role=axis_role,
                size=shape[index],
                unit=unit,
                scale=scale,
                translation=translation,
                direction=direction_value,
            )
        )

    return axes_order, axes


def _resolve_axis_role(axis_type: str | None, axis_name: str) -> str:
    """Map axis type or name to a canonical Lucida axis role.

    Parameters
    ----------
    axis_type:
        Advertised axis type from metadata.
    axis_name:
        Axis name to infer from when type is missing.

    Returns
    -------
    str
        Canonical axis role used by Lucida.
    """
    if axis_type in _AXIS_TYPES:
        return axis_type

    name = axis_name.lower()
    if name in {"x", "width"}:
        return "x"
    if name in {"y", "height"}:
        return "y"
    if name in {"z", "depth"}:
        return "z"
    if name in {"c", "ch", "channel", "channels"}:
        return "c"
    if name in {"t", "time"}:
        return "t"

    return "other"


def _parse_channels(omero: Any, warnings: list[ApiWarning]) -> list[ChannelDef]:
    """Parse channels from OME metadata.

    Parameters
    ----------
    omero:
        OME metadata subtree.
    warnings:
        Warning sink for parse issues.
    """
    if not isinstance(omero, dict):
        return []

    channels_raw = omero.get("channels")
    if not isinstance(channels_raw, list):
        return []

    channels: list[ChannelDef] = []
    for index, channel_raw in enumerate(channels_raw):
        if not isinstance(channel_raw, dict):
            warnings.append(
                ApiWarning(
                    code="channel_metadata_skipped",
                    message="Invalid channel metadata entry was skipped.",
                    details={"channel_position": index},
                )
            )
            continue

        channel_index_raw = channel_raw.get("index")
        if isinstance(channel_index_raw, int) and channel_index_raw >= 0:
            channel_index = channel_index_raw
        else:
            channel_index = index
            warnings.append(
                ApiWarning(
                    code="channel_index_inferred",
                    message="Channel index missing; inferred from channel order.",
                    details={"channel_position": index, "index": channel_index},
                )
            )

        color_rgba = _parse_color(channel_raw.get("color"))
        if channel_raw.get("color") is not None and color_rgba is None:
            warnings.append(
                ApiWarning(
                    code="channel_color_invalid",
                    message="Channel color was not parseable and was omitted.",
                    details={"channel_index": channel_index},
                )
            )

        suggested_contrast = _parse_suggested_contrast(channel_raw.get("window"))

        gamma = channel_raw.get("gamma")
        gamma_value: float | None = None
        if gamma is not None:
            try:
                gamma_value = float(gamma)
            except (TypeError, ValueError):
                warnings.append(
                    ApiWarning(
                        code="channel_gamma_invalid",
                        message="Channel gamma was not parseable and was omitted.",
                        details={"channel_index": channel_index},
                    )
                )

        channel_name_raw = channel_raw.get("label") or channel_raw.get("name")
        channel_name = str(channel_name_raw) if channel_name_raw is not None else None

        channels.append(
            ChannelDef(
                index=channel_index,
                name=channel_name,
                color_rgba=color_rgba,
                suggested_contrast=suggested_contrast,
                suggested_gamma=gamma_value,
            )
        )

    return channels


def _parse_color(raw_color: Any) -> tuple[float, float, float, float] | None:
    """Parse color values from a hex string.

    Parameters
    ----------
    raw_color:
        Raw color field from metadata.
    """
    if not isinstance(raw_color, str):
        return None

    color = raw_color.strip().lower().replace("0x", "")
    if color.startswith("#"):
        color = color[1:]

    if len(color) == 6:
        color += "ff"
    if len(color) != 8:
        return None

    try:
        red = int(color[0:2], 16) / 255.0
        green = int(color[2:4], 16) / 255.0
        blue = int(color[4:6], 16) / 255.0
        alpha = int(color[6:8], 16) / 255.0
    except ValueError:
        return None

    return (red, green, blue, alpha)


def _parse_suggested_contrast(window: Any) -> SuggestedContrast | None:
    """Parse optional contrast hints from a metadata window record.

    Parameters
    ----------
    window:
        Raw window metadata dictionary.
    """
    if not isinstance(window, dict):
        return None

    min_value = _first_float(window.get("min"), window.get("start"))
    max_value = _first_float(window.get("max"), window.get("end"))

    if min_value is None and max_value is None:
        return None

    return SuggestedContrast(min=min_value, max=max_value, policy="fixed")


def _first_float(*values: Any) -> float | None:
    """Return the first value that can be coerced to float.

    Parameters
    ----------
    values:
        Candidate values to parse.
    """
    for value in values:
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _infer_recommended_tile_px(
    axes: list[AxisDef],
    chunks: list[int],
) -> tuple[int, int] | None:
    """Infer tile dimensions from axis roles and chunk sizes.

    Parameters
    ----------
    axes:
        Parsed axis definitions.
    chunks:
        Chunk geometry in axis order.
    """
    x_index = next((idx for idx, axis in enumerate(axes) if axis.role == "x"), None)
    y_index = next((idx for idx, axis in enumerate(axes) if axis.role == "y"), None)
    if x_index is None or y_index is None:
        return None
    if x_index >= len(chunks) or y_index >= len(chunks):
        return None
    x_size = max(64, int(chunks[x_index]))
    y_size = max(64, int(chunks[y_index]))
    return (x_size, y_size)


def _collect_array_attrs(*, attrs: dict[str, Any], include_full: bool) -> dict[str, Any]:
    """Collect array-level attrs with optional truncation.

    Parameters
    ----------
    attrs:
        Source array attributes.
    include_full:
        Keep full attrs when true; otherwise use a safe subset.
    """
    attrs = _to_json_compatible(attrs)
    if include_full:
        return attrs
    keys = ("_ARRAY_DIMENSIONS", "dimension_separator")
    return {key: attrs[key] for key in keys if key in attrs}


def _to_json_compatible(value: Any) -> Any:
    """Return values as JSON-serializable primitives recursively.

    Parameters
    ----------
    value:
        Arbitrary object.
    """
    if isinstance(value, dict):
        return {str(key): _to_json_compatible(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_json_compatible(item) for item in value]
    if isinstance(value, tuple):
        return [_to_json_compatible(item) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    return value
