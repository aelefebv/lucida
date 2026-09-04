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
/// in `target_level`. Keying on `image_id` keeps those records distinct.
///
/// # Reconstruction
///
/// Applying deltas in order rebuilds the same set a fresh [`ViewQueryResult`]
/// would report. Starting from a `Full`, for each subsequent `Delta`: drop the
/// records whose `image_id` is in `left`, then insert or overwrite every record
/// in `entered` and `changed` keyed by its `image_id`. The resulting map of
/// `image_id → { visible, target_level, kind }` equals the one a full query
/// would produce at that step.
///
/// # Quantized fields
///
/// Exactly four aspects of a record trigger a delta entry, all keyed by
/// [`EntityQueryResult::image_id`]: membership (whether the record is present at
/// all), [`EntityQueryResult::visible`], [`EntityQueryResult::target_level`],
/// and [`EntityQueryResult::kind`]. This quantized set —
/// `{ membership, visible, target_level, kind }` — is the whole of what a
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
/// that `{ membership, visible, target_level, kind }` is unchanged for that
/// record; it makes no claim about the record's continuous fields.
///
/// A consumer MUST NOT read "this record is absent from the delta" as "nothing I
/// derive from this record changed" when what it derives comes from a continuous
/// field. A continuous field can cross a discrete boundary while the quantized
/// set holds steady: over a zoom, [`EntityQueryResult::projected_diagonal_px`]
/// can pass a threshold that flips a downstream discrete choice — a
/// coarse-vs-detailed presentation mode selected by projected size, say — even
/// though membership, visibility, target level, and kind are all identical and
/// the delta is thus empty. A consumer that turns a continuous field into such a
/// discrete decision must recompute that decision itself for the records it
/// cares about; the delta does not report continuous-boundary crossings and
/// cannot stand in for that recomputation.
///
/// # Epochs cover what the quantized set does not
///
/// The [`SceneEpochs`] carried on both variants reflect structural and selection
/// changes — a change of the active selection along a dimension axis or of a
/// per-channel display setting (see [`SceneEpochs::selection`]), or of entity
/// membership, layout, or the asset catalog — that the quantized set does not
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
    /// The target level. The dataset's level pin when it has one, else the
    /// level the screen calls for from [`crate::target_level::target_level`],
    /// the coarsest level that still places at least one sample under every
    /// device pixel, held across a level boundary by hysteresis. Either is
    /// clamped to the image's source levels, so a visible record never names
    /// a generated coarse level. Off-screen records report the pyramid's last
    /// level, generated or not.
    pub target_level: u32,
    /// True when `target_level` is the dataset's level pin rather than the
    /// screen's choice. Part of the quantized state a delta tracks, so a pin
    /// set to the level the screen already wanted still reaches a consumer.
    /// False for off-screen records.
    #[serde(default)]
    pub level_pinned: bool,
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
                    (e.visible, e.target_level, e.kind.clone()),
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
                        (e.visible, e.target_level, e.kind.clone()),
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
        // visibility and target level for members as they pass through the view.
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
        // distinct, so their independent `target_level` must survive replay.
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

    // ---- target level ----

    use crate::target_level::HYSTERESIS_OCTAVES;

    /// A 4096² image with `levels` regular levels, viewed from its middle so it
    /// stays on screen at every zoom.
    fn slice_scene(viewport: [u32; 2], levels: u32) -> (Scene, DatasetId) {
        let mut scene = Scene::new(viewport);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "img",
            "img",
            1,
            [1, 1, 1, 4096, 4096],
            [1, 1, 1, 256, 256],
            levels,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        set_center(&mut scene, 2048.0, 2048.0);
        (scene, DatasetId::from("img"))
    }

    fn set_zoom(scene: &mut Scene, zoom: f64) {
        if let Camera::Slice(s) = &mut scene.camera {
            s.set_zoom(zoom);
        }
    }

    fn full_target(scene: &Scene, ds: &DatasetId) -> u32 {
        let result = scene.view_query(ds).unwrap();
        assert_eq!(result.visible_entities.len(), 1);
        assert!(
            result.visible_entities[0].visible,
            "the image must be on screen"
        );
        result.visible_entities[0].target_level
    }

    /// The level a delta reported for the single image, or `None` when the
    /// delta was empty. Panics on a `Full`, because these tests expect the
    /// cursor to hold across camera moves.
    fn delta_level(scene: &mut Scene, ds: &DatasetId) -> Option<u32> {
        match scene.view_query_delta(ds).unwrap() {
            ViewQueryDelta::Delta {
                entered,
                left,
                changed,
                ..
            } => {
                assert!(entered.is_empty() && left.is_empty());
                changed.first().map(|e| e.target_level)
            }
            ViewQueryDelta::Full(_) => panic!("a camera move must not force a full resync"),
        }
    }

    #[test]
    fn slice_target_is_the_coarsest_level_that_still_fills_every_device_pixel() {
        let (mut scene, ds) = slice_scene([512, 512], 4);
        let cases = [
            (4.0, 0),
            (1.0, 0),
            (0.51, 0),
            (0.5, 1),
            (0.26, 1),
            (0.25, 2),
            (0.13, 2),
            (0.125, 3),
            (0.001, 3),
        ];
        for (zoom, level) in cases {
            set_zoom(&mut scene, zoom);
            assert_eq!(full_target(&scene, &ds), level, "zoom {zoom}");
        }
    }

    #[test]
    fn slice_target_uses_the_in_plane_axes() {
        // Level 1 quarters z but only halves y and x. Judged along all three
        // axes it would count as four times coarser and level 0 would stay the
        // target at this zoom.
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_level_shapes(
            "aniso",
            &[[64, 2048, 2048], [16, 1024, 1024], [4, 512, 512]],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds = DatasetId::from("aniso");
        set_center(&mut scene, 1024.0, 1024.0);
        set_zoom(&mut scene, 0.5);
        assert_eq!(full_target(&scene, &ds), 1);
    }

    #[test]
    fn level_change_arrives_as_a_changed_record_not_a_full_resync() {
        let (mut scene, ds) = slice_scene([512, 512], 4);
        set_zoom(&mut scene, 1.0);
        assert!(matches!(
            scene.view_query_delta(&ds).unwrap(),
            ViewQueryDelta::Full(_)
        ));
        set_zoom(&mut scene, 0.3);
        assert_eq!(delta_level(&mut scene, &ds), Some(1));
    }

    #[test]
    fn a_slow_zoom_holds_the_level_until_the_boundary_is_crossed_by_the_band() {
        let (mut scene, ds) = slice_scene([512, 512], 4);
        let band = 2f64.powf(HYSTERESIS_OCTAVES);
        // Level 1 becomes the raw target at half a pixel per level-0 sample.
        // Where the delta holds, a full query must report the held level too.
        let boundary = 0.5;
        set_zoom(&mut scene, 1.0);
        let _ = scene.view_query_delta(&ds).unwrap();

        set_zoom(&mut scene, boundary / band * 1.02);
        assert_eq!(delta_level(&mut scene, &ds), None);
        assert_eq!(full_target(&scene, &ds), 0);

        set_zoom(&mut scene, boundary / band * 0.98);
        assert_eq!(delta_level(&mut scene, &ds), Some(1));

        set_zoom(&mut scene, boundary * band * 0.98);
        assert_eq!(delta_level(&mut scene, &ds), None);
        assert_eq!(full_target(&scene, &ds), 1);

        set_zoom(&mut scene, boundary * band * 1.02);
        assert_eq!(delta_level(&mut scene, &ds), Some(0));
    }

    #[test]
    fn a_full_query_with_no_delta_history_applies_the_rule_without_hysteresis() {
        // 0.45 sits inside the band; with level 0 as history it would hold 0.
        let (mut scene, ds) = slice_scene([512, 512], 4);
        set_zoom(&mut scene, 0.45);
        assert_eq!(full_target(&scene, &ds), 1);
    }

    #[test]
    fn device_pixel_ratio_2_selects_one_level_finer_for_the_same_slice_framing() {
        // Twice the pixel density doubles both the backing viewport and the
        // zoom; the world extent on screen is unchanged.
        let (mut dpr1, ds) = slice_scene([400, 300], 4);
        let (mut dpr2, _) = slice_scene([800, 600], 4);
        for (css_zoom, dpr1_level) in [(0.5, 1), (0.25, 2), (0.12, 3)] {
            set_zoom(&mut dpr1, css_zoom);
            set_zoom(&mut dpr2, css_zoom * 2.0);
            let (Camera::Slice(a), Camera::Slice(b)) = (&dpr1.camera, &dpr2.camera) else {
                unreachable!()
            };
            for (lo, hi) in a.world_bounds().iter().zip(b.world_bounds()) {
                assert!((lo - hi).abs() < 1e-9, "same framing: {lo} vs {hi}");
            }
            assert_eq!(full_target(&dpr1, &ds), dpr1_level, "zoom {css_zoom}");
            assert_eq!(full_target(&dpr2, &ds), dpr1_level - 1, "zoom {css_zoom}");
        }
    }

    /// A 256 × 1024 × 1024 volume with five regular levels, framed by the
    /// arcball camera at `viewport`. Returns the fitted orbit distance.
    fn volume_scene(viewport: [u32; 2]) -> (Scene, DatasetId, f64) {
        let mut scene = Scene::new(viewport);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "vol",
            "vol",
            1,
            [1, 1, 256, 1024, 1024],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        assert!(scene.fit_camera_to_dataset("vol"));
        let Camera::Arcball(a) = &scene.camera else {
            unreachable!()
        };
        let fitted = a.distance;
        (scene, DatasetId::from("vol"), fitted)
    }

    fn set_distance(scene: &mut Scene, distance: f64) {
        if let Camera::Arcball(a) = &mut scene.camera {
            a.distance = distance;
        }
    }

    #[test]
    fn volume_target_follows_the_distance_to_the_hit_and_clamps_at_both_ends() {
        let (mut scene, ds, fitted) = volume_scene([800, 600]);
        let mut levels = Vec::new();
        for factor in [0.05, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 64.0] {
            set_distance(&mut scene, fitted * factor);
            levels.push(full_target(&scene, &ds));
        }
        assert_eq!(levels[0], 0, "close up the finest level is the target");
        assert_eq!(*levels.last().unwrap(), 4, "far away the coarsest level is");
        assert!(levels.windows(2).all(|w| w[0] <= w[1]), "{levels:?}");
        assert!(
            levels.contains(&2),
            "the walk must pass through the middle: {levels:?}"
        );
    }

    #[test]
    fn device_pixel_ratio_2_selects_one_level_finer_for_the_same_volume_framing() {
        // Only a mid-pyramid target can move exactly one level; the ends clamp.
        let (mut dpr1, ds, fitted) = volume_scene([800, 600]);
        let (mut dpr2, _, fitted2) = volume_scene([1600, 1200]);
        assert!(
            (fitted - fitted2).abs() < 1e-9,
            "the fit depends on aspect, not size"
        );
        let mut compared = 0;
        for factor in [0.25, 0.5, 1.0, 2.0, 4.0, 8.0] {
            set_distance(&mut dpr1, fitted * factor);
            set_distance(&mut dpr2, fitted * factor);
            let (a, b) = (full_target(&dpr1, &ds), full_target(&dpr2, &ds));
            assert!(b <= a, "factor {factor}: dpr2 {b} coarser than dpr1 {a}");
            if (1..=3).contains(&a) {
                assert_eq!(b, a - 1, "factor {factor}");
                compared += 1;
            }
        }
        assert!(compared > 0, "no distance landed mid-pyramid");
    }
}
