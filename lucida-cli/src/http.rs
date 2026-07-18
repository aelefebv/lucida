//! Authenticated HTTP request plumbing shared by the noun command modules.
//!
//! Each noun keeps its own status-to-error vocabulary (the strings users see
//! name the noun), but the mechanics — API URL construction, bearer auth,
//! the JSON `Accept` header, and success/failure splitting — live here.

use std::sync::OnceLock;
use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::error::{CliError, ErrorKind};
use crate::transport::TransportLimits;

const DEFAULT_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Build an absolute API URL from the base server URL and path segments,
/// preserving any reverse-proxy path prefix while dropping query/fragment
/// noise from the configured base.
pub fn api_url(server_url: &str, segments: &[&str]) -> Result<reqwest::Url, CliError> {
    endpoint_url(server_url, false, segments)
}

/// Build a workspace WebSocket URL from the same configured HTTP(S) base
/// used by the REST and browser surfaces. Keeping scheme conversion here
/// makes path-prefix handling identical for every CLI transport.
pub fn websocket_url(server_url: &str, segments: &[&str]) -> Result<reqwest::Url, CliError> {
    endpoint_url(server_url, true, segments)
}

fn endpoint_url(
    server_url: &str,
    websocket: bool,
    segments: &[&str],
) -> Result<reqwest::Url, CliError> {
    let mut url = reqwest::Url::parse(server_url)
        .map_err(|error| CliError::invalid_server(format!("invalid server URL: {error}")))?;
    if websocket {
        let scheme = match url.scheme() {
            "http" => "ws",
            "https" => "wss",
            other => {
                return Err(CliError::invalid_server(format!(
                    "unsupported server URL scheme: {other}"
                )));
            }
        };
        url.set_scheme(scheme)
            .map_err(|_| CliError::invalid_server("failed to construct server URL"))?;
    }
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| CliError::invalid_server("server URL cannot be used as a base URL"))?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// Shared HTTP client policy for every CLI noun. A single client also reuses
/// connection pools instead of creating a fresh pool per request family.
pub fn http_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(DEFAULT_HTTP_CONNECT_TIMEOUT)
                .timeout(DEFAULT_HTTP_REQUEST_TIMEOUT)
                .build()
                .expect("the fixed Lucida HTTP client policy must be valid")
        })
        .clone()
}

/// Decode a success response without permitting an endpoint to allocate an
/// unbounded body. The cap applies to streamed bytes, so it remains effective
/// when Content-Length is absent or dishonest.
pub async fn bounded_json<T>(response: reqwest::Response) -> Result<T, CliError>
where
    T: DeserializeOwned,
{
    let body = bounded_body(response, TransportLimits::from_env()?.http_body_bytes).await?;
    serde_json::from_slice(&body).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("server returned invalid JSON: {error}"),
        )
    })
}

/// Read a small textual endpoint response under the same body cap as JSON.
pub async fn bounded_text(response: reqwest::Response) -> Result<String, CliError> {
    let body = bounded_body(response, TransportLimits::from_env()?.http_body_bytes).await?;
    String::from_utf8(body).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("server returned non-UTF-8 text: {error}"),
        )
    })
}

async fn bounded_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, CliError> {
    validate_content_length(response.content_length(), limit)?;

    let mut body =
        Vec::with_capacity(response.content_length().unwrap_or(0).min(limit as u64) as usize);
    while let Some(chunk) = response.chunk().await? {
        append_bounded(&mut body, &chunk, limit)?;
    }
    Ok(body)
}

fn validate_content_length(content_length: Option<u64>, limit: usize) -> Result<(), CliError> {
    if content_length.is_some_and(|length| length > limit as u64) {
        return Err(body_limit_error(limit, content_length));
    }
    Ok(())
}

fn append_bounded(body: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), CliError> {
    if body.len().saturating_add(chunk.len()) > limit {
        return Err(body_limit_error(limit, None));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn body_limit_error(limit: usize, content_length: Option<u64>) -> CliError {
    let mut error = CliError::new(
        ErrorKind::Protocol,
        format!("server response exceeded the {limit}-byte HTTP body limit"),
    )
    .with_context("http_body_limit_bytes", limit);
    if let Some(content_length) = content_length {
        error = error.with_context("content_length", content_length);
    }
    error
}

/// Send an authed JSON API request. On a non-success status the body text is
/// handed to `map_status_error` so the caller reports the failure in its own
/// vocabulary.
pub async fn send_json<E>(
    mut request: reqwest::RequestBuilder,
    token: Option<&str>,
    map_status_error: E,
) -> Result<reqwest::Response, CliError>
where
    E: FnOnce(reqwest::StatusCode, &str) -> CliError,
{
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = bounded_text(response).await?;
    Err(map_status_error(status, &body))
}

/// Pull a human-readable detail string out of a JSON error body
/// (`{"detail": ...}` or `{"error": ...}`), if one is present.
pub fn response_detail(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    value
        .get("detail")
        .or_else(|| value.get("error"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_url_preserves_base_path_and_strips_query_and_fragment() {
        let url = api_url(
            "http://127.0.0.1:9988/ignored?stale=1#frag",
            &["api", "workspaces", "w 1", "saved-views"],
        )
        .unwrap();

        assert_eq!(url.path(), "/ignored/api/workspaces/w%201/saved-views");
        assert_eq!(url.query(), None);
        assert_eq!(url.fragment(), None);
    }

    #[test]
    fn api_url_joins_root_and_trailing_prefix_without_double_slashes() {
        assert_eq!(
            api_url("https://example.test/", &["healthz"])
                .unwrap()
                .as_str(),
            "https://example.test/healthz"
        );
        assert_eq!(
            api_url("https://example.test/lucida/", &["healthz"])
                .unwrap()
                .as_str(),
            "https://example.test/lucida/healthz"
        );
    }

    #[test]
    fn websocket_url_preserves_base_path_and_converts_http_schemes() {
        assert_eq!(
            websocket_url(
                "https://example.test/lucida/?stale=1#frag",
                &["ws", "workspaces", "w 1"],
            )
            .unwrap()
            .as_str(),
            "wss://example.test/lucida/ws/workspaces/w%201"
        );
        assert_eq!(
            websocket_url("http://example.test", &["ws", "workspaces", "w1"])
                .unwrap()
                .as_str(),
            "ws://example.test/ws/workspaces/w1"
        );
    }

    #[test]
    fn response_detail_prefers_detail_over_error_and_tolerates_junk() {
        assert_eq!(
            response_detail(r#"{"detail":"no such view","error":"missing"}"#).as_deref(),
            Some("no such view")
        );
        assert_eq!(
            response_detail(r#"{"error":"missing"}"#).as_deref(),
            Some("missing")
        );
        assert_eq!(response_detail("not json"), None);
        assert_eq!(response_detail(r#"{"detail":42}"#), None);
    }

    #[test]
    fn bounded_body_rejects_declared_and_streamed_oversized_responses() {
        let declared = validate_content_length(Some(5), 4).unwrap_err();
        assert_eq!(declared.kind, ErrorKind::Protocol);
        assert_eq!(declared.to_json()["error"]["content_length"], 5);

        let mut streamed = b"ab".to_vec();
        append_bounded(&mut streamed, b"cd", 4).unwrap();
        let streamed_error = append_bounded(&mut streamed, b"e", 4).unwrap_err();
        assert_eq!(streamed, b"abcd");
        assert_eq!(streamed_error.kind, ErrorKind::Protocol);
        assert_eq!(
            streamed_error.to_json()["error"]["http_body_limit_bytes"],
            4
        );
    }
}
