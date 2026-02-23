from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .dataset_summary import DatasetSummary


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
    include_full_raw_metadata: bool = False


class DatasetOpenResponse(ModelBase):
    schema_version: Literal[1] = 1
    dataset_summary: DatasetSummary
    warnings: list[ApiWarning] = Field(default_factory=list)
