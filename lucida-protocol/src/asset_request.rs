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
//!   "rid": 12,
//!   "dataset_id": "ds-...",
//!   "entity_id":  "tile-A1",
//!   "kind":       "TileProxy3D",
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
        /// Correlation label, minted from the same per-connection counter as
        /// `ChunkMessage::ChunkRequest` (ADR 0048). Uniqueness is across the
        /// connection, not within a family, so a label that is ambiguous
        /// until you also know the message type would not be a join key.
        rid: u32,
        dataset_id: DatasetId,
        entity_id: EntityId,
        kind: ProxyKind,
        t: u32,
        c: u32,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_message_round_trip() {
        let msg = AssetMessage::AssetRequest {
            rid: 12,
            dataset_id: DatasetId("ds-x".into()),
            entity_id: EntityId("tile-A1".into()),
            kind: ProxyKind::TileProxy3D,
            t: 0,
            c: 0,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"asset_request\""));
        let parsed: AssetMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            AssetMessage::AssetRequest {
                rid,
                dataset_id,
                entity_id,
                kind,
                t,
                c,
            } => {
                assert_eq!(rid, 12);
                assert_eq!(dataset_id, DatasetId("ds-x".into()));
                assert_eq!(entity_id, EntityId("tile-A1".into()));
                assert_eq!(kind, ProxyKind::TileProxy3D);
                assert_eq!(t, 0);
                assert_eq!(c, 0);
            }
        }
    }

    /// The label is required: a payload without it must fail to parse rather
    /// than default to `rid: 0`, which would look like a join and produce
    /// wrong rows.
    #[test]
    fn asset_message_without_label_fails_to_parse() {
        let json = r#"{"type":"asset_request","dataset_id":"ds-x","entity_id":"tile-A1",
                       "kind":"TileProxy3D","t":0,"c":0}"#;
        assert!(serde_json::from_str::<AssetMessage>(json).is_err());
    }
}
