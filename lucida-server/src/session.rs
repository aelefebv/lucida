use std::collections::{HashMap, VecDeque};

use lucida_content::DatasetId;
use lucida_core::camera::Camera;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientId, PeerIdentity, PresenceState, ServerMessage};
use lucida_core::scene::{
    Annotation, CommandValidationCategory, CommandValidationError, Comment, DatasetDisplaySettings,
    DisplayState, DocumentState,
};
use lucida_core::view::ViewState;
use lucida_protocol::{
    DatasetOpenFailureDiagnostic, GeneratedAvailabilityDelta, GeneratedAvailabilityIndex,
    MAX_GENERATED_RUNTIME_CHUNKS, MAX_GENERATED_RUNTIME_LEVELS,
};
use serde::ser::{SerializeMap, SerializeSeq, SerializeStruct};
use serde::{Serialize, Serializer};

use crate::binding::ServerBinding;

const HISTORY_CAPACITY: usize = 256;
const MAX_GENERATED_SESSION_DATASETS: usize = 4_096;
// These are session-wide ceilings, not per-dataset allowances. A workspace
// snapshot is one wire message, so multiplying either limit by the number of
// loaded datasets would defeat the allocation bound at the serialization
// boundary.
const MAX_GENERATED_SESSION_LEVELS: usize = MAX_GENERATED_RUNTIME_LEVELS;
const MAX_GENERATED_SESSION_CHUNKS: usize = MAX_GENERATED_RUNTIME_CHUNKS;

pub struct Session {
    pub document: DocumentState,
    pub seq: u64,
    history: VecDeque<DocumentOperation>,
    /// Server-hosted datasets: dataset_id → operational binding (store + resolver + cache).
    pub server_bindings: HashMap<DatasetId, ServerBinding>,
    /// Server-private source/restore metadata for workspace datasets.
    /// Kept outside `DocumentState` so client-visible membership remains
    /// the source of truth while operational restore failures stay diagnosable.
    pub binding_runtime: HashMap<DatasetId, DatasetBindingRuntimeState>,
    /// Server-authored runtime generated coarse metadata/readiness.
    /// Kept outside `DocumentState` so it is never treated as a user
    /// document command or saved-view payload.
    pub generated_availability: HashMap<DatasetId, GeneratedAvailabilityIndex>,
    /// Per-client ephemeral presence state.
    pub clients: HashMap<ClientId, PresenceState>,
}

/// Borrowed wire view of a session snapshot. Serializing this view walks the
/// authoritative document, peer state, and generated-availability indexes in
/// place; it does not clone a potentially 32 MiB `ServerMessage::Snapshot`
/// before the outbound allocator has admitted its exact serialized length.
pub(crate) struct SessionSnapshot<'a> {
    session: &'a Session,
    your_id: ClientId,
}

impl Serialize for SessionSnapshot<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut snapshot = serializer.serialize_struct("ServerMessage", 6)?;
        snapshot.serialize_field("type", "snapshot")?;
        snapshot.serialize_field("seq", &self.session.seq)?;
        snapshot.serialize_field("document", &self.session.document)?;
        snapshot.serialize_field("peers", &PresenceValues(&self.session.clients))?;
        snapshot.serialize_field("your_id", &self.your_id)?;
        snapshot.serialize_field(
            "generated_availability",
            &GeneratedAvailabilityValues(&self.session.generated_availability),
        )?;
        snapshot.end()
    }
}

struct PresenceValues<'a>(&'a HashMap<ClientId, PresenceState>);

impl Serialize for PresenceValues<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut peers = serializer.serialize_seq(Some(self.0.len()))?;
        for presence in self.0.values() {
            peers.serialize_element(presence)?;
        }
        peers.end()
    }
}

struct GeneratedAvailabilityValues<'a>(&'a HashMap<DatasetId, GeneratedAvailabilityIndex>);

impl Serialize for GeneratedAvailabilityValues<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut remaining_levels = MAX_GENERATED_SESSION_LEVELS;
        let mut remaining_chunks = MAX_GENERATED_SESSION_CHUNKS;
        let mut values = serializer.serialize_map(None)?;
        for (dataset_id, index) in self.0 {
            if remaining_levels == 0 && remaining_chunks == 0 {
                break;
            }
            let level_count = index.level_count().min(remaining_levels);
            let chunk_count = index.chunk_count().min(remaining_chunks);
            if level_count == 0 && chunk_count == 0 {
                continue;
            }
            values.serialize_entry(
                dataset_id,
                &GeneratedAvailabilityValue {
                    index,
                    level_count,
                    chunk_count,
                },
            )?;
            remaining_levels = remaining_levels.saturating_sub(level_count);
            remaining_chunks = remaining_chunks.saturating_sub(chunk_count);
        }
        values.end()
    }
}

struct GeneratedAvailabilityValue<'a> {
    index: &'a GeneratedAvailabilityIndex,
    level_count: usize,
    chunk_count: usize,
}

impl Serialize for GeneratedAvailabilityValue<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut value = serializer.serialize_struct("GeneratedAvailabilitySnapshot", 2)?;
        value.serialize_field(
            "levels",
            &GeneratedLevelValues {
                index: self.index,
                limit: self.level_count,
            },
        )?;
        value.serialize_field(
            "chunks",
            &GeneratedChunkValues {
                index: self.index,
                limit: self.chunk_count,
            },
        )?;
        value.end()
    }
}

struct GeneratedLevelValues<'a> {
    index: &'a GeneratedAvailabilityIndex,
    limit: usize,
}

impl Serialize for GeneratedLevelValues<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut levels = serializer.serialize_seq(Some(self.limit))?;
        for level in self.index.levels().take(self.limit) {
            levels.serialize_element(level)?;
        }
        levels.end()
    }
}

struct GeneratedChunkValues<'a> {
    index: &'a GeneratedAvailabilityIndex,
    limit: usize,
}

impl Serialize for GeneratedChunkValues<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut chunks = serializer.serialize_seq(Some(self.limit))?;
        for chunk in self.index.chunks().take(self.limit) {
            chunks.serialize_element(chunk)?;
        }
        chunks.end()
    }
}

/// An opaque capability to publish one already-validated document revision.
///
/// Only [`Session::stage_durable_document_as`] can construct this value.  It is
/// intentionally non-`Clone`: callers may borrow its command/document for one
/// exact-predecessor persistence attempt and then consume it exactly once after
/// that attempt commits.  All validation, serialization checks, inverse
/// derivation, and history construction happen while staging, so consumption
/// cannot discover a new failure after the database is already durable.
#[must_use = "persist this staged revision and consume it with Session::commit_staged_document"]
pub(crate) struct StagedDocumentCommit {
    seq: u64,
    document: DocumentState,
    operation: DocumentOperation,
}

impl StagedDocumentCommit {
    pub(crate) fn seq(&self) -> u64 {
        self.seq
    }

    pub(crate) fn document(&self) -> &DocumentState {
        &self.document
    }

    pub(crate) fn command(&self) -> &DocumentCommand {
        &self.operation.command
    }
}

/// One accepted shared-document operation. The sequence number is also its
/// stable operation identity: it is allocated by the authoritative session,
/// never supplied by a client, and therefore cannot collide across peers.
///
/// Keeping inverse metadata beside the normal command log preserves Lucida's
/// append-only collaboration model: undo resolves to another command and the
/// resulting operation is recorded with `inverse_of`, rather than replacing a
/// document snapshot or decrementing the sequence.
#[derive(Debug, Clone)]
pub struct DocumentOperation {
    pub seq: u64,
    pub author: String,
    pub command: DocumentCommand,
    pub inverse: Option<DocumentCommand>,
    pub inverse_of: Option<u64>,
    precondition: OperationPrecondition,
}

#[derive(Debug, Clone, PartialEq)]
enum OperationPrecondition {
    Dataset(Option<String>),
    DatasetName(Option<String>),
    ActiveLayout(Option<String>),
    Annotation(Option<Box<Annotation>>),
    AnnotationGeometry(Option<([f64; 2], Option<[f64; 2]>, f64)>),
    Comment(Option<Comment>),
    Unsupported,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum InverseCommandError {
    #[error("the target operation is no longer retained")]
    UnknownOperation,
    #[error("the target operation revision does not match")]
    RevisionConflict,
    #[error("only the operation author may undo it")]
    NotAuthor,
    #[error("the target operation has no lossless inverse")]
    Unsupported,
    #[error("the target changed after the operation")]
    TargetChanged,
}

#[derive(Debug, Clone)]
pub struct PreparedInverse {
    pub command: DocumentCommand,
    pub inverse_of: u64,
}

#[derive(Debug, Clone)]
pub struct DatasetBindingRuntimeState {
    pub source_url: String,
    pub dataset_source_id: Option<String>,
    pub display_name: String,
    pub last_restore_failure: Option<DatasetOpenFailureDiagnostic>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Self {
            document: DocumentState::default(),
            seq: 0,
            history: VecDeque::with_capacity(HISTORY_CAPACITY),
            server_bindings: HashMap::new(),
            binding_runtime: HashMap::new(),
            generated_availability: HashMap::new(),
            clients: HashMap::new(),
        }
    }

    pub fn snapshot(&self, your_id: ClientId) -> ServerMessage {
        let mut remaining_levels = MAX_GENERATED_SESSION_LEVELS;
        let mut remaining_chunks = MAX_GENERATED_SESSION_CHUNKS;
        let generated_availability = self
            .generated_availability
            .iter()
            .filter_map(|(dataset_id, index)| {
                if remaining_levels == 0 && remaining_chunks == 0 {
                    return None;
                }
                let snapshot = index.snapshot_with_limits(remaining_levels, remaining_chunks);
                remaining_levels = remaining_levels.saturating_sub(snapshot.levels.len());
                remaining_chunks = remaining_chunks.saturating_sub(snapshot.chunks.len());
                if snapshot.levels.is_empty() && snapshot.chunks.is_empty() {
                    None
                } else {
                    Some((dataset_id.clone(), snapshot))
                }
            })
            .collect();
        ServerMessage::Snapshot {
            seq: self.seq,
            document: self.document.clone(),
            peers: self.clients.values().cloned().collect(),
            your_id,
            generated_availability,
        }
    }

    pub(crate) fn snapshot_view(&self, your_id: ClientId) -> SessionSnapshot<'_> {
        SessionSnapshot {
            session: self,
            your_id,
        }
    }

    /// Apply a server-authored document command. Returns the new seq number.
    /// User-originated paths should use [`Self::apply_as`] so the operation can
    /// later pass the authorship check for collaborative undo.
    pub fn apply(&mut self, cmd: DocumentCommand) -> u64 {
        self.try_apply(cmd)
            .expect("trusted server command must satisfy core validation")
    }

    /// Atomically validate and apply a server-authored document command.
    pub fn try_apply(&mut self, cmd: DocumentCommand) -> Result<u64, CommandValidationError> {
        self.try_apply_as(cmd, "server", None)
    }

    /// Apply a trusted document command and append its audit/inverse metadata.
    pub fn apply_as(&mut self, cmd: DocumentCommand, author: &str, inverse_of: Option<u64>) -> u64 {
        self.try_apply_as(cmd, author, inverse_of)
            .expect("trusted session command must satisfy core validation")
    }

    /// Atomically validate and apply a document command while appending its
    /// audit/inverse metadata. Rejection leaves the document, runtime
    /// capabilities, history, and sequence untouched.
    pub fn try_apply_as(
        &mut self,
        cmd: DocumentCommand,
        author: &str,
        inverse_of: Option<u64>,
    ) -> Result<u64, CommandValidationError> {
        let staged = self.stage_durable_document_as(cmd, author, inverse_of)?;
        let seq = staged.seq();
        self.commit_staged_document(staged);
        Ok(seq)
    }

    pub(crate) fn stage_durable_document(
        &self,
        command: DocumentCommand,
    ) -> Result<StagedDocumentCommit, CommandValidationError> {
        self.stage_durable_document_as(command, "server", None)
    }

    /// Validate and fully prepare one contiguous durable revision without
    /// mutating the Session. The returned capability exposes only immutable
    /// persistence inputs and cannot be cloned or fabricated by callers.
    pub(crate) fn stage_durable_document_as(
        &self,
        command: DocumentCommand,
        author: &str,
        inverse_of: Option<u64>,
    ) -> Result<StagedDocumentCommit, CommandValidationError> {
        let seq = self
            .seq
            .checked_add(1)
            .ok_or_else(|| CommandValidationError {
                category: CommandValidationCategory::ResourceLimit,
                path: "session.seq".to_string(),
                message: "session sequence is exhausted".to_string(),
            })?;
        let before = self.document.clone();
        let mut document = before.clone();
        document.try_apply(command.clone())?;
        let operation =
            self.prepare_operation(command, seq, author, inverse_of, &before, &document);
        Ok(StagedDocumentCommit {
            seq,
            document,
            operation,
        })
    }

    /// Consume a capability only after its exact-predecessor store transaction
    /// commits. This path is deliberately infallible: it performs no apply,
    /// validation, serialization, comparison, or sequence arithmetic after
    /// durability has been established.
    pub(crate) fn commit_staged_document(
        &mut self,
        staged: StagedDocumentCommit,
    ) -> Option<ServerBinding> {
        let StagedDocumentCommit {
            seq,
            document,
            operation,
        } = staged;
        let removed_binding = if let DocumentCommand::RemoveDataset { id } = &operation.command {
            self.generated_availability.remove(id);
            self.binding_runtime.remove(id);
            self.server_bindings.remove(id)
        } else {
            None
        };

        self.document = document;
        self.seq = seq;
        self.append_operation(operation);
        removed_binding
    }

    fn prepare_operation(
        &self,
        command: DocumentCommand,
        seq: u64,
        author: &str,
        inverse_of: Option<u64>,
        before: &DocumentState,
        after: &DocumentState,
    ) -> DocumentOperation {
        // Redo is the inverse of the inverse. When this operation was itself
        // prepared from a retained target, that target's concrete command is
        // the exact lossless redo—even for command pairs where the forward
        // vocabulary alone cannot reconstruct prior state (dataset open ↔
        // remove is the important case).
        let inverse = inverse_of
            .and_then(|target| {
                self.history
                    .iter()
                    .find(|operation| operation.seq == target)
                    .map(|operation| operation.command.clone())
            })
            .or_else(|| inverse_for(before, &command));
        DocumentOperation {
            seq,
            author: normalize_actor(author),
            inverse,
            precondition: precondition_for(after, &command),
            command,
            inverse_of,
        }
    }

    fn append_operation(&mut self, operation: DocumentOperation) {
        if self.history.len() == HISTORY_CAPACITY {
            self.history.pop_front();
        }
        tracing::info!(
            operation_id = operation.seq,
            author = %operation.author,
            inverse_of = ?operation.inverse_of,
            undoable = operation.inverse.is_some(),
            "session.document_operation_appended"
        );
        self.history.push_back(operation);
    }

    /// Resolve an inverse request without mutating state. The caller must
    /// still run current role/ownership policy, validate, persist, and then
    /// publish the returned command through the normal sequence boundary.
    pub fn prepare_inverse(
        &self,
        target_operation_id: u64,
        expected_revision: u64,
        actor: &str,
    ) -> Result<PreparedInverse, InverseCommandError> {
        let operation = self
            .history
            .iter()
            .find(|operation| operation.seq == target_operation_id)
            .ok_or(InverseCommandError::UnknownOperation)?;
        if operation.seq != expected_revision {
            return Err(InverseCommandError::RevisionConflict);
        }
        if operation.author != normalize_actor(actor) {
            return Err(InverseCommandError::NotAuthor);
        }
        let inverse = operation
            .inverse
            .clone()
            .ok_or(InverseCommandError::Unsupported)?;
        if precondition_for(&self.document, &operation.command) != operation.precondition {
            return Err(InverseCommandError::TargetChanged);
        }
        Ok(PreparedInverse {
            command: inverse,
            inverse_of: operation.seq,
        })
    }

    pub fn apply_generated_availability_delta(
        &mut self,
        dataset_id: DatasetId,
        delta: GeneratedAvailabilityDelta,
    ) {
        if !self.generated_availability.contains_key(&dataset_id) {
            // A status-only delta cannot establish its own geometry, and an
            // empty delta must not create a durable map entry. Both rules keep
            // repeated invalid publications O(1) in session memory.
            if delta.levels.is_empty()
                || self.generated_availability.len() >= MAX_GENERATED_SESSION_DATASETS
            {
                return;
            }
        }
        let existing_levels = self
            .generated_availability
            .get(&dataset_id)
            .map_or(0, GeneratedAvailabilityIndex::level_count);
        let existing_chunks = self
            .generated_availability
            .get(&dataset_id)
            .map_or(0, GeneratedAvailabilityIndex::chunk_count);
        let total_levels = self
            .generated_availability
            .values()
            .fold(0usize, |total, index| {
                total.saturating_add(index.level_count())
            });
        let total_chunks = self
            .generated_availability
            .values()
            .fold(0usize, |total, index| {
                total.saturating_add(index.chunk_count())
            });
        let other_levels = total_levels.saturating_sub(existing_levels);
        let other_chunks = total_chunks.saturating_sub(existing_chunks);
        let dataset_level_limit = MAX_GENERATED_SESSION_LEVELS.saturating_sub(other_levels);
        let dataset_chunk_limit = MAX_GENERATED_SESSION_CHUNKS.saturating_sub(other_chunks);
        let index = self
            .generated_availability
            .entry(dataset_id.clone())
            .or_default();
        index.apply_delta_with_limits(delta, dataset_level_limit, dataset_chunk_limit);
        if index.level_count() == 0 && index.chunk_count() == 0 {
            self.generated_availability.remove(&dataset_id);
        }
    }

    pub fn record_binding_source(
        &mut self,
        dataset_id: DatasetId,
        source_url: String,
        dataset_source_id: Option<String>,
        display_name: String,
    ) {
        self.binding_runtime
            .entry(dataset_id)
            .and_modify(|state| {
                state.source_url = source_url.clone();
                state.dataset_source_id = dataset_source_id.clone();
                state.display_name = display_name.clone();
            })
            .or_insert(DatasetBindingRuntimeState {
                source_url,
                dataset_source_id,
                display_name,
                last_restore_failure: None,
            });
    }

    pub fn record_binding_restore_failure(
        &mut self,
        dataset_id: DatasetId,
        source_url: String,
        dataset_source_id: Option<String>,
        display_name: String,
        diagnostic: DatasetOpenFailureDiagnostic,
    ) {
        self.binding_runtime.insert(
            dataset_id,
            DatasetBindingRuntimeState {
                source_url,
                dataset_source_id,
                display_name,
                last_restore_failure: Some(diagnostic),
            },
        );
    }

    pub fn clear_binding_restore_failure(&mut self, dataset_id: &DatasetId) {
        if let Some(state) = self.binding_runtime.get_mut(dataset_id) {
            state.last_restore_failure = None;
        }
    }

    /// Register a newly connected client.
    ///
    /// `identity` is the server-authored presentational identity for the
    /// peer's cursor (#540), derived from the connection's authenticated
    /// principal. Live workspace connections always pass `Some`; `None` is
    /// retained for old snapshot compatibility and minimal session fixtures.
    pub fn add_client(&mut self, id: ClientId, identity: Option<PeerIdentity>) -> PresenceState {
        let presence = PresenceState {
            client_id: id,
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: None,
            cursor: None,
            cursor_dataset_id: None,
            dataset_order: Vec::new(),
            dataset_settings: HashMap::new(),
            identity,
        };
        self.clients.insert(id, presence.clone());
        presence
    }

    /// Remove a client and return the list of clients whose follow target was invalidated
    /// (they were following the disconnected client and need to stop).
    pub fn remove_client(&mut self, id: ClientId) -> Vec<ClientId> {
        self.clients.remove(&id);
        // Redirect any followers of this client to stop following.
        let mut affected = Vec::new();
        for (cid, presence) in &mut self.clients {
            if presence.following == Some(id) {
                presence.following = None;
                affected.push(*cid);
            }
        }
        affected
    }

    pub fn update_presence(
        &mut self,
        id: ClientId,
        camera: Camera,
        view: ViewState,
        display: DisplayState,
    ) {
        if let Some(presence) = self.clients.get_mut(&id) {
            presence.camera = camera;
            presence.view = view;
            presence.display = display;
        }
    }

    pub fn update_cursor(
        &mut self,
        id: ClientId,
        position: Option<[f64; 2]>,
        dataset_id: Option<DatasetId>,
    ) {
        if let Some(presence) = self.clients.get_mut(&id) {
            presence.cursor = position;
            presence.cursor_dataset_id = position.and(dataset_id);
        }
    }

    pub fn update_dataset_presence(
        &mut self,
        id: ClientId,
        dataset_order: Vec<DatasetId>,
        dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    ) {
        if let Some(presence) = self.clients.get_mut(&id) {
            presence.dataset_order = dataset_order;
            presence.dataset_settings = dataset_settings;
        }
    }

    /// Set follow target for a client.
    /// Returns a list of (client_id, new_target) pairs for all affected clients
    /// (including transitive chain resolution).
    pub fn set_follow(
        &mut self,
        client_id: ClientId,
        target: Option<ClientId>,
    ) -> Vec<(ClientId, Option<ClientId>)> {
        let mut changes = Vec::new();

        // Validate: can't follow yourself
        if target == Some(client_id) {
            return changes;
        }

        // Validate: target must exist and must not be following someone else
        if let Some(target_id) = target {
            if let Some(target_presence) = self.clients.get(&target_id) {
                if target_presence.following.is_some() {
                    // Can't follow someone who is already following
                    return changes;
                }
            } else {
                return changes; // Target doesn't exist
            }
        }

        // Set the follow target
        if let Some(presence) = self.clients.get_mut(&client_id) {
            presence.following = target;
            changes.push((client_id, target));
        }

        // Transitive chain resolution: if anyone was following client_id,
        // and client_id is now following someone, redirect them to the new target.
        if let Some(new_target) = target {
            let followers: Vec<ClientId> = self
                .clients
                .iter()
                .filter(|(cid, p)| **cid != client_id && p.following == Some(client_id))
                .map(|(cid, _)| *cid)
                .collect();

            for follower_id in followers {
                if let Some(presence) = self.clients.get_mut(&follower_id) {
                    presence.following = Some(new_target);
                    changes.push((follower_id, Some(new_target)));
                }
            }
        }

        changes
    }
}

fn normalize_actor(actor: &str) -> String {
    actor.trim().to_ascii_lowercase()
}

fn annotation<'a>(
    document: &'a DocumentState,
    dataset_id: &DatasetId,
    id: &str,
) -> Option<&'a Annotation> {
    document
        .annotations
        .get(dataset_id)?
        .iter()
        .find(|annotation| annotation.id == id)
}

fn comment<'a>(
    document: &'a DocumentState,
    dataset_id: &DatasetId,
    annotation_id: &str,
    id: &str,
) -> Option<&'a Comment> {
    annotation(document, dataset_id, annotation_id)?
        .comments
        .iter()
        .find(|comment| comment.id == id)
}

fn dataset_fingerprint(document: &DocumentState, dataset_id: &DatasetId) -> Option<String> {
    let manifest = document.manifests.get(dataset_id)?;
    Some(
        serde_json::to_string(&(
            manifest,
            document.registered_layouts.get(dataset_id),
            document.active_layout_ids.get(dataset_id),
            document.annotations.get(dataset_id),
        ))
        .expect("validated document dataset serializes"),
    )
}

fn precondition_for(document: &DocumentState, command: &DocumentCommand) -> OperationPrecondition {
    match command {
        DocumentCommand::DatasetOpened(opened) => OperationPrecondition::Dataset(
            dataset_fingerprint(document, &opened.manifest.dataset_id),
        ),
        DocumentCommand::RemoveDataset { id } => {
            OperationPrecondition::Dataset(dataset_fingerprint(document, id))
        }
        DocumentCommand::RenameDataset { id, .. } => OperationPrecondition::DatasetName(
            document
                .manifests
                .get(id)
                .map(|manifest| manifest.name.clone()),
        ),
        DocumentCommand::SetActiveLayout { dataset_id, .. } => OperationPrecondition::ActiveLayout(
            document
                .active_layout_ids
                .get(dataset_id)
                .map(|id| id.0.clone()),
        ),
        DocumentCommand::AddAnnotation { dataset_id, id, .. }
        | DocumentCommand::RemoveAnnotation { dataset_id, id } => {
            OperationPrecondition::Annotation(
                annotation(document, dataset_id, id).cloned().map(Box::new),
            )
        }
        DocumentCommand::MoveAnnotation { dataset_id, id, .. } => {
            OperationPrecondition::AnnotationGeometry(
                annotation(document, dataset_id, id)
                    .map(|annotation| (annotation.position, annotation.end, annotation.z)),
            )
        }
        DocumentCommand::AddComment {
            dataset_id,
            annotation_id,
            id,
            ..
        }
        | DocumentCommand::RemoveComment {
            dataset_id,
            annotation_id,
            id,
        }
        | DocumentCommand::EditComment {
            dataset_id,
            annotation_id,
            id,
            ..
        } => OperationPrecondition::Comment(
            comment(document, dataset_id, annotation_id, id).cloned(),
        ),
        DocumentCommand::RegisterLayout { .. } => OperationPrecondition::Unsupported,
    }
}

/// Derive a lossless inverse from the exact pre-command document. Operations
/// whose prior state cannot be represented by today's command vocabulary stay
/// explicitly unavailable rather than pretending that a partial restore is
/// safe (for example dataset removal and annotation-thread deletion).
fn inverse_for(before: &DocumentState, command: &DocumentCommand) -> Option<DocumentCommand> {
    match command {
        DocumentCommand::DatasetOpened(opened)
            if !before.manifests.contains_key(&opened.manifest.dataset_id) =>
        {
            Some(DocumentCommand::RemoveDataset {
                id: opened.manifest.dataset_id.clone(),
            })
        }
        DocumentCommand::RenameDataset { id, name } => {
            let previous = before.manifests.get(id)?.name.clone();
            (previous != *name).then(|| DocumentCommand::RenameDataset {
                id: id.clone(),
                name: previous,
            })
        }
        DocumentCommand::SetActiveLayout {
            dataset_id,
            layout_id,
        } => {
            let previous = before
                .active_layout_ids
                .get(dataset_id)
                .cloned()
                .or_else(|| {
                    before
                        .manifests
                        .get(dataset_id)
                        .and_then(|manifest| manifest.default_layout_id.clone())
                })?;
            (previous != *layout_id).then(|| DocumentCommand::SetActiveLayout {
                dataset_id: dataset_id.clone(),
                layout_id: previous,
            })
        }
        DocumentCommand::AddAnnotation { dataset_id, id, .. }
            if annotation(before, dataset_id, id).is_none() =>
        {
            Some(DocumentCommand::RemoveAnnotation {
                dataset_id: dataset_id.clone(),
                id: id.clone(),
            })
        }
        DocumentCommand::RemoveAnnotation { dataset_id, id } => {
            let previous = annotation(before, dataset_id, id)?;
            if !previous.comments.is_empty() {
                return None;
            }
            Some(DocumentCommand::AddAnnotation {
                dataset_id: dataset_id.clone(),
                id: previous.id.clone(),
                position: previous.position,
                end: previous.end,
                z: previous.z,
                t: previous.t,
                c: previous.c,
                author: previous.author.clone(),
                kind: previous.kind,
                view: previous.view.clone().map(Box::new),
            })
        }
        DocumentCommand::MoveAnnotation { dataset_id, id, .. } => {
            let previous = annotation(before, dataset_id, id)?;
            Some(DocumentCommand::MoveAnnotation {
                dataset_id: dataset_id.clone(),
                id: id.clone(),
                position: previous.position,
                end: previous.end,
                z: previous.z,
            })
        }
        DocumentCommand::AddComment {
            dataset_id,
            annotation_id,
            id,
            ..
        } => match comment(before, dataset_id, annotation_id, id) {
            Some(previous) => Some(DocumentCommand::AddComment {
                dataset_id: dataset_id.clone(),
                annotation_id: annotation_id.clone(),
                id: id.clone(),
                author: previous.author.clone(),
                text: previous.text.clone(),
            }),
            None => Some(DocumentCommand::RemoveComment {
                dataset_id: dataset_id.clone(),
                annotation_id: annotation_id.clone(),
                id: id.clone(),
            }),
        },
        DocumentCommand::RemoveComment {
            dataset_id,
            annotation_id,
            id,
        } => {
            let previous = comment(before, dataset_id, annotation_id, id)?;
            Some(DocumentCommand::AddComment {
                dataset_id: dataset_id.clone(),
                annotation_id: annotation_id.clone(),
                id: id.clone(),
                author: previous.author.clone(),
                text: previous.text.clone(),
            })
        }
        DocumentCommand::EditComment {
            dataset_id,
            annotation_id,
            id,
            text,
        } => {
            let previous = comment(before, dataset_id, annotation_id, id)?;
            (previous.text != *text).then(|| DocumentCommand::EditComment {
                dataset_id: dataset_id.clone(),
                annotation_id: annotation_id.clone(),
                id: id.clone(),
                text: previous.text.clone(),
            })
        }
        DocumentCommand::DatasetOpened(_)
        | DocumentCommand::RemoveDataset { .. }
        | DocumentCommand::RegisterLayout { .. }
        | DocumentCommand::AddAnnotation { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::*;
    use lucida_protocol::*;

    fn make_register(id: &str, name: &str) -> DatasetOpened {
        let entity_id = EntityId(format!("{id}-entity"));
        let image_id = ImageId(format!("{id}-image"));
        let manifest = DatasetManifest::new(
            DatasetId(id.to_string()),
            name.to_string(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some(name.to_string()),
                    ..Default::default()
                },
            }],
            vec![],
            vec![ImageSpec {
                image_id: image_id.clone(),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "z".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".into(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, 1, 10, 256, 256],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, 1, 10, 2, 2],
                        scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    channel_infos: vec![],
                },
            }],
            vec![],
            None,
        );
        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });
        DatasetOpened {
            manifest,
            fetch,
            opener_client_id: None,
        }
    }

    fn generated_level_for(image_id: &str) -> GeneratedLevelAvailability {
        GeneratedLevelAvailability {
            image_id: ImageId(image_id.into()),
            info: GeneratedLevelInfo {
                level_index: 1,
                role: GeneratedLevelRole::Coarse,
                provenance: GeneratedLevelProvenance::default(),
            },
            level: LevelGeometry {
                level_index: 1,
                shape: [1, 1, 1, 1, 1],
                chunk_shape: [1, 1, 1, 1, 1],
                grid_shape: [1, 1, 1, 1, 1],
                scale: [1.0; 5],
            },
            summary: None,
        }
    }

    #[test]
    fn new_session_starts_at_seq_zero() {
        let session = Session::new();
        assert_eq!(session.seq, 0);
    }

    #[test]
    fn apply_increments_seq() {
        let mut session = Session::new();
        let reg = make_register("ds1", "test");
        let seq = session.apply(DocumentCommand::DatasetOpened(reg));
        assert_eq!(seq, 1);
    }

    #[test]
    fn apply_mutates_document() {
        let mut session = Session::new();
        let reg = make_register("ds1", "test");
        session.apply(DocumentCommand::DatasetOpened(reg));
        assert_eq!(session.document.manifests.len(), 1);
        assert!(
            session
                .document
                .manifests
                .contains_key(&DatasetId("ds1".into()))
        );
    }

    #[test]
    fn snapshot_contains_current_state() {
        let mut session = Session::new();
        let reg = make_register("ds1", "test");
        session.apply(DocumentCommand::DatasetOpened(reg));
        let msg = session.snapshot(42);
        match msg {
            ServerMessage::Snapshot {
                seq,
                document,
                your_id,
                ..
            } => {
                assert_eq!(seq, 1);
                assert_eq!(your_id, 42);
                assert_eq!(document.manifests.len(), 1);
            }
            _ => panic!("expected Snapshot"),
        }
    }

    #[test]
    fn borrowed_snapshot_serializes_identically_to_owned_snapshot() {
        let mut session = Session::new();
        session.seq = 17;
        session.add_client(3, None);
        session.apply_generated_availability_delta(
            DatasetId("borrowed".into()),
            GeneratedAvailabilityDelta {
                levels: vec![generated_level_for("borrowed-image")],
                chunks: vec![],
            },
        );

        let owned = serde_json::to_value(session.snapshot(42)).unwrap();
        let borrowed = serde_json::to_value(session.snapshot_view(42)).unwrap();
        assert_eq!(borrowed, owned);
    }

    #[test]
    fn generated_availability_is_runtime_snapshot_state() {
        let mut session = Session::new();
        session.apply_generated_availability_delta(
            DatasetId("ds1".into()),
            GeneratedAvailabilityDelta {
                levels: vec![generated_level_for("ds1-image")],
                chunks: vec![GeneratedChunkStatusUpdate {
                    image_id: ImageId("ds1-image".into()),
                    level_index: 1,
                    key: "1/0/0/0/0/0".into(),
                    status: GeneratedChunkStatus::Ready,
                    failure: None,
                    message: None,
                }],
            },
        );

        let msg = session.snapshot(7);
        match msg {
            ServerMessage::Snapshot {
                generated_availability,
                ..
            } => {
                let snapshot = generated_availability
                    .get(&DatasetId("ds1".into()))
                    .expect("generated availability snapshot");
                assert_eq!(snapshot.chunks.len(), 1);
                assert_eq!(snapshot.chunks[0].status, GeneratedChunkStatus::Ready);
            }
            _ => panic!("expected Snapshot"),
        }
        assert!(session.document.manifests.is_empty());
    }

    #[test]
    fn remove_dataset_clears_generated_availability() {
        let mut session = Session::new();
        let reg = make_register("ds1", "test");
        session.apply(DocumentCommand::DatasetOpened(reg));
        session.apply_generated_availability_delta(
            DatasetId("ds1".into()),
            GeneratedAvailabilityDelta {
                levels: vec![generated_level_for("ds1-image")],
                chunks: vec![],
            },
        );
        assert!(
            session
                .generated_availability
                .contains_key(&DatasetId("ds1".into()))
        );

        session.apply(DocumentCommand::RemoveDataset {
            id: DatasetId("ds1".into()),
        });

        assert!(
            !session
                .generated_availability
                .contains_key(&DatasetId("ds1".into()))
        );
    }

    #[test]
    fn generated_session_registry_rejects_status_only_and_caps_dataset_indexes() {
        let mut session = Session::new();
        for index in 0..10_000 {
            session.apply_generated_availability_delta(
                DatasetId(format!("invalid-{index}")),
                GeneratedAvailabilityDelta {
                    levels: vec![],
                    chunks: vec![GeneratedChunkStatusUpdate {
                        image_id: ImageId(format!("image-{index}")),
                        level_index: 1,
                        key: format!("1/0/0/0/0/{index}"),
                        status: GeneratedChunkStatus::FailedPermanent,
                        failure: None,
                        message: Some("invalid".into()),
                    }],
                },
            );
        }
        assert!(session.generated_availability.is_empty());

        for index in 0..(MAX_GENERATED_SESSION_DATASETS + 128) {
            session.apply_generated_availability_delta(
                DatasetId(format!("dataset-{index}")),
                GeneratedAvailabilityDelta {
                    levels: vec![generated_level_for(&format!("image-{index}"))],
                    chunks: vec![],
                },
            );
        }
        assert_eq!(
            session.generated_availability.len(),
            MAX_GENERATED_SESSION_DATASETS
        );
    }

    #[test]
    fn generated_statuses_share_one_session_wide_retention_and_snapshot_budget() {
        let mut session = Session::new();
        let first_dataset = DatasetId("first".into());
        let second_dataset = DatasetId("second".into());
        let first_image = ImageId("first-image".into());
        let second_image = ImageId("second-image".into());
        let first_count = MAX_GENERATED_SESSION_CHUNKS / 2;
        let attempted_second_count = MAX_GENERATED_SESSION_CHUNKS.saturating_sub(first_count) + 128;

        let level_with_grid = |image_id: &ImageId| {
            let mut level = generated_level_for(&image_id.0);
            level.level.shape[4] = u64::try_from(MAX_GENERATED_SESSION_CHUNKS + 256).unwrap();
            level.level.grid_shape[4] = level.level.shape[4];
            level
        };
        let chunks = |image_id: &ImageId, count: usize| {
            (0..count)
                .map(|x| GeneratedChunkStatusUpdate {
                    image_id: image_id.clone(),
                    level_index: 1,
                    key: format!("1/0/0/0/0/{x}"),
                    status: GeneratedChunkStatus::Pending,
                    failure: None,
                    message: None,
                })
                .collect()
        };

        session.apply_generated_availability_delta(
            first_dataset.clone(),
            GeneratedAvailabilityDelta {
                levels: vec![level_with_grid(&first_image)],
                chunks: chunks(&first_image, first_count),
            },
        );
        session.apply_generated_availability_delta(
            second_dataset.clone(),
            GeneratedAvailabilityDelta {
                levels: vec![level_with_grid(&second_image)],
                chunks: chunks(&second_image, attempted_second_count),
            },
        );

        let retained_chunks = session
            .generated_availability
            .values()
            .map(GeneratedAvailabilityIndex::chunk_count)
            .sum::<usize>();
        assert_eq!(retained_chunks, MAX_GENERATED_SESSION_CHUNKS);
        assert_eq!(
            session.generated_availability[&first_dataset].chunk_count(),
            first_count
        );
        assert_eq!(
            session.generated_availability[&second_dataset].chunk_count(),
            MAX_GENERATED_SESSION_CHUNKS - first_count
        );

        // Full aggregate capacity still permits a hot transition for an
        // admitted key, while a new key remains rejected.
        let rejected_key = format!("1/0/0/0/0/{attempted_second_count}");
        session.apply_generated_availability_delta(
            second_dataset.clone(),
            GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: vec![
                    GeneratedChunkStatusUpdate {
                        image_id: second_image.clone(),
                        level_index: 1,
                        key: "1/0/0/0/0/0".into(),
                        status: GeneratedChunkStatus::Ready,
                        failure: None,
                        message: None,
                    },
                    GeneratedChunkStatusUpdate {
                        image_id: second_image.clone(),
                        level_index: 1,
                        key: rejected_key.clone(),
                        status: GeneratedChunkStatus::Ready,
                        failure: None,
                        message: None,
                    },
                ],
            },
        );
        let second = &session.generated_availability[&second_dataset];
        assert_eq!(
            second
                .chunk(&second_image, 1, "1/0/0/0/0/0")
                .map(|chunk| chunk.status),
            Some(GeneratedChunkStatus::Ready)
        );
        assert!(second.chunk(&second_image, 1, &rejected_key).is_none());

        let snapshot_chunks = match session.snapshot(7) {
            ServerMessage::Snapshot {
                generated_availability,
                ..
            } => {
                assert!(generated_availability.len() >= 2);
                generated_availability
                    .values()
                    .map(|snapshot| snapshot.chunks.len())
                    .sum::<usize>()
            }
            _ => panic!("expected Snapshot"),
        };
        assert_eq!(snapshot_chunks, MAX_GENERATED_SESSION_CHUNKS);
    }

    #[test]
    fn history_ring_buffer_caps_at_256() {
        let mut session = Session::new();
        for i in 0..300 {
            let reg = make_register(&format!("ds-{i}"), "test");
            session.apply(DocumentCommand::DatasetOpened(reg));
        }
        assert_eq!(session.history.len(), HISTORY_CAPACITY);
    }

    #[test]
    fn try_apply_rejection_preserves_document_runtime_history_and_sequence() {
        let mut session = Session::new();
        session.apply(DocumentCommand::DatasetOpened(make_register("ds1", "test")));
        let invalid_id = DatasetId(String::new());
        session
            .generated_availability
            .insert(invalid_id.clone(), GeneratedAvailabilityIndex::default());
        session.binding_runtime.insert(
            invalid_id.clone(),
            DatasetBindingRuntimeState {
                source_url: "memory://invalid".into(),
                dataset_source_id: None,
                display_name: "invalid".into(),
                last_restore_failure: None,
            },
        );
        let document_before = serde_json::to_value(&session.document).unwrap();
        let seq_before = session.seq;
        let history_before = session.history.len();

        let error = session
            .try_apply(DocumentCommand::RemoveDataset {
                id: invalid_id.clone(),
            })
            .unwrap_err();

        assert_eq!(error.category, CommandValidationCategory::InvalidValue);
        assert_eq!(error.path, "command.dataset_id");
        assert_eq!(session.seq, seq_before);
        assert_eq!(session.history.len(), history_before);
        assert_eq!(
            serde_json::to_value(&session.document).unwrap(),
            document_before
        );
        assert!(session.generated_availability.contains_key(&invalid_id));
        assert!(session.binding_runtime.contains_key(&invalid_id));
        session.document.validate_state().unwrap();
    }

    #[test]
    fn sequence_exhaustion_rejects_before_any_session_mutation() {
        let mut session = Session::new();
        session.apply(DocumentCommand::DatasetOpened(make_register("ds1", "test")));
        session.seq = u64::MAX;
        let document_before = serde_json::to_value(&session.document).unwrap();
        let history_before = session.history.len();

        let error = session
            .try_apply_as(
                DocumentCommand::RenameDataset {
                    id: DatasetId("ds1".into()),
                    name: "never-applied".into(),
                },
                "alice@example.com",
                None,
            )
            .unwrap_err();

        assert_eq!(error.category, CommandValidationCategory::ResourceLimit);
        assert_eq!(error.path, "session.seq");
        assert_eq!(session.seq, u64::MAX);
        assert_eq!(session.history.len(), history_before);
        assert_eq!(
            serde_json::to_value(&session.document).unwrap(),
            document_before
        );
    }

    #[test]
    fn durable_publication_is_prevalidated_then_consumed_without_fallible_work() {
        let mut session = Session::new();
        session.apply(DocumentCommand::DatasetOpened(make_register("ds1", "test")));
        let command = DocumentCommand::RenameDataset {
            id: DatasetId("ds1".into()),
            name: "expected".into(),
        };
        let document_before = serde_json::to_value(&session.document).unwrap();
        let seq_before = session.seq;
        let history_before = session.history.len();

        let staged = session
            .stage_durable_document_as(command.clone(), "actor@example.com", None)
            .unwrap();

        assert_eq!(staged.seq(), seq_before + 1);
        assert!(matches!(
            staged.command(),
            DocumentCommand::RenameDataset { id, name }
                if id == &DatasetId("ds1".into()) && name == "expected"
        ));
        assert_eq!(
            staged.document().manifests[&DatasetId("ds1".into())].name,
            "expected"
        );
        assert_eq!(session.seq, seq_before);
        assert_eq!(session.history.len(), history_before);
        assert_eq!(
            serde_json::to_value(&session.document).unwrap(),
            document_before
        );

        session.commit_staged_document(staged);
        assert_eq!(session.seq, seq_before + 1);
        assert_eq!(session.history.len(), history_before + 1);
        assert_eq!(
            session.document.manifests[&DatasetId("ds1".into())].name,
            "expected"
        );
    }

    #[test]
    fn collaborative_inverse_appends_convergent_commands_and_redo_is_inverse_of_inverse() {
        let mut session = Session::new();
        session.apply_as(
            DocumentCommand::DatasetOpened(make_register("ds1", "original")),
            "alice@example.com",
            None,
        );
        let rename_seq = session.apply_as(
            DocumentCommand::RenameDataset {
                id: DatasetId("ds1".into()),
                name: "renamed".into(),
            },
            "alice@example.com",
            None,
        );

        let mut peer = session.document.clone();
        let undo = session
            .prepare_inverse(rename_seq, rename_seq, "ALICE@example.com")
            .expect("authored rename is undoable");
        peer.apply(undo.command.clone());
        let undo_seq = session.apply_as(undo.command, "alice@example.com", Some(undo.inverse_of));

        assert_eq!(undo_seq, rename_seq + 1);
        assert_eq!(
            serde_json::to_value(&peer).unwrap(),
            serde_json::to_value(&session.document).unwrap(),
            "the requester and a peer converge by applying the same broadcast command"
        );
        assert_eq!(session.history.back().unwrap().inverse_of, Some(rename_seq));
        assert_eq!(
            session.document.manifests[&DatasetId("ds1".into())].name,
            "original"
        );

        let redo = session
            .prepare_inverse(undo_seq, undo_seq, "alice@example.com")
            .expect("undo record carries the original command as its inverse");
        assert!(matches!(
            &redo.command,
            DocumentCommand::RenameDataset { name, .. } if name == "renamed"
        ));
        let redo_seq = session.apply_as(redo.command, "alice@example.com", Some(redo.inverse_of));
        assert_eq!(session.history.back().unwrap().inverse_of, Some(undo_seq));
        assert_eq!(redo_seq, undo_seq + 1);
        assert_eq!(
            session.document.manifests[&DatasetId("ds1".into())].name,
            "renamed"
        );
    }

    #[test]
    fn inverse_rechecks_revision_author_and_semantic_target_without_mutation() {
        let mut session = Session::new();
        session.apply_as(
            DocumentCommand::DatasetOpened(make_register("ds1", "original")),
            "alice@example.com",
            None,
        );
        let target = session.apply_as(
            DocumentCommand::RenameDataset {
                id: DatasetId("ds1".into()),
                name: "alice name".into(),
            },
            "alice@example.com",
            None,
        );
        let before = serde_json::to_value(&session.document).unwrap();
        assert_eq!(
            session
                .prepare_inverse(target, target + 1, "alice@example.com")
                .unwrap_err(),
            InverseCommandError::RevisionConflict
        );
        assert_eq!(
            session
                .prepare_inverse(target, target, "bob@example.com")
                .unwrap_err(),
            InverseCommandError::NotAuthor
        );
        assert_eq!(before, serde_json::to_value(&session.document).unwrap());

        session.apply_as(
            DocumentCommand::RenameDataset {
                id: DatasetId("ds1".into()),
                name: "newer name".into(),
            },
            "alice@example.com",
            None,
        );
        let changed = serde_json::to_value(&session.document).unwrap();
        assert_eq!(
            session
                .prepare_inverse(target, target, "alice@example.com")
                .unwrap_err(),
            InverseCommandError::TargetChanged
        );
        assert_eq!(changed, serde_json::to_value(&session.document).unwrap());
    }

    #[test]
    fn inverse_replay_is_rejected_after_the_first_append() {
        let mut session = Session::new();
        session.apply_as(
            DocumentCommand::DatasetOpened(make_register("ds1", "original")),
            "alice@example.com",
            None,
        );
        let target = session.apply_as(
            DocumentCommand::RenameDataset {
                id: DatasetId("ds1".into()),
                name: "renamed".into(),
            },
            "alice@example.com",
            None,
        );
        let undo = session
            .prepare_inverse(target, target, "alice@example.com")
            .unwrap();
        session.apply_as(undo.command, "alice@example.com", Some(undo.inverse_of));
        let after = serde_json::to_value(&session.document).unwrap();
        assert_eq!(
            session
                .prepare_inverse(target, target, "alice@example.com")
                .unwrap_err(),
            InverseCommandError::TargetChanged
        );
        assert_eq!(after, serde_json::to_value(&session.document).unwrap());
    }

    #[test]
    fn semantic_inverse_model_covers_dataset_layout_annotation_and_comment_operations() {
        let mut session = Session::new();
        let dataset_seq = session.apply_as(
            DocumentCommand::DatasetOpened(make_register("ds1", "dataset")),
            "alice@example.com",
            None,
        );
        assert!(matches!(
            session
                .prepare_inverse(dataset_seq, dataset_seq, "alice@example.com")
                .unwrap()
                .command,
            DocumentCommand::RemoveDataset { .. }
        ));

        for layout_id in ["layout-old", "layout-new"] {
            session.apply_as(
                DocumentCommand::RegisterLayout {
                    dataset_id: DatasetId("ds1".into()),
                    layout: LayoutSpec {
                        id: LayoutId(layout_id.into()),
                        name: layout_id.into(),
                        placements: vec![EntityPlacement {
                            entity_id: EntityId("ds1-entity".into()),
                            position: [0.0, 0.0],
                        }],
                    },
                },
                "alice@example.com",
                None,
            );
        }
        session.apply_as(
            DocumentCommand::SetActiveLayout {
                dataset_id: DatasetId("ds1".into()),
                layout_id: LayoutId("layout-old".into()),
            },
            "alice@example.com",
            None,
        );
        let layout_seq = session.apply_as(
            DocumentCommand::SetActiveLayout {
                dataset_id: DatasetId("ds1".into()),
                layout_id: LayoutId("layout-new".into()),
            },
            "alice@example.com",
            None,
        );
        assert!(matches!(
            session
                .prepare_inverse(layout_seq, layout_seq, "alice@example.com")
                .unwrap()
                .command,
            DocumentCommand::SetActiveLayout { layout_id, .. }
                if layout_id == LayoutId("layout-old".into())
        ));

        let annotation_seq = session.apply_as(
            DocumentCommand::AddAnnotation {
                dataset_id: DatasetId("ds1".into()),
                id: "pin".into(),
                position: [1.0, 2.0],
                end: None,
                z: 3.0,
                t: 0,
                c: 0,
                author: "alice@example.com".into(),
                kind: lucida_core::scene::AnnotationKind::Point,
                view: None,
            },
            "alice@example.com",
            None,
        );
        assert!(matches!(
            session
                .prepare_inverse(annotation_seq, annotation_seq, "alice@example.com")
                .unwrap()
                .command,
            DocumentCommand::RemoveAnnotation { .. }
        ));

        let comment_seq = session.apply_as(
            DocumentCommand::AddComment {
                dataset_id: DatasetId("ds1".into()),
                annotation_id: "pin".into(),
                id: "comment".into(),
                author: "alice@example.com".into(),
                text: "first".into(),
            },
            "alice@example.com",
            None,
        );
        assert!(matches!(
            session
                .prepare_inverse(comment_seq, comment_seq, "alice@example.com")
                .unwrap()
                .command,
            DocumentCommand::RemoveComment { .. }
        ));
        let edit_seq = session.apply_as(
            DocumentCommand::EditComment {
                dataset_id: DatasetId("ds1".into()),
                annotation_id: "pin".into(),
                id: "comment".into(),
                text: "second".into(),
            },
            "alice@example.com",
            None,
        );
        assert!(matches!(
            session
                .prepare_inverse(edit_seq, edit_seq, "alice@example.com")
                .unwrap()
                .command,
            DocumentCommand::EditComment { text, .. } if text == "first"
        ));
    }

    #[test]
    fn add_remove_client() {
        let mut session = Session::new();
        session.add_client(1, None);
        session.add_client(2, None);
        assert_eq!(session.clients.len(), 2);
        session.remove_client(1);
        assert_eq!(session.clients.len(), 1);
        assert!(session.clients.contains_key(&2));
    }

    #[test]
    fn add_client_attaches_identity_to_presence_and_snapshot() {
        // #540: a workspace client connects with a server-authored identity.
        // It rides on the returned presence (broadcast as PeerJoined) AND on
        // the snapshot peer list a late joiner receives.
        let mut session = Session::new();
        let identity = PeerIdentity {
            display_name: "Grace Hopper".into(),
            picture_url: Some("https://example.com/grace.png".into()),
            initial: "G".into(),
        };
        let presence = session.add_client(7, Some(identity.clone()));
        // Returned presence (the PeerJoined payload) carries identity.
        assert_eq!(presence.identity.as_ref(), Some(&identity));

        // And a fresh snapshot's peer list carries it too (late-joiner path).
        match session.snapshot(99) {
            ServerMessage::Snapshot { peers, .. } => {
                let peer = peers
                    .iter()
                    .find(|p| p.client_id == 7)
                    .expect("client 7 in snapshot");
                let got = peer.identity.as_ref().expect("identity on snapshot peer");
                assert_eq!(got.display_name, "Grace Hopper");
                assert_eq!(
                    got.picture_url.as_deref(),
                    Some("https://example.com/grace.png")
                );
            }
            _ => panic!("expected Snapshot"),
        }
    }

    #[test]
    fn add_client_without_identity_leaves_presence_anonymous() {
        // Old snapshots and minimal fixtures can omit identity; the presence
        // still has the numeric client id as a rendering fallback.
        let mut session = Session::new();
        let presence = session.add_client(3, None);
        assert_eq!(presence.identity, None);
        assert!(session.clients.get(&3).unwrap().identity.is_none());
    }

    #[test]
    fn follow_and_disconnect_clears_followers() {
        let mut session = Session::new();
        session.add_client(1, None);
        session.add_client(2, None);
        session.add_client(3, None);
        // 2 follows 1, 3 follows 1
        session.set_follow(2, Some(1));
        session.set_follow(3, Some(1));
        // 1 disconnects → 2 and 3 should stop following
        let affected = session.remove_client(1);
        assert_eq!(affected.len(), 2);
        assert_eq!(session.clients.get(&2).unwrap().following, None);
        assert_eq!(session.clients.get(&3).unwrap().following, None);
    }

    #[test]
    fn follow_transitive_chain() {
        let mut session = Session::new();
        session.add_client(1, None); // A
        session.add_client(2, None); // B
        session.add_client(3, None); // C
        // A follows C
        session.set_follow(1, Some(3));
        assert_eq!(session.clients.get(&1).unwrap().following, Some(3));
        // C starts following B → A should be redirected to B
        let changes = session.set_follow(3, Some(2));
        assert!(changes.iter().any(|&(cid, t)| cid == 1 && t == Some(2)));
        assert_eq!(session.clients.get(&1).unwrap().following, Some(2));
        assert_eq!(session.clients.get(&3).unwrap().following, Some(2));
    }

    #[test]
    fn cannot_follow_someone_who_is_following() {
        let mut session = Session::new();
        session.add_client(1, None);
        session.add_client(2, None);
        session.add_client(3, None);
        // 2 follows 1
        session.set_follow(2, Some(1));
        // 3 tries to follow 2 (who is following 1) → should fail
        let changes = session.set_follow(3, Some(2));
        assert!(changes.is_empty());
        assert_eq!(session.clients.get(&3).unwrap().following, None);
    }
}
