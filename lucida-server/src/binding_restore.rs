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
use lucida_content::url::{dataset_url_hash16, normalize_dataset_url};
use lucida_protocol::{
    AssetCatalog, DatasetOpenFailureDiagnostic, DatasetOpened, GeneratedAvailabilityDelta,
};
use lucida_store::cache::CachedStore;
use tokio::sync::{Mutex, broadcast};

use crate::binding::{ChunkResolver, ServerBinding};
use crate::generated::{
    DerivedChunkCache, GeneratedCoarseConfig, GeneratedCoarseService, GeneratedSchedulingConfig,
    plan_generated_coarse_for_manifest,
};
use crate::open_diagnostics::{backend_open_failure, import_failure};
use crate::proxy::{ProxyCache, ProxyGenerator, proxy_catalog_entries_for_manifest};
use crate::session::Session;
use crate::workspace::types::WorkspaceDatasetSource;
use crate::{BroadcastItem, ProxyConfig};

/// Rebuild server-private dataset bindings for a lazily restored workspace.
///
/// The durable workspace document stores client-facing dataset state, but
/// operational chunk/proxy/generated services are intentionally not part of
/// `DocumentState`. On first open after a server restart, rebuild those
/// bindings from the structured `workspace_datasets → dataset_sources`
/// records before the first snapshot goes out.
pub async fn restore_workspace_bindings(
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    sources: Vec<WorkspaceDatasetSource>,
    proxy_config: ProxyConfig,
) {
    for source in sources {
        {
            let mut sess = session.lock().await;
            if sess
                .server_bindings
                .contains_key(&source.workspace_dataset_id)
            {
                continue;
            }
            sess.record_binding_source(
                source.workspace_dataset_id.clone(),
                normalize_dataset_url(&source.canonical_url),
                Some(source.dataset_source_id.clone()),
                source.display_name.clone(),
            );
        }
        if let Err(e) =
            restore_one_workspace_binding(Arc::clone(&session), tx.clone(), &source, &proxy_config)
                .await
        {
            {
                let mut sess = session.lock().await;
                sess.record_binding_restore_failure(
                    source.workspace_dataset_id.clone(),
                    normalize_dataset_url(&source.canonical_url),
                    Some(source.dataset_source_id.clone()),
                    source.display_name.clone(),
                    e.clone(),
                );
            }
            tracing::warn!(
                dataset_id = %source.workspace_dataset_id,
                dataset_source_id = %source.dataset_source_id,
                url = %source.canonical_url,
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
    tx: broadcast::Sender<BroadcastItem>,
    source: &WorkspaceDatasetSource,
    proxy_config: &ProxyConfig,
) -> Result<(), DatasetOpenFailureDiagnostic> {
    let canonical_url = normalize_dataset_url(&source.canonical_url);
    let dataset_id = source.workspace_dataset_id.0.clone();
    let dataset_id_key = DatasetId(dataset_id.clone());

    let store =
        lucida_store::backend::open(&canonical_url).map_err(|e| backend_open_failure(&e))?;
    let result = lucida_store::import::import_dataset(&store, &dataset_id, &source.display_name)
        .await
        .map_err(|e| import_failure(&e))?;

    let import_warnings: Vec<String> = result.warnings.iter().map(|w| w.message.clone()).collect();
    for warning in &result.warnings {
        tracing::warn!(
            dataset_id = %dataset_id,
            target = %warning.target,
            "workspace.binding_restore.import_warning: {}",
            warning.message,
        );
    }

    let catalog_entries =
        proxy_catalog_entries_for_manifest(&result.manifest, proxy_config.legacy_proxy_enabled);
    let dataset_opened = DatasetOpened {
        manifest: result.manifest.clone(),
        fetch: result.fetch,
        catalog: AssetCatalog {
            entries: catalog_entries.clone(),
        },
        // Server-side workspace restore has no originating client, so no peer
        // should auto-fit off this broadcast.
        opener_client_id: None,
    };

    let cached = Arc::new(CachedStore::new(store.clone(), 512 * 1024 * 1024));
    let resolver = Arc::new(ChunkResolver::new(&result.binding_seed));
    let generated_config = GeneratedCoarseConfig {
        target_long_axis: proxy_config.generated_target_long_axis,
        chunk_long_axis: proxy_config.generated_chunk_long_axis,
        max_chunk_bytes: proxy_config.generated_max_chunk_bytes,
    };
    let generated_plans = if proxy_config.generated_enabled {
        plan_generated_coarse_for_manifest(&result.manifest, generated_config)
    } else {
        vec![]
    };

    let url_hash16 = dataset_url_hash16(&canonical_url);
    let derived_chunks = Arc::new(DerivedChunkCache::new_on_disk_with_budget(
        proxy_config.generated_cache_dir.clone(),
        url_hash16,
        proxy_config.generated_disk_budget_bytes,
    ));
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
                derived_chunks.upsert_level(plan.availability.clone());
                generated_initial_delta
                    .levels
                    .push(plan.availability.clone());
            }
        }
    }
    let proxy_cache = Arc::new(ProxyCache::new(proxy_config.cache_dir.clone(), url_hash16));
    let generated_service = Arc::new(GeneratedCoarseService::new(
        generated_plans.clone(),
        Arc::new(result.manifest.clone()),
        cached.clone(),
        resolver.clone(),
        derived_chunks.clone(),
        Arc::clone(&session),
        tx,
        GeneratedSchedulingConfig {
            concurrency: proxy_config.generated_concurrency,
            background_chunk_limit: proxy_config.generated_background_chunk_limit,
            ..GeneratedSchedulingConfig::default()
        },
    ));
    generated_service.start();
    let proxy_generator = Arc::new(ProxyGenerator::new(
        proxy_cache.clone(),
        cached.clone(),
        resolver.clone(),
        Arc::new(result.manifest),
        proxy_config.concurrency,
    ));

    let binding = ServerBinding {
        source_url: canonical_url.clone(),
        store,
        resolver,
        cache: cached,
        dataset_opened,
        derived_chunks,
        generated_service: generated_service.clone(),
        legacy_proxy_enabled: proxy_config.legacy_proxy_enabled,
        proxy_cache,
        proxy_generator,
        import_warnings,
    };

    {
        let mut sess = session.lock().await;
        sess.record_binding_source(
            dataset_id_key.clone(),
            canonical_url,
            Some(source.dataset_source_id.clone()),
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
