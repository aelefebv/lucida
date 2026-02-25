"""Convert OME-TIFF files to OME-Zarr."""

from __future__ import annotations

import shutil
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from dataclasses import dataclass
from itertools import product
from pathlib import Path
from typing import Any

import numpy as np
import zarr
from PIL import Image

_SUPPORTED_DOWNSAMPLE_AXES = frozenset({"z", "y", "x"})
_CHANNEL_COLORS = (
    "FF0000",
    "00FF00",
    "0000FF",
    "FFFF00",
    "FF00FF",
    "00FFFF",
    "FFFFFF",
    "FFA500",
)


@dataclass(frozen=True, slots=True)
class ConversionOptions:
    """Configuration for OME-TIFF to OME-Zarr conversion."""

    pyramid_levels: int = 4
    downsample_factor: int = 2
    downsample_axes: tuple[str, ...] = ("z", "y", "x")
    chunk_shape: tuple[int, int, int, int, int] | None = None
    overwrite: bool = False

    def __post_init__(self) -> None:
        if self.pyramid_levels < 1:
            raise ValueError("pyramid_levels must be >= 1")
        if self.downsample_factor < 2:
            raise ValueError("downsample_factor must be >= 2")
        normalized_axes = tuple(axis.lower() for axis in self.downsample_axes)
        if not normalized_axes:
            raise ValueError("downsample_axes cannot be empty")
        if any(axis not in _SUPPORTED_DOWNSAMPLE_AXES for axis in normalized_axes):
            raise ValueError("downsample_axes must be a subset of {'z', 'y', 'x'}")
        object.__setattr__(self, "downsample_axes", normalized_axes)

        if self.chunk_shape is not None:
            if len(self.chunk_shape) != 5:
                raise ValueError("chunk_shape must have 5 entries in TCZYX order")
            if any(value < 1 for value in self.chunk_shape):
                raise ValueError("chunk_shape values must be positive integers")


@dataclass(frozen=True, slots=True)
class ConversionSummary:
    """Summary of a successful conversion."""

    input_path: Path
    output_path: Path
    shape_tczyx: tuple[int, int, int, int, int]
    chunk_shape: tuple[int, int, int, int, int]
    dtype: str
    pyramid_levels_written: int


@dataclass(frozen=True, slots=True)
class _ParsedOmeMetadata:
    size_t: int
    size_c: int
    size_z: int
    size_y: int
    size_x: int
    dimension_order: str
    channel_names: tuple[str, ...]
    physical_size_t: float
    physical_size_z: float
    physical_size_y: float
    physical_size_x: float
    unit_t: str | None
    unit_z: str | None
    unit_y: str | None
    unit_x: str | None
    ifd_to_coord: dict[int, tuple[int, int, int]]

    @property
    def shape_tczyx(self) -> tuple[int, int, int, int, int]:
        return (self.size_t, self.size_c, self.size_z, self.size_y, self.size_x)

    @property
    def total_planes(self) -> int:
        return self.size_t * self.size_c * self.size_z


def convert_ome_tiff_to_omezarr(
    input_path: str | Path,
    output_path: str | Path,
    *,
    options: ConversionOptions | None = None,
) -> ConversionSummary:
    """Convert one OME-TIFF file into an OME-Zarr directory."""

    resolved_input = Path(input_path).expanduser().resolve(strict=True)
    resolved_output = Path(output_path).expanduser().resolve(strict=False)
    conversion_options = options or ConversionOptions()

    if not resolved_input.is_file():
        raise FileNotFoundError(f"Input path is not a file: {resolved_input}")

    _prepare_output_path(resolved_output, overwrite=conversion_options.overwrite)
    resolved_output.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(resolved_input) as image:
        metadata = _parse_ome_metadata(image)
        chunk_shape = conversion_options.chunk_shape or _default_chunk_shape(metadata.shape_tczyx)
        root = zarr.open_group(store=str(resolved_output), mode="w")
        level_zero, channel_windows = _write_level_zero(
            image=image,
            root=root,
            metadata=metadata,
            chunk_shape=chunk_shape,
        )
        pyramid_levels_written, datasets_metadata = _build_pyramid_levels(
            root=root,
            level_zero=level_zero,
            metadata=metadata,
            options=conversion_options,
            base_chunk_shape=chunk_shape,
        )
        root.attrs["multiscales"] = [
            {
                "name": "primary",
                "axes": _build_axes_metadata(metadata),
                "datasets": datasets_metadata,
            }
        ]
        root.attrs["omero"] = {
            "channels": _build_omero_channels(
                channel_names=metadata.channel_names,
                channel_windows=channel_windows,
            )
        }

    return ConversionSummary(
        input_path=resolved_input,
        output_path=resolved_output,
        shape_tczyx=metadata.shape_tczyx,
        chunk_shape=chunk_shape,
        dtype=str(level_zero.dtype),
        pyramid_levels_written=pyramid_levels_written,
    )


def _prepare_output_path(output_path: Path, *, overwrite: bool) -> None:
    if output_path.exists():
        if not overwrite:
            raise FileExistsError(
                f"Output path already exists: {output_path}. Use overwrite=True to replace it."
            )
        if output_path.is_dir():
            shutil.rmtree(output_path)
        else:
            output_path.unlink()


def _default_chunk_shape(shape_tczyx: tuple[int, int, int, int, int]) -> tuple[int, int, int, int, int]:
    return (
        1,
        1,
        min(16, shape_tczyx[2]),
        min(256, shape_tczyx[3]),
        min(256, shape_tczyx[4]),
    )


def _write_level_zero(
    *,
    image: Image.Image,
    root: zarr.Group,
    metadata: _ParsedOmeMetadata,
    chunk_shape: tuple[int, int, int, int, int],
) -> tuple[zarr.Array, tuple[tuple[float, float], ...]]:
    n_frames = int(getattr(image, "n_frames", 1))
    if metadata.total_planes > n_frames:
        raise ValueError(
            "OME metadata requires more planes than available TIFF frames: "
            f"{metadata.total_planes} > {n_frames}"
        )

    read_plan = _build_read_plan(metadata=metadata, n_frames=n_frames)
    if not read_plan:
        raise ValueError("No TIFF planes were found to convert.")

    first_ifd, _ = read_plan[0]
    image.seek(first_ifd)
    first_frame = np.asarray(image)
    _validate_frame_shape(first_frame, expected_y=metadata.size_y, expected_x=metadata.size_x)
    frame_dtype = first_frame.dtype.newbyteorder("=")

    level_zero = root.create_array(
        "0",
        shape=metadata.shape_tczyx,
        chunks=chunk_shape,
        dtype=frame_dtype,
        overwrite=True,
    )

    channel_min = np.full(metadata.size_c, np.inf, dtype=np.float64)
    channel_max = np.full(metadata.size_c, -np.inf, dtype=np.float64)

    for ifd, (t_index, c_index, z_index) in read_plan:
        image.seek(ifd)
        frame = np.asarray(image)
        _validate_frame_shape(frame, expected_y=metadata.size_y, expected_x=metadata.size_x)
        native_frame = np.asarray(frame, dtype=frame_dtype)
        level_zero[t_index, c_index, z_index, :, :] = native_frame

        plane_min = float(np.min(native_frame))
        plane_max = float(np.max(native_frame))
        if plane_min < channel_min[c_index]:
            channel_min[c_index] = plane_min
        if plane_max > channel_max[c_index]:
            channel_max[c_index] = plane_max

    channel_windows = tuple(
        (float(channel_min[index]), float(channel_max[index])) for index in range(metadata.size_c)
    )
    return level_zero, channel_windows


def _build_read_plan(
    *,
    metadata: _ParsedOmeMetadata,
    n_frames: int,
) -> list[tuple[int, tuple[int, int, int]]]:
    axis_order = _non_spatial_axis_order(metadata.dimension_order)
    sizes = {"t": metadata.size_t, "c": metadata.size_c, "z": metadata.size_z}

    coord_to_ifd: dict[tuple[int, int, int], int] = {}
    for ifd, coord in sorted(metadata.ifd_to_coord.items()):
        if ifd >= n_frames:
            continue
        if coord not in coord_to_ifd:
            coord_to_ifd[coord] = ifd

    read_plan: list[tuple[int, tuple[int, int, int]]] = []
    for linear_index in range(metadata.total_planes):
        coord = _decode_linear_index(linear_index, axis_order=axis_order, sizes=sizes)
        ifd = coord_to_ifd.get(coord, linear_index)
        if ifd >= n_frames:
            raise ValueError(
                "Unable to resolve TIFF frame for coordinate "
                f"(t={coord[0]}, c={coord[1]}, z={coord[2]})."
            )
        read_plan.append((ifd, coord))
    return read_plan


def _validate_frame_shape(frame: np.ndarray, *, expected_y: int, expected_x: int) -> None:
    if frame.ndim != 2:
        raise ValueError(f"Expected 2D TIFF frames, found {frame.ndim} dimensions.")
    if frame.shape[0] != expected_y or frame.shape[1] != expected_x:
        raise ValueError(
            "Frame shape mismatch while reading TIFF planes: "
            f"expected ({expected_y}, {expected_x}), found {frame.shape}."
        )


def _build_pyramid_levels(
    *,
    root: zarr.Group,
    level_zero: zarr.Array,
    metadata: _ParsedOmeMetadata,
    options: ConversionOptions,
    base_chunk_shape: tuple[int, int, int, int, int],
) -> tuple[int, list[dict[str, Any]]]:
    datasets_metadata: list[dict[str, Any]] = [
        {
            "path": "0",
            "coordinateTransformations": [
                {"type": "scale", "scale": _scale_for_level(metadata=metadata, options=options, level=0)}
            ],
        }
    ]

    previous_array = level_zero
    levels_written = 1
    axis_factors = _axis_downsample_factors(
        downsample_axes=options.downsample_axes,
        downsample_factor=options.downsample_factor,
    )

    for level in range(1, options.pyramid_levels):
        target_shape = _downsampled_shape(previous_array.shape, axis_factors=axis_factors)
        if target_shape == previous_array.shape:
            break

        target_chunks = tuple(
            min(base_chunk_shape[index], target_shape[index]) for index in range(len(target_shape))
        )
        target_array = root.create_array(
            str(level),
            shape=target_shape,
            chunks=target_chunks,
            dtype=previous_array.dtype,
            overwrite=True,
        )
        _populate_downsampled_level(
            source=previous_array,
            destination=target_array,
            axis_factors=axis_factors,
        )
        datasets_metadata.append(
            {
                "path": str(level),
                "coordinateTransformations": [
                    {"type": "scale", "scale": _scale_for_level(metadata=metadata, options=options, level=level)}
                ],
            }
        )
        previous_array = target_array
        levels_written += 1

    return levels_written, datasets_metadata


def _populate_downsampled_level(
    *,
    source: zarr.Array,
    destination: zarr.Array,
    axis_factors: tuple[int, int, int, int, int],
) -> None:
    chunk_shape = tuple(int(value) for value in destination.chunks)
    for dest_slices in _iter_chunk_slices(destination.shape, chunk_shape):
        source_slices: list[slice] = []
        for axis_index, dest_slice in enumerate(dest_slices):
            factor = axis_factors[axis_index]
            src_start = int(dest_slice.start) * factor
            src_stop = min(int(dest_slice.stop) * factor, int(source.shape[axis_index]))
            source_slices.append(slice(src_start, src_stop, factor))
        block = np.asarray(source[tuple(source_slices)])
        destination[dest_slices] = block


def _iter_chunk_slices(
    shape: tuple[int, ...],
    chunk_shape: tuple[int, ...],
) -> Iterator[tuple[slice, ...]]:
    ranges = [range(0, int(dim_size), int(chunk_size)) for dim_size, chunk_size in zip(shape, chunk_shape)]
    for starts in product(*ranges):
        yield tuple(
            slice(start, min(start + int(chunk_shape[axis_index]), int(shape[axis_index])))
            for axis_index, start in enumerate(starts)
        )


def _axis_downsample_factors(
    *,
    downsample_axes: tuple[str, ...],
    downsample_factor: int,
) -> tuple[int, int, int, int, int]:
    return (
        1,
        1,
        downsample_factor if "z" in downsample_axes else 1,
        downsample_factor if "y" in downsample_axes else 1,
        downsample_factor if "x" in downsample_axes else 1,
    )


def _downsampled_shape(
    shape: tuple[int, ...],
    *,
    axis_factors: tuple[int, ...],
) -> tuple[int, ...]:
    downsampled: list[int] = []
    for axis_index, dim_size in enumerate(shape):
        factor = int(axis_factors[axis_index])
        if factor == 1:
            downsampled.append(int(dim_size))
            continue
        downsampled.append(_ceil_div(int(dim_size), factor))
    return tuple(downsampled)


def _ceil_div(value: int, divisor: int) -> int:
    return (value + divisor - 1) // divisor


def _scale_for_level(
    *,
    metadata: _ParsedOmeMetadata,
    options: ConversionOptions,
    level: int,
) -> list[float]:
    base_scale = [
        metadata.physical_size_t,
        1.0,
        metadata.physical_size_z,
        metadata.physical_size_y,
        metadata.physical_size_x,
    ]
    scale_multipliers = _axis_downsample_factors(
        downsample_axes=options.downsample_axes,
        downsample_factor=options.downsample_factor**level,
    )
    return [float(base_scale[index] * scale_multipliers[index]) for index in range(len(base_scale))]


def _build_axes_metadata(metadata: _ParsedOmeMetadata) -> list[dict[str, str]]:
    axes = [
        {"name": "t", "type": "t"},
        {"name": "c", "type": "c"},
        {"name": "z", "type": "z"},
        {"name": "y", "type": "y"},
        {"name": "x", "type": "x"},
    ]
    if metadata.unit_t:
        axes[0]["unit"] = metadata.unit_t
    if metadata.unit_z:
        axes[2]["unit"] = metadata.unit_z
    if metadata.unit_y:
        axes[3]["unit"] = metadata.unit_y
    if metadata.unit_x:
        axes[4]["unit"] = metadata.unit_x
    return axes


def _build_omero_channels(
    *,
    channel_names: tuple[str, ...],
    channel_windows: tuple[tuple[float, float], ...],
) -> list[dict[str, Any]]:
    channels: list[dict[str, Any]] = []
    for index, name in enumerate(channel_names):
        start, end = channel_windows[index]
        if start == end:
            end = start + 1.0
        channels.append(
            {
                "index": index,
                "label": name,
                "color": _CHANNEL_COLORS[index % len(_CHANNEL_COLORS)],
                "window": {"start": _numeric_window_value(start), "end": _numeric_window_value(end)},
            }
        )
    return channels


def _numeric_window_value(value: float) -> float | int:
    integer = int(value)
    if float(integer) == value:
        return integer
    return value


def _parse_ome_metadata(image: Image.Image) -> _ParsedOmeMetadata:
    xml_text = _extract_ome_xml(image)
    if xml_text is None:
        return _fallback_metadata_from_tiff(image)

    root = ET.fromstring(xml_text)
    pixels = _find_first_element(root, "Pixels")
    if pixels is None:
        return _fallback_metadata_from_tiff(image)

    size_x = _parse_positive_int(pixels.attrib.get("SizeX"), name="SizeX")
    size_y = _parse_positive_int(pixels.attrib.get("SizeY"), name="SizeY")
    size_z = _parse_positive_int(pixels.attrib.get("SizeZ"), name="SizeZ")
    size_c = _parse_positive_int(pixels.attrib.get("SizeC"), name="SizeC")
    size_t = _parse_positive_int(pixels.attrib.get("SizeT"), name="SizeT")

    dimension_order = pixels.attrib.get("DimensionOrder", "XYZCT").upper()
    axis_order = _non_spatial_axis_order(dimension_order)
    sizes = {"t": size_t, "c": size_c, "z": size_z}

    channel_names = _extract_channel_names(pixels, size_c=size_c)
    ifd_to_coord = _extract_ifd_mapping(pixels, axis_order=axis_order, sizes=sizes)

    return _ParsedOmeMetadata(
        size_t=size_t,
        size_c=size_c,
        size_z=size_z,
        size_y=size_y,
        size_x=size_x,
        dimension_order=dimension_order,
        channel_names=channel_names,
        physical_size_t=_parse_optional_float(pixels.attrib.get("TimeIncrement"), default=1.0),
        physical_size_z=_parse_optional_float(pixels.attrib.get("PhysicalSizeZ"), default=1.0),
        physical_size_y=_parse_optional_float(pixels.attrib.get("PhysicalSizeY"), default=1.0),
        physical_size_x=_parse_optional_float(pixels.attrib.get("PhysicalSizeX"), default=1.0),
        unit_t=_normalize_unit(pixels.attrib.get("TimeIncrementUnit")),
        unit_z=_normalize_unit(pixels.attrib.get("PhysicalSizeZUnit")),
        unit_y=_normalize_unit(pixels.attrib.get("PhysicalSizeYUnit")),
        unit_x=_normalize_unit(pixels.attrib.get("PhysicalSizeXUnit")),
        ifd_to_coord=ifd_to_coord,
    )


def _extract_ome_xml(image: Image.Image) -> str | None:
    description = image.tag_v2.get(270)
    if description is None:
        return None
    if isinstance(description, (tuple, list)):
        if not description:
            return None
        description = description[0]
    if isinstance(description, bytes):
        text = description.decode("utf-8", errors="ignore")
    else:
        text = str(description)
    if "<OME" not in text:
        return None
    return text


def _find_first_element(root: ET.Element, local_name: str) -> ET.Element | None:
    for element in root.iter():
        if _local_name(element.tag) == local_name:
            return element
    return None


def _local_name(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _extract_channel_names(pixels: ET.Element, *, size_c: int) -> tuple[str, ...]:
    names: list[str] = []
    for child in pixels:
        if _local_name(child.tag) != "Channel":
            continue
        value = child.attrib.get("Name") or child.attrib.get("ID") or ""
        names.append(value if value else f"c{len(names)}")
    if len(names) < size_c:
        names.extend(f"c{index}" for index in range(len(names), size_c))
    return tuple(names[:size_c])


def _extract_ifd_mapping(
    pixels: ET.Element,
    *,
    axis_order: tuple[str, str, str],
    sizes: dict[str, int],
) -> dict[int, tuple[int, int, int]]:
    mapping: dict[int, tuple[int, int, int]] = {}
    next_ifd = 0
    for child in pixels:
        if _local_name(child.tag) != "TiffData":
            continue

        ifd = _parse_optional_int(child.attrib.get("IFD"), default=next_ifd)
        plane_count = _parse_optional_int(child.attrib.get("PlaneCount"), default=1)
        first_t = _parse_optional_int(child.attrib.get("FirstT"), default=0)
        first_c = _parse_optional_int(child.attrib.get("FirstC"), default=0)
        first_z = _parse_optional_int(child.attrib.get("FirstZ"), default=0)

        linear_index = _encode_linear_index(
            t=first_t,
            c=first_c,
            z=first_z,
            axis_order=axis_order,
            sizes=sizes,
        )
        for offset in range(plane_count):
            mapping[ifd + offset] = _decode_linear_index(
                linear_index + offset,
                axis_order=axis_order,
                sizes=sizes,
            )
        next_ifd = ifd + plane_count
    return mapping


def _fallback_metadata_from_tiff(image: Image.Image) -> _ParsedOmeMetadata:
    width, height = image.size
    n_frames = int(getattr(image, "n_frames", 1))
    return _ParsedOmeMetadata(
        size_t=1,
        size_c=1,
        size_z=n_frames,
        size_y=height,
        size_x=width,
        dimension_order="XYZCT",
        channel_names=("c0",),
        physical_size_t=1.0,
        physical_size_z=1.0,
        physical_size_y=1.0,
        physical_size_x=1.0,
        unit_t=None,
        unit_z=None,
        unit_y=None,
        unit_x=None,
        ifd_to_coord={},
    )


def _non_spatial_axis_order(dimension_order: str) -> tuple[str, str, str]:
    axes = [axis.lower() for axis in dimension_order if axis in {"T", "C", "Z"}]
    if len(axes) != 3 or set(axes) != {"t", "c", "z"}:
        raise ValueError(f"Unsupported OME DimensionOrder: {dimension_order}")
    return (axes[0], axes[1], axes[2])


def _decode_linear_index(
    linear_index: int,
    *,
    axis_order: tuple[str, str, str],
    sizes: dict[str, int],
) -> tuple[int, int, int]:
    remaining = int(linear_index)
    values = {"t": 0, "c": 0, "z": 0}
    for axis in axis_order:
        axis_size = sizes[axis]
        values[axis] = remaining % axis_size
        remaining //= axis_size
    return (values["t"], values["c"], values["z"])


def _encode_linear_index(
    *,
    t: int,
    c: int,
    z: int,
    axis_order: tuple[str, str, str],
    sizes: dict[str, int],
) -> int:
    values = {"t": t, "c": c, "z": z}
    multiplier = 1
    linear_index = 0
    for axis in axis_order:
        value = values[axis]
        if value < 0 or value >= sizes[axis]:
            raise ValueError(f"{axis.upper()} index out of range in OME metadata: {value}")
        linear_index += value * multiplier
        multiplier *= sizes[axis]
    return linear_index


def _parse_positive_int(value: str | None, *, name: str) -> int:
    if value is None:
        raise ValueError(f"Missing required OME attribute: {name}")
    parsed = int(value)
    if parsed < 1:
        raise ValueError(f"OME attribute {name} must be >= 1.")
    return parsed


def _parse_optional_int(value: str | None, *, default: int) -> int:
    if value is None:
        return default
    return int(value)


def _parse_optional_float(value: str | None, *, default: float) -> float:
    if value is None:
        return default
    return float(value)


def _normalize_unit(unit: str | None) -> str | None:
    if unit is None:
        return None
    lowered = unit.strip().lower()
    if lowered in {"um", "µm", "μm", "micron", "microns", "micrometer", "micrometers"}:
        return "micrometer"
    if lowered in {"s", "sec", "second", "seconds"}:
        return "second"
    return lowered
