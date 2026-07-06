//! Live workspace runtime: [`LiveWorkspace`] (the broadcast hub + shared
//! session for one open workspace) and [`WorkspaceManager`] (authorization,
//! lazy live-session restore, idle eviction, and every workspace operation
//! the HTTP surface exposes), plus [`WorkspaceError`] and its HTTP mapping.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use lucida_content::DatasetId;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::ServerMessage;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::DocumentState;
use serde_json::json;
use thiserror::Error;
use tokio::sync::{Mutex, broadcast};

use crate::session::Session;
use crate::{BroadcastItem, ProxyConfig, UnicastRoutes};

use super::store::{StoreError, WorkspaceStore, normalize_email};
use super::types::{
    SavedViewVisibility, WorkspaceAdminDetails, WorkspaceAdminSummary, WorkspaceDatasetSource,
    WorkspaceLinkAccess, WorkspaceMember, WorkspaceRecord, WorkspaceRole, WorkspaceSavedView,
    WorkspaceSharingSettings, WorkspaceSummary, WorkspaceUserState, WorkspaceViewerProfile,
};

const MAX_SAVED_VIEW_NAME_CHARS: usize = 200;
const MAX_VIEWER_PROFILE_NAME_CHARS: usize = 64;
pub(crate) const MAX_DATASET_NAME_CHARS: usize = 200;

pub struct LiveWorkspace {
    pub workspace_id: String,
    pub session: Arc<Mutex<Session>>,
    pub tx: broadcast::Sender<BroadcastItem>,
    pub unicast_routes: UnicastRoutes,
    next_id: AtomicU64,
    empty_since: Mutex<Option<Instant>>,
    background_cancelled: AtomicBool,
}

impl LiveWorkspace {
    fn new(workspace_id: String, session: Session) -> Self {
        let (tx, _) = broadcast::channel::<BroadcastItem>(256);
        Self {
            workspace_id,
            session: Arc::new(Mutex::new(session)),
            tx,
            unicast_routes: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(0),
            empty_since: Mutex::new(Some(Instant::now())),
            background_cancelled: AtomicBool::new(false),
        }
    }

    pub fn next_client_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn cancel_background(&self) -> bool {
        !self.background_cancelled.swap(true, Ordering::SeqCst)
    }

    pub fn background_cancelled(&self) -> bool {
        self.background_cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceRuntimeConfig {
    pub idle_ttl: Duration,
    pub idle_sweep_interval: Duration,
}

impl Default for WorkspaceRuntimeConfig {
    fn default() -> Self {
        Self {
            idle_ttl: Duration::from_secs(60 * 60),
            idle_sweep_interval: Duration::from_secs(60),
        }
    }
}

pub struct WorkspaceManager {
    store: Arc<dyn WorkspaceStore>,
    pub(crate) live: Mutex<HashMap<String, Arc<LiveWorkspace>>>,
    proxy_config: ProxyConfig,
    runtime_config: WorkspaceRuntimeConfig,
}

impl WorkspaceManager {
    pub fn new(store: Arc<dyn WorkspaceStore>, proxy_config: ProxyConfig) -> Self {
        Self::new_with_runtime_config(store, proxy_config, WorkspaceRuntimeConfig::default())
    }

    pub fn new_with_runtime_config(
        store: Arc<dyn WorkspaceStore>,
        proxy_config: ProxyConfig,
        runtime_config: WorkspaceRuntimeConfig,
    ) -> Self {
        Self {
            store,
            live: Mutex::new(HashMap::new()),
            proxy_config,
            runtime_config,
        }
    }

    pub fn store(&self) -> Arc<dyn WorkspaceStore> {
        Arc::clone(&self.store)
    }

    pub fn proxy_config(&self) -> ProxyConfig {
        self.proxy_config.clone()
    }

    pub fn runtime_config(&self) -> WorkspaceRuntimeConfig {
        self.runtime_config
    }

    pub fn spawn_idle_eviction_loop(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let interval = manager
                .runtime_config
                .idle_sweep_interval
                .max(Duration::from_secs(1));
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                let evicted = manager.evict_idle_workspaces().await;
                if evicted > 0 {
                    tracing::info!(evicted, "workspace.live_idle_sweep_evicted");
                }
            }
        })
    }

    pub async fn live_workspace_count(&self) -> usize {
        self.live.lock().await.len()
    }

    pub async fn evict_idle_workspaces(&self) -> usize {
        let ttl = self.runtime_config.idle_ttl;
        let candidates: Vec<_> = self.live.lock().await.values().cloned().collect();
        let mut evicted = 0usize;

        for live in candidates {
            let client_count = live.session.lock().await.clients.len();
            if client_count > 0 {
                *live.empty_since.lock().await = None;
                tracing::debug!(
                    workspace_id = %live.workspace_id,
                    client_count,
                    "workspace.live_eviction_skipped_active"
                );
                continue;
            }

            let idle_for = {
                let mut empty_since = live.empty_since.lock().await;
                let since = empty_since.get_or_insert_with(Instant::now);
                since.elapsed()
            };
            if idle_for < ttl {
                tracing::debug!(
                    workspace_id = %live.workspace_id,
                    idle_for_ms = idle_for.as_millis() as u64,
                    idle_ttl_ms = ttl.as_millis() as u64,
                    "workspace.live_eviction_skipped_ttl"
                );
                continue;
            }

            let removed = {
                let mut live_map = self.live.lock().await;
                match live_map.get(&live.workspace_id) {
                    Some(current) if Arc::ptr_eq(current, &live) => {
                        live_map.remove(&live.workspace_id)
                    }
                    _ => None,
                }
            };

            let Some(removed) = removed else {
                continue;
            };
            self.shutdown_live_workspace_background(&removed, "idle_eviction")
                .await;
            tracing::info!(
                workspace_id = %removed.workspace_id,
                idle_for_ms = idle_for.as_millis() as u64,
                "workspace.live_evicted"
            );
            evicted += 1;
        }

        evicted
    }

    pub async fn list_workspaces(
        &self,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSummary>, WorkspaceError> {
        self.store
            .list_workspaces(principal)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn list_archived_workspaces(
        &self,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSummary>, WorkspaceError> {
        self.store
            .list_archived_workspaces(principal)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn admin_search_workspaces(
        &self,
        query: Option<&str>,
        include_archived: bool,
        limit: usize,
    ) -> Result<Vec<WorkspaceAdminSummary>, WorkspaceError> {
        self.store
            .admin_search_workspaces(query, include_archived, limit)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn admin_workspace_details(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceAdminDetails, WorkspaceError> {
        self.store
            .admin_workspace_details(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn create_workspace(
        &self,
        principal: &AuthPrincipal,
        name: Option<&str>,
    ) -> Result<WorkspaceRecord, WorkspaceError> {
        self.store
            .create_workspace(principal, name)
            .await
            .map_err(WorkspaceError::Store)
    }

    /// Duplicate the source workspace into a private copy owned by the caller.
    ///
    /// Authorization: ANYONE who can *access* the source (any role, viewer
    /// included) may duplicate it — the copy becomes their own owned workspace.
    /// Access is checked via [`get_workspace_for`], so a non-member gets the
    /// uniform never-leak `NotFound` (byte-identical to a missing workspace):
    /// duplication must not reveal a workspace the caller can't see.
    ///
    /// The copy is named `Copy of <source name>` (an explicit `name` overrides
    /// this), created with the new-workspace defaults (restricted, owner-only,
    /// link OFF), and deep-copies datasets + Shared saved views + the document
    /// in one transaction — never the source's members or any permission. See
    /// [`WorkspaceStore::duplicate_workspace`].
    pub async fn duplicate_workspace(
        &self,
        source_workspace_id: &str,
        principal: &AuthPrincipal,
        name: Option<&str>,
    ) -> Result<WorkspaceRecord, WorkspaceError> {
        // Never-leak access check (viewer+ may duplicate; non-member → NotFound,
        // indistinguishable from missing). Also yields the source name.
        let (source, _role) = self
            .get_workspace_for(source_workspace_id, principal)
            .await?;
        let copy_name = match name.map(str::trim) {
            Some(explicit) if !explicit.is_empty() => explicit.to_string(),
            _ => format!("Copy of {}", source.name),
        };
        self.store
            .duplicate_workspace(source_workspace_id, principal, &copy_name)
            .await
            .map_err(WorkspaceError::Store)?
            // The source existed a moment ago (access check passed); a None here
            // means it was archived/removed between the check and the copy.
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn get_workspace_for(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<(WorkspaceRecord, WorkspaceRole), WorkspaceError> {
        // NEVER-LEAK (workspace-open path). This path is reachable by *anyone*
        // who is handed a `/w/<id>` deep-link (annotation share-by-link), so a
        // caller with no access must not be able to tell "exists but denied"
        // from "does not exist": both collapse to NotFound (404), byte-identical
        // to a missing row. This mirrors the saved-views never-leak discipline
        // (see `get_saved_view`). The role check therefore comes FIRST, and a
        // missing role yields NotFound, not Forbidden.
        //
        // Archived is surfaced (Gone/410) only to a real member — the one party
        // that already knows the workspace exists; to a non-member an archived
        // workspace is also indistinguishable from a missing one (NotFound).
        // The anyone-with-link grant is honored by `role_for` (active rows
        // only), so a valid link still resolves to a role → 200.
        let record = self
            .store
            .get_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        if record.archived_at.is_some() {
            // `role_for` excludes archived rows, so distinguish member from
            // non-member with an archive-state-agnostic membership lookup.
            return if self
                .store
                .member_role_for_any_state(workspace_id, principal)
                .await
                .map_err(WorkspaceError::Store)?
                .is_some()
            {
                Err(WorkspaceError::Archived)
            } else {
                Err(WorkspaceError::NotFound)
            };
        }
        let role = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        Ok((record, role))
    }

    pub async fn open_workspace_for(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<(WorkspaceRecord, WorkspaceRole, WorkspaceUserState), WorkspaceError> {
        let (record, role) = self.get_workspace_for(workspace_id, principal).await?;
        let user_state = self
            .store
            .record_workspace_open(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?;
        Ok((record, role, user_state))
    }

    pub async fn rename_workspace(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        name: &str,
    ) -> Result<WorkspaceRecord, WorkspaceError> {
        let role = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)?;
        if !role.can_own() {
            return Err(WorkspaceError::Forbidden);
        }
        self.store
            .rename_workspace(workspace_id, name)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn archive_workspace(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<(WorkspaceRecord, WorkspaceRole), WorkspaceError> {
        let role = self.require_owner(workspace_id, principal).await?;
        let record = self
            .store
            .archive_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        self.notify_workspace_archived(workspace_id).await;
        Ok((record, role))
    }

    pub async fn restore_workspace(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<(WorkspaceRecord, WorkspaceRole), WorkspaceError> {
        let role = self
            .require_owner_any_state(workspace_id, principal)
            .await?;
        let record = self
            .store
            .restore_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        Ok((record, role))
    }

    pub async fn admin_archive_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceAdminDetails, WorkspaceError> {
        self.store
            .archive_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        self.notify_workspace_archived(workspace_id).await;
        self.admin_workspace_details(workspace_id).await
    }

    pub async fn admin_restore_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceAdminDetails, WorkspaceError> {
        self.store
            .restore_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        self.admin_workspace_details(workspace_id).await
    }

    pub async fn sharing_settings(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceSharingSettings, WorkspaceError> {
        self.require_owner(workspace_id, principal).await?;
        self.store
            .sharing_settings(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn upsert_member(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        email: &str,
        display_name: Option<&str>,
        role: WorkspaceRole,
    ) -> Result<WorkspaceMember, WorkspaceError> {
        self.require_owner(workspace_id, principal).await?;
        let email = normalize_request_email(email)?;
        let settings = self.current_sharing_settings(workspace_id).await?;
        ensure_owner_retained(&settings, &email, Some(role))?;
        self.store
            .upsert_member(workspace_id, &email, display_name.unwrap_or(""), role)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn admin_upsert_owner(
        &self,
        workspace_id: &str,
        email: &str,
        display_name: Option<&str>,
    ) -> Result<WorkspaceMember, WorkspaceError> {
        let email = normalize_request_email(email)?;
        self.store
            .admin_upsert_owner(workspace_id, &email, display_name.unwrap_or(""))
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn update_member_role(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        email: &str,
        role: WorkspaceRole,
    ) -> Result<WorkspaceMember, WorkspaceError> {
        self.require_owner(workspace_id, principal).await?;
        let email = normalize_request_email(email)?;
        let settings = self.current_sharing_settings(workspace_id).await?;
        ensure_owner_retained(&settings, &email, Some(role))?;
        self.store
            .update_member_role(workspace_id, &email, role)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn remove_member(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        email: &str,
    ) -> Result<(), WorkspaceError> {
        self.require_owner(workspace_id, principal).await?;
        let email = normalize_request_email(email)?;
        let settings = self.current_sharing_settings(workspace_id).await?;
        ensure_owner_retained(&settings, &email, None)?;
        let removed = self
            .store
            .remove_member(workspace_id, &email)
            .await
            .map_err(WorkspaceError::Store)?;
        if removed {
            Ok(())
        } else {
            Err(WorkspaceError::NotFound)
        }
    }

    pub async fn update_link_access(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        link_access: WorkspaceLinkAccess,
        link_role: WorkspaceRole,
    ) -> Result<WorkspaceSharingSettings, WorkspaceError> {
        self.require_owner(workspace_id, principal).await?;
        if link_role.can_own() {
            return Err(WorkspaceError::BadRequest(
                "link role cannot be owner".to_string(),
            ));
        }
        self.store
            .update_link_access(workspace_id, link_access, link_role)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn list_saved_views(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSavedView>, WorkspaceError> {
        // Members only — a non-member is denied by the viewer gate before any
        // row is read. The shared-∪-own-(personal|proposed) filter is then
        // applied in SQL, scoped to this caller's normalized email; editors
        // additionally get every proposed view in the workspace (the #702
        // review queue), so the caller's edit-ness is pushed into the query.
        let role = self.require_viewer(workspace_id, principal).await?;
        self.store
            .list_saved_views(
                workspace_id,
                &normalize_email(&principal.email),
                role.can_edit(),
            )
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn get_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        let role = self.require_viewer(workspace_id, principal).await?;
        let saved_view = self
            .store
            .get_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        // Never-leak boundary: a personal view — and a pending proposed view —
        // is disclosed by the role-blind gate only to its creator; any other
        // caller gets NotFound, identical to a missing row, so existence is
        // never confirmed.
        //
        // The one role-dependent exception (#702): an *editor* reviewing the
        // workspace may read ANY pending proposal. It is layered here, not in
        // the pure gate, so the never-leak default stays deny-by-construction.
        // A rejected proposal becomes `Personal`, at which point this exception
        // no longer applies and the editor loses visibility unless it is their
        // own — exactly the personal-view boundary.
        match ensure_saved_view_readable(&saved_view, principal) {
            Ok(()) => Ok(saved_view),
            Err(err) => {
                if saved_view.visibility == SavedViewVisibility::Proposed && role.can_edit() {
                    Ok(saved_view)
                } else {
                    Err(err)
                }
            }
        }
    }

    pub async fn create_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        name: &str,
        view: SavedView,
        visibility: SavedViewVisibility,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        // Personal views are private and never mutate shared state, so any
        // member (viewer+) may save one. A Proposed view is a viewer's *bid* to
        // share: it likewise touches no shared state until an editor approves
        // it, so a plain viewer may create one too (#702). Only directly
        // creating a Shared view remains editor-gated.
        match visibility {
            SavedViewVisibility::Personal | SavedViewVisibility::Proposed => {
                self.require_viewer(workspace_id, principal).await?;
            }
            SavedViewVisibility::Shared => {
                self.require_editor(workspace_id, principal).await?;
            }
        }
        let name = normalize_saved_view_name(name)?;
        let view = workspace_saved_view_payload(view);
        self.store
            .create_saved_view(workspace_id, &name, principal, view, visibility)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn update_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
        name: Option<&str>,
        view: Option<SavedView>,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        // Mirror create/get: ownership of a personal view (or editor on a
        // shared view) is enforced before any mutation. A non-creator of a
        // personal view — including editors, owners, and admins — gets
        // NotFound and never confirms the row exists.
        self.ensure_saved_view_mutable(workspace_id, principal, saved_view_id)
            .await?;
        if name.is_none() && view.is_none() {
            return Err(WorkspaceError::BadRequest(
                "saved view patch is empty".to_string(),
            ));
        }
        let name = name.map(normalize_saved_view_name).transpose()?;
        let view = view.map(workspace_saved_view_payload);
        self.store
            .update_saved_view(workspace_id, saved_view_id, name.as_deref(), view)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn delete_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<(), WorkspaceError> {
        // Same ownership gate as update: a personal view can be deleted only by
        // its creator; a shared view requires editor. Everyone else gets
        // NotFound.
        self.ensure_saved_view_mutable(workspace_id, principal, saved_view_id)
            .await?;
        let deleted = self
            .store
            .delete_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?;
        if deleted {
            Ok(())
        } else {
            Err(WorkspaceError::NotFound)
        }
    }

    /// Promote/demote a saved view between `Personal` and `Shared`.
    ///
    /// Authorization is entirely delegated to `ensure_saved_view_rescopable`
    /// (the single re-scope gate); this method only persists the new
    /// visibility once the gate has returned the visible view. `created_by` is
    /// never written here, so attribution is preserved across the change.
    pub async fn set_saved_view_visibility(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
        visibility: SavedViewVisibility,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.ensure_saved_view_rescopable(workspace_id, principal, saved_view_id, visibility)
            .await?;
        self.store
            .set_saved_view_visibility(workspace_id, saved_view_id, visibility)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    /// Approve a viewer's proposed saved view (#702): it becomes `Shared`.
    ///
    /// This is **editor authority over another member's proposal**, which is
    /// fundamentally different from the creator-only re-scope path
    /// (`set_saved_view_visibility` / `ensure_saved_view_rescopable`): the
    /// approving editor is, by design, *not* the author. So it does NOT route
    /// through that creator-only gate. Instead `require_editor` is the single
    /// authority check — a viewer cannot approve (`Forbidden`).
    ///
    /// `created_by` is never written, so the proposer stays the author once the
    /// view goes shared (attribution is preserved). The view MUST currently be
    /// `Proposed`: approving an already-shared (or anyone's personal) view is a
    /// `BadRequest`, not a silent no-op — except that another member's personal
    /// view stays `NotFound` even to an editor, preserving the never-leak rule.
    ///
    /// **Self-approve guard (#817):** a proposer cannot be their own reviewer.
    /// The whole point of the review queue is that a *second* party signs off, so
    /// even an editor/owner who created the proposal may not approve it — that
    /// would reach `Proposed->Shared` with no reviewer, the exact transition the
    /// `/visibility` allow-list (`ensure_saved_view_rescopable`) forbids for the
    /// creator. The guard is placed here (the approve path), *after* the shared
    /// review gate, so (a) the readability/role checks in
    /// `ensure_proposal_reviewable` still run first — a stranger keeps getting
    /// `Forbidden`/`NotFound` and never learns the view exists — and (b) it does
    /// NOT apply to `reject_saved_view`: a creator self-rejecting is just
    /// withdrawing their own proposal (Proposed->Personal), which is already
    /// legal via `/visibility`. A sole editor wanting to share their own view
    /// uses the legal `Personal->Shared` re-scope directly; the queue is for a
    /// *different* editor. The denial is `Forbidden` (an authorization act on the
    /// view, like the creator-only re-scope gate), not `BadRequest` (a state
    /// error).
    pub async fn approve_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        let saved_view = self
            .ensure_proposal_reviewable(workspace_id, principal, saved_view_id)
            .await?;
        // Creator != reviewer: a proposer cannot self-approve. Reached only after
        // the shared gate has confirmed the caller may see and review the view,
        // so never-leak ordering is intact; scoped to approve so reject/withdraw
        // by the creator stays legal.
        if saved_view.created_by == normalize_email(&principal.email) {
            return Err(WorkspaceError::Forbidden);
        }
        self.store
            .set_saved_view_visibility(workspace_id, saved_view_id, SavedViewVisibility::Shared)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    /// Reject a viewer's proposed saved view (#702): it reverts to the
    /// proposer's own `Personal` view — non-destructive, the saved camera and
    /// attribution are untouched, the proposer simply keeps it privately.
    ///
    /// Same authority as `approve_saved_view`: `require_editor` (a viewer
    /// cannot reject), editor-over-another-member's-proposal, NOT the
    /// creator-only re-scope gate. The view MUST currently be `Proposed`
    /// (`BadRequest` otherwise; never-leak preserved for others' personal).
    pub async fn reject_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.ensure_proposal_reviewable(workspace_id, principal, saved_view_id)
            .await?;
        self.store
            .set_saved_view_visibility(workspace_id, saved_view_id, SavedViewVisibility::Personal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    /// The shared authority gate for the two editor review actions
    /// (`approve` / `reject`), kept distinct from the creator-only re-scope
    /// gate because the authority is genuinely different: here the reviewer is
    /// an editor acting on *someone else's* proposal.
    ///
    /// Order, and why:
    /// 1. `require_editor` — a viewer (or non-member) cannot review at all
    ///    (`Forbidden`); this is the entire authority for the action.
    /// 2. fetch — a missing id is `NotFound`.
    /// 3. never-leak guard — a `Personal` view that is not the editor's own is
    ///    still `NotFound`, exactly as the read gate would say, so reviewing a
    ///    proposal can never be used to probe for another member's hidden
    ///    personal views.
    /// 4. **must be `Proposed`** — any other (readable) state is a `BadRequest`;
    ///    approve/reject only ever act on a pending proposal.
    ///
    /// Returns the confirmed-`Proposed` view so callers can persist without
    /// re-fetching.
    async fn ensure_proposal_reviewable(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.require_editor(workspace_id, principal).await?;
        let saved_view = self
            .store
            .get_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        // Never-leak: another member's personal view is invisible even to an
        // editor, so reviewing cannot confirm it exists.
        if saved_view.visibility == SavedViewVisibility::Personal
            && saved_view.created_by != normalize_email(&principal.email)
        {
            return Err(WorkspaceError::NotFound);
        }
        if saved_view.visibility != SavedViewVisibility::Proposed {
            return Err(WorkspaceError::BadRequest(
                "saved view is not a pending proposal".to_string(),
            ));
        }
        Ok(saved_view)
    }

    /// The single mutation-authorization gate for saved views, mirroring the
    /// read path. Membership is required first (a non-member gets `Forbidden`
    /// before any row is read, exactly like `get_saved_view`); the row is then
    /// fetched and funnelled through `ensure_saved_view_readable`, so a
    /// personal view that is not the caller's own yields `NotFound` and is
    /// never confirmed to exist — for editors, owners, and admins alike. Only
    /// after the view is confirmed visible do `Shared` views additionally
    /// require editor, leaving today's shared-view behavior intact while
    /// letting a viewer mutate their own personal view (as `create` allows a
    /// viewer to make one). Routing both `update` and `delete` through here
    /// keeps the never-leak rule in one place.
    async fn ensure_saved_view_mutable(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        let saved_view = self
            .store
            .get_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        ensure_saved_view_readable(&saved_view, principal)?;
        if saved_view.visibility == SavedViewVisibility::Shared {
            self.require_editor(workspace_id, principal).await?;
        }
        Ok(saved_view)
    }

    /// The single authorization gate for *changing a saved view's visibility*
    /// (re-scoping it between `Personal` and `Shared`), kept separate from the
    /// read gate (`get_saved_view`) and the content-mutation gate
    /// (`ensure_saved_view_mutable`) because the authority is genuinely
    /// different: re-scoping is restricted to the **creator**, and *who else*
    /// is allowed depends on the *target* visibility.
    ///
    /// The check order — and the reasons — are:
    /// 1. `require_viewer` — a non-member is denied (`Forbidden`) before any
    ///    row is read, so membership is never disclosed by a re-scope attempt.
    /// 2. fetch + `ensure_saved_view_readable` — never-leak in one place: a
    ///    personal (or pending proposed) view the caller cannot see yields
    ///    `NotFound` (identical to a missing row), so even editors/owners/admins
    ///    never learn it exists.
    /// 3. **creator-only** — a shared view is readable by everyone, but only
    ///    the original creator may re-scope it; anyone else gets `Forbidden`.
    /// 4. **transition allow-list** — the source→target re-scope must be one of
    ///    the legal creator transitions (`saved_view_transition_allowed`); any
    ///    other pair is `BadRequest`. This is the structural gate (#817): it
    ///    rejects `Shared→Proposed` and, crucially, `Proposed→Shared` — the
    ///    self-approve bypass — so sharing a proposal stays exclusively the
    ///    editor review queue's job (`approve_saved_view`), never `/visibility`.
    ///    A same-state request is an idempotent no-op and falls through to a
    ///    (value-preserving) persist by the caller.
    /// 5. **target-visibility authority** — making a view `Shared` is a
    ///    shared-state mutation (exactly like creating a `Shared` view), so it
    ///    additionally requires editor; demoting back to `Personal`, or
    ///    proposing, needs no editor (the creator is acting on their own view).
    ///    Checked last so an illegal transition is `BadRequest` regardless of
    ///    the caller's role — the deny is by construction, not role-dependent.
    ///
    /// Returns the (now-confirmed-visible) view so callers can persist without
    /// re-fetching. The #702 review actions (`approve_saved_view` /
    /// `reject_saved_view`, the Proposed→Shared / Proposed→Personal review
    /// queue) deliberately do NOT route through this creator-only gate: their
    /// authority is an *editor acting on another member's* proposal, so they use
    /// `ensure_proposal_reviewable` instead — keeping the review queue the only
    /// path that shares a proposal.
    async fn ensure_saved_view_rescopable(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
        target_visibility: SavedViewVisibility,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        let saved_view = self
            .store
            .get_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        // Never-leak: a personal view the caller didn't create is NotFound.
        ensure_saved_view_readable(&saved_view, principal)?;
        // Creator-only: re-scoping is an authorship act, not a read or a
        // content edit. A non-creator (even of a shared view) cannot re-scope.
        if saved_view.created_by != normalize_email(&principal.email) {
            return Err(WorkspaceError::Forbidden);
        }
        // Transition allow-list: close the gate by construction. Anything not on
        // the creator allow-list — notably Shared→Proposed and the
        // Proposed→Shared self-approve bypass — is rejected here, before the
        // role check, so the deny is structural rather than role-dependent.
        if !saved_view_transition_allowed(saved_view.visibility, target_visibility) {
            return Err(WorkspaceError::BadRequest(format!(
                "cannot change saved view visibility from {} to {}",
                saved_view.visibility.as_str(),
                target_visibility.as_str()
            )));
        }
        // Target-visibility authority: promoting to Shared mutates shared
        // state, so it needs editor; demoting to Personal does not.
        if target_visibility == SavedViewVisibility::Shared {
            self.require_editor(workspace_id, principal).await?;
        }
        Ok(saved_view)
    }

    pub async fn set_default_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: Option<&str>,
    ) -> Result<(WorkspaceRecord, WorkspaceRole), WorkspaceError> {
        let role = self.require_editor(workspace_id, principal).await?;
        if let Some(saved_view_id) = saved_view_id {
            let saved_view = self
                .store
                .get_saved_view(workspace_id, saved_view_id)
                .await
                .map_err(WorkspaceError::Store)?
                .ok_or(WorkspaceError::NotFound)?;
            // A workspace-wide default must be shared: pointing it at a personal
            // view would surface that view to every member through the default,
            // breaking the never-leak invariant. Reject rather than leak.
            if saved_view.visibility != SavedViewVisibility::Shared {
                return Err(WorkspaceError::BadRequest(
                    "a personal saved view cannot be the workspace default".to_string(),
                ));
            }
        }
        self.store
            .set_default_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .map(|record| (record, role))
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn get_viewer_profile(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        profile: &str,
    ) -> Result<Option<WorkspaceViewerProfile>, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        let profile = normalize_viewer_profile_name(profile)?;
        self.store
            .get_viewer_profile(workspace_id, &principal.email, &profile)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn upsert_viewer_profile(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        profile: &str,
        seed_source: Option<&str>,
        view: SavedView,
    ) -> Result<WorkspaceViewerProfile, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        let profile = normalize_viewer_profile_name(profile)?;
        let view = workspace_saved_view_payload(view);
        self.store
            .upsert_viewer_profile(workspace_id, principal, &profile, seed_source, view)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn set_workspace_pinned(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        pinned: bool,
    ) -> Result<WorkspaceUserState, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        self.store
            .set_workspace_pinned(workspace_id, principal, pinned)
            .await
            .map_err(WorkspaceError::Store)
    }

    /// Record the caller's own last-open view (#700). Any member (viewer+)
    /// may remember their own view; the write is scoped to
    /// `(workspace_id, principal.email)` and stores ONLY the per-user
    /// `last_view` — it never mutates the shared `default_saved_view_id`.
    /// Source URLs are stripped (mirroring `upsert_viewer_profile`) since
    /// workspace views address datasets by workspace-local id.
    pub async fn set_user_workspace_last_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        view: SavedView,
    ) -> Result<WorkspaceUserState, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        let view = workspace_saved_view_payload(view);
        self.store
            .set_user_workspace_last_view(workspace_id, principal, view)
            .await
            .map_err(WorkspaceError::Store)
    }

    /// Read the caller's own workspace state including `last_view` (#700).
    /// `require_viewer` gates access; the store keys on `principal.email`, so
    /// the result is the caller's own row only — never another member's, and
    /// `last_view = None` when they've never recorded one.
    pub async fn get_user_workspace_state(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceUserState, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        self.store
            .get_user_workspace_state_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn live_workspace(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Arc<LiveWorkspace>, WorkspaceError> {
        let (_record, _role) = self.get_workspace_for(workspace_id, principal).await?;

        if let Some(live) = self.live.lock().await.get(workspace_id).cloned() {
            tracing::debug!(workspace_id, "workspace.live_reused");
            return Ok(live);
        }

        let record = self
            .store
            .get_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        let mut session = Session::new();
        session.document = record.document;
        session.seq = record.seq;
        let live = Arc::new(LiveWorkspace::new(workspace_id.to_string(), session));
        let sources = self
            .store
            .list_dataset_sources(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?;
        tracing::info!(
            workspace_id,
            seq = record.seq,
            dataset_sources = sources.len(),
            "workspace.live_restore_started"
        );
        crate::binding_restore::restore_workspace_bindings(
            Arc::clone(&live.session),
            live.tx.clone(),
            sources,
            self.proxy_config.clone(),
        )
        .await;
        self.live
            .lock()
            .await
            .insert(workspace_id.to_string(), Arc::clone(&live));
        tracing::info!(workspace_id, "workspace.live_loaded");
        Ok(live)
    }

    pub async fn require_viewer(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceRole, WorkspaceError> {
        self.store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)
    }

    pub async fn require_editor(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceRole, WorkspaceError> {
        let role = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)?;
        if role.can_edit() {
            Ok(role)
        } else {
            Err(WorkspaceError::Forbidden)
        }
    }

    pub async fn require_owner(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceRole, WorkspaceError> {
        let role = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)?;
        if role.can_own() {
            Ok(role)
        } else {
            Err(WorkspaceError::Forbidden)
        }
    }

    pub async fn require_owner_any_state(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceRole, WorkspaceError> {
        self.store
            .owner_role_for_any_state(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)
    }

    async fn notify_workspace_archived(&self, workspace_id: &str) {
        let live = self.live.lock().await.remove(workspace_id);
        let Some(live) = live else {
            return;
        };
        let msg = ServerMessage::WorkspaceArchived {
            workspace_id: workspace_id.to_string(),
        };
        let _ = live.tx.send(BroadcastItem::WorkspaceArchived {
            json: serde_json::to_string(&msg).unwrap(),
        });
        self.shutdown_live_workspace_background(&live, "archive")
            .await;
        tracing::info!(workspace_id, "workspace.live_archived_cancelled");
    }

    async fn shutdown_live_workspace_background(&self, live: &LiveWorkspace, reason: &str) {
        let first_cancel = live.cancel_background();
        let services: Vec<_> = {
            let sess = live.session.lock().await;
            sess.server_bindings
                .values()
                .map(|binding| binding.generated_service.clone())
                .collect()
        };
        for service in &services {
            service.shutdown(reason).await;
        }
        tracing::info!(
            workspace_id = %live.workspace_id,
            reason,
            first_cancel,
            generated_services = services.len(),
            "workspace.live_background_cancelled"
        );
    }

    pub async fn persist_applied_command(
        &self,
        live: &LiveWorkspace,
        command: &DocumentCommand,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), WorkspaceError> {
        match command {
            DocumentCommand::RemoveDataset { id } => {
                self.store
                    .persist_dataset_removed(&live.workspace_id, id, seq, document)
                    .await
            }
            _ => {
                self.store
                    .persist_document(&live.workspace_id, seq, document)
                    .await
            }
        }
        .map_err(WorkspaceError::Store)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn persist_dataset_opened(
        &self,
        live: &LiveWorkspace,
        workspace_dataset_id: &DatasetId,
        dataset_source_id: &str,
        canonical_url: &str,
        display_name: &str,
        added_by: &AuthPrincipal,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), WorkspaceError> {
        self.store
            .persist_dataset_opened(
                &live.workspace_id,
                workspace_dataset_id,
                dataset_source_id,
                canonical_url,
                display_name,
                &added_by.email,
                seq,
                document,
            )
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn dataset_by_source(
        &self,
        workspace_id: &str,
        dataset_source_id: &str,
    ) -> Result<Option<WorkspaceDatasetSource>, WorkspaceError> {
        self.store
            .dataset_by_source(workspace_id, dataset_source_id)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn dataset_by_workspace_dataset(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
    ) -> Result<Option<WorkspaceDatasetSource>, WorkspaceError> {
        self.store
            .dataset_by_workspace_dataset(workspace_id, workspace_dataset_id)
            .await
            .map_err(WorkspaceError::Store)
    }

    /// Rename a workspace dataset's display label, the right way: mutate the
    /// shared collaborative document so the change broadcasts to co-present
    /// peers and survives reopen, and keep the server-private DB
    /// `display_name` in sync so listings and restored bindings agree.
    ///
    /// The new name flows as a `DocumentCommand::RenameDataset`, returned to
    /// the caller (the WS handler) so it can broadcast + ack it on the live
    /// channel exactly like every other document command — that is what
    /// delivers it live to peers. Persistence is handled here:
    /// [`Store::persist_dataset_renamed`] writes both the `workspace_datasets`
    /// row and the full `document_json` in one transaction, so reopening the
    /// workspace (which loads `document_json` into `session.document`) shows
    /// the new name.
    ///
    /// Authority + safety, role-first to preserve never-leak:
    /// 1. `require_editor` — a viewer or non-member gets `Forbidden` before
    ///    any document/row is read (uniform with `open_remote_dataset` and the
    ///    other editor-gated mutations).
    /// 2. validation — empty/whitespace/over-long names are `BadRequest`.
    /// 3. the dataset must exist in the live document — a missing id is
    ///    `NotFound`, identical to a dataset that was never opened, so the
    ///    rename never confirms which ids exist.
    ///
    /// Returns the applied `(seq, command)` so the handler can broadcast.
    pub async fn rename_dataset(
        &self,
        live: &LiveWorkspace,
        principal: &AuthPrincipal,
        workspace_dataset_id: &DatasetId,
        name: &str,
    ) -> Result<(u64, DocumentCommand), WorkspaceError> {
        // 1. Authority first — never read the document for a non-editor.
        self.require_editor(&live.workspace_id, principal).await?;

        // 2. Validate before mutating anything.
        let name = normalize_dataset_name(name)?;

        let command = DocumentCommand::RenameDataset {
            id: workspace_dataset_id.clone(),
            name: name.clone(),
        };

        // 3. Apply to the live session, but only if the dataset actually
        //    exists in the document. A missing id is NotFound (never-leak),
        //    not a silent no-op that would still bump seq and persist.
        let (seq, document) = {
            let mut sess = live.session.lock().await;
            if !sess.document.manifests.contains_key(workspace_dataset_id) {
                return Err(WorkspaceError::NotFound);
            }
            let seq = sess.apply(command.clone());
            (seq, sess.document.clone())
        };

        // 4. Persist: workspace_datasets.display_name + document_json together.
        self.store
            .persist_dataset_renamed(
                &live.workspace_id,
                workspace_dataset_id,
                &name,
                seq,
                &document,
            )
            .await
            .map_err(WorkspaceError::Store)?;

        Ok((seq, command))
    }

    /// Apply a client-issued document command to the live workspace: editor
    /// gate first, then apply to the shared session, then persist. Together
    /// with [`Self::rename_dataset`] (which adds validation and DB
    /// display-name sync on top of the same editor gate) this is the single
    /// authorization + persistence path for workspace-scoped document
    /// commands — the WS handler only translates the returned
    /// `(seq, command)` or [`CommandApplyError`] into wire traffic, it
    /// holds no policy.
    ///
    /// The error is split by phase (see [`CommandApplyError`]): a role that
    /// denies is `Forbidden`, a role lookup that *errors* is
    /// `GateUnavailable` (transient store failure is not an authorization
    /// verdict), and `PersistFailed` means the command HAS already been
    /// applied to the in-memory session (the seq advanced) — the caller
    /// must not broadcast it, so peers converge again from the next
    /// snapshot.
    pub async fn apply_document_command(
        &self,
        live: &LiveWorkspace,
        principal: &AuthPrincipal,
        command: DocumentCommand,
    ) -> Result<(u64, DocumentCommand), CommandApplyError> {
        match self.require_editor(&live.workspace_id, principal).await {
            Ok(_) => {}
            Err(WorkspaceError::Store(e)) => return Err(CommandApplyError::GateUnavailable(e)),
            Err(_) => return Err(CommandApplyError::Forbidden),
        }
        let (seq, document) = {
            let mut sess = live.session.lock().await;
            let seq = sess.apply(command.clone());
            (seq, sess.document.clone())
        };
        self.persist_applied_command(live, &command, seq, &document)
            .await
            .map_err(CommandApplyError::PersistFailed)?;
        Ok((seq, command))
    }

    /// Resolve the persisted source for a dataset-retry request: editor
    /// gate first (retrying rebuilds server bindings — the same authority
    /// as opening the dataset), then the membership lookup. `Ok(None)`
    /// means the workspace has no such dataset row.
    ///
    /// A role lookup that *errors* surfaces as `WorkspaceError::Store`,
    /// deliberately distinct from `Forbidden`: transient store failure is
    /// not an authorization verdict, so transports report it as retryable
    /// lookup trouble rather than a denial.
    pub async fn dataset_source_for_retry(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        workspace_dataset_id: &DatasetId,
    ) -> Result<Option<WorkspaceDatasetSource>, WorkspaceError> {
        self.require_editor(workspace_id, principal).await?;
        self.dataset_by_workspace_dataset(workspace_id, workspace_dataset_id)
            .await
    }

    async fn current_sharing_settings(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceSharingSettings, WorkspaceError> {
        self.store
            .sharing_settings(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }
}

fn normalize_request_email(email: &str) -> Result<String, WorkspaceError> {
    let normalized = normalize_email(email);
    if normalized.is_empty() || !normalized.contains('@') {
        return Err(WorkspaceError::BadRequest(
            "member email is invalid".to_string(),
        ));
    }
    Ok(normalized)
}

/// The never-leak rule for non-shared views, in one place: a `Personal` view —
/// and a still-pending `Proposed` view — is readable here only by its creator
/// (matched on normalized email); everyone else is told `NotFound` so the
/// row's existence is never confirmed. `Shared` views are readable by any
/// viewer (membership is enforced upstream).
///
/// This gate is intentionally **role-blind**: the editor review exception for
/// `Proposed` views (an editor may read *any* member's pending proposal) is
/// genuinely role-dependent and is therefore layered at the manager
/// (`get_saved_view`, `list_saved_views`, `approve`/`reject`), not here.
/// Keeping the pure match creator-only means a refactor cannot accidentally
/// disclose another viewer's pending proposal: the default is always deny.
pub(crate) fn ensure_saved_view_readable(
    saved_view: &WorkspaceSavedView,
    principal: &AuthPrincipal,
) -> Result<(), WorkspaceError> {
    match saved_view.visibility {
        SavedViewVisibility::Shared => Ok(()),
        SavedViewVisibility::Personal | SavedViewVisibility::Proposed => {
            if saved_view.created_by == normalize_email(&principal.email) {
                Ok(())
            } else {
                Err(WorkspaceError::NotFound)
            }
        }
    }
}

/// The creator-driven `/visibility` transition allow-list — the *only* source→
/// target re-scopes the direct REST endpoint may perform, closed by
/// construction so an illegal transition is unreachable rather than merely
/// unsent by today's web UI.
///
/// Allowed (all by the creator; the `→Shared` editor authority is enforced
/// separately by the caller, not here):
/// - `Personal → Shared`  (creator shares; caller additionally requires editor)
/// - `Shared   → Personal` (creator makes their own shared view private again)
/// - `Personal → Proposed` (creator proposes their view for review)
/// - `Proposed → Personal` (creator withdraws their own pending proposal)
/// - a same-state request (`X → X`) — an idempotent no-op (`Ok`), so a benign
///   "set it to what it already is" never errors.
///
/// Everything else is `BadRequest`. In particular this is what closes the gate
/// on the two illegal direct transitions #817 calls out:
/// - `Shared   → Proposed` — a shared view cannot be demoted into the review
///   queue.
/// - `Proposed → Shared` — the self-approve bypass: a creator (even an editor)
///   cannot move their OWN proposal straight to shared and skip the editor
///   review queue. Sharing a proposal is exclusively `approve_saved_view`'s job
///   (editor authority over *another member's* bid), never `/visibility`.
pub(crate) fn saved_view_transition_allowed(
    source: SavedViewVisibility,
    target: SavedViewVisibility,
) -> bool {
    use SavedViewVisibility::{Personal, Proposed, Shared};
    // Same-state is always an idempotent no-op.
    if source == target {
        return true;
    }
    matches!(
        (source, target),
        (Personal, Shared) | (Shared, Personal) | (Personal, Proposed) | (Proposed, Personal)
    )
}

fn normalize_saved_view_name(raw: &str) -> Result<String, WorkspaceError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(WorkspaceError::BadRequest(
            "saved view name is empty".to_string(),
        ));
    }
    if trimmed.chars().count() > MAX_SAVED_VIEW_NAME_CHARS {
        return Err(WorkspaceError::BadRequest(format!(
            "saved view name exceeds {MAX_SAVED_VIEW_NAME_CHARS} characters"
        )));
    }
    Ok(trimmed.to_string())
}

/// Validate + canonicalize a dataset display name. Mirrors
/// [`normalize_saved_view_name`]: an empty/whitespace-only name is a
/// `BadRequest` (a blank layer label is meaningless), and an over-long name is
/// a `BadRequest`. The trimmed form is what gets stored, so leading/trailing
/// whitespace never lands in the document or the DB.
fn normalize_dataset_name(raw: &str) -> Result<String, WorkspaceError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(WorkspaceError::BadRequest(
            "dataset name is empty".to_string(),
        ));
    }
    if trimmed.chars().count() > MAX_DATASET_NAME_CHARS {
        return Err(WorkspaceError::BadRequest(format!(
            "dataset name exceeds {MAX_DATASET_NAME_CHARS} characters"
        )));
    }
    Ok(trimmed.to_string())
}

fn normalize_viewer_profile_name(raw: &str) -> Result<String, WorkspaceError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(WorkspaceError::BadRequest(
            "viewer profile name is empty".to_string(),
        ));
    }
    if trimmed.chars().count() > MAX_VIEWER_PROFILE_NAME_CHARS {
        return Err(WorkspaceError::BadRequest(format!(
            "viewer profile name exceeds {MAX_VIEWER_PROFILE_NAME_CHARS} characters"
        )));
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(WorkspaceError::BadRequest(
            "viewer profile may contain only letters, numbers, '-', '_', or '.'".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn workspace_saved_view_payload(mut view: SavedView) -> SavedView {
    // Workspace saved views refer to datasets by workspace-local ids in
    // dataset_order/dataset_settings/active_layouts. Source URLs belong
    // to workspace_datasets and must not be copied into the saved-view row.
    view.datasets.clear();
    view
}

fn ensure_owner_retained(
    settings: &WorkspaceSharingSettings,
    target_email: &str,
    next_role: Option<WorkspaceRole>,
) -> Result<(), WorkspaceError> {
    let Some(existing) = settings
        .members
        .iter()
        .find(|member| member.email == target_email)
    else {
        return Ok(());
    };
    if existing.role != WorkspaceRole::Owner {
        return Ok(());
    }

    let owners = settings
        .members
        .iter()
        .filter(|member| member.role == WorkspaceRole::Owner)
        .count();
    let remains_owner = next_role == Some(WorkspaceRole::Owner);
    if owners <= 1 && !remains_owner {
        return Err(WorkspaceError::BadRequest(
            "workspace must retain at least one owner".to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace not found")]
    NotFound,
    #[error("workspace is archived")]
    Archived,
    #[error("forbidden")]
    Forbidden,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("{0}")]
    Store(StoreError),
}

/// Failure modes of [`WorkspaceManager::apply_document_command`], split by
/// phase so the transport can report each one truthfully instead of
/// collapsing them into a single verdict.
#[derive(Debug, Error)]
pub enum CommandApplyError {
    /// The principal's role denies the command. Nothing was applied.
    #[error("forbidden")]
    Forbidden,
    /// The editor gate could not be evaluated: the role lookup itself
    /// failed. Nothing was applied. A transient store failure is not an
    /// authorization denial — callers should surface it as retryable
    /// infrastructure trouble, never as a permissions verdict.
    #[error("workspace role lookup failed: {0}")]
    GateUnavailable(StoreError),
    /// The command WAS applied to the in-memory session (the seq advanced)
    /// but persistence failed. The caller must not broadcast it, so peers
    /// converge again from the next snapshot.
    #[error("{0}")]
    PersistFailed(WorkspaceError),
}

impl WorkspaceError {
    pub fn into_response(self) -> Response {
        let (status, code, detail) = match self {
            WorkspaceError::NotFound => (StatusCode::NOT_FOUND, "not_found", None),
            WorkspaceError::Archived => (StatusCode::GONE, "workspace_archived", None),
            WorkspaceError::Forbidden => (StatusCode::FORBIDDEN, "forbidden", None),
            WorkspaceError::BadRequest(detail) => {
                (StatusCode::BAD_REQUEST, "bad_request", Some(detail))
            }
            WorkspaceError::Store(e) => {
                tracing::error!(error = %e, "workspaces.store_error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_store_error",
                    None,
                )
            }
        };
        let body = match detail {
            Some(detail) => json!({ "error": code, "detail": detail }),
            None => json!({ "error": code }),
        };
        (status, Json(body)).into_response()
    }
}
