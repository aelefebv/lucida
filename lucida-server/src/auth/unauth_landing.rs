//! The tiny HTML page the middleware serves to an unauthenticated
//! browser navigation.
//!
//! It runs before any framework code mounts; that's the whole point —
//! the JS shim must capture `location.hash` and bounce the browser to
//! `/auth/start` so a saved-views deep link survives the OAuth round
//! trip (see ADR-0013 + ADR-0016).
//!
//! No template engine; the whole page is a const string. The hash and
//! the path are URL-encoded by the shim itself, not by the server, so
//! the server never has to think about how to escape them.

/// The complete unauth-landing HTML body. `Content-Type: text/html`.
///
/// The JS:
/// - reads `location.hash` (everything after the `#`, including the
///   leading `#` itself, but we slice it off for cleanliness),
/// - reads `location.pathname + location.search` (the part the server
///   does see, which we still URL-encode for the query param),
/// - bounces to `/auth/start?path=…&hash=…` via `location.replace`
///   (replace, not assign, so the unauth landing is invisible in the
///   browser history).
///
/// Falls back to a plain "Sign in" link if JS is disabled.
pub const UNAUTH_LANDING_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>lucida — sign in</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a1f; color: #eee; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { padding: 24px 32px; border: 1px solid #444; border-radius: 8px; background: #22222a; max-width: 360px; }
  a { color: #8ab4f8; }
</style>
</head>
<body>
<div class="card">
  <h1 style="margin-top:0">Signing you in&hellip;</h1>
  <p>Redirecting to Google.</p>
  <p><noscript>JavaScript is required to sign in. <a id="manual" href="/auth/start">Click here to continue</a>.</noscript></p>
</div>
<script>
(function () {
  try {
    var hash = window.location.hash || "";
    if (hash.charAt(0) === "#") { hash = hash.substring(1); }
    var pathAndQuery = window.location.pathname + window.location.search;
    var url = "/auth/start?path=" + encodeURIComponent(pathAndQuery)
            + "&hash=" + encodeURIComponent(hash);
    // replace() so the landing page doesn't pollute browser history.
    window.location.replace(url);
  } catch (e) {
    // If something goes wrong, the noscript link is the visible fallback.
    var manual = document.getElementById("manual");
    if (manual) { manual.style.display = "inline"; }
  }
})();
</script>
</body>
</html>"##;

/// The HTML the middleware serves when the marker cookie
/// `lucida_signed_out=1` is present (i.e. the user just clicked sign
/// out, then refreshed / opened a new tab / followed a saved link).
///
/// Same scaffolding as `UNAUTH_LANDING_HTML`, but **does not auto-bounce**.
/// The user must click "Sign in again" — which is the whole point: a
/// silent auto-bounce here would 302 → /auth/start → Google → silent
/// pass-through (Google's session is still active) → callback → fresh
/// lucida session, defeating the user's intent to log out.
///
/// The link's href is rewritten by inline JS on load to inject
/// `location.pathname + location.search` and the captured `location.hash`,
/// so a saved-view URL like `/dataset/foo#view=abc` survives the round
/// trip. The noscript fallback href hard-codes `/` — JS-disabled users
/// lose the deep-link, but still get to a working sign-in.
pub const SIGNED_OUT_LANDING_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>lucida — signed out</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a1f; color: #eee; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { padding: 24px 32px; border: 1px solid #444; border-radius: 8px; background: #22222a; max-width: 360px; }
  a.button { display: inline-block; margin-top: 8px; padding: 8px 16px; background: #646cff; color: #fff; text-decoration: none; border-radius: 6px; }
  p { color: #aaa; }
</style>
</head>
<body>
<div class="card">
  <h1 style="margin-top:0">Signed out</h1>
  <p>You've been signed out of lucida.</p>
  <a id="signin" class="button" href="/auth/start?path=%2F">Sign in again</a>
</div>
<script>
(function () {
  try {
    var hash = window.location.hash || "";
    if (hash.charAt(0) === "#") { hash = hash.substring(1); }
    var pathAndQuery = window.location.pathname + window.location.search;
    var url = "/auth/start?path=" + encodeURIComponent(pathAndQuery)
            + "&hash=" + encodeURIComponent(hash);
    var link = document.getElementById("signin");
    if (link) { link.setAttribute("href", url); }
  } catch (e) {
    // Fall through: link still points to /auth/start?path=%2F so
    // sign-in works, just without the captured hash.
  }
})();
</script>
</body>
</html>"##;

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity-check the contract the slice-4 acceptance criteria
    /// articulate: the shim must produce a request to /auth/start with
    /// URL-encoded path and hash. We grep the static string rather
    /// than execute it (no JS engine in cargo test); a vitest test
    /// against the same shim shape lives in lucida-web.
    #[test]
    fn shim_redirects_to_auth_start_with_encoded_path_and_hash() {
        assert!(UNAUTH_LANDING_HTML.contains("/auth/start?path="));
        assert!(UNAUTH_LANDING_HTML.contains("encodeURIComponent(pathAndQuery)"));
        assert!(UNAUTH_LANDING_HTML.contains("encodeURIComponent(hash)"));
        assert!(
            UNAUTH_LANDING_HTML.contains("window.location.replace"),
            "use replace() to keep the unauth landing out of history",
        );
    }

    #[test]
    fn noscript_fallback_present() {
        assert!(UNAUTH_LANDING_HTML.contains("<noscript>"));
        assert!(UNAUTH_LANDING_HTML.contains("/auth/start"));
    }

    /// Annotation deep-links (`/w/<id>#a=<annotationId>`, annotation-views
    /// slice 3) ride the SAME hash-capture the shim already does — it forwards
    /// the WHOLE `location.hash`, not a specific key (`#view=`/`#b=`/`#a=` all
    /// ride identically). Assert the capture is key-agnostic so the `#a=` link
    /// survives the logged-out OAuth round trip with no shim change.
    #[test]
    fn captures_full_hash_so_annotation_deeplink_survives_oauth() {
        // The shim reads the entire hash, strips only the leading '#', and
        // forwards it URL-encoded — it never inspects which key is present.
        assert!(UNAUTH_LANDING_HTML.contains("window.location.hash"));
        assert!(UNAUTH_LANDING_HTML.contains("encodeURIComponent(hash)"));
        // It must not special-case a hash key (that would drop `#a=`).
        assert!(
            !UNAUTH_LANDING_HTML.contains("#view="),
            "the shim forwards the whole hash; it must not key off #view=",
        );
        // Same for the signed-out landing's link rewrite.
        assert!(SIGNED_OUT_LANDING_HTML.contains("window.location.hash"));
        assert!(SIGNED_OUT_LANDING_HTML.contains("encodeURIComponent(hash)"));
    }

    #[test]
    fn signed_out_landing_renders_static_signin_link_no_auto_bounce() {
        // Deliberately must NOT auto-redirect. The whole point of this
        // page is to break the auto-bounce loop after explicit logout.
        assert!(
            !SIGNED_OUT_LANDING_HTML.contains("window.location.replace"),
            "signed-out landing must not auto-bounce — that defeats logout",
        );
        assert!(
            !SIGNED_OUT_LANDING_HTML.contains("location.assign"),
            "signed-out landing must not auto-navigate — that defeats logout",
        );
        // Must offer a sign-in affordance the user can click.
        assert!(SIGNED_OUT_LANDING_HTML.contains("Sign in again"));
        assert!(SIGNED_OUT_LANDING_HTML.contains("id=\"signin\""));
    }

    #[test]
    fn signed_out_landing_inline_js_injects_path_and_hash_on_link() {
        // The link's href is rewritten on load to carry the captured
        // pathname+search and hash. Same encoding shape as the
        // auto-bounce shim so /auth/start parses both consistently.
        assert!(SIGNED_OUT_LANDING_HTML.contains("encodeURIComponent(pathAndQuery)"));
        assert!(SIGNED_OUT_LANDING_HTML.contains("encodeURIComponent(hash)"));
        assert!(SIGNED_OUT_LANDING_HTML.contains("setAttribute(\"href\""));
    }

    #[test]
    fn signed_out_landing_noscript_fallback_signin_link() {
        // No JS engine on the user's browser → the static href
        // (`/auth/start?path=%2F`) still works; they lose the saved-
        // view hash but reach a working sign-in.
        assert!(SIGNED_OUT_LANDING_HTML.contains("/auth/start?path=%2F"));
    }
}
