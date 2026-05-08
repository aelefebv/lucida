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
}
