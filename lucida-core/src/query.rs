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
    /// Whether this entity's image is a segmentation **label** overlay (vs
    /// intensity), so the web roster can tag / group / style label rows without
    /// re-joining against the manifest. A hidden label is already excluded from
    /// `view_query`'s output by the core gate, so any label row present here is
    /// one the user has turned on.
    #[serde(default)]
    pub is_label: bool,
    /// For a label entity, its **label-relative index** (the N-th label image),
    /// the value `SetLabelVisible`/`SetLabelOpacity` carry — so the roster can
    /// address this label's settings directly. `None` for intensity.
    /// `skip_serializing_if` keeps intensity rows byte-identical to the
    /// pre-slice wire shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_index: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::DocumentCommand;
    use crate::scene::Scene;
    use crate::scene::test_helpers;
    use lucida_content::DatasetId;

    #[test]
    fn single_image_view_query() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
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
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let result = scene.view_query(&DatasetId::from("ds1")).unwrap();
        assert_eq!(result.epochs, scene.epochs);
    }

    #[test]
    fn view_query_serde_round_trip() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let result = scene.view_query(&DatasetId::from("ds1")).unwrap();
        let json = serde_json::to_string(&result).unwrap();
        let parsed: ViewQueryResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.visible_entities.len(), result.visible_entities.len());
    }

    #[test]
    fn intensity_roster_row_omits_label_index_on_the_wire() {
        // An intensity entity serializes with is_label=false and NO label_index
        // key (skip_serializing_if), keeping the roster wire shape backward
        // compatible for the common all-intensity dataset.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let result = scene.view_query(&DatasetId::from("ds1")).unwrap();
        let row = &result.visible_entities[0];
        assert!(!row.is_label);
        assert_eq!(row.label_index, None);
        let json = serde_json::to_string(row).unwrap();
        assert!(
            !json.contains("label_index"),
            "intensity row must omit label_index: {json}"
        );
        assert!(json.contains("\"is_label\":false"));
    }

    #[test]
    fn visible_label_roster_row_carries_index() {
        // A toggled-on label entity round-trips with is_label=true and its
        // label-relative index present.
        let mut scene = Scene::new([800, 600]);
        let reg = crate::scene::test_helpers::make_dataset_with_labels(
            "ds1",
            256,
            256,
            &[("m", 256, 256)],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(
            crate::command::ViewportCommand::SetLabelVisible {
                dataset_id: "ds1".into(),
                label: 0,
                visible: true,
            }
            .into(),
        );
        let result = scene.view_query(&DatasetId::from("ds1")).unwrap();
        let json = serde_json::to_string(&result).unwrap();
        let parsed: ViewQueryResult = serde_json::from_str(&json).unwrap();
        let label_row = parsed
            .visible_entities
            .iter()
            .find(|r| r.is_label)
            .expect("a visible label row");
        assert_eq!(label_row.label_index, Some(0));
    }
}
