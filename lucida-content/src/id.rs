use serde::{Deserialize, Serialize};

/// Stable dataset identity. Assigned by the server on import.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DatasetId(pub String);

impl std::fmt::Display for DatasetId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::borrow::Borrow<str> for DatasetId {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for DatasetId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl From<&str> for DatasetId {
    fn from(s: &str) -> Self {
        DatasetId(s.to_string())
    }
}

impl From<String> for DatasetId {
    fn from(s: String) -> Self {
        DatasetId(s)
    }
}

/// Stable entity identity within a dataset.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EntityId(pub String);

impl std::fmt::Display for EntityId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for EntityId {
    fn from(s: &str) -> Self {
        EntityId(s.to_string())
    }
}

/// Identifies an image-bearing entity's multiscale image data.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ImageId(pub String);

impl std::fmt::Display for ImageId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for ImageId {
    fn from(s: &str) -> Self {
        ImageId(s.to_string())
    }
}

/// A unique identifier for a registered layout.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LayoutId(pub String);

impl std::fmt::Display for LayoutId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for LayoutId {
    fn from(s: &str) -> Self {
        LayoutId(s.to_string())
    }
}

impl From<String> for LayoutId {
    fn from(s: String) -> Self {
        LayoutId(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn dataset_id_serde_round_trip() {
        let id = DatasetId("ds-001".to_string());
        let json = serde_json::to_string(&id).unwrap();
        let back: DatasetId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn entity_id_serde_round_trip() {
        let id = EntityId("ent-42".to_string());
        let json = serde_json::to_string(&id).unwrap();
        let back: EntityId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn image_id_serde_round_trip() {
        let id = ImageId("img-abc".to_string());
        let json = serde_json::to_string(&id).unwrap();
        let back: ImageId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn layout_id_serde_round_trip() {
        let id = LayoutId("layout-0".to_string());
        let json = serde_json::to_string(&id).unwrap();
        let back: LayoutId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn layout_id_display() {
        let id = LayoutId("grid-2x2".to_string());
        assert_eq!(id.to_string(), "grid-2x2");
    }

    #[test]
    fn id_hash_eq_behavior() {
        let a = EntityId("e1".to_string());
        let b = EntityId("e1".to_string());
        let c = EntityId("e2".to_string());

        assert_eq!(a, b);
        assert_ne!(a, c);

        let mut set = HashSet::new();
        set.insert(a.clone());
        set.insert(b.clone());
        assert_eq!(set.len(), 1);

        set.insert(c);
        assert_eq!(set.len(), 2);
    }
}
