"""Core in-memory service implementation for Lucida datasets and views."""

from __future__ import annotations

import copy
import base64
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
from lucida.models.render import (
    RenderImageArtifact,
    RenderImageResponse,
    RenderMeta,
    RenderOutputSpec,
    RenderTimingMs,
)
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
from lucida.service.render_2d import render_view_to_png


def generate_dataset_id(normalized_uri: str) -> str:
    """Build a deterministic dataset identifier from a normalized URI.

    Parameters
    ----------
    normalized_uri:
        Canonical URI string (e.g., ``file://`` URI).
    """
    digest = hashlib.sha256(normalized_uri.encode("utf-8")).hexdigest()[:16]
    return f"ds_{digest}"


@dataclass(slots=True)
class SessionRecord:
    """Session record tracking datasets and views.

    Attributes
    ----------
    session_id:
        Session identifier.
    created_at:
        Session creation timestamp.
    dataset_ids:
        Attached dataset ids.
    view_ids:
        Attached view ids.
    """
    session_id: str
    created_at: datetime
    dataset_ids: set[str] = field(default_factory=set)
    view_ids: set[str] = field(default_factory=set)


@dataclass(slots=True)
class DatasetRecord:
    """Dataset record with session membership tracking.

    Attributes
    ----------
    dataset_summary:
        Cached dataset summary.
    session_ids:
        Sessions currently attached to this dataset.
    """
    dataset_summary: DatasetSummary
    session_ids: set[str] = field(default_factory=set)


@dataclass(slots=True)
class ViewRecord:
    """Stored view state tied to a session.

    Attributes
    ----------
    session_id:
        Owning session id.
    view_state:
        Persisted view state.
    """
    session_id: str
    view_state: ViewState


class DatasetService:
    """Thread-safe in-memory service used by CLI and API handlers.

    Attributes
    ----------
    sessions_by_id:
        Session id to :class:`SessionRecord` mapping.
    datasets_by_id:
        Dataset id to :class:`DatasetRecord` mapping.
    views_by_id:
        View id to :class:`ViewRecord` mapping.
    _compat_session_id:
        Lazily created compatibility session id used for no-session flows.
    """

    def __init__(self) -> None:
        """Initialize in-memory stores and synchronization lock."""
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
        """Open a dataset and upsert its metadata into the active session.

        Parameters
        ----------
        uri:
            Source URI/path for the OME-Zarr dataset.
        dataset_id:
            Optional explicit dataset identifier.
        session_id:
            Optional session to attach the dataset.
        include_full_raw_metadata:
            Keep full metadata payload when true.
        """
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
        """Create and persist a new explicit session."""
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
        """Create a new view for a dataset with normalized selectors and viewport.

        Parameters
        ----------
        dataset_id:
            Dataset identifier to view.
        session_id:
            Optional owning session id.
        mode:
            Render mode (``2d`` supported in this service).
        multiscale_name:
            Optional explicit multiscale name.
        viewport:
            Optional viewport override.
        selectors:
            Optional selectors to initialize the view.
        view_2d:
            Optional explicit 2D view configuration.
        """
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
        """Get a view by id and optional session scope.

        Parameters
        ----------
        view_id:
            Identifier for the target view.
        session_id:
            Optional session guard.
        """
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
        """Apply a JSON patch to an existing view and return updated state.

        Parameters
        ----------
        view_id:
            Target view id.
        patch:
            RFC6902 operations to apply.
        session_id:
            Optional owning session id.
        """
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

    def render_image(
        self,
        *,
        view_id: str,
        output: RenderOutputSpec,
        session_id: str | None = None,
        request_id: str | None = None,
        overrides_json_patch: list[dict[str, Any]] | None = None,
    ) -> RenderImageResponse:
        """Render a view into a PNG image response.

        Parameters
        ----------
        view_id:
            Target view id.
        output:
            Render output specification.
        session_id:
            Optional session id for membership checks.
        request_id:
            Optional caller-provided request id.
        overrides_json_patch:
            Optional RFC6902 patch applied ephemerally for this render.
        """
        if (
            output.width_px > 4096
            or output.height_px > 4096
            or (output.width_px * output.height_px) > 16_777_216
        ):
            raise LucidaError(
                code="render_output_too_large",
                message="Requested render output exceeds configured limits.",
                details={
                    "width_px": output.width_px,
                    "height_px": output.height_px,
                    "max_width_px": 4096,
                    "max_height_px": 4096,
                    "max_pixels": 16_777_216,
                },
                status_code=422,
            )

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

            effective_payload = view_record.view_state.model_dump(mode="json")
            if overrides_json_patch:
                try:
                    effective_payload = jsonpatch.apply_patch(
                        effective_payload,
                        overrides_json_patch,
                        in_place=False,
                    )
                except Exception as exc:
                    raise LucidaError(
                        code="invalid_patch",
                        message="Failed to apply render-time JSON patch overrides.",
                        details={"view_id": view_id, "reason": str(exc)},
                        status_code=422,
                    ) from exc

            try:
                effective_view = ViewState.model_validate(effective_payload)
            except ValidationError as exc:
                raise LucidaError(
                    code="invalid_patch",
                    message="Render-time patched view state did not validate.",
                    details={"view_id": view_id, "errors": exc.errors()},
                    status_code=422,
                ) from exc

            if effective_view.mode != "2d":
                raise LucidaError(
                    code="unsupported_mode",
                    message="Only mode=2d is supported in this slice.",
                    details={"mode": effective_view.mode},
                    status_code=422,
                )

            self._validate_immutable_view_fields(
                current=view_record.view_state,
                candidate=effective_view,
            )

            primary_dataset_summary = self._resolve_primary_dataset_for_view(
                view_state=effective_view,
                session=session,
            )

            selectors, selector_warnings = self._normalize_selectors(
                selectors=effective_view.selectors,
                dataset_summary=primary_dataset_summary,
                operation="render_image",
            )
            effective_view = effective_view.model_copy(update={"selectors": selectors}, deep=True)

            normalized_view_2d, view_warnings = self._normalize_view_2d(
                view_2d=effective_view.view_2d,
                dataset_summary=primary_dataset_summary,
                selectors=selectors,
            )
            effective_view = effective_view.model_copy(
                update={"view_2d": normalized_view_2d},
                deep=True,
            )

            state_hash = self._compute_state_hash(effective_view)
            state_version = view_record.view_state.state_version

        render_result = render_view_to_png(
            dataset_summary=primary_dataset_summary,
            view_state=effective_view,
            output=output,
        )

        payload_bytes = render_result.png_bytes
        payload_b64 = base64.b64encode(payload_bytes).decode("ascii")
        payload_sha256 = hashlib.sha256(payload_bytes).hexdigest()

        warnings = [*selector_warnings, *view_warnings, *render_result.warnings]
        resolved_request_id = request_id or f"req_{uuid.uuid4().hex[:16]}"
        render_id = f"ren_{uuid.uuid4().hex[:16]}"

        return RenderImageResponse(
            request_id=resolved_request_id,
            render_id=render_id,
            view_id=view_id,
            state_hash=state_hash,
            state_version=state_version,
            images=[
                RenderImageArtifact(
                    width_px=output.width_px,
                    height_px=output.height_px,
                    bytes_base64=payload_b64,
                    sha256=payload_sha256,
                )
            ],
            meta=RenderMeta(
                dataset_id=primary_dataset_summary.dataset_id,
                multiscale_name=effective_view.datasets[0].multiscale_name,
                pyramid_level_used=render_result.pyramid_level_used,
                selectors_applied=selectors,
                timing_ms=(
                    render_result.timing_ms
                    if render_result.timing_ms is not None
                    else RenderTimingMs(total=0.0, io=0.0, decode=0.0, gpu_upload=0.0, render=0.0)
                ),
            ),
            warnings=warnings,
        )

    def _resolve_session(self, session_id: str | None) -> SessionRecord:
        """Resolve a provided session id or use a compatibility session.

        Parameters
        ----------
        session_id:
            Optional session id, defaults to compatibility session when omitted.
        """
        if session_id is not None:
            return self._require_session(session_id)
        if self._compat_session_id is None:
            compatibility_session = self._create_session_record(prefix="compat")
            self._compat_session_id = compatibility_session.session_id
        return self.sessions_by_id[self._compat_session_id]

    def _require_session(self, session_id: str) -> SessionRecord:
        """Raise a typed error if the session does not exist.

        Parameters
        ----------
        session_id:
            Session identifier to resolve.
        """
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
        """Create and store a new session record.

        Parameters
        ----------
        prefix:
            Prefix for generated session id.
        """
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
        """Resolve a dataset for a session and optionally attach membership.

        Parameters
        ----------
        dataset_id:
            Identifier of dataset to resolve.
        session:
            Session record for membership checks.
        attach_if_missing:
            Attach dataset to session if not already associated.
        """
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
        """Resolve the primary dataset referenced by the first layer of a view.

        Parameters
        ----------
        view_state:
            View state pointing at target dataset.
        session:
            Owning session record.
        """
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
        """Validate that a named multiscale exists for the dataset.

        Parameters
        ----------
        dataset_summary:
            Dataset metadata containing multiscale names.
        multiscale_name:
            Candidate multiscale identifier.
        """
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
        """Reject patches that attempt to change immutable view fields.

        Parameters
        ----------
        current:
            Stored view state before update.
        candidate:
            Candidate view state after patch.
        """
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
        """Return default viewport dimensions used for new views."""
        return Viewport(width_px=1024, height_px=1024, pixel_ratio=1.0)

    def _default_selectors(self, dataset_summary: DatasetSummary) -> list[AxisSelector]:
        """Create initial selectors from dataset axes.

        Parameters
        ----------
        dataset_summary:
            Source dataset metadata.
        """
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
        """Build a default 2D view state for a dataset and selector set.

        Parameters
        ----------
        dataset_summary:
            Dataset metadata used for axis-to-world mapping.
        selectors:
            Active axis selectors.
        """
        u_role, v_role, orth_role = self._plane_role_triplet("xy")
        u_axis_name = self._axis_name_for_role(
            dataset_summary=dataset_summary,
            role=u_role,
            plane="xy",
        )
        v_axis_name = self._axis_name_for_role(
            dataset_summary=dataset_summary,
            role=v_role,
            plane="xy",
        )
        slice_axis = self._axis_name_for_role(
            dataset_summary=dataset_summary,
            role=orth_role,
            plane="xy",
        )
        axis_sizes = {axis.name: axis.size for axis in dataset_summary.axes}
        slice_index = self._selector_index_for_axis(selectors=selectors, axis_name=slice_axis)

        return View2D(
            plane="xy",
            slice=SliceSettings(
                axis=slice_axis,
                index=slice_index,
                slab=SlabSettings(thickness_vox=1, mode="single"),
            ),
            camera=Camera2D(
                center_world=(
                    float(axis_sizes[u_axis_name]) / 2.0,
                    float(axis_sizes[v_axis_name]) / 2.0,
                ),
                zoom=1.0,
                rotation_deg=0.0,
            ),
        )

    def _default_image_layer(
        self, dataset_summary: DatasetSummary, multiscale_name: str
    ) -> LayerState:
        """Construct a default image layer for a new view.

        Parameters
        ----------
        dataset_summary:
            Source dataset summary.
        multiscale_name:
            Name of the multiscale to bind.
        """
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
        """Build default per-channel settings from metadata or axis cardinality.

        Parameters
        ----------
        dataset_summary:
            Source dataset summary with optional channel metadata.
        """
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
        """Normalize slice axis/index and clamp values when needed.

        Parameters
        ----------
        view_2d:
            Optional 2D view config.
        dataset_summary:
            Metadata used for bounds and axis validation.
        selectors:
            Current selectors used for default slice resolution.
        """
        warnings: list[ApiWarning] = []
        resolved_view = view_2d or self._default_view_2d(
            dataset_summary=dataset_summary,
            selectors=selectors,
        )

        _, _, orth_role = self._plane_role_triplet(resolved_view.plane)
        slice_axis = self._axis_name_for_role(
            dataset_summary=dataset_summary,
            role=orth_role,
            plane=resolved_view.plane,
        )
        requested_slice_axis = (
            resolved_view.slice.axis if resolved_view.slice and resolved_view.slice.axis else None
        )
        if requested_slice_axis is not None and requested_slice_axis != slice_axis:
            warnings.append(
                ApiWarning(
                    code="slice_axis_forced_to_plane",
                    message="Slice axis was replaced to match plane orthogonal axis.",
                    details={
                        "plane": resolved_view.plane,
                        "requested_axis": requested_slice_axis,
                        "applied_axis": slice_axis,
                    },
                )
            )

        axis_sizes = {axis.name: axis.size for axis in dataset_summary.axes}
        slice_index = (
            resolved_view.slice.index
            if resolved_view.slice is not None and resolved_view.slice.index is not None
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
        slab = resolved_view.slice.slab if resolved_view.slice and resolved_view.slice.slab else SlabSettings()

        normalized_view = resolved_view.model_copy(
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

    def _plane_role_triplet(self, plane: str) -> tuple[str, str, str]:
        mapping: dict[str, tuple[str, str, str]] = {
            "xy": ("x", "y", "z"),
            "xz": ("x", "z", "y"),
            "yz": ("y", "z", "x"),
        }
        roles = mapping.get(plane)
        if roles is None:
            raise LucidaError(
                code="unsupported_plane",
                message="Requested 2D plane is unsupported.",
                details={"plane": plane},
                status_code=422,
            )
        return roles

    def _axis_name_for_role(
        self,
        *,
        dataset_summary: DatasetSummary,
        role: str,
        plane: str,
    ) -> str:
        axis = next((item for item in dataset_summary.axes if item.role == role), None)
        if axis is None:
            missing_roles = [r for r in self._plane_role_triplet(plane) if not any(a.role == r for a in dataset_summary.axes)]
            raise LucidaError(
                code="unsupported_plane",
                message="Requested plane is unsupported for dataset axes.",
                details={
                    "plane": plane,
                    "missing_roles": missing_roles,
                    "dataset_id": dataset_summary.dataset_id,
                },
                status_code=422,
            )
        return axis.name

    def _select_slice_axis(
        self, dataset_summary: DatasetSummary, selectors: list[AxisSelector]
    ) -> str:
        """Choose a slice axis, preferring explicit Z axis selectors.

        Parameters
        ----------
        dataset_summary:
            Dataset metadata to inspect axis roles.
        selectors:
            Active selectors for axis selection.
        """
        axis_by_name = {axis.name: axis for axis in dataset_summary.axes}
        for selector in selectors:
            axis = axis_by_name.get(selector.axis)
            if axis is not None and axis.role == "z":
                return selector.axis
        return selectors[0].axis

    def _selector_index_for_axis(self, *, selectors: list[AxisSelector], axis_name: str) -> int:
        """Return a usable integer index for an axis selector.

        Parameters
        ----------
        selectors:
            Axis selector list.
        axis_name:
            Axis to query.
        """
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
        """Normalize selectors and emit warnings for clamped values.

        Parameters
        ----------
        selectors:
            Raw selectors requested by caller or patch.
        dataset_summary:
            Dataset context for bounds validation.
        operation:
            Operation name for error context.
        """
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
        """Clamp or validate a single-axis index selector.

        Parameters
        ----------
        selector:
            Candidate selector.
        axis_size:
            Size of the axis being constrained.
        """
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
        """Clamp/validate a range selector and guarantee non-empty ranges.

        Parameters
        ----------
        selector:
            Candidate selector.
        axis_size:
            Size of the axis being constrained.
        """
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
        """Normalize set selectors by de-duplicating and clamping values.

        Parameters
        ----------
        selector:
            Candidate selector.
        axis_size:
            Size of the axis being constrained.
        """
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
        """Generate a stable view identifier."""
        return f"view_{uuid.uuid4().hex[:16]}"

    def _with_state_hash(self, *, view_state: ViewState, state_version: int) -> ViewState:
        """Attach state hash and version to a normalized view payload.

        Parameters
        ----------
        view_state:
            Raw view state.
        state_version:
            Monotonic state version to persist.
        """
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
        """Compute a deterministic hash from the canonicalized view state.

        Parameters
        ----------
        view_state:
            Normalized view state to hash.
        """
        payload = view_state.model_dump(mode="python")
        payload.pop("state_hash", None)
        payload.pop("state_version", None)
        canonical = self._canonicalize_for_hash(payload)
        serialized = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    def _canonicalize_for_hash(self, value: Any) -> Any:
        """Canonicalize values for deterministic hashing.

        Parameters
        ----------
        value:
            Arbitrary value in the view state tree.
        """
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
