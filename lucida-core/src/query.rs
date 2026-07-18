use serde::{Deserialize, Serialize};

use lucida_content::{EntityId, EntityKind, ImageId};

use crate::epoch::SceneEpochs;

/// Result of querying the scene for visible entities from the current camera view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewQueryResult {
    pub epochs: SceneEpochs,
    pub visible_entities: Vec<EntityQueryResult>,
}

/// Incremental form of a [`ViewQueryResult`].
///
/// A consumer that has already processed a prior query for a dataset can ask
/// for only what changed since then. The two variants let the producer choose
/// between a self-contained snapshot and a difference:
///
/// - [`ViewQueryDelta::Full`] carries the entire visible set. It is returned
///   for the first query of a dataset, after any change that alters which
///   records are present (the membership base), after a camera-mode change,
///   and whenever a correct difference cannot be established. It is always safe
///   to treat as a fresh start.
/// - [`ViewQueryDelta::Delta`] carries only the records that entered, left, or
///   whose *quantized* fields changed since the prior query.
///
/// # Keying
///
/// Records are keyed by [`EntityQueryResult::image_id`], the unique per-record
/// (per-member) identity. [`EntityQueryResult::entity_id`] is **not** unique: a
/// single entity can own more than one image, so a query can emit several
/// records that share an `entity_id` but differ in pyramid depth and therefore
/// in `ideal_target_lod`. Keying on `image_id` keeps those records distinct.
///
/// # Reconstruction
///
/// Applying deltas in order rebuilds the same set a fresh [`ViewQueryResult`]
/// would report. Starting from a `Full`, for each subsequent `Delta`: drop the
/// records whose `image_id` is in `left`, then insert or overwrite every record
/// in `entered` and `changed` keyed by its `image_id`. The resulting map of
/// `image_id → { visible, ideal_target_lod, kind }` equals the one a full query
/// would produce at that step.
///
/// # Quantized fields
///
/// Exactly four aspects of a record trigger a delta entry, all keyed by
/// [`EntityQueryResult::image_id`]: membership (whether the record is present at
/// all), [`EntityQueryResult::visible`], [`EntityQueryResult::ideal_target_lod`],
/// and [`EntityQueryResult::kind`]. This quantized set —
/// `{ membership, visible, ideal_target_lod, kind }` — is the whole of what a
/// delta tracks.
///
/// The continuous fields ([`EntityQueryResult::importance`],
/// [`EntityQueryResult::projected_diagonal_px`],
/// [`EntityQueryResult::projected_area_px2`], and
/// [`EntityQueryResult::centroid_world`]) change on nearly every camera move and
/// are deliberately *not* triggers, so a small camera nudge yields a small delta.
/// Records reported in `entered` and `changed` carry current values for every
/// field, the continuous ones included; those values are simply never, on their
/// own, a reason to report an otherwise-unchanged record.
///
/// # Continuous fields go stale between deltas
///
/// Because the continuous fields are untracked, a record that appears in no
/// delta between two `Full`s may hold *stale* continuous values: its last
/// reported values stand until the record next surfaces in `entered` or
/// `changed` for a quantized reason. Absence from a delta therefore states only
/// that `{ membership, visible, ideal_target_lod, kind }` is unchanged for that
/// record; it makes no claim about the record's continuous fields.
///
/// A consumer MUST NOT read "this record is absent from the delta" as "nothing I
/// derive from this record changed" when what it derives comes from a continuous
/// field. A continuous field can cross a discrete boundary while the quantized
/// set holds steady: over a zoom, [`EntityQueryResult::projected_diagonal_px`]
/// can pass a threshold that flips a downstream discrete choice — a
/// coarse-vs-detailed presentation mode selected by projected size, say — even
/// though membership, visibility, target LOD, and kind are all identical and the
/// delta is thus empty. A consumer that turns a continuous field into such a
/// discrete decision must recompute that decision itself for the records it
/// cares about; the delta does not report continuous-boundary crossings and
/// cannot stand in for that recomputation.
///
/// # Epochs cover what the quantized set does not
///
/// The [`SceneEpochs`] carried on both variants reflect structural and selection
/// changes — a change of the active selection along a dimension axis or of a
/// per-channel display setting (see [`SceneEpochs::selection`]), or of entity
/// membership, layout, or annotations — that the quantized set does not
/// encode. A consumer that must react to those (for example, a selection change
/// that should drive its own refetch) must consult `epochs`, not just `entered`
/// / `left` / `changed`.
///
/// The vectors are ordered by `image_id` so a consumer can rely on a stable,
/// deterministic sequence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ViewQueryDelta {
    /// A complete snapshot; treat as a fresh start.
    Full(ViewQueryResult),
    /// Only the records that changed since the prior query.
    Delta {
        /// Scene epochs at the time of this query.
        epochs: SceneEpochs,
        /// Records now present that were absent in the prior query. Full record each.
        entered: Vec<EntityQueryResult>,
        /// The `image_id` of each record no longer present.
        left: Vec<ImageId>,
        /// Records still present whose quantized state changed. Full record each.
        changed: Vec<EntityQueryResult>,
    },
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

    // ---- view_query_delta ----

    use crate::camera::Camera;
    use std::collections::HashMap;

    /// The quantized set as a full query would report it, keyed by the unique
    /// per-record `image_id` — the map the invariant says every delta replay
    /// must reproduce.
    type QuantizedMap = HashMap<ImageId, (bool, u32, EntityKind)>;

    fn map_from_full(result: &ViewQueryResult) -> QuantizedMap {
        result
            .visible_entities
            .iter()
            .map(|e| {
                (
                    e.image_id.clone(),
                    (e.visible, e.ideal_target_lod, e.kind.clone()),
                )
            })
            .collect()
    }

    /// Replay one delta onto a running reconstruction: a `Full` replaces the
    /// map wholesale; a `Delta` drops `left` and upserts `entered ∪ changed`,
    /// all keyed by `image_id`.
    fn replay(map: &mut QuantizedMap, delta: &ViewQueryDelta) {
        match delta {
            ViewQueryDelta::Full(result) => {
                *map = map_from_full(result);
            }
            ViewQueryDelta::Delta {
                entered,
                left,
                changed,
                ..
            } => {
                for id in left {
                    map.remove(id);
                }
                for e in entered.iter().chain(changed.iter()) {
                    map.insert(
                        e.image_id.clone(),
                        (e.visible, e.ideal_target_lod, e.kind.clone()),
                    );
                }
            }
        }
    }

    fn spread_collection() -> Scene {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_collection_dataset_opened(
            "coll",
            "coll",
            vec![
                ("m0", [0.0, 0.0]),
                ("m1", [600.0, 0.0]),
                ("m2", [1200.0, 0.0]),
                ("m3", [1800.0, 0.0]),
            ],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 256, 256],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene
    }

    fn set_center(scene: &mut Scene, x: f64, y: f64) {
        if let Camera::Slice(s) = &mut scene.camera {
            s.set_center(x, y);
        }
    }

    #[test]
    fn first_query_is_full_then_delta() {
        let mut scene = spread_collection();
        let ds = DatasetId::from("coll");
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Full(_)
        ));
        // A re-query at the same camera is a (here, empty) delta, not a full.
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Delta { .. }
        ));
    }

    #[test]
    fn nonexistent_dataset_delta_is_none() {
        let mut scene = Scene::new([800, 600]);
        assert!(scene.view_query_delta(&DatasetId::from("nope")).is_none());
    }

    #[test]
    fn continuous_only_move_yields_empty_delta() {
        // One large centered image: a sub-pixel pan changes continuous geometry
        // but not visibility or LOD, so the delta carries nothing.
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "ds1",
            1,
            [1, 1, 1, 2048, 2048],
            [1, 1, 1, 256, 256],
            4,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds = DatasetId::from("ds1");

        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Full(_)
        ));
        set_center(&mut scene, 0.25, 0.0);
        match scene.view_query_delta(&ds).unwrap() {
            ViewQueryDelta::Delta {
                entered,
                left,
                changed,
                ..
            } => {
                assert!(entered.is_empty(), "entered: {entered:?}");
                assert!(left.is_empty(), "left: {left:?}");
                assert!(changed.is_empty(), "changed: {changed:?}");
            }
            ViewQueryDelta::Full(_) => panic!("expected a delta for a continuous-only move"),
        }
    }

    #[test]
    fn visibility_flip_appears_in_changed() {
        let mut scene = spread_collection();
        let ds = DatasetId::from("coll");
        // Seed at origin: m0 visible, the far members are not.
        set_center(&mut scene, 128.0, 128.0);
        let _ = scene.view_query_delta(&ds).unwrap();

        // Pan to m2's neighbourhood. m0 leaves the screen (visible flip), m2
        // enters it (visible flip). Both surface as `changed` — never as
        // entered/left, since membership is unchanged.
        set_center(&mut scene, 1328.0, 128.0);
        match scene.view_query_delta(&ds).unwrap() {
            ViewQueryDelta::Delta {
                entered,
                left,
                changed,
                ..
            } => {
                assert!(entered.is_empty());
                assert!(left.is_empty());
                let ids: Vec<_> = changed.iter().map(|e| e.entity_id.0.as_str()).collect();
                assert!(ids.contains(&"m0"), "m0 should flip: {ids:?}");
                assert!(ids.contains(&"m2"), "m2 should flip: {ids:?}");
            }
            ViewQueryDelta::Full(_) => panic!("camera-only move must not resync"),
        }
    }

    #[test]
    fn camera_mode_switch_forces_full() {
        let mut scene = spread_collection();
        let ds = DatasetId::from("coll");
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Full(_)
        ));
        // A camera-only 2D move stays a delta.
        set_center(&mut scene, 600.0, 0.0);
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Delta { .. }
        ));
        // Switching geometry family resyncs.
        scene.set_mode_3d();
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Full(_)
        ));
        // And settles back into deltas within the new family.
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Delta { .. }
        ));
    }

    #[test]
    fn structural_change_forces_full() {
        let mut scene = spread_collection();
        let ds = DatasetId::from("coll");
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Full(_)
        ));
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Delta { .. }
        ));
        // Opening another dataset moves the structural (content/layout) epochs,
        // so the next query resyncs.
        let reg = test_helpers::make_dataset_opened("other", "other", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Full(_)
        ));
    }

    #[test]
    fn multi_dataset_cursors_are_independent() {
        let mut scene = Scene::new([512, 512]);
        for id in ["a", "b"] {
            let reg = test_helpers::make_dataset_opened_with_shape(
                id,
                id,
                1,
                [1, 1, 1, 512, 512],
                [1, 1, 1, 256, 256],
                3,
            );
            scene.apply(DocumentCommand::DatasetOpened(reg).into());
        }
        let a = DatasetId::from("a");
        let b = DatasetId::from("b");

        // Seed only dataset `a`. Dataset `b` has never been queried.
        assert!(matches!(
            scene.view_query_delta(&a).unwrap(),
            ViewQueryDelta::Full(_)
        ));
        // `a`'s next query is a delta; `b`'s first query is still a full — the
        // cursors are keyed per dataset.
        assert!(matches!(
            scene.view_query_delta(&a).unwrap(),
            ViewQueryDelta::Delta { .. }
        ));
        assert!(matches!(
            scene.view_query_delta(&b).unwrap(),
            ViewQueryDelta::Full(_)
        ));
    }

    #[test]
    fn delta_replay_matches_full_over_camera_sequence() {
        let mut scene = spread_collection();
        let ds = DatasetId::from("coll");

        // A camera walk across the row plus zoom changes, which flip both
        // visibility and ideal LOD for members as they pass through the view.
        let moves: [(f64, f64, f64); 8] = [
            (0.0, 0.0, 1.0),
            (128.0, 128.0, 1.0),
            (600.0, 0.0, 1.0),
            (600.0, 0.0, 4.0),
            (1200.0, 0.0, 4.0),
            (1800.0, 0.0, 0.5),
            (900.0, 0.0, 2.0),
            (0.0, 0.0, 1.0),
        ];

        let mut reconstructed: QuantizedMap = HashMap::new();
        let mut saw_nonempty_delta = false;

        for (x, y, zoom) in moves {
            if let Camera::Slice(s) = &mut scene.camera {
                s.set_center(x, y);
                s.set_zoom(zoom);
            }

            // Expected state from a full query at this camera.
            let expected = map_from_full(&scene.view_query(&ds).unwrap());

            // Same camera, incremental form.
            let delta = scene.view_query_delta(&ds).unwrap();
            if let ViewQueryDelta::Delta {
                entered,
                left,
                changed,
                ..
            } = &delta
                && (!entered.is_empty() || !left.is_empty() || !changed.is_empty())
            {
                saw_nonempty_delta = true;
            }
            replay(&mut reconstructed, &delta);

            assert_eq!(
                reconstructed, expected,
                "reconstruction diverged from full query at ({x}, {y}, {zoom})"
            );
        }

        assert!(
            saw_nonempty_delta,
            "the sequence never exercised a non-trivial delta"
        );
    }

    #[test]
    fn delta_replay_matches_full_across_structural_and_mode_changes() {
        let mut scene = spread_collection();
        let ds = DatasetId::from("coll");
        let mut reconstructed: QuantizedMap = HashMap::new();

        let check = |scene: &mut Scene, reconstructed: &mut QuantizedMap| {
            let expected = map_from_full(&scene.view_query(&ds).unwrap());
            let delta = scene.view_query_delta(&ds).unwrap();
            replay(reconstructed, &delta);
            assert_eq!(*reconstructed, expected);
        };

        check(&mut scene, &mut reconstructed);
        set_center(&mut scene, 600.0, 0.0);
        check(&mut scene, &mut reconstructed);

        // Structural change: open another dataset (resync to Full).
        let reg = test_helpers::make_dataset_opened("other", "other", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        check(&mut scene, &mut reconstructed);

        // Camera-family change (resync to Full), then a move within it.
        scene.set_mode_3d();
        check(&mut scene, &mut reconstructed);
        check(&mut scene, &mut reconstructed);
    }

    #[test]
    fn delta_replay_matches_full_for_multi_image_owner() {
        // One entity owning two images of very different pyramid depth at the
        // same position. `entity_id` collapses them; only `image_id` keeps them
        // distinct, so their independent `ideal_target_lod` must survive replay.
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_multi_image_owner_opened(
            "dup",
            "dup",
            &[("dup-a", 8, 8192), ("dup-b", 2, 512)],
            [0.0, 0.0],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds = DatasetId::from("dup");

        // Two distinct records share one entity id.
        let full = scene.view_query(&ds).unwrap();
        assert_eq!(full.visible_entities.len(), 2);
        assert!(full.visible_entities.iter().all(|e| e.entity_id.0 == "dup"));

        let a = ImageId("dup-a".into());
        let b = ImageId("dup-b".into());

        // A zoom sweep centered where both images overlap, so both stay present
        // and their LODs move independently.
        let zooms = [0.02_f64, 0.1, 0.5, 1.0, 4.0, 0.05];
        let mut reconstructed: QuantizedMap = HashMap::new();
        let mut saw_distinct_lod = false;

        for zoom in zooms {
            if let Camera::Slice(s) = &mut scene.camera {
                s.set_center(128.0, 128.0);
                s.set_zoom(zoom);
            }

            let expected = map_from_full(&scene.view_query(&ds).unwrap());
            // Both records survive as distinct keys in the full map.
            assert!(expected.contains_key(&a) && expected.contains_key(&b));
            if expected[&a].1 != expected[&b].1 {
                saw_distinct_lod = true;
            }

            let delta = scene.view_query_delta(&ds).unwrap();
            replay(&mut reconstructed, &delta);

            assert_eq!(
                reconstructed, expected,
                "multi-image-owner reconstruction diverged at zoom {zoom}"
            );
        }

        assert!(
            saw_distinct_lod,
            "the two images never diverged in LOD; test fixture is not exercising the bug"
        );
    }
}
