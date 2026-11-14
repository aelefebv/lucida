//! The listings index: every listing the dataset sources offer, held in
//! memory and searched there.
//!
//! A refresh asks each source for all of its listings, drops those the
//! source policy would refuse to open, and swaps in a new snapshot. A
//! search reads the snapshot and never waits on a source.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use futures_util::future::join_all;
use futures_util::stream::{self, StreamExt};
use lucida_content::url::DatasetLocation;
use lucida_store::source_policy::SourcePolicy;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use super::{DatasetSource, Listing, ListingGroup, ListingKind};

/// Listings a page of results holds before it ends, unless its first
/// group alone holds more. A group is never split across pages, so a
/// client meets each group once.
const PAGE_LISTINGS: usize = 200;

/// The most listings the index holds from one source; past it, the oldest
/// go. Every listing is held in memory, so no source may grow it without
/// bound.
const MAX_LISTINGS_PER_SOURCE: usize = 100_000;

/// The URL path segments, counted from the end, that a search word may
/// match. The leading ones, such as a data root's own path or a bucket,
/// are shared by every listing under them, so a word matching them would
/// narrow nothing.
const MATCHED_URL_SEGMENTS: usize = 3;

/// Policy checks a refresh runs at once. One may resolve a host name.
const CHECK_CONCURRENCY: usize = 16;

pub struct ListingsIndex {
    sources: Vec<Arc<dyn DatasetSource>>,
    policy: Arc<SourcePolicy>,
    /// What each source offered at its last good refresh, as the policy
    /// admitted it, so a failed refresh keeps it. The lock also keeps two
    /// refreshes from interleaving.
    offered: tokio::sync::Mutex<Vec<Arc<Vec<Listing>>>>,
    snapshot: RwLock<Arc<Snapshot>>,
}

/// What a search asks for: the words every listing must hold, and what
/// narrows the listings that hold them.
#[derive(Debug, Clone, Default)]
pub struct SearchQuery {
    /// Whitespace-separated words that must each appear, ignoring case.
    pub words: String,
    pub kind: Option<ListingKind>,
    /// The earliest date a listing may have. An undated listing never passes.
    pub since: Option<DateTime<Utc>>,
    /// Keep only the listings this email owns, ignoring case. While no
    /// listing has an owner it narrows nothing, because it would hide every
    /// listing and tell none apart.
    pub owner: Option<String>,
}

/// One page of search results.
#[derive(Debug)]
pub struct SearchPage {
    /// Ordered by each one's newest listing.
    pub results: Vec<ResultGroup>,
    /// Where the next page starts, when there is one.
    pub next: Option<Cursor>,
    /// Whether any listing the index holds has an owner, which is when an
    /// owner narrows a search.
    pub owned: bool,
    /// Listings that matched everything but the owner, over all pages
    /// rather than this one.
    pub outside_scope: usize,
}

/// One group's matching listings, or one listing that has no group.
#[derive(Debug)]
pub struct ResultGroup {
    pub group: Option<ListingGroup>,
    /// What the group's source calls a group.
    pub noun: Arc<str>,
    /// The group's label matched, so every listing in it that passes the
    /// kind, date and owner came back.
    pub collapsed: bool,
    /// How many listings the group holds, matched or not.
    pub size: usize,
    /// Newest first.
    pub listings: Vec<Listing>,
}

#[derive(Debug)]
pub struct ResolvedListing {
    pub listing: Listing,
    /// What the listing's source calls a group.
    pub noun: Arc<str>,
}

/// Where a page of results ended, opaque to clients and valid with the
/// query that produced it. It names the last result the page held rather
/// than a position, so a refresh between two pages neither repeats nor
/// skips a result that kept its place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor(SortKey);

impl Cursor {
    pub fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&self.0).expect("a sort key serializes"))
    }

    /// `None` for text no cursor encodes to.
    pub fn decode(text: &str) -> Option<Self> {
        let bytes = URL_SAFE_NO_PAD.decode(text).ok()?;
        serde_json::from_slice(&bytes).ok().map(Self)
    }
}

impl ListingsIndex {
    /// An index over `sources`, empty until its first refresh.
    pub fn new(sources: Vec<Arc<dyn DatasetSource>>, policy: Arc<SourcePolicy>) -> Self {
        let offered = sources.iter().map(|_| Arc::new(Vec::new())).collect();
        Self {
            sources,
            policy,
            offered: tokio::sync::Mutex::new(offered),
            snapshot: RwLock::new(Arc::new(Snapshot::default())),
        }
    }

    pub fn source_count(&self) -> usize {
        self.sources.len()
    }

    /// Ask every source for its listings and swap in what they offer. A
    /// source that fails keeps what it offered last.
    pub async fn refresh(&self) {
        let mut offered = self.offered.lock().await;
        let results = join_all(self.sources.iter().map(|source| source.listings())).await;
        for (at, result) in results.into_iter().enumerate() {
            match result {
                Ok(listings) => offered[at] = Arc::new(self.admit(listings).await),
                Err(error) => tracing::warn!(
                    source = at,
                    noun = self.sources[at].group_noun(),
                    error = %error,
                    "listings.source_failed"
                ),
            }
        }
        let snapshot = Arc::new(Snapshot::build(&self.sources, &offered));
        let previous = std::mem::replace(
            &mut *self.snapshot.write().expect("listings snapshot lock"),
            Arc::clone(&snapshot),
        );
        if snapshot.listings == previous.listings {
            tracing::debug!(listings = snapshot.listings, "listings.refreshed");
        } else {
            tracing::info!(
                listings = snapshot.listings,
                results = snapshot.entries.len(),
                "listings.refreshed"
            );
        }
    }

    /// Refresh now and then every `interval`, for as long as the index
    /// lives. The task holds the index weakly, so dropping it ends the task.
    pub fn spawn_refresh_loop(self: &Arc<Self>, interval: Duration) -> JoinHandle<()> {
        let index = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            // A walk that outlasts the interval is followed by a whole
            // interval's rest, not a burst of catch-up refreshes.
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(index) = index.upgrade() else {
                    return;
                };
                index.refresh().await;
            }
        })
    }

    /// The listings matching `query`, grouped, starting after `cursor`.
    pub fn search(&self, query: &SearchQuery, cursor: Option<&Cursor>) -> SearchPage {
        let snapshot = self.snapshot();
        let filter = Filter::new(query, snapshot.owned);
        let mut outside_scope = 0;
        let mut matches: Vec<Match> = snapshot
            .entries
            .iter()
            .enumerate()
            .filter_map(|(at, entry)| {
                let (found, outside) = entry.matching(at, &filter);
                outside_scope += outside;
                found
            })
            .collect();
        matches.sort_by(|a, b| a.key.cmp(&b.key));
        let start = cursor.map_or(0, |cursor| matches.partition_point(|m| m.key <= cursor.0));
        let mut results = Vec::new();
        let mut held = 0;
        for found in &matches[start..] {
            if !results.is_empty() && held + found.listings.len() > PAGE_LISTINGS {
                break;
            }
            held += found.listings.len();
            results.push(snapshot.result(found));
        }
        let end = start + results.len();
        let next = (end < matches.len()).then(|| Cursor(matches[end - 1].key.clone()));
        SearchPage {
            results,
            next,
            owned: snapshot.owned,
            outside_scope,
        }
    }

    /// The listing at `url`, in any spelling of it, if a source offers one.
    pub fn resolve(&self, url: &str) -> Option<ResolvedListing> {
        let location = DatasetLocation::parse(url.trim()).ok()?;
        let snapshot = self.snapshot();
        let &(entry, at) = snapshot.by_url.get(lookup_key(location.as_str()))?;
        let entry = &snapshot.entries[entry];
        Some(ResolvedListing {
            listing: entry.listings[at].listing.clone(),
            noun: Arc::clone(&snapshot.nouns[entry.source]),
        })
    }

    fn snapshot(&self) -> Arc<Snapshot> {
        Arc::clone(&self.snapshot.read().expect("listings snapshot lock"))
    }

    /// The listings the policy would let open, each URL in the form resolve
    /// looks it up by. One whose URL does not parse could never open.
    async fn admit(&self, listings: Vec<Listing>) -> Vec<Listing> {
        let offered = listings.len();
        let policy = &self.policy;
        let mut admitted: Vec<Listing> = stream::iter(listings)
            .map(|listing| async move {
                let location = DatasetLocation::parse(&listing.url).ok()?;
                policy.check(&location).await.ok()?;
                Some(Listing {
                    url: lookup_key(location.as_str()).to_string(),
                    ..listing
                })
            })
            .buffered(CHECK_CONCURRENCY)
            .filter_map(|listing| async move { listing })
            .collect()
            .await;
        if admitted.len() < offered {
            tracing::debug!(
                refused = offered - admitted.len(),
                "listings.refused_by_policy"
            );
        }
        if admitted.len() > MAX_LISTINGS_PER_SOURCE {
            tracing::warn!(
                offered = admitted.len(),
                kept = MAX_LISTINGS_PER_SOURCE,
                "listings.source_truncated"
            );
            admitted.sort_by(newest_first);
            admitted.truncate(MAX_LISTINGS_PER_SOURCE);
        }
        admitted
    }
}

/// A dataset location as the index keys it: canonical, without trailing
/// slashes, so a pasted URL with one still resolves.
fn lookup_key(canonical: &str) -> &str {
    match canonical.trim_end_matches('/') {
        "" => canonical,
        trimmed => trimmed,
    }
}

/// Newest first, undated last, then by title and URL so the order is total.
fn newest_first(a: &Listing, b: &Listing) -> Ordering {
    b.date
        .cmp(&a.date)
        .then_with(|| a.title.cmp(&b.title))
        .then_with(|| a.url.cmp(&b.url))
}

/// What a refresh built: every admitted listing, gathered into results.
#[derive(Default)]
struct Snapshot {
    entries: Vec<Entry>,
    /// Each listing's place, by its lookup key.
    by_url: HashMap<String, (usize, usize)>,
    /// Each source's group noun, by source.
    nouns: Vec<Arc<str>>,
    listings: usize,
    /// Whether any listing has an owner.
    owned: bool,
}

impl Snapshot {
    fn build(sources: &[Arc<dyn DatasetSource>], offered: &[Arc<Vec<Listing>>]) -> Self {
        let mut entries: Vec<Entry> = Vec::new();
        let mut groups: HashMap<(usize, &str), usize> = HashMap::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for (source, listings) in offered.iter().enumerate() {
            for listing in listings.iter() {
                // The first source to list a URL keeps it, so search and
                // resolve agree on one listing per URL.
                if !seen.insert(listing.url.as_str()) {
                    continue;
                }
                let indexed = Indexed::new(listing.clone());
                match &listing.group {
                    Some(group) => {
                        let at = *groups
                            .entry((source, group.id.as_str()))
                            .or_insert_with(|| {
                                entries.push(Entry::group(source, group.clone()));
                                entries.len() - 1
                            });
                        entries[at].listings.push(indexed);
                    }
                    None => entries.push(Entry::single(source, indexed)),
                }
            }
        }
        for entry in &mut entries {
            entry
                .listings
                .sort_by(|a, b| newest_first(&a.listing, &b.listing));
        }
        let by_url: HashMap<String, (usize, usize)> = entries
            .iter()
            .enumerate()
            .flat_map(|(at, entry)| {
                entry
                    .listings
                    .iter()
                    .enumerate()
                    .map(move |(i, indexed)| (indexed.listing.url.clone(), (at, i)))
            })
            .collect();
        let owned = entries
            .iter()
            .flat_map(|entry| &entry.listings)
            .any(|indexed| indexed.owner.is_some());
        Self {
            listings: by_url.len(),
            owned,
            entries,
            by_url,
            nouns: sources
                .iter()
                .map(|source| Arc::from(source.group_noun()))
                .collect(),
        }
    }

    fn result(&self, found: &Match) -> ResultGroup {
        let entry = &self.entries[found.entry];
        ResultGroup {
            group: entry.group.clone(),
            noun: Arc::clone(&self.nouns[entry.source]),
            collapsed: found.collapsed,
            size: entry.listings.len(),
            listings: found
                .listings
                .iter()
                .map(|&at| entry.listings[at].listing.clone())
                .collect(),
        }
    }
}

/// One group from one source, or one listing that has no group.
struct Entry {
    source: usize,
    group: Option<ListingGroup>,
    /// The group's label, lowercased, for matching.
    label: Option<String>,
    /// The group's id, or the lone listing's URL.
    id: String,
    /// Newest first.
    listings: Vec<Indexed>,
}

impl Entry {
    fn group(source: usize, group: ListingGroup) -> Self {
        Self {
            source,
            label: Some(group.label.to_lowercase()),
            id: group.id.clone(),
            group: Some(group),
            listings: Vec::new(),
        }
    }

    fn single(source: usize, indexed: Indexed) -> Self {
        Self {
            source,
            group: None,
            label: None,
            id: indexed.listing.url.clone(),
            listings: vec![indexed],
        }
    }

    /// What of this entry matches `filter`: of the listings it admits, the
    /// whole group when its label holds every word, else each listing that
    /// does. Also how many matched but belong to someone else.
    fn matching(&self, at: usize, filter: &Filter) -> (Option<Match>, usize) {
        let collapsed = !filter.words.is_empty()
            && self
                .label
                .as_deref()
                .is_some_and(|label| filter.holds_all(label));
        let mut listings = Vec::new();
        let mut outside = 0;
        for (i, indexed) in self.listings.iter().enumerate() {
            if !filter.admits(&indexed.listing) || !(collapsed || filter.holds_all(&indexed.text)) {
                continue;
            }
            if filter.in_scope(indexed) {
                listings.push(i);
            } else {
                outside += 1;
            }
        }
        let Some(&first) = listings.first() else {
            return (None, outside);
        };
        let newest = &self.listings[first].listing;
        let found = Match {
            entry: at,
            collapsed,
            key: SortKey {
                newest: newest.date,
                label: self
                    .label
                    .clone()
                    .unwrap_or_else(|| newest.title.to_lowercase()),
                source: self.source,
                grouped: self.group.is_some(),
                id: self.id.clone(),
            },
            listings,
        };
        (Some(found), outside)
    }
}

struct Indexed {
    listing: Listing,
    /// Everything a search word may match, lowercased.
    text: String,
    /// The owner's email as [`owner_key`] compares it.
    owner: Option<String>,
}

impl Indexed {
    fn new(listing: Listing) -> Self {
        let tail = url_tail(&listing.url);
        let mut parts = vec![listing.title.as_str(), tail.as_str()];
        if let Some(group) = &listing.group {
            parts.push(&group.label);
        }
        parts.extend(listing.fields.iter().map(|field| field.value.as_str()));
        // Joined by a line break, which no search word holds, so a word
        // never matches across two parts.
        let text = parts.join("\n").to_lowercase();
        let owner = listing.owner.as_deref().and_then(owner_key);
        Self {
            listing,
            text,
            owner,
        }
    }
}

/// An email as owners are compared: trimmed and lowercased, because a
/// source may spell an address in any case and the principal's is
/// lowercase. `None` for a blank one, which names nobody.
fn owner_key(email: &str) -> Option<String> {
    let email = email.trim();
    (!email.is_empty()).then(|| email.to_lowercase())
}

/// A [`SearchQuery`], ready to test listings against.
struct Filter {
    /// Lowercased.
    words: Vec<String>,
    kind: Option<ListingKind>,
    since: Option<DateTime<Utc>>,
    /// As [`owner_key`] compares it; `None` when the search keeps every
    /// owner's listings.
    owner: Option<String>,
}

impl Filter {
    fn new(query: &SearchQuery, owned: bool) -> Self {
        Self {
            words: query
                .words
                .to_lowercase()
                .split_whitespace()
                .map(str::to_string)
                .collect(),
            kind: query.kind,
            since: query.since,
            owner: query.owner.as_deref().filter(|_| owned).and_then(owner_key),
        }
    }

    fn holds_all(&self, text: &str) -> bool {
        self.words.iter().all(|word| text.contains(word.as_str()))
    }

    /// Whether the kind and date let `listing` through.
    fn admits(&self, listing: &Listing) -> bool {
        self.kind.is_none_or(|kind| listing.kind == kind)
            && self
                .since
                .is_none_or(|since| listing.date.is_some_and(|date| date >= since))
    }

    fn in_scope(&self, indexed: &Indexed) -> bool {
        self.owner.is_none() || indexed.owner == self.owner
    }
}

/// The last [`MATCHED_URL_SEGMENTS`] segments of a URL's path.
fn url_tail(url: &str) -> String {
    let path = url.split_once("://").map_or(url, |(_, rest)| rest);
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    segments[segments.len().saturating_sub(MATCHED_URL_SEGMENTS)..].join("/")
}

/// A result a search found: an entry and which of its listings matched.
struct Match {
    entry: usize,
    collapsed: bool,
    listings: Vec<usize>,
    key: SortKey,
}

/// Where a result sorts: newest listing first, undated last, then by label
/// and identity so the order is total and a cursor can name a place in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SortKey {
    newest: Option<DateTime<Utc>>,
    label: String,
    source: usize,
    grouped: bool,
    id: String,
}

impl Ord for SortKey {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .newest
            .cmp(&self.newest)
            .then_with(|| self.label.cmp(&other.label))
            .then_with(|| self.source.cmp(&other.source))
            .then_with(|| self.grouped.cmp(&other.grouped))
            .then_with(|| self.id.cmp(&other.id))
    }
}

impl PartialOrd for SortKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
