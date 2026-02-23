from __future__ import annotations

import copy
import hashlib
import json
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import jsonpatch
from pydantic import ValidationError

from lucida.errors import LucidaError
from lucida.io.omezarr_reader import read_omezarr
from lucida.io.uri import is_remote_uri, normalize_uri
from lucida.models.api import (
    ApiWarning,
    DatasetOpenResponse,
    SessionCreateResponse,
    ViewCreateResponse,
    ViewGetResponse,
    ViewUpdateResponse,
)
from lucida.models.dataset_summary import DatasetHints, DatasetSummary
from lucida.models.view_state import (
    AxisSelector,
    Camera2D,
    ChannelContrast,
    DatasetRef,
    ImageChannelSettings,
    ImageLayerSettings,
    LayerSource,
    LayerState,
    SlabSettings,
    SliceSettings,
    View2D,
    ViewState,
    Viewport,
)


def generate_dataset_id(normalized_uri: str) -> str:
    digest = hashlib.sha256(normalized_uri.encode("utf-8")).hexdigest()[:16]
    return f"ds_{digest}"


@dataclass(slots=True)
class SessionRecord:
    session_id: str
    created_at: datetime
    dataset_ids: set[str] = field(default_factory=set)
    view_ids: set[str] = field(default_factory=set)


@dataclass(slots=True)
class DatasetRecord:
    dataset_summary: DatasetSummary
    session_ids: set[str] = field(default_factory=set)


@dataclass(slots=True)
class ViewRecord:
    session_id: str
    view_state: ViewState


class DatasetService:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.sessions_by_id: dict[str, SessionRecord] = {}
        self.datasets_by_id: dict[str, DatasetRecord] = {}
        self.views_by_id: dict[str, ViewRecord] = {}
        self._compat_session_id: str | None = None

    def open_dataset(
        self,
        *,
        uri: str,
        dataset_id: str | None = None,
        session_id: str | None = None,
        include_full_raw_metadata: bool = False,
    ) -> DatasetOpenResponse:
        with self._lock:
            session = self._resolve_session(session_id)
            normalized_uri = normalize_uri(uri)
            resolved_dataset_id = dataset_id or generate_dataset_id(normalized_uri)

            read_result, warnings = read_omezarr(
                uri=normalized_uri,
                include_full_raw_metadata=include_full_raw_metadata,
            )

            hints = DatasetHints(
                is_remote=is_remote_uri(normalized_uri),
                recommended_tile_px=read_result.recommended_tile_px,
            )

            dataset_summary = DatasetSummary(
                dataset_id=resolved_dataset_id,
                uri=normalized_uri,
                opened_at=datetime.now(tz=timezone.utc),
                axes=read_result.axes,
                shape=read_result.shape,
                dtype=read_result.dtype,
                channels=read_result.channels,
                multiscales=read_result.multiscales,
                hints=hints,
                raw_metadata=read_result.raw_metadata,
            )

            dataset_record = self.datasets_by_id.get(resolved_dataset_id)
            if dataset_record is None:
                dataset_record = DatasetRecord(dataset_summary=dataset_summary)
                self.datasets_by_id[resolved_dataset_id] = dataset_record
            else:
                dataset_record.dataset_summary = dataset_summary
            dataset_record.session_ids.add(session.session_id)
            session.dataset_ids.add(resolved_dataset_id)

            return DatasetOpenResponse(dataset_summary=dataset_summary, warnings=warnings)

    def create_session(self) -> SessionCreateResponse:
        with self._lock:
            session = self._create_session_record()
            return SessionCreateResponse(session_id=session.session_id, created_at=session.created_at)

    def create_view(
        self,
        *,
        dataset_id: str,
        session_id: str | None = None,
        mode: str = "2d",
        multiscale_name: str | None = None,
        viewport: Viewport | None = None,
        selectors: list[AxisSelector] | None = None,
        view_2d: View2D | None = None,
    ) -> ViewCreateResponse:
        with self._lock:
            session = self._resolve_session(session_id)
            dataset_summary = self._resolve_dataset_for_session(
                dataset_id=dataset_id, session=session, attach_if_missing=True
            )

            if mode != "2d":
                raise LucidaError(
                    code="unsupported_mode",
                    message="Only mode=2d is supported in this slice.",
                    details={"mode": mode},
                    status_code=422,
                )

            selected_multiscale_name = multiscale_name or dataset_summary.multiscales[0].name
            self._validate_multiscale_name(dataset_summary, selected_multiscale_name)

            selector_input = selectors or self._default_selectors(dataset_summary)
            normalized_selectors, selector_warnings = self._normalize_selectors(
                selectors=selector_input,
                dataset_summary=dataset_summary,
                operation="create_view",
            )

            resolved_viewport = viewport or self._default_viewport()
            resolved_view_2d = view_2d or self._default_view_2d(
                dataset_summary=dataset_summary,
                selectors=normalized_selectors,
            )
            resolved_view_2d, view_warnings = self._normalize_view_2d(
                view_2d=resolved_view_2d,
                dataset_summary=dataset_summary,
                selectors=normalized_selectors,
            )

            view_state = ViewState(
                view_id=self._generate_view_id(),
                session_id=session.session_id,
                created_at=datetime.now(tz=timezone.utc),
                mode="2d",
                datasets=[
                    DatasetRef(
                        dataset_id=dataset_summary.dataset_id,
                        multiscale_name=selected_multiscale_name,
                    )
                ],
                viewport=resolved_viewport,
                selectors=normalized_selectors,
                view_2d=resolved_view_2d,
                layers=[self._default_image_layer(dataset_summary, selected_multiscale_name)],
                state_version=0,
            )

            finalized_view = self._with_state_hash(view_state=view_state, state_version=0)
            self.views_by_id[finalized_view.view_id] = ViewRecord(
                session_id=session.session_id, view_state=finalized_view
            )
            session.view_ids.add(finalized_view.view_id)

            warnings = [*selector_warnings, *view_warnings]
            return ViewCreateResponse(
                view_state=finalized_view,
                warnings=warnings,
                selectors_applied=normalized_selectors,
            )

    def get_view(self, *, view_id: str, session_id: str | None = None) -> ViewGetResponse:
        with self._lock:
            view_record = self.views_by_id.get(view_id)
            if view_record is None:
                raise LucidaError(
                    code="view_not_found",
                    message="View was not found.",
                    details={"view_id": view_id},
                    status_code=404,
                )

            if session_id is not None:
                session = self._require_session(session_id)
                if view_id not in session.view_ids:
                    raise LucidaError(
                        code="view_not_found",
                        message="View was not found in session.",
                        details={"view_id": view_id, "session_id": session_id},
                        status_code=404,
                    )

            return ViewGetResponse(view_state=view_record.view_state)

    def update_view(
        self,
        *,
        view_id: str,
        patch: list[dict[str, Any]],
        session_id: str | None = None,
    ) -> ViewUpdateResponse:
        with self._lock:
            view_record = self.views_by_id.get(view_id)
            if view_record is None:
                raise LucidaError(
                    code="view_not_found",
                    message="View was not found.",
                    details={"view_id": view_id},
                    status_code=404,
                )

            if session_id is not None:
                session = self._require_session(session_id)
                if view_id not in session.view_ids:
                    raise LucidaError(
                        code="view_not_found",
                        message="View was not found in session.",
                        details={"view_id": view_id, "session_id": session_id},
                        status_code=404,
                    )
            else:
                session = self.sessions_by_id[view_record.session_id]

            current_payload = view_record.view_state.model_dump(mode="json")
            try:
                patched_payload = jsonpatch.apply_patch(current_payload, patch, in_place=False)
            except Exception as exc:
                raise LucidaError(
                    code="invalid_patch",
                    message="Failed to apply JSON patch.",
                    details={"view_id": view_id, "reason": str(exc)},
                    status_code=422,
                ) from exc

            try:
                candidate = ViewState.model_validate(patched_payload)
            except ValidationError as exc:
                raise LucidaError(
                    code="invalid_patch",
                    message="Patched view state did not validate.",
                    details={"view_id": view_id, "errors": exc.errors()},
                    status_code=422,
                ) from exc

            if candidate.mode != "2d":
                raise LucidaError(
                    code="unsupported_mode",
                    message="Only mode=2d is supported in this slice.",
                    details={"mode": candidate.mode},
                    status_code=422,
                )

            self._validate_immutable_view_fields(
                current=view_record.view_state,
                candidate=candidate,
            )

            primary_dataset_summary = self._resolve_primary_dataset_for_view(
                view_state=candidate,
                session=session,
            )

            selectors, selector_warnings = self._normalize_selectors(
                selectors=candidate.selectors,
                dataset_summary=primary_dataset_summary,
                operation="update_view",
            )
            candidate = candidate.model_copy(update={"selectors": selectors}, deep=True)

            normalized_view_2d, view_warnings = self._normalize_view_2d(
                view_2d=candidate.view_2d,
                dataset_summary=primary_dataset_summary,
                selectors=selectors,
            )
            candidate = candidate.model_copy(update={"view_2d": normalized_view_2d}, deep=True)

            next_state_version = view_record.view_state.state_version + 1
            finalized = self._with_state_hash(view_state=candidate, state_version=next_state_version)
            self.views_by_id[view_id] = ViewRecord(session_id=session.session_id, view_state=finalized)

            warnings = [*selector_warnings, *view_warnings]
            return ViewUpdateResponse(
                view_state=finalized,
                warnings=warnings,
                selectors_applied=selectors,
            )

    def _resolve_session(self, session_id: str | None) -> SessionRecord:
        if session_id is not None:
            return self._require_session(session_id)
        if self._compat_session_id is None:
            compatibility_session = self._create_session_record(prefix="compat")
            self._compat_session_id = compatibility_session.session_id
        return self.sessions_by_id[self._compat_session_id]

    def _require_session(self, session_id: str) -> SessionRecord:
        session = self.sessions_by_id.get(session_id)
        if session is None:
            raise LucidaError(
                code="session_not_found",
                message="Session was not found.",
                details={"session_id": session_id},
                status_code=404,
            )
        return session

    def _create_session_record(self, prefix: str = "session") -> SessionRecord:
        session_id = f"{prefix}_{uuid.uuid4().hex[:16]}"
        session = SessionRecord(session_id=session_id, created_at=datetime.now(tz=timezone.utc))
        self.sessions_by_id[session_id] = session
        return session

    def _resolve_dataset_for_session(
        self,
        *,
        dataset_id: str,
        session: SessionRecord,
        attach_if_missing: bool,
    ) -> DatasetSummary:
        dataset_record = self.datasets_by_id.get(dataset_id)
        if dataset_record is None:
            raise LucidaError(
                code="dataset_not_found",
                message="Dataset was not found.",
                details={"dataset_id": dataset_id},
                status_code=404,
            )
        if attach_if_missing and dataset_id not in session.dataset_ids:
            session.dataset_ids.add(dataset_id)
            dataset_record.session_ids.add(session.session_id)
        return dataset_record.dataset_summary

    def _resolve_primary_dataset_for_view(
        self, *, view_state: ViewState, session: SessionRecord
    ) -> DatasetSummary:
        dataset_ref = view_state.datasets[0]
        dataset_summary = self._resolve_dataset_for_session(
            dataset_id=dataset_ref.dataset_id,
            session=session,
            attach_if_missing=True,
        )
        self._validate_multiscale_name(dataset_summary, dataset_ref.multiscale_name)
        return dataset_summary

    def _validate_multiscale_name(
        self, dataset_summary: DatasetSummary, multiscale_name: str
    ) -> None:
        available = {multiscale.name for multiscale in dataset_summary.multiscales}
        if multiscale_name not in available:
            raise LucidaError(
                code="dataset_not_found",
                message="Requested multiscale was not found in dataset.",
                details={
                    "dataset_id": dataset_summary.dataset_id,
                    "multiscale_name": multiscale_name,
                    "available_multiscales": sorted(available),
                },
                status_code=404,
            )

    def _validate_immutable_view_fields(self, *, current: ViewState, candidate: ViewState) -> None:
        if current.view_id != candidate.view_id:
            raise LucidaError(
                code="invalid_patch",
                message="view_id is immutable.",
                details={"expected": current.view_id, "actual": candidate.view_id},
                status_code=422,
            )
        if current.session_id != candidate.session_id:
            raise LucidaError(
                code="invalid_patch",
                message="session_id is immutable.",
                details={"expected": current.session_id, "actual": candidate.session_id},
                status_code=422,
            )
        if current.created_at != candidate.created_at:
            raise LucidaError(
                code="invalid_patch",
                message="created_at is immutable.",
                details={"view_id": current.view_id},
                status_code=422,
            )

    def _default_viewport(self) -> Viewport:
        return Viewport(width_px=1024, height_px=1024, pixel_ratio=1.0)

    def _default_selectors(self, dataset_summary: DatasetSummary) -> list[AxisSelector]:
        selectors = [
            AxisSelector(axis=axis.name, kind="index", index=0, clamp=True)
            for axis in dataset_summary.axes
            if axis.role not in {"x", "y"}
        ]
        if selectors:
            return selectors
        return [AxisSelector(axis=dataset_summary.axes[0].name, kind="index", index=0, clamp=True)]

    def _default_view_2d(
        self,
        *,
        dataset_summary: DatasetSummary,
        selectors: list[AxisSelector],
    ) -> View2D:
        axis_by_role = {axis.role: axis for axis in dataset_summary.axes}
        x_axis = axis_by_role.get("x", dataset_summary.axes[-1])
        y_axis = axis_by_role.get("y", dataset_summary.axes[-2] if len(dataset_summary.axes) > 1 else x_axis)

        slice_axis = self._select_slice_axis(dataset_summary, selectors)
        slice_index = self._selector_index_for_axis(selectors=selectors, axis_name=slice_axis)

        return View2D(
            plane="xy",
            slice=SliceSettings(
                axis=slice_axis,
                index=slice_index,
                slab=SlabSettings(thickness_vox=1, mode="single"),
            ),
            camera=Camera2D(
                center_world=(float(x_axis.size) / 2.0, float(y_axis.size) / 2.0),
                zoom=1.0,
                rotation_deg=0.0,
            ),
        )

    def _default_image_layer(
        self, dataset_summary: DatasetSummary, multiscale_name: str
    ) -> LayerState:
        channels = self._default_image_channels(dataset_summary)
        channel_mode: str
        if len(channels) <= 1:
            channel_mode = "single"
        else:
            channel_mode = "composite"

        return LayerState(
            layer_id="image_0",
            type="image",
            dataset_id=dataset_summary.dataset_id,
            source=LayerSource(multiscale_name=multiscale_name, array_path=None),
            visible=True,
            opacity=1.0,
            image=ImageLayerSettings(
                channel_mode=channel_mode,
                channels=channels,
                interpolation="linear",
            ),
        )

    def _default_image_channels(self, dataset_summary: DatasetSummary) -> list[ImageChannelSettings]:
        channels: list[ImageChannelSettings] = []
        if dataset_summary.channels:
            for channel in dataset_summary.channels:
                contrast: ChannelContrast | None = None
                if channel.suggested_contrast is not None:
                    suggested = channel.suggested_contrast
                    policy = suggested.policy or ("fixed" if suggested.min is not None else "percentile")
                    contrast = ChannelContrast(
                        policy=policy,
                        min=suggested.min,
                        max=suggested.max,
                        p_low=suggested.p_low or 1.0,
                        p_high=suggested.p_high or 99.0,
                    )
                channels.append(
                    ImageChannelSettings(
                        index=channel.index,
                        enabled=True,
                        color_rgba=channel.color_rgba,
                        contrast=contrast,
                        gamma=channel.suggested_gamma or 1.0,
                    )
                )
            return channels

        c_axis = next((axis for axis in dataset_summary.axes if axis.role == "c"), None)
        channel_count = c_axis.size if c_axis is not None else 1
        for index in range(channel_count):
            channels.append(
                ImageChannelSettings(
                    index=index,
                    enabled=True,
                    color_rgba=None,
                    contrast=None,
                    gamma=1.0,
                )
            )
        return channels

    def _normalize_view_2d(
        self,
        *,
        view_2d: View2D | None,
        dataset_summary: DatasetSummary,
        selectors: list[AxisSelector],
    ) -> tuple[View2D, list[ApiWarning]]:
        warnings: list[ApiWarning] = []
        if view_2d is None:
            return self._default_view_2d(dataset_summary=dataset_summary, selectors=selectors), warnings

        axis_sizes = {axis.name: axis.size for axis in dataset_summary.axes}
        default_slice_axis = self._select_slice_axis(dataset_summary, selectors)

        slice_axis = view_2d.slice.axis if view_2d.slice and view_2d.slice.axis else default_slice_axis
        if slice_axis not in axis_sizes:
            warnings.append(
                ApiWarning(
                    code="slice_axis_fallback",
                    message="Slice axis was invalid and replaced with default axis.",
                    details={"requested_axis": slice_axis, "fallback_axis": default_slice_axis},
                )
            )
            slice_axis = default_slice_axis

        slice_index = (
            view_2d.slice.index
            if view_2d.slice is not None and view_2d.slice.index is not None
            else self._selector_index_for_axis(selectors=selectors, axis_name=slice_axis)
        )
        clamped_slice_index = max(0, min(slice_index, axis_sizes[slice_axis] - 1))
        if clamped_slice_index != slice_index:
            warnings.append(
                ApiWarning(
                    code="slice_index_clamped",
                    message="Slice index exceeded axis bounds and was clamped.",
                    details={
                        "axis": slice_axis,
                        "requested_index": slice_index,
                        "applied_index": clamped_slice_index,
                    },
                )
            )
        slab = view_2d.slice.slab if view_2d.slice and view_2d.slice.slab else SlabSettings()

        normalized_view = view_2d.model_copy(
            update={
                "slice": SliceSettings(
                    axis=slice_axis,
                    index=clamped_slice_index,
                    slab=slab,
                )
            },
            deep=True,
        )
        return normalized_view, warnings

    def _select_slice_axis(
        self, dataset_summary: DatasetSummary, selectors: list[AxisSelector]
    ) -> str:
        axis_by_name = {axis.name: axis for axis in dataset_summary.axes}
        for selector in selectors:
            axis = axis_by_name.get(selector.axis)
            if axis is not None and axis.role == "z":
                return selector.axis
        return selectors[0].axis

    def _selector_index_for_axis(self, *, selectors: list[AxisSelector], axis_name: str) -> int:
        selector = next((item for item in selectors if item.axis == axis_name), None)
        if selector is None:
            return 0
        if selector.kind == "index" and selector.index is not None:
            return selector.index
        if selector.kind == "range" and selector.start is not None:
            return selector.start
        if selector.kind == "set" and selector.indices:
            return selector.indices[0]
        return 0

    def _normalize_selectors(
        self,
        *,
        selectors: list[AxisSelector],
        dataset_summary: DatasetSummary,
        operation: str,
    ) -> tuple[list[AxisSelector], list[ApiWarning]]:
        if not selectors:
            raise LucidaError(
                code="selector_out_of_bounds",
                message="At least one selector is required.",
                details={"operation": operation},
                status_code=422,
            )

        axis_sizes = {axis.name: axis.size for axis in dataset_summary.axes}
        normalized: list[AxisSelector] = []
        warnings: list[ApiWarning] = []

        for selector in selectors:
            axis_size = axis_sizes.get(selector.axis)
            if axis_size is None:
                raise LucidaError(
                    code="selector_out_of_bounds",
                    message="Selector axis does not exist in dataset.",
                    details={"axis": selector.axis, "dataset_id": dataset_summary.dataset_id},
                    status_code=422,
                )

            if selector.kind == "index":
                normalized_selector, selector_warning = self._normalize_index_selector(
                    selector=selector, axis_size=axis_size
                )
            elif selector.kind == "range":
                normalized_selector, selector_warning = self._normalize_range_selector(
                    selector=selector, axis_size=axis_size
                )
            else:
                normalized_selector, selector_warning = self._normalize_set_selector(
                    selector=selector, axis_size=axis_size
                )

            if selector_warning is not None:
                warnings.append(selector_warning)
            normalized.append(normalized_selector)

        return normalized, warnings

    def _normalize_index_selector(
        self, *, selector: AxisSelector, axis_size: int
    ) -> tuple[AxisSelector, ApiWarning | None]:
        assert selector.index is not None
        requested = selector.index
        if not selector.clamp and not (0 <= requested < axis_size):
            raise LucidaError(
                code="selector_out_of_bounds",
                message="Selector index is out of bounds and clamp is disabled.",
                details={"axis": selector.axis, "index": requested, "size": axis_size},
                status_code=422,
            )

        applied = max(0, min(requested, axis_size - 1))
        warning = None
        if applied != requested:
            warning = ApiWarning(
                code="selector_clamped",
                message="Selector index was clamped to fit axis bounds.",
                details={"axis": selector.axis, "requested": requested, "applied": applied},
            )
        return (
            AxisSelector(
                axis=selector.axis,
                kind="index",
                index=applied,
                clamp=selector.clamp,
            ),
            warning,
        )

    def _normalize_range_selector(
        self, *, selector: AxisSelector, axis_size: int
    ) -> tuple[AxisSelector, ApiWarning | None]:
        assert selector.start is not None
        assert selector.end_exclusive is not None
        requested_start = selector.start
        requested_end = selector.end_exclusive

        if not selector.clamp and not (
            0 <= requested_start < requested_end <= axis_size
        ):
            raise LucidaError(
                code="selector_out_of_bounds",
                message="Selector range is out of bounds and clamp is disabled.",
                details={
                    "axis": selector.axis,
                    "start": requested_start,
                    "end_exclusive": requested_end,
                    "size": axis_size,
                },
                status_code=422,
            )

        start = max(0, min(requested_start, axis_size - 1))
        end = max(1, min(requested_end, axis_size))
        if start >= end:
            end = min(axis_size, start + 1)
            if start >= end:
                start = max(0, end - 1)

        warning = None
        if start != requested_start or end != requested_end:
            warning = ApiWarning(
                code="selector_clamped",
                message="Selector range was clamped to fit axis bounds.",
                details={
                    "axis": selector.axis,
                    "requested": {"start": requested_start, "end_exclusive": requested_end},
                    "applied": {"start": start, "end_exclusive": end},
                },
            )

        return (
            AxisSelector(
                axis=selector.axis,
                kind="range",
                start=start,
                end_exclusive=end,
                clamp=selector.clamp,
            ),
            warning,
        )

    def _normalize_set_selector(
        self, *, selector: AxisSelector, axis_size: int
    ) -> tuple[AxisSelector, ApiWarning | None]:
        assert selector.indices is not None
        requested_indices = selector.indices

        if not selector.clamp:
            if not requested_indices:
                raise LucidaError(
                    code="selector_out_of_bounds",
                    message="Selector set cannot be empty when clamp is disabled.",
                    details={"axis": selector.axis},
                    status_code=422,
                )
            if any(index < 0 or index >= axis_size for index in requested_indices):
                raise LucidaError(
                    code="selector_out_of_bounds",
                    message="Selector set contains out-of-bounds values and clamp is disabled.",
                    details={"axis": selector.axis, "indices": requested_indices, "size": axis_size},
                    status_code=422,
                )
            normalized = sorted(set(requested_indices))
            return (
                AxisSelector(
                    axis=selector.axis,
                    kind="set",
                    indices=normalized,
                    clamp=False,
                ),
                None,
            )

        clamped = [max(0, min(index, axis_size - 1)) for index in requested_indices]
        normalized = sorted(set(clamped))
        if not normalized:
            normalized = [0]

        warning = None
        if normalized != sorted(set(requested_indices)):
            warning = ApiWarning(
                code="selector_clamped",
                message="Selector set was normalized to fit axis bounds.",
                details={"axis": selector.axis, "requested": requested_indices, "applied": normalized},
            )

        return (
            AxisSelector(
                axis=selector.axis,
                kind="set",
                indices=normalized,
                clamp=True,
            ),
            warning,
        )

    def _generate_view_id(self) -> str:
        return f"view_{uuid.uuid4().hex[:16]}"

    def _with_state_hash(self, *, view_state: ViewState, state_version: int) -> ViewState:
        base_state = view_state.model_copy(
            update={
                "state_version": state_version,
                "state_hash": None,
            },
            deep=True,
        )
        computed_hash = self._compute_state_hash(base_state)
        return base_state.model_copy(update={"state_hash": computed_hash}, deep=True)

    def _compute_state_hash(self, view_state: ViewState) -> str:
        payload = view_state.model_dump(mode="python")
        payload.pop("state_hash", None)
        payload.pop("state_version", None)
        canonical = self._canonicalize_for_hash(payload)
        serialized = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    def _canonicalize_for_hash(self, value: Any) -> Any:
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, dict):
            return {
                key: self._canonicalize_for_hash(value[key])
                for key in sorted(value.keys())
            }
        if isinstance(value, list):
            return [self._canonicalize_for_hash(item) for item in value]
        if isinstance(value, float):
            quantized = round(value, 6)
            if quantized == -0.0:
                return 0.0
            return quantized
        return copy.deepcopy(value)
