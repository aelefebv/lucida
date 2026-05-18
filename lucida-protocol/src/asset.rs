//! Asset catalog protocol types — what proxy products are available for
//! which entities, and incremental deltas thereof.
//!
//! The catalog is *capability* metadata, not content. A well exists
//! regardless of whether a proxy has been generated for it; the catalog
//! simply tells Planning which proxy kinds it can request.

use lucida_content::EntityId;
use serde::{Deserialize, Serialize};

// Re-export the canonical ProxyKind so downstream crates (lucida-core,
// lucida-server, web bindings) can refer to it through a single
// well-known path: `lucida_protocol::ProxyKind`.
pub use lucida_proxy::ProxyKind;

/// Snapshot of all known proxy availability for a single dataset.
///
/// One [`ProxyAvailability`] per entity that has at least one proxy.
/// Entities with no available proxies are omitted, not represented as
/// empty entries.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssetCatalog {
    pub entries: Vec<ProxyAvailability>,
}

/// What proxy kinds are available for a given entity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProxyAvailability {
    pub entity_id: EntityId,
    pub kinds: Vec<ProxyKind>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub footprints: Vec<ProxyFootprint>,
}

/// Estimated GPU footprint for one advertised proxy kind.
///
/// `dims` is `[Z, Y, X]`, matching `lucida_proxy::ProxyHeader`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProxyFootprint {
    pub kind: ProxyKind,
    pub dims: [u32; 3],
    pub bytes: u64,
}

impl ProxyFootprint {
    pub fn u16(kind: ProxyKind, dims: [u32; 3]) -> Self {
        Self {
            kind,
            dims,
            bytes: dims
                .iter()
                .fold(2_u64, |acc, dim| acc.saturating_mul(*dim as u64)),
        }
    }
}

/// Incremental update to an [`AssetCatalog`].
///
/// V1 only carries additions (new proxies become available); removal /
/// invalidation is deferred.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssetCatalogDelta {
    pub added: Vec<ProxyAvailability>,
}

impl AssetCatalog {
    /// An empty catalog. Equivalent to `AssetCatalog::default()`.
    pub fn empty() -> Self {
        Self::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_catalog_round_trip() {
        let cat = AssetCatalog::empty();
        let json = serde_json::to_string(&cat).unwrap();
        let back: AssetCatalog = serde_json::from_str(&json).unwrap();
        assert_eq!(cat, back);
        assert!(back.entries.is_empty());
    }

    #[test]
    fn populated_catalog_round_trip() {
        let cat = AssetCatalog {
            entries: vec![
                ProxyAvailability {
                    entity_id: EntityId("well-A1".into()),
                    kinds: vec![ProxyKind::WellProxy3D],
                    footprints: vec![ProxyFootprint::u16(ProxyKind::WellProxy3D, [1, 64, 64])],
                },
                ProxyAvailability {
                    entity_id: EntityId("field-F17".into()),
                    kinds: vec![ProxyKind::FieldProxy3D, ProxyKind::WellProxy3D],
                    footprints: vec![ProxyFootprint::u16(ProxyKind::FieldProxy3D, [1, 64, 64])],
                },
            ],
        };
        let json = serde_json::to_string(&cat).unwrap();
        let back: AssetCatalog = serde_json::from_str(&json).unwrap();
        assert_eq!(cat, back);
    }

    #[test]
    fn proxy_availability_deserializes_without_footprints() {
        let json = r#"{"entity_id":"field-F17","kinds":["FieldProxy3D"]}"#;
        let entry: ProxyAvailability = serde_json::from_str(json).unwrap();
        assert_eq!(entry.entity_id, EntityId("field-F17".into()));
        assert_eq!(entry.kinds, vec![ProxyKind::FieldProxy3D]);
        assert!(entry.footprints.is_empty());
    }

    #[test]
    fn delta_round_trip() {
        let delta = AssetCatalogDelta {
            added: vec![ProxyAvailability {
                entity_id: EntityId("e1".into()),
                kinds: vec![ProxyKind::FieldProxy3D],
                footprints: vec![ProxyFootprint::u16(ProxyKind::FieldProxy3D, [1, 32, 32])],
            }],
        };
        let json = serde_json::to_string(&delta).unwrap();
        let back: AssetCatalogDelta = serde_json::from_str(&json).unwrap();
        assert_eq!(delta, back);
    }

    #[test]
    fn empty_delta_default() {
        let delta = AssetCatalogDelta::default();
        assert!(delta.added.is_empty());
    }
}
