//! SPA static-asset serving via `tower_http::services::ServeDir`, so one
//! container image serves both the API and the UI.
//!
//! Unknown paths fall back to `index.html` for client-side routing, except
//! under `/api` and `/ws`, which answer 404. When
//! `dist_path` lacks an `index.html`, a landing page with build
//! instructions is served instead. That check runs per request, so building
//! the SPA after the server starts needs no restart. Mounts on the public
//! router half: the bundle itself must never 401.
//!
//! With a deployment theme configured, `index.html` goes out with the
//! theme written in at [`INDEX_MARKER`], so the pre-paint script applies
//! it on a first visit.
//!
//! The web build writes a `.br` and a `.gz` copy beside each compressible
//! file, and a browser that accepts one gets it with `Content-Encoding`
//! set. A file without a copy goes out as it is: the server never
//! compresses on the fly.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use serde_json::json;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::deployment_theme::{DeploymentTheme, INDEX_MARKER};

/// Build the static-serve router for the SPA bundle at `dist_path`.
///
/// The returned router is a catch-all (`fallback`) — merge it LAST into
/// the application router so route-specific handlers (`/auth/*`,
/// `/api/*`, `/admin/*`, `/ws/*`) take precedence and the SPA fallback
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
///
/// Any path `ServeDir` finds no file for gets `index.html` with a 200, so
/// client-side routing survives a deep-link refresh. With a theme, every
/// response that would be `index.html` carries it: `/` and `/index.html`
/// reach the file through `ServeDir` itself, so they are caught first.
async fn serve_static(State(state): State<StaticState>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    if let Some(not_found) = not_an_app_route(&path) {
        return not_found;
    }
    let dist_path: &Path = state.dist_path.as_ref();
    if !dist_is_ready(dist_path) {
        return missing_dist_landing();
    }
    let theme = state.theme_snippet.as_deref();
    if let Some(snippet) = theme
        && (path == "/" || path == "/index.html")
    {
        return themed_index(dist_path, snippet).await;
    }
    // Kept for the index fallback, since `ServeDir` consumes the request.
    let mut index_req = Request::new(Body::empty());
    *index_req.method_mut() = req.method().clone();
    *index_req.headers_mut() = req.headers().clone();

    let svc = ServeDir::new(dist_path)
        .precompressed_br()
        .precompressed_gzip();
    let response = match svc.oneshot(req).await {
        Ok(r) => r.into_response(),
        Err(e) => match e {},
    };
    if response.status() != StatusCode::NOT_FOUND {
        return with_file_headers(response, cache_control(&path));
    }
    if let Some(snippet) = theme {
        return themed_index(dist_path, snippet).await;
    }
    let svc = ServeFile::new(dist_path.join("index.html"))
        .precompressed_br()
        .precompressed_gzip();
    let response = match svc.oneshot(index_req).await {
        Ok(r) => r.into_response(),
        Err(e) => match e {},
    };
    with_file_headers(response, NO_CACHE)
}

const NO_CACHE: HeaderValue = HeaderValue::from_static("no-cache");
const IMMUTABLE: HeaderValue = HeaderValue::from_static("public, max-age=31536000, immutable");

/// Vite names every file it writes under `assets/` with a hash of its
/// content, so a URL there always means the same bytes. Anything else,
/// `index.html` above all, must be revalidated: a stale page points at
/// assets the next build no longer has.
fn cache_control(path: &str) -> HeaderValue {
    if path.starts_with("/assets/") {
        IMMUTABLE
    } else {
        NO_CACHE
    }
}

/// Caching and `Vary` for a response that carries a file. `Vary` goes on
/// the plain file too, so a shared cache never hands a compressed copy to
/// a client that did not accept it.
fn with_file_headers(mut response: Response, cache: HeaderValue) -> Response {
    let status = response.status();
    if status.is_success() || status == StatusCode::NOT_MODIFIED {
        let headers = response.headers_mut();
        headers.insert(header::CACHE_CONTROL, cache);
        headers.append(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    response
}

/// A 404 for a path under `/api` or `/ws` that no route claimed. Handing
/// those the page would answer a client that expects JSON or a socket
/// with HTML and a 200.
fn not_an_app_route(path: &str) -> Option<Response> {
    let under = |prefix: &str| {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    if under("/api") {
        Some((StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response())
    } else if under("/ws") {
        Some(StatusCode::NOT_FOUND.into_response())
    } else {
        None
    }
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

    #[tokio::test]
    async fn unknown_api_and_socket_paths_are_not_found() {
        let tmp = TempDir::new().unwrap();
        write_index(tmp.path(), "<html>HELLO</html>");
        let missing = PathBuf::from("/nonexistent/lucida-web/dist-does-not-exist");
        for dist in [tmp.path().to_path_buf(), missing] {
            let app = router(dist, None);
            for uri in ["/api", "/api/", "/api/nope", "/api/workspaces/x/nope?y=1"] {
                let (status, _, body) = get(&app, uri).await;
                assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&body).unwrap(),
                    json!({ "error": "not_found" }),
                    "{uri}"
                );
            }
            for uri in ["/ws", "/ws/", "/ws/nope", "/ws/workspaces"] {
                let (status, _, body) = get(&app, uri).await;
                assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
                assert!(!body.contains("<html"), "{uri}");
            }
        }
    }

    #[tokio::test]
    async fn paths_that_only_begin_with_api_or_ws_are_still_app_routes() {
        let tmp = TempDir::new().unwrap();
        write_index(tmp.path(), "<html>HELLO</html>");
        let app = router(tmp.path().to_path_buf(), None);
        for uri in ["/apiary", "/wsx", "/w/some-workspace"] {
            let (status, _, body) = get(&app, uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert_eq!(body, "<html>HELLO</html>", "{uri}");
        }
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

    /// A bundle whose compressed copies hold their encoding's name, so a
    /// test can tell which file went out.
    fn precompressed_dist() -> TempDir {
        let tmp = TempDir::new().unwrap();
        write_index(tmp.path(), MARKED);
        std::fs::write(tmp.path().join("index.html.br"), "br").unwrap();
        std::fs::write(tmp.path().join("index.html.gz"), "gzip").unwrap();
        std::fs::write(tmp.path().join("favicon.svg"), "<svg/>").unwrap();
        let assets = tmp.path().join("assets");
        std::fs::create_dir(&assets).unwrap();
        for (name, body) in [
            ("app-a1b2.js", "plain"),
            ("app-a1b2.js.br", "br"),
            ("app-a1b2.js.gz", "gzip"),
            ("core-a1b2.wasm", "plain"),
            ("core-a1b2.wasm.br", "br"),
            ("core-a1b2.wasm.gz", "gzip"),
            ("style-a1b2.css", "plain"),
            ("style-a1b2.css.gz", "gzip"),
        ] {
            std::fs::write(assets.join(name), body).unwrap();
        }
        tmp
    }

    struct Served {
        status: StatusCode,
        header: axum::http::HeaderMap,
        body: String,
    }

    impl Served {
        fn get(&self, name: header::HeaderName) -> Option<&str> {
            self.header.get(name).map(|v| v.to_str().unwrap())
        }
        fn varies_on_encoding(&self) -> bool {
            self.header
                .get_all(header::VARY)
                .iter()
                .any(|v| v.to_str().unwrap().eq_ignore_ascii_case("accept-encoding"))
        }
    }

    async fn fetch(app: &Router, uri: &str, headers: &[(header::HeaderName, &str)]) -> Served {
        let mut req = Request::builder().uri(uri);
        for (name, value) in headers {
            req = req.header(name, *value);
        }
        let res = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let header = res.headers().clone();
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        Served {
            status,
            header,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    #[tokio::test]
    async fn each_client_gets_the_best_copy_it_accepts() {
        let tmp = precompressed_dist();
        let app = router(tmp.path().to_path_buf(), None);
        let browser = "gzip, deflate, br, zstd";
        for (uri, accept, served) in [
            ("/assets/app-a1b2.js", Some(browser), "br"),
            ("/assets/app-a1b2.js", Some("gzip"), "gzip"),
            ("/assets/app-a1b2.js", Some("br;q=0.5, gzip"), "gzip"),
            ("/assets/app-a1b2.js", Some("identity"), "plain"),
            ("/assets/app-a1b2.js", None, "plain"),
            ("/assets/style-a1b2.css", Some(browser), "gzip"),
            ("/assets/style-a1b2.css", Some("br"), "plain"),
            ("/favicon.svg", Some(browser), "<svg/>"),
        ] {
            let headers: Vec<_> = accept
                .map(|a| (header::ACCEPT_ENCODING, a))
                .into_iter()
                .collect();
            let res = fetch(&app, uri, &headers).await;
            let case = format!("{uri} with {accept:?}");
            assert_eq!(res.status, StatusCode::OK, "{case}");
            assert_eq!(res.body, served, "{case}");
            let encoding = res.get(header::CONTENT_ENCODING);
            match served {
                "br" | "gzip" => assert_eq!(encoding, Some(served), "{case}"),
                _ => assert_eq!(encoding, None, "{case}"),
            }
            assert!(res.varies_on_encoding(), "{case}");
        }
    }

    #[tokio::test]
    async fn a_compressed_copy_keeps_the_original_content_type() {
        let tmp = precompressed_dist();
        let app = router(tmp.path().to_path_buf(), None);
        for (uri, content_type) in [
            ("/assets/core-a1b2.wasm", "application/wasm"),
            ("/assets/app-a1b2.js", "text/javascript"),
            ("/", "text/html"),
        ] {
            for accept in ["br", "gzip"] {
                let res = fetch(&app, uri, &[(header::ACCEPT_ENCODING, accept)]).await;
                assert_eq!(res.get(header::CONTENT_ENCODING), Some(accept), "{uri}");
                assert_eq!(res.get(header::CONTENT_TYPE), Some(content_type), "{uri}");
            }
        }
    }

    #[tokio::test]
    async fn the_index_fallback_is_compressed_too() {
        let tmp = precompressed_dist();
        let app = router(tmp.path().to_path_buf(), None);
        let res = fetch(&app, "/some/spa/route", &[(header::ACCEPT_ENCODING, "br")]).await;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(res.body, "br");
        assert_eq!(res.get(header::CONTENT_ENCODING), Some("br"));
        assert_eq!(res.get(header::CONTENT_TYPE), Some("text/html"));
        assert!(res.varies_on_encoding());
    }

    #[tokio::test]
    async fn only_hashed_assets_are_cached_for_good() {
        let tmp = precompressed_dist();
        let app = router(tmp.path().to_path_buf(), None);
        let res = fetch(&app, "/assets/app-a1b2.js", &[]).await;
        assert_eq!(
            res.get(header::CACHE_CONTROL),
            Some("public, max-age=31536000, immutable")
        );
        // A missing asset gets the page, which must not be cached as the
        // asset for a year.
        for uri in [
            "/",
            "/index.html",
            "/favicon.svg",
            "/some/spa/route",
            "/assets/gone-c3d4.js",
        ] {
            let res = fetch(&app, uri, &[]).await;
            assert_eq!(res.status, StatusCode::OK, "{uri}");
            assert_eq!(res.get(header::CACHE_CONTROL), Some("no-cache"), "{uri}");
        }
    }

    #[tokio::test]
    async fn revalidating_the_page_keeps_its_caching_headers() {
        let tmp = precompressed_dist();
        let app = router(tmp.path().to_path_buf(), None);
        let first = fetch(&app, "/", &[(header::ACCEPT_ENCODING, "br")]).await;
        let modified = first.get(header::LAST_MODIFIED).expect("last-modified");
        let again = fetch(
            &app,
            "/",
            &[
                (header::ACCEPT_ENCODING, "br"),
                (header::IF_MODIFIED_SINCE, modified),
            ],
        )
        .await;
        assert_eq!(again.status, StatusCode::NOT_MODIFIED);
        assert_eq!(again.get(header::CACHE_CONTROL), Some("no-cache"));
        assert!(again.varies_on_encoding());
    }

    #[tokio::test]
    async fn assets_beside_a_theme_are_compressed_and_cached() {
        let tmp = precompressed_dist();
        let theme = light_theme();
        let app = router(tmp.path().to_path_buf(), Some(&theme));
        let res = fetch(
            &app,
            "/assets/app-a1b2.js",
            &[(header::ACCEPT_ENCODING, "br")],
        )
        .await;
        assert_eq!(res.body, "br");
        assert_eq!(res.get(header::CONTENT_ENCODING), Some("br"));
        assert_eq!(
            res.get(header::CACHE_CONTROL),
            Some("public, max-age=31536000, immutable")
        );
        // The themed page differs from every copy on disk, so it goes out
        // plain whatever the client accepts.
        let expected = MARKED.replace(INDEX_MARKER, &theme.index_snippet());
        for uri in ["/", "/some/spa/route", "/assets/gone-c3d4.js"] {
            let res = fetch(&app, uri, &[(header::ACCEPT_ENCODING, "br")]).await;
            assert_eq!(res.body, expected, "{uri}");
            assert_eq!(res.get(header::CONTENT_ENCODING), None, "{uri}");
            assert_eq!(res.get(header::CACHE_CONTROL), Some("no-cache"), "{uri}");
        }
    }
}
