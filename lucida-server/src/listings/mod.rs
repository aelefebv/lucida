//! Finding datasets before anyone opens them.
//!
//! A [`DatasetSource`] says which datasets exist. [`sources::configured`]
//! builds every source a server lists from, in one place. The
//! [`ListingsIndex`] holds what they offer in memory and searches it, and
//! [`http`] serves that search over HTTP, beside each caller's recent
//! datasets.

pub mod http;
pub mod index;
pub mod object_store_source;
pub mod sources;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub use http::router;
pub use index::{Cursor, ListingsIndex, ResolvedListing, ResultGroup, SearchPage, SearchQuery};
pub use object_store_source::{DataRoot, ObjectStoreSource};
pub use sources::{SourceContext, configured};

/// One dataset a source offers. Opening it makes it a dataset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    /// The dataset location it opens from.
    pub url: String,
    pub title: String,
    pub kind: ListingKind,
    /// How many tiles a collection lays out, when the source knows.
    pub tiles: Option<usize>,
    /// The email address of whoever owns it, when the source knows.
    pub owner: Option<String>,
    pub date: Option<DateTime<Utc>>,
    pub group: Option<ListingGroup>,
    /// Named values shown with the listing and searched, in display order.
    pub fields: Vec<ListingField>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListingKind {
    Image,
    Collection,
}

/// A named set of listings from one source. Its `id` is unique within the
/// source; its `label` is what a person reads.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ListingGroup {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListingField {
    pub name: String,
    pub value: String,
}

pub type SourceError = Box<dyn std::error::Error + Send + Sync>;

/// Where the server learns which datasets exist.
#[async_trait::async_trait]
pub trait DatasetSource: Send + Sync {
    /// What the source calls one of its groups, such as "Folder".
    fn group_noun(&self) -> &str;

    /// Every listing the source offers now. The index asks again on every
    /// refresh, and an error keeps what the source offered last.
    async fn listings(&self) -> Result<Vec<Listing>, SourceError>;
}
