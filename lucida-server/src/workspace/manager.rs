//! Live workspace runtime: [`LiveWorkspace`] (the broadcast hub + shared
//! session for one open workspace) and [`WorkspaceManager`] (authorization,
//! lazy live-session restore, idle eviction, and every workspace operation
//! the HTTP surface exposes), plus [`WorkspaceError`] and its HTTP mapping.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use chrono::{DateTime, Utc};
use lucida_content::DatasetId;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientId, CommandRejection, ServerMessage};
use lucida_core::saved_view::SavedView;
use lucida_core::scene::DocumentState;
use lucida_store::source_policy::SourcePolicy;
use serde_json::json;
use thiserror::Error;
use tokio::sync::{Mutex, MutexGuard, broadcast};

use crate::connection::{
    CLOSE_ACCESS_REVOKED, CLOSE_WORKSPACE_ARCHIVED, CLOSE_WORKSPACE_RELOADED, ClientSender,
    CloseRequest,
};
use crate::inbox::InboxStore;
use crate::session::Session;
use crate::{BroadcastItem, GeneratedConfig, UnicastRoutes};

use super::preview::{MIN_PREVIEW_INTERVAL, PreviewError, retry_after_secs, validate_preview};
use super::store::{StoreError, WorkspaceStore, normalize_email};
use super::types::{
    NewWorkspacePreview, PreviewWrite, SavedViewVisibility, WorkspaceAdminDetails,
    WorkspaceAdminSummary, WorkspaceDatasetSource, WorkspaceLinkAccess, WorkspaceMember,
    WorkspacePreview, WorkspacePreviewMeta, WorkspaceRecord, WorkspaceRole, WorkspaceSavedView,
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
    /// One document write at a time, held from reading the seq through
    /// persisting, applying, and broadcasting. Persisting first keeps memory
    /// from holding a command the database refused, and holding the turn
    /// through the broadcast sends seqs to peers in order. Separate from the
    /// session lock so a database write never stalls chunk serving or
    /// presence.
    document_turn: Mutex<()>,
    empty_since: Mutex<Option<Instant>>,
    background_cancelled: AtomicBool,
    connections: std::sync::Mutex<Connections>,
}

#[derive(Default)]
struct Connections {
    /// Who each open socket acts as, so a membership change can find the
    /// sockets it took access from.
    open: HashMap<ClientId, (AuthPrincipal, ClientSender)>,
    /// Set once the workspace stops serving. Kept under the same lock as
    /// `open`, so a socket that registers after its peers were closed is
    /// closed the same way rather than served alone.
    closed: Option<CloseRequest>,
}

impl LiveWorkspace {
    fn new(workspace_id: String, session: Session, broadcast_capacity: usize) -> Self {
        let (tx, _) = broadcast::channel::<BroadcastItem>(broadcast_capacity);
        Self {
            workspace_id,
            session: Arc::new(Mutex::new(session)),
            tx,
            unicast_routes: Arc::new(Mutex::new(HashMap::new())),
            document_turn: Mutex::new(()),
            empty_since: Mutex::new(Some(Instant::now())),
            background_cancelled: AtomicBool::new(false),
            connections: std::sync::Mutex::default(),
        }
    }

    /// Wait for the workspace's document turn. Every change to the document
    /// takes it first; see the field.
    pub async fn document_turn(&self) -> MutexGuard<'_, ()> {
        self.document_turn.lock().await
    }

    /// Send an applied command to every peer, and its ack to `sender`.
    pub fn broadcast_command(&self, sender: ClientId, seq: u64, command: DocumentCommand) {
        let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };
        let ack_msg = ServerMessage::Ack { seq };
        let _ = self.tx.send(BroadcastItem::CommandBroadcast {
            sender,
            broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
            ack_json: serde_json::to_string(&ack_msg).unwrap(),
        });
    }

    /// Forget a socket that ended.
    pub fn detach_connection(&self, id: ClientId) {
        self.lock_connections().open.remove(&id);
    }

    fn lock_connections(&self) -> std::sync::MutexGuard<'_, Connections> {
        self.connections.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn connections(&self) -> Vec<(ClientId, AuthPrincipal, ClientSender)> {
        self.lock_connections()
            .open
            .iter()
            .map(|(id, (principal, sender))| (*id, principal.clone(), sender.clone()))
            .collect()
    }

    /// Close every socket, and any that registers from now on, as `request`
    /// says. The first request wins, as it does for one socket.
    fn close_all(&self, request: CloseRequest) {
        let senders: Vec<ClientSender> = {
            let mut connections = self.lock_connections();
            connections.closed.get_or_insert(request.clone());
            connections
                .open
                .values()
                .map(|(_, sender)| sender.clone())
                .collect()
        };
        for sender in senders {
            sender.request_close(request.clone());
        }
    }

    fn close_one(&self, id: ClientId, request: CloseRequest) {
        let sender = self
            .lock_connections()
            .open
            .get(&id)
            .map(|(_, sender)| sender.clone());
        if let Some(sender) = sender {
            sender.request_close(request);
        }
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
    /// How many broadcast items a live workspace buffers per connection. A
    /// connection that falls further behind than this skips ahead and is
    /// repaired with a fresh snapshot.
    pub broadcast_capacity: usize,
}

impl Default for WorkspaceRuntimeConfig {
    fn default() -> Self {
        Self {
            idle_ttl: Duration::from_secs(60 * 60),
            idle_sweep_interval: Duration::from_secs(60),
            broadcast_capacity: 256,
        }
    }
}

pub struct WorkspaceManager {
    store: Arc<dyn WorkspaceStore>,
    inbox: Option<Arc<dyn InboxStore>>,
    pub(crate) live: Mutex<HashMap<String, Arc<LiveWorkspace>>>,
    generated_config: GeneratedConfig,
    source_policy: Arc<SourcePolicy>,
    runtime_config: WorkspaceRuntimeConfig,
}

impl WorkspaceManager {
    pub fn new(store: Arc<dyn WorkspaceStore>, generated_config: GeneratedConfig) -> Self {
        Self::new_with_runtime_config(store, generated_config, WorkspaceRuntimeConfig::default())
    }

    pub fn new_with_runtime_config(
        store: Arc<dyn WorkspaceStore>,
        generated_config: GeneratedConfig,
        runtime_config: WorkspaceRuntimeConfig,
    ) -> Self {
        Self {
            store,
            inbox: None,
            live: Mutex::new(HashMap::new()),
            generated_config,
            source_policy: Arc::default(),
            runtime_config,
        }
    }

    /// Set where this server's workspaces may open datasets from. Without
    /// it every location opens.
    #[must_use]
    pub fn with_source_policy(mut self, policy: Arc<SourcePolicy>) -> Self {
        self.source_policy = policy;
        self
    }

    /// Attach the workspace inbox, so a **Send report** arriving on a
    /// workspace socket has somewhere to land.
    ///
    /// Set beside the constructors rather than through them because the
    /// inbox is not part of what makes a workspace work: a manager
    /// without one serves every other message as it always did, and
    /// tells a sender that this server keeps no inbox.
    #[must_use]
    pub fn with_inbox(mut self, inbox: Arc<dyn InboxStore>) -> Self {
        self.inbox = Some(inbox);
        self
    }

    pub fn store(&self) -> Arc<dyn WorkspaceStore> {
        Arc::clone(&self.store)
    }

    /// The inbox this server keeps, or `None` where none was attached.
    pub fn inbox(&self) -> Option<Arc<dyn InboxStore>> {
        self.inbox.clone()
    }

    pub fn generated_config(&self) -> GeneratedConfig {
        self.generated_config.clone()
    }

    pub fn source_policy(&self) -> Arc<SourcePolicy> {
        Arc::clone(&self.source_policy)
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
    /// Anyone who can access the source, viewers included, may duplicate it.
    /// Access goes through [`get_workspace_for`], so a non-member gets the
    /// same `NotFound` as for a missing workspace. The copy is named
    /// `Copy of <source name>` unless `name` is given, starts with the
    /// new-workspace defaults (restricted, owner-only, link off), and never
    /// copies members or permissions. See [`WorkspaceStore::duplicate_workspace`].
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
        // Never-leak: anyone handed a `/w/<id>` link reaches this path, so a
        // caller without access must not tell "exists but denied" from "does
        // not exist". Both are NotFound, byte-identical to a missing row, so
        // the role check comes first and a missing role is NotFound, not
        // Forbidden. Archived (410) is shown only to a real member. The
        // anyone-with-link grant is honored by `role_for`.
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
        let member = self
            .store
            .upsert_member(workspace_id, &email, display_name.unwrap_or(""), role)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        self.close_revoked_connections(workspace_id).await;
        Ok(member)
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
        let member = self
            .store
            .update_member_role(workspace_id, &email, role)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        self.close_revoked_connections(workspace_id).await;
        Ok(member)
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
        if !removed {
            return Err(WorkspaceError::NotFound);
        }
        self.close_revoked_connections(workspace_id).await;
        Ok(())
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
        let settings = self
            .store
            .update_link_access(workspace_id, link_access, link_role)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        self.close_revoked_connections(workspace_id).await;
        Ok(settings)
    }

    pub async fn list_saved_views(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSavedView>, WorkspaceError> {
        // Members only — a non-member is denied by the viewer gate before any
        // row is read. The shared-∪-own-(personal|proposed) filter is then
        // applied in SQL, scoped to this caller's normalized email; editors
        // additionally get every proposed view in the workspace (the
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
        // Never-leak: a personal view, or a pending proposed one, is shown by
        // the role-blind gate only to its creator. Anyone else gets NotFound,
        // identical to a missing row.
        //
        // The one role-dependent exception: an editor may read any pending
        // proposal. It is layered here, not in the pure gate, so the default
        // stays deny-by-construction. A rejected proposal becomes `Personal`
        // and the exception stops applying.
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
        // it, so a plain viewer may create one too. Only directly
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

    /// Approve a viewer's proposed saved view: it becomes `Shared`.
    ///
    /// This is editor authority over another member's proposal, so it skips
    /// the creator-only re-scope gate and `require_editor` is the authority
    /// check. `created_by` is never written, so the proposer stays the
    /// author. The view must be `Proposed`, or the call is `BadRequest`,
    /// except that another member's personal view stays `NotFound`.
    ///
    /// A proposer cannot approve their own proposal, even as an editor: the
    /// review queue exists so a second party signs off. The guard runs after
    /// `ensure_proposal_reviewable`, so a stranger still never learns the
    /// view exists. It does not apply to `reject_saved_view`, where a creator
    /// is only withdrawing. The denial is `Forbidden`, not `BadRequest`.
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

    /// Reject a viewer's proposed saved view: it reverts to the proposer's
    /// own `Personal` view, with the saved camera and attribution untouched.
    ///
    /// Same authority as `approve_saved_view`. The view must currently be
    /// `Proposed` (`BadRequest` otherwise; never-leak preserved for others'
    /// personal views).
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

    /// The shared authority gate for approve and reject, separate from the
    /// creator-only re-scope gate because here an editor acts on someone
    /// else's proposal.
    ///
    /// Order: `require_editor` (`Forbidden`), fetch (`NotFound`), then
    /// never-leak (another member's `Personal` view is still `NotFound`, so
    /// review cannot probe for hidden views), then the view must be
    /// `Proposed` (`BadRequest`). Returns the view so callers can persist
    /// without re-fetching.
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
    /// read path. Membership comes first (a non-member gets `Forbidden` before
    /// any row is read), then `ensure_saved_view_readable`, so another
    /// member's personal view is `NotFound` even for editors and admins. Only
    /// a visible `Shared` view also requires editor. Both `update` and
    /// `delete` route through here to keep the never-leak rule in one place.
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

    /// The single authorization gate for re-scoping a saved view's
    /// visibility. Re-scoping is creator-only, and whether editor is also
    /// needed depends on the target.
    ///
    /// Order: `require_viewer` (`Forbidden` before any row is read), then
    /// fetch and `ensure_saved_view_readable` (`NotFound` for a view the
    /// caller cannot see), then creator-only (`Forbidden`), then the
    /// transition allow-list (`BadRequest`), then editor for a `→Shared`
    /// target. The allow-list comes before the role check so an illegal
    /// transition is `BadRequest` whatever the caller's role. It rejects
    /// `Proposed→Shared`, so sharing a proposal stays the review queue's job
    /// (`approve_saved_view`, which uses `ensure_proposal_reviewable`).
    /// Returns the view so callers can persist without re-fetching.
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

    /// Record the caller's own last-open view. Any member may record their
    /// own; the write is scoped to `(workspace_id, principal.email)`, stores
    /// only the per-user `last_view`, and never touches the shared
    /// `default_saved_view_id`. Source URLs are stripped, as in
    /// `upsert_viewer_profile`, since workspace views address datasets by
    /// workspace-local id.
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

    /// Read the caller's own workspace state including `last_view`.
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

    /// The workspace's preview, for anyone who may view the workspace. An
    /// archived workspace's preview stays readable by its owners, who still
    /// see its card on the archived shelf.
    pub async fn workspace_preview(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Option<WorkspacePreview>, WorkspaceError> {
        let viewer = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?;
        if viewer.is_none() {
            self.require_owner_any_state(workspace_id, principal)
                .await?;
        }
        self.store
            .get_preview(workspace_id)
            .await
            .map_err(WorkspaceError::Store)
    }

    /// Store a preview uploaded by an owner or editor at `now`.
    ///
    /// The role is checked before the bytes, so a viewer is told it may not
    /// upload whatever it sent. The rate limit is the store's conditional
    /// write rather than a read here, so two racing uploads cannot both
    /// pass it.
    pub async fn put_workspace_preview(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        declared_type: Option<&str>,
        image: &[u8],
        now: DateTime<Utc>,
    ) -> Result<WorkspacePreviewMeta, PreviewError> {
        self.require_editor(workspace_id, principal).await?;
        let content_type = validate_preview(declared_type, image)?;
        let interval = chrono::Duration::from_std(MIN_PREVIEW_INTERVAL).expect("a few seconds fit");
        let written = self
            .store
            .put_preview(NewWorkspacePreview {
                workspace_id,
                content_type,
                image,
                updated_by: &principal.email,
                updated_at: now,
                replaces_up_to: now - interval,
            })
            .await
            .map_err(WorkspaceError::Store)?;
        match written {
            Some(PreviewWrite::Stored(meta)) => Ok(meta),
            Some(PreviewWrite::TooSoon { last_updated_at }) => Err(PreviewError::TooSoon {
                retry_after_secs: retry_after_secs(last_updated_at, now),
            }),
            None => Err(WorkspaceError::NotFound.into()),
        }
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
        let live = Arc::new(LiveWorkspace::new(
            workspace_id.to_string(),
            session,
            self.runtime_config.broadcast_capacity,
        ));
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
            self.generated_config.clone(),
            &self.source_policy,
        )
        .await;
        self.live
            .lock()
            .await
            .insert(workspace_id.to_string(), Arc::clone(&live));
        tracing::info!(workspace_id, "workspace.live_loaded");
        Ok(live)
    }

    /// Register an open socket under its principal, then check the role
    /// once more: a membership change that landed between the upgrade's
    /// check and this registration would otherwise never reach it.
    pub async fn attach_connection(
        &self,
        live: &LiveWorkspace,
        id: ClientId,
        principal: &AuthPrincipal,
        sender: ClientSender,
    ) {
        let closed = {
            let mut connections = live.lock_connections();
            connections
                .open
                .insert(id, (principal.clone(), sender.clone()));
            connections.closed.clone()
        };
        if let Some(request) = closed {
            sender.request_close(request);
            return;
        }
        if !self.still_has_access(&live.workspace_id, principal).await {
            sender.close(CLOSE_ACCESS_REVOKED, "workspace access revoked");
        }
    }

    /// Close every open socket whose principal no longer holds a role in
    /// the workspace. Editor-only messages re-check the role as they
    /// arrive, so a lowered role needs nothing here; losing access
    /// altogether ends the socket, because everything else it receives
    /// (chunks, broadcasts, presence) was authorized only at the upgrade.
    pub async fn close_revoked_connections(&self, workspace_id: &str) {
        let Some(live) = self.live.lock().await.get(workspace_id).cloned() else {
            return;
        };
        let mut verdicts: HashMap<String, bool> = HashMap::new();
        for (id, principal, sender) in live.connections() {
            let allowed = match verdicts.get(&principal.email) {
                Some(allowed) => *allowed,
                None => {
                    let allowed = self.still_has_access(workspace_id, &principal).await;
                    verdicts.insert(principal.email.clone(), allowed);
                    allowed
                }
            };
            if !allowed {
                tracing::info!(
                    client_id = id,
                    workspace_id,
                    "workspace.connection.access_revoked"
                );
                sender.close(CLOSE_ACCESS_REVOKED, "workspace access revoked");
            }
        }
    }

    /// Whether `principal` still holds any role here. A lookup that fails
    /// counts as no: the client reconnects, and the upgrade asks again.
    async fn still_has_access(&self, workspace_id: &str, principal: &AuthPrincipal) -> bool {
        match self.store.role_for(workspace_id, principal).await {
            Ok(role) => role.is_some(),
            Err(e) => {
                tracing::error!(
                    workspace_id,
                    error = %e,
                    "workspace.connection.access_check_failed"
                );
                false
            }
        }
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

    /// Close the archived workspace's sockets. Each hears `WorkspaceArchived`
    /// just before its close, so a client that reads messages but not close
    /// codes still leaves rather than reconnecting into a 410.
    async fn notify_workspace_archived(&self, workspace_id: &str) {
        let live = self.live.lock().await.remove(workspace_id);
        let Some(live) = live else {
            return;
        };
        let notice = serde_json::to_string(&ServerMessage::WorkspaceArchived {
            workspace_id: workspace_id.to_string(),
        })
        .unwrap();
        live.close_all(
            CloseRequest::new(CLOSE_WORKSPACE_ARCHIVED, "workspace archived").with_notice(notice),
        );
        self.shutdown_live_workspace_background(&live, "archive")
            .await;
        tracing::info!(workspace_id, "workspace.live_archived_cancelled");
    }

    /// Stop serving a live workspace whose document the database has moved
    /// past, and close its sockets so they reconnect to one loaded fresh.
    ///
    /// Reloading in place would leave a live workspace that eviction already
    /// replaced still taking writes beside its replacement, so the two would
    /// keep refusing each other. `sender`, whose command found the newer
    /// document, hears that it was refused before its close.
    async fn retire_stale(&self, live: &LiveWorkspace, sender: Option<ClientId>, seq: u64) {
        let was_current = {
            let mut live_map = self.live.lock().await;
            let current = live_map
                .get(&live.workspace_id)
                .is_some_and(|current| std::ptr::eq(Arc::as_ptr(current), live));
            if current {
                live_map.remove(&live.workspace_id);
            }
            current
        };
        let close = CloseRequest::new(
            CLOSE_WORKSPACE_RELOADED,
            "workspace changed elsewhere; reconnect to load it",
        );
        if let Some(sender) = sender {
            let refused = ServerMessage::CommandRejected {
                reason: CommandRejection::Unavailable,
            };
            live.close_one(
                sender,
                close
                    .clone()
                    .with_notice(serde_json::to_string(&refused).unwrap()),
            );
        }
        live.close_all(close);
        self.shutdown_live_workspace_background(live, "stale_document")
            .await;
        tracing::warn!(
            workspace_id = %live.workspace_id,
            seq,
            was_current,
            "workspace.live_retired_stale"
        );
    }

    /// Pass a document write's result through, first retiring `live` if
    /// the database refused it as stale.
    async fn document_written(
        &self,
        live: &LiveWorkspace,
        sender: Option<ClientId>,
        written: Result<(), StoreError>,
    ) -> Result<(), WorkspaceError> {
        if let Err(StoreError::StaleDocument(seq)) = &written {
            self.retire_stale(live, sender, *seq).await;
        }
        written.map_err(WorkspaceError::Store)
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

    /// Persist `sender`'s command at `seq`. A stale write retires `live`;
    /// see [`Self::retire_stale`].
    pub async fn persist_applied_command(
        &self,
        live: &LiveWorkspace,
        sender: ClientId,
        command: &DocumentCommand,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), WorkspaceError> {
        let written = match command {
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
        };
        self.document_written(live, Some(sender), written).await
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
        let written = self
            .store
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
            .await;
        // An open is not a command, so nobody is owed a refusal: the
        // opener's socket closes with the rest.
        self.document_written(live, None, written).await
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

    /// Rename a workspace dataset's display label in the shared document, so
    /// it broadcasts to peers and survives reopen, and keep the DB
    /// `display_name` in sync so listings and restored bindings agree.
    ///
    /// Persists, applies, and broadcasts the rename like any other document
    /// command, acking `sender`, and returns its seq.
    /// [`Store::persist_dataset_renamed`] writes the row and `document_json`
    /// in one transaction. `require_editor` runs before anything is read; a
    /// bad name is `BadRequest`, and a missing id is `NotFound`, so the
    /// rename never confirms which ids exist.
    pub async fn rename_dataset(
        &self,
        live: &LiveWorkspace,
        principal: &AuthPrincipal,
        sender: ClientId,
        workspace_dataset_id: &DatasetId,
        name: &str,
    ) -> Result<u64, WorkspaceError> {
        // 1. Authority first — never read the document for a non-editor.
        self.require_editor(&live.workspace_id, principal).await?;

        // 2. Validate before mutating anything.
        let name = normalize_dataset_name(name)?;

        let command = DocumentCommand::RenameDataset {
            id: workspace_dataset_id.clone(),
            name: name.clone(),
        };

        // 3. Only a dataset the document holds can be renamed. A missing id
        //    is NotFound (never-leak), not a silent no-op that would still
        //    bump seq and persist.
        let turn = live.document_turn().await;
        let (seq, document) = {
            let sess = live.session.lock().await;
            if !sess.document.manifests.contains_key(workspace_dataset_id) {
                return Err(WorkspaceError::NotFound);
            }
            sess.next(&command)
        };

        // 4. Persist: workspace_datasets.display_name + document_json together.
        let written = self
            .store
            .persist_dataset_renamed(
                &live.workspace_id,
                workspace_dataset_id,
                &name,
                seq,
                &document,
            )
            .await;
        self.document_written(live, Some(sender), written).await?;

        live.session
            .lock()
            .await
            .commit(seq, command.clone(), document);
        live.broadcast_command(sender, seq, command);
        drop(turn);
        Ok(seq)
    }

    /// Apply a client-issued document command to the live workspace: editor
    /// gate, persist, apply, then broadcast it and ack `sender`. With
    /// [`Self::rename_dataset`] this is the only authorization and
    /// persistence path for workspace document commands; the WS handler
    /// holds no policy.
    ///
    /// Every failure leaves the document as it was. A denying role is
    /// `Forbidden`, and a role lookup that errors is `GateUnavailable`, not a
    /// verdict.
    pub async fn apply_document_command(
        &self,
        live: &LiveWorkspace,
        principal: &AuthPrincipal,
        sender: ClientId,
        command: DocumentCommand,
    ) -> Result<u64, CommandApplyError> {
        match self.require_editor(&live.workspace_id, principal).await {
            Ok(_) => {}
            Err(WorkspaceError::Store(e)) => return Err(CommandApplyError::GateUnavailable(e)),
            Err(_) => return Err(CommandApplyError::Forbidden),
        }
        let turn = live.document_turn().await;
        let (seq, document) = live.session.lock().await.next(&command);
        self.persist_applied_command(live, sender, &command, seq, &document)
            .await
            .map_err(CommandApplyError::PersistFailed)?;
        live.session
            .lock()
            .await
            .commit(seq, command.clone(), document);
        live.broadcast_command(sender, seq, command);
        drop(turn);
        Ok(seq)
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

/// The never-leak rule for non-shared views: a `Personal` or pending
/// `Proposed` view is readable here only by its creator (normalized email),
/// and everyone else gets `NotFound`. `Shared` views are readable by any
/// member.
///
/// Role-blind on purpose. The editor exception for pending proposals is
/// layered at the manager, so a refactor here cannot disclose another
/// member's proposal: the default is deny.
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

/// The creator-driven `/visibility` transition allow-list, closed by
/// construction so an illegal transition is unreachable from the REST
/// endpoint, not merely unsent by the web UI.
///
/// Allowed, all by the creator:
/// - `Personal → Shared` (the caller also requires editor)
/// - `Shared → Personal`
/// - `Personal → Proposed`
/// - `Proposed → Personal`
/// - `X → X`, an idempotent no-op
///
/// Everything else is `BadRequest`. That rejects `Shared → Proposed` and the
/// self-approve bypass `Proposed → Shared`: sharing a proposal is only
/// `approve_saved_view`'s job.
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
    /// The database refused or failed the write. Nothing was applied: the
    /// seq did not advance, and no peer heard of the command.
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
