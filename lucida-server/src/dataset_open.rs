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
use lucida_content::url::{dataset_id_for_url, dataset_url_hash16, normalize_dataset_url};
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientId, ServerMessage};
use lucida_protocol::{
    AssetCatalog, DatasetOpenFailureDiagnostic, DatasetOpenFailureKind,
    DatasetOpenProgressDiagnostic, DatasetOpenStage, DatasetOpenSuccessDiagnostic, DatasetOpened,
    GeneratedAvailabilityDelta,
};
use lucida_proxy::ProxySpec;
use lucida_store::cache::CachedStore;
use tokio::sync::{Mutex, broadcast, mpsc};

use crate::binding::{ChunkResolver, ServerBinding};
use crate::generated::{
    DerivedChunkCache, GeneratedCoarseConfig, GeneratedCoarseService, GeneratedSchedulingConfig,
    plan_generated_coarse_for_manifest,
};
use crate::open_diagnostics::{
    MetadataReadCost, backend_kind_for_url, backend_open_failure, import_failure, open_failure,
    open_progress, open_success, open_warning,
};
use crate::proxy::{
    PROXY_TARGET_LONG_AXIS, ProxyCache, ProxyGenerator, proxy_catalog_entries_for_manifest,
};
use crate::session::Session;
use crate::workspace::{LiveWorkspace, WorkspaceManager};
use crate::{BroadcastItem, ProxyConfig};

// `dataset_id_for_url` and `dataset_url_hash16` live in
// `lucida_content::url` so the SPA (via the `lucida-core` wasm shim),
// the storage layer, and this orchestration share one implementation. See
// `wiki/decisions/0042-canonical-dataset-url-form.md`.

/// The workspace scope a connection acts under: the live runtime handles,
/// the [`WorkspaceManager`] that owns authorization and persistence, and
/// the authenticated principal. `None` wherever it is optional means the
/// legacy non-workspace `/ws` session, which has no workspace
/// authorization at all — none is applied there.
#[derive(Clone)]
pub struct WorkspaceScope {
    pub live: Arc<LiveWorkspace>,
    pub manager: Arc<WorkspaceManager>,
    pub principal: AuthPrincipal,
}

/// Everything a dataset open runs against: the shared session + broadcast
/// hub it mutates, the proxy/generated configuration for the binding it
/// builds, and the (optional) workspace scope that authorizes and
/// persists the open.
#[derive(Clone)]
pub struct DatasetOpenContext {
    pub session: Arc<Mutex<Session>>,
    pub tx: broadcast::Sender<BroadcastItem>,
    pub proxy_config: ProxyConfig,
    pub workspace: Option<WorkspaceScope>,
}

/// Ordered sink for the per-stage progress diagnostics an open emits.
/// The orchestration only emits; the caller decides delivery (the
/// websocket adapter forwards each one to the requesting client, tests
/// collect them directly). Send failures are ignored — a caller that has
/// gone away stops observing progress, exactly like a disconnected
/// client, without aborting the open.
pub type ProgressSink = mpsc::UnboundedSender<DatasetOpenProgressDiagnostic>;

/// Terminal result of an open that did not fail with a diagnostic.
#[derive(Debug)]
pub enum DatasetOpenOutcome {
    /// The dataset is live in the session (freshly imported or joined via
    /// dedup) and the `DatasetOpened` broadcast has been sent.
    Opened {
        seq: u64,
        opened: Box<DatasetOpened>,
        diagnostic: DatasetOpenSuccessDiagnostic,
    },
    /// The workspace runtime shut down after the import completed; the
    /// open is abandoned with no further caller-visible outcome.
    Cancelled,
}

fn emit(progress: &ProgressSink, diagnostic: DatasetOpenProgressDiagnostic) {
    let _ = progress.send(diagnostic);
}

/// Open a dataset URL into the session: probe the storage backend, import
/// the OME-Zarr metadata, build the server binding, apply + broadcast
/// `DatasetOpened`, and (in a workspace) persist the membership.
///
/// The incoming `url` is normalized once at entry via
/// [`lucida_content::url::normalize_dataset_url`]; every downstream
/// derivation (`dataset_id_for_url` for source identity,
/// `dataset_url_hash16` for cache identity, `backend::open`, the
/// binding's `source_url`, and the name extraction) uses the canonical
/// form. Workspace clients receive an opaque workspace-local
/// `DatasetId`; the source-derived id is retained only for membership
/// dedupe and shared source/cache routing. This makes spelling variants
/// of the same path dedup to one source — see
/// `wiki/decisions/0042-canonical-dataset-url-form.md` for the rationale.
///
/// Concurrent opens of the same URL are safe: a fast pre-check reuses an
/// existing binding, and the apply step re-checks under the session lock
/// so a lost race drops its duplicate binding and rebroadcasts the
/// canonical `DatasetOpened` instead.
#[tracing::instrument(
    name = "dataset_open",
    skip(ctx, progress),
    fields(url = %url, client_id = %opener)
)]
pub async fn open_dataset(
    opener: ClientId,
    url: &str,
    ctx: &DatasetOpenContext,
    progress: &ProgressSink,
) -> Result<DatasetOpenOutcome, DatasetOpenFailureDiagnostic> {
    // Normalize at the input boundary. Drive-letter case, slash
    // direction, `file://` prefix, UNC backslashes — see ADR-0042.
    // Idempotent (safe even though `backend::open` will also normalize),
    // and required *here* because `dataset_id_for_url` /
    // `dataset_url_hash16` must hash the canonical form for the dedup
    // short-circuit to fire across spelling variants.
    let canonical_url = normalize_dataset_url(url);

    // Stable, content-derived source ID. This is intentionally not the
    // client-facing dataset ID inside a workspace: workspace document
    // state uses an opaque workspace-local ID so the same source can be
    // opened independently in different workspaces while sharing the
    // source/cache identity below.
    let dataset_source_id = dataset_id_for_url(&canonical_url);
    emit(
        progress,
        open_progress(
            DatasetOpenStage::RequestReceived,
            "dataset open request received",
            None,
            Some(dataset_source_id.clone()),
            Some(format!("normalized source: {canonical_url}")),
        ),
    );

    if let Some(scope) = ctx.workspace.as_ref()
        && scope.live.background_cancelled()
    {
        tracing::info!(
            client_id = %opener,
            workspace_id = %scope.live.workspace_id,
            url = %canonical_url,
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
            Some(dataset_source_id.clone()),
            ctx.workspace
                .as_ref()
                .map(|scope| format!("workspace: {}", scope.live.workspace_id)),
        ),
    );

    if let Some(scope) = ctx.workspace.as_ref()
        && let Err(e) = scope
            .manager
            .require_editor(&scope.live.workspace_id, &scope.principal)
            .await
    {
        tracing::warn!(
            client_id = %opener,
            workspace_id = %scope.live.workspace_id,
            url = %canonical_url,
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
            Some(dataset_source_id.clone()),
            ctx.workspace
                .as_ref()
                .map(|scope| format!("workspace: {}", scope.live.workspace_id)),
        ),
    );

    let existing_workspace_source = if let Some(scope) = ctx.workspace.as_ref() {
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
        match scope
            .manager
            .dataset_by_source(&scope.live.workspace_id, &dataset_source_id)
            .await
        {
            Ok(source) => source,
            Err(e) => {
                tracing::error!(
                    client_id = %opener,
                    workspace_id = %scope.live.workspace_id,
                    dataset_source_id = %dataset_source_id,
                    url = %canonical_url,
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
        }
    } else {
        None
    };

    let dataset_id_key = existing_workspace_source
        .as_ref()
        .map(|source| source.workspace_dataset_id.clone())
        .unwrap_or_else(|| {
            if ctx.workspace.is_some() {
                new_workspace_dataset_id()
            } else {
                DatasetId(dataset_source_id.clone())
            }
        });
    let dataset_id = dataset_id_key.0.clone();
    let workspace_scoped = ctx.workspace.is_some();
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

    // If we've already imported this URL in this session, reuse the binding.
    // Re-broadcast the existing DatasetOpened (held on the binding) so the
    // requesting client receives the same content graph + fetch descriptor
    // without re-importing.
    {
        let sess = ctx.session.lock().await;
        if let Some((existing_dataset_id, mut existing)) =
            find_loaded_binding(&sess, &dataset_id_key, &canonical_url, workspace_scoped)
        {
            // Re-broadcast the CURRENT document manifest, not the stale
            // import-time one cached on the binding: a `DatasetOpened` apply
            // does a full manifest replace, so reusing the cached manifest
            // here would clobber a since-applied rename (the document is the
            // source of truth for the display name). Other manifest fields
            // (images/transforms/source layouts) are immutable post-import, so
            // adopting the document copy is otherwise a no-op.
            if let Some(doc_manifest) = sess.document.manifests.get(&existing_dataset_id) {
                existing.manifest = doc_manifest.clone();
            }
            // Re-stamp the opener with the CURRENT requester. This is the
            // everyday multi-user path (someone opens a URL already loaded in
            // the session); the binding's cached copy holds whoever first
            // opened it (or None for a server-side restore), but the client
            // that just requested this open is the one whose camera should
            // auto-fit when the rebroadcast reaches it. Mirrors the lost-race
            // re-stamp below.
            existing.opener_client_id = Some(opener);
            let opened = existing.clone();
            let command = DocumentCommand::DatasetOpened(existing);
            let seq = sess.seq;
            drop(sess);
            emit(
                progress,
                open_progress(
                    DatasetOpenStage::BindingBuild,
                    "reusing existing server binding",
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
            let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };
            let _ = ctx.tx.send(BroadcastItem::CommandBroadcast {
                sender: u64::MAX,
                broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
                ack_json: String::new(),
            });
            tracing::info!(
                dataset_id = %existing_dataset_id,
                dataset_source_id = %dataset_source_id,
                url = %canonical_url,
                "open_remote_dataset.dedup_reuse"
            );
            let diagnostic = open_success(&canonical_url, &opened, Some(dataset_source_id.clone()));
            return Ok(DatasetOpenOutcome::Opened {
                seq,
                opened: Box::new(opened),
                diagnostic,
            });
        }
    }

    // Open storage backend. `backend::open` re-normalizes (idempotent)
    // and dispatches via `is_local_dataset_url`.
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
    let store = match lucida_store::backend::open(&canonical_url) {
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
        url = %canonical_url,
        id = %dataset_id,
        dataset_source_id = %dataset_source_id,
        name = %name,
        "importing dataset"
    );
    // The source cache is resolved here, BEFORE the import, and the import
    // reads through it: metadata objects are the first thing an open reads, they are
    // the largest single term in a remote open, and routing them through the
    // same `CachedStore` the chunk path uses is what makes them both cacheable
    // and visible to the source-cache instrumentation. The same Arc goes on to
    // back the binding, so nothing is read twice across the boundary — and it
    // is keyed by SOURCE, so a second workspace opening the same URL is served
    // from what the first one already read.
    let cached = CachedStore::shared_for_source(
        &dataset_source_id,
        store.clone(),
        lucida_store::cache::DEFAULT_SOURCE_CACHE_BYTES,
    );
    let reads_before = cached.stats();
    let result = match lucida_store::import::import_dataset(&cached, &dataset_id, &name).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "open_remote_dataset.import_failed");
            return Err(import_failure(&e));
        }
    };
    let import_reads = MetadataReadCost::between(&reads_before, &cached.stats());

    if let Some(scope) = ctx.workspace.as_ref()
        && scope.live.background_cancelled()
    {
        tracing::info!(
            client_id = %opener,
            workspace_id = %scope.live.workspace_id,
            dataset_id = %dataset_id,
            dataset_source_id = %dataset_source_id,
            "open_remote_dataset.cancelled_after_import"
        );
        return Ok(DatasetOpenOutcome::Cancelled);
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
        metadata_reads = import_reads.reads,
        metadata_read_millis = import_reads.read_millis,
        metadata_read_cache_hits = import_reads.hits,
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
                "entities: {n_entities}, images: {n_images}, first image levels: {n_levels}, {}",
                import_reads.summary()
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
    let proxy_config = &ctx.proxy_config;
    let resolver = Arc::new(ChunkResolver::new(&result.binding_seed));
    let generated_config = GeneratedCoarseConfig {
        target_long_axis: proxy_config.generated_target_long_axis,
        chunk_long_axis: proxy_config.generated_chunk_long_axis,
        max_chunk_bytes: proxy_config.generated_max_chunk_bytes,
    };
    emit(
        progress,
        open_progress(
            DatasetOpenStage::GeneratedCoarsePlanning,
            if proxy_config.generated_enabled {
                "planning generated coarse levels"
            } else {
                "generated coarse planning disabled"
            },
            Some(dataset_id_key.clone()),
            Some(dataset_source_id.clone()),
            None,
        ),
    );
    let generated_plans = if proxy_config.generated_enabled {
        plan_generated_coarse_for_manifest(&result.manifest, generated_config)
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

    // Legacy proxy fallback is opt-in after the coarse/detail default
    // flip. The default DatasetOpened catalog is empty so fallback
    // availability comes from chunk tier metadata instead of proxies.
    let catalog_entries =
        proxy_catalog_entries_for_manifest(&result.manifest, proxy_config.legacy_proxy_enabled);

    let dataset_opened = DatasetOpened {
        manifest: result.manifest.clone(),
        fetch: result.fetch,
        catalog: AssetCatalog {
            entries: catalog_entries.clone(),
        },
        // Stamp the requesting client so the broadcast's recipients can tell
        // whether they are the opener; only the opener auto-fits its camera.
        opener_client_id: Some(opener),
    };

    // Per-dataset proxy infrastructure. Cache root is keyed by the
    // 16-byte URL hash so a single shared `cache_dir` can host many
    // datasets without collision. The generator owns its own bounded
    // semaphore + in-flight dedup map.
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
                    "generated coarse derived-cache registration failed"
                );
                derived_chunks.upsert_level(plan.availability.clone());
                generated_initial_delta
                    .levels
                    .push(plan.availability.clone());
            }
        }
    }
    let proxy_cache = Arc::new(ProxyCache::new(proxy_config.cache_dir.clone(), url_hash16));
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

    // Clone for the (T=0, C=0) pre-generation task spawned below.
    let prefetch_generator = proxy_generator.clone();
    let prefetch_entries = catalog_entries.clone();
    let prefetch_live = ctx.workspace.as_ref().map(|scope| scope.live.clone());

    let binding = ServerBinding {
        source_url: canonical_url.clone(),
        store: store.clone(),
        resolver,
        cache: cached,
        dataset_opened: dataset_opened.clone(),
        derived_chunks: derived_chunks.clone(),
        generated_service: generated_service.clone(),
        legacy_proxy_enabled: proxy_config.legacy_proxy_enabled,
        proxy_cache,
        proxy_generator,
        import_warnings,
    };

    // Build DatasetOpened command (manifest + fetch, no server-private state).
    let command = DocumentCommand::DatasetOpened(dataset_opened);

    // Apply command and register server binding. Re-check the binding
    // presence under the lock in case a concurrent open raced ahead.
    let (seq, document) = {
        let mut sess = ctx.session.lock().await;
        if let Some((existing_dataset_id, mut existing)) =
            find_loaded_binding(&sess, &dataset_id_key, &canonical_url, workspace_scoped)
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
            let _ = ctx.tx.send(BroadcastItem::CommandBroadcast {
                sender: u64::MAX,
                broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
                ack_json: String::new(),
            });
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
            });
        }
        let seq = sess.apply(command.clone());
        if !generated_initial_delta.levels.is_empty() {
            sess.apply_generated_availability_delta(
                dataset_id_key.clone(),
                generated_initial_delta.clone(),
            );
        }
        sess.record_binding_source(
            dataset_id_key.clone(),
            canonical_url.clone(),
            Some(dataset_source_id.clone()),
            name.clone(),
        );
        sess.clear_binding_restore_failure(&dataset_id_key);
        sess.server_bindings.insert(dataset_id_key.clone(), binding);
        let document = sess.document.clone();
        (seq, document)
    };

    if ctx.workspace.is_some() {
        emit(
            progress,
            open_progress(
                DatasetOpenStage::WorkspacePersist,
                "persisting workspace dataset membership",
                Some(dataset_id_key.clone()),
                Some(dataset_source_id.clone()),
                Some(format!("seq: {seq}")),
            ),
        );
    }

    if let Some(scope) = ctx.workspace.as_ref()
        && let Err(e) = scope
            .manager
            .persist_dataset_opened(
                &scope.live,
                &dataset_id_key,
                &dataset_source_id,
                &canonical_url,
                &name,
                &scope.principal,
                seq,
                &document,
            )
            .await
    {
        tracing::error!(
            client_id = %opener,
            workspace_id = %scope.live.workspace_id,
            dataset_id = %dataset_id,
            dataset_source_id = %dataset_source_id,
            error = %e,
            "open_remote_dataset.persist_failed"
        );
        return Err(open_failure(
            DatasetOpenStage::WorkspacePersist,
            DatasetOpenFailureKind::Persistence,
            true,
            "workspace persistence failed",
            Some(e.to_string()),
        ));
    }

    if ctx.workspace.is_some() {
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

    // Broadcast to ALL clients including the requester.
    // Use u64::MAX as sender so no client matches — everyone gets the
    // CommandBroadcast (not an Ack), since the requester hasn't applied
    // the DatasetOpened locally.
    let opened = match &command {
        DocumentCommand::DatasetOpened(opened) => opened.clone(),
        _ => unreachable!("dataset open command must be DatasetOpened"),
    };
    let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };

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

    let _ = ctx.tx.send(BroadcastItem::CommandBroadcast {
        sender: u64::MAX,
        broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
        ack_json: String::new(), // unused — no client will match
    });

    if !generated_initial_delta.levels.is_empty() {
        let msg = ServerMessage::GeneratedAvailabilityUpdate {
            dataset_id: DatasetId(dataset_id.clone()),
            delta: generated_initial_delta.clone(),
        };
        let _ = ctx.tx.send(BroadcastItem::GeneratedAvailabilityUpdate {
            json: serde_json::to_string(&msg).unwrap(),
        });
    }

    tracing::info!(
        dataset_id = %dataset_id,
        seq,
        "open_remote_dataset.broadcast_sent"
    );

    // Background warm-up is deliberately decoupled from the returned
    // result: the caller can deliver success while coarse fill and proxy
    // pre-generation proceed on their own tasks.
    if !generated_plans.is_empty() {
        let fill_service = generated_service.clone();
        tokio::spawn(async move {
            fill_service.enqueue_background_fill().await;
        });
    }

    // Kick off background generation for the initial (T=0, C=0) view
    // of every advertised entity at the lowest priority. Errors are logged
    // but do not propagate — the open succeeds either way, and downstream
    // requests will surface the failure with their own error path.
    if !prefetch_entries.is_empty() {
        let dataset_id_for_log = dataset_id.clone();
        tokio::spawn(async move {
            for availability in prefetch_entries {
                for kind in availability.kinds {
                    if prefetch_live
                        .as_ref()
                        .is_some_and(|live| live.background_cancelled())
                    {
                        tracing::info!(
                            dataset = %dataset_id_for_log,
                            "background proxy pre-generation cancelled"
                        );
                        return;
                    }
                    let spec = ProxySpec {
                        entity_id: availability.entity_id.clone(),
                        kind,
                        t: 0,
                        c: 0,
                        target_long_axis: PROXY_TARGET_LONG_AXIS,
                    };
                    if let Err(e) = prefetch_generator.request(spec, 0).await {
                        tracing::warn!(
                            dataset = %dataset_id_for_log,
                            entity = %availability.entity_id.0,
                            kind = ?kind,
                            error = %e,
                            "background proxy pre-generation failed"
                        );
                    }
                }
            }
        });
    }

    let diagnostic = open_success(&canonical_url, &opened, Some(dataset_source_id));
    Ok(DatasetOpenOutcome::Opened {
        seq,
        opened: Box::new(opened),
        diagnostic,
    })
}

fn new_workspace_dataset_id() -> DatasetId {
    DatasetId(format!("wds-{}", uuid::Uuid::new_v4().simple()))
}

fn find_loaded_binding(
    sess: &Session,
    dataset_id: &DatasetId,
    canonical_url: &str,
    allow_source_url_match: bool,
) -> Option<(DatasetId, DatasetOpened)> {
    if sess.document.manifests.contains_key(dataset_id)
        && let Some(binding) = sess.server_bindings.get(dataset_id)
    {
        return Some((dataset_id.clone(), binding.dataset_opened.clone()));
    }

    if allow_source_url_match {
        for (existing_id, binding) in &sess.server_bindings {
            if binding.source_url == canonical_url
                && sess.document.manifests.contains_key(existing_id)
            {
                return Some((existing_id.clone(), binding.dataset_opened.clone()));
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::single_image_manifest;
    use lucida_content::DataType;
    use std::fs;
    use std::path::Path;

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
            catalog: lucida_protocol::AssetCatalog::default(),
            opener_client_id: None,
        }
    }

    /// Construct a `ServerBinding` carrying `opened` as its cached, import-time
    /// `dataset_opened`, with inert/stub proxy + generated infrastructure (none
    /// of it is exercised here). Mirrors the helper in
    /// `tests/dataset_id_stable.rs`.
    fn make_test_binding(source_url: &str, opened: &DatasetOpened) -> ServerBinding {
        let store =
            Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
        let cache = Arc::new(CachedStore::new(store.clone(), 1024));
        let resolver = Arc::new(ChunkResolver::new(
            &lucida_store::import_types::ServerBindingSeed { images: vec![] },
        ));
        let url_hash = lucida_content::url::dataset_url_hash16(source_url);
        let tmp = tempfile::tempdir().expect("tempdir");
        let proxy_cache = Arc::new(ProxyCache::new(tmp.path().to_path_buf(), url_hash));
        std::mem::forget(tmp); // keep the dir alive for the test process
        let proxy_generator = Arc::new(ProxyGenerator::new(
            proxy_cache.clone(),
            cache.clone(),
            resolver.clone(),
            Arc::new(opened.manifest.clone()),
            1,
        ));
        let derived_chunks = Arc::new(DerivedChunkCache::default());
        ServerBinding {
            source_url: source_url.to_string(),
            store,
            resolver,
            cache,
            dataset_opened: opened.clone(),
            derived_chunks: derived_chunks.clone(),
            generated_service: Arc::new(GeneratedCoarseService::inert(derived_chunks)),
            legacy_proxy_enabled: false,
            proxy_cache,
            proxy_generator,
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
        let (existing_dataset_id, mut existing) =
            find_loaded_binding(&session, &dataset_id, URL, true)
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

    /// A non-workspace open context whose proxy/generated caches live
    /// under `root` and whose generated planning is disabled, so nothing
    /// writes outside the test sandbox.
    fn test_context(root: &Path) -> DatasetOpenContext {
        let (tx, _rx) = broadcast::channel(64);
        DatasetOpenContext {
            session: Arc::new(Mutex::new(Session::new())),
            tx,
            proxy_config: ProxyConfig {
                cache_dir: root.join("proxies"),
                legacy_proxy_enabled: false,
                concurrency: 1,
                generated_enabled: false,
                generated_cache_dir: root.join("generated"),
                generated_concurrency: 1,
                generated_background_chunk_limit: 4,
                generated_target_long_axis: 64,
                generated_chunk_long_axis: 32,
                generated_max_chunk_bytes: 1024 * 1024,
                generated_disk_budget_bytes: None,
            },
            workspace: None,
        }
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
        let ctx = test_context(tmp.path());
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
                DatasetOpenStage::SourceLookup,
                DatasetOpenStage::BackendOpen,
            ],
            "failure must arrive after the exact per-stage progress sequence"
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
        let ctx = test_context(tmp.path());
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

        let ctx = test_context(tmp.path());
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

        // Both opens broadcast a server-originated (u64::MAX) DatasetOpened.
        let mut broadcasts = 0;
        while let Ok(item) = broadcast_rx.try_recv() {
            if let BroadcastItem::CommandBroadcast { sender, .. } = item {
                assert_eq!(sender, u64::MAX);
                broadcasts += 1;
            }
        }
        assert_eq!(broadcasts, 2);
    }

    /// Concurrent opens of the same URL must converge on one binding and
    /// one document manifest, whichever open wins the import race — the
    /// loser rejoins via the pre-check or the under-lock re-check.
    #[tokio::test]
    async fn concurrent_opens_of_same_url_converge_to_one_binding() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("tiny.zarr");
        fs::create_dir_all(&data_dir).unwrap();
        write_minimal_zarr(&data_dir);
        let url = data_dir.to_str().unwrap().to_string();

        let ctx = test_context(tmp.path());
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

        let ctx = test_context(tmp.path());
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();
        let outcome = open_dataset(9, &url, &ctx, &progress_tx)
            .await
            .expect("open");
        let DatasetOpenOutcome::Opened {
            seq,
            opened,
            diagnostic,
        } = outcome
        else {
            panic!("open must complete");
        };

        assert_eq!(seq, 1);
        assert_eq!(diagnostic.stage, DatasetOpenStage::Complete);
        assert_eq!(diagnostic.workspace_dataset_id, opened.manifest.dataset_id);
        assert_eq!(
            diagnostic.source_url,
            normalize_dataset_url(&url),
            "the diagnostic reports the canonical source URL"
        );
        // Non-workspace opens use the URL-derived source id as dataset id.
        assert_eq!(
            opened.manifest.dataset_id.0,
            dataset_id_for_url(&normalize_dataset_url(&url))
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
                DatasetOpenStage::BackendOpen,
                DatasetOpenStage::MetadataImport,
                DatasetOpenStage::MetadataImport,
                DatasetOpenStage::BindingBuild,
                DatasetOpenStage::GeneratedCoarsePlanning,
                DatasetOpenStage::GeneratedCoarsePlanning,
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
