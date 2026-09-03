//! Disabled-auth developer identity switching.
//!
//! This module is only meaningful when `LUCIDA_AUTH=disabled` and the
//! server is bound to loopback. The cookie is not a security boundary.
//! It is a local-dev convenience, so different browser profiles can
//! exercise viewer, editor, and owner behavior without configuring
//! OAuth. That is why the routes that write it are off wherever
//! anything but this machine can reach the server. See
//! [`crate::auth::handlers::DevAuthState::new`].

use axum::http::header::COOKIE;
use axum::http::request::Parts;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cookie::time::Duration as CookieDuration;
use cookie::{Cookie, SameSite};
use lucida_core::auth_principal::AuthPrincipal;
use serde::{Deserialize, Serialize};

use super::config::AuthConfig;
use super::cookie::resolve_secure;
use super::principal::{display_name_from_email, normalize_email};

pub const DEV_PRINCIPAL_COOKIE_NAME: &str = "lucida_dev_principal";
const DEV_PRINCIPAL_TTL_SECS: i64 = 60 * 60 * 24 * 30;

#[derive(Debug, Serialize, Deserialize)]
struct DevPrincipalCookie {
    email: String,
    display_name: String,
    is_admin: bool,
}

/// The identity disabled mode hands to a caller who presents nothing.
///
/// It carries no admin rights. Every request in disabled mode resolves
/// to this principal by default, so anything it can do, anyone who
/// reaches the server can do. Admin rights take a deliberate switch,
/// which only a loopback bind offers.
pub fn default_dev_principal() -> AuthPrincipal {
    AuthPrincipal {
        email: "dev@local".to_string(),
        display_name: "Local Dev".to_string(),
        picture_url: None,
        is_admin: false,
    }
}

pub fn normalize_dev_principal(
    email: &str,
    display_name: Option<&str>,
    is_admin: bool,
) -> Result<AuthPrincipal, String> {
    let email = normalize_email(email).ok_or_else(|| "dev user email is invalid".to_string())?;

    let display_name = display_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(120).collect::<String>())
        .unwrap_or_else(|| display_name_from_email(&email));

    Ok(AuthPrincipal {
        email,
        display_name,
        picture_url: None,
        is_admin,
    })
}

pub fn read_dev_principal_cookie(parts: &Parts) -> Option<AuthPrincipal> {
    parts
        .headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|hv| hv.to_str().ok())
        .flat_map(Cookie::split_parse)
        .filter_map(|res| res.ok())
        .find_map(|c| {
            if c.name() == DEV_PRINCIPAL_COOKIE_NAME {
                decode_dev_principal(c.value())
            } else {
                None
            }
        })
}

pub fn build_dev_principal_cookie(
    config: &AuthConfig,
    principal: &AuthPrincipal,
    request_is_https: bool,
) -> String {
    let value = encode_dev_principal(principal);
    let mut cookie = Cookie::new(DEV_PRINCIPAL_COOKIE_NAME, value);
    cookie.set_http_only(true);
    cookie.set_path("/");
    cookie.set_same_site(SameSite::Lax);
    cookie.set_secure(resolve_secure(config.secure_mode, request_is_https));
    cookie.set_max_age(CookieDuration::seconds(DEV_PRINCIPAL_TTL_SECS));
    cookie.to_string()
}

pub fn build_clearing_dev_principal_cookie(config: &AuthConfig, request_is_https: bool) -> String {
    let mut cookie = Cookie::new(DEV_PRINCIPAL_COOKIE_NAME, "");
    cookie.set_http_only(true);
    cookie.set_path("/");
    cookie.set_same_site(SameSite::Lax);
    cookie.set_secure(resolve_secure(config.secure_mode, request_is_https));
    cookie.set_max_age(CookieDuration::ZERO);
    cookie.to_string()
}

fn encode_dev_principal(principal: &AuthPrincipal) -> String {
    let payload = DevPrincipalCookie {
        email: principal.email.clone(),
        display_name: principal.display_name.clone(),
        is_admin: principal.is_admin,
    };
    let bytes = serde_json::to_vec(&payload).expect("dev principal cookie serializes");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_dev_principal(value: &str) -> Option<AuthPrincipal> {
    let bytes = URL_SAFE_NO_PAD.decode(value).ok()?;
    let payload: DevPrincipalCookie = serde_json::from_slice(&bytes).ok()?;
    normalize_dev_principal(
        &payload.email,
        Some(&payload.display_name),
        payload.is_admin,
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    fn parts_with_cookie(cookie: &str) -> Parts {
        let req: Request<()> = Request::builder()
            .uri("http://example.com/")
            .header("cookie", cookie)
            .body(())
            .unwrap();
        let (parts, _) = req.into_parts();
        parts
    }

    #[test]
    fn default_dev_principal_holds_no_admin_rights() {
        let principal = default_dev_principal();
        assert_eq!(principal.email, "dev@local");
        assert!(!principal.is_admin);
    }

    #[test]
    fn dev_principal_cookie_round_trips() {
        let config = AuthConfig::for_tests();
        let principal = normalize_dev_principal("Alice@Example.com", Some("Alice"), false).unwrap();
        let set_cookie = build_dev_principal_cookie(&config, &principal, false);
        let inbound_cookie = set_cookie.split(';').next().unwrap();

        let parsed = read_dev_principal_cookie(&parts_with_cookie(inbound_cookie)).unwrap();

        assert_eq!(parsed.email, "alice@example.com");
        assert_eq!(parsed.display_name, "Alice");
        assert!(!parsed.is_admin);
    }

    #[test]
    fn display_name_falls_back_from_email_local_part() {
        let principal = normalize_dev_principal("test.viewer@example.com", None, false).unwrap();
        assert_eq!(principal.display_name, "Test Viewer");
    }
}
