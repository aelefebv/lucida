use axum::extract::Path;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Html;

use crate::error::ApiError;

const INDEX_HTML: &str = include_str!("../ui/index.html");
const STYLES_CSS: &str = include_str!("../ui/styles.css");
const APP_JS: &str = include_str!("../ui/app.js");
const REPLAY_HTML: &str = include_str!("../ui/replay.html");
const REPLAY_CSS: &str = include_str!("../ui/replay.css");
const REPLAY_JS: &str = include_str!("../ui/replay.js");
const LIVE_HTML: &str = include_str!("../ui/live.html");
const LIVE_CSS: &str = include_str!("../ui/live.css");
const LIVE_JS: &str = include_str!("../ui/live.js");
const VIEWER_HTML: &str = include_str!("../ui/viewer.html");
const VIEWER_CSS: &str = include_str!("../ui/viewer.css");
const VIEWER_JS: &str = include_str!("../ui/viewer.js");
const VIEWER_HELPERS_JS: &str = include_str!("../ui/viewer_helpers.js");

pub async fn ui_index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

pub async fn ui_replay() -> Html<&'static str> {
    Html(REPLAY_HTML)
}

pub async fn ui_live() -> Html<&'static str> {
    Html(LIVE_HTML)
}

pub async fn ui_viewer() -> Html<&'static str> {
    Html(VIEWER_HTML)
}

pub async fn ui_asset(Path(path): Path<String>) -> Result<(HeaderMap, &'static str), ApiError> {
    let normalized = path.trim_matches('/');
    match normalized {
        "" | "index.html" => Ok((html_headers(), INDEX_HTML)),
        "styles.css" => Ok((css_headers(), STYLES_CSS)),
        "app.js" => Ok((js_headers(), APP_JS)),
        "replay" | "replay.html" => Ok((html_headers(), REPLAY_HTML)),
        "replay.css" => Ok((css_headers(), REPLAY_CSS)),
        "replay.js" => Ok((js_headers(), REPLAY_JS)),
        "live" | "live.html" => Ok((html_headers(), LIVE_HTML)),
        "live.css" => Ok((css_headers(), LIVE_CSS)),
        "live.js" => Ok((js_headers(), LIVE_JS)),
        "viewer" | "viewer.html" => Ok((html_headers(), VIEWER_HTML)),
        "viewer.css" => Ok((css_headers(), VIEWER_CSS)),
        "viewer.js" => Ok((js_headers(), VIEWER_JS)),
        "viewer_helpers.js" => Ok((js_headers(), VIEWER_HELPERS_JS)),
        _ => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "ui_asset_not_found",
            "UI asset was not found.",
            Some(serde_json::json!({ "path": normalized })),
        )),
    }
}

fn html_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "text/html; charset=utf-8".parse().expect("valid header"),
    );
    headers
}

fn css_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "text/css; charset=utf-8".parse().expect("valid header"),
    );
    headers
}

fn js_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "application/javascript; charset=utf-8"
            .parse()
            .expect("valid header"),
    );
    headers
}
