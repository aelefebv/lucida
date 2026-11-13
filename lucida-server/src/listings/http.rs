//! The listings REST surface: search, and resolve for a pasted URL.
//!
//! Any principal the auth mode admits may search. Opening a listing still
//! takes the editor role in the workspace it opens into.

use std::sync::Arc;

use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::{Extension, Router};
use chrono::{DateTime, Utc};
use lucida_core::auth_principal::AuthPrincipal;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::index::{Cursor, ListingsIndex, ResultGroup, SearchQuery};
use super::{Listing, ListingField, ListingGroup, ListingKind};

/// The listings routes over `index`. `people_signed_in` says whether each
/// principal's email is the address of the person signed in. Where it
/// isn't, as with auth disabled, a principal owns nothing, so a search
/// never narrows to the caller's own listings.
pub fn router(index: Arc<ListingsIndex>, people_signed_in: bool) -> Router<()> {
    Router::new()
        .route("/api/listings", get(search_listings))
        .route("/api/listings/resolve", get(resolve_listing))
        .with_state(ListingsState {
            index,
            people_signed_in,
        })
}

#[derive(Clone)]
struct ListingsState {
    index: Arc<ListingsIndex>,
    people_signed_in: bool,
}

/// Whose listings a search keeps.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// Those the caller owns.
    Mine,
    #[default]
    Everyone,
}

#[derive(Debug, Default, Deserialize)]
pub struct SearchListingsQuery {
    pub q: Option<String>,
    pub cursor: Option<String>,
    #[serde(default)]
    pub scope: Scope,
    pub kind: Option<ListingKind>,
    /// Only listings dated at or after this RFC 3339 time.
    pub since: Option<DateTime<Utc>>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ResolveListingQuery {
    pub url: Option<String>,
}

#[derive(Debug, Serialize)]
struct SearchListingsResponse {
    results: Vec<ListingResultResponse>,
    next_cursor: Option<String>,
    /// Whose listings the results hold: `everyone` when `mine` was asked
    /// but isn't available.
    scope: Scope,
    /// Whether `mine` narrows anything: the caller is signed in as a person
    /// and some listing has an owner.
    mine_available: bool,
    /// Listings that matched but the scope left out, over all pages.
    outside_scope: usize,
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

async fn search_listings(
    State(state): State<ListingsState>,
    Extension(principal): Extension<AuthPrincipal>,
    query: Result<Query<SearchListingsQuery>, QueryRejection>,
) -> Response {
    let query = match query {
        Ok(Query(query)) => query,
        Err(rejection) => return bad_request(&rejection.body_text()),
    };
    let cursor = match query.cursor.as_deref().filter(|c| !c.is_empty()) {
        None => None,
        Some(text) => match Cursor::decode(text) {
            Some(cursor) => Some(cursor),
            None => return bad_request("cursor is not one this server returned"),
        },
    };
    let mine = query.scope == Scope::Mine && state.people_signed_in;
    let page = state.index.search(
        &SearchQuery {
            words: query.q.unwrap_or_default(),
            kind: query.kind,
            since: query.since,
            owner: mine.then_some(principal.email),
        },
        cursor.as_ref(),
    );
    let body = SearchListingsResponse {
        results: page
            .results
            .into_iter()
            .map(ListingResultResponse::new)
            .collect(),
        next_cursor: page.next.map(|cursor| cursor.encode()),
        scope: if mine && page.owned {
            Scope::Mine
        } else {
            Scope::Everyone
        },
        mine_available: state.people_signed_in && page.owned,
        outside_scope: page.outside_scope,
    };
    (StatusCode::OK, Json(body)).into_response()
}

// The principal is unused, but requiring it keeps this route off the
// router half the auth middleware doesn't wrap.
async fn resolve_listing(
    State(state): State<ListingsState>,
    Extension(_principal): Extension<AuthPrincipal>,
    Query(query): Query<ResolveListingQuery>,
) -> Response {
    let Some(url) = query.url else {
        return bad_request("url is required");
    };
    let listing = state.index.resolve(&url).map(|resolved| {
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
