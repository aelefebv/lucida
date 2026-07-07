use serde::{Deserialize, Serialize};

use crate::id::EntityId;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entity {
    pub id: EntityId,
    pub kind: EntityKind,
    pub parent: Option<EntityId>,
    pub labels: EntityLabels,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntityKind {
    Image,
    Group,
    Tile,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntityLabels {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_row: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_index: Option<u32>,
}
