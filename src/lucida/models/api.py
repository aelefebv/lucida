from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .dataset_summary import DatasetSummary
from .view_state import AxisSelector, View2D, ViewState, Viewport


class ModelBase(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ApiWarning(ModelBase):
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    details: dict[str, Any] | None = None


class ApiError(ModelBase):
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    details: dict[str, Any] | None = None


class DatasetOpenRequest(ModelBase):
    schema_version: Literal[1] = 1
    uri: str = Field(min_length=1)
    dataset_id: str | None = Field(default=None, min_length=1)
    session_id: str | None = Field(default=None, min_length=1)
    include_full_raw_metadata: bool = False


class DatasetOpenResponse(ModelBase):
    schema_version: Literal[1] = 1
    dataset_summary: DatasetSummary
    warnings: list[ApiWarning] = Field(default_factory=list)


class SessionCreateRequest(ModelBase):
    schema_version: Literal[1] = 1


class SessionCreateResponse(ModelBase):
    schema_version: Literal[1] = 1
    session_id: str = Field(min_length=1)
    created_at: datetime


class ViewCreateRequest(ModelBase):
    schema_version: Literal[1] = 1
    session_id: str | None = Field(default=None, min_length=1)
    dataset_id: str = Field(min_length=1)
    mode: Literal["2d", "3d"] = "2d"
    multiscale_name: str | None = Field(default=None, min_length=1)
    viewport: Viewport | None = None
    selectors: list[AxisSelector] | None = None
    view_2d: View2D | None = None


class ViewCreateResponse(ModelBase):
    schema_version: Literal[1] = 1
    view_state: ViewState
    warnings: list[ApiWarning] = Field(default_factory=list)
    selectors_applied: list[AxisSelector] = Field(default_factory=list)


class ViewGetResponse(ModelBase):
    schema_version: Literal[1] = 1
    view_state: ViewState


class ViewUpdateRequest(ModelBase):
    schema_version: Literal[1] = 1
    session_id: str | None = Field(default=None, min_length=1)
    view_id: str = Field(min_length=1)
    patch: list[dict[str, Any]] = Field(min_length=1)


class ViewUpdateResponse(ModelBase):
    schema_version: Literal[1] = 1
    view_state: ViewState
    warnings: list[ApiWarning] = Field(default_factory=list)
    selectors_applied: list[AxisSelector] = Field(default_factory=list)
