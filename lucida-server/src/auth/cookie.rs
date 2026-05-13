//! Cookie reading + Set-Cookie building for the session cookie.
//!
//! Slice 2 (PRD #455) ships only the session cookie (`lucida_session`
//! by default). The encoded id is opaque (UUID v4 today; whatever the
//! store hands us in future). Attribute choices come straight from PRD
//! #455 §"Cookie attributes":
//!
//! - `HttpOnly` — JS cannot read.
//! - `Secure` — auto-detected per request scheme; overridable via
//!   `LUCIDA_COOKIE_SECURE`.
//! - `SameSite=Lax` — allows top-level cross-site navigation (so
//!   `#b=ID` saved-view links from Slack land authenticated) while
//!   blocking cross-site POST/PATCH/DELETE for CSRF protection.
//! - `Path=/` — cookie applies to every endpoint.
//! - `Max-Age` matches the session hard cap so the browser drops it
//!   when the server would have anyway.

use axum::http::header::COOKIE;
use axum::http::request::Parts;
use cookie::time::Duration as CookieDuration;
use cookie::{Cookie, SameSite};

use super::config::{AuthConfig, SecureCookieMode};

/// Marker cookie set by `/auth/logout` and consumed by middleware +
/// `/auth/start`. Its presence (no value semantics — empty body would
/// also work) tells the next request: "this user just signed out, do
/// not auto-bounce them back through OAuth." Cleared by `/auth/start`
/// once the user explicitly opts back in. See ADR on post-logout
/// re-sign-in for the full rationale; cookie attributes mirror
/// `lucida_session` (HttpOnly + SameSite=Lax + Path=/ + auto Secure).
pub const SIGNED_OUT_COOKIE_NAME: &str = "lucida_signed_out";

/// TTL for the marker cookie: 10 minutes. A backstop for the rare path
/// where the user never returns to `/auth/start` to clear it (closed
/// the tab, walked away). Short enough that "I logged out, came back
/// the next morning" behaves as a fresh visit (auto-bounce friction-
/// free), long enough to cover the realistic refresh / new-tab /
/// bookmark-click windows immediately after logout.
pub const SIGNED_OUT_TTL_SECS: i64 = 600;

/// Pull the session id out of an inbound request's `Cookie` header.
///
/// Returns the *first* matching cookie value; duplicates are unusual
/// and the spec leaves "first vs last" ambiguous. Returns `None` when
/// the header is absent, unparseable, or doesn't carry our cookie.
/// Returns an owned `String` because the parsed `Cookie<'_>` borrows
/// from a temporary inside the iterator chain — owning the value is
/// cheaper than wrestling lifetimes for what's a UUID-sized string.
pub fn read_session_cookie(parts: &Parts, cookie_name: &str) -> Option<String> {
    parts
        .headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|hv| hv.to_str().ok())
        .flat_map(Cookie::split_parse)
        .filter_map(|res| res.ok())
        .find_map(|c| {
            if c.name() == cookie_name {
                Some(c.value().to_string())
            } else {
                None
            }
        })
}

/// Decide whether to set the `Secure` attribute given the request
/// scheme and the server's secure-cookie mode.
pub fn resolve_secure(mode: SecureCookieMode, request_is_https: bool) -> bool {
    match mode {
        SecureCookieMode::Always => true,
        SecureCookieMode::Never => false,
        SecureCookieMode::Auto => request_is_https,
    }
}

/// Detect whether the inbound request was served over HTTPS. Trusts the
/// request scheme as observed by axum (`parts.uri.scheme_str()`); when
/// behind a TLS-terminating proxy that strips the scheme, the operator
/// must set `LUCIDA_COOKIE_SECURE=always` explicitly. We deliberately
/// do not trust `X-Forwarded-Proto` here — slice 2 keeps the surface
/// minimal and the operator-override path is the safer default.
pub fn request_is_https(parts: &Parts) -> bool {
    parts
        .uri
        .scheme_str()
        .map(|s| s.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

/// Build the `Set-Cookie` header value to mint a session cookie. The
/// `Max-Age` matches the hard cap so the browser stops sending the
/// cookie at the same time the server would reject it.
pub fn build_session_cookie(
    config: &AuthConfig,
    session_id: &str,
    request_is_https: bool,
) -> String {
    let mut cookie = Cookie::new(config.cookie_name.clone(), session_id.to_string());
    cookie.set_http_only(true);
    cookie.set_path("/");
    cookie.set_same_site(SameSite::Lax);
    cookie.set_secure(resolve_secure(config.secure_mode, request_is_https));
    cookie.set_max_age(CookieDuration::seconds(config.hard_cap.as_secs() as i64));
    cookie.to_string()
}

/// Build a `Set-Cookie` header that clears the session cookie. Used by
/// the slice-3 logout flow; defined here so the cookie attribute set
/// stays in one place (otherwise it's easy to drift Path/SameSite).
pub fn build_clearing_cookie(config: &AuthConfig, request_is_https: bool) -> String {
    let mut cookie = Cookie::new(config.cookie_name.clone(), "");
    cookie.set_http_only(true);
    cookie.set_path("/");
    cookie.set_same_site(SameSite::Lax);
    cookie.set_secure(resolve_secure(config.secure_mode, request_is_https));
    cookie.set_max_age(CookieDuration::ZERO);
    cookie.to_string()
}

/// True iff the inbound request carries the `lucida_signed_out` marker
/// cookie. The value isn't inspected — presence is the entire signal.
/// Takes `&HeaderMap` rather than `&Parts` so the middleware can call
/// it after destructuring the request without re-borrowing.
pub fn read_signed_out_marker(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|hv| hv.to_str().ok())
        .flat_map(Cookie::split_parse)
        .filter_map(|res| res.ok())
        .any(|c| c.name() == SIGNED_OUT_COOKIE_NAME)
}

/// Build the `Set-Cookie` header that mints the marker. Attributes
/// mirror `build_session_cookie` — same HttpOnly/Path/SameSite/Secure
/// semantics — so the marker travels exactly the same trust contour as
/// the session cookie and isn't readable by JS.
pub fn build_signed_out_marker(config: &AuthConfig, request_is_https: bool) -> String {
    let mut cookie = Cookie::new(SIGNED_OUT_COOKIE_NAME, "1");
    cookie.set_http_only(true);
    cookie.set_path("/");
    cookie.set_same_site(SameSite::Lax);
    cookie.set_secure(resolve_secure(config.secure_mode, request_is_https));
    cookie.set_max_age(CookieDuration::seconds(SIGNED_OUT_TTL_SECS));
    cookie.to_string()
}

/// Build the `Set-Cookie` header that clears the marker. Emitted by
/// `/auth/start` so a successful re-sign-in immediately drops the
/// marker (rather than waiting for the 10-minute TTL to expire).
pub fn build_clearing_signed_out_marker(config: &AuthConfig, request_is_https: bool) -> String {
    let mut cookie = Cookie::new(SIGNED_OUT_COOKIE_NAME, "");
    cookie.set_http_only(true);
    cookie.set_path("/");
    cookie.set_same_site(SameSite::Lax);
    cookie.set_secure(resolve_secure(config.secure_mode, request_is_https));
    cookie.set_max_age(CookieDuration::ZERO);
    cookie.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    fn parts_with_cookie(header: &str) -> Parts {
        let req: Request<()> = Request::builder()
            .uri("http://example.com/")
            .header("cookie", header)
            .body(())
            .unwrap();
        req.into_parts().0
    }

    #[test]
    fn reads_named_cookie() {
        let parts = parts_with_cookie("lucida_session=abc123; other=42");
        let v = read_session_cookie(&parts, "lucida_session");
        assert_eq!(v.as_deref(), Some("abc123"));
    }

    #[test]
    fn returns_none_when_cookie_absent() {
        let parts = parts_with_cookie("other=42");
        assert!(read_session_cookie(&parts, "lucida_session").is_none());
    }

    #[test]
    fn returns_none_when_no_cookie_header() {
        let req: Request<()> = Request::builder()
            .uri("http://example.com/")
            .body(())
            .unwrap();
        let parts = req.into_parts().0;
        assert!(read_session_cookie(&parts, "lucida_session").is_none());
    }

    #[test]
    fn secure_resolution_matches_documented_modes() {
        assert!(resolve_secure(SecureCookieMode::Always, false));
        assert!(!resolve_secure(SecureCookieMode::Never, true));
        assert!(resolve_secure(SecureCookieMode::Auto, true));
        assert!(!resolve_secure(SecureCookieMode::Auto, false));
    }

    #[test]
    fn build_session_cookie_carries_required_attributes() {
        let config = AuthConfig::for_tests();
        let header = build_session_cookie(&config, "uuid-xyz", true);
        // We just check the substring presence; the cookie crate's
        // exact serialization order is not part of the contract.
        assert!(header.contains("lucida_session=uuid-xyz"));
        assert!(header.contains("HttpOnly"));
        assert!(header.contains("Path=/"));
        assert!(header.contains("SameSite=Lax"));
        assert!(header.contains("Secure"));
        // hard cap is 720h = 2,592,000s by default
        assert!(header.contains("Max-Age=2592000"));
    }

    #[test]
    fn build_session_cookie_no_secure_when_not_https() {
        let config = AuthConfig::for_tests();
        let header = build_session_cookie(&config, "uuid-xyz", false);
        assert!(!header.contains("Secure"));
    }

    #[test]
    fn build_clearing_cookie_zeroes_max_age() {
        let config = AuthConfig::for_tests();
        let header = build_clearing_cookie(&config, false);
        assert!(header.contains("Max-Age=0"));
        assert!(header.contains("lucida_session=;"));
    }

    #[test]
    fn read_signed_out_marker_detects_presence() {
        let parts = parts_with_cookie("lucida_signed_out=1; lucida_session=abc");
        assert!(read_signed_out_marker(&parts.headers));
    }

    #[test]
    fn read_signed_out_marker_absent_when_not_present() {
        let parts = parts_with_cookie("lucida_session=abc");
        assert!(!read_signed_out_marker(&parts.headers));
    }

    #[test]
    fn build_signed_out_marker_carries_required_attributes() {
        let config = AuthConfig::for_tests();
        let header = build_signed_out_marker(&config, true);
        assert!(header.contains("lucida_signed_out=1"));
        assert!(header.contains("HttpOnly"));
        assert!(header.contains("Path=/"));
        assert!(header.contains("SameSite=Lax"));
        assert!(header.contains("Secure"));
        // 10 minute TTL — backstop for the case where /auth/start
        // never runs to clear the marker.
        assert!(header.contains("Max-Age=600"));
    }

    #[test]
    fn build_signed_out_marker_no_secure_when_not_https() {
        let config = AuthConfig::for_tests();
        let header = build_signed_out_marker(&config, false);
        assert!(!header.contains("Secure"));
    }

    #[test]
    fn build_clearing_signed_out_marker_zeroes_max_age() {
        let config = AuthConfig::for_tests();
        let header = build_clearing_signed_out_marker(&config, false);
        assert!(header.contains("Max-Age=0"));
        assert!(header.contains("lucida_signed_out=;"));
    }
}
