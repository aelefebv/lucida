//! SPA static-asset serving via `tower_http::services::ServeDir`, so one
//! container image serves both the API and the UI (ADR-0020).
//!
//! Unknown paths fall back to `index.html` for client-side routing. When
//! `dist_path` lacks an `index.html`, a landing page with build
//! instructions is served instead. That check runs per request, so building
//! the SPA after the server starts needs no restart. Mounts on the public
//! router half: the bundle itself must never 401.
//!
//! With a deployment theme configured, `index.html` goes out with the
//! theme written in at [`INDEX_MARKER`], so the pre-paint script applies
//! it on a first visit (ADR 0066).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::deployment_theme::{DeploymentTheme, INDEX_MARKER};

/// Build the static-serve router for the SPA bundle at `dist_path`.
///
/// The returned router is a catch-all (`fallback`) — merge it LAST into
/// the application router so route-specific handlers (`/auth/*`,
/// `/api/*`, `/admin/*`, `/ws`) take precedence and the SPA fallback
/// only fires for truly unknown paths.
pub fn router(dist_path: PathBuf, theme: Option<&DeploymentTheme>) -> Router {
    Router::new()
        .fallback(serve_static)
        .with_state(StaticState {
            dist_path: Arc::new(dist_path),
            theme_snippet: theme.map(|t| t.index_snippet().into()),
        })
}

/// State threaded into the fallback handler so it can re-stat the dist
/// directory on every request without holding any mutable state itself.
#[derive(Clone)]
struct StaticState {
    dist_path: Arc<PathBuf>,
    /// What replaces [`INDEX_MARKER`] in `index.html`, when a deployment
    /// theme is configured.
    theme_snippet: Option<Arc<str>>,
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
    if let Some(snippet) = state.theme_snippet.as_deref() {
        return serve_with_theme(dist_path, snippet, req).await;
    }
    // SPA fallback: any unknown path returns `index.html` so client-side
    // routing survives deep-link refresh. `.fallback(...)`, not
    // `.not_found_service(...)`, because the latter would serve the SPA
    // shell with a 404 status. ServeDir's error type is Infallible, so the
    // `oneshot` Result is always Ok.
    let index_file = dist_path.join("index.html");
    let svc = ServeDir::new(dist_path).fallback(ServeFile::new(index_file));
    match svc.oneshot(req).await {
        Ok(r) => r.into_response(),
        // Unreachable: ServeDir's error is Infallible.
        Err(e) => match e {},
    }
}

/// The plain path, except that every response that would be `index.html`
/// carries the theme. `/` and `/index.html` reach the file through
/// `ServeDir` itself, so they are caught first; any other path is
/// `index.html` exactly when `ServeDir` finds no file for it.
async fn serve_with_theme(dist_path: &Path, snippet: &str, req: Request) -> Response {
    let path = req.uri().path();
    if path == "/" || path == "/index.html" {
        return themed_index(dist_path, snippet).await;
    }
    let response = match ServeDir::new(dist_path).oneshot(req).await {
        Ok(r) => r,
        Err(e) => match e {},
    };
    if response.status() == StatusCode::NOT_FOUND {
        return themed_index(dist_path, snippet).await;
    }
    response.into_response()
}

async fn themed_index(dist_path: &Path, snippet: &str) -> Response {
    let html = match tokio::fs::read_to_string(dist_path.join("index.html")).await {
        Ok(html) => html,
        Err(e) => {
            tracing::error!(error = %e, "static_serve.index_unreadable");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // The page differs from the file on disk, so the file's
            // modification time cannot validate it.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        with_theme(html, snippet),
    )
        .into_response()
}

/// `html` with the theme in place of the marker. A bundle without the
/// marker goes out unchanged and the client fetches the theme instead,
/// which still themes the page but shows the built-in theme first.
fn with_theme(html: String, snippet: &str) -> String {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !html.contains(INDEX_MARKER) {
        if !WARNED.swap(true, Ordering::Relaxed) {
            tracing::warn!(marker = INDEX_MARKER, "static_serve.theme_marker_missing");
        }
        return html;
    }
    html.replacen(INDEX_MARKER, snippet, 1)
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
    use axum::body::{Body, to_bytes};
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
        let app = router(bogus, None);

        let req = Request::builder().uri("/").body(Body::empty()).unwrap();
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

        let app = router(tmp.path().to_path_buf(), None);
        let req = Request::builder().uri("/").body(Body::empty()).unwrap();
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

        let app = router(tmp.path().to_path_buf(), None);
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

    const MARKED: &str = "<html><head><!-- deployment theme --><script></script></head></html>";

    async fn get(app: &Router, uri: &str) -> (StatusCode, Option<String>, String) {
        let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let cache = res
            .headers()
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap().to_string());
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        (status, cache, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn light_theme() -> DeploymentTheme {
        DeploymentTheme::parse(r#"{"defaults": {"theme": "light"}}"#).unwrap()
    }

    #[tokio::test]
    async fn without_a_theme_the_marker_is_left_alone() {
        let tmp = TempDir::new().unwrap();
        write_index(tmp.path(), MARKED);
        let app = router(tmp.path().to_path_buf(), None);
        for uri in ["/", "/index.html", "/open"] {
            let (status, _, body) = get(&app, uri).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body, MARKED, "{uri}");
        }
    }

    #[tokio::test]
    async fn every_route_to_index_carries_the_theme() {
        let tmp = TempDir::new().unwrap();
        write_index(tmp.path(), MARKED);
        let theme = light_theme();
        let expected = MARKED.replace(INDEX_MARKER, &theme.index_snippet());
        let app = router(tmp.path().to_path_buf(), Some(&theme));
        for uri in [
            "/",
            "/index.html",
            "/open?url=/data/a.zarr",
            "/some/spa/route",
        ] {
            let (status, cache, body) = get(&app, uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert_eq!(body, expected, "{uri}");
            assert_eq!(cache.as_deref(), Some("no-cache"), "{uri}");
        }
    }

    #[tokio::test]
    async fn assets_are_served_untouched_beside_a_theme() {
        let tmp = TempDir::new().unwrap();
        write_index(tmp.path(), MARKED);
        std::fs::create_dir(tmp.path().join("assets")).unwrap();
        std::fs::write(
            tmp.path().join("assets/app.js"),
            "// <!-- deployment theme -->",
        )
        .unwrap();
        let theme = light_theme();
        let app = router(tmp.path().to_path_buf(), Some(&theme));
        let (status, _, body) = get(&app, "/assets/app.js").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "// <!-- deployment theme -->");
    }

    #[tokio::test]
    async fn a_bundle_without_the_marker_is_served_unchanged() {
        let tmp = TempDir::new().unwrap();
        write_index(tmp.path(), "<html>HELLO</html>");
        let theme = light_theme();
        let app = router(tmp.path().to_path_buf(), Some(&theme));
        let (status, _, body) = get(&app, "/").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "<html>HELLO</html>");
    }
}
