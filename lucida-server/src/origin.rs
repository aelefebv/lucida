//! Which web origins may reach the server from a browser: the server's own,
//! plus any listed in `LUCIDA_ALLOWED_ORIGINS`.
//!
//! Two places ask. A WebSocket upgrade that carries an `Origin` must come
//! from one of them, because a browser attaches cookies to a cross-site
//! upgrade and no CORS check stands in the way. And only a listed origin
//! gets CORS headers; with none listed the server sends none, so a page on
//! another site cannot read the API through a visitor's browser.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header::{HOST, ORIGIN, SEC_WEBSOCKET_VERSION};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use reqwest::Url;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

pub const ALLOWED_ORIGINS_VAR: &str = "LUCIDA_ALLOWED_ORIGINS";

/// An entry in `LUCIDA_ALLOWED_ORIGINS` that is not an origin. Fails the
/// boot, so a typo does not quietly lock out the page it meant to admit.
#[derive(Debug, thiserror::Error)]
#[error(
    "LUCIDA_ALLOWED_ORIGINS entry {entry:?} is not an origin such as https://viewer.example.com \
     ({reason})"
)]
pub struct OriginConfigError {
    entry: String,
    reason: String,
}

/// The origins allowed besides the server's own, each in the form a
/// browser writes in an `Origin` header.
#[derive(Debug, Clone, Default)]
pub struct OriginPolicy {
    allowed: Vec<String>,
}

impl OriginPolicy {
    pub fn from_env() -> Result<Self, OriginConfigError> {
        Self::parse(std::env::var(ALLOWED_ORIGINS_VAR).ok().as_deref())
    }

    /// Comma-separated origins. Unset or blank allows the server's own
    /// origin only.
    pub fn parse(raw: Option<&str>) -> Result<Self, OriginConfigError> {
        let allowed = raw
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(parse_entry)
            .collect::<Result<_, _>>()?;
        Ok(Self { allowed })
    }

    pub fn allowed(&self) -> &[String] {
        &self.allowed
    }

    /// Whether a WebSocket upgrade with these headers may proceed.
    ///
    /// No `Origin` passes: browsers always send one on an upgrade, and the
    /// clients that omit it (the CLI, the Python client) present a bearer
    /// token, which a page on another site cannot make a browser attach.
    /// `authority` is the request URI's, which stands in for `Host` on
    /// HTTP/2.
    pub fn permits_upgrade(&self, headers: &HeaderMap, authority: Option<&str>) -> bool {
        let Some(origin) = headers.get(ORIGIN) else {
            return true;
        };
        let Some(origin) = origin.to_str().ok().and_then(parse_origin) else {
            return false;
        };
        if self
            .allowed
            .iter()
            .any(|allowed| *allowed == origin.origin().ascii_serialization())
        {
            return true;
        }
        let host = headers
            .get(HOST)
            .and_then(|host| host.to_str().ok())
            .or(authority);
        host.is_some_and(|host| names_host(&origin, host))
    }

    /// CORS for the listed origins, with credentials, since the operator
    /// chose to trust them. `None` with nothing listed: the server's own
    /// pages are same-origin and need no CORS headers.
    pub fn cors_layer(&self) -> Option<CorsLayer> {
        if self.allowed.is_empty() {
            return None;
        }
        let origins: Vec<HeaderValue> = self
            .allowed
            .iter()
            .map(|origin| HeaderValue::from_str(origin).expect("an ASCII origin is a header value"))
            .collect();
        Some(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_credentials(true)
                .allow_methods(AllowMethods::mirror_request())
                .allow_headers(AllowHeaders::mirror_request()),
        )
    }
}

fn parse_entry(entry: &str) -> Result<String, OriginConfigError> {
    let invalid = |reason: &str| OriginConfigError {
        entry: entry.to_string(),
        reason: reason.to_string(),
    };
    if entry == "*" {
        return Err(invalid("a wildcard would admit every site"));
    }
    let url = Url::parse(entry).map_err(|e| invalid(&e.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid("the scheme must be http or https"));
    }
    if url.host_str().is_none() {
        return Err(invalid("there is no host"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("an origin has no user name or password"));
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(invalid("an origin has no path, query, or fragment"));
    }
    Ok(url.origin().ascii_serialization())
}

/// A non-opaque origin. `null` (a sandboxed frame, a file) is opaque and
/// matches nothing.
fn parse_origin(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    url.origin().is_tuple().then_some(url)
}

/// Whether `origin` names the host the request was sent to. The scheme is
/// taken from the origin, because behind a perimeter that terminates TLS
/// the server never sees the scheme the browser used; default ports and
/// letter case compare equal.
fn names_host(origin: &Url, host: &str) -> bool {
    let Ok(target) = Url::parse(&format!("{}://{host}", origin.scheme())) else {
        return false;
    };
    target.path() == "/"
        && target.username().is_empty()
        && target.query().is_none()
        && target.fragment().is_none()
        && target.origin() == origin.origin()
}

/// Refuse a WebSocket upgrade from an origin the policy does not allow.
///
/// Wraps the whole router, so every upgrade route is covered, present and
/// future. Every upgrade axum accepts carries `Sec-WebSocket-Version`, on
/// HTTP/1.1 and HTTP/2 alike, so a request without it cannot become a
/// socket and passes untouched.
pub async fn reject_cross_origin_upgrade(
    State(policy): State<Arc<OriginPolicy>>,
    req: Request,
    next: Next,
) -> Response {
    if req.headers().contains_key(SEC_WEBSOCKET_VERSION)
        && !policy.permits_upgrade(req.headers(), req.uri().authority().map(|a| a.as_str()))
    {
        tracing::warn!(
            origin = ?req.headers().get(ORIGIN),
            host = ?req.headers().get(HOST),
            path = %req.uri().path(),
            "ws.upgrade.origin_rejected"
        );
        return (
            StatusCode::FORBIDDEN,
            "WebSocket upgrade refused: the Origin is not this server or an allowed origin",
        )
            .into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use axum::routing::get;
    use tower::ServiceExt;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn own_origin_only() -> OriginPolicy {
        OriginPolicy::parse(None).unwrap()
    }

    #[test]
    fn an_upgrade_without_an_origin_passes() {
        assert!(own_origin_only().permits_upgrade(&headers(&[("host", "lucida.example")]), None));
    }

    #[test]
    fn an_origin_naming_the_request_host_passes() {
        let policy = own_origin_only();
        for (origin, host) in [
            ("https://lucida.example", "lucida.example"),
            ("https://lucida.example", "lucida.example:443"),
            ("http://127.0.0.1:9876", "127.0.0.1:9876"),
            ("http://localhost:5173", "localhost:5173"),
            ("https://Lucida.Example", "lucida.example"),
            ("http://[::1]:9876", "[::1]:9876"),
        ] {
            assert!(
                policy.permits_upgrade(&headers(&[("origin", origin), ("host", host)]), None),
                "{origin} against Host {host}"
            );
        }
    }

    #[test]
    fn an_origin_naming_another_host_is_refused() {
        let policy = own_origin_only();
        for (origin, host) in [
            ("https://other.example", "lucida.example"),
            ("https://lucida.example.other.example", "lucida.example"),
            ("http://localhost:5173", "localhost:9876"),
            ("null", "lucida.example"),
            ("not an origin", "lucida.example"),
        ] {
            assert!(
                !policy.permits_upgrade(&headers(&[("origin", origin), ("host", host)]), None),
                "{origin} against Host {host}"
            );
        }
    }

    #[test]
    fn an_origin_with_no_host_to_compare_is_refused() {
        assert!(
            !own_origin_only().permits_upgrade(&headers(&[("origin", "https://a.example")]), None)
        );
    }

    #[test]
    fn the_uri_authority_stands_in_for_a_missing_host() {
        assert!(own_origin_only().permits_upgrade(
            &headers(&[("origin", "https://lucida.example")]),
            Some("lucida.example")
        ));
    }

    #[test]
    fn a_listed_origin_passes_whatever_the_host() {
        let policy =
            OriginPolicy::parse(Some(" https://viewer.example , http://localhost:5173/ ")).unwrap();
        assert_eq!(
            policy.allowed(),
            ["https://viewer.example", "http://localhost:5173"]
        );
        assert!(policy.permits_upgrade(
            &headers(&[
                ("origin", "https://viewer.example"),
                ("host", "lucida.example")
            ]),
            None
        ));
        assert!(!policy.permits_upgrade(
            &headers(&[
                ("origin", "https://other.example"),
                ("host", "lucida.example")
            ]),
            None
        ));
    }

    #[test]
    fn entries_that_are_not_origins_fail_the_parse() {
        for raw in [
            "*",
            "viewer.example",
            "ftp://viewer.example",
            "https://viewer.example/app",
            "https://user@viewer.example",
            "https://viewer.example?x=1",
        ] {
            let err = OriginPolicy::parse(Some(raw)).expect_err(raw);
            assert!(err.to_string().contains(ALLOWED_ORIGINS_VAR), "{err}");
        }
    }

    #[test]
    fn cors_is_off_unless_an_origin_is_listed() {
        assert!(own_origin_only().cors_layer().is_none());
        assert!(
            OriginPolicy::parse(Some("https://viewer.example"))
                .unwrap()
                .cors_layer()
                .is_some()
        );
    }

    fn guarded(policy: OriginPolicy) -> Router {
        Router::new()
            .route("/ws", get(|| async { "upgraded" }))
            .layer(axum::middleware::from_fn_with_state(
                Arc::new(policy),
                reject_cross_origin_upgrade,
            ))
    }

    async fn status(router: Router, pairs: &[(&'static str, &str)]) -> StatusCode {
        let mut req = HttpRequest::builder().uri("/ws");
        for (name, value) in pairs {
            req = req.header(*name, *value);
        }
        router
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn the_guard_refuses_a_cross_origin_upgrade_and_passes_the_rest() {
        let upgrade = [("sec-websocket-version", "13"), ("host", "lucida.example")];
        let cross = [upgrade.as_slice(), &[("origin", "https://other.example")]].concat();
        let same = [upgrade.as_slice(), &[("origin", "https://lucida.example")]].concat();

        assert_eq!(
            status(guarded(own_origin_only()), &cross).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(guarded(own_origin_only()), &same).await,
            StatusCode::OK
        );
        assert_eq!(
            status(guarded(own_origin_only()), &upgrade).await,
            StatusCode::OK
        );
        // Not an upgrade: ordinary requests are CORS's business, not this guard's.
        assert_eq!(
            status(
                guarded(own_origin_only()),
                &[
                    ("origin", "https://other.example"),
                    ("host", "lucida.example")
                ]
            )
            .await,
            StatusCode::OK
        );
    }
}
