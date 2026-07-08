use serde::{Deserialize, Serialize};

use crate::id::{EntityId, ImageId};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageSpec {
    pub image_id: ImageId,
    pub owner: EntityId,
    pub multiscale: MultiscaleInfo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MultiscaleInfo {
    pub axes: Vec<Axis>,
    pub levels: Vec<LevelGeometry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coarse_level_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub generated_levels: Vec<GeneratedLevelInfo>,
    pub data_type: DataType,
    /// Non-canonical axes (anything outside `{t,c,z,y,x}`) that were dropped
    /// from the canonical 5D shape and pinned to a fixed index when reading
    /// chunks. Empty for normal datasets.
    #[serde(default)]
    pub pinned_axes: Vec<PinnedAxis>,
    /// Per-channel display metadata parsed from the OME `omero.channels` block
    /// (label and optional color), in channel order.
    ///
    /// This is immutable manifest data — channel *names* live here, not in the
    /// mutable scene state. Empty when the source has no `omero` block (e.g.
    /// raw OME-Zarr without rendering metadata), so consumers must fall back to
    /// a positional `Ch N` label.
    ///
    /// Positional and best-effort: entries are kept in the order omero lists
    /// them and are *not* forced to match the C-axis length. A producer whose
    /// omero list is shorter, longer, or partly blank still yields a valid
    /// manifest; consumers index by channel and fall back per-index when an
    /// entry is missing. `#[serde(default)]` keeps older snapshots (written
    /// before this field existed) deserializable, and `skip_serializing_if`
    /// keeps channel-less datasets from emitting it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channel_infos: Vec<ChannelInfo>,
}

/// Display metadata for a single channel, sourced from the OME `omero.channels`
/// block. Carries only a human label and an optional color hint, leaving
/// contrast/window and colormap to the mutable scene state
/// (`ChannelSettings`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ChannelInfo {
    /// Non-empty channel label (e.g. `"Channel 0"`). The parse layer drops blank /
    /// whitespace-only labels, so any value present here is meaningful.
    pub label: String,
    /// Optional color hint, as the raw omero hex string without a leading `#`
    /// (e.g. `"00FF00"`). Carried through verbatim for future use; it is not
    /// applied to colormaps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl MultiscaleInfo {
    pub fn is_generated_level(&self, level_index: u32) -> bool {
        self.generated_levels
            .iter()
            .any(|level| level.level_index == level_index)
    }

    pub fn selectable_detail_levels(&self) -> Vec<u32> {
        self.levels
            .iter()
            .map(|level| level.level_index)
            .filter(|level_index| !self.is_generated_level(*level_index))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct GeneratedLevelInfo {
    pub level_index: u32,
    #[serde(default)]
    pub role: GeneratedLevelRole,
    #[serde(default)]
    pub provenance: GeneratedLevelProvenance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum GeneratedLevelRole {
    #[default]
    Coarse,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct GeneratedLevelProvenance {
    #[serde(default)]
    pub generator: String,
    #[serde(default)]
    pub config_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_content_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Axis {
    pub name: String,
    pub kind: AxisKind,
}

/// A non-canonical OME-Zarr axis that has been pinned to a fixed index.
///
/// Some OME-Zarr exports (notably CZI mosaics with an `m` axis) include axes
/// outside the canonical `{t,c,z,y,x}` set. Lucida pins each such axis to
/// `pinned_index` (always `0` today) and exposes the dropped metadata here so
/// future UI work can surface it without revisiting the parse layer.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PinnedAxis {
    pub name: String,
    pub size: u64,
    pub pinned_index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AxisKind {
    Time,
    Channel,
    Space,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LevelGeometry {
    pub level_index: u32,
    pub shape: [u64; 5],
    pub chunk_shape: [u64; 5],
    pub grid_shape: [u64; 5],
    pub scale: [f64; 5],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DataType {
    Uint8,
    Uint16,
    Uint32,
    Float32,
    Float64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_geometry_grid_exact_division() {
        let level = LevelGeometry {
            level_index: 0,
            shape: [1, 1, 20, 512, 512],
            chunk_shape: [1, 1, 1, 128, 128],
            grid_shape: [1, 1, 20, 4, 4],
            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
        };
        assert_eq!(level.grid_shape, [1, 1, 20, 4, 4]);
    }

    #[test]
    fn level_geometry_grid_ceiling_division() {
        // 513 / 128 = 4.0078... -> ceil = 5
        let level = LevelGeometry {
            level_index: 0,
            shape: [1, 1, 20, 513, 513],
            chunk_shape: [1, 1, 1, 128, 128],
            grid_shape: [1, 1, 20, 5, 5],
            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
        };
        assert_eq!(level.grid_shape, [1, 1, 20, 5, 5]);
    }

    #[test]
    fn level_geometry_grid_single_voxel() {
        let level = LevelGeometry {
            level_index: 0,
            shape: [1, 1, 1, 1, 1],
            chunk_shape: [1, 1, 1, 1, 1],
            grid_shape: [1, 1, 1, 1, 1],
            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
        };
        assert_eq!(level.grid_shape, [1, 1, 1, 1, 1]);
    }

    #[test]
    fn multiscale_info_deserializes_without_pinned_axes() {
        // Backward-compat: snapshots from older servers omit `pinned_axes`.
        // `#[serde(default)]` should yield an empty Vec rather than failing.
        let json = serde_json::json!({
            "axes": [
                {"name": "z", "kind": "Space"},
                {"name": "y", "kind": "Space"},
                {"name": "x", "kind": "Space"}
            ],
            "levels": [{
                "level_index": 0,
                "shape": [1, 1, 10, 256, 256],
                "chunk_shape": [1, 1, 1, 128, 128],
                "grid_shape": [1, 1, 10, 2, 2],
                "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
            }],
            "data_type": "Uint16"
        });
        let info: MultiscaleInfo = serde_json::from_value(json).unwrap();
        assert_eq!(info.axes.len(), 3);
        assert_eq!(info.coarse_level_index, None);
        assert!(info.generated_levels.is_empty());
        assert!(info.pinned_axes.is_empty());
        // Old snapshots predate `channel_infos`; serde default yields empty.
        assert!(info.channel_infos.is_empty());
    }

    fn minimal_multiscale(channel_infos: Vec<ChannelInfo>) -> MultiscaleInfo {
        MultiscaleInfo {
            axes: vec![Axis {
                name: "x".to_string(),
                kind: AxisKind::Space,
            }],
            levels: vec![LevelGeometry {
                level_index: 0,
                shape: [1, 1, 1, 1, 1],
                chunk_shape: [1, 1, 1, 1, 1],
                grid_shape: [1, 1, 1, 1, 1],
                scale: [1.0, 1.0, 1.0, 1.0, 1.0],
            }],
            coarse_level_index: None,
            generated_levels: Vec::new(),
            data_type: DataType::Uint16,
            pinned_axes: Vec::new(),
            channel_infos,
        }
    }

    #[test]
    fn channel_infos_round_trip_with_and_without_color() {
        let info = minimal_multiscale(vec![
            ChannelInfo {
                label: "Channel 0".to_string(),
                color: Some("0000FF".to_string()),
            },
            ChannelInfo {
                label: "Channel 1".to_string(),
                color: None,
            },
        ]);
        let json = serde_json::to_value(&info).unwrap();
        let back: MultiscaleInfo = serde_json::from_value(json).unwrap();
        assert_eq!(back.channel_infos.len(), 2);
        assert_eq!(back.channel_infos[0].label, "Channel 0");
        assert_eq!(back.channel_infos[0].color.as_deref(), Some("0000FF"));
        assert_eq!(back.channel_infos[1].label, "Channel 1");
        assert_eq!(back.channel_infos[1].color, None);
    }

    #[test]
    fn empty_channel_infos_is_skipped_on_the_wire() {
        // skip_serializing_if keeps channel-less datasets from emitting the
        // field at all, so the wire stays identical to pre-slice output.
        let info = minimal_multiscale(Vec::new());
        let json = serde_json::to_value(&info).unwrap();
        assert!(
            json.get("channel_infos").is_none(),
            "empty channel_infos must not be serialized, got: {json}",
        );
    }

    #[test]
    fn channel_info_color_omitted_when_none() {
        let info = ChannelInfo {
            label: "Channel 9".to_string(),
            color: None,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(
            json.get("label").and_then(|v| v.as_str()),
            Some("Channel 9")
        );
        assert!(
            json.get("color").is_none(),
            "color: None must be omitted, got: {json}",
        );
    }

    #[test]
    fn multiscale_info_carries_coarse_and_generated_metadata() {
        let json = serde_json::json!({
            "axes": [
                {"name": "z", "kind": "Space"},
                {"name": "y", "kind": "Space"},
                {"name": "x", "kind": "Space"}
            ],
            "levels": [
                {
                    "level_index": 0,
                    "shape": [1, 1, 10, 256, 256],
                    "chunk_shape": [1, 1, 1, 128, 128],
                    "grid_shape": [1, 1, 10, 2, 2],
                    "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                },
                {
                    "level_index": 1,
                    "shape": [1, 1, 1, 64, 64],
                    "chunk_shape": [1, 1, 1, 64, 64],
                    "grid_shape": [1, 1, 1, 1, 1],
                    "scale": [1.0, 1.0, 1.0, 4.0, 4.0]
                }
            ],
            "coarse_level_index": 1,
            "generated_levels": [{
                "level_index": 1,
                "role": "coarse",
                "provenance": {
                    "generator": "coarse-v1",
                    "config_id": "max-axis-1024"
                }
            }],
            "data_type": "Uint16"
        });
        let info: MultiscaleInfo = serde_json::from_value(json).unwrap();
        assert_eq!(info.coarse_level_index, Some(1));
        assert!(info.is_generated_level(1));
        assert_eq!(info.selectable_detail_levels(), vec![0]);
        assert_eq!(info.generated_levels[0].provenance.generator, "coarse-v1");
    }
}
