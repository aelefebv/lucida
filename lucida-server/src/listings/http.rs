//! The listings REST surface: search, and resolve for a pasted URL.
//!
//! Any principal the auth mode admits may search. Opening a listing still
//! takes the editor role in the workspace it opens into.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::{Extension, Router};
use chrono::{DateTime, Utc};
use lucida_core::auth_principal::AuthPrincipal;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::index::{Cursor, ListingsIndex, ResultGroup};
use super::{Listing, ListingField, ListingGroup, ListingKind};

pub fn router(index: Arc<ListingsIndex>) -> Router<()> {
    Router::new()
        .route("/api/listings", get(search_listings))
        .route("/api/listings/resolve", get(resolve_listing))
        .with_state(index)
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
struct ListingResponse {
    url: String,
    title: String,
    kind: ListingKind,
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
            owner: listing.owner,
            date: listing.date,
            group,
            fields: listing.fields,
        }
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
    let listing = index.resolve(&url).map(|resolved| {
        let group = ListingGroupResponse::new(resolved.listing.group.clone(), &resolved.noun);
        ListingResponse::new(resolved.listing, group)
    });
    (StatusCode::OK, Json(ResolveListingResponse { listing })).into_response()
}

fn bad_request(detail: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "bad_request", "detail": detail })),
    )
        .into_response()
}
