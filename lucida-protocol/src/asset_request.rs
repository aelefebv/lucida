//! Client → server proxy request envelope.
//!
//! Mirrors `ChunkRequest` in shape: the client identifies the dataset +
//! entity it wants a proxy for, picks the proxy kind, and selects a
//! `(t, c)`. The server resolves the spec against its
//! [`crate::ProxyGenerator`] and returns the bytes via a binary frame.
//!
//! Wire shape (JSON, snake_case):
//!
//! ```json
//! { "type": "asset_request",
//!   "dataset_id": "ds-...",
//!   "entity_id":  "field-A1",
//!   "kind":       "FieldProxy3D",
//!   "t": 0,
//!   "c": 0 }
//! ```
//!
//! Wire-format sibling of `ChunkMessage::ChunkRequest`. The two are
//! parsed at the same layer in the server handler — see
//! `lucida_server::handler::handle_client`.

use lucida_content::{DatasetId, EntityId};
use lucida_proxy::ProxyKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssetMessage {
    /// Viewer → server: request a proxy asset.
    AssetRequest {
        dataset_id: DatasetId,
        entity_id: EntityId,
        kind: ProxyKind,
        t: u32,
        c: u32,
    },
}

/// Parsed `AssetRequest` body, as a stand-alone struct for handler use.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct AssetRequest {
    pub dataset_id: DatasetId,
    pub entity_id: EntityId,
    pub kind: ProxyKind,
    pub t: u32,
    pub c: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_message_round_trip() {
        let msg = AssetMessage::AssetRequest {
            dataset_id: DatasetId("ds-x".into()),
            entity_id: EntityId("field-A1".into()),
            kind: ProxyKind::FieldProxy3D,
            t: 0,
            c: 0,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"asset_request\""));
        let parsed: AssetMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            AssetMessage::AssetRequest {
                dataset_id,
                entity_id,
                kind,
                t,
                c,
            } => {
                assert_eq!(dataset_id, DatasetId("ds-x".into()));
                assert_eq!(entity_id, EntityId("field-A1".into()));
                assert_eq!(kind, ProxyKind::FieldProxy3D);
                assert_eq!(t, 0);
                assert_eq!(c, 0);
            }
        }
    }

    #[test]
    fn asset_request_struct_round_trip() {
        let req = AssetRequest {
            dataset_id: DatasetId("ds-y".into()),
            entity_id: EntityId("well-B2".into()),
            kind: ProxyKind::WellProxy3D,
            t: 3,
            c: 1,
        };
        let json = serde_json::to_string(&req).unwrap();
        let back: AssetRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req, back);
    }
}
