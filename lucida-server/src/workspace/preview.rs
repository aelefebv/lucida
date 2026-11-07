//! Workspace previews: one small image per workspace, captured by the
//! viewer from its own canvas and shown on the workspace's dashboard card.
//!
//! The server never renders or decodes a preview, so what a card shows is
//! what someone saw, colormaps and all. It checks who is asking, sniffs the
//! type from the leading bytes, caps the size, and limits how often a
//! workspace's preview can change.

use std::time::Duration;

use axum::Extension;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use lucida_core::auth_principal::AuthPrincipal;
use serde_json::json;
use thiserror::Error;

use super::http::WorkspacesState;
use super::manager::WorkspaceError;
use super::types::{WorkspacePreview, WorkspacePreviewMeta};

/// The largest preview accepted, in bytes. The viewer sends a WebP about
/// 480 px on its long side, a few kilobytes to a few tens; the cap leaves
/// room for a busy frame or a browser that falls back to JPEG.
/// `lucida-web/src/workspacePreview/api.ts` checks the same number.
pub const MAX_PREVIEW_BYTES: usize = 256 * 1024;

/// How soon after one write a workspace's preview may change again.
///
/// Long enough that a client looping on uploads writes twelve times a
/// minute at most, and short enough that a person choosing a view by hand
/// right after the automatic capture waits only seconds.
pub const MIN_PREVIEW_INTERVAL: Duration = Duration::from_secs(5);

/// The image types a preview may be, by the bytes that open each file.
/// Every browser can show all three, and every one the viewer runs in can
/// encode at least one.
pub fn sniff_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[derive(Debug, Error)]
pub enum PreviewError {
    #[error("{0}")]
    Workspace(#[from] WorkspaceError),
    #[error("this workspace has no preview yet")]
    Missing,
    #[error("the preview is empty")]
    Empty,
    #[error("the upload ended before the preview arrived")]
    Interrupted,
    #[error("the preview is larger than the {MAX_PREVIEW_BYTES}-byte cap")]
    TooLarge,
    #[error("a preview must be a WebP, PNG, or JPEG image")]
    UnsupportedType,
    #[error("the request says {declared}, but the bytes are {sniffed}")]
    TypeMismatch {
        declared: String,
        sniffed: &'static str,
    },
    #[error("this workspace's preview changed moments ago; try again in {retry_after_secs} s")]
    TooSoon { retry_after_secs: u64 },
}

impl IntoResponse for PreviewError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            // The same shape every other workspace route gives it.
            PreviewError::Workspace(e) => return e.into_response(),
            PreviewError::Missing => (StatusCode::NOT_FOUND, "preview_not_found"),
            PreviewError::Empty | PreviewError::Interrupted => {
                (StatusCode::BAD_REQUEST, "bad_request")
            }
            PreviewError::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "preview_too_large"),
            PreviewError::UnsupportedType | PreviewError::TypeMismatch { .. } => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_preview_type",
            ),
            PreviewError::TooSoon { .. } => (StatusCode::TOO_MANY_REQUESTS, "preview_rate_limited"),
        };
        let body = Json(json!({ "error": code, "detail": self.to_string() }));
        match self {
            PreviewError::TooSoon { retry_after_secs } => (
                status,
                [(header::RETRY_AFTER, retry_after_secs.to_string())],
                body,
            )
                .into_response(),
            _ => (status, body).into_response(),
        }
    }
}

/// Check an upload against the allowlist and the cap, and name its type.
///
/// A declared `Content-Type` is optional, but one that names a different
/// image type than the bytes is refused rather than corrected: it means
/// the client is not sending what it thinks it is.
pub fn validate_preview(
    declared: Option<&str>,
    bytes: &[u8],
) -> Result<&'static str, PreviewError> {
    if bytes.is_empty() {
        return Err(PreviewError::Empty);
    }
    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err(PreviewError::TooLarge);
    }
    let sniffed = sniff_image_type(bytes).ok_or(PreviewError::UnsupportedType)?;
    let declared = declared
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "application/octet-stream");
    match declared {
        Some(declared) if declared != sniffed => {
            Err(PreviewError::TypeMismatch { declared, sniffed })
        }
        _ => Ok(sniffed),
    }
}

/// Seconds until a write refused at `now` would be accepted, at least one.
pub(crate) fn retry_after_secs(last_updated_at: DateTime<Utc>, now: DateTime<Utc>) -> u64 {
    let interval = chrono::Duration::from_std(MIN_PREVIEW_INTERVAL).expect("a few seconds fit");
    let wait = (last_updated_at + interval - now).num_milliseconds().max(0) as u64;
    wait.div_ceil(1000).max(1)
}

/// A strong validator for the stored bytes. A write always moves
/// `updated_at` (the rate limit keeps two writes seconds apart), so the
/// instant and the size name one image.
fn etag(meta: &WorkspacePreviewMeta) -> String {
    format!(
        "\"{:x}-{:x}\"",
        meta.updated_at.timestamp_micros(),
        meta.size_bytes
    )
}

fn if_none_match_hits(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|candidate| candidate == "*" || candidate.trim_start_matches("W/") == etag)
}

/// `GET` (and `HEAD`) `/api/workspaces/{id}/preview`.
///
/// `no-cache` makes a browser revalidate each time, which costs a 304 once
/// it holds the current image. The dashboard adds the listing's update
/// time to the URL as well, because an `<img>` already decoded in the page
/// is reused by URL without asking the server at all.
pub(super) async fn get_preview(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let preview = match state
        .manager
        .workspace_preview(&workspace_id, &principal)
        .await
    {
        Ok(Some(preview)) => preview,
        Ok(None) => return PreviewError::Missing.into_response(),
        Err(e) => return e.into_response(),
    };
    let WorkspacePreview { meta, image } = preview;
    let etag = etag(&meta);
    let last_modified = meta
        .updated_at
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let mut response = if if_none_match_hits(&headers, &etag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let mut response = (StatusCode::OK, image).into_response();
        let response_headers = response.headers_mut();
        response_headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&meta.content_type)
                .unwrap_or(HeaderValue::from_static("application/octet-stream")),
        );
        response
    };
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    response_headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Ok(value) = HeaderValue::from_str(&etag) {
        response_headers.insert(header::ETAG, value);
    }
    if let Ok(value) = HeaderValue::from_str(&last_modified) {
        response_headers.insert(header::LAST_MODIFIED, value);
    }
    response
}

/// `PUT /api/workspaces/{id}/preview`, with the image as the body.
///
/// The body is read up to the cap and no further, so an oversize upload
/// costs the server the cap and not whatever the client meant to send.
pub(super) async fn put_preview(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let declared_length = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if declared_length.is_some_and(|length| length > MAX_PREVIEW_BYTES) {
        return PreviewError::TooLarge.into_response();
    }
    let image = match read_capped(body).await {
        Ok(image) => image,
        Err(e) => return e.into_response(),
    };
    let declared_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    match state
        .manager
        .put_workspace_preview(&workspace_id, &principal, declared_type, &image, Utc::now())
        .await
    {
        Ok(meta) => (StatusCode::OK, Json(meta)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn read_capped(body: Body) -> Result<Vec<u8>, PreviewError> {
    let mut stream = body.into_data_stream();
    let mut image = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| PreviewError::Interrupted)?;
        if image.len() + chunk.len() > MAX_PREVIEW_BYTES {
            return Err(PreviewError::TooLarge);
        }
        image.extend_from_slice(&chunk);
    }
    Ok(image)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEBP: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 ";

    #[test]
    fn each_allowed_type_is_recognized_by_its_leading_bytes() {
        assert_eq!(
            sniff_image_type(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(
            sniff_image_type(b"\xff\xd8\xff\xe0rest"),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_type(WEBP), Some("image/webp"));
    }

    #[test]
    fn anything_else_is_not_an_image_the_server_takes() {
        for bytes in [
            &b"GIF89a"[..],
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
            b"RIFF\x24\x00\x00\x00WAVEfmt ",
            b"RIFF",
            b"\x89PNG",
        ] {
            assert_eq!(sniff_image_type(bytes), None, "{bytes:?}");
        }
    }

    #[test]
    fn a_declared_type_must_agree_with_the_bytes() {
        assert_eq!(
            validate_preview(Some("image/webp"), WEBP).unwrap(),
            "image/webp"
        );
        assert_eq!(
            validate_preview(Some("IMAGE/WEBP; q=1"), WEBP).unwrap(),
            "image/webp"
        );
        assert_eq!(validate_preview(None, WEBP).unwrap(), "image/webp");
        assert_eq!(
            validate_preview(Some("application/octet-stream"), WEBP).unwrap(),
            "image/webp"
        );
        assert!(matches!(
            validate_preview(Some("image/png"), WEBP),
            Err(PreviewError::TypeMismatch {
                sniffed: "image/webp",
                ..
            })
        ));
    }

    #[test]
    fn an_empty_or_oversized_upload_is_refused_before_it_is_sniffed() {
        assert!(matches!(
            validate_preview(None, b""),
            Err(PreviewError::Empty)
        ));
        let mut big = WEBP.to_vec();
        big.resize(MAX_PREVIEW_BYTES + 1, 0);
        assert!(matches!(
            validate_preview(None, &big),
            Err(PreviewError::TooLarge)
        ));
    }

    #[test]
    fn a_refused_write_is_told_when_to_come_back() {
        let last: DateTime<Utc> = "2026-01-02T03:04:05Z".parse().unwrap();
        let now = last + chrono::Duration::milliseconds(1_200);
        assert_eq!(retry_after_secs(last, now), 4);
        assert_eq!(
            retry_after_secs(last, last + chrono::Duration::seconds(10)),
            1
        );
    }

    #[test]
    fn a_matching_validator_answers_not_modified() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_static("\"a\", W/\"b-1\""),
        );
        assert!(if_none_match_hits(&headers, "\"b-1\""));
        assert!(!if_none_match_hits(&headers, "\"c\""));
    }
}
