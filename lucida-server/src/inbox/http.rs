//! The inbox's REST surface: what the CLI lists and fetches.
//!
//! Two routes, both under a workspace and both read-only. Nothing here
//! writes: a bundle arrives over the session socket, because that is
//! where the page already is, and it is read over HTTP, because that is
//! where the CLI already is. Neither half is a second way to do the
//! other's job.
//!
//! The routes live in this module rather than in `workspace/http.rs`
//! for the reason the bookmark routes do: the store behind them is this
//! feature's, and the only thing it needs from the workspace layer is
//! the membership check, which it makes through the manager like any
//! other caller. `main.rs` merges this router into the protected half,
//! so every handler sees an `AuthPrincipal` in extensions.
//!
//! **Members only, all of them.** A viewer can read the inbox and a
//! viewer can send to it. Somebody who can see the workspace can see
//! what went wrong in it, and needing edit rights to report a problem
//! would put the field report behind the very permission the reporter
//! is least likely to hold.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::json;
use serde_json::value::RawValue;

use lucida_core::auth_principal::AuthPrincipal;

use super::store::{InboxEntry, InboxStore};
use crate::workspace::WorkspaceManager;

/// What the handlers hold: the store the entries are in, and the
/// manager that says who may read them.
#[derive(Clone)]
pub struct InboxState {
    pub manager: Arc<WorkspaceManager>,
    pub store: Arc<dyn InboxStore>,
}

pub fn router(state: InboxState) -> Router<()> {
    Router::new()
        .route("/api/workspaces/{workspace_id}/inbox", get(list_inbox))
        .route(
            "/api/workspaces/{workspace_id}/inbox/{entry_id}",
            get(fetch_inbox_entry),
        )
        .with_state(state)
}

/// One entry as the CLI reads it. The header rides verbatim, as the
/// text the page wrote, so the listing shows the run's own fields in
/// the run's own order and the server states nothing of its own about
/// what it is holding.
#[derive(Debug, Serialize)]
struct InboxEntryResponse {
    id: String,
    workspace_id: String,
    sent_by: String,
    sent_by_name: String,
    sent_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    size_bytes: i64,
    header: Box<RawValue>,
}

impl InboxEntryResponse {
    /// `Err` only if the column stopped being JSON, which the write and
    /// the schema both refuse — so it is a fault of this server's
    /// storage rather than anything a reader did.
    fn from_entry(entry: InboxEntry) -> Result<Self, serde_json::Error> {
        Ok(Self {
            id: entry.id,
            workspace_id: entry.workspace_id,
            sent_by: entry.sent_by,
            sent_by_name: entry.sent_by_name,
            sent_at: entry.sent_at,
            expires_at: entry.expires_at,
            size_bytes: entry.size_bytes,
            header: RawValue::from_string(entry.header_json)?,
        })
    }
}

async fn list_inbox(
    State(state): State<InboxState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
) -> Response {
    if let Err(e) = state
        .manager
        .require_viewer(&workspace_id, &principal)
        .await
    {
        return e.into_response();
    }
    let entries = match state.store.list(&workspace_id, Utc::now()).await {
        Ok(entries) => entries,
        Err(e) => return store_failed(e),
    };
    match entries
        .into_iter()
        .map(InboxEntryResponse::from_entry)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(e) => stored_header_unreadable(e),
    }
}

/// The bundle, as it was sent.
///
/// The body is the stored text handed back unaltered rather than a
/// value this server re-serialised, so the file the CLI writes is the
/// file the page produced and a reader comparing the two finds them
/// identical.
async fn fetch_inbox_entry(
    State(state): State<InboxState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, entry_id)): Path<(String, String)>,
) -> Response {
    if let Err(e) = state
        .manager
        .require_viewer(&workspace_id, &principal)
        .await
    {
        return e.into_response();
    }
    match state
        .store
        .fetch(&workspace_id, &entry_id, Utc::now())
        .await
    {
        Ok(Some(bundle)) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            bundle.bundle_json,
        )
            .into_response(),
        // An entry past its retention answers the same way one that
        // never existed does. The inbox keeps reports for a fixed
        // number of days and then has nothing to say about them.
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "not_found",
                "detail": "no such report in this workspace's inbox; it may have expired",
            })),
        )
            .into_response(),
        Err(e) => store_failed(e),
    }
}

fn store_failed(error: super::store::StoreError) -> Response {
    tracing::error!(error = %error, "inbox.store_error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "inbox_store_error" })),
    )
        .into_response()
}

fn stored_header_unreadable(error: serde_json::Error) -> Response {
    tracing::error!(error = %error, "inbox.stored_header_unreadable");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "inbox_store_error" })),
    )
        .into_response()
}
