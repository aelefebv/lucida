//! Authenticated HTTP request plumbing shared by the noun command modules.
//!
//! Each noun keeps its own status-to-error vocabulary (the strings users see
//! name the noun), but the mechanics — API URL construction, bearer auth,
//! the JSON `Accept` header, and success/failure splitting — live here.

use crate::error::CliError;

/// Build an absolute API URL from the base server URL and path segments,
/// dropping any query/fragment noise from the configured base.
pub fn api_url(server_url: &str, segments: &[&str]) -> Result<reqwest::Url, CliError> {
    let mut url = reqwest::Url::parse(server_url)
        .map_err(|error| CliError::invalid_server(format!("invalid server URL: {error}")))?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| CliError::invalid_server("server URL cannot be used as a base URL"))?;
        path.clear();
        for segment in segments {
            path.push(segment);
        }
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
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
    let body = response.text().await.unwrap_or_default();
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
    fn api_url_replaces_path_and_strips_query_and_fragment() {
        let url = api_url(
            "http://127.0.0.1:9988/ignored?stale=1#frag",
            &["api", "workspaces", "w 1", "saved-views"],
        )
        .unwrap();

        assert_eq!(url.path(), "/api/workspaces/w%201/saved-views");
        assert_eq!(url.query(), None);
        assert_eq!(url.fragment(), None);
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
}
