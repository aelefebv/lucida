use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde_json::json;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::dto::dataset_summary::DatasetSummary;
use crate::dto::view_state::ViewState;
use crate::error::ApiError;
use crate::render_cache::{new_shared_render_cache_registry, SharedRenderCacheRegistry};

#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub session_id: String,
    pub created_at: DateTime<Utc>,
    pub dataset_ids: HashSet<String>,
    pub view_ids: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct DatasetRecord {
    pub dataset_summary: DatasetSummary,
    pub session_ids: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct ViewRecord {
    pub session_id: String,
    pub view_state: ViewState,
}

#[derive(Debug)]
pub struct AppState {
    pub sessions_by_id: HashMap<String, SessionRecord>,
    pub datasets_by_id: HashMap<String, DatasetRecord>,
    pub views_by_id: HashMap<String, ViewRecord>,
    pub compat_session_id: Option<String>,
    pub render_caches: SharedRenderCacheRegistry,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions_by_id: HashMap::new(),
            datasets_by_id: HashMap::new(),
            views_by_id: HashMap::new(),
            compat_session_id: None,
            render_caches: new_shared_render_cache_registry(),
        }
    }
}

pub type SharedAppState = Arc<RwLock<AppState>>;

pub fn new_shared_state() -> SharedAppState {
    Arc::new(RwLock::new(AppState::default()))
}

pub fn create_session_record(state: &mut AppState, prefix: &str) -> SessionRecord {
    let session_id = format!("{}_{}", prefix, &Uuid::new_v4().simple().to_string()[..16]);
    let session = SessionRecord {
        session_id: session_id.clone(),
        created_at: Utc::now(),
        dataset_ids: HashSet::new(),
        view_ids: HashSet::new(),
    };
    state.sessions_by_id.insert(session_id, session.clone());
    session
}

pub fn require_session<'a>(
    state: &'a AppState,
    session_id: &str,
) -> Result<&'a SessionRecord, ApiError> {
    state.sessions_by_id.get(session_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "session_not_found",
            "Session was not found.",
            Some(json!({ "session_id": session_id })),
        )
    })
}

pub fn resolve_session_id(
    state: &mut AppState,
    session_id: Option<&str>,
) -> Result<String, ApiError> {
    if let Some(session_id) = session_id {
        require_session(state, session_id)?;
        return Ok(session_id.to_owned());
    }
    if state.compat_session_id.is_none() {
        let compat_session = create_session_record(state, "compat");
        state.compat_session_id = Some(compat_session.session_id.clone());
    }
    Ok(state
        .compat_session_id
        .clone()
        .expect("compat session id must be initialized"))
}

pub fn ensure_dataset_attached(state: &mut AppState, dataset_id: &str, session_id: &str) {
    if let Some(session) = state.sessions_by_id.get_mut(session_id) {
        session.dataset_ids.insert(dataset_id.to_owned());
    }
    if let Some(dataset) = state.datasets_by_id.get_mut(dataset_id) {
        dataset.session_ids.insert(session_id.to_owned());
    }
}
