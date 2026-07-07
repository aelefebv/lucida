use serde::{Deserialize, Serialize};

use crate::layout::PositioningMode;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub enum DatasetKind {
    #[default]
    Single,
    Collection {
        rows: Vec<String>,
        columns: Vec<String>,
        positioning_mode: PositioningMode,
        has_explicit_positions: bool,
    },
}
