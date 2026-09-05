//! The profile directory: an optional source of display names and
//! pictures, keyed by email address, applied to every principal the
//! auth middleware attaches.
//!
//! An auth mode decides who a caller is. A perimeter's assertion
//! carries only an email, so in that mode the display name is derived
//! from the address and there is no picture at all. The directory fills
//! those two fields in from a listing the operator names, and does
//! nothing else: it never changes the email, never changes the
//! administrator flag, and never stands in for a credential. See
//! ADR-0063.
//!
//! One operation matters to the rest of the server: [`ProfileDirectory::apply`],
//! which the middleware calls after the mode's extractor resolved a
//! principal and before the principal reaches a handler. The lookup key
//! is the email the mode resolved, normalized the way every mode
//! normalizes it, so nothing a request carries can choose whose row is
//! shown.
//!
//! The listing is fetched whole and held in memory, so a lookup never
//! adds a network round trip to a request. [`load_at_boot`] builds the
//! directory, loads it once, and starts the schedule that keeps it
//! loaded: a first load that failed is retried on a backoff until one
//! succeeds, and a loaded snapshot is refreshed every interval. The
//! schedule is the only thing that fetches. A refresh that fails, or
//! that returns a listing with no rows, leaves the last good snapshot
//! in place and says so in the log, and a snapshot that outlives two
//! intervals is logged as stale once. No request performs, waits on,
//! or triggers a fetch.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock, Weak};
use std::time::{Duration, Instant};

use axum::http::header::HeaderMap;
use lucida_core::auth_principal::AuthPrincipal;
use serde_json::Value;
use tracing::{error, info, warn};

use super::config::DirectoryConfig;
use super::principal::normalize_email;

/// How long one fetch of the listing may take, connect to last byte.
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(10);

/// What the directory holds for one email: either field may be absent
/// when the row does not carry it, and an absent field leaves the
/// mode's value in place.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Profile {
    pub display_name: Option<String>,
    pub picture_url: Option<String>,
}

/// What one load produced: rows kept, keyed by normalized email, and
/// rows dropped for carrying no usable email. Two spellings of one
/// address count as one row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoadReport {
    pub rows: usize,
    pub skipped: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum DirectoryError {
    /// The HTTP client could not be built. Not a property of the
    /// listing; a process that hits this cannot fetch anything.
    #[error("directory client could not be built: {0}")]
    Client(String),
    /// The listing could not be reached or did not answer in time.
    #[error("directory fetch failed: {0}")]
    Network(String),
    /// The listing answered, and the answer was not a success.
    #[error("directory answered status {0}")]
    Status(u16),
    /// The body is not a JSON array.
    #[error("directory listing is not a JSON array: {0}")]
    Decode(String),
}

/// An in-memory snapshot of the listing, the client that reads it, and
/// the schedule that keeps it read.
pub struct ProfileDirectory {
    config: DirectoryConfig,
    /// The listing URL as it may be logged, computed once.
    shown_url: String,
    http: reqwest::Client,
    snapshot: RwLock<Snapshot>,
    /// How many times a snapshot has been logged as stale. Counted so a
    /// test can assert on the log's mechanism rather than its output.
    stale_episodes: AtomicUsize,
}

/// What requests read, and what the schedule knows about its age.
struct Snapshot {
    rows: Arc<HashMap<String, Profile>>,
    /// When `rows` last came from a listing. `None` until a load yields
    /// a row, which an empty listing never does.
    loaded_at: Option<Instant>,
    /// Whether this snapshot's age has been logged. Cleared when the
    /// snapshot is replaced, so each stale episode is logged once.
    stale_logged: bool,
}

/// The age at which a snapshot is stale, as a multiple of the refresh
/// interval: two missed refreshes in a row.
const STALE_AFTER_INTERVALS: u32 = 2;

impl ProfileDirectory {
    /// Build the directory with an empty snapshot and no schedule.
    /// Nothing is fetched here; [`load_at_boot`] does that and starts
    /// the schedule, and a test calls [`load`](Self::load) by hand.
    pub fn new(config: DirectoryConfig) -> Result<Self, DirectoryError> {
        let mut headers = HeaderMap::new();
        for (name, value) in &config.headers {
            headers.append(name.clone(), value.clone());
        }
        let http = reqwest::Client::builder()
            .timeout(LOAD_TIMEOUT)
            .default_headers(headers)
            .build()
            .map_err(|e| DirectoryError::Client(e.to_string()))?;
        Ok(Self {
            shown_url: redacted(&config.url),
            config,
            http,
            snapshot: RwLock::new(Snapshot {
                rows: Arc::new(HashMap::new()),
                loaded_at: None,
                stale_logged: false,
            }),
            stale_episodes: AtomicUsize::new(0),
        })
    }

    /// Fetch the listing once and, when it yields at least one row,
    /// replace the snapshot with what it holds. A listing that yields
    /// none is reported and leaves the snapshot as it was, because a
    /// directory can serve an empty list before its own first load and
    /// an empty answer is no reason to erase the names people already
    /// see. On any error the snapshot is left as it was.
    pub(crate) async fn load(&self) -> Result<LoadReport, DirectoryError> {
        let listing = fetch_listing(&self.http, &self.config.url).await?;
        let (rows, skipped) = rows_from_listing(&listing, &self.config)?;
        let report = LoadReport {
            rows: rows.len(),
            skipped,
        };
        if !rows.is_empty() {
            let mut snapshot = self.snapshot.write().expect("directory snapshot lock");
            snapshot.rows = Arc::new(rows);
            snapshot.loaded_at = Some(Instant::now());
            snapshot.stale_logged = false;
        }
        Ok(report)
    }

    /// The row for an email, if the snapshot holds one. The email is
    /// normalized before the lookup, so any spelling of one address
    /// finds the same row.
    pub fn lookup(&self, email: &str) -> Option<Profile> {
        let key = normalize_email(email)?;
        self.snapshot
            .read()
            .expect("directory snapshot lock")
            .rows
            .get(&key)
            .cloned()
    }

    /// Enrich a principal from its row. Writes the display name and the
    /// picture URL, each only when the row carries one, and touches
    /// nothing else. The email and the administrator flag are the
    /// auth mode's to decide, whatever the row says about them.
    pub fn apply(&self, principal: &mut AuthPrincipal) {
        let Some(profile) = self.lookup(&principal.email) else {
            return;
        };
        if let Some(name) = profile.display_name {
            principal.display_name = name;
        }
        if let Some(picture) = profile.picture_url {
            principal.picture_url = Some(picture);
        }
    }

    /// Whether any load has yielded a row. Decides which schedule the
    /// task is on: retrying a first load, or refreshing a snapshot.
    fn is_loaded(&self) -> bool {
        self.snapshot
            .read()
            .expect("directory snapshot lock")
            .loaded_at
            .is_some()
    }

    /// One attempt, the boot's or the schedule's. It fetches, then logs
    /// what happened, naming the listing and no one in it.
    ///
    /// A failure before the first load logs as `load_failed`, meaning
    /// no names yet. A failure after it logs as `refresh_failed`,
    /// meaning the names are getting older. Whoever watches the log
    /// treats those differently, so they get different names.
    async fn attempt(&self) {
        let loaded_before = self.is_loaded();
        match self.load().await {
            Ok(report) if report.rows > 0 => info!(
                url = %self.shown_url,
                rows = report.rows,
                skipped = report.skipped,
                "auth.directory.loaded",
            ),
            Ok(report) => warn!(
                url = %self.shown_url,
                skipped = report.skipped,
                "auth.directory.empty",
            ),
            Err(e) if loaded_before => {
                warn!(url = %self.shown_url, error = %e, "auth.directory.refresh_failed");
            }
            Err(e) => warn!(url = %self.shown_url, error = %e, "auth.directory.load_failed"),
        }
        self.check_stale();
    }

    /// Log the snapshot as stale, once, when it has outlived two
    /// refresh intervals. Runs after every attempt on the schedule and
    /// never on a request, so the line appears once per episode rather
    /// than once per person who happened to be looked up. A snapshot
    /// that has just loaded is not stale, and one that never loaded
    /// has no age.
    fn check_stale(&self) {
        let mut snapshot = self.snapshot.write().expect("directory snapshot lock");
        let Some(loaded_at) = snapshot.loaded_at else {
            return;
        };
        let age = loaded_at.elapsed();
        let stale_after = self
            .config
            .refresh_interval
            .saturating_mul(STALE_AFTER_INTERVALS);
        if snapshot.stale_logged || age < stale_after {
            return;
        }
        snapshot.stale_logged = true;
        self.stale_episodes.fetch_add(1, Ordering::Relaxed);
        warn!(
            url = %self.shown_url,
            age_s = age.as_secs(),
            refresh_s = self.config.refresh_interval.as_secs(),
            "auth.directory.stale",
        );
    }

    /// How many stale episodes have been logged so far.
    #[cfg(test)]
    pub(crate) fn stale_episodes(&self) -> usize {
        self.stale_episodes.load(Ordering::Relaxed)
    }
}

/// The schedule: retry the first load on the backoff until one yields
/// rows, then refresh every interval for the rest of the process.
///
/// This loop is the only caller of `load` outside tests, and it awaits
/// each attempt before it sleeps, so one fetch is in flight at a time
/// by construction and no request ever performs or waits on one. It
/// holds the directory weakly and upgrades only around an attempt, so
/// the directory owns the task. Dropping the last handle ends it at
/// its next wake.
async fn run_schedule(directory: Weak<ProfileDirectory>) {
    let (mut retries, interval) = {
        let Some(directory) = directory.upgrade() else {
            return;
        };
        (
            directory.config.backoff.delays(),
            directory.config.refresh_interval,
        )
    };
    loop {
        let delay = {
            let Some(directory) = directory.upgrade() else {
                return;
            };
            if directory.is_loaded() {
                interval
            } else {
                retries.next().expect("the backoff has no end")
            }
        };
        tokio::time::sleep(delay).await;
        let Some(directory) = directory.upgrade() else {
            return;
        };
        directory.attempt().await;
    }
}

/// Build the directory, load it once, and start the schedule that
/// keeps it loaded.
///
/// Never stops the boot. A listing that is down when the server starts
/// is an outage to survive, not a configuration to refuse: the server
/// comes up serving the names the auth mode derives, says so in the
/// log, and the schedule keeps trying. Malformed configuration was
/// refused before this ran. `None` only when no HTTP client can be
/// built at all, which is a property of the process rather than of the
/// listing.
pub async fn load_at_boot(config: DirectoryConfig) -> Option<Arc<ProfileDirectory>> {
    info!(
        url = %redacted(&config.url),
        email_field = %config.email_field,
        name_fields = ?config.name_fields,
        picture_field = %config.picture_field,
        headers = config.headers.len(),
        refresh_s = config.refresh_interval.as_secs(),
        "auth.directory.startup",
    );
    let directory = match ProfileDirectory::new(config) {
        Ok(directory) => Arc::new(directory),
        Err(e) => {
            error!(error = %e, "auth.directory.unavailable");
            return None;
        }
    };
    directory.attempt().await;
    tokio::spawn(run_schedule(Arc::downgrade(&directory)));
    Some(directory)
}

/// The listing URL as it may be logged: a listing that wants an API
/// key may carry it in the query string or the userinfo, and neither
/// belongs in a log line.
fn redacted(url: &reqwest::Url) -> String {
    let mut shown = url.clone();
    let _ = shown.set_username("");
    let _ = shown.set_password(None);
    shown.set_query(None);
    shown.set_fragment(None);
    shown.to_string()
}

async fn fetch_listing(
    http: &reqwest::Client,
    url: &reqwest::Url,
) -> Result<Value, DirectoryError> {
    let res = http
        .get(url.clone())
        .send()
        .await
        .map_err(|e| DirectoryError::Network(e.without_url().to_string()))?;
    let status = res.status();
    if !status.is_success() {
        return Err(DirectoryError::Status(status.as_u16()));
    }
    res.json::<Value>()
        .await
        .map_err(|e| DirectoryError::Decode(e.to_string()))
}

/// Turn the listing into rows keyed by normalized email.
///
/// An entry is skipped, and counted, when it is not an object or when
/// its email field is missing, blank, not a string, or not an address.
/// A later entry for an address already seen replaces the earlier one,
/// so a listing that spells one person twice yields one row.
fn rows_from_listing(
    listing: &Value,
    config: &DirectoryConfig,
) -> Result<(HashMap<String, Profile>, usize), DirectoryError> {
    let Some(entries) = listing.as_array() else {
        return Err(DirectoryError::Decode(format!(
            "expected an array, got {}",
            json_kind(listing)
        )));
    };
    let mut rows = HashMap::new();
    let mut skipped = 0;
    for entry in entries {
        let Some(email) = entry
            .get(&config.email_field)
            .and_then(Value::as_str)
            .and_then(normalize_email)
        else {
            skipped += 1;
            continue;
        };
        rows.insert(email, profile_from_row(entry, config));
    }
    Ok((rows, skipped))
}

/// The name is the configured fields, in order, trimmed, with absent
/// and blank ones left out, joined by one space. No field present
/// means no name, which leaves the mode's in place.
fn profile_from_row(row: &Value, config: &DirectoryConfig) -> Profile {
    let display_name = config
        .name_fields
        .iter()
        .filter_map(|field| row.get(field).and_then(Value::as_str))
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let picture_url = row
        .get(&config.picture_field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string);
    Profile {
        display_name: (!display_name.is_empty()).then_some(display_name),
        picture_url,
    }
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A listing served from an ephemeral local listener, shared with
    //! the middleware tests next door. Same shape as the IAP tests'
    //! mock key set: the body and status are swappable, and the mock
    //! counts fetches and keeps the headers of the last one.

    use std::sync::Arc;
    use std::time::Duration;

    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use serde_json::Value;
    use tokio::sync::Mutex;

    use crate::auth::config::{Backoff, DirectoryConfig};

    /// How long a test waits for the schedule to do something, and how
    /// often it looks. The schedules under test run in milliseconds.
    /// The limit is for a loaded machine, not a design number.
    pub const POLL_LIMIT: Duration = Duration::from_secs(10);
    pub const POLL_STEP: Duration = Duration::from_millis(10);

    /// Poll `condition` until it holds, or fail after [`POLL_LIMIT`].
    pub async fn eventually(what: &str, mut condition: impl AsyncFnMut() -> bool) {
        let started = std::time::Instant::now();
        while !condition().await {
            assert!(
                started.elapsed() < POLL_LIMIT,
                "still waiting after {POLL_LIMIT:?}: {what}"
            );
            tokio::time::sleep(POLL_STEP).await;
        }
    }

    /// Config for `url` whose first-load retries and refreshes both run
    /// in milliseconds, so a test can watch the schedule act.
    pub fn fast_schedule(url: &str) -> DirectoryConfig {
        let mut cfg = DirectoryConfig::for_tests(url);
        cfg.backoff = Backoff {
            first: Duration::from_millis(20),
            cap: Duration::from_millis(80),
        };
        cfg.refresh_interval = Duration::from_millis(100);
        cfg
    }

    struct Served {
        status: StatusCode,
        body: String,
        /// Hold every fetch open past the load timeout before answering.
        hang: bool,
        fetches: usize,
        last_headers: HeaderMap,
    }

    #[derive(Clone)]
    pub struct MockListing {
        state: Arc<Mutex<Served>>,
    }

    impl MockListing {
        /// Answer the next fetches with this listing and a 200.
        pub async fn serve(&self, listing: Value) {
            let mut guard = self.state.lock().await;
            guard.status = StatusCode::OK;
            guard.body = listing.to_string();
            guard.hang = false;
        }

        /// Answer the next fetches with this status and an empty body.
        pub async fn fail(&self, status: StatusCode) {
            let mut guard = self.state.lock().await;
            guard.status = status;
            guard.body.clear();
            guard.hang = false;
        }

        /// Hold the next fetches open past the load timeout, the shape
        /// of a listing that accepts connections and never answers.
        pub async fn hang(&self) {
            self.state.lock().await.hang = true;
        }

        pub async fn fetch_count(&self) -> usize {
            self.state.lock().await.fetches
        }

        /// Wait until at least this many fetches have arrived, or fail
        /// after the polling limit.
        pub async fn wait_for_fetches(&self, at_least: usize) {
            eventually(&format!("at least {at_least} fetches"), async || {
                self.fetch_count().await >= at_least
            })
            .await;
        }

        /// The value of one header on the most recent fetch, if it was
        /// sent.
        pub async fn last_header(&self, name: &str) -> Option<String> {
            self.state
                .lock()
                .await
                .last_headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        }
    }

    async fn listing(State(mock): State<MockListing>, headers: HeaderMap) -> impl IntoResponse {
        let (status, body, hang) = {
            let mut guard = mock.state.lock().await;
            guard.fetches += 1;
            guard.last_headers = headers;
            (guard.status, guard.body.clone(), guard.hang)
        };
        if hang {
            // Sleep outside the lock so `fetch_count` keeps answering
            // while this fetch is held past the client's timeout.
            tokio::time::sleep(super::LOAD_TIMEOUT * 3).await;
        }
        (
            status,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            body,
        )
    }

    /// Stand the mock up on an ephemeral port serving `listing`.
    /// Returns the URL to configure as `LUCIDA_DIRECTORY_URL` and a
    /// handle for changing what it serves.
    pub async fn spawn_mock_listing(listing: Value) -> (String, MockListing) {
        spawn(StatusCode::OK, listing.to_string()).await
    }

    /// Stand the mock up answering `status` with an empty body, the
    /// shape of a listing that is down when the server boots.
    pub async fn spawn_failing_listing(status: StatusCode) -> (String, MockListing) {
        spawn(status, String::new()).await
    }

    async fn spawn(status: StatusCode, body: String) -> (String, MockListing) {
        let mock = MockListing {
            state: Arc::new(Mutex::new(Served {
                status,
                body,
                hang: false,
                fetches: 0,
                last_headers: HeaderMap::new(),
            })),
        };
        let app = Router::new()
            .route("/people", get(self::listing))
            .with_state(mock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock listing");
        let addr = listener.local_addr().expect("mock listing address");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}/people"), mock)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use axum::http::StatusCode;
    use serde_json::json;

    fn config(url: &str) -> DirectoryConfig {
        DirectoryConfig::for_tests(url)
    }

    /// A directory that has loaded its listing once.
    async fn loaded(cfg: DirectoryConfig) -> ProfileDirectory {
        let directory = ProfileDirectory::new(cfg).unwrap();
        directory.load().await.unwrap();
        directory
    }

    fn principal(email: &str, is_admin: bool) -> AuthPrincipal {
        AuthPrincipal {
            email: email.to_string(),
            display_name: "Resolved Name".to_string(),
            picture_url: Some("https://resolved.example/p.png".to_string()),
            is_admin,
        }
    }

    // -- Turning a listing into rows -------------------------------------

    #[test]
    fn rows_are_keyed_by_normalized_email_and_unusable_entries_are_counted() {
        let listing = json!([
            {"email": "  Alice@Example.com ", "name": "Alice"},
            {"email": "", "name": "Blank"},
            {"email": "   ", "name": "Spaces"},
            {"email": 42, "name": "Number"},
            {"email": "no-at-sign", "name": "Not An Address"},
            {"name": "Missing"},
            "not an object",
            null,
        ]);
        let (rows, skipped) = rows_from_listing(&listing, &config("http://127.0.0.1:1/people"))
            .expect("an array parses");
        assert_eq!(rows.len(), 1);
        assert_eq!(skipped, 7);
        assert_eq!(
            rows["alice@example.com"].display_name.as_deref(),
            Some("Alice")
        );
    }

    #[test]
    fn two_spellings_of_one_email_are_one_row_and_the_later_wins() {
        let listing = json!([
            {"email": "Alice@Example.com", "name": "First Spelling"},
            {"email": " alice@example.com ", "name": "Second Spelling"},
        ]);
        let (rows, skipped) = rows_from_listing(&listing, &config("http://127.0.0.1:1/people"))
            .expect("an array parses");
        assert_eq!(rows.len(), 1);
        assert_eq!(skipped, 0);
        assert_eq!(
            rows["alice@example.com"].display_name.as_deref(),
            Some("Second Spelling")
        );
    }

    #[test]
    fn a_name_is_the_configured_fields_joined_by_one_space() {
        let mut cfg = config("http://127.0.0.1:1/people");
        cfg.name_fields = vec!["first_name".into(), "middle".into(), "last_name".into()];
        let row = json!({
            "email": "a@example.com",
            "first_name": "  Alice ",
            "middle": "   ",
            "last_name": "Example",
            "name": "Ignored Because Not Configured",
        });
        let profile = profile_from_row(&row, &cfg);
        assert_eq!(profile.display_name.as_deref(), Some("Alice Example"));
    }

    #[test]
    fn a_row_without_a_name_or_picture_carries_neither() {
        let cfg = config("http://127.0.0.1:1/people");
        let row = json!({"email": "a@example.com", "name": " ", "picture": ""});
        assert_eq!(profile_from_row(&row, &cfg), Profile::default());
        let row = json!({"email": "a@example.com", "name": 7, "picture": null});
        assert_eq!(profile_from_row(&row, &cfg), Profile::default());
    }

    #[test]
    fn a_listing_that_is_not_an_array_is_a_decode_error() {
        let err = rows_from_listing(&json!({"people": []}), &config("http://127.0.0.1:1/people"))
            .expect_err("an object is not a listing");
        assert!(matches!(err, DirectoryError::Decode(_)), "{err:?}");
        assert!(err.to_string().contains("an object"), "{err}");
    }

    // -- Applying a row to a principal -----------------------------------

    #[tokio::test]
    async fn apply_replaces_name_and_picture_and_nothing_else() {
        let (url, _mock) = spawn_mock_listing(json!([
            {
                "email": "ALICE@example.com",
                "name": "Alice Example",
                "picture": "https://pictures.example/alice.png",
                "is_admin": true,
            },
        ]))
        .await;
        let directory = loaded(config(&url)).await;

        let mut p = principal("alice@example.com", false);
        directory.apply(&mut p);
        assert_eq!(p.email, "alice@example.com");
        assert_eq!(p.display_name, "Alice Example");
        assert_eq!(
            p.picture_url.as_deref(),
            Some("https://pictures.example/alice.png")
        );
        assert!(!p.is_admin, "the row's flag is not consulted");
    }

    #[tokio::test]
    async fn apply_leaves_a_principal_without_a_row_untouched() {
        let (url, _mock) =
            spawn_mock_listing(json!([{"email": "alice@example.com", "name": "Alice"}])).await;
        let directory = loaded(config(&url)).await;

        let before = principal("bob@example.com", true);
        let mut after = before.clone();
        directory.apply(&mut after);
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn apply_keeps_the_modes_value_for_a_field_the_row_lacks() {
        let (url, _mock) = spawn_mock_listing(json!([
            {"email": "alice@example.com", "picture": "https://pictures.example/alice.png"},
        ]))
        .await;
        let directory = loaded(config(&url)).await;

        let mut p = principal("alice@example.com", false);
        directory.apply(&mut p);
        assert_eq!(p.display_name, "Resolved Name");
        assert_eq!(
            p.picture_url.as_deref(),
            Some("https://pictures.example/alice.png")
        );
    }

    // -- Loading -----------------------------------------------------------

    #[tokio::test]
    async fn load_reports_rows_kept_and_rows_skipped() {
        let (url, mock) = spawn_mock_listing(json!([
            {"email": "alice@example.com", "name": "Alice"},
            {"email": "Alice@Example.com", "name": "Alice Again"},
            {"email": "bob@example.com", "name": "Bob"},
            {"name": "Nobody"},
        ]))
        .await;
        let directory = ProfileDirectory::new(config(&url)).unwrap();
        let report = directory.load().await.expect("the mock serves a listing");
        assert_eq!(
            report,
            LoadReport {
                rows: 2,
                skipped: 1
            }
        );
        assert_eq!(mock.fetch_count().await, 1);
    }

    #[tokio::test]
    async fn load_sends_the_configured_fixed_headers() {
        let (url, mock) = spawn_mock_listing(json!([])).await;
        let mut cfg = config(&url);
        cfg.headers = vec![(
            axum::http::HeaderName::from_static("x-requested-by"),
            axum::http::HeaderValue::from_static("lucida"),
        )];
        loaded(cfg).await;
        assert_eq!(
            mock.last_header("x-requested-by").await.as_deref(),
            Some("lucida")
        );
    }

    #[tokio::test]
    async fn a_failed_load_is_an_error_and_leaves_the_snapshot_as_it_was() {
        let (url, mock) =
            spawn_mock_listing(json!([{"email": "alice@example.com", "name": "Alice"}])).await;
        let directory = loaded(config(&url)).await;

        mock.fail(StatusCode::INTERNAL_SERVER_ERROR).await;
        let err = directory.load().await.expect_err("a 500 is not a listing");
        assert!(matches!(err, DirectoryError::Status(500)), "{err:?}");
        assert!(
            directory.lookup("alice@example.com").is_some(),
            "the earlier snapshot survives a failed load"
        );
    }

    /// `load` is the operation a refresh repeats: a second call reads
    /// whatever the listing says now.
    #[tokio::test]
    async fn a_later_load_replaces_the_snapshot_with_the_current_listing() {
        let (url, mock) =
            spawn_mock_listing(json!([{"email": "alice@example.com", "name": "Alice"}])).await;
        let directory = loaded(config(&url)).await;

        mock.serve(json!([{"email": "alice@example.com", "name": "Alice Renamed"}]))
            .await;
        directory.load().await.unwrap();
        assert_eq!(
            directory
                .lookup("alice@example.com")
                .and_then(|p| p.display_name)
                .as_deref(),
            Some("Alice Renamed")
        );
        assert_eq!(mock.fetch_count().await, 2);
    }

    /// A directory can serve an empty list before its own first load,
    /// so an empty listing means "not loaded yet", never "nobody".
    #[tokio::test]
    async fn an_empty_listing_does_not_replace_a_populated_snapshot() {
        let (url, mock) =
            spawn_mock_listing(json!([{"email": "alice@example.com", "name": "Alice"}])).await;
        let directory = loaded(config(&url)).await;

        mock.serve(json!([])).await;
        let report = directory
            .load()
            .await
            .expect("an empty array is a listing, not an error");
        assert_eq!(
            report,
            LoadReport {
                rows: 0,
                skipped: 0
            }
        );
        assert!(
            directory.lookup("alice@example.com").is_some(),
            "the populated snapshot survives an empty listing"
        );
    }

    /// The same holds for a listing that has entries and no usable
    /// email in any of them: nothing to show is nothing to replace with.
    #[tokio::test]
    async fn a_listing_with_no_usable_row_does_not_replace_a_populated_snapshot() {
        let (url, mock) =
            spawn_mock_listing(json!([{"email": "alice@example.com", "name": "Alice"}])).await;
        let directory = loaded(config(&url)).await;

        mock.serve(json!([{"address": "alice@example.com", "name": "Alice"}]))
            .await;
        let report = directory.load().await.expect("an array parses");
        assert_eq!(
            report,
            LoadReport {
                rows: 0,
                skipped: 1
            }
        );
        assert!(directory.lookup("alice@example.com").is_some());
    }

    #[tokio::test]
    async fn an_unreachable_listing_is_a_network_error() {
        // Port 1 on loopback refuses immediately, so this does not wait
        // out the timeout.
        let directory = ProfileDirectory::new(config("http://127.0.0.1:1/people")).unwrap();
        let err = directory.load().await.expect_err("nothing listens there");
        assert!(matches!(err, DirectoryError::Network(_)), "{err:?}");
        assert!(directory.lookup("anyone@example.com").is_none());
    }

    #[tokio::test]
    async fn start_survives_a_listing_that_is_down_and_serves_nothing_from_it() {
        let (url, _mock) = spawn_failing_listing(StatusCode::INTERNAL_SERVER_ERROR).await;
        let directory = load_at_boot(config(&url)).await.expect("a client builds");
        let mut p = principal("alice@example.com", false);
        let before = p.clone();
        directory.apply(&mut p);
        assert_eq!(p, before);
    }

    // -- The schedule ------------------------------------------------------

    /// Config whose first-load retries run in milliseconds while the
    /// refresh interval stays at its six-hour default, so a load that
    /// happens within a test can only have come from a retry.
    fn config_retrying_fast(url: &str) -> DirectoryConfig {
        let mut cfg = config(url);
        cfg.backoff = fast_schedule(url).backoff;
        cfg
    }

    fn name_of(directory: &ProfileDirectory, email: &str) -> Option<String> {
        directory.lookup(email).and_then(|p| p.display_name)
    }

    #[tokio::test]
    async fn a_first_load_that_fails_is_retried_until_the_listing_answers() {
        let (url, mock) = spawn_failing_listing(StatusCode::SERVICE_UNAVAILABLE).await;
        let directory = load_at_boot(config_retrying_fast(&url))
            .await
            .expect("a client builds");
        assert!(directory.lookup("alice@example.com").is_none());
        mock.wait_for_fetches(3).await;

        mock.serve(json!([{"email": "alice@example.com", "name": "Alice"}]))
            .await;
        eventually("the retry loads the listing", async || {
            directory.lookup("alice@example.com").is_some()
        })
        .await;
    }

    /// An empty listing at boot is not the first load. The schedule
    /// stays on the retry backoff, in milliseconds here, rather than
    /// moving to the interval, which is six hours here.
    #[tokio::test]
    async fn an_empty_listing_at_boot_is_not_a_load_and_the_retry_continues() {
        let (url, mock) = spawn_mock_listing(json!([])).await;
        let directory = load_at_boot(config_retrying_fast(&url))
            .await
            .expect("a client builds");
        mock.wait_for_fetches(3).await;

        mock.serve(json!([{"email": "alice@example.com", "name": "Alice"}]))
            .await;
        eventually("the retry loads the listing", async || {
            directory.lookup("alice@example.com").is_some()
        })
        .await;
    }

    /// Once refreshes fail, the snapshot ages. At twice the interval
    /// it is logged as stale, once, and a load that succeeds ends the
    /// episode so the next one is logged again.
    #[tokio::test]
    async fn a_stale_snapshot_is_logged_once_per_episode() {
        let (url, mock) =
            spawn_mock_listing(json!([{"email": "alice@example.com", "name": "Alice"}])).await;
        let directory = load_at_boot(fast_schedule(&url))
            .await
            .expect("a client builds");
        assert_eq!(directory.stale_episodes(), 0);

        mock.fail(StatusCode::INTERNAL_SERVER_ERROR).await;
        mock.wait_for_fetches(6).await;
        assert_eq!(
            directory.stale_episodes(),
            1,
            "logged once, not per refresh"
        );
        assert_eq!(
            name_of(&directory, "alice@example.com").as_deref(),
            Some("Alice"),
            "stale is still served"
        );

        mock.serve(json!([{"email": "alice@example.com", "name": "Alice Renamed"}]))
            .await;
        eventually("a refresh loads the new listing", async || {
            name_of(&directory, "alice@example.com").as_deref() == Some("Alice Renamed")
        })
        .await;
        let recovered_at = mock.fetch_count().await;
        assert_eq!(directory.stale_episodes(), 1, "recovery is not an episode");

        mock.fail(StatusCode::INTERNAL_SERVER_ERROR).await;
        mock.wait_for_fetches(recovered_at + 5).await;
        assert_eq!(directory.stale_episodes(), 2, "a second episode logs again");
    }

    /// The directory owns the schedule. Dropping the last handle ends
    /// the task rather than leaving it fetching for the process's life.
    #[tokio::test]
    async fn dropping_the_directory_ends_the_schedule() {
        let (url, mock) = spawn_failing_listing(StatusCode::SERVICE_UNAVAILABLE).await;
        let directory = load_at_boot(config_retrying_fast(&url))
            .await
            .expect("a client builds");
        mock.wait_for_fetches(3).await;

        drop(directory);
        // A wake that upgraded its handle before the drop still runs its
        // attempt, so the baseline waits out the backoff cap first.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let after_drop = mock.fetch_count().await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            mock.fetch_count().await,
            after_drop,
            "no fetch after the drop"
        );
    }
}
