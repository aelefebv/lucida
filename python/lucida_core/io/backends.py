"""Backend adapters for local/HTTP/S3/GCS OME-Zarr metadata + export."""

from __future__ import annotations

from dataclasses import dataclass
import importlib.util
import math
import os
from pathlib import Path
import shutil
from typing import Any, Literal
from urllib.parse import unquote, urlparse

from .cache import CacheManager
from .metadata import AxisMapError, apply_axis_map, axis_type_for_label, default_axis_labels, parse_transform


BackendKind = Literal["local", "http", "s3", "gcs", "synthetic"]


class IOBackendError(RuntimeError):
    """Base IO backend exception."""


class MissingDependencyError(IOBackendError):
    """Raised when a backend requires an optional dependency that is missing."""


@dataclass
class DatasetMetadata:
    backend: BackendKind
    uri: str
    axis_labels: list[str]
    shape: list[int]
    dtype: str
    transform: dict[str, list[float]]
    read_only: bool
    ngff_version: str
    zarr_format: int
    multiscales: list[dict[str, Any]]
    cache_snapshot: dict[str, Any]


def detect_backend(uri: str) -> BackendKind:
    if uri.startswith("synthetic://") or uri.startswith("mem://"):
        return "synthetic"
    if uri.startswith("http://") or uri.startswith("https://"):
        return "http"
    if uri.startswith("s3://"):
        return "s3"
    if uri.startswith("gs://"):
        return "gcs"
    if uri.startswith("file://"):
        return "local"
    parsed = urlparse(uri)
    if parsed.scheme:
        raise IOBackendError(f"unsupported dataset URI scheme: {uri}")
    if os.path.isabs(uri) or uri.endswith(".zarr"):
        return "local"
    raise IOBackendError(f"unsupported dataset URI scheme: {uri}")


def _require_dependency(module_name: str) -> None:
    if importlib.util.find_spec(module_name) is None:
        raise MissingDependencyError(f"backend dependency '{module_name}' is required but not installed")


def _local_path_from_uri(uri: str) -> str:
    if uri.startswith("file://"):
        parsed = urlparse(uri)
        return unquote(parsed.path)
    return uri


def _open_zarr_group(uri: str, backend: BackendKind):
    _require_dependency("fsspec")
    _require_dependency("zarr")

    import fsspec
    import zarr

    if backend == "local":
        path = _local_path_from_uri(uri)
        return zarr.open_group(path, mode="r")
    if backend == "http":
        fs, path = fsspec.core.url_to_fs(uri)
    elif backend == "s3":
        _require_dependency("s3fs")
        fs, path = fsspec.core.url_to_fs(uri)
    elif backend == "gcs":
        _require_dependency("gcsfs")
        fs, path = fsspec.core.url_to_fs(uri)
    else:
        raise IOBackendError(f"zarr group is not supported for backend: {backend}")

    fsspec_store = getattr(zarr.storage, "FsspecStore", None)
    if fsspec_store is not None:
        return zarr.open_group(store=fsspec_store(fs=fs, path=path), mode="r")
    return zarr.open_group(store=fs.get_mapper(path), mode="r")


def _canonical_dataset_id(uri: str) -> str:
    import hashlib

    digest = hashlib.sha256(uri.encode("utf-8")).hexdigest()
    return f"{digest[0:8]}-{digest[8:12]}-7{digest[13:16]}-8{digest[17:20]}-{digest[20:32]}"


def _synthetic_metadata(uri: str, read_only: bool, axis_map: dict[str, str] | None, cache: CacheManager) -> DatasetMetadata:
    axis_labels = ["t", "c", "z", "y", "x"]
    shape = [1, 1, 16, 128, 128]
    dtype = "uint16"
    scale = [1.0, 1.0, 1.0, 1.0, 1.0]
    translate = [0.0, 0.0, 0.0, 0.0, 0.0]

    if "mask" in uri:
        dtype = "uint8"
    if "large" in uri:
        shape = [1, 1, 32, 256, 256]
    if "anisotropic" in uri:
        scale = [1.0, 1.0, 2.0, 0.5, 0.5]

    mapped_axes = apply_axis_map(axis_labels, axis_map)
    chunk_bytes = 1
    for dim in shape:
        chunk_bytes *= dim
    cache.touch_chunk(f"{uri}#0", chunk_bytes)
    cache.metadata_set(
        uri,
        {
            "axis_labels": mapped_axes,
            "shape": shape,
            "dtype": dtype,
        },
    )

    multiscales = [
        {
            "name": "synthetic",
            "axes": mapped_axes,
            "levels": [
                {
                    "path": "0",
                    "shape": shape,
                    "chunk_shape": [1, 1, 8, 64, 64],
                }
            ],
        }
    ]

    return DatasetMetadata(
        backend="synthetic",
        uri=uri,
        axis_labels=mapped_axes,
        shape=shape,
        dtype=dtype,
        transform={"scale": scale, "translate": translate},
        read_only=read_only,
        ngff_version="synthetic",
        zarr_format=2,
        multiscales=multiscales,
        cache_snapshot=cache.snapshot(),
    )


def _axis_labels_from_axes_field(axes_field: Any, rank_hint: int) -> list[str]:
    if isinstance(axes_field, list) and axes_field:
        labels: list[str] = []
        for axis in axes_field:
            if isinstance(axis, dict) and isinstance(axis.get("name"), str):
                labels.append(axis["name"])
            elif isinstance(axis, str):
                labels.append(axis)
        if labels:
            return labels
    return default_axis_labels(rank_hint)


def _build_multiscale_summary(group, raw_multiscales: list[dict[str, Any]], fallback_axes: list[str]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for multiscale in raw_multiscales:
        if not isinstance(multiscale, dict):
            continue
        axes = _axis_labels_from_axes_field(multiscale.get("axes"), len(fallback_axes))
        levels: list[dict[str, Any]] = []
        datasets = multiscale.get("datasets")
        if isinstance(datasets, list):
            for dataset_entry in datasets:
                if not isinstance(dataset_entry, dict):
                    continue
                path = str(dataset_entry.get("path", "0"))
                try:
                    array = group[path]
                except Exception:
                    continue
                chunk_shape = list(array.chunks) if getattr(array, "chunks", None) is not None else list(array.shape)
                levels.append(
                    {
                        "path": path,
                        "shape": [int(v) for v in array.shape],
                        "chunk_shape": [int(v) for v in chunk_shape],
                    }
                )
        summaries.append(
            {
                "name": str(multiscale.get("name", "main")),
                "axes": axes,
                "levels": levels,
            }
        )
    return summaries


def _attrs_to_dict(group: Any) -> dict[str, Any]:
    attrs_obj = getattr(group, "attrs", None)
    if attrs_obj is None:
        return {}
    asdict = getattr(attrs_obj, "asdict", None)
    if callable(asdict):
        return dict(asdict())
    return dict(attrs_obj)


def open_dataset_metadata(
    *,
    uri: str,
    read_only: bool,
    axis_map: dict[str, str] | None,
    cache: CacheManager,
) -> DatasetMetadata:
    backend = detect_backend(uri)
    if backend == "synthetic":
        return _synthetic_metadata(uri, read_only, axis_map, cache)

    cached = cache.metadata_get(uri)
    if isinstance(cached, DatasetMetadata):
        return DatasetMetadata(
            backend=cached.backend,
            uri=cached.uri,
            axis_labels=list(cached.axis_labels),
            shape=list(cached.shape),
            dtype=cached.dtype,
            transform={"scale": list(cached.transform["scale"]), "translate": list(cached.transform["translate"])},
            read_only=read_only,
            ngff_version=cached.ngff_version,
            zarr_format=cached.zarr_format,
            multiscales=[dict(item) for item in cached.multiscales],
            cache_snapshot=cache.snapshot(),
        )

    group = _open_zarr_group(uri, backend)
    attrs = _attrs_to_dict(group)
    raw_multiscales = attrs.get("multiscales")
    multiscales = raw_multiscales if isinstance(raw_multiscales, list) else []

    dataset_entry: dict[str, Any] = {}
    dataset_path = "0"
    if multiscales and isinstance(multiscales[0], dict):
        first_multiscale = multiscales[0]
        datasets = first_multiscale.get("datasets")
        if isinstance(datasets, list) and datasets:
            candidate = datasets[0]
            if isinstance(candidate, dict):
                dataset_entry = candidate
                dataset_path = str(candidate.get("path", dataset_path))

    if dataset_path not in group:
        array_keys = sorted(group.array_keys())
        if not array_keys:
            raise IOBackendError("dataset has no arrays")
        dataset_path = array_keys[0]
        dataset_entry = {"path": dataset_path}

    array = group[dataset_path]
    shape = [int(v) for v in array.shape]
    axes = _axis_labels_from_axes_field(
        multiscales[0].get("axes") if multiscales and isinstance(multiscales[0], dict) else None,
        len(shape),
    )
    mapped_axes = apply_axis_map(axes, axis_map)

    transform = parse_transform(dataset_entry, len(shape)).as_dict()
    dtype = str(array.dtype)
    chunk_shape = list(array.chunks) if getattr(array, "chunks", None) is not None else list(shape)

    ngff_version = "0.4"
    if multiscales and isinstance(multiscales[0], dict):
        raw_version = multiscales[0].get("version")
        if isinstance(raw_version, str) and raw_version:
            ngff_version = raw_version

    zarr_format = 2
    raw_zarr_format = attrs.get("zarr_format")
    if raw_zarr_format is None:
        metadata_obj = getattr(group, "metadata", None)
        raw_zarr_format = getattr(metadata_obj, "zarr_format", None)
    if isinstance(raw_zarr_format, int):
        zarr_format = raw_zarr_format

    summaries = _build_multiscale_summary(group, multiscales, mapped_axes)
    if not summaries:
        summaries = [
            {
                "name": "main",
                "axes": mapped_axes,
                "levels": [
                    {
                        "path": dataset_path,
                        "shape": shape,
                        "chunk_shape": [int(v) for v in chunk_shape],
                    }
                ],
            }
        ]

    dtype_itemsize = getattr(array.dtype, "itemsize", 1) or 1
    chunk_bytes = dtype_itemsize * math.prod(int(v) for v in chunk_shape)
    cache.touch_chunk(f"{uri}#{dataset_path}", int(chunk_bytes))

    metadata = DatasetMetadata(
        backend=backend,
        uri=uri,
        axis_labels=mapped_axes,
        shape=shape,
        dtype=dtype,
        transform=transform,
        read_only=read_only,
        ngff_version=ngff_version,
        zarr_format=zarr_format,
        multiscales=summaries,
        cache_snapshot=cache.snapshot(),
    )
    cache.metadata_set(uri, metadata)
    return metadata


def _destination_path(destination_uri: str) -> Path:
    parsed = urlparse(destination_uri)
    if parsed.scheme in {"", "file"}:
        path = unquote(parsed.path) if parsed.scheme == "file" else destination_uri
        if not path:
            raise IOBackendError("destination_uri is empty")
        return Path(path)
    raise IOBackendError("dataset.export currently supports local filesystem destinations only")


def export_dataset_local_v05(
    metadata: DatasetMetadata,
    *,
    destination_uri: str,
    overwrite: bool = False,
) -> str:
    _require_dependency("zarr")
    import zarr

    destination = _destination_path(destination_uri)
    if destination.exists():
        if not overwrite:
            raise FileExistsError(f"destination already exists: {destination}")
        shutil.rmtree(destination)

    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        group = zarr.open_group(str(destination), mode="w", zarr_format=2)
    except TypeError:
        group = zarr.open_group(str(destination), mode="w")
    chunk_shape = tuple(max(1, min(dim, 64)) for dim in metadata.shape)
    create_array = getattr(group, "create_array", None)
    if callable(create_array):
        try:
            create_array(
                name="0",
                shape=tuple(metadata.shape),
                chunks=chunk_shape,
                dtype=metadata.dtype,
                fill_value=0,
            )
        except TypeError:
            create_array(
                "0",
                shape=tuple(metadata.shape),
                chunks=chunk_shape,
                dtype=metadata.dtype,
                fill_value=0,
            )
    else:
        group.create_dataset(
            "0",
            shape=tuple(metadata.shape),
            chunks=chunk_shape,
            dtype=metadata.dtype,
            fill_value=0,
        )
    group.attrs["multiscales"] = [
        {
            "name": "lucida-export",
            "version": "0.5",
            "axes": [{"name": axis, "type": axis_type_for_label(axis)} for axis in metadata.axis_labels],
            "datasets": [
                {
                    "path": "0",
                    "coordinateTransformations": [
                        {"type": "scale", "scale": metadata.transform["scale"]},
                        {"type": "translation", "translation": metadata.transform["translate"]},
                    ],
                }
            ],
        }
    ]
    group.attrs["lucida_exported_from"] = metadata.uri
    return f"file://{destination.resolve()}"


__all__ = [
    "AxisMapError",
    "BackendKind",
    "DatasetMetadata",
    "IOBackendError",
    "MissingDependencyError",
    "_canonical_dataset_id",
    "detect_backend",
    "export_dataset_local_v05",
    "open_dataset_metadata",
]
