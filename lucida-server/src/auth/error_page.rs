//! `/auth/error` server-rendered page.
//!
//! Slice 5 (PRD #455 §"Error UX"): the user-facing destination after
//! `auth_callback` rejects a sign-in. Three rendering modes, all
//! distinguishable from the `code=` query param:
//!
//! * `hd_mismatch` — verified Google account, but the `hd` claim is
//!   absent or not in `LUCIDA_ALLOWED_HOSTED_DOMAINS`. The user knows
//!   their own email and we tell them which domains *are* allowed, so
//!   leaking those isn't recon-aiding — they just signed in.
//! * `unverified` — Google says the account's `email_verified` claim
//!   is false. Pure user-fixable (verify in Google account settings,
//!   try again).
//! * everything else (`auth_failed` or unknown) — generic message.
//!   These come from state-token mismatches, code-exchange failures,
//!   JWT validation failures, etc; they're either benign races or
//!   attack indicators. Logs hold details server-side; the user gets
//!   a vague "try again" link to avoid aiding reconnaissance.
//!
//! Pattern matches `unauth_landing`: server-rendered HTML, no
//! framework, no template engine. The user is mid-OAuth-roundtrip
//! and not yet inside the SPA, so a React component would render
//! later than the cookie-less page can. Keeping it server-rendered
//! also dodges the cross-cutting question of "how does an unauth'd
//! React tree mount?"

use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

/// Query string accepted by `/auth/error`. Every field is optional;
/// missing values fall back to the generic "try again" message. We
/// don't 4xx on missing/unknown `code` because the user is being
/// redirected here from an upstream failure path — surfacing a 400
/// as their first user-visible feedback would be unhelpful.
#[derive(Debug, Deserialize, Default)]
pub struct ErrorQuery {
    #[serde(default)]
    pub code: Option<String>,
    /// Email the user attempted to sign in with. Surfaced verbatim;
    /// HTML-escaped before render. Only meaningful for `hd_mismatch`
    /// and `unverified`.
    #[serde(default)]
    pub attempted_email: Option<String>,
    /// Comma-separated list of domains the operator configured. Only
    /// meaningful for `hd_mismatch`.
    #[serde(default)]
    pub allowed_domains: Option<String>,
}

/// `GET /auth/error?code=…&attempted_email=…&allowed_domains=…`
///
/// Always returns 200 with text/html; the user-facing copy is
/// determined by the `code` param.
pub async fn auth_error(Query(q): Query<ErrorQuery>) -> Response {
    let html = render(&q);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

fn render(q: &ErrorQuery) -> String {
    let inner = match q.code.as_deref() {
        Some("hd_mismatch") => render_hd_mismatch(
            q.attempted_email.as_deref().unwrap_or(""),
            q.allowed_domains.as_deref().unwrap_or(""),
        ),
        Some("unverified") => render_unverified(q.attempted_email.as_deref().unwrap_or("")),
        _ => render_generic(),
    };
    format!("{HEAD_HTML}{inner}{TAIL_HTML}")
}

fn render_hd_mismatch(attempted_email: &str, allowed_domains_raw: &str) -> String {
    // The query-param form is comma-separated; render as a friendly
    // list ("calicolabs.com" vs "calicolabs.com or othercorp.com" vs
    // "calicolabs.com, mid.org, or zlast.com"). Empty fallback "your
    // organization" keeps the page sane even if the redirect omitted
    // the param.
    let domains: Vec<&str> = allowed_domains_raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let domains_phrase = match domains.as_slice() {
        [] => "your organization".to_string(),
        [one] => html_escape(one),
        [a, b] => format!("{} or {}", html_escape(a), html_escape(b)),
        many => {
            let head = many[..many.len() - 1]
                .iter()
                .map(|s| html_escape(s))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{}, or {}", head, html_escape(many[many.len() - 1]))
        }
    };
    let email_phrase = if attempted_email.is_empty() {
        "the account you used".to_string()
    } else {
        format!("<strong>{}</strong>", html_escape(attempted_email))
    };
    format!(
        r#"<h1>Account not allowed</h1>
<p>lucida is restricted to <strong>{domains_phrase}</strong>. Your account {email_phrase} isn&rsquo;t allowed.</p>
<p><a class="button" href="/auth/start">Sign in with a different account</a></p>"#,
    )
}

fn render_unverified(attempted_email: &str) -> String {
    let email_phrase = if attempted_email.is_empty() {
        "Your Google account".to_string()
    } else {
        format!("Your Google account <strong>{}</strong>", html_escape(attempted_email))
    };
    format!(
        r#"<h1>Email not verified</h1>
<p>{email_phrase} doesn&rsquo;t have a verified email address. Please verify it in your Google account settings, then try again.</p>
<p><a class="button" href="/auth/start">Try again</a></p>"#,
    )
}

fn render_generic() -> String {
    // Deliberately vague: a more specific message would aid
    // reconnaissance for the state-mismatch / JWT-invalid paths.
    // Server logs already hold the details.
    r#"<h1>Sign-in failed</h1>
<p>We couldn&rsquo;t complete your sign-in. Please try again.</p>
<p><a class="button" href="/auth/start">Try again</a></p>"#
        .to_string()
}

/// Minimal HTML escape for the four characters we emit verbatim from
/// query params. The page never reflects untrusted multi-byte content,
/// so a five-replacement escaper is sufficient.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            other => out.push(other),
        }
    }
    out
}

const HEAD_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>lucida — sign in</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a1f; color: #eee; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { padding: 24px 32px; border: 1px solid #444; border-radius: 8px; background: #22222a; max-width: 480px; }
  h1 { margin-top: 0; font-size: 1.25rem; }
  p { line-height: 1.5; }
  .button { display: inline-block; padding: 8px 16px; background: #3a5fd6; color: #fff; border-radius: 4px; text-decoration: none; margin-top: 8px; }
  .button:hover { background: #4870e0; }
  strong { color: #fff; }
</style>
</head>
<body>
<div class="card">
"##;

const TAIL_HTML: &str = r##"</div>
</body>
</html>"##;

#[cfg(test)]
mod tests {
    use super::*;

    fn q(code: &str, email: Option<&str>, domains: Option<&str>) -> ErrorQuery {
        ErrorQuery {
            code: Some(code.into()),
            attempted_email: email.map(str::to_string),
            allowed_domains: domains.map(str::to_string),
        }
    }

    #[test]
    fn hd_mismatch_renders_email_and_domains() {
        let body = render(&q(
            "hd_mismatch",
            Some("alice@gmail.com"),
            Some("calicolabs.com"),
        ));
        assert!(body.contains("Account not allowed"));
        assert!(body.contains("alice@gmail.com"));
        assert!(body.contains("calicolabs.com"));
        assert!(body.contains(r#"href="/auth/start""#));
    }

    #[test]
    fn hd_mismatch_two_domains_uses_or() {
        let body = render(&q(
            "hd_mismatch",
            Some("a@x.com"),
            Some("calicolabs.com,othercorp.com"),
        ));
        assert!(body.contains("calicolabs.com or othercorp.com"));
    }

    #[test]
    fn hd_mismatch_three_domains_uses_oxford_comma() {
        let body = render(&q(
            "hd_mismatch",
            Some("a@x.com"),
            Some("acorp.com,mid.org,zlast.com"),
        ));
        // Three values: "acorp.com, mid.org, or zlast.com"
        assert!(body.contains("acorp.com, mid.org, or zlast.com"));
    }

    #[test]
    fn hd_mismatch_missing_params_falls_back_gracefully() {
        // Operator misconfigured the redirect or the user navigated
        // here directly. We render *something* sensible.
        let body = render(&q("hd_mismatch", None, None));
        assert!(body.contains("Account not allowed"));
        assert!(body.contains("your organization"));
        assert!(body.contains("the account you used"));
    }

    #[test]
    fn unverified_renders_email_and_settings_hint() {
        let body = render(&q("unverified", Some("alice@example.com"), None));
        assert!(body.contains("Email not verified"));
        assert!(body.contains("alice@example.com"));
        assert!(body.contains("Google account settings"));
    }

    #[test]
    fn generic_falls_through_for_auth_failed_and_unknown() {
        let body = render(&q("auth_failed", None, None));
        assert!(body.contains("Sign-in failed"));
        // Deliberately vague — no detail field reflected.
        assert!(!body.contains("state"));
        assert!(!body.contains("JWT"));

        let unknown = render(&q("totally_made_up", None, None));
        assert!(unknown.contains("Sign-in failed"));
    }

    #[test]
    fn missing_code_renders_generic() {
        let body = render(&ErrorQuery::default());
        assert!(body.contains("Sign-in failed"));
    }

    #[test]
    fn html_escape_blocks_xss_in_email_param() {
        let body = render(&q(
            "hd_mismatch",
            Some("<script>alert(1)</script>@x.com"),
            Some("calicolabs.com"),
        ));
        assert!(!body.contains("<script>alert(1)</script>"));
        assert!(body.contains("&lt;script&gt;"));
    }

    #[test]
    fn html_escape_blocks_xss_in_domain_param() {
        let body = render(&q(
            "hd_mismatch",
            Some("a@x.com"),
            Some("<img onerror=x>"),
        ));
        assert!(!body.contains("<img onerror=x>"));
        assert!(body.contains("&lt;img onerror=x&gt;"));
    }

    #[tokio::test]
    async fn handler_returns_html_with_200() {
        let res = auth_error(Query(q(
            "hd_mismatch",
            Some("a@x.com"),
            Some("calicolabs.com"),
        )))
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let ct = res
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(ct.starts_with("text/html"));
    }
}
