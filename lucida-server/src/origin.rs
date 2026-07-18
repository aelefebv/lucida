//! Shared HTTP and WebSocket origin policy.

use std::collections::HashSet;
use std::sync::Arc;

use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, HeaderValue};

#[derive(Clone, Debug)]
pub struct OriginPolicy {
    allowed: Arc<HashSet<String>>,
    permissive: bool,
}

impl OriginPolicy {
    pub fn new(
        origins: impl IntoIterator<Item = String>,
        permissive: bool,
    ) -> Result<Self, String> {
        let mut allowed = HashSet::new();
        for origin in origins {
            let normalized = normalize_origin(&origin)
                .ok_or_else(|| format!("invalid allowed CORS origin {origin:?}"))?;
            allowed.insert(normalized);
        }
        Ok(Self {
            allowed: Arc::new(allowed),
            permissive,
        })
    }

    /// Requests without an Origin header are non-browser/same-origin clients
    /// and remain usable. Browser origins must either match Host exactly or be
    /// explicitly configured; permissive mode is an operator opt-in.
    pub fn allows_headers(&self, headers: &HeaderMap) -> bool {
        let mut origins = headers.get_all(ORIGIN).iter();
        let Some(origin) = origins.next() else {
            return true;
        };
        // Browsers send exactly one Origin. Multiple values are ambiguous and
        // must not be reduced to whichever value HeaderMap happens to expose.
        if origins.next().is_some() {
            return false;
        }
        self.allows(origin, headers.get(HOST))
    }

    pub fn allows(&self, origin: &HeaderValue, host: Option<&HeaderValue>) -> bool {
        let Some(origin) = origin.to_str().ok().and_then(normalize_origin) else {
            return false;
        };
        // Permissive is an explicit operator choice to allow any web origin,
        // not a bypass for malformed, opaque (`null`), or non-HTTP origins.
        if self.permissive {
            return true;
        }
        if self.allowed.contains(&origin) {
            return true;
        }
        let Some(host) = host.and_then(|host| host.to_str().ok()) else {
            return false;
        };
        origin_authority(&origin).is_some_and(|authority| authority.eq_ignore_ascii_case(host))
    }

    pub fn permissive(&self) -> bool {
        self.permissive
    }
}

fn normalize_origin(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.len() > 2_048
        || value.bytes().any(|byte| byte.is_ascii_control())
        || value.contains(['?', '#', '\\', '@'])
    {
        return None;
    }
    let (scheme, authority) = value.split_once("://")?;
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
        || authority.is_empty()
        || authority.contains('/')
    {
        return None;
    }
    // Delegate authority grammar and default-port canonicalization to the URL
    // parser already used by the server's HTTP client. This rejects malformed
    // ports, comma-joined values, invalid IPv6, and other hand-parser gaps.
    let parsed = reqwest::Url::parse(value).ok()?;
    (parsed.host_str().is_some()).then(|| parsed.origin().ascii_serialization())
}

fn origin_authority(origin: &str) -> Option<&str> {
    origin.split_once("://").map(|(_, authority)| authority)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_host_and_explicit_origins_are_allowed_but_cross_origin_is_denied() {
        let policy = OriginPolicy::new(vec!["https://ui.example.com".into()], false).unwrap();
        assert!(policy.allows(
            &HeaderValue::from_static("http://localhost:9876"),
            Some(&HeaderValue::from_static("localhost:9876"))
        ));
        assert!(policy.allows(&HeaderValue::from_static("https://ui.example.com"), None));
        assert!(!policy.allows(
            &HeaderValue::from_static("https://attacker.example"),
            Some(&HeaderValue::from_static("lucida.example"))
        ));
        assert!(!policy.allows(&HeaderValue::from_static("null"), None));
    }

    #[test]
    fn browser_header_validation_rejects_multiple_origin_values() {
        let policy = OriginPolicy::new(Vec::new(), false).unwrap();
        let mut headers = HeaderMap::new();
        headers.append(ORIGIN, HeaderValue::from_static("https://one.example"));
        headers.append(ORIGIN, HeaderValue::from_static("https://two.example"));
        headers.insert(HOST, HeaderValue::from_static("one.example"));
        assert!(!policy.allows_headers(&headers));
    }

    #[test]
    fn configured_origins_reject_paths_credentials_and_ambiguous_forms() {
        for invalid in [
            "//example.com",
            "https://user@example.com",
            "https://example.com/path",
            "https://example.com\\evil",
            "https://example.com:invalid",
            "https://example.com,https://evil.example",
            "https://[::broken]",
            "file:///tmp/data",
        ] {
            assert!(OriginPolicy::new(vec![invalid.into()], false).is_err());
        }
    }

    #[test]
    fn permissive_mode_still_rejects_opaque_and_malformed_origins() {
        let policy = OriginPolicy::new(Vec::new(), true).unwrap();
        assert!(policy.allows(&HeaderValue::from_static("https://any.example"), None));
        for invalid in ["null", "file:///tmp/data", "https://example.com/path"] {
            assert!(!policy.allows(&HeaderValue::from_str(invalid).unwrap(), None));
        }
    }
}
