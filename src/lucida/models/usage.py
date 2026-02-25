"""Pydantic models for usage telemetry endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ModelBase(BaseModel):
    """Shared base model with strict schema behavior."""

    model_config = ConfigDict(extra="forbid")


class UsageEvent(ModelBase):
    """One persisted telemetry event row."""

    id: int = Field(ge=1)
    occurred_at_utc: datetime
    endpoint: str = Field(min_length=1)
    method: str = Field(min_length=1)
    status_code: int = Field(ge=100, le=599)
    latency_ms: float = Field(ge=0)
    agent_run_id: str | None = None
    agent_step_id: str | None = None
    agent_name: str | None = None
    session_id: str | None = None
    dataset_id: str | None = None
    view_id: str | None = None
    render_id: str | None = None
    request_id: str | None = None
    state_hash: str | None = None
    state_version: int | None = Field(default=None, ge=0)
    request_json: Any | None = None
    response_json: Any | None = None
    error_code: str | None = None
    error_message: str | None = None


class UsageEventsResponse(ModelBase):
    """Response payload for listing telemetry events."""

    schema_version: Literal[1] = 1
    events: list[UsageEvent] = Field(default_factory=list)


class UsageRunSummary(ModelBase):
    """Aggregate metrics for one agent run."""

    agent_run_id: str = Field(min_length=1)
    started_at_utc: datetime
    last_activity_at_utc: datetime
    event_count: int = Field(ge=0)
    error_count: int = Field(ge=0)
    render_count: int = Field(ge=0)
    p50_latency_ms: float | None = Field(default=None, ge=0)
    p95_latency_ms: float | None = Field(default=None, ge=0)


class UsageRunsResponse(ModelBase):
    """Response payload for listing run aggregates."""

    schema_version: Literal[1] = 1
    runs: list[UsageRunSummary] = Field(default_factory=list)


class UsageRunDetailResponse(ModelBase):
    """Response payload for one run summary with recent events."""

    schema_version: Literal[1] = 1
    run: UsageRunSummary
    events: list[UsageEvent] = Field(default_factory=list)
