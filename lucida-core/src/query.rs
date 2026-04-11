use serde::{Deserialize, Serialize};

use lucida_content::{EntityId, EntityKind, ImageId};

use crate::epoch::SceneEpochs;

/// Result of querying the scene for visible entities from the current camera view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewQueryResult {
    pub epochs: SceneEpochs,
    pub visible_entities: Vec<EntityQueryResult>,
}

/// Per-entity geometric query result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityQueryResult {
    pub entity_id: EntityId,
    pub image_id: ImageId,
    pub kind: EntityKind,
    pub visible: bool,
    pub projected_diagonal_px: f64,
    pub projected_area_px2: f64,
    pub centroid_world: [f64; 3],
    pub ideal_target_lod: u32,
    pub importance: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::DocumentCommand;
    use crate::scene::test_helpers;
    use crate::scene::Scene;
    use lucida_content::DatasetId;

    #[test]
    fn single_image_view_query() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        let result = scene.view_query(&DatasetId::from("ds1")).unwrap();
        assert_eq!(result.visible_entities.len(), 1);
        assert!(result.visible_entities[0].visible);
        assert!(result.visible_entities[0].projected_diagonal_px > 0.0);
        assert!(result.visible_entities[0].projected_area_px2 > 0.0);
    }

    #[test]
    fn view_query_nonexistent_dataset_returns_none() {
        let scene = Scene::new([800, 600]);
        assert!(scene.view_query(&DatasetId::from("nope")).is_none());
    }

    #[test]
    fn view_query_carries_epochs() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        let result = scene.view_query(&DatasetId::from("ds1")).unwrap();
        assert_eq!(result.epochs, scene.epochs);
    }

    #[test]
    fn view_query_serde_round_trip() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_register_dataset("ds1", "test", 1);
        scene.apply(DocumentCommand::RegisterDataset(reg).into());
        let result = scene.view_query(&DatasetId::from("ds1")).unwrap();
        let json = serde_json::to_string(&result).unwrap();
        let parsed: ViewQueryResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.visible_entities.len(), result.visible_entities.len());
    }
}
