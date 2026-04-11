use serde::{Deserialize, Serialize};

use crate::id::{EntityId, LayoutId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutSpec {
    pub id: LayoutId,
    pub name: String,
    pub placements: Vec<EntityPlacement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityPlacement {
    pub entity_id: EntityId,
    pub position: [f64; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum PositioningMode {
    Stage,
    #[default]
    Grid,
}
