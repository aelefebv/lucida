//! Workspace binding restore: rebuild the server-private
//! [`ServerBinding`]s (chunk resolver, caches, generated-coarse service)
//! for a lazily reopened workspace from its persisted
//! `workspace_datasets → dataset_sources` records.
//!
//! Runs on workspace wake ([`WorkspaceManager::live_workspace`]), before
//! the live session is published; per-dataset failures are recorded on
//! the session and surfaced through dataset health rather than aborting
//! the wake. This module deliberately depends only on
//! [`crate::workspace::types`] — never the manager — so the workspace
//! layer can call it without any import cycle, and it shares its failure
//! classification ([`crate::open_diagnostics`]) with the interactive open
//! path so both report the same diagnostic vocabulary.
//!
//! [`WorkspaceManager::live_workspace`]: crate::workspace::WorkspaceManager::live_workspace

use std::sync::Arc;

use lucida_content::DatasetId;
use lucida_content::url::SourceVersion;
use lucida_core::command::DocumentCommand;
use lucida_protocol::{
    DatasetOpenFailureDiagnostic, DatasetOpenFailureKind, DatasetOpenStage, DatasetOpened,
    GeneratedAvailabilityDelta,
};
use lucida_store::cache::CachedStore;
use tokio::sync::Mutex;

use crate::binding::{ChunkResolver, ServerBinding};
use crate::generated_coarse::{
    DerivedChunkCache, GeneratedCoarseConfig, GeneratedCoarseService, GeneratedSchedulingConfig,
    GeneratedStatusBudget, plan_generated_coarse_for_source,
};
use crate::open_diagnostics::{
    backend_open_failure, dataset_opened_validation_failure, import_failure, open_failure,
    source_policy_failure,
};
use crate::session::Session;
use crate::workspace::store::WorkspaceStore;
use crate::workspace::types::WorkspaceDatasetSource;
use crate::{BroadcastSender, DatasetRuntimeConfig};

/// Rebuild server-private dataset bindings for a lazily restored workspace.
///
/// The durable workspace document stores client-facing dataset state, but
/// operational chunk/generated services are intentionally not part of
/// `DocumentState`. On first open after a server restart, rebuild those
/// bindings from the structured `workspace_datasets → dataset_sources`
/// records before the first snapshot goes out.
pub(crate) async fn restore_workspace_bindings(
    session: Arc<Mutex<Session>>,
    tx: BroadcastSender,
    workspace_id: &str,
    persistence: Arc<dyn WorkspaceStore>,
    sources: Vec<WorkspaceDatasetSource>,
    dataset_runtime: DatasetRuntimeConfig,
    generated_status_budget: Arc<GeneratedStatusBudget>,
) {
    for source in sources {
        if session
            .lock()
            .await
            .server_bindings
            .contains_key(&source.workspace_dataset_id)
        {
            continue;
        }
        let redacted_source = dataset_runtime
            .source_policy
            .redact_untrusted(source.identity.locator.as_str());
        if let Err(e) = restore_one_workspace_binding(
            Arc::clone(&session),
            tx.clone(),
            workspace_id,
            Arc::clone(&persistence),
            &source,
            &dataset_runtime,
            Arc::clone(&generated_status_budget),
        )
        .await
        {
            {
                let mut sess = session.lock().await;
                sess.record_binding_restore_failure(
                    source.workspace_dataset_id.clone(),
                    redacted_source.clone(),
                    Some(source.identity.dataset_id()),
                    source.display_name.clone(),
                    e.clone(),
                );
            }
            tracing::warn!(
                dataset_id = %source.workspace_dataset_id,
                dataset_source_id = %source.identity.dataset_id(),
                source = %redacted_source,
                error = %e.message,
                stage = ?e.stage,
                kind = ?e.kind,
                retryable = e.retryable,
                "workspace.binding_restore_failed"
            );
        }
    }
}

async fn restore_one_workspace_binding(
    session: Arc<Mutex<Session>>,
    tx: BroadcastSender,
    workspace_id: &str,
    persistence: Arc<dyn WorkspaceStore>,
    source: &WorkspaceDatasetSource,
    dataset_runtime: &DatasetRuntimeConfig,
    generated_status_budget: Arc<GeneratedStatusBudget>,
) -> Result<(), DatasetOpenFailureDiagnostic> {
    let admitted = dataset_runtime
        .source_policy
        .admit(source.identity.locator.as_str())
        .await
        .map_err(|error| source_policy_failure(&error))?;
    let canonical_url = admitted.canonical_url().to_string();
    let dataset_source_id = source.identity.dataset_id();
    let dataset_id = source.workspace_dataset_id.0.clone();
    let dataset_id_key = DatasetId(dataset_id.clone());

    if admitted.identity != source.identity {
        return Err(open_failure(
            DatasetOpenStage::Authorization,
            DatasetOpenFailureKind::Persistence,
            false,
            "persisted source identity no longer matches admitted locator",
            None,
        ));
    }

    let store = admitted
        .open_backend()
        .map_err(|error| backend_open_failure(&error))?;
    let result = lucida_store::import::import_dataset_with_shared_cache(
        &store,
        &dataset_id,
        &source.display_name,
        Arc::clone(&dataset_runtime.source_cache),
    )
    .await
    .map_err(|e| import_failure(&e))?;
    let source_version = SourceVersion::new(source.identity.clone(), result.source_revision);

    let import_warnings: Vec<String> = result.warnings.iter().map(|w| w.message.clone()).collect();
    for warning in &result.warnings {
        tracing::warn!(
            dataset_id = %dataset_id,
            target = %warning.target,
            "workspace.binding_restore.import_warning: {}",
            warning.message,
        );
    }

    let dataset_opened = DatasetOpened {
        manifest: result.manifest.clone(),
        fetch: result.fetch,
        // Server-side workspace restore has no originating client, so no peer
        // should auto-fit off this broadcast.
        opener_client_id: None,
    };
    // Restore is an admission boundary too: persisted membership never makes
    // a freshly imported manifest/fetch mismatch safe to register.
    dataset_opened
        .validate()
        .map_err(|error| dataset_opened_validation_failure(&error))?;

    if source.revision != Some(result.source_revision) {
        let command = DocumentCommand::DatasetOpened(dataset_opened.clone());
        let mut sess = session.lock().await;
        let staged = sess.stage_durable_document(command).map_err(|error| {
            open_failure(
                DatasetOpenStage::WorkspacePersist,
                DatasetOpenFailureKind::Persistence,
                false,
                "restored source generation exceeds document limits",
                Some(error.to_string()),
            )
        })?;
        let seq = staged.seq();
        persistence
            .persist_dataset_refreshed(
                workspace_id,
                &dataset_id_key,
                &source_version,
                &source.display_name,
                seq,
                staged.document(),
            )
            .await
            .map_err(|error| {
                open_failure(
                    DatasetOpenStage::WorkspacePersist,
                    DatasetOpenFailureKind::Persistence,
                    true,
                    "restored source generation could not be persisted",
                    Some(error.to_string()),
                )
            })?;
        sess.commit_staged_document(staged);
    }

    let cached = Arc::new(CachedStore::with_source_version(
        store.clone(),
        &source_version,
        Arc::clone(&dataset_runtime.source_cache),
    ));
    let resolver = Arc::new(ChunkResolver::new(&result.binding_seed));
    let generated_config = GeneratedCoarseConfig {
        target_long_axis: dataset_runtime.generated_target_long_axis,
        chunk_long_axis: dataset_runtime.generated_chunk_long_axis,
        max_chunk_bytes: dataset_runtime.generated_max_chunk_bytes,
    };
    let generated_plans = if dataset_runtime.generated_enabled {
        plan_generated_coarse_for_source(&result.manifest, result.source_revision, generated_config)
    } else {
        vec![]
    };

    let derived_chunks = Arc::new(
        DerivedChunkCache::new_on_disk_for_source_with_status_budget(
            dataset_runtime.generated_cache_dir.clone(),
            &source_version,
            dataset_runtime.generated_disk_budget_bytes,
            Arc::clone(&dataset_runtime.source_cache),
            generated_status_budget,
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
                    "workspace.binding_restore.generated_registration_failed"
                );
                let retained = derived_chunks.upsert_level(plan.availability.clone());
                generated_initial_delta.levels.extend(retained.levels);
            }
        }
    }
    let generated_service = Arc::new(GeneratedCoarseService::new(
        generated_plans.clone(),
        Arc::new(result.manifest.clone()),
        cached.clone(),
        resolver.clone(),
        derived_chunks.clone(),
        Arc::clone(&session),
        tx,
        GeneratedSchedulingConfig {
            concurrency: dataset_runtime.generated_concurrency,
            background_chunk_limit: dataset_runtime.generated_background_chunk_limit,
            ..GeneratedSchedulingConfig::default()
        },
    ));
    generated_service.start();
    let binding = ServerBinding {
        source: source_version,
        store,
        resolver,
        cache: cached,
        dataset_opened,
        derived_chunks,
        generated_service: generated_service.clone(),
        import_warnings,
    };

    {
        let mut sess = session.lock().await;
        sess.record_binding_source(
            dataset_id_key.clone(),
            canonical_url,
            Some(dataset_source_id),
            source.display_name.clone(),
        );
        sess.clear_binding_restore_failure(&dataset_id_key);
        if !generated_initial_delta.levels.is_empty() {
            sess.apply_generated_availability_delta(
                dataset_id_key.clone(),
                generated_initial_delta.clone(),
            );
        }
        sess.server_bindings.insert(dataset_id_key, binding);
    }
    if !generated_plans.is_empty() {
        // Enqueue inline (unlike the interactive open, which spawns this
        // step so the requester's success reply is not held behind queue
        // admission): restore runs during workspace wake, before the live
        // session is published to any client, so nothing is waiting on a
        // reply — and finishing the enqueue here keeps the wake sequence
        // deterministic: bindings registered and fill queued before the
        // first snapshot goes out.
        generated_service.enqueue_background_fill().await;
    }
    Ok(())
}
