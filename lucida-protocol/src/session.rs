use lucida_content::{DatasetId, ImageId};
use serde::{Deserialize, Serialize};

/// Stable identifier for one live client within a session.
///
/// The domain is deliberately `u32`: the JSON session protocol, the browser's
/// exactly-representable number domain, and the binary chunk-frame header all
/// share this one width. Session allocators must fail closed before exhausting
/// the domain rather than wrapping or issuing an id that another transport
/// cannot represent.
pub type ClientId = u32;

/// Small, request-correlated result of opening a dataset. The authoritative
/// manifest/fetch payload is delivered once through the sequenced
/// `DatasetOpened` command broadcast.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenedDatasetSummary {
    pub workspace_dataset_id: DatasetId,
    pub name: String,
    pub image_count: usize,
    pub entity_count: usize,
}

/// Presentational identity of a connected peer.
///
/// The server derives this from the authenticated principal. Raw email
/// addresses never cross the collaboration wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerIdentity {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture_url: Option<String>,
    #[serde(default)]
    pub initial: String,
}

impl PeerIdentity {
    /// Build a bounded wire identity and compute its privacy-preserving
    /// fallback initial before the value leaves the server.
    pub fn from_principal_parts(
        mut display_name: String,
        mut picture_url: Option<String>,
        email: &str,
    ) -> Self {
        truncate_utf8(&mut display_name, 256);
        if let Some(url) = picture_url.as_mut() {
            truncate_utf8(url, 2048);
        }
        let initial = Self::compute_initial(&display_name, email);
        Self {
            display_name,
            picture_url,
            initial,
        }
    }

    fn compute_initial(display_name: &str, email: &str) -> String {
        let first = |value: &str| value.trim().chars().next();
        let character =
            first(display_name).or_else(|| first(email.split('@').next().unwrap_or("")));
        character
            .map(|value| value.to_uppercase().to_string())
            .unwrap_or_default()
    }
}

fn truncate_utf8(value: &mut String, max_bytes: usize) {
    if value.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandFailureCode {
    InvalidRequest,
    Forbidden,
    Conflict,
    ResourceLimit,
    AuthorizationUnavailable,
    PersistenceUnavailable,
    Internal,
}

/// Chunk-related JSON messages exchanged between clients and the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChunkMessage {
    ChunkRequest {
        dataset_id: DatasetId,
        image_id: ImageId,
        key: String,
    },
}

/// Unsequenced, latest-wins scheduling guidance from one viewer.
///
/// Viewer interest influences generated-coarse work only. It is neither
/// collaborative document state nor saved-view state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewerInterestHint {
    #[serde(default)]
    pub client_id: Option<ClientId>,
    pub dataset_id: DatasetId,
    pub generation: u64,
    pub t: u32,
    pub z: u32,
    #[serde(default)]
    pub channels: Vec<u32>,
    pub mode: ViewerInterestMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<ViewerInterestViewport>,
    #[serde(default)]
    pub desired_keys: Vec<ViewerInterestChunkKey>,
    #[serde(default)]
    pub predicted_keys: Vec<ViewerInterestChunkKey>,
    pub interaction: ViewerInteractionMode,
    pub timestamp_ms: u64,
    pub ttl_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewerInterestMode {
    Slice,
    Volume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewerInteractionMode {
    Idle,
    Panning,
    Zooming,
    Scrubbing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewerInterestViewport {
    pub xy_bounds: [f64; 4],
    pub z_range: [f64; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewerInterestChunkKey {
    pub image_id: ImageId,
    pub key: String,
    #[serde(default)]
    pub lane: ViewerInterestLane,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ViewerInterestLane {
    #[default]
    Visible,
    Predicted,
    Background,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omitted_lane_and_collections_keep_the_legacy_defaults() {
        let hint: ViewerInterestHint = serde_json::from_str(
            r#"{
                "dataset_id":"ds-1",
                "generation":3,
                "t":0,
                "z":4,
                "mode":"slice",
                "desired_keys":[{"image_id":"image-1","key":"0/0/0/4/0/0"}],
                "interaction":"idle",
                "timestamp_ms":10,
                "ttl_ms":1000
            }"#,
        )
        .unwrap();

        assert_eq!(hint.client_id, None);
        assert!(hint.channels.is_empty());
        assert!(hint.predicted_keys.is_empty());
        assert_eq!(hint.desired_keys[0].lane, ViewerInterestLane::Visible);
    }

    #[test]
    fn peer_identity_bounds_provider_strings_on_utf8_boundaries() {
        let identity = PeerIdentity::from_principal_parts(
            "🧬".repeat(100),
            Some(format!("https://example.test/{}", "x".repeat(4096))),
            "member@example.test",
        );
        assert!(identity.display_name.len() <= 256);
        assert!(identity.picture_url.unwrap().len() <= 2048);
        assert!(!identity.initial.is_empty());
    }
}
