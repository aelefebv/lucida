//! Headless dataset-open orchestration.
//!
//! Owns the full open-a-dataset use case: URL normalization, workspace
//! authorization, persisted-source lookup, dedup / concurrent-open race
//! handling, storage-backend probe, metadata import, binding + derived
//! service construction, document apply, workspace persistence, and the
//! result broadcast. The module contains **zero websocket types**:
//! per-stage diagnostics flow out through a [`ProgressSink`] channel and
//! the terminal result is a typed [`DatasetOpenOutcome`], so the
//! orchestration can be driven (and tested) by any caller — the
//! websocket adapter in [`crate::handler`] is one thin transport over it.
//!
//! Failure classification lives in [`crate::open_diagnostics`] and the
//! wake-time counterpart of this path (rebuilding bindings for a lazily
//! reopened workspace) in [`crate::binding_restore`]; both leaf modules
//! sit below this one so the two paths share one diagnostic vocabulary
//! without this module ever being imported by the workspace layer.

use std::sync::Arc;

use lucida_content::DatasetId;
use lucida_content::url::SourceVersion;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientId, ServerMessage};
use lucida_protocol::{
    DatasetOpenFailureDiagnostic, DatasetOpenFailureKind, DatasetOpenProgressDiagnostic,
    DatasetOpenStage, DatasetOpenSuccessDiagnostic, DatasetOpened, GeneratedAvailabilityDelta,
    OpenedDatasetSummary,
};
use lucida_store::cache::CachedStore;
use tokio::sync::{Mutex, OwnedRwLockReadGuard, mpsc};

use crate::binding::{ChunkResolver, ServerBinding};
use crate::generated_coarse::{
    DerivedChunkCache, GeneratedCoarseConfig, GeneratedCoarseService, GeneratedSchedulingConfig,
    plan_generated_coarse_for_source,
};
use crate::open_diagnostics::{
    backend_kind_for_url, backend_open_failure, dataset_opened_validation_failure, import_failure,
    open_failure, open_progress, open_success, open_warning, source_policy_failure,
};
use crate::outbox::{
    DEFAULT_OUTBOX_BYTES, PreparedJsonError, PreparedUnicast, ReservedUnicastSlot, UnicastSender,
};
use crate::session::Session;
use crate::workspace::{LiveWorkspace, WorkspaceManager};
use crate::{BroadcastEvent, BroadcastSender, DatasetRuntimeConfig};

// Source identity is derived by the admission policy's typed
// `SourceIdentity`. Imports additionally derive a `SourceRevision`; the pair
// is the generation boundary for bindings, documents, and caches. See
// ADR-0042 and the dataset-opening flow.

/// The workspace scope a connection acts under: the live runtime handles,
/// the [`WorkspaceManager`] that owns authorization and persistence, and
/// the authenticated principal.
#[derive(Clone)]
pub struct WorkspaceScope {
    pub live: Arc<LiveWorkspace>,
    pub manager: Arc<WorkspaceManager>,
    pub principal: AuthPrincipal,
}

/// Everything a dataset open runs against: the shared session + broadcast
/// hub it mutates, the proxy/generated configuration for the binding it
/// builds, and the workspace scope that authorizes and persists the open.
#[derive(Clone)]
pub struct DatasetOpenContext {
    pub session: Arc<Mutex<Session>>,
    pub tx: BroadcastSender,
    pub dataset_runtime: DatasetRuntimeConfig,
    pub workspace: WorkspaceScope,
    /// Optional requester-only terminal lane. WebSocket opens provide this so
    /// the full success envelope is reserved before persistence and published
    /// atomically with the live command; headless callers leave it absent.
    pub(crate) terminal: Option<DatasetOpenTerminal>,
    #[cfg(test)]
    pub(crate) publication_barrier: Option<DatasetOpenPublicationBarrier>,
    /// Test-only pause after the durable write returns but before the
    /// synchronous live commit/publish region. The work is already owned by
    /// a detached child at this point, so aborting its requester must not
    /// split durable state from the live session.
    #[cfg(test)]
    pub(crate) post_persist_barrier: Option<DatasetOpenPostPersistBarrier>,
    /// Test-only panic injection after both publications are prepared but
    /// before persistence starts. This exercises JoinError cleanup of the
    /// shared terminal-slot lease.
    #[cfg(test)]
    pub(crate) panic_commit_task: bool,
}

#[derive(Clone)]
pub(crate) struct DatasetOpenTerminal {
    pub(crate) request_id: String,
    pub(crate) sender: UnicastSender,
    slot: ReservedUnicastSlot,
}

impl DatasetOpenTerminal {
    pub(crate) fn new(
        request_id: String,
        sender: UnicastSender,
        slot: ReservedUnicastSlot,
    ) -> Self {
        Self {
            request_id,
            sender,
            slot,
        }
    }

    pub(crate) fn prepare_json<T>(
        &self,
        value: &T,
        limit: usize,
    ) -> Result<PreparedUnicast, PreparedJsonError>
    where
        T: serde::Serialize + ?Sized,
    {
        self.sender.prepare_json_in_slot(&self.slot, value, limit)
    }

    pub(crate) fn publish_json<T>(&self, value: &T, limit: usize) -> Result<(), PreparedJsonError>
    where
        T: serde::Serialize + ?Sized,
    {
        match self.prepare_json(value, limit) {
            Ok(prepared) => prepared.publish().map_err(PreparedJsonError::from),
            Err(error) => {
                // An authoritative result may never disappear behind process
                // pressure. If the exact reserved-slot terminal cannot be
                // prepared, force this requester down the bounded overload
                // close/hard-drop path instead of returning it to an open
                // socket with no terminal.
                self.sender.force_overload_close();
                Err(error)
            }
        }
    }
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct DatasetOpenPublicationBarrier {
    entered: Arc<tokio::sync::Semaphore>,
    release: Arc<tokio::sync::Semaphore>,
    service: Arc<std::sync::Mutex<Option<Arc<GeneratedCoarseService>>>>,
}

#[cfg(test)]
impl DatasetOpenPublicationBarrier {
    fn new() -> Self {
        Self {
            entered: Arc::new(tokio::sync::Semaphore::new(0)),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
            service: Arc::new(std::sync::Mutex::new(None)),
        }
    }
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct DatasetOpenPostPersistBarrier {
    entered: Arc<tokio::sync::Semaphore>,
    release: Arc<tokio::sync::Semaphore>,
}

#[cfg(test)]
impl DatasetOpenPostPersistBarrier {
    fn new() -> Self {
        Self {
            entered: Arc::new(tokio::sync::Semaphore::new(0)),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
        }
    }
}

/// Ordered sink for per-stage diagnostics. WebSocket callers synchronously
/// enqueue progress onto the same priority lane as their terminal result, so
/// success cannot overtake queued progress and no late progress can resurrect
/// a completed request. Headless/tests can keep using an unbounded channel.
pub trait ProgressSink: Send + Sync {
    fn emit(&self, diagnostic: DatasetOpenProgressDiagnostic);
}

impl ProgressSink for mpsc::UnboundedSender<DatasetOpenProgressDiagnostic> {
    fn emit(&self, diagnostic: DatasetOpenProgressDiagnostic) {
        let _ = self.send(diagnostic);
    }
}

pub(crate) struct DatasetOpenProgressSender {
    request_id: String,
    url: String,
    sender: UnicastSender,
}

impl DatasetOpenProgressSender {
    pub(crate) fn new(request_id: String, url: String, sender: UnicastSender) -> Self {
        Self {
            request_id,
            url,
            sender,
        }
    }
}

impl ProgressSink for DatasetOpenProgressSender {
    fn emit(&self, diagnostic: DatasetOpenProgressDiagnostic) {
        let message = ServerMessage::DatasetOpenProgress {
            request_id: self.request_id.clone(),
            url: self.url.clone(),
            diagnostic,
        };
        let _ = self
            .sender
            .send_json_best_effort(&message, DEFAULT_OUTBOX_BYTES);
    }
}

/// Terminal result of an open that did not fail with a diagnostic.
#[derive(Debug)]
pub enum DatasetOpenOutcome {
    /// The dataset is live in the session (freshly imported or joined via
    /// dedup) and the `DatasetOpened` broadcast has been sent.
    Opened {
        seq: u64,
        opened: Box<DatasetOpened>,
        diagnostic: DatasetOpenSuccessDiagnostic,
        /// True when the requester terminal was already published from the
        /// prepared priority-lane capability at the durable commit boundary.
        terminal_precommitted: bool,
    },
    /// The workspace runtime shut down after the import completed; the
    /// open is abandoned with no further caller-visible outcome.
    Cancelled,
}

fn emit(progress: &dyn ProgressSink, diagnostic: DatasetOpenProgressDiagnostic) {
    progress.emit(diagnostic);
}

/// Open a dataset URL into the session: probe the storage backend, import
/// the OME-Zarr metadata, build the server binding, apply + broadcast
/// `DatasetOpened`, and (in a workspace) persist the membership.
///
/// The incoming `url` is admitted once by the process-wide source policy;
/// every downstream derivation (source identity, cache identity, backend,
/// binding source, and display-name extraction) uses that canonical admitted
/// form. Workspace clients receive an opaque workspace-local
/// `DatasetId`; the source-derived id is retained only for membership
/// dedupe and shared source/cache routing. This makes spelling variants
/// of the same path dedup to one source — see
/// `wiki/decisions/0042-canonical-dataset-url-form.md` for the rationale.
///
/// Concurrent opens of the same source generation are safe: metadata is
/// imported before reuse is decided, then the apply step re-checks under the
/// session lock so a lost race drops its duplicate binding. Import-before-
/// reuse is intentional: a locator may mutate in place.
#[tracing::instrument(
    name = "dataset_open",
    skip(url, ctx, progress),
    fields(source = tracing::field::Empty, client_id = %opener)
)]
pub async fn open_dataset(
    opener: ClientId,
    url: &str,
    ctx: &DatasetOpenContext,
    progress: &dyn ProgressSink,
) -> Result<DatasetOpenOutcome, DatasetOpenFailureDiagnostic> {
    open_dataset_inner(opener, url, ctx, progress, None).await
}

/// Connection-scoped entry point that transfers an already-admitted access
/// lease into the cancellation-shielded commit child. The permit is acquired
/// before request work starts; it must never be reacquired after revocation.
pub(crate) async fn open_dataset_with_operation_permit(
    opener: ClientId,
    url: &str,
    ctx: &DatasetOpenContext,
    progress: &dyn ProgressSink,
    operation_permit: OwnedRwLockReadGuard<()>,
) -> Result<DatasetOpenOutcome, DatasetOpenFailureDiagnostic> {
    open_dataset_inner(opener, url, ctx, progress, Some(operation_permit)).await
}

async fn open_dataset_inner(
    opener: ClientId,
    url: &str,
    ctx: &DatasetOpenContext,
    progress: &dyn ProgressSink,
    operation_permit: Option<OwnedRwLockReadGuard<()>>,
) -> Result<DatasetOpenOutcome, DatasetOpenFailureDiagnostic> {
    // Do not attach a caller-controlled locator to traces. This pre-admission
    // form is deliberately lossy and is replaced with the admitted source's
    // equally safe representation once DNS/path checks complete.
    let mut redacted_source = ctx.dataset_runtime.source_policy.redact_untrusted(url);
    tracing::Span::current().record("source", redacted_source.as_str());
    emit(
        progress,
        open_progress(
            DatasetOpenStage::RequestReceived,
            "dataset open request received",
            None,
            None,
            Some(format!("source: {redacted_source}")),
        ),
    );

    let scope = &ctx.workspace;
    if scope.live.background_cancelled() {
        tracing::info!(
            client_id = %opener,
            workspace_id = %scope.live.workspace_id,
            source = %redacted_source,
            "open_remote_dataset.cancelled_workspace_runtime"
        );
        return Err(open_failure(
            DatasetOpenStage::Authorization,
            DatasetOpenFailureKind::SessionClosed,
            true,
            "workspace runtime is closed",
            None,
        ));
    }

    emit(
        progress,
        open_progress(
            DatasetOpenStage::Authorization,
            "checking workspace permission",
            None,
            None,
            Some(format!("workspace: {}", scope.live.workspace_id)),
        ),
    );

    if let Err(e) = scope
        .manager
        .require_editor(&scope.live.workspace_id, &scope.principal)
        .await
    {
        tracing::warn!(
            client_id = %opener,
            workspace_id = %scope.live.workspace_id,
            source = %redacted_source,
            error = %e,
            "open_remote_dataset.forbidden"
        );
        return Err(open_failure(
            DatasetOpenStage::Authorization,
            DatasetOpenFailureKind::Authorization,
            false,
            "workspace role cannot add datasets",
            Some(e.to_string()),
        ));
    }

    emit(
        progress,
        open_progress(
            DatasetOpenStage::Authorization,
            "workspace permission accepted",
            None,
            None,
            Some(format!("workspace: {}", scope.live.workspace_id)),
        ),
    );

    // This is the single I/O admission boundary. Local roots are resolved and
    // contained; HTTP DNS is validated and pinned; cloud scopes require an
    // explicit bucket plus explicit ambient-credential opt-in.
    let admitted = ctx
        .dataset_runtime
        .source_policy
        .admit(url)
        .await
        .map_err(|error| source_policy_failure(&error))?;
    let canonical_url = admitted.canonical_url().to_string();
    redacted_source = admitted.redacted().to_string();
    tracing::Span::current().record("source", redacted_source.as_str());

    // Stable, collision-resistant source identity derives from the admitted
    // canonical locator, not from caller spelling. Workspace document state
    // still receives its independent opaque workspace-local ID.
    let dataset_source_id = admitted.identity.dataset_id();

    emit(
        progress,
        open_progress(
            DatasetOpenStage::SourceLookup,
            "checking persisted workspace dataset source",
            None,
            Some(dataset_source_id.clone()),
            Some(format!("workspace: {}", scope.live.workspace_id)),
        ),
    );
    let existing_workspace_source = match scope
        .manager
        .dataset_by_source(&scope.live.workspace_id, &admitted.identity)
        .await
    {
        Ok(source) => source,
        Err(e) => {
            tracing::error!(
                client_id = %opener,
                workspace_id = %scope.live.workspace_id,
                dataset_source_id = %dataset_source_id,
                source = %redacted_source,
                error = %e,
                "open_remote_dataset.source_lookup_failed"
            );
            return Err(open_failure(
                DatasetOpenStage::SourceLookup,
                DatasetOpenFailureKind::WorkspaceLookup,
                true,
                "workspace dataset lookup failed",
                Some(e.to_string()),
            ));
        }
    };

    let dataset_id_key = existing_workspace_source
        .as_ref()
        .map(|source| source.workspace_dataset_id.clone())
        .unwrap_or_else(new_workspace_dataset_id);
    let dataset_id = dataset_id_key.0.clone();
    emit(
        progress,
        open_progress(
            DatasetOpenStage::SourceLookup,
            "workspace dataset source resolved",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            existing_workspace_source
                .as_ref()
                .map(|source| format!("display name: {}", source.display_name)),
        ),
    );

    // Open through the admitted capability. HTTP uses the exact DNS answers
    // checked above and has redirects/proxies disabled, so there is no second
    // URL interpretation or post-check target pivot.
    emit(
        progress,
        open_progress(
            DatasetOpenStage::BackendOpen,
            "opening dataset storage backend",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!("backend: {}", backend_kind_for_url(&canonical_url))),
        ),
    );
    let store = match admitted.open_backend() {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "open_remote_dataset.backend_open_failed");
            return Err(backend_open_failure(&e));
        }
    };

    // Extract dataset name from URL (last path component). Canonical
    // form is always forward-slash, so a single `rsplit('/')` works for
    // every platform.
    let name = existing_workspace_source
        .as_ref()
        .map(|source| source.display_name.clone())
        .unwrap_or_else(|| {
            canonical_url
                .rsplit('/')
                .find(|s| !s.is_empty())
                .unwrap_or("dataset")
                .to_string()
        });

    // Import dataset via the new pipeline.
    emit(
        progress,
        open_progress(
            DatasetOpenStage::MetadataImport,
            "importing OME-Zarr metadata",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!("name: {name}")),
        ),
    );
    tracing::info!(
        source = %redacted_source,
        id = %dataset_id,
        dataset_source_id = %dataset_source_id,
        name = %name,
        "importing dataset"
    );
    let result = match lucida_store::import::import_dataset_with_shared_cache(
        &store,
        &dataset_id,
        &name,
        Arc::clone(&ctx.dataset_runtime.source_cache),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "open_remote_dataset.import_failed");
            return Err(import_failure(&e));
        }
    };

    if scope.live.background_cancelled() {
        tracing::info!(
            client_id = %opener,
            workspace_id = %scope.live.workspace_id,
            dataset_id = %dataset_id,
            dataset_source_id = %dataset_source_id,
            "open_remote_dataset.cancelled_after_import"
        );
        return Ok(DatasetOpenOutcome::Cancelled);
    }

    let source = SourceVersion::new(admitted.identity.clone(), result.source_revision);

    // Reuse is safe only after a fresh metadata import proves that the
    // locator still exposes the same generation. This preserves idempotent
    // opens without turning a mutable locator into a stale-content alias.
    {
        let sess = ctx.session.lock().await;
        if let Some((existing_dataset_id, mut existing)) =
            find_loaded_binding(&sess, &dataset_id_key, &source)
        {
            if let Some(doc_manifest) = sess.document.manifests.get(&existing_dataset_id) {
                existing.manifest = doc_manifest.clone();
            }
            existing.opener_client_id = Some(opener);
            let seq = sess.seq;
            drop(sess);
            let command = DocumentCommand::DatasetOpened(existing.clone());
            let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };
            let _ = ctx.tx.send(BroadcastEvent::command(
                // The requester receives the compatibility success envelope
                // carrying this full payload exactly once. Peers receive the
                // authoritative sequenced command.
                Some(opener),
                broadcast_msg,
                None,
            ));
            emit(
                progress,
                open_progress(
                    DatasetOpenStage::BindingBuild,
                    "reusing existing server binding",
                    Some(existing_dataset_id.clone()),
                    Some(dataset_source_id.clone()),
                    Some(format!("seq: {seq}")),
                ),
            );
            let diagnostic =
                open_success(&canonical_url, &existing, Some(dataset_source_id.clone()));
            return Ok(DatasetOpenOutcome::Opened {
                seq,
                opened: Box::new(existing),
                diagnostic,
                terminal_precommitted: false,
            });
        }
    }

    // Log import result summary.
    let n_entities = result.manifest.entities().len();
    let n_images = result.manifest.images().len();
    let n_levels = result
        .manifest
        .images()
        .first()
        .map(|i| i.multiscale.levels.len())
        .unwrap_or(0);
    tracing::info!(
        id = %dataset_id,
        kind = ?result.manifest.kind,
        entities = n_entities,
        images = n_images,
        levels = n_levels,
        binding_images = result.binding_seed.images.len(),
        "import complete"
    );
    emit(
        progress,
        open_progress(
            DatasetOpenStage::MetadataImport,
            "metadata import complete",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!(
                "entities: {n_entities}, images: {n_images}, first image levels: {n_levels}"
            )),
        ),
    );

    // Surface non-fatal import problems (e.g. skipped collection groups) on the open
    // trail so both the CLI and the web's latest-message view see them, and
    // retain them for the durable Health tab below.
    let import_warnings: Vec<String> = result.warnings.iter().map(|w| w.message.clone()).collect();
    for warning in &result.warnings {
        tracing::warn!(
            id = %dataset_id,
            target = %warning.target,
            "dataset import warning: {}",
            warning.message,
        );
        emit(
            progress,
            open_warning(
                DatasetOpenStage::MetadataImport,
                warning.message.clone(),
                Some(dataset_id_key.clone()),
                Some(dataset_source_id.clone()),
                Some(format!("target: {}", warning.target)),
            ),
        );
    }

    // Build operational binding.
    emit(
        progress,
        open_progress(
            DatasetOpenStage::BindingBuild,
            "building server chunk binding",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!(
                "binding images: {}",
                result.binding_seed.images.len()
            )),
        ),
    );
    let dataset_runtime = &ctx.dataset_runtime;
    let cached = Arc::new(CachedStore::with_source_version(
        store.clone(),
        &source,
        Arc::clone(&dataset_runtime.source_cache),
    ));
    let resolver = Arc::new(ChunkResolver::new(&result.binding_seed));
    let generated_config = GeneratedCoarseConfig {
        target_long_axis: dataset_runtime.generated_target_long_axis,
        chunk_long_axis: dataset_runtime.generated_chunk_long_axis,
        max_chunk_bytes: dataset_runtime.generated_max_chunk_bytes,
    };
    emit(
        progress,
        open_progress(
            DatasetOpenStage::GeneratedCoarsePlanning,
            if dataset_runtime.generated_enabled {
                "planning generated coarse levels"
            } else {
                "generated coarse planning disabled"
            },
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            None,
        ),
    );
    let generated_plans = if dataset_runtime.generated_enabled {
        plan_generated_coarse_for_source(&result.manifest, result.source_revision, generated_config)
    } else {
        vec![]
    };
    emit(
        progress,
        open_progress(
            DatasetOpenStage::GeneratedCoarsePlanning,
            "generated coarse planning complete",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            Some(format!("planned levels: {}", generated_plans.len())),
        ),
    );

    let dataset_opened = DatasetOpened {
        manifest: result.manifest.clone(),
        fetch: result.fetch,
        // Stamp the requesting client so the broadcast's recipients can tell
        // whether they are the opener; only the opener auto-fits its camera.
        opener_client_id: Some(opener),
    };
    // Treat the manifest plus its fetch contract as one admission unit before
    // any binding, persistence, generated-cache registration, or broadcast.
    dataset_opened
        .validate()
        .map_err(|error| dataset_opened_validation_failure(&error))?;

    // Disk caches share the same full locator + revision scope as source
    // memory. Old generations may coexist on disk, but can never be addressed
    // by a binding for the current generation.
    let derived_chunks = Arc::new(
        DerivedChunkCache::new_on_disk_for_source_with_status_budget(
            dataset_runtime.generated_cache_dir.clone(),
            &source,
            dataset_runtime.generated_disk_budget_bytes,
            Arc::clone(&dataset_runtime.source_cache),
            ctx.workspace.manager.generated_status_budget(),
        ),
    );
    let mut generated_initial_delta = GeneratedAvailabilityDelta::default();
    for plan in &generated_plans {
        match derived_chunks.register_generated_plan(plan) {
            Ok(delta) => {
                generated_initial_delta.levels.extend(delta.levels);
                generated_initial_delta.chunks.extend(delta.chunks);
            }
            Err(e) => {
                tracing::warn!(
                    dataset_id = %dataset_id,
                    image = %plan.image_id.0,
                    error = %e,
                    "generated coarse derived-cache registration failed"
                );
                let retained = derived_chunks.upsert_level(plan.availability.clone());
                generated_initial_delta.levels.extend(retained.levels);
            }
        }
    }
    let generated_manifest = Arc::new(result.manifest.clone());
    let generated_store = cached.clone();
    let generated_resolver = resolver.clone();
    let generated_service = Arc::new(GeneratedCoarseService::new(
        generated_plans.clone(),
        generated_manifest,
        generated_store,
        generated_resolver,
        derived_chunks.clone(),
        ctx.session.clone(),
        ctx.tx.clone(),
        GeneratedSchedulingConfig {
            concurrency: dataset_runtime.generated_concurrency,
            background_chunk_limit: dataset_runtime.generated_background_chunk_limit,
            ..GeneratedSchedulingConfig::default()
        },
    ));
    let binding = ServerBinding {
        source: source.clone(),
        store: store.clone(),
        resolver,
        cache: cached,
        dataset_opened: dataset_opened.clone(),
        derived_chunks: derived_chunks.clone(),
        generated_service: generated_service.clone(),
        import_warnings,
    };

    #[cfg(test)]
    if let Some(barrier) = &ctx.publication_barrier {
        *barrier.service.lock().expect("publication barrier service") =
            Some(Arc::clone(&generated_service));
        barrier.entered.add_permits(1);
        let _ = barrier.release.acquire().await;
    }

    // Build DatasetOpened command (manifest + fetch, no server-private state).
    let command = DocumentCommand::DatasetOpened(dataset_opened);

    // Apply command and register server binding. Re-check the binding
    // presence under the lock in case a concurrent open raced ahead.
    emit(
        progress,
        open_progress(
            DatasetOpenStage::WorkspacePersist,
            "persisting workspace dataset membership",
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            None,
        ),
    );

    let seq = {
        let mut sess = Arc::clone(&ctx.session).lock_owned().await;
        if scope.live.background_cancelled() {
            generated_service
                .shutdown("workspace runtime closed during dataset open")
                .await;
            return Ok(DatasetOpenOutcome::Cancelled);
        }
        if let Some((existing_dataset_id, mut existing)) =
            find_loaded_binding(&sess, &dataset_id_key, &source)
        {
            // Lost the race: another open completed the import. Drop our
            // duplicate binding/command and rebroadcast the canonical one.
            // Re-stamp the opener with the CURRENT requester: the binding's
            // stored copy holds whoever first opened it (or None for a
            // server-side restore), but the client that just requested this
            // open is the one whose camera should auto-fit when the
            // rebroadcast reaches it.
            existing.opener_client_id = Some(opener);
            let seq = sess.seq;
            drop(sess);
            let broadcast_msg = ServerMessage::CommandBroadcast {
                seq,
                command: DocumentCommand::DatasetOpened(existing),
            };
            let opened = match &broadcast_msg {
                ServerMessage::CommandBroadcast {
                    command: DocumentCommand::DatasetOpened(opened),
                    ..
                } => opened.clone(),
                _ => unreachable!("constructed above"),
            };
            emit(
                progress,
                open_progress(
                    DatasetOpenStage::BindingBuild,
                    "reusing binding from concurrent dataset open",
                    Some(existing_dataset_id.clone()),
                    Some(dataset_source_id.clone()),
                    None,
                ),
            );
            emit(
                progress,
                open_progress(
                    DatasetOpenStage::Broadcast,
                    "broadcasting existing dataset to workspace clients",
                    Some(existing_dataset_id.clone()),
                    Some(dataset_source_id.clone()),
                    Some(format!("seq: {seq}")),
                ),
            );
            let _ = ctx
                .tx
                .send(BroadcastEvent::command(Some(opener), broadcast_msg, None));
            tracing::info!(
                dataset_id = %existing_dataset_id,
                dataset_source_id = %dataset_source_id,
                "open_remote_dataset.lost_race"
            );
            let diagnostic = open_success(&canonical_url, &opened, Some(dataset_source_id.clone()));
            return Ok(DatasetOpenOutcome::Opened {
                seq,
                opened: Box::new(opened),
                diagnostic,
                terminal_precommitted: false,
            });
        }

        let author = scope.principal.email.as_str();
        let staged = sess
            .stage_durable_document_as(command.clone(), author, None)
            .map_err(|error| {
                open_failure(
                    DatasetOpenStage::WorkspacePersist,
                    DatasetOpenFailureKind::Import,
                    false,
                    "dataset exceeds collaborative document limits",
                    Some(error.to_string()),
                )
            })?;
        let seq = staged.seq();
        // Reserve the shared broadcast before consuming the requester's
        // admission-time terminal slot. If broadcast admission fails, the
        // slot remains available for the smaller failure terminal.
        let publish = ctx
            .tx
            .prepare(BroadcastEvent::command(
                Some(opener),
                ServerMessage::CommandBroadcast {
                    seq,
                    command: command.clone(),
                },
                None,
            ))
            .map_err(|error| {
                open_failure(
                    DatasetOpenStage::Broadcast,
                    DatasetOpenFailureKind::ResourceLimit,
                    true,
                    "outbound process capacity is temporarily full",
                    Some(error.to_string()),
                )
            })?;
        let terminal = if let Some(terminal) = &ctx.terminal {
            let opened = match &command {
                DocumentCommand::DatasetOpened(opened) => opened.clone(),
                _ => unreachable!("dataset open command must be DatasetOpened"),
            };
            let diagnostic = open_success(&canonical_url, &opened, Some(dataset_source_id.clone()));
            let summary = OpenedDatasetSummary {
                workspace_dataset_id: opened.manifest.dataset_id.clone(),
                name: opened.manifest.name.clone(),
                image_count: opened.manifest.images().len(),
                entity_count: opened.manifest.entities().len(),
            };
            let message = ServerMessage::OpenDatasetSucceeded {
                request_id: terminal.request_id.clone(),
                url: canonical_url.clone(),
                seq,
                summary: Some(summary),
                opened: Some(opened),
                diagnostic: Some(diagnostic),
            };
            Some(
                terminal
                    .prepare_json(&message, DEFAULT_OUTBOX_BYTES)
                    .map_err(|error| {
                        open_failure(
                            DatasetOpenStage::Broadcast,
                            DatasetOpenFailureKind::ResourceLimit,
                            true,
                            "requester outcome exceeds outbound capacity",
                            Some(error.to_string()),
                        )
                    })?,
            )
        } else {
            None
        };

        // The caller owns the import work up to this point. Once persistence
        // begins, an owned child owns the session guard and both outbound
        // capabilities through the synchronous live commit/publication
        // boundary. Dropping the JoinHandle detaches this work, so a socket
        // disconnect cannot cancel it after SQL reports a committed write.
        let manager = Arc::clone(&scope.manager);
        let live = Arc::clone(&scope.live);
        let principal = scope.principal.clone();
        let persist_dataset_id = dataset_id_key.clone();
        let persist_source = source.clone();
        let persist_name = name.clone();
        let publish_dataset_id = dataset_id_key.clone();
        let publish_dataset_source_id = dataset_source_id.clone();
        let publish_canonical_url = canonical_url.clone();
        let publish_dataset_name = name.clone();
        let source_cache = Arc::clone(&dataset_runtime.source_cache);
        let tx = ctx.tx.clone();
        let indeterminate_terminal_sender = ctx
            .terminal
            .as_ref()
            .map(|terminal| terminal.sender.clone());
        let logged_dataset_id = dataset_id.clone();
        #[cfg(test)]
        let post_persist_barrier = ctx.post_persist_barrier.clone();
        #[cfg(test)]
        let panic_commit_task = ctx.panic_commit_task;

        let commit_task = tokio::spawn(async move {
            #[cfg(test)]
            assert!(
                !panic_commit_task,
                "injected dataset-open commit task panic"
            );

            // Transfer the exact read guard admitted before this request
            // started. Revocation marks the lease and waits on its write
            // side, so it cannot return while this accepted durable/live
            // mutation or its required derived publication is unfinished.
            let _operation_permit = operation_permit;
            if let Err(error) = manager
                .persist_dataset_opened(
                    &live,
                    &persist_dataset_id,
                    &persist_source,
                    &persist_name,
                    &principal,
                    seq,
                    staged.document(),
                )
                .await
            {
                let indeterminate = matches!(
                    &error,
                    crate::workspace::WorkspaceError::PersistenceIndeterminate(_)
                );
                if indeterminate && let Some(sender) = indeterminate_terminal_sender {
                    // Durable read-back could not prove non-commit. Close the
                    // requester instead of publishing a retryable failure for
                    // a dataset open that may already be durable. Dropping the
                    // prepared success below releases its exact reservations.
                    sender.force_overload_close();
                }
                tracing::error!(
                    client_id = %opener,
                    workspace_id = %live.workspace_id,
                    dataset_id = %logged_dataset_id,
                    dataset_source_id = %publish_dataset_source_id,
                    error = %error,
                    "open_remote_dataset.persist_failed"
                );
                return Err(open_failure(
                    DatasetOpenStage::WorkspacePersist,
                    DatasetOpenFailureKind::Persistence,
                    !indeterminate,
                    if indeterminate {
                        "workspace closed while durable state is reconciled"
                    } else {
                        "workspace persistence failed"
                    },
                    Some(error.to_string()),
                ));
            }

            #[cfg(test)]
            if let Some(barrier) = post_persist_barrier {
                barrier.entered.add_permits(1);
                let _ = barrier.release.acquire().await;
            }

            // From the instant the durable write reports success until the
            // live mutation and both prepared publications are consumed,
            // this region is synchronous and infallible.
            let replacing_generation = sess.server_bindings.contains_key(&publish_dataset_id);
            if replacing_generation {
                // Release the old generation's aggregate status permits
                // before retrying admission for the replacement. The session
                // lock is the publication fence for stale workers.
                sess.server_bindings[&publish_dataset_id]
                    .derived_chunks
                    .clear_runtime_statuses();
                for plan in &generated_plans {
                    if derived_chunks.register_generated_plan(plan).is_err() {
                        derived_chunks.upsert_level(plan.availability.clone());
                    }
                }
                let refreshed = derived_chunks.snapshot();
                generated_initial_delta = GeneratedAvailabilityDelta {
                    levels: refreshed.levels,
                    chunks: refreshed.chunks,
                };
            }
            sess.commit_staged_document(staged);
            if replacing_generation {
                sess.generated_availability.remove(&publish_dataset_id);
            }
            if !generated_initial_delta.levels.is_empty() {
                sess.apply_generated_availability_delta(
                    publish_dataset_id.clone(),
                    generated_initial_delta.clone(),
                );
            }
            sess.record_binding_source(
                publish_dataset_id.clone(),
                publish_canonical_url,
                Some(publish_dataset_source_id.clone()),
                publish_dataset_name,
            );
            sess.clear_binding_restore_failure(&publish_dataset_id);
            let replaced = sess.server_bindings.insert(publish_dataset_id, binding);
            publish.publish();
            if let Some(terminal) = terminal {
                let _ = terminal.publish();
            }
            drop(sess);

            // Derived availability is subordinate to the durable command but
            // still belongs to the shielded child so a requester disconnect
            // cannot suppress post-commit operational state.
            if !generated_initial_delta.levels.is_empty() {
                let msg = ServerMessage::GeneratedAvailabilityUpdate {
                    dataset_id: DatasetId(logged_dataset_id.clone()),
                    delta: generated_initial_delta,
                };
                let _ = tx.send(BroadcastEvent::generated_availability(msg));
            }

            // Quiescing a superseded generator is cleanup, not part of the
            // durable boundary. Generation identity already fences stale
            // session updates after the binding swap.
            let replacement_cleanup = replaced.map(|binding| {
                tokio::spawn(async move {
                    binding
                        .generated_service
                        .shutdown("source revision replaced")
                        .await;
                    binding.derived_chunks.clear_runtime_statuses();
                })
            });

            if live.background_cancelled() {
                generated_service
                    .shutdown("workspace runtime closed during dataset open")
                    .await;
            } else {
                generated_service.start();
            }
            if replacement_cleanup.is_some() {
                source_cache.invalidate_source(&persist_source.identity);
            }
            if let Some(cleanup) = replacement_cleanup {
                let _ = cleanup.await;
            }

            tracing::info!(
                dataset_id = %logged_dataset_id,
                seq,
                "open_remote_dataset.broadcast_sent"
            );

            if !generated_plans.is_empty() {
                tokio::spawn(async move {
                    generated_service.enqueue_background_fill().await;
                });
            }

            Ok(seq)
        });

        commit_task.await.map_err(|error| {
            tracing::error!(
                client_id = %opener,
                workspace_id = %scope.live.workspace_id,
                dataset_id = %dataset_id,
                dataset_source_id = %dataset_source_id,
                error = %error,
                "open_remote_dataset.commit_task_failed"
            );
            open_failure(
                DatasetOpenStage::WorkspacePersist,
                DatasetOpenFailureKind::Persistence,
                true,
                "workspace commit task failed",
                Some(error.to_string()),
            )
        })??
    };

    // WebSocket progress shares the terminal's priority FIFO and must have no
    // producer after the precommitted terminal. Headless callers still get
    // these observational post-commit stages through their channel sink.
    if ctx.terminal.is_none() {
        emit(
            progress,
            open_progress(
                DatasetOpenStage::WorkspacePersist,
                "workspace dataset membership persisted",
                Some(dataset_id_key.clone()),
                Some(dataset_source_id.clone()),
                Some(format!("seq: {seq}")),
            ),
        );
    }

    // Broadcast the authoritative command to peers. The requester receives
    // the compatibility OpenDatasetSucceeded payload from the handler, so it
    // is excluded here to avoid sending the same large DatasetOpened twice.
    let opened = match &command {
        DocumentCommand::DatasetOpened(opened) => opened.clone(),
        _ => unreachable!("dataset open command must be DatasetOpened"),
    };
    if ctx.terminal.is_none() {
        emit(
            progress,
            open_progress(
                DatasetOpenStage::Broadcast,
                "broadcasting dataset to workspace clients",
                Some(dataset_id_key.clone()),
                Some(dataset_source_id.clone()),
                Some(format!("seq: {seq}")),
            ),
        );
    }

    let diagnostic = open_success(&canonical_url, &opened, Some(dataset_source_id));
    Ok(DatasetOpenOutcome::Opened {
        seq,
        opened: Box::new(opened),
        diagnostic,
        terminal_precommitted: ctx.terminal.is_some(),
    })
}

fn new_workspace_dataset_id() -> DatasetId {
    DatasetId(format!("wds-{}", uuid::Uuid::new_v4().simple()))
}

fn find_loaded_binding(
    sess: &Session,
    dataset_id: &DatasetId,
    source: &SourceVersion,
) -> Option<(DatasetId, DatasetOpened)> {
    if sess.document.manifests.contains_key(dataset_id)
        && let Some(binding) = sess.server_bindings.get(dataset_id)
        && binding.source == *source
    {
        return Some((dataset_id.clone(), binding.dataset_opened.clone()));
    }

    for (existing_id, binding) in &sess.server_bindings {
        if binding.source == *source && sess.document.manifests.contains_key(existing_id) {
            return Some((existing_id.clone(), binding.dataset_opened.clone()));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outbox::{
        BroadcastKind, ProcessOutboxBudgetProbe, UnicastReceiver,
        unicast_channel_with_process_budget, unicast_channel_with_process_budget_probe,
    };
    use crate::test_fixtures::single_image_manifest;
    use crate::workspace::{WorkspaceError, WorkspaceStore};
    use lucida_content::DataType;
    use std::fs;
    use std::path::Path;

    async fn terminal_lane(
        request_id: &str,
    ) -> (DatasetOpenTerminal, UnicastReceiver, UnicastSender) {
        let (sender, receiver) =
            unicast_channel_with_process_budget(1, DEFAULT_OUTBOX_BYTES, 4 * 1024 * 1024);
        let slot = sender
            .reserve_terminal_slot()
            .await
            .expect("dataset-open terminal slot");
        (
            DatasetOpenTerminal::new(request_id.into(), sender.clone(), slot),
            receiver,
            sender,
        )
    }

    async fn terminal_lane_with_budget_probe(
        request_id: &str,
    ) -> (
        DatasetOpenTerminal,
        UnicastReceiver,
        UnicastSender,
        ProcessOutboxBudgetProbe,
    ) {
        let (sender, receiver, budget) =
            unicast_channel_with_process_budget_probe(1, DEFAULT_OUTBOX_BYTES, 4 * 1024 * 1024);
        let slot = sender
            .reserve_terminal_slot()
            .await
            .expect("dataset-open terminal slot");
        (
            DatasetOpenTerminal::new(request_id.into(), sender.clone(), slot),
            receiver,
            sender,
            budget,
        )
    }

    async fn receive_terminal(receiver: &mut UnicastReceiver) -> ServerMessage {
        let axum::extract::ws::Message::Text(text) = receiver
            .recv()
            .await
            .expect("dataset-open terminal message")
        else {
            panic!("dataset-open terminal must be JSON")
        };
        serde_json::from_str(text.as_str()).expect("valid dataset-open terminal JSON")
    }

    fn publish_failure_after_open_error(
        terminal: &DatasetOpenTerminal,
        request_id: &str,
        url: &str,
        diagnostic: DatasetOpenFailureDiagnostic,
    ) {
        let message = ServerMessage::OpenDatasetFailed {
            request_id: request_id.into(),
            url: url.into(),
            error: diagnostic.message.clone(),
            diagnostic: Some(diagnostic),
        };
        terminal
            .publish_json(&message, DEFAULT_OUTBOX_BYTES)
            .expect("prepared success drop must leave the terminal slot reusable");
    }

    /// Build a `DatasetOpened` whose manifest carries `name`, wired to the
    /// shared `single_image_manifest` shape but renamed. Used to seed both the
    /// document and a `ServerBinding`'s cached import-time copy.
    fn dataset_opened_named(name: &str) -> DatasetOpened {
        let mut manifest = single_image_manifest();
        manifest.name = name.to_string();
        let image_id = manifest.images()[0].image_id.clone();
        DatasetOpened {
            manifest,
            fetch: lucida_protocol::FetchSource::Proxied(lucida_protocol::ProxiedFetchDescriptor {
                images: vec![lucida_protocol::ProxiedImageSpec {
                    image_id,
                    wire_format: lucida_protocol::WireFormat::Raw {
                        data_type: DataType::Uint16,
                    },
                }],
            }),
            opener_client_id: None,
        }
    }

    /// Construct a `ServerBinding` carrying `opened` as its cached, import-time
    /// `dataset_opened`, with inert generated infrastructure (none of it is
    /// exercised here). Mirrors the helper in
    /// `tests/dataset_id_stable.rs`.
    fn make_test_binding(source_url: &str, opened: &DatasetOpened) -> ServerBinding {
        let store =
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let cache = Arc::new(CachedStore::new(store.clone(), 1024));
        let resolver = Arc::new(ChunkResolver::new(
            &lucida_store::import_types::ServerBindingSeed { images: vec![] },
        ));
        let derived_chunks = Arc::new(DerivedChunkCache::default());
        ServerBinding {
            source: SourceVersion::new(
                lucida_content::url::SourceIdentity::parse(source_url).unwrap(),
                lucida_content::url::SourceRevision::from_bytes(b"dataset-open-test"),
            ),
            store,
            resolver,
            cache,
            dataset_opened: opened.clone(),
            derived_chunks: derived_chunks.clone(),
            generated_service: Arc::new(GeneratedCoarseService::inert(derived_chunks)),
            import_warnings: Vec::new(),
        }
    }

    /// Regression for the dedup-reuse-after-rename bug (#701): re-opening an
    /// already-loaded dataset URL must re-broadcast the dataset under its
    /// CURRENT document name, not the stale import-time name cached on the
    /// `ServerBinding`.
    ///
    /// The bug: the reuse short-circuit cloned the binding's cached
    /// `dataset_opened` (whose manifest is frozen at import time) into the
    /// re-broadcast `DatasetOpened`. Because applying a `DatasetOpened` does a
    /// full manifest *replace*, a re-open after a rename silently clobbered
    /// the new name back to the import-time one for every client that
    /// received the re-broadcast.
    ///
    /// This drives the real reuse-shortcut body: it seeds a `Session` with a
    /// dataset (real `Session::apply(DatasetOpened)`) and a matching
    /// `ServerBinding`, renames it through the real document path
    /// (`Session::apply(RenameDataset)`), then runs the open path's own
    /// `find_loaded_binding` lookup + the fix's document-manifest adoption +
    /// opener re-stamp, and asserts the resulting re-broadcast command carries
    /// the renamed name AND the re-stamped opener id. As a guard, it confirms
    /// the binding's own cached copy is deliberately left stale (proving the
    /// document — not the binding — is the source of truth for the display
    /// name).
    #[test]
    fn dedup_reuse_after_rename_rebroadcasts_renamed_name() {
        const URL: &str = "gs://lucida-test/datasets/rename-me.zarr";
        const FIRST_OPENER: ClientId = 11;
        const SECOND_REQUESTER: ClientId = 42;
        let import_name = "import-time-name.zarr";
        let renamed = "Renamed By Editor";

        let dataset_id = single_image_manifest().dataset_id;
        let mut session = Session::new();

        // First open: apply DatasetOpened (import-time name, stamped with the
        // first opener) + register binding.
        let mut opened = dataset_opened_named(import_name);
        opened.opener_client_id = Some(FIRST_OPENER);
        session.apply(DocumentCommand::DatasetOpened(opened.clone()));
        session
            .server_bindings
            .insert(dataset_id.clone(), make_test_binding(URL, &opened));
        assert_eq!(
            session.document.manifests[&dataset_id].name, import_name,
            "precondition: document carries the import-time name"
        );

        // Rename through the real document path.
        session.apply(DocumentCommand::RenameDataset {
            id: dataset_id.clone(),
            name: renamed.to_string(),
        });
        assert_eq!(
            session.document.manifests[&dataset_id].name, renamed,
            "precondition: rename updated the live document manifest"
        );
        // The binding's cached import-time copy is (intentionally) untouched by
        // a rename — this is exactly the stale state the bug re-broadcast.
        assert_eq!(
            session.server_bindings[&dataset_id]
                .dataset_opened
                .manifest
                .name,
            import_name,
            "the binding cache stays at the import-time name; the fix must not \
             rely on it for the display name"
        );
        assert_eq!(
            session.server_bindings[&dataset_id]
                .dataset_opened
                .opener_client_id,
            Some(FIRST_OPENER),
            "precondition: the binding cache holds the FIRST opener's id"
        );

        // Re-open the SAME URL as a DIFFERENT client: run the real reuse
        // short-circuit. `find_loaded_binding` is the production helper;
        // the manifest adoption + opener re-stamp immediately below are the
        // exact fixes under test (mirroring `open_dataset`'s dedup-reuse path).
        let client_id: ClientId = SECOND_REQUESTER;
        let source = session.server_bindings[&dataset_id].source.clone();
        let (existing_dataset_id, mut existing) =
            find_loaded_binding(&session, &dataset_id, &source)
                .expect("re-open must find the existing binding (dedup short-circuit)");
        if let Some(doc_manifest) = session.document.manifests.get(&existing_dataset_id) {
            existing.manifest = doc_manifest.clone();
        }
        existing.opener_client_id = Some(client_id);
        let rebroadcast = DocumentCommand::DatasetOpened(existing);

        // The re-broadcast DatasetOpened — what peers re-apply — must carry the
        // renamed name, NOT the import-time name.
        let DocumentCommand::DatasetOpened(rebroadcast_opened) = &rebroadcast else {
            panic!("expected DatasetOpened");
        };
        assert_eq!(
            rebroadcast_opened.manifest.name, renamed,
            "dedup re-open must re-broadcast the renamed name, not the stale \
             import-time manifest name"
        );
        assert_eq!(
            rebroadcast_opened.manifest.dataset_id, dataset_id,
            "dedup re-open must target the same dataset id"
        );
        // The dedup-reuse rebroadcast must re-stamp the CURRENT requester so
        // the everyday multi-user case (open a URL already loaded in the
        // session) auto-fits for the opener — not the original first opener.
        assert_eq!(
            rebroadcast_opened.opener_client_id,
            Some(SECOND_REQUESTER),
            "dedup re-open must re-stamp opener_client_id with the current \
             requester, not the binding's cached first opener"
        );
    }

    // --- Headless open orchestration ---------------------------------

    /// Write a minimal valid OME-Zarr v0.5 store (metadata only — chunks
    /// are fetched lazily, so none are needed for an import) to `dir`.
    fn write_minimal_zarr(dir: &Path) {
        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "multiscales": [{
                        "version": "0.5",
                        "name": "img",
                        "axes": [
                            {"name": "t", "type": "time"},
                            {"name": "c", "type": "channel"},
                            {"name": "z", "type": "space"},
                            {"name": "y", "type": "space"},
                            {"name": "x", "type": "space"}
                        ],
                        "datasets": [{
                            "path": "0",
                            "coordinateTransformations": [{
                                "type": "scale",
                                "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                            }]
                        }]
                    }]
                }
            }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        let level_dir = dir.join("0");
        fs::create_dir_all(&level_dir).unwrap();
        let arr = serde_json::json!({
            "zarr_format": 3,
            "node_type": "array",
            "shape": [1, 1, 1, 4, 4],
            "data_type": "uint16",
            "chunk_grid": {
                "name": "regular",
                "configuration": { "chunk_shape": [1, 1, 1, 4, 4] }
            },
            "codecs": [
                {"name": "bytes", "configuration": {"endian": "little"}}
            ],
            "fill_value": 0
        });
        fs::write(
            level_dir.join("zarr.json"),
            serde_json::to_string_pretty(&arr).unwrap(),
        )
        .unwrap();
    }

    /// A real workspace context whose generated caches live under `root` and
    /// whose generated planning is disabled, so nothing writes outside the
    /// test sandbox.
    async fn test_context(root: &Path) -> DatasetOpenContext {
        test_context_with_pool(root).await.0
    }

    async fn test_context_with_pool(root: &Path) -> (DatasetOpenContext, sqlx::SqlitePool) {
        let (context, pool, _) = test_context_with_store(root, None).await;
        (context, pool)
    }

    async fn test_context_with_store(
        root: &Path,
        persistence_deadline: Option<std::time::Duration>,
    ) -> (
        DatasetOpenContext,
        sqlx::SqlitePool,
        crate::workspace::SqliteWorkspaceStore,
    ) {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

        let runtime = DatasetRuntimeConfig {
            source_policy: Arc::new(
                crate::source_policy::SourceTrustPolicy::from_config(
                    crate::source_policy::SourceTrustConfig {
                        local_roots: vec![root.to_path_buf()],
                        ..crate::source_policy::SourceTrustConfig::default()
                    },
                )
                .unwrap(),
            ),
            source_cache: lucida_store::cache::SharedObjectCache::new(
                16 * 1024 * 1024,
                8 * 1024 * 1024,
            ),
            generated_enabled: false,
            generated_cache_dir: root.join("generated"),
            legacy_proxy_cache_dir: root.join("proxies"),
            generated_concurrency: 1,
            generated_background_chunk_limit: 4,
            generated_target_long_axis: 64,
            generated_chunk_long_axis: 32,
            generated_max_chunk_bytes: 1024 * 1024,
            generated_disk_budget_bytes: crate::DEFAULT_GENERATED_DISK_BUDGET_BYTES,
        };
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let store = match persistence_deadline {
            Some(deadline) => crate::workspace::SqliteWorkspaceStore::with_persistence_deadline(
                pool.clone(),
                deadline,
            ),
            None => crate::workspace::SqliteWorkspaceStore::new(pool.clone()),
        };
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(store.clone()),
            runtime.clone(),
        ));
        let principal = AuthPrincipal {
            email: "dataset-open@example.test".into(),
            display_name: "Dataset Open".into(),
            picture_url: None,
            is_admin: false,
            auth_epoch: 0,
        };
        let record = manager
            .create_workspace(&principal, Some("Dataset open tests"))
            .await
            .unwrap();
        let live = manager
            .live_workspace(&record.id, &principal)
            .await
            .unwrap();
        (
            DatasetOpenContext {
                session: Arc::clone(&live.session),
                tx: live.tx.clone(),
                dataset_runtime: runtime,
                workspace: WorkspaceScope {
                    live,
                    manager,
                    principal,
                },
                terminal: None,
                publication_barrier: None,
                post_persist_barrier: None,
                panic_commit_task: false,
            },
            pool,
            store,
        )
    }

    fn stages_of(
        rx: &mut mpsc::UnboundedReceiver<DatasetOpenProgressDiagnostic>,
    ) -> Vec<DatasetOpenStage> {
        let mut stages = Vec::new();
        while let Ok(diagnostic) = rx.try_recv() {
            stages.push(diagnostic.stage);
        }
        stages
    }

    #[tokio::test]
    async fn unsupported_scheme_fails_at_backend_open_with_staged_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = test_context(tmp.path()).await;
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();

        let err = open_dataset(7, "ftp://example.com/data.zarr", &ctx, &progress_tx)
            .await
            .expect_err("unsupported scheme must fail");

        assert_eq!(err.stage, DatasetOpenStage::BackendOpen);
        assert_eq!(err.kind, DatasetOpenFailureKind::UnsupportedScheme);
        assert!(!err.retryable);

        drop(progress_tx);
        assert_eq!(
            stages_of(&mut progress_rx),
            vec![
                DatasetOpenStage::RequestReceived,
                DatasetOpenStage::Authorization,
                DatasetOpenStage::Authorization,
            ],
            "policy rejection happens before source lookup or backend construction"
        );

        // Nothing was applied or bound.
        let sess = ctx.session.lock().await;
        assert!(sess.server_bindings.is_empty());
        assert!(sess.document.manifests.is_empty());
    }

    #[tokio::test]
    async fn missing_metadata_fails_at_import_with_staged_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("empty.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        let ctx = test_context(tmp.path()).await;
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();

        let err = open_dataset(7, data_dir.to_str().unwrap(), &ctx, &progress_tx)
            .await
            .expect_err("a directory with no zarr metadata must fail import");

        assert_eq!(err.stage, DatasetOpenStage::MetadataImport);
        assert!(!err.retryable);

        drop(progress_tx);
        assert_eq!(
            stages_of(&mut progress_rx),
            vec![
                DatasetOpenStage::RequestReceived,
                DatasetOpenStage::Authorization,
                DatasetOpenStage::Authorization,
                DatasetOpenStage::SourceLookup,
                DatasetOpenStage::SourceLookup,
                DatasetOpenStage::BackendOpen,
                DatasetOpenStage::MetadataImport,
            ],
        );

        let sess = ctx.session.lock().await;
        assert!(sess.server_bindings.is_empty());
        assert!(sess.document.manifests.is_empty());
    }

    #[tokio::test]
    async fn second_open_of_same_url_joins_existing_binding() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("tiny.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();

        let ctx = test_context(tmp.path()).await;
        let mut broadcast_rx = ctx.tx.subscribe();

        let (p1, _r1) = mpsc::unbounded_channel();
        let first = open_dataset(1, &url, &ctx, &p1).await.expect("first open");
        let DatasetOpenOutcome::Opened {
            seq: first_seq,
            opened: first_opened,
            ..
        } = first
        else {
            panic!("first open must complete");
        };
        assert_eq!(first_opened.opener_client_id, Some(1));

        let (p2, mut r2) = mpsc::unbounded_channel();
        let second = open_dataset(2, &url, &ctx, &p2).await.expect("second open");
        let DatasetOpenOutcome::Opened {
            seq: second_seq,
            opened: second_opened,
            ..
        } = second
        else {
            panic!("second open must complete");
        };

        // Joined, not duplicated: same dataset id, same seq (no re-apply),
        // one binding, one manifest — and the rebroadcast is re-stamped
        // with the second requester.
        assert_eq!(
            second_opened.manifest.dataset_id,
            first_opened.manifest.dataset_id
        );
        assert_eq!(second_seq, first_seq);
        assert_eq!(second_opened.opener_client_id, Some(2));
        {
            let sess = ctx.session.lock().await;
            assert_eq!(sess.server_bindings.len(), 1);
            assert_eq!(sess.document.manifests.len(), 1);
        }
        drop(p2);
        let mut reused = false;
        while let Ok(diagnostic) = r2.try_recv() {
            if diagnostic.stage == DatasetOpenStage::BindingBuild {
                assert_eq!(diagnostic.message, "reusing existing server binding");
                reused = true;
            }
        }
        assert!(reused, "second open must take the binding-reuse path");

        // Each requester is excluded from its own full DatasetOpened
        // broadcast; its success envelope carries the compatibility payload.
        let mut senders = Vec::new();
        while let Ok(item) = broadcast_rx.try_recv() {
            if let BroadcastKind::CommandBroadcast { sender } = item.kind() {
                senders.push(sender);
            }
        }
        assert_eq!(senders, vec![Some(1), Some(2)]);
    }

    #[tokio::test]
    async fn late_workspace_drain_rejects_and_shuts_down_unpublished_generated_service() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("late-drain.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();

        let mut ctx = test_context(tmp.path()).await;
        let barrier = DatasetOpenPublicationBarrier::new();
        ctx.publication_barrier = Some(barrier.clone());
        let open_ctx = ctx.clone();
        let (progress, _progress_rx) = mpsc::unbounded_channel();
        let opening =
            tokio::spawn(async move { open_dataset(7, &url, &open_ctx, &progress).await });

        let entered =
            tokio::time::timeout(std::time::Duration::from_secs(5), barrier.entered.acquire())
                .await
                .expect("dataset open did not reach the pre-publication barrier")
                .expect("pre-publication barrier closed");
        entered.forget();
        let unpublished_service = barrier
            .service
            .lock()
            .expect("publication barrier service")
            .clone()
            .expect("constructed generated service");

        // The drain snapshots no binding because the open has constructed its
        // service but has not yet published it. Its cancellation marker must
        // nevertheless make the late publisher reject and clean up that
        // otherwise-invisible service.
        let drained = ctx
            .workspace
            .manager
            .shutdown_all_live_background("test late drain")
            .await;
        assert_eq!(drained, 0);
        assert!(ctx.workspace.live.background_cancelled());

        barrier.release.add_permits(1);
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), opening)
            .await
            .expect("dataset open did not observe workspace drain")
            .expect("dataset open task panicked")
            .expect("workspace drain is a cancellation, not an open failure");
        assert!(matches!(outcome, DatasetOpenOutcome::Cancelled));
        assert!(unpublished_service.is_shutdown().await);

        let sess = ctx.session.lock().await;
        assert!(sess.server_bindings.is_empty());
        assert!(sess.document.manifests.is_empty());
        assert!(sess.generated_availability.is_empty());
    }

    #[tokio::test]
    async fn requester_abort_after_sql_commit_cannot_split_live_publication() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("post-persist-abort.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();

        let (mut ctx, pool) = test_context_with_pool(tmp.path()).await;
        let barrier = DatasetOpenPostPersistBarrier::new();
        ctx.post_persist_barrier = Some(barrier.clone());
        let mut broadcast_rx = ctx.tx.subscribe();
        let open_ctx = ctx.clone();
        let (progress, _progress_rx) = mpsc::unbounded_channel();
        let opening =
            tokio::spawn(async move { open_dataset(7, &url, &open_ctx, &progress).await });

        let entered =
            tokio::time::timeout(std::time::Duration::from_secs(5), barrier.entered.acquire())
                .await
                .expect("dataset open did not reach the post-persist barrier")
                .expect("post-persist barrier closed");
        entered.forget();
        let persisted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_datasets")
            .fetch_one(&pool)
            .await
            .expect("durable membership query");
        assert_eq!(persisted, 1, "SQL commit must precede the injected pause");
        assert!(
            ctx.session.try_lock().is_err(),
            "shielded child owns the live publication fence"
        );
        assert!(matches!(
            broadcast_rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        opening.abort();
        assert!(opening.await.unwrap_err().is_cancelled());
        barrier.release.add_permits(1);

        let sess = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            Arc::clone(&ctx.session).lock_owned(),
        )
        .await
        .expect("detached commit child did not finish");
        assert_eq!(sess.seq, 1);
        assert_eq!(sess.document.manifests.len(), 1);
        assert_eq!(sess.server_bindings.len(), 1);
        drop(sess);

        let item = tokio::time::timeout(std::time::Duration::from_secs(1), broadcast_rx.recv())
            .await
            .expect("detached child omitted command publication")
            .expect("broadcast ring remained open");
        assert!(matches!(
            item.kind(),
            BroadcastKind::CommandBroadcast { sender: Some(7) }
        ));
    }

    #[tokio::test]
    async fn lost_dataset_open_completion_reconciles_and_publishes_once() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("lost-open-completion.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();

        let (mut ctx, pool) = test_context_with_pool(tmp.path()).await;
        let (terminal, mut terminal_rx, terminal_sender) = terminal_lane("lost-open").await;
        ctx.terminal = Some(terminal);
        let mut broadcast_rx = ctx.tx.subscribe();
        ctx.workspace.manager.lose_next_persistence_completion();
        let (progress, _progress_rx) = mpsc::unbounded_channel();

        let outcome = open_dataset(17, &url, &ctx, &progress)
            .await
            .expect("durable read-back must recover a committed dataset open");
        let DatasetOpenOutcome::Opened {
            seq,
            terminal_precommitted,
            ..
        } = outcome
        else {
            panic!("recovered dataset open must publish success");
        };
        assert_eq!(seq, 1);
        assert!(terminal_precommitted);
        assert!(matches!(
            receive_terminal(&mut terminal_rx).await,
            ServerMessage::OpenDatasetSucceeded { request_id, seq: 1, .. }
                if request_id == "lost-open"
        ));
        assert!(
            terminal_rx.try_recv().is_err(),
            "success terminal published twice"
        );

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), broadcast_rx.recv())
            .await
            .expect("recovered open omitted broadcast")
            .expect("broadcast ring closed");
        assert!(matches!(
            event.kind(),
            BroadcastKind::CommandBroadcast { sender: Some(17) }
        ));
        assert!(matches!(
            broadcast_rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workspace_datasets")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        let session = ctx.session.lock().await;
        assert_eq!(session.seq, 1);
        assert_eq!(session.document.manifests.len(), 1);
        drop(session);

        let restored = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            terminal_sender.reserve_terminal_slot(),
        )
        .await
        .expect("recovered success leaked its terminal reservation")
        .expect("terminal lane remains open");
        drop(restored);
    }

    #[tokio::test]
    async fn never_completing_dataset_persistence_returns_bounded_indeterminate_without_terminal_lie()
     {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("never-completing-open.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();

        let (mut ctx, pool, store) =
            test_context_with_store(tmp.path(), Some(std::time::Duration::from_millis(10))).await;
        let workspace_id = ctx.workspace.live.workspace_id.clone();
        let manager = Arc::clone(&ctx.workspace.manager);
        let principal = ctx.workspace.principal.clone();
        let old_live = Arc::clone(&ctx.workspace.live);
        let (terminal, mut terminal_rx, terminal_sender, terminal_process_budget) =
            terminal_lane_with_budget_probe("never-open").await;
        let terminal_payload_baseline = terminal_sender.queued_bytes();
        ctx.terminal = Some(terminal);
        let mut broadcast_rx = ctx.tx.subscribe();
        let (progress, _progress_rx) = mpsc::unbounded_channel();

        store.never_complete_next_persistence();
        let started = tokio::time::Instant::now();
        let error = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            open_dataset(29, &url, &ctx, &progress),
        )
        .await
        .expect("a backend deadline must bound dataset-open persistence")
        .expect_err("a deadline cannot claim durable success or failure");
        assert!(started.elapsed() < std::time::Duration::from_millis(500));
        assert_eq!(error.kind, DatasetOpenFailureKind::Persistence);
        assert!(!error.retryable);
        assert!(
            error
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("persist-")),
            "indeterminate outcome must retain its operation identity"
        );

        let terminal_message =
            tokio::time::timeout(std::time::Duration::from_millis(100), terminal_rx.recv())
                .await
                .expect("indeterminate open must close its requester lane")
                .expect("requester lane must carry a coded close");
        assert!(
            matches!(terminal_message, axum::extract::ws::Message::Close(_)),
            "an indeterminate open must publish neither a success nor failure terminal"
        );
        drop(terminal_message);
        assert!(matches!(
            broadcast_rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        assert!(
            terminal_sender.reserve_terminal_slot().await.is_err(),
            "the force-closed terminal lane must release and reject further reservations"
        );
        assert_eq!(
            terminal_sender.queued_bytes(),
            terminal_payload_baseline,
            "prepared success and coded close must return payload accounting to baseline"
        );

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workspace_datasets")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        let old_session = ctx
            .session
            .try_lock()
            .expect("deadline return must release the accepted session guard");
        assert_eq!(old_session.seq, 0);
        assert!(old_session.document.manifests.is_empty());
        assert!(old_session.server_bindings.is_empty());
        drop(old_session);

        let operation_id = store.last_persistence_operation_id();
        tokio::time::timeout(std::time::Duration::from_millis(100), async {
            while crate::persistence::persistence_operation_resources(operation_id)
                != (false, false)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("deadline must retain no backend worker or operation controller");

        drop(ctx);
        drop(terminal_sender);
        drop(terminal_rx);
        assert_eq!(
            terminal_process_budget.queued_bytes(),
            0,
            "closing the lane must return terminal slot, payload, and retained wire capacity"
        );

        let restored = manager
            .live_workspace(&workspace_id, &principal)
            .await
            .expect("quiesced persistence permits a durable restore");
        assert!(!Arc::ptr_eq(&old_live, &restored));
        let restored_session = restored.session.lock().await;
        assert_eq!(restored_session.seq, 0);
        assert!(restored_session.document.manifests.is_empty());
    }

    #[tokio::test]
    async fn unquiesced_cold_binding_refresh_aborts_publication_and_retains_one_workspace_tombstone()
     {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("unquiesced-cold-refresh.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();

        let (ctx, _pool, store) =
            test_context_with_store(tmp.path(), Some(std::time::Duration::from_millis(10))).await;
        let workspace_id = ctx.workspace.live.workspace_id.clone();
        let principal = ctx.workspace.principal.clone();
        let (progress, _progress_rx) = mpsc::unbounded_channel();
        let opened = open_dataset(37, &url, &ctx, &progress)
            .await
            .expect("seed dataset open");
        let DatasetOpenOutcome::Opened { opened, seq, .. } = opened else {
            panic!("seed open must produce a durable dataset");
        };
        assert_eq!(seq, 1);
        let dataset_id = opened.manifest.dataset_id.clone();
        let persisted_before = store.get_workspace(&workspace_id).await.unwrap().unwrap();
        assert_eq!(persisted_before.seq, 1);

        // Change an import-visible field while keeping the Zarr valid. A
        // fresh source cache below then observes a new source revision during
        // cold binding restore and must durably refresh the workspace.
        let level_path = data_dir.join("0/zarr.json");
        let mut level: serde_json::Value =
            serde_json::from_slice(&fs::read(&level_path).unwrap()).unwrap();
        level["shape"] = serde_json::json!([1, 1, 1, 8, 4]);
        fs::write(&level_path, serde_json::to_vec_pretty(&level).unwrap()).unwrap();

        let mut restart_runtime = ctx.dataset_runtime.clone();
        restart_runtime.source_cache =
            lucida_store::cache::SharedObjectCache::new(16 * 1024 * 1024, 8 * 1024 * 1024);
        let manager = WorkspaceManager::new(Arc::new(store.clone()), restart_runtime);
        store.never_complete_and_never_quiesce_next_persistence();

        let started = tokio::time::Instant::now();
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            manager.live_workspace(&workspace_id, &principal),
        )
        .await
        .expect("cold refresh mutation and quiescence must both be bounded");
        let error = match result {
            Ok(_) => panic!("an unquiesced refresh cannot publish a cold live runtime"),
            Err(error) => error,
        };
        let WorkspaceError::PersistenceIndeterminate(detail) = error else {
            panic!("unquiesced cold refresh must remain explicitly indeterminate");
        };
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
        assert!(detail.contains("persist-"));
        assert!(detail.contains("RestartRequired"));
        assert_eq!(manager.live_workspace_count().await, 0);
        assert_eq!(manager.restart_required_workspace_count().await, 1);

        let operation_id = store.last_persistence_operation_id();
        tokio::time::timeout(std::time::Duration::from_millis(100), async {
            while crate::persistence::persistence_operation_resources(operation_id)
                != (false, false)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("failed cold restore must release operation resources");
        assert_eq!(
            crate::persistence::persistence_operation_resources(operation_id),
            (false, false),
            "failed cold restore must retain no worker or operation controller"
        );
        for _ in 0..2 {
            let error = match manager.live_workspace(&workspace_id, &principal).await {
                Ok(_) => panic!("restart tombstone must block every later cold publication"),
                Err(error) => error,
            };
            assert!(matches!(error, WorkspaceError::PersistenceIndeterminate(_)));
        }
        assert_eq!(manager.restart_required_workspace_count().await, 1);
        assert_eq!(manager.live_workspace_count().await, 0);

        let durable = store.get_workspace(&workspace_id).await.unwrap().unwrap();
        assert_eq!(
            durable.seq, 1,
            "the never-running fake cannot alter durability"
        );
        assert_eq!(
            serde_json::to_value(&durable.document.manifests[&dataset_id]).unwrap(),
            serde_json::to_value(&persisted_before.document.manifests[&dataset_id]).unwrap()
        );
    }

    #[tokio::test]
    async fn revoked_connection_waits_for_transferred_dataset_commit_permit() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("revoke-commit-race.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();

        let mut ctx = test_context(tmp.path()).await;
        let barrier = DatasetOpenPostPersistBarrier::new();
        ctx.post_persist_barrier = Some(barrier.clone());
        let lease = ctx
            .workspace
            .live
            .register_connection_for_test(7, &ctx.workspace.principal.email)
            .await;
        let operation_permit = lease.begin_operation().await.expect("admitted operation");
        let mut broadcast_rx = ctx.tx.subscribe();
        let open_ctx = ctx.clone();
        let (progress, _progress_rx) = mpsc::unbounded_channel();
        let opening = tokio::spawn(async move {
            open_dataset_with_operation_permit(7, &url, &open_ctx, &progress, operation_permit)
                .await
        });

        let entered =
            tokio::time::timeout(std::time::Duration::from_secs(5), barrier.entered.acquire())
                .await
                .expect("dataset open did not reach the post-persist barrier")
                .expect("post-persist barrier closed");
        entered.forget();
        opening.abort();
        assert!(opening.await.unwrap_err().is_cancelled());

        let live = Arc::clone(&ctx.workspace.live);
        let email = ctx.workspace.principal.email.clone();
        let mut revocation = tokio::spawn(async move {
            live.revoke_principal_and_quiesce_for_test(&email).await;
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !lease.is_revoked() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("revocation did not mark the lease");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut revocation)
                .await
                .is_err(),
            "revocation returned while the transferred commit permit was active"
        );

        barrier.release.add_permits(1);
        tokio::time::timeout(std::time::Duration::from_secs(5), &mut revocation)
            .await
            .expect("revocation did not finish after publication")
            .expect("revocation task panicked");

        let sess = ctx.session.lock().await;
        assert_eq!(sess.seq, 1);
        assert_eq!(sess.document.manifests.len(), 1);
        drop(sess);
        assert!(matches!(
            broadcast_rx.recv().await.expect("command published").kind(),
            BroadcastKind::CommandBroadcast { sender: Some(7) }
        ));
        assert!(lease.begin_operation().await.is_none());
    }

    #[tokio::test]
    async fn same_locator_metadata_mutation_replaces_document_binding_and_cache_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("mutable.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();
        let ctx = test_context(tmp.path()).await;

        let (first_progress, _first_rx) = mpsc::unbounded_channel();
        let first = open_dataset(1, &url, &ctx, &first_progress)
            .await
            .expect("first open");
        let DatasetOpenOutcome::Opened {
            seq: first_seq,
            opened: first_opened,
            ..
        } = first
        else {
            panic!("first open must complete");
        };
        let dataset_id = first_opened.manifest.dataset_id.clone();
        let first_revision = ctx.session.lock().await.server_bindings[&dataset_id]
            .source
            .revision;

        let level_path = data_dir.join("0/zarr.json");
        let mut level: serde_json::Value =
            serde_json::from_slice(&fs::read(&level_path).unwrap()).unwrap();
        level["shape"] = serde_json::json!([1, 1, 1, 8, 4]);
        fs::write(&level_path, serde_json::to_vec_pretty(&level).unwrap()).unwrap();

        let (second_progress, _second_rx) = mpsc::unbounded_channel();
        let second = open_dataset(2, &url, &ctx, &second_progress)
            .await
            .expect("mutated reopen");
        let DatasetOpenOutcome::Opened {
            seq: second_seq,
            opened: second_opened,
            ..
        } = second
        else {
            panic!("mutated reopen must complete");
        };

        let sess = ctx.session.lock().await;
        let binding = &sess.server_bindings[&dataset_id];
        assert_eq!(first_seq, 1);
        assert_eq!(second_seq, 2);
        assert_eq!(sess.server_bindings.len(), 1);
        assert_eq!(sess.document.manifests.len(), 1);
        assert_ne!(binding.source.revision, first_revision);
        assert_eq!(
            second_opened.manifest.images()[0].multiscale.levels[0].shape,
            [1, 1, 1, 8, 4]
        );
        assert_eq!(
            sess.document.manifests[&dataset_id].images()[0]
                .multiscale
                .levels[0]
                .shape,
            [1, 1, 1, 8, 4]
        );
    }

    #[tokio::test]
    async fn replacement_quiesces_old_worker_before_reset_and_fences_stale_ready() {
        use lucida_core::protocol::{
            ViewerInteractionMode, ViewerInterestChunkKey, ViewerInterestHint, ViewerInterestLane,
            ViewerInterestMode,
        };

        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("replacement-race.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let level_path = data_dir.join("0/zarr.json");
        let mut level: serde_json::Value =
            serde_json::from_slice(&fs::read(&level_path).unwrap()).unwrap();
        level["shape"] = serde_json::json!([1, 1, 1, 4096, 4096]);
        fs::write(&level_path, serde_json::to_vec_pretty(&level).unwrap()).unwrap();
        let url = data_dir.to_str().unwrap().to_string();
        let mut ctx = test_context(tmp.path()).await;
        ctx.dataset_runtime.generated_enabled = true;
        ctx.dataset_runtime.generated_background_chunk_limit = 0;
        ctx.dataset_runtime.generated_target_long_axis = 2;
        ctx.dataset_runtime.generated_chunk_long_axis = 2;

        let (first_progress, _first_rx) = mpsc::unbounded_channel();
        let first = open_dataset(1, &url, &ctx, &first_progress)
            .await
            .expect("first open");
        let DatasetOpenOutcome::Opened { opened, .. } = first else {
            panic!("first open must complete");
        };
        let dataset_id = opened.manifest.dataset_id.clone();
        let (old_source, old_service, old_cache) = {
            let sess = ctx.session.lock().await;
            let binding = &sess.server_bindings[&dataset_id];
            (
                binding.source.clone(),
                Arc::clone(&binding.generated_service),
                Arc::clone(&binding.derived_chunks),
            )
        };
        let plan = plan_generated_coarse_for_source(
            &opened.manifest,
            old_source.revision,
            GeneratedCoarseConfig {
                target_long_axis: ctx.dataset_runtime.generated_target_long_axis,
                chunk_long_axis: ctx.dataset_runtime.generated_chunk_long_axis,
                max_chunk_bytes: ctx.dataset_runtime.generated_max_chunk_bytes,
            },
        )
        .pop()
        .expect("generated plan");
        let key = plan.chunk_keys_for_tc(0, 0).next().expect("generated key");

        let (worker_entered, worker_release) = old_service.install_worker_barrier();
        let (shutdown_entered, shutdown_release) = old_service.install_shutdown_barrier();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        old_service
            .apply_viewer_interest(
                99,
                ViewerInterestHint {
                    client_id: None,
                    dataset_id: dataset_id.clone(),
                    generation: 1,
                    t: 0,
                    z: 0,
                    channels: vec![0],
                    mode: ViewerInterestMode::Slice,
                    viewport: None,
                    desired_keys: vec![ViewerInterestChunkKey {
                        image_id: plan.image_id.clone(),
                        key: key.clone(),
                        lane: ViewerInterestLane::Visible,
                    }],
                    predicted_keys: vec![],
                    interaction: ViewerInteractionMode::Idle,
                    timestamp_ms: now_ms,
                    ttl_ms: 60_000,
                },
            )
            .await;
        let worker_permit =
            tokio::time::timeout(std::time::Duration::from_secs(1), worker_entered.acquire())
                .await
                .expect("old worker entered deterministic barrier")
                .expect("worker barrier remains open");
        worker_permit.forget();

        // Change source semantics without changing geometry, so an unfenced
        // old Ready update would still fit the new availability grid.
        let mut level: serde_json::Value =
            serde_json::from_slice(&fs::read(&level_path).unwrap()).unwrap();
        level["fill_value"] = serde_json::json!(1);
        level["chunk_grid"]["configuration"]["chunk_shape"] = serde_json::json!([1, 1, 1, 8, 8]);
        fs::write(&level_path, serde_json::to_vec_pretty(&level).unwrap()).unwrap();

        let replacement_ctx = ctx.clone();
        let replacement_url = url.clone();
        let (replacement_progress, _replacement_rx) = mpsc::unbounded_channel();
        let replacement = tokio::spawn(async move {
            open_dataset(2, &replacement_url, &replacement_ctx, &replacement_progress).await
        });
        let shutdown_permit = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            shutdown_entered.acquire(),
        )
        .await
        .expect("replacement reached old-service withdrawal")
        .expect("shutdown barrier remains open");
        shutdown_permit.forget();
        {
            let sess = ctx
                .session
                .try_lock()
                .expect("old-service cleanup must run after the publication fence");
            assert_ne!(
                sess.server_bindings[&dataset_id].source.revision, old_source.revision,
                "replacement must already be live before asynchronous cleanup"
            );
        }

        shutdown_release.add_permits(1);
        let replacement = replacement
            .await
            .expect("replacement task joined")
            .expect("replacement open succeeded");
        let DatasetOpenOutcome::Opened {
            opened: replacement_opened,
            ..
        } = replacement
        else {
            panic!("replacement open must complete");
        };
        worker_release.add_permits(1);
        assert!(old_service.is_shutdown().await);

        {
            let sess = ctx.session.lock().await;
            let binding = &sess.server_bindings[&dataset_id];
            assert_ne!(binding.source.revision, old_source.revision);
            assert!(!Arc::ptr_eq(&binding.derived_chunks, &old_cache));
            assert!(
                sess.generated_availability
                    .get(&dataset_id)
                    .and_then(|index| index.chunk(&plan.image_id, plan.level_index, &key))
                    .is_none(),
                "the blocked old worker cannot publish Ready into reset state"
            );
        }
        assert_eq!(
            replacement_opened.manifest.images()[0].multiscale.levels[0].shape,
            opened.manifest.images()[0].multiscale.levels[0].shape,
            "the replacement stays geometrically compatible"
        );

        // Defense in depth: even a late publisher that somehow outlives the
        // withdrawal barrier is rejected by cache-generation identity.
        let mut stale_rx = ctx.tx.subscribe();
        crate::generated_coarse::publish_generated_delta_for_test(
            dataset_id.clone(),
            GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: vec![lucida_protocol::GeneratedChunkStatusUpdate {
                    image_id: plan.image_id.clone(),
                    level_index: plan.level_index,
                    key: key.clone(),
                    status: lucida_protocol::GeneratedChunkStatus::Ready,
                    failure: None,
                    message: Some("stale old generation".into()),
                }],
            },
            Arc::clone(&old_cache),
            Arc::clone(&ctx.session),
            ctx.tx.clone(),
        )
        .await;
        assert!(
            ctx.session
                .lock()
                .await
                .generated_availability
                .get(&dataset_id)
                .and_then(|index| index.chunk(&plan.image_id, plan.level_index, &key))
                .is_none()
        );
        assert!(matches!(
            stale_rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn replacement_persistence_failure_leaves_old_generated_service_live() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("persist-failure.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();
        let (mut ctx, pool) = test_context_with_pool(tmp.path()).await;

        let (first_progress, _first_rx) = mpsc::unbounded_channel();
        let first = open_dataset(1, &url, &ctx, &first_progress)
            .await
            .expect("first open");
        let DatasetOpenOutcome::Opened { opened, .. } = first else {
            panic!("first open must complete");
        };
        let dataset_id = opened.manifest.dataset_id.clone();
        let (old_source, old_service) = {
            let sess = ctx.session.lock().await;
            let binding = &sess.server_bindings[&dataset_id];
            (
                binding.source.clone(),
                Arc::clone(&binding.generated_service),
            )
        };

        let level_path = data_dir.join("0/zarr.json");
        let mut level: serde_json::Value =
            serde_json::from_slice(&fs::read(&level_path).unwrap()).unwrap();
        level["shape"] = serde_json::json!([1, 1, 1, 8, 4]);
        fs::write(&level_path, serde_json::to_vec_pretty(&level).unwrap()).unwrap();
        sqlx::query(
            r#"
            CREATE TRIGGER fail_replacement_persist
            BEFORE UPDATE ON workspace_datasets
            BEGIN
                SELECT RAISE(ABORT, 'injected replacement persistence failure');
            END
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let (terminal, mut terminal_rx, terminal_sender) = terminal_lane("persist-failure").await;
        ctx.terminal = Some(terminal.clone());
        let (second_progress, _second_rx) = mpsc::unbounded_channel();
        let error = open_dataset(2, &url, &ctx, &second_progress)
            .await
            .expect_err("replacement persistence must fail at the injected trigger");
        assert_eq!(error.kind, DatasetOpenFailureKind::Persistence);
        publish_failure_after_open_error(&terminal, "persist-failure", &url, error);
        assert!(matches!(
            receive_terminal(&mut terminal_rx).await,
            ServerMessage::OpenDatasetFailed { request_id, .. }
                if request_id == "persist-failure"
        ));
        assert!(
            terminal_rx.try_recv().is_err(),
            "the preflighted success must be dropped, not published"
        );
        let restored = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            terminal_sender.reserve_terminal_slot(),
        )
        .await
        .expect("persistence failure leaked the shared slot")
        .expect("terminal lane remains open");
        drop(restored);
        assert!(
            !old_service.is_shutdown().await,
            "fallible persistence must complete before the old service is withdrawn"
        );
        let sess = ctx.session.lock().await;
        let binding = &sess.server_bindings[&dataset_id];
        assert_eq!(binding.source, old_source);
        assert!(Arc::ptr_eq(&binding.generated_service, &old_service));
        assert_eq!(sess.seq, 1);
    }

    #[tokio::test]
    async fn commit_task_join_failure_reuses_prepared_success_slot_for_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("commit-join-failure.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();
        let (mut ctx, pool) = test_context_with_pool(tmp.path()).await;
        let (terminal, mut terminal_rx, terminal_sender) = terminal_lane("join-failure").await;
        ctx.terminal = Some(terminal.clone());
        ctx.panic_commit_task = true;
        let (progress, _progress_rx) = mpsc::unbounded_channel();

        let error = open_dataset(7, &url, &ctx, &progress)
            .await
            .expect_err("injected commit-task panic must surface as a Join failure");
        assert_eq!(error.kind, DatasetOpenFailureKind::Persistence);
        assert_eq!(error.message, "workspace commit task failed");
        publish_failure_after_open_error(&terminal, "join-failure", &url, error);
        assert!(matches!(
            receive_terminal(&mut terminal_rx).await,
            ServerMessage::OpenDatasetFailed { request_id, .. }
                if request_id == "join-failure"
        ));
        assert!(
            terminal_rx.try_recv().is_err(),
            "unwinding the prepared success must not publish it"
        );
        let restored = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            terminal_sender.reserve_terminal_slot(),
        )
        .await
        .expect("Join failure leaked the shared slot")
        .expect("terminal lane remains open");
        drop(restored);

        let persisted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_datasets")
            .fetch_one(&pool)
            .await
            .expect("durable membership query");
        assert_eq!(persisted, 0);
        let sess = ctx.session.lock().await;
        assert_eq!(sess.seq, 0);
        assert!(sess.document.manifests.is_empty());
        assert!(sess.server_bindings.is_empty());
    }

    /// Concurrent opens of the same URL must converge on one binding and
    /// one document manifest, whichever open wins the import race — the
    /// loser rejoins via the post-import, under-lock generation re-check.
    #[tokio::test]
    async fn concurrent_opens_of_same_url_converge_to_one_binding() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("tiny.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();

        let ctx = test_context(tmp.path()).await;
        let (p1, _r1) = mpsc::unbounded_channel();
        let (p2, _r2) = mpsc::unbounded_channel();
        let (a, b) = tokio::join!(
            open_dataset(1, &url, &ctx, &p1),
            open_dataset(2, &url, &ctx, &p2),
        );

        let DatasetOpenOutcome::Opened {
            opened: opened_a, ..
        } = a.expect("open a")
        else {
            panic!("open a must complete");
        };
        let DatasetOpenOutcome::Opened {
            opened: opened_b, ..
        } = b.expect("open b")
        else {
            panic!("open b must complete");
        };
        assert_eq!(opened_a.manifest.dataset_id, opened_b.manifest.dataset_id);

        let sess = ctx.session.lock().await;
        assert_eq!(sess.server_bindings.len(), 1, "no duplicate binding");
        assert_eq!(sess.document.manifests.len(), 1, "no duplicate manifest");
        assert_eq!(sess.seq, 1, "exactly one DatasetOpened was applied");
    }

    /// The import step reads only metadata, so a metadata-only fixture is
    /// enough for the resolver to know the image; requesting actual chunk
    /// bytes would then hit the (absent) chunk objects and zero-fill —
    /// out of scope here.
    #[tokio::test]
    async fn open_reports_success_diagnostic_and_binds_session_state() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("tiny.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();

        let ctx = test_context(tmp.path()).await;
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();
        let outcome = open_dataset(9, &url, &ctx, &progress_tx)
            .await
            .expect("open");
        let DatasetOpenOutcome::Opened {
            seq,
            opened,
            diagnostic,
            ..
        } = outcome
        else {
            panic!("open must complete");
        };

        assert_eq!(seq, 1);
        assert_eq!(diagnostic.stage, DatasetOpenStage::Complete);
        assert_eq!(diagnostic.workspace_dataset_id, opened.manifest.dataset_id);
        let admitted_path = std::fs::canonicalize(&data_dir).unwrap();
        let admitted_url = admitted_path.to_string_lossy().to_string();
        assert_eq!(
            diagnostic.source_url, admitted_url,
            "the diagnostic reports the filesystem-resolved admitted source URL"
        );
        let source_dataset_id = lucida_content::url::SourceIdentity::parse(&admitted_url)
            .unwrap()
            .dataset_id();
        assert!(
            opened.manifest.dataset_id.0.starts_with("wds-"),
            "workspace document ids stay opaque and workspace-local"
        );
        assert_ne!(
            opened.manifest.dataset_id.0, source_dataset_id,
            "workspace identity must not leak the dedup/cache source identity"
        );
        assert_eq!(
            diagnostic.dataset_source_id.as_deref(),
            Some(source_dataset_id.as_str()),
            "diagnostics retain the independently-derived source identity"
        );
        assert_eq!(opened.opener_client_id, Some(9));

        drop(progress_tx);
        let stages = stages_of(&mut progress_rx);
        assert_eq!(
            stages,
            vec![
                DatasetOpenStage::RequestReceived,
                DatasetOpenStage::Authorization,
                DatasetOpenStage::Authorization,
                DatasetOpenStage::SourceLookup,
                DatasetOpenStage::SourceLookup,
                DatasetOpenStage::BackendOpen,
                DatasetOpenStage::MetadataImport,
                DatasetOpenStage::MetadataImport,
                DatasetOpenStage::BindingBuild,
                DatasetOpenStage::GeneratedCoarsePlanning,
                DatasetOpenStage::GeneratedCoarsePlanning,
                DatasetOpenStage::WorkspacePersist,
                DatasetOpenStage::WorkspacePersist,
                DatasetOpenStage::Broadcast,
            ],
        );

        let sess = ctx.session.lock().await;
        assert!(
            sess.server_bindings
                .contains_key(&opened.manifest.dataset_id)
        );
        assert!(
            sess.document
                .manifests
                .contains_key(&opened.manifest.dataset_id)
        );
    }
}
