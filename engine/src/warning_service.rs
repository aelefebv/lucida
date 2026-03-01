use std::collections::BTreeMap;

use crate::model::{
    PerClientViewState, SharedSceneState, WarningCode, WarningEntry, WarningSeverity,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarningAggregation {
    pub shared_scene_warnings: Vec<WarningEntry>,
    pub per_client_warnings: BTreeMap<String, Vec<WarningEntry>>,
}

#[must_use]
pub fn aggregate_warnings(
    shared_scene: &SharedSceneState,
    client_views: &BTreeMap<String, PerClientViewState>,
) -> WarningAggregation {
    let mut shared_scene_warnings = Vec::new();

    if !shared_scene.layers.is_empty() && shared_scene.sources.is_empty() {
        shared_scene_warnings.push(warning(
            WarningCode::UncalibratedOverlay,
            WarningSeverity::Warning,
            "scene has overlays without any source calibration",
        ));
    }

    for source in shared_scene.sources.values() {
        if source.latest_working_generation_seq == 0 {
            shared_scene_warnings.push(warning(
                WarningCode::GenerationBuildIncomplete,
                WarningSeverity::Warning,
                &format!("source `{}` has no working generation yet", source.name),
            ));
        }
    }

    for layer in shared_scene.layers.values() {
        if layer.metadata_rev == 0 {
            shared_scene_warnings.push(warning(
                WarningCode::IncompleteLabelIndex,
                WarningSeverity::Info,
                &format!("layer `{}` metadata index is incomplete", layer.name),
            ));
        }

        if layer.write_rev > layer.layer_rev {
            shared_scene_warnings.push(warning(
                WarningCode::StaleDerivedLayer,
                WarningSeverity::Warning,
                &format!(
                    "layer `{}` has derived writes newer than its definition",
                    layer.name
                ),
            ));
        }

        if layer.write_rev > 0 && layer.metadata_rev < layer.write_rev {
            shared_scene_warnings.push(warning(
                WarningCode::ComputedAtLod,
                WarningSeverity::Warning,
                &format!(
                    "layer `{}` has writes computed at non-reference detail",
                    layer.name
                ),
            ));
        }
    }

    let per_client_warnings = client_views
        .iter()
        .map(|(client_id, view_state)| {
            let mut warnings = Vec::new();
            if let Some(active_layer_id) = view_state.active_layer_id.as_deref()
                && !shared_scene.layers.contains_key(active_layer_id)
            {
                warnings.push(warning(
                    WarningCode::MissingActiveLayer,
                    WarningSeverity::Warning,
                    &format!("active layer `{active_layer_id}` is missing from shared scene"),
                ));
            }

            (client_id.clone(), warnings)
        })
        .collect::<BTreeMap<_, _>>();

    WarningAggregation {
        shared_scene_warnings,
        per_client_warnings,
    }
}

fn warning(code: WarningCode, severity: WarningSeverity, message: &str) -> WarningEntry {
    WarningEntry {
        warning_code: code,
        severity,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::model::{
        AxisName, AxisShape, AxisSpacing, CalibrationMetadata, CalibrationStatus, ChannelTable,
        ClientViewMode, LayerState, PerClientViewState, SceneMode, SharedSceneState, SourceKind,
        SourceMetadata, SourceRecord, SourceStatus, SourceWatchMode, StabilityWindow, WarningCode,
    };

    use super::aggregate_warnings;

    #[test]
    fn aggregates_expected_shared_and_client_warning_sets() {
        let shared_scene = SharedSceneState {
            scene_rev: 1,
            scene_id: "scn_00000001".to_owned(),
            name: "warning-scene".to_owned(),
            mode: SceneMode::Live,
            sources: BTreeMap::from([(
                "src_00000001".to_owned(),
                SourceRecord {
                    source_id: "src_00000001".to_owned(),
                    name: "source-a".to_owned(),
                    uri: "/tmp/source-a.tiff".to_owned(),
                    source_kind: SourceKind::Tiff,
                    watch_enabled: true,
                    watch_mode: SourceWatchMode::WatcherOnly,
                    status: SourceStatus::Watching,
                    latest_working_generation_id: None,
                    latest_working_generation_seq: 0,
                    stability_window: StabilityWindow {
                        debounce_seconds: 2,
                        single_file_verify_ms: 200,
                    },
                    source_metadata: SourceMetadata {
                        original_axis_order: vec![AxisName::Y, AxisName::X],
                        canonical_axis_order: vec![
                            AxisName::T,
                            AxisName::C,
                            AxisName::Z,
                            AxisName::Y,
                            AxisName::X,
                        ],
                        shape: AxisShape {
                            t: 1,
                            c: 1,
                            z: 1,
                            y: 32,
                            x: 32,
                            extra_axes: BTreeMap::new(),
                        },
                        dtype: "uint16".to_owned(),
                        calibration: CalibrationMetadata {
                            status: CalibrationStatus::Uncalibrated,
                            spacing: AxisSpacing {
                                x: None,
                                y: None,
                                z: None,
                            },
                            units: None,
                        },
                        channel_table: ChannelTable {
                            channel_count: 1,
                            channels: vec![],
                        },
                    },
                    generations: BTreeMap::new(),
                    warnings: Vec::new(),
                },
            )]),
            datasets: BTreeMap::new(),
            layers: BTreeMap::from([(
                "lay_00000001".to_owned(),
                LayerState {
                    layer_id: "lay_00000001".to_owned(),
                    name: "layer-a".to_owned(),
                    layer_rev: 1,
                    metadata_rev: 0,
                    write_rev: 2,
                },
            )]),
            layer_order: vec!["lay_00000001".to_owned()],
            targets: BTreeMap::new(),
            warnings: Vec::new(),
        };

        let client_views = BTreeMap::from([(
            "cli_00000001".to_owned(),
            PerClientViewState {
                client_id: "cli_00000001".to_owned(),
                view_rev: 1,
                view_mode: ClientViewMode::TwoD,
                active_layer_id: Some("lay_missing".to_owned()),
                warnings: Vec::new(),
            },
        )]);

        let aggregation = aggregate_warnings(&shared_scene, &client_views);

        assert!(
            aggregation
                .shared_scene_warnings
                .iter()
                .any(|warning| warning.warning_code == WarningCode::GenerationBuildIncomplete)
        );
        assert!(
            aggregation
                .shared_scene_warnings
                .iter()
                .any(|warning| warning.warning_code == WarningCode::IncompleteLabelIndex)
        );
        assert!(
            aggregation
                .shared_scene_warnings
                .iter()
                .any(|warning| warning.warning_code == WarningCode::ComputedAtLod)
        );
        assert!(
            aggregation
                .shared_scene_warnings
                .iter()
                .any(|warning| warning.warning_code == WarningCode::StaleDerivedLayer)
        );
        assert!(
            aggregation
                .per_client_warnings
                .get("cli_00000001")
                .expect("client warning set should exist")
                .iter()
                .any(|warning| warning.warning_code == WarningCode::MissingActiveLayer)
        );
    }
}
