//! The listings REST surface: search, resolve for a pasted URL, and the
//! caller's recent datasets.
//!
//! Any principal the auth mode admits may search. Opening a listing still
//! takes the editor role in the workspace it opens into.

use std::sync::Arc;

use axum::extract::{FromRef, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::{Extension, Router};
use chrono::{DateTime, Utc};
use lucida_core::auth_principal::AuthPrincipal;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::index::{Cursor, ListingsIndex, ResolvedListing, ResultGroup};
use super::{Listing, ListingField, ListingGroup, ListingKind};
use crate::workspace::WorkspaceManager;

/// The most recent datasets a caller gets back.
const RECENT_DATASETS: usize = 8;

/// The listings, and the workspaces whose per-member state says which
/// datasets each caller opened recently.
#[derive(Clone)]
struct ListingsState {
    index: Arc<ListingsIndex>,
    workspaces: Arc<WorkspaceManager>,
}

impl FromRef<ListingsState> for Arc<ListingsIndex> {
    fn from_ref(state: &ListingsState) -> Self {
        Arc::clone(&state.index)
    }
}

impl FromRef<ListingsState> for Arc<WorkspaceManager> {
    fn from_ref(state: &ListingsState) -> Self {
        Arc::clone(&state.workspaces)
    }
}

pub fn router(index: Arc<ListingsIndex>, workspaces: Arc<WorkspaceManager>) -> Router<()> {
    Router::new()
        .route("/api/listings", get(search_listings))
        .route("/api/listings/resolve", get(resolve_listing))
        .route("/api/listings/recent", get(recent_listings))
        .with_state(ListingsState { index, workspaces })
}

#[derive(Debug, Default, Deserialize)]
pub struct SearchListingsQuery {
    pub q: Option<String>,
    pub cursor: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ResolveListingQuery {
    pub url: Option<String>,
}

#[derive(Debug, Serialize)]
struct SearchListingsResponse {
    results: Vec<ListingResultResponse>,
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
struct ListingResultResponse {
    group: Option<ListingGroupResponse>,
    collapsed: bool,
    listings: Vec<ListingResponse>,
}

#[derive(Debug, Serialize)]
struct ResolveListingResponse {
    listing: Option<ListingResponse>,
}

#[derive(Debug, Serialize)]
struct RecentListingsResponse {
    /// Newest first.
    recent: Vec<RecentListingResponse>,
}

/// A dataset the caller opened recently. `listing` is what a source offers
/// at `url`, when one does; `name` is the dataset's own name either way.
#[derive(Debug, Serialize)]
struct RecentListingResponse {
    url: String,
    name: String,
    listing: Option<ListingResponse>,
}

#[derive(Debug, Serialize)]
struct ListingResponse {
    url: String,
    title: String,
    kind: ListingKind,
    tiles: Option<usize>,
    owner: Option<String>,
    date: Option<DateTime<Utc>>,
    group: Option<ListingGroupResponse>,
    fields: Vec<ListingField>,
}

#[derive(Debug, Clone, Serialize)]
struct ListingGroupResponse {
    id: String,
    label: String,
    noun: String,
}

impl ListingGroupResponse {
    fn new(group: Option<ListingGroup>, noun: &str) -> Option<Self> {
        group.map(|group| Self {
            id: group.id,
            label: group.label,
            noun: noun.to_string(),
        })
    }
}

impl ListingResponse {
    fn new(listing: Listing, group: Option<ListingGroupResponse>) -> Self {
        Self {
            url: listing.url,
            title: listing.title,
            kind: listing.kind,
            tiles: listing.tiles,
            owner: listing.owner,
            date: listing.date,
            group,
            fields: listing.fields,
        }
    }
}

impl From<ResolvedListing> for ListingResponse {
    fn from(resolved: ResolvedListing) -> Self {
        let group = ListingGroupResponse::new(resolved.listing.group.clone(), &resolved.noun);
        Self::new(resolved.listing, group)
    }
}

impl ListingResultResponse {
    fn new(result: ResultGroup) -> Self {
        let group = ListingGroupResponse::new(result.group, &result.noun);
        Self {
            listings: result
                .listings
                .into_iter()
                .map(|listing| ListingResponse::new(listing, group.clone()))
                .collect(),
            group,
            collapsed: result.collapsed,
        }
    }
}

// The principal is unused until search scopes by owner, but requiring it
// keeps these routes off the router half the auth middleware doesn't wrap.
async fn search_listings(
    State(index): State<Arc<ListingsIndex>>,
    Extension(_principal): Extension<AuthPrincipal>,
    Query(query): Query<SearchListingsQuery>,
) -> Response {
    let cursor = match query.cursor.as_deref().filter(|c| !c.is_empty()) {
        None => None,
        Some(text) => match Cursor::decode(text) {
            Some(cursor) => Some(cursor),
            None => return bad_request("cursor is not one this server returned"),
        },
    };
    let page = index.search(query.q.as_deref().unwrap_or(""), cursor.as_ref());
    let body = SearchListingsResponse {
        results: page
            .results
            .into_iter()
            .map(ListingResultResponse::new)
            .collect(),
        next_cursor: page.next.map(|cursor| cursor.encode()),
    };
    (StatusCode::OK, Json(body)).into_response()
}

async fn resolve_listing(
    State(index): State<Arc<ListingsIndex>>,
    Extension(_principal): Extension<AuthPrincipal>,
    Query(query): Query<ResolveListingQuery>,
) -> Response {
    let Some(url) = query.url else {
        return bad_request("url is required");
    };
    let listing = index.resolve(&url).map(ListingResponse::from);
    (StatusCode::OK, Json(ResolveListingResponse { listing })).into_response()
}

async fn recent_listings(
    State(index): State<Arc<ListingsIndex>>,
    State(workspaces): State<Arc<WorkspaceManager>>,
    Extension(principal): Extension<AuthPrincipal>,
) -> Response {
    let recent = match workspaces
        .recent_datasets(&principal, RECENT_DATASETS)
        .await
    {
        Ok(recent) => recent,
        Err(error) => return error.into_response(),
    };
    let recent = recent
        .into_iter()
        .map(|recent| RecentListingResponse {
            listing: index
                .resolve(&recent.canonical_url)
                .map(ListingResponse::from),
            url: recent.canonical_url,
            name: recent.name,
        })
        .collect();
    (StatusCode::OK, Json(RecentListingsResponse { recent })).into_response()
}

fn bad_request(detail: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "bad_request", "detail": detail })),
    )
        .into_response()
}
