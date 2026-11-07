//! Cookie reading + Set-Cookie building for the session cookie.
//!
//! The cookie (`lucida_session` by default) carries an opaque id. It is
//! `HttpOnly`, `Path=/`, and `Secure` over https or off loopback unless
//! `LUCIDA_COOKIE_SECURE` overrides it. `SameSite=Lax` lets a saved-view
//! link opened from another site land signed in while still blocking
//! cross-site writes. `Max-Age` matches the session hard cap.

use axum::http::header::COOKIE;
use axum::http::request::Parts;
use cookie::time::Duration as CookieDuration;
use cookie::{Cookie, SameSite};

use super::config::{AuthConfig, SecureCookieMode};

/// Marker cookie set by `/auth/logout` and read by the middleware and
/// `/auth/start`. Its presence, not its value, tells the next request
/// that this user just signed out, so do not bounce them back through
/// OAuth. `/auth/callback` clears it once they sign back in.
/// Attributes mirror `lucida_session`.
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

/// Decide whether to set the `Secure` attribute.
///
/// `Auto` sets it for a request that came over https, and on any bind
/// other than loopback. The scheme alone misses most deployments: a
/// perimeter that terminates TLS forwards plain http, and an HTTP/1.1
/// request carries no scheme at all. A server other machines can reach
/// is served over https in any deployment worth having, and one that is
/// not sets `LUCIDA_COOKIE_SECURE=never`.
pub fn resolve_secure(config: &AuthConfig, request_is_https: bool) -> bool {
    match config.secure_mode {
        SecureCookieMode::Always => true,
        SecureCookieMode::Never => false,
        SecureCookieMode::Auto => request_is_https || !config.bind_is_loopback(),
    }
}

/// Detect whether the inbound request was served over HTTPS. Trusts the
/// request scheme as observed by axum (`parts.uri.scheme_str()`), which
/// a TLS-terminating perimeter strips; [`resolve_secure`] covers that
/// case by the bind. We deliberately do not trust `X-Forwarded-Proto`
/// here: operator override is the safer default than auto-trusting a
/// spoofable header.
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
    cookie.set_secure(resolve_secure(config, request_is_https));
    cookie.set_max_age(CookieDuration::seconds(config.hard_cap.as_secs() as i64));
    cookie.to_string()
}

/// Build a `Set-Cookie` header that clears the session cookie. Defined
/// here so the cookie attribute set stays in one place.
pub fn build_clearing_cookie(config: &AuthConfig, request_is_https: bool) -> String {
    let mut cookie = Cookie::new(config.cookie_name.clone(), "");
    cookie.set_http_only(true);
    cookie.set_path("/");
    cookie.set_same_site(SameSite::Lax);
    cookie.set_secure(resolve_secure(config, request_is_https));
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
    cookie.set_secure(resolve_secure(config, request_is_https));
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
    cookie.set_secure(resolve_secure(config, request_is_https));
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

    fn config_with(mode: SecureCookieMode, bind: &str) -> AuthConfig {
        let mut config = AuthConfig::for_tests();
        config.secure_mode = mode;
        config.bind_addr = bind.parse().unwrap();
        config
    }

    #[test]
    fn secure_resolution_matches_documented_modes() {
        let loopback = "127.0.0.1:9876";
        assert!(resolve_secure(
            &config_with(SecureCookieMode::Always, loopback),
            false
        ));
        assert!(!resolve_secure(
            &config_with(SecureCookieMode::Never, loopback),
            true
        ));
        assert!(resolve_secure(
            &config_with(SecureCookieMode::Auto, loopback),
            true
        ));
        assert!(!resolve_secure(
            &config_with(SecureCookieMode::Auto, loopback),
            false
        ));
    }

    #[test]
    fn auto_is_secure_off_loopback_whatever_the_request_scheme() {
        let public = "0.0.0.0:9876";
        assert!(resolve_secure(
            &config_with(SecureCookieMode::Auto, public),
            false
        ));
        assert!(!resolve_secure(
            &config_with(SecureCookieMode::Never, public),
            false
        ));

        let header =
            build_session_cookie(&config_with(SecureCookieMode::Auto, public), "id", false);
        assert!(header.contains("Secure"), "{header}");
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
