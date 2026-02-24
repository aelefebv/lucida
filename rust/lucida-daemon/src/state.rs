use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::dto::dataset_summary::DatasetSummary;

#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub session_id: String,
    pub created_at: DateTime<Utc>,
    pub dataset_ids: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct DatasetRecord {
    pub dataset_summary: DatasetSummary,
    pub session_ids: HashSet<String>,
}

#[derive(Debug, Default)]
pub struct AppState {
    pub sessions_by_id: HashMap<String, SessionRecord>,
    pub datasets_by_id: HashMap<String, DatasetRecord>,
    pub compat_session_id: Option<String>,
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
    };
    state.sessions_by_id.insert(session_id, session.clone());
    session
}
