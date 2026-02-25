use axum::extract::Path;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Html;

use crate::error::ApiError;

const INDEX_HTML: &str = include_str!("../ui/index.html");
const STYLES_CSS: &str = include_str!("../ui/styles.css");
const APP_JS: &str = include_str!("../ui/app.js");

pub async fn ui_index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

pub async fn ui_asset(Path(path): Path<String>) -> Result<(HeaderMap, &'static str), ApiError> {
    let normalized = path.trim_matches('/');
    match normalized {
        "" | "index.html" => Ok((html_headers(), INDEX_HTML)),
        "styles.css" => Ok((css_headers(), STYLES_CSS)),
        "app.js" => Ok((js_headers(), APP_JS)),
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
