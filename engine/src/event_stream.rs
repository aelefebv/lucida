use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::model::{
    AuditEventKind, AxisName, ClientRosterEntry, ClientViewMode, DatasetBinding, DatasetKind,
    GenerationRecord, GenerationRefMode, GenerationStage, LayerState, LeaseChangeKind, LeaseState,
    PerClientViewState, PermissionClass, SessionSnapshotEnvelope, SourceKind, SourceRecord,
    SourceStatus, WarningCode, WarningEntry, WarningSeverity,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    SessionClientJoined,
    LeaseChanged,
    WarningsUpdated,
    ViewUpdated,
    SceneSourceUpsert,
    SceneDatasetUpsert,
    SceneLayerUpsert,
    SourceGenerationDetected,
    SourceGenerationStarted,
    SourceGenerationProgress,
    SourceGenerationReady,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseChangedKindPayload {
    Requested,
    Stolen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEventKindPayload {
    LeaseRequested,
    LeaseStolen,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientJoinedPayload {
    pub client_id: String,
    pub label: String,
    pub permission_class: String,
    pub connected_at: String,
    pub last_seen_at: String,
    pub is_lease_holder: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewUpdatedPayload {
    pub client_id: String,
    pub view_rev: u64,
    pub view_mode: String,
    pub active_layer_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseStatePayload {
    pub lease_holder_client_id: Option<String>,
    pub lease_holder_label: Option<String>,
    pub acquired_at: Option<String>,
    pub stealable: bool,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseChangedPayload {
    pub lease_state: LeaseStatePayload,
    pub change_kind: LeaseChangedKindPayload,
    pub changed_by_client_id: String,
    pub changed_by_label: String,
    pub previous_lease_holder_client_id: Option<String>,
    pub previous_lease_holder_label: Option<String>,
    pub audit_event_kind: AuditEventKindPayload,
    pub audit_recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WarningPayloadEntry {
    pub warning_code: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WarningsUpdatedPayload {
    pub client_id: String,
    pub warnings: Vec<WarningPayloadEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceUpsertPayload {
    pub source_id: String,
    pub name: String,
    pub uri: String,
    pub source_kind: String,
    pub status: String,
    pub latest_working_generation_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetUpsertPayload {
    pub dataset_id: String,
    pub name: String,
    pub dataset_kind: String,
    pub generation_ref_mode: String,
    pub source_id: Option<String>,
    pub resolved_generation_seq: u64,
    pub canonical_axes: Vec<String>,
    pub dtype: String,
    pub channel_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayerUpsertPayload {
    pub layer_id: String,
    pub name: String,
    pub layer_rev: u64,
    pub metadata_rev: u64,
    pub write_rev: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceGenerationPayload {
    pub generation_id: String,
    pub source_id: String,
    pub generation_seq: u64,
    pub stage: String,
    pub progress_percent: u8,
    pub preview_ready: bool,
    pub tile2d_ready_lods: Vec<u8>,
    pub brick3d_ready_lods: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "payload_type", content = "payload", rename_all = "snake_case")]
pub enum EventPayload {
    SessionClientJoined(ClientJoinedPayload),
    LeaseChanged(LeaseChangedPayload),
    WarningsUpdated(WarningsUpdatedPayload),
    ViewUpdated(ViewUpdatedPayload),
    SceneSourceUpsert(SourceUpsertPayload),
    SceneDatasetUpsert(DatasetUpsertPayload),
    SceneLayerUpsert(LayerUpsertPayload),
    SourceGenerationDetected(SourceGenerationPayload),
    SourceGenerationStarted(SourceGenerationPayload),
    SourceGenerationProgress(SourceGenerationPayload),
    SourceGenerationReady(SourceGenerationPayload),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub message_type: String,
    pub schema_version: String,
    pub session_id: String,
    pub session_rev: u64,
    pub event_type: EventType,
    pub payload: EventPayload,
    pub emitted_at: String,
}

impl EventEnvelope {
    #[must_use]
    pub fn session_client_joined(
        session_id: String,
        session_rev: u64,
        payload: ClientJoinedPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::SessionClientJoined,
            payload: EventPayload::SessionClientJoined(payload),
            emitted_at,
        }
    }

    #[must_use]
    pub fn view_updated(
        session_id: String,
        session_rev: u64,
        payload: ViewUpdatedPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::ViewUpdated,
            payload: EventPayload::ViewUpdated(payload),
            emitted_at,
        }
    }

    #[must_use]
    pub fn lease_changed(
        session_id: String,
        session_rev: u64,
        payload: LeaseChangedPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::LeaseChanged,
            payload: EventPayload::LeaseChanged(payload),
            emitted_at,
        }
    }

    #[must_use]
    pub fn warnings_updated(
        session_id: String,
        session_rev: u64,
        payload: WarningsUpdatedPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::WarningsUpdated,
            payload: EventPayload::WarningsUpdated(payload),
            emitted_at,
        }
    }

    #[must_use]
    pub fn scene_source_upsert(
        session_id: String,
        session_rev: u64,
        payload: SourceUpsertPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::SceneSourceUpsert,
            payload: EventPayload::SceneSourceUpsert(payload),
            emitted_at,
        }
    }

    #[must_use]
    pub fn scene_dataset_upsert(
        session_id: String,
        session_rev: u64,
        payload: DatasetUpsertPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::SceneDatasetUpsert,
            payload: EventPayload::SceneDatasetUpsert(payload),
            emitted_at,
        }
    }

    #[must_use]
    pub fn scene_layer_upsert(
        session_id: String,
        session_rev: u64,
        payload: LayerUpsertPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::SceneLayerUpsert,
            payload: EventPayload::SceneLayerUpsert(payload),
            emitted_at,
        }
    }

    #[must_use]
    pub fn source_generation_detected(
        session_id: String,
        session_rev: u64,
        payload: SourceGenerationPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::SourceGenerationDetected,
            payload: EventPayload::SourceGenerationDetected(payload),
            emitted_at,
        }
    }

    #[must_use]
    pub fn source_generation_started(
        session_id: String,
        session_rev: u64,
        payload: SourceGenerationPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::SourceGenerationStarted,
            payload: EventPayload::SourceGenerationStarted(payload),
            emitted_at,
        }
    }

    #[must_use]
    pub fn source_generation_progress(
        session_id: String,
        session_rev: u64,
        payload: SourceGenerationPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::SourceGenerationProgress,
            payload: EventPayload::SourceGenerationProgress(payload),
            emitted_at,
        }
    }

    #[must_use]
    pub fn source_generation_ready(
        session_id: String,
        session_rev: u64,
        payload: SourceGenerationPayload,
        emitted_at: String,
    ) -> Self {
        Self {
            message_type: "event".to_owned(),
            schema_version: crate::SCHEMA_VERSION.to_owned(),
            session_id,
            session_rev,
            event_type: EventType::SourceGenerationReady,
            payload: EventPayload::SourceGenerationReady(payload),
            emitted_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventStreamError {
    NonMonotonicSessionRevision {
        last_session_rev: u64,
        next_session_rev: u64,
    },
    SessionMismatch {
        expected_session_id: String,
        actual_session_id: String,
    },
}

#[derive(Debug, Default)]
pub struct EventBus {
    events: Vec<EventEnvelope>,
}

impl EventBus {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn publish(&mut self, event: EventEnvelope) -> Result<(), EventStreamError> {
        if let Some(last) = self.events.last()
            && event.session_rev <= last.session_rev
        {
            return Err(EventStreamError::NonMonotonicSessionRevision {
                last_session_rev: last.session_rev,
                next_session_rev: event.session_rev,
            });
        }

        self.events.push(event);
        Ok(())
    }

    #[must_use]
    pub fn events(&self) -> &[EventEnvelope] {
        &self.events
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionState {
    pub session_id: String,
    pub session_rev: u64,
    pub lease_state: LeaseStatePayload,
    pub client_warnings: BTreeMap<String, Vec<WarningPayloadEntry>>,
    pub client_roster: BTreeMap<String, ClientJoinedPayload>,
    pub client_views: BTreeMap<String, ViewUpdatedPayload>,
    pub sources: BTreeMap<String, SourceUpsertPayload>,
    pub datasets: BTreeMap<String, DatasetUpsertPayload>,
    pub layers: BTreeMap<String, LayerUpsertPayload>,
    pub source_generations: BTreeMap<String, SourceGenerationPayload>,
}

impl ProjectionState {
    #[must_use]
    pub fn from_snapshot(snapshot: &SessionSnapshotEnvelope) -> Self {
        let client_roster = snapshot
            .snapshot
            .client_roster
            .iter()
            .map(|entry| {
                let payload = ClientJoinedPayload::from(entry);
                (payload.client_id.clone(), payload)
            })
            .collect::<BTreeMap<_, _>>();

        let client_view_payload = ViewUpdatedPayload::from(&snapshot.snapshot.client_view);
        let client_views =
            BTreeMap::from([(client_view_payload.client_id.clone(), client_view_payload)]);

        let sources = snapshot
            .snapshot
            .shared_scene
            .sources
            .values()
            .map(|source| {
                let payload = SourceUpsertPayload::from(source);
                (payload.source_id.clone(), payload)
            })
            .collect::<BTreeMap<_, _>>();

        let layers = snapshot
            .snapshot
            .shared_scene
            .layers
            .values()
            .map(|layer| {
                let payload = LayerUpsertPayload::from(layer);
                (payload.layer_id.clone(), payload)
            })
            .collect::<BTreeMap<_, _>>();
        let datasets = snapshot
            .snapshot
            .shared_scene
            .datasets
            .values()
            .map(|dataset| {
                let payload = DatasetUpsertPayload::from(dataset);
                (payload.dataset_id.clone(), payload)
            })
            .collect::<BTreeMap<_, _>>();
        let source_generations = snapshot
            .snapshot
            .shared_scene
            .sources
            .values()
            .flat_map(|source| source.generations.values())
            .map(|generation| {
                let payload = SourceGenerationPayload::from(generation);
                (
                    generation_projection_key(&payload.source_id, payload.generation_seq),
                    payload,
                )
            })
            .collect::<BTreeMap<_, _>>();
        let client_warnings = BTreeMap::from([(
            snapshot.snapshot.client_view.client_id.clone(),
            warning_payloads(&snapshot.snapshot.warnings),
        )]);

        Self {
            session_id: snapshot.session_id.clone(),
            session_rev: snapshot.session_rev,
            lease_state: LeaseStatePayload::from(&snapshot.snapshot.lease_state),
            client_warnings,
            client_roster,
            client_views,
            sources,
            datasets,
            layers,
            source_generations,
        }
    }

    pub fn apply_event(&mut self, event: &EventEnvelope) -> Result<(), EventStreamError> {
        if event.session_id != self.session_id {
            return Err(EventStreamError::SessionMismatch {
                expected_session_id: self.session_id.clone(),
                actual_session_id: event.session_id.clone(),
            });
        }

        if event.session_rev <= self.session_rev {
            return Err(EventStreamError::NonMonotonicSessionRevision {
                last_session_rev: self.session_rev,
                next_session_rev: event.session_rev,
            });
        }

        match &event.payload {
            EventPayload::SessionClientJoined(payload) => {
                self.client_roster
                    .insert(payload.client_id.clone(), payload.clone());
            }
            EventPayload::LeaseChanged(payload) => {
                self.lease_state = payload.lease_state.clone();
            }
            EventPayload::WarningsUpdated(payload) => {
                self.client_warnings
                    .insert(payload.client_id.clone(), payload.warnings.clone());
            }
            EventPayload::ViewUpdated(payload) => {
                self.client_views
                    .insert(payload.client_id.clone(), payload.clone());
            }
            EventPayload::SceneSourceUpsert(payload) => {
                self.sources
                    .insert(payload.source_id.clone(), payload.clone());
            }
            EventPayload::SceneDatasetUpsert(payload) => {
                self.datasets
                    .insert(payload.dataset_id.clone(), payload.clone());
            }
            EventPayload::SceneLayerUpsert(payload) => {
                self.layers
                    .insert(payload.layer_id.clone(), payload.clone());
            }
            EventPayload::SourceGenerationDetected(payload)
            | EventPayload::SourceGenerationStarted(payload)
            | EventPayload::SourceGenerationProgress(payload)
            | EventPayload::SourceGenerationReady(payload) => {
                self.source_generations.insert(
                    generation_projection_key(&payload.source_id, payload.generation_seq),
                    payload.clone(),
                );
            }
        }

        self.session_rev = event.session_rev;
        Ok(())
    }
}

pub struct EventMessageSerializer;

impl EventMessageSerializer {
    pub fn serialize(event: &EventEnvelope) -> Result<String, serde_json::Error> {
        serde_json::to_string(event)
    }

    pub fn deserialize(raw: &str) -> Result<EventEnvelope, serde_json::Error> {
        serde_json::from_str(raw)
    }
}

impl From<&ClientRosterEntry> for ClientJoinedPayload {
    fn from(value: &ClientRosterEntry) -> Self {
        Self {
            client_id: value.client_id.clone(),
            label: value.label.clone(),
            permission_class: permission_class_name(value.permission_class).to_owned(),
            connected_at: value.connected_at.clone(),
            last_seen_at: value.last_seen_at.clone(),
            is_lease_holder: value.is_lease_holder,
        }
    }
}

impl From<&PerClientViewState> for ViewUpdatedPayload {
    fn from(value: &PerClientViewState) -> Self {
        Self {
            client_id: value.client_id.clone(),
            view_rev: value.view_rev,
            view_mode: view_mode_name(value.view_mode).to_owned(),
            active_layer_id: value.active_layer_id.clone(),
        }
    }
}

impl From<&LeaseState> for LeaseStatePayload {
    fn from(value: &LeaseState) -> Self {
        Self {
            lease_holder_client_id: value.lease_holder_client_id.clone(),
            lease_holder_label: value.lease_holder_label.clone(),
            acquired_at: value.acquired_at.clone(),
            stealable: value.stealable,
            expires_at: value.expires_at.clone(),
        }
    }
}

impl From<&SourceRecord> for SourceUpsertPayload {
    fn from(value: &SourceRecord) -> Self {
        Self {
            source_id: value.source_id.clone(),
            name: value.name.clone(),
            uri: value.uri.clone(),
            source_kind: source_kind_name(value.source_kind).to_owned(),
            status: source_status_name(value.status).to_owned(),
            latest_working_generation_seq: value.latest_working_generation_seq,
        }
    }
}

impl From<&DatasetBinding> for DatasetUpsertPayload {
    fn from(value: &DatasetBinding) -> Self {
        Self {
            dataset_id: value.dataset_id.clone(),
            name: value.name.clone(),
            dataset_kind: dataset_kind_name(value.dataset_kind).to_owned(),
            generation_ref_mode: generation_ref_mode_name(value.generation_ref.mode).to_owned(),
            source_id: value.source_id.clone(),
            resolved_generation_seq: value.resolved_generation_seq,
            canonical_axes: value
                .canonical_axes
                .iter()
                .map(axis_name)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>(),
            dtype: value.dtype.clone(),
            channel_count: value.channel_table.channel_count,
        }
    }
}

#[must_use]
pub const fn lease_change_kind_payload(value: LeaseChangeKind) -> LeaseChangedKindPayload {
    match value {
        LeaseChangeKind::Requested => LeaseChangedKindPayload::Requested,
        LeaseChangeKind::Stolen => LeaseChangedKindPayload::Stolen,
    }
}

#[must_use]
pub const fn audit_event_kind_payload(value: AuditEventKind) -> AuditEventKindPayload {
    match value {
        AuditEventKind::LeaseRequested => AuditEventKindPayload::LeaseRequested,
        AuditEventKind::LeaseStolen => AuditEventKindPayload::LeaseStolen,
    }
}

impl From<&LayerState> for LayerUpsertPayload {
    fn from(value: &LayerState) -> Self {
        Self {
            layer_id: value.layer_id.clone(),
            name: value.name.clone(),
            layer_rev: value.layer_rev,
            metadata_rev: value.metadata_rev,
            write_rev: value.write_rev,
        }
    }
}

impl From<&GenerationRecord> for SourceGenerationPayload {
    fn from(value: &GenerationRecord) -> Self {
        Self {
            generation_id: value.generation_id.clone(),
            source_id: value.source_id.clone(),
            generation_seq: value.generation_seq,
            stage: generation_stage_name(value.stage).to_owned(),
            progress_percent: value.progress_percent,
            preview_ready: value.availability.preview_ready,
            tile2d_ready_lods: value.availability.tile2d_ready_lods.clone(),
            brick3d_ready_lods: value.availability.brick3d_ready_lods.clone(),
        }
    }
}

#[must_use]
pub fn warning_payloads(warnings: &[WarningEntry]) -> Vec<WarningPayloadEntry> {
    warnings
        .iter()
        .map(WarningPayloadEntry::from)
        .collect::<Vec<_>>()
}

impl From<&WarningEntry> for WarningPayloadEntry {
    fn from(value: &WarningEntry) -> Self {
        Self {
            warning_code: warning_code_name(value.warning_code).to_owned(),
            severity: warning_severity_name(value.severity).to_owned(),
            message: value.message.clone(),
        }
    }
}

const fn permission_class_name(permission: PermissionClass) -> &'static str {
    match permission {
        PermissionClass::View => "view",
        PermissionClass::Control => "control",
        PermissionClass::Admin => "admin",
    }
}

const fn view_mode_name(view_mode: ClientViewMode) -> &'static str {
    match view_mode {
        ClientViewMode::TwoD => "2d",
        ClientViewMode::ThreeD => "3d",
    }
}

const fn source_kind_name(kind: SourceKind) -> &'static str {
    match kind {
        SourceKind::Tiff => "tiff",
        SourceKind::BigTiff => "bigtiff",
        SourceKind::Zarr => "zarr",
        SourceKind::OmeZarr => "ome_zarr",
        SourceKind::Other => "other",
    }
}

const fn source_status_name(status: SourceStatus) -> &'static str {
    match status {
        SourceStatus::Idle => "idle",
        SourceStatus::Watching => "watching",
        SourceStatus::Building => "building",
        SourceStatus::Error => "error",
    }
}

const fn dataset_kind_name(kind: DatasetKind) -> &'static str {
    match kind {
        DatasetKind::Source => "source",
        DatasetKind::Derived => "derived",
    }
}

const fn generation_ref_mode_name(mode: GenerationRefMode) -> &'static str {
    match mode {
        GenerationRefMode::Working => "working",
        GenerationRefMode::Pinned => "pinned",
    }
}

fn axis_name(axis: &AxisName) -> &str {
    match axis {
        AxisName::T => "t",
        AxisName::C => "c",
        AxisName::Z => "z",
        AxisName::Y => "y",
        AxisName::X => "x",
        AxisName::Extra(name) => name.as_str(),
    }
}

const fn generation_stage_name(stage: GenerationStage) -> &'static str {
    match stage {
        GenerationStage::Detected => "detected",
        GenerationStage::Started => "started",
        GenerationStage::Partial => "partial",
        GenerationStage::Ready => "ready",
        GenerationStage::Pinned => "pinned",
        GenerationStage::GarbageCollected => "garbage_collected",
        GenerationStage::Failed => "failed",
    }
}

fn generation_projection_key(source_id: &str, generation_seq: u64) -> String {
    format!("{source_id}:{generation_seq}")
}

const fn warning_code_name(code: WarningCode) -> &'static str {
    match code {
        WarningCode::UncalibratedOverlay => "uncalibrated_overlay",
        WarningCode::StaleDerivedLayer => "stale_derived_layer",
        WarningCode::IncompleteLabelIndex => "incomplete_label_index",
        WarningCode::ComputedAtLod => "computed_at_lod",
        WarningCode::GenerationBuildIncomplete => "generation_build_incomplete",
        WarningCode::MissingActiveLayer => "missing_active_layer",
    }
}

const fn warning_severity_name(severity: WarningSeverity) -> &'static str {
    match severity {
        WarningSeverity::Info => "info",
        WarningSeverity::Warning => "warning",
        WarningSeverity::Error => "error",
    }
}

#[cfg(test)]
mod tests {
    use crate::model::{AttachRequest, ClientViewMode, PermissionClass};
    use crate::session_manager::SessionManager;

    use super::{
        EventBus, EventEnvelope, EventMessageSerializer, EventPayload, EventStreamError,
        ProjectionState, SourceGenerationPayload, SourceUpsertPayload, ViewUpdatedPayload,
        WarningPayloadEntry, WarningsUpdatedPayload,
    };

    #[test]
    fn event_bus_rejects_non_monotonic_session_revisions() {
        let mut bus = EventBus::new();

        let first = EventEnvelope::scene_source_upsert(
            "sess_00000001".to_owned(),
            2,
            SourceUpsertPayload {
                source_id: "src_00000001".to_owned(),
                name: "source-a".to_owned(),
                uri: "/tmp/source-a.tiff".to_owned(),
                source_kind: "tiff".to_owned(),
                status: "watching".to_owned(),
                latest_working_generation_seq: 0,
            },
            "2026-03-01T01:00:00Z".to_owned(),
        );
        let second = EventEnvelope::scene_source_upsert(
            "sess_00000001".to_owned(),
            2,
            SourceUpsertPayload {
                source_id: "src_00000002".to_owned(),
                name: "source-b".to_owned(),
                uri: "/tmp/source-b.tiff".to_owned(),
                source_kind: "tiff".to_owned(),
                status: "watching".to_owned(),
                latest_working_generation_seq: 0,
            },
            "2026-03-01T01:00:01Z".to_owned(),
        );

        bus.publish(first)
            .expect("first monotonic event should succeed");
        let error = bus
            .publish(second)
            .expect_err("second non-monotonic event should fail");
        assert_eq!(
            error,
            EventStreamError::NonMonotonicSessionRevision {
                last_session_rev: 2,
                next_session_rev: 2
            }
        );
    }

    #[test]
    fn projection_hydrates_from_snapshot_and_applies_typed_events() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("projection-session");
        let snapshot = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("attach should succeed");

        let mut projection = ProjectionState::from_snapshot(&snapshot);
        assert!(projection.sources.is_empty());

        let source_event = EventEnvelope::scene_source_upsert(
            created.session_id.clone(),
            snapshot.session_rev + 1,
            SourceUpsertPayload {
                source_id: "src_90000001".to_owned(),
                name: "projection-source".to_owned(),
                uri: "/tmp/projection-source.tiff".to_owned(),
                source_kind: "tiff".to_owned(),
                status: "watching".to_owned(),
                latest_working_generation_seq: 3,
            },
            "2026-03-01T01:00:10Z".to_owned(),
        );
        projection
            .apply_event(&source_event)
            .expect("source upsert event should apply");

        let view_event = EventEnvelope::view_updated(
            created.session_id,
            snapshot.session_rev + 2,
            ViewUpdatedPayload {
                client_id: snapshot.snapshot.client_view.client_id.clone(),
                view_rev: 1,
                view_mode: "3d".to_owned(),
                active_layer_id: Some("lay_00000001".to_owned()),
            },
            "2026-03-01T01:00:11Z".to_owned(),
        );
        projection
            .apply_event(&view_event)
            .expect("view updated event should apply");

        let source_payload = projection
            .sources
            .get("src_90000001")
            .expect("source payload should exist");
        assert_eq!(source_payload.latest_working_generation_seq, 3);

        let view_payload = projection
            .client_views
            .get(&snapshot.snapshot.client_view.client_id)
            .expect("client view payload should exist");
        assert_eq!(view_payload.view_mode, "3d");
        assert_eq!(
            view_payload.active_layer_id.as_deref(),
            Some("lay_00000001")
        );
        assert_eq!(projection.session_rev, snapshot.session_rev + 2);
    }

    #[test]
    fn projection_applies_generation_lifecycle_events_coherently() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("generation-projection-session");
        let snapshot = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("attach should succeed");
        let mut projection = ProjectionState::from_snapshot(&snapshot);

        let detected = EventEnvelope::source_generation_detected(
            created.session_id.clone(),
            snapshot.session_rev + 1,
            SourceGenerationPayload {
                generation_id: "gen_00000001".to_owned(),
                source_id: "src_00000001".to_owned(),
                generation_seq: 1,
                stage: "detected".to_owned(),
                progress_percent: 0,
                preview_ready: false,
                tile2d_ready_lods: vec![],
                brick3d_ready_lods: vec![],
            },
            "2026-03-01T02:00:00Z".to_owned(),
        );
        projection
            .apply_event(&detected)
            .expect("detected event should apply");

        let started = EventEnvelope::source_generation_started(
            created.session_id.clone(),
            snapshot.session_rev + 2,
            SourceGenerationPayload {
                generation_id: "gen_00000001".to_owned(),
                source_id: "src_00000001".to_owned(),
                generation_seq: 1,
                stage: "started".to_owned(),
                progress_percent: 10,
                preview_ready: false,
                tile2d_ready_lods: vec![],
                brick3d_ready_lods: vec![],
            },
            "2026-03-01T02:00:01Z".to_owned(),
        );
        projection
            .apply_event(&started)
            .expect("started event should apply");

        let progress = EventEnvelope::source_generation_progress(
            created.session_id.clone(),
            snapshot.session_rev + 3,
            SourceGenerationPayload {
                generation_id: "gen_00000001".to_owned(),
                source_id: "src_00000001".to_owned(),
                generation_seq: 1,
                stage: "partial".to_owned(),
                progress_percent: 75,
                preview_ready: true,
                tile2d_ready_lods: vec![4, 3],
                brick3d_ready_lods: vec![],
            },
            "2026-03-01T02:00:02Z".to_owned(),
        );
        projection
            .apply_event(&progress)
            .expect("progress event should apply");

        let ready = EventEnvelope::source_generation_ready(
            created.session_id,
            snapshot.session_rev + 4,
            SourceGenerationPayload {
                generation_id: "gen_00000001".to_owned(),
                source_id: "src_00000001".to_owned(),
                generation_seq: 1,
                stage: "ready".to_owned(),
                progress_percent: 100,
                preview_ready: true,
                tile2d_ready_lods: vec![4, 3, 2, 1, 0],
                brick3d_ready_lods: vec![2, 1, 0],
            },
            "2026-03-01T02:00:03Z".to_owned(),
        );
        projection
            .apply_event(&ready)
            .expect("ready event should apply");

        let generation = projection
            .source_generations
            .get("src_00000001:1")
            .expect("generation payload should exist");
        assert_eq!(generation.stage, "ready");
        assert_eq!(generation.progress_percent, 100);
        assert_eq!(generation.tile2d_ready_lods, vec![4, 3, 2, 1, 0]);
        assert_eq!(projection.session_rev, snapshot.session_rev + 4);
    }

    #[test]
    fn serializer_round_trips_event_envelopes() {
        let event = EventEnvelope::view_updated(
            "sess_00000001".to_owned(),
            7,
            ViewUpdatedPayload {
                client_id: "cli_00000001".to_owned(),
                view_rev: 2,
                view_mode: "2d".to_owned(),
                active_layer_id: None,
            },
            "2026-03-01T01:00:20Z".to_owned(),
        );

        let encoded =
            EventMessageSerializer::serialize(&event).expect("event serialization should succeed");
        let decoded = EventMessageSerializer::deserialize(&encoded)
            .expect("event deserialization should succeed");

        assert_eq!(decoded, event);
        assert!(matches!(decoded.payload, EventPayload::ViewUpdated(_)));
    }

    #[test]
    fn projection_rejects_session_mismatch() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("mismatch-session");
        let snapshot = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("attach should succeed");
        let mut projection = ProjectionState::from_snapshot(&snapshot);

        let wrong_session_event = EventEnvelope::view_updated(
            "sess_other".to_owned(),
            snapshot.session_rev + 1,
            ViewUpdatedPayload {
                client_id: snapshot.snapshot.client_view.client_id.clone(),
                view_rev: 1,
                view_mode: match ClientViewMode::TwoD {
                    ClientViewMode::TwoD => "2d",
                    ClientViewMode::ThreeD => "3d",
                }
                .to_owned(),
                active_layer_id: None,
            },
            "2026-03-01T01:00:30Z".to_owned(),
        );

        let error = projection
            .apply_event(&wrong_session_event)
            .expect_err("session mismatch should fail");
        assert!(matches!(error, EventStreamError::SessionMismatch { .. }));
    }

    #[test]
    fn projection_applies_warning_updates_for_target_client() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("warning-projection");
        let snapshot = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("attach should succeed");

        let mut projection = ProjectionState::from_snapshot(&snapshot);
        let warning_event = EventEnvelope::warnings_updated(
            created.session_id,
            snapshot.session_rev + 1,
            WarningsUpdatedPayload {
                client_id: snapshot.snapshot.client_view.client_id.clone(),
                warnings: vec![WarningPayloadEntry {
                    warning_code: "missing_active_layer".to_owned(),
                    severity: "warning".to_owned(),
                    message: "active layer `lay_missing` is missing from shared scene".to_owned(),
                }],
            },
            "2026-03-01T03:00:00Z".to_owned(),
        );

        projection
            .apply_event(&warning_event)
            .expect("warning event should apply");
        assert_eq!(
            projection
                .client_warnings
                .get(&snapshot.snapshot.client_view.client_id)
                .expect("warning list should exist")
                .len(),
            1
        );
    }
}
