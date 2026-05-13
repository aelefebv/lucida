//! SPA static-asset serving via `tower_http::services::ServeDir`.
//!
//! Per ADR-0020 ([[decisions/0020-single-image-with-servedir]]):
//! `lucida-server` serves the SPA bundle (`lucida-web/dist`) directly so
//! the production deploy unit can be a single container image and the
//! localhost docker-run path works on `:9876` alone.
//!
//! ## Public surface
//!
//! [`router`] takes a `dist_path` and returns an Axum [`Router`] that
//! either:
//!
//! * Serves the bundle from `dist_path` with SPA-style fallback to
//!   `index.html` for unknown paths (so client-side routing works on
//!   deep-link refresh).
//! * Or, if `dist_path` is missing / empty / lacks `index.html`, serves
//!   a small static landing page with build instructions ("run
//!   `pnpm run build` then restart").
//!
//! ## Why detect at request time, not startup
//!
//! A developer who runs `cargo run` first and *then* builds the SPA in
//! another shell would otherwise have to restart the server to pick up
//! the freshly-built dist. The fallback handler inspects the filesystem
//! on each request — the cost is one `metadata()` syscall per hit, well
//! below the network round-trip cost.
//!
//! ## Auth interaction
//!
//! This route MUST land on the public router half (NOT through the auth
//! middleware). The SPA's HTML/JS/CSS shouldn't 401; auth gates remain
//! on `/auth/whoami` polling and `/api/*` calls. See
//! [[decisions/0016-backend-mediated-oauth-with-session-cookies]] and
//! [[subsystems/auth]] for the public/protected router split.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

/// Build the static-serve router for the SPA bundle at `dist_path`.
///
/// The returned router is a catch-all (`fallback`) — merge it LAST into
/// the application router so route-specific handlers (`/auth/*`,
/// `/api/*`, `/admin/*`, `/ws`) take precedence and the SPA fallback
/// only fires for truly unknown paths.
pub fn router(dist_path: PathBuf) -> Router {
    Router::new()
        .fallback(serve_static)
        .with_state(StaticState {
            dist_path: Arc::new(dist_path),
        })
}

/// State threaded into the fallback handler so it can re-stat the dist
/// directory on every request without holding any mutable state itself.
#[derive(Clone)]
struct StaticState {
    dist_path: Arc<PathBuf>,
}

/// Returns true iff `dist_path` is a directory containing `index.html`.
/// We deliberately re-stat on every request (not at startup) so a dev
/// who builds the SPA mid-session sees the result without restarting
/// the server.
fn dist_is_ready(dist_path: &std::path::Path) -> bool {
    let index = dist_path.join("index.html");
    dist_path.is_dir() && index.is_file()
}

/// Fallback handler: delegates to `ServeDir` when the SPA bundle is
/// present, otherwise renders the build-instructions landing page.
async fn serve_static(State(state): State<StaticState>, req: Request) -> Response {
    let dist_path: &std::path::Path = state.dist_path.as_ref();
    if !dist_is_ready(dist_path) {
        return missing_dist_landing();
    }
    // SPA fallback: any unknown path returns `index.html` so client-side
    // routing survives deep-link refresh. ServeFile sets Content-Type
    // from the extension. ServeDir's error type is Infallible so the
    // `oneshot` Result is always Ok — pattern-match exhaustively to
    // reassure the type checker.
    //
    // Note: we use `.fallback(...)` rather than `.not_found_service(...)`
    // because the latter forces the response status to 404, which
    // breaks deep-link SPA refresh — the browser would render the SPA
    // shell with a 404 status and confuse devtools / monitoring.
    // `.fallback(...)` keeps ServeFile's natural 200 OK.
    let index_file = dist_path.join("index.html");
    let svc = ServeDir::new(dist_path).fallback(ServeFile::new(index_file));
    match svc.oneshot(req).await {
        Ok(r) => r.into_response(),
        // Unreachable: ServeDir's error is Infallible.
        Err(e) => match e {},
    }
}

/// Build the "SPA bundle missing — run `pnpm run build`" landing page.
/// 200 OK with `text/html` so a browser that hits `:9876` directly sees
/// an actionable message rather than a 404 or blank page.
fn missing_dist_landing() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        MISSING_DIST_HTML,
    )
        .into_response()
}

/// Static landing HTML served when `LUCIDA_WEB_DIST` is missing or
/// empty. Self-contained (no external CSS / JS). Mirrors the visual
/// style of `auth/error_page` so devs landing on it don't feel like
/// they've hit a different application.
const MISSING_DIST_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>lucida — SPA bundle not built</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a1f; color: #eee; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { padding: 24px 32px; border: 1px solid #444; border-radius: 8px; background: #22222a; max-width: 640px; }
  h1 { margin-top: 0; font-size: 1.25rem; }
  p { line-height: 1.5; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #111118; padding: 1px 6px; border-radius: 3px; color: #b8d3ff; }
  pre { padding: 12px 14px; overflow-x: auto; }
  strong { color: #fff; }
</style>
</head>
<body>
<div class="card">
<h1>SPA bundle not built</h1>
<p>The lucida server is running but no SPA bundle was found at the configured <code>LUCIDA_WEB_DIST</code> path (default <code>./lucida-web/dist</code>).</p>
<p>To build the SPA, run:</p>
<pre>(cd lucida-web &amp;&amp; pnpm install &amp;&amp; pnpm run build)</pre>
<p>Then refresh this page. (No server restart required &mdash; the dist directory is checked on every request.)</p>
<p>If you're an active developer, you probably want the Vite dev server on <code>:5173</code> (which proxies API/WS to this port) instead of visiting <code>:9876</code> directly.</p>
</div>
</body>
</html>"##;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tempfile::TempDir;
    use tower::ServiceExt;

    /// Helper: write `content` to `dir/index.html`.
    fn write_index(dir: &std::path::Path, content: &str) {
        std::fs::write(dir.join("index.html"), content).expect("write index.html");
    }

    /// Missing dist → build-instructions landing.
    /// 200 OK, text/html, body contains build instructions so a dev who
    /// hits `:9876` without a built SPA sees an actionable message.
    #[tokio::test]
    async fn missing_dist_returns_build_instructions_landing() {
        // Point at a path that definitely doesn't exist.
        let bogus = PathBuf::from("/nonexistent/lucida-web/dist-does-not-exist");
        let app = router(bogus);

        let req = Request::builder()
            .uri("/")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let ct = res
            .headers()
            .get(header::CONTENT_TYPE)
            .expect("content-type")
            .to_str()
            .unwrap()
            .to_string();
        assert!(ct.starts_with("text/html"), "got content-type {ct}");

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body = std::str::from_utf8(&bytes).unwrap();
        assert!(
            body.contains("pnpm run build"),
            "landing page must include build instructions; got: {body}",
        );
        assert!(
            body.contains("LUCIDA_WEB_DIST"),
            "landing page must mention the env var; got: {body}",
        );
    }

    /// Present dist + GET / → serves index.html.
    #[tokio::test]
    async fn present_dist_serves_index_at_root() {
        let tmp = TempDir::new().unwrap();
        let html = "<html>HELLO</html>";
        write_index(tmp.path(), html);

        let app = router(tmp.path().to_path_buf());
        let req = Request::builder()
            .uri("/")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body = std::str::from_utf8(&bytes).unwrap();
        assert_eq!(body, html);
    }

    /// Present dist + GET /some/spa/route → falls back to index.html.
    /// This is the SPA client-routing requirement: deep-link refresh
    /// must hand the browser the same `index.html` so the React router
    /// can pick up the path.
    #[tokio::test]
    async fn present_dist_falls_back_to_index_for_unknown_paths() {
        let tmp = TempDir::new().unwrap();
        let html = "<html>HELLO</html>";
        write_index(tmp.path(), html);

        let app = router(tmp.path().to_path_buf());
        let req = Request::builder()
            .uri("/some/spa/route")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body = std::str::from_utf8(&bytes).unwrap();
        assert_eq!(body, html, "SPA fallback must serve index.html verbatim");
    }
}
