"""Pydantic API contracts used by endpoints and clients."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .dataset_summary import DatasetSummary
from .view_state import AxisSelector, View2D, ViewState, Viewport


class ModelBase(BaseModel):
    """Shared base model with strict schema behavior.

    Attributes
    ----------
    model_config:
        Pydantic v2 model configuration that forbids extra fields.
    """
    model_config = ConfigDict(extra="forbid")


class ApiWarning(ModelBase):
    """Structured warning payload returned by operations.

    Attributes
    ----------
    code:
        Machine-readable warning code.
    message:
        Human-readable warning message.
    details:
        Optional warning-specific metadata.
    """
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    details: dict[str, Any] | None = None


class ApiError(ModelBase):
    """Standard API error envelope.

    Attributes
    ----------
    code:
        Machine-readable error code.
    message:
        Human-readable error text.
    details:
        Optional provider details.
    """
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    details: dict[str, Any] | None = None


class DatasetOpenRequest(ModelBase):
    """Request body for opening an OME-Zarr dataset.

    Attributes
    ----------
    schema_version:
        API schema version.
    uri:
        Dataset URI to open.
    dataset_id:
        Optional dataset identifier override.
    session_id:
        Optional session id to attach the opened dataset.
    include_full_raw_metadata:
        If true, include full raw metadata payload.
    """
    schema_version: Literal[1] = 1
    uri: str = Field(min_length=1)
    dataset_id: str | None = Field(default=None, min_length=1)
    session_id: str | None = Field(default=None, min_length=1)
    include_full_raw_metadata: bool = False


class DatasetOpenResponse(ModelBase):
    """Response payload for a successful dataset-open request.

    Attributes
    ----------
    schema_version:
        API schema version.
    dataset_summary:
        Parsed dataset metadata.
    warnings:
        Metadata extraction warnings.
    """
    schema_version: Literal[1] = 1
    dataset_summary: DatasetSummary
    warnings: list[ApiWarning] = Field(default_factory=list)


class SessionCreateRequest(ModelBase):
    """Request body for creating a new session.

    Attributes
    ----------
    schema_version:
        API schema version.
    """
    schema_version: Literal[1] = 1


class SessionCreateResponse(ModelBase):
    """Response body containing a newly created session id.

    Attributes
    ----------
    schema_version:
        API schema version.
    session_id:
        New session identifier.
    created_at:
        Creation timestamp.
    """
    schema_version: Literal[1] = 1
    session_id: str = Field(min_length=1)
    created_at: datetime


class ViewCreateRequest(ModelBase):
    """Request body for creating a view from a dataset.

    Attributes
    ----------
    schema_version:
        API schema version.
    session_id:
        Optional session identifier.
    dataset_id:
        Target dataset identifier.
    mode:
        Render mode.
    multiscale_name:
        Optional multiscale selection.
    viewport:
        Optional viewport override.
    selectors:
        Initial selector list.
    view_2d:
        Optional 2D configuration payload.
    """
    schema_version: Literal[1] = 1
    session_id: str | None = Field(default=None, min_length=1)
    dataset_id: str = Field(min_length=1)
    mode: Literal["2d", "3d"] = "2d"
    multiscale_name: str | None = Field(default=None, min_length=1)
    viewport: Viewport | None = None
    selectors: list[AxisSelector] | None = None
    view_2d: View2D | None = None


class ViewCreateResponse(ModelBase):
    """Response body returned after successfully creating a view.

    Attributes
    ----------
    schema_version:
        API schema version.
    view_state:
        Initialized view state.
    warnings:
        Warnings raised during creation.
    selectors_applied:
        Final normalized selectors.
    """
    schema_version: Literal[1] = 1
    view_state: ViewState
    warnings: list[ApiWarning] = Field(default_factory=list)
    selectors_applied: list[AxisSelector] = Field(default_factory=list)


class ViewGetResponse(ModelBase):
    """Response body for fetching an existing view.

    Attributes
    ----------
    schema_version:
        API schema version.
    view_state:
        Stored view state.
    """
    schema_version: Literal[1] = 1
    view_state: ViewState


class ViewUpdateRequest(ModelBase):
    """Request body for applying a JSON patch to view state.

    Attributes
    ----------
    schema_version:
        API schema version.
    session_id:
        Optional session identifier.
    view_id:
        Target view identifier.
    patch:
        JSON patch operations.
    """
    schema_version: Literal[1] = 1
    session_id: str | None = Field(default=None, min_length=1)
    view_id: str = Field(min_length=1)
    patch: list[dict[str, Any]] = Field(min_length=1)


class ViewUpdateResponse(ModelBase):
    """Response body for a successful view update.

    Attributes
    ----------
    schema_version:
        API schema version.
    view_state:
        Updated view state.
    warnings:
        Warnings raised during update.
    selectors_applied:
        Final normalized selectors.
    """
    schema_version: Literal[1] = 1
    view_state: ViewState
    warnings: list[ApiWarning] = Field(default_factory=list)
    selectors_applied: list[AxisSelector] = Field(default_factory=list)
