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
//! adds a network round trip to a request. [`load_at_boot`] performs the
//! one load the boot does. [`ProfileDirectory::load`] is the operation a
//! refresh would repeat.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

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

/// An in-memory snapshot of the listing, and the client that reads it.
pub struct ProfileDirectory {
    config: DirectoryConfig,
    http: reqwest::Client,
    rows: RwLock<Arc<HashMap<String, Profile>>>,
}

impl ProfileDirectory {
    /// Build the directory with an empty snapshot. Nothing is fetched
    /// here; call [`load`](Self::load) for that.
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
            config,
            http,
            rows: RwLock::new(Arc::new(HashMap::new())),
        })
    }

    /// Fetch the listing once and replace the snapshot with what it
    /// holds. On any error the snapshot is left as it was.
    pub async fn load(&self) -> Result<LoadReport, DirectoryError> {
        let listing = fetch_listing(&self.http, &self.config.url).await?;
        let (rows, skipped) = rows_from_listing(&listing, &self.config)?;
        let report = LoadReport {
            rows: rows.len(),
            skipped,
        };
        *self.rows.write().expect("directory snapshot lock") = Arc::new(rows);
        Ok(report)
    }

    /// The row for an email, if the snapshot holds one. The email is
    /// normalized before the lookup, so any spelling of one address
    /// finds the same row.
    pub fn lookup(&self, email: &str) -> Option<Profile> {
        let key = normalize_email(email)?;
        self.rows
            .read()
            .expect("directory snapshot lock")
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
}

/// Build the directory and load it once, at boot.
///
/// Never stops the boot. A listing that is down when the server starts
/// is an outage to survive, not a configuration to refuse: the server
/// comes up serving the names the auth mode derives, and says so once
/// in the log. Malformed configuration was refused before this ran.
/// `None` only when no HTTP client can be built at all, which is a
/// property of the process rather than of the listing.
pub async fn load_at_boot(config: DirectoryConfig) -> Option<Arc<ProfileDirectory>> {
    let url = redacted(&config.url);
    info!(
        url = %url,
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
    match directory.load().await {
        Ok(report) => info!(
            url = %url,
            rows = report.rows,
            skipped = report.skipped,
            "auth.directory.loaded",
        ),
        Err(e) => warn!(url = %url, error = %e, "auth.directory.load_failed"),
    }
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

    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use serde_json::Value;
    use tokio::sync::Mutex;

    struct Served {
        status: StatusCode,
        body: String,
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
        }

        /// Answer the next fetches with this status and an empty body.
        pub async fn fail(&self, status: StatusCode) {
            let mut guard = self.state.lock().await;
            guard.status = status;
            guard.body.clear();
        }

        pub async fn fetch_count(&self) -> usize {
            self.state.lock().await.fetches
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
        let mut guard = mock.state.lock().await;
        guard.fetches += 1;
        guard.last_headers = headers;
        (
            guard.status,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            guard.body.clone(),
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
}
