"""Generated protocol models. Do not edit by hand."""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

SCHEMA_DIGEST = "f8d2485c97d0c8a401ca1a30edfee6c4ba1a2bd8304a389f3052adffe0b630ed"

class AsyncAccepted(TypedDict):
    accepted_at: Timestamp
    job_id: UUIDv7
    state: Literal['queued']

class AxisIndex(TypedDict):
    axis: AxisLabel
    index: int

class CameraGetRequest(TypedDict):
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class CameraGetResponse(TypedDict):
    mode: CameraMode
    pose: CameraPose
    session_id: UUIDv7

class CameraPose(TypedDict):
    fov_degrees: NotRequired[float]
    position: list[float]
    target: list[float]
    up: list[float]

class CameraSetModeRequest(TypedDict):
    idempotency_key: str
    mode: CameraMode
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class CameraSetModeResponse(TypedDict):
    mode: CameraMode
    session_id: UUIDv7

class CameraSetPoseRequest(TypedDict):
    idempotency_key: str
    pose: CameraPose
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class CameraSetPoseResponse(TypedDict):
    pose: CameraPose
    session_id: UUIDv7

class CapabilityFlags(TypedDict):
    async_jobs: bool
    command_log_replay: bool
    dataref_oob: bool
    dedicated_event_stream: bool
    idempotency_keys: bool
    total_ordered_events: bool

class CommandLogExportRequest(TypedDict):
    destination_uri: str
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class CommandLogExportResponse(TypedDict):
    destination_uri: str
    record_count: int
    session_id: UUIDv7

class CommandLogImportRequest(TypedDict):
    idempotency_key: str
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7
    source_uri: str

class CommandLogImportResponse(TypedDict):
    import_id: UUIDv7
    job: AsyncAccepted
    session_id: UUIDv7

class CommandLogReplayEvent(TypedDict):
    emitted_at: Timestamp
    event_id: UUIDv7
    event_type: Literal['command_log.replay']
    payload: CommandLogReplayPayload
    protocol_version: SemVer
    session_id: UUIDv7
    session_seq: SessionSeq

class CommandLogReplayPayload(TypedDict):
    applied_commands: int
    replay_id: UUIDv7
    state: Literal['started', 'progress', 'completed', 'failed']
    total_commands: int

class CommandLogReplayRequest(TypedDict):
    dry_run: bool
    idempotency_key: str
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7
    source_uri: str

class CommandLogReplayResponse(TypedDict):
    job: AsyncAccepted
    replay_id: UUIDv7
    session_id: UUIDv7

class CommandRecord(TypedDict):
    correlation_id: UUIDv7
    kind: Literal['command']
    method: str
    recorded_at: Timestamp
    request: dict[str, Any]
    seq: int

class DataRefSharedMemory(TypedDict):
    checksum_sha256: str
    compression: Compression
    dtype: str
    endianness: Endianness
    kind: Literal['shared_memory']
    shape: list[int]
    shm_name: str
    strides: NotRequired[list[int]]
    ttl_ms: int

class DataRefTempFile(TypedDict):
    checksum_sha256: str
    compression: Compression
    dtype: str
    endianness: Endianness
    file_path: str
    kind: Literal['temp_file']
    shape: list[int]
    strides: NotRequired[list[int]]
    ttl_ms: int

class DataRefUri(TypedDict):
    checksum_sha256: str
    compression: Compression
    dtype: str
    endianness: Endianness
    kind: Literal['uri']
    shape: list[int]
    strides: NotRequired[list[int]]
    ttl_ms: int
    uri: str

class DatasetCloseRequest(TypedDict):
    dataset_id: UUIDv7
    idempotency_key: str
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class DatasetCloseResponse(TypedDict):
    closed_at: Timestamp
    dataset_id: UUIDv7

class DatasetGetRequest(TypedDict):
    dataset_id: UUIDv7
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class DatasetGetResponse(TypedDict):
    axis_labels: list[AxisLabel]
    dataset_id: UUIDv7
    dtype: str
    session_id: UUIDv7
    shape: list[int]
    transform: Transform
    uri: str

class DatasetOpenRequest(TypedDict):
    axis_map: NotRequired[dict[str, Any]]
    idempotency_key: str
    protocol_version: SemVer
    read_only: bool
    request_id: UUIDv7
    session_id: UUIDv7
    uri: str

class DatasetOpenResponse(TypedDict):
    job: AsyncAccepted
    session_id: UUIDv7

class DatasetOpenedEvent(TypedDict):
    emitted_at: Timestamp
    event_id: UUIDv7
    event_type: Literal['dataset.opened']
    payload: DatasetOpenedPayload
    protocol_version: SemVer
    session_id: UUIDv7
    session_seq: SessionSeq

class DatasetOpenedPayload(TypedDict):
    dataset_id: UUIDv7
    uri: str

class ErrorEnvelope(TypedDict):
    code: ErrorCode
    details: dict[str, Any]
    message: str
    retry_after_ms: NotRequired[int]
    retryable: bool

class ErrorEvent(TypedDict):
    emitted_at: Timestamp
    event_id: UUIDv7
    event_type: Literal['error']
    payload: ErrorPayload
    protocol_version: SemVer
    session_id: UUIDv7
    session_seq: SessionSeq

class ErrorPayload(TypedDict):
    error: ErrorEnvelope

class EventEnvelope(TypedDict):
    emitted_at: Timestamp
    event_id: UUIDv7
    event_type: str
    protocol_version: SemVer
    session_id: UUIDv7
    session_seq: SessionSeq

class EventRecord(TypedDict):
    correlation_id: UUIDv7
    event: AnyEvent
    kind: Literal['event']
    recorded_at: Timestamp
    seq: int

class EventsSubscribeRequest(TypedDict):
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7
    topics: list[str]

class EventsSubscribeResponse(TypedDict):
    session_id: UUIDv7
    subscription_id: UUIDv7
    topics: list[str]
    transport_uri: str

class JobCancelRequest(TypedDict):
    idempotency_key: str
    job_id: UUIDv7
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class JobCancelResponse(TypedDict):
    job_id: UUIDv7
    session_id: UUIDv7
    state: Literal['cancelled']

class JobGetRequest(TypedDict):
    job_id: UUIDv7
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class JobGetResponse(TypedDict):
    completed_at: NotRequired[Timestamp]
    error: NotRequired[ErrorEnvelope]
    job_id: UUIDv7
    session_id: UUIDv7
    started_at: NotRequired[Timestamp]
    state: JobState
    submitted_at: Timestamp

class JobLifecycleEvent(TypedDict):
    emitted_at: Timestamp
    event_id: UUIDv7
    event_type: Literal['job.lifecycle']
    payload: JobLifecyclePayload
    protocol_version: SemVer
    session_id: UUIDv7
    session_seq: SessionSeq

class JobLifecyclePayload(TypedDict):
    error: NotRequired[ErrorEnvelope]
    job_id: UUIDv7
    reason: NotRequired[str]
    state: JobState

class JobListRequest(TypedDict):
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7
    state: NotRequired[JobState]

class JobListResponse(TypedDict):
    jobs: list[dict[str, Any]]
    session_id: UUIDv7

class JobProgressEvent(TypedDict):
    emitted_at: Timestamp
    event_id: UUIDv7
    event_type: Literal['job.progress']
    payload: JobProgressPayload
    protocol_version: SemVer
    session_id: UUIDv7
    session_seq: SessionSeq

class JobProgressPayload(TypedDict):
    job_id: UUIDv7
    message: NotRequired[str]
    progress: float

class LayerAddImageRequest(TypedDict):
    channel: NotRequired[int]
    dataset_id: UUIDv7
    idempotency_key: str
    name: NotRequired[str]
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7
    transform: NotRequired[Transform]

class LayerAddImageResponse(TypedDict):
    job: AsyncAccepted
    layer_id: UUIDv7
    session_id: UUIDv7

class LayerAddPointsRequest(TypedDict):
    attributes: NotRequired[dict[str, Any]]
    data_ref: DataRef
    idempotency_key: str
    name: NotRequired[str]
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class LayerAddPointsResponse(TypedDict):
    job: AsyncAccepted
    layer_id: UUIDv7
    session_id: UUIDv7

class LayerGetRequest(TypedDict):
    layer_id: UUIDv7
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class LayerGetResponse(TypedDict):
    layer_id: UUIDv7
    layer_type: Literal['image', 'points']
    name: NotRequired[str]
    opacity: float
    visible: bool

class LayerRemoveRequest(TypedDict):
    idempotency_key: str
    layer_id: UUIDv7
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class LayerRemoveResponse(TypedDict):
    layer_id: UUIDv7
    removed_at: Timestamp

class LayerUpdateRequest(TypedDict):
    idempotency_key: str
    layer_id: UUIDv7
    patch: dict[str, Any]
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class LayerUpdateResponse(TypedDict):
    layer_id: UUIDv7
    updated_at: Timestamp

class RequestMeta(TypedDict):
    idempotency_key: NotRequired[str]
    protocol_version: SemVer
    request_id: UUIDv7

class SelectionChangedEvent(TypedDict):
    emitted_at: Timestamp
    event_id: UUIDv7
    event_type: Literal['selection.changed']
    payload: SelectionChangedPayload
    protocol_version: SemVer
    session_id: UUIDv7
    session_seq: SessionSeq

class SelectionChangedPayload(TypedDict):
    layer_id: NotRequired[UUIDv7]
    selection: dict[str, Any]

class SelectionGetRequest(TypedDict):
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class SelectionGetResponse(TypedDict):
    selection: dict[str, Any]
    session_id: UUIDv7

class SelectionSetRequest(TypedDict):
    idempotency_key: str
    layer_id: NotRequired[UUIDv7]
    protocol_version: SemVer
    request_id: UUIDv7
    selection: dict[str, Any]
    session_id: UUIDv7

class SelectionSetResponse(TypedDict):
    selection: dict[str, Any]
    session_id: UUIDv7

class SessionCloseRequest(TypedDict):
    idempotency_key: str
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class SessionCloseResponse(TypedDict):
    closed_at: Timestamp
    session_id: UUIDv7

class SessionCreateRequest(TypedDict):
    idempotency_key: str
    label: NotRequired[str]
    preferred_view: NotRequired[Literal['2d', '3d', 'auto']]
    protocol_version: SemVer
    request_id: UUIDv7

class SessionCreateResponse(TypedDict):
    created_at: Timestamp
    label: NotRequired[str]
    session_id: UUIDv7

class SessionGetRequest(TypedDict):
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class SessionGetResponse(TypedDict):
    created_at: Timestamp
    label: NotRequired[str]
    session_id: UUIDv7
    state: Literal['active', 'closing', 'closed']

class StateChangedEvent(TypedDict):
    emitted_at: Timestamp
    event_id: UUIDv7
    event_type: Literal['state.changed']
    payload: StateChangedPayload
    protocol_version: SemVer
    session_id: UUIDv7
    session_seq: SessionSeq

class StateChangedPayload(TypedDict):
    change_summary: str
    object_id: UUIDv7
    object_type: Literal['session', 'dataset', 'layer', 'view', 'camera', 'selection']

class SystemCapabilitiesGetRequest(TypedDict):
    protocol_version: SemVer
    request_id: UUIDv7

class SystemCapabilitiesGetResponse(TypedDict):
    capabilities: CapabilityFlags
    inline_payload_limit_bytes: InlinePayloadLimitBytes
    selected_version: SemVer

class SystemHelloRequest(TypedDict):
    client_name: str
    client_version: SemVer
    protocol_version: SemVer
    request_id: UUIDv7
    supported_versions: VersionRange
    transport: Literal['ipc', 'tcp', 'ws']

class SystemHelloResponse(TypedDict):
    capabilities: CapabilityFlags
    daemon_name: str
    daemon_version: SemVer
    event_stream: Literal['unix_socket', 'named_pipe', 'tcp', 'ws']
    selected_version: SemVer
    server_time: Timestamp

class Transform(TypedDict):
    scale: list[float]
    translate: list[float]

class VersionRange(TypedDict):
    max_version: SemVer
    min_version: SemVer

class ViewReorderAxesRequest(TypedDict):
    idempotency_key: str
    order: list[AxisLabel]
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class ViewReorderAxesResponse(TypedDict):
    order: list[AxisLabel]
    session_id: UUIDv7

class ViewSetAxisIndexRequest(TypedDict):
    axis_index: AxisIndex
    idempotency_key: str
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class ViewSetAxisIndexResponse(TypedDict):
    axis_index: AxisIndex
    session_id: UUIDv7
    updated_at: Timestamp

class ViewSetChannelOrderRequest(TypedDict):
    channel_order: list[int]
    idempotency_key: str
    protocol_version: SemVer
    request_id: UUIDv7
    session_id: UUIDv7

class ViewSetChannelOrderResponse(TypedDict):
    channel_order: list[int]
    session_id: UUIDv7

AnyEvent = CommandLogReplayEvent | DatasetOpenedEvent | ErrorEvent | JobLifecycleEvent | JobProgressEvent | SelectionChangedEvent | StateChangedEvent

AxisLabel = str

CameraMode = Literal['panzoom', 'arcball', 'freefly']

Compression = Literal['none', 'gzip', 'zstd', 'blosc']

DataRef = DataRefSharedMemory | DataRefTempFile | DataRefUri

Endianness = Literal['little', 'big']

ErrorCode = Literal['LUCIDA_INVALID_PARAMS', 'LUCIDA_NOT_FOUND', 'LUCIDA_CONFLICT', 'LUCIDA_VERSION_MISMATCH', 'LUCIDA_UNSUPPORTED_CAPABILITY', 'LUCIDA_BUSY', 'LUCIDA_TIMEOUT', 'LUCIDA_INTERNAL', 'LUCIDA_IO_FAILURE', 'LUCIDA_AUTH_REQUIRED', 'LUCIDA_AUTH_DENIED']

InlinePayloadLimitBytes = Literal[65536]

JobState = Literal['queued', 'running', 'completed', 'failed', 'cancelled']

LogRecord = CommandRecord | EventRecord

MutatingRequestMeta = RequestMeta | dict[str, Any]

SemVer = str

SessionSeq = int

Timestamp = str

UUIDv7 = str
