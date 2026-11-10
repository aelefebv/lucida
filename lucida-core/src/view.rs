use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::placement::Affine;
use crate::slice_plane::SlicePlane;
use lucida_content::SpatialAxis;

/// Selected indices for non-displayed dimensions. Which channels show is per
/// layer, in [`crate::scene::DatasetDisplaySettings::solo`] and each channel's
/// `visible` flag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewState {
    /// Z slab range. A single slice is a range of length 1 (e.g. 42..43).
    pub z_range: Range<u32>,
    pub t: u32,
    /// The place in the scene frame an XZ view cuts along Y, and the one a YZ
    /// view cuts along X, in the frame's units. Absent until a view of that
    /// plane first opens, which picks the middle of the data; absent reads
    /// as 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<u32>,
    /// The scene-wide channel of a view recorded before solo was per layer.
    /// Decoding only, see [`Self::legacy_channels`]; nothing writes it now.
    #[serde(rename = "c", default, skip_serializing_if = "Option::is_none")]
    pub legacy_c: Option<u32>,
    /// The scene-wide composite flag of a view recorded before solo was per
    /// layer. Decoding only, see [`Self::legacy_channels`].
    #[serde(
        rename = "multi_channel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub legacy_multi_channel: Option<bool>,
}

/// The scene-wide channel mode of a view recorded before solo was per layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyChannels {
    /// Every layer showed its visible channels.
    Composite,
    /// Every layer with this channel showed it alone.
    Solo(u32),
}

impl ViewState {
    pub fn new() -> Self {
        Self {
            z_range: 0..1,
            t: 0,
            y: None,
            x: None,
            legacy_c: None,
            legacy_multi_channel: None,
        }
    }

    /// Set a single z slice (slab of thickness 1).
    pub fn set_z(&mut self, index: u32) {
        self.z_range = index..index + 1;
    }

    /// Set a z slab range.
    pub fn set_z_range(&mut self, range: Range<u32>) {
        self.z_range = range;
    }

    /// The plane a slice view of `plane` cuts, before any layer clamps it.
    pub fn cut(&self, plane: SlicePlane) -> Range<u32> {
        let single = |index: Option<u32>| {
            let index = index.unwrap_or(0);
            index..index.saturating_add(1)
        };
        match plane.cut() {
            SpatialAxis::Z => self.z_range.clone(),
            SpatialAxis::Y => single(self.y),
            SpatialAxis::X => single(self.x),
        }
    }

    /// Move the X and Y axis positions, places in one scene frame, by `map`
    /// into another, keeping the plane each names.
    pub fn map_cut_positions(&mut self, map: &Affine) {
        for (a, position) in [(1, &mut self.y), (0, &mut self.x)] {
            if let Some(index) = position {
                let mut at = [0.0; 3];
                at[a] = *index as f64 + 0.5;
                *index = map.apply(at)[a].floor().clamp(0.0, u32::MAX as f64) as u32;
            }
        }
    }

    pub fn set_slice(&mut self, axis: &str, index: u32) -> Result<(), String> {
        match axis {
            "z" => self.set_z(index),
            "y" => self.y = Some(index),
            "x" => self.x = Some(index),
            "t" => self.t = index,
            "c" => {
                return Err(
                    "channels are shown per layer; solo a channel on a layer instead".to_string(),
                );
            }
            _ => return Err(format!("unknown axis: {axis}")),
        }
        Ok(())
    }

    /// The channel mode of a view recorded before solo was per layer, or
    /// `None` for a current view. Such a view always carried `c`, and without
    /// `multi_channel: true` it showed `c` alone.
    pub fn legacy_channels(&self) -> Option<LegacyChannels> {
        if self.legacy_c.is_none() && self.legacy_multi_channel.is_none() {
            return None;
        }
        Some(if self.legacy_multi_channel == Some(true) {
            LegacyChannels::Composite
        } else {
            LegacyChannels::Solo(self.legacy_c.unwrap_or(0))
        })
    }

    /// [`Self::legacy_channels`], leaving a current view behind.
    pub fn take_legacy_channels(&mut self) -> Option<LegacyChannels> {
        let legacy = self.legacy_channels();
        self.legacy_c = None;
        self.legacy_multi_channel = None;
        legacy
    }
}

impl Default for ViewState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_view_starts_at_zero() {
        let v = ViewState::new();
        assert_eq!(v.z_range, 0..1);
        assert_eq!(v.t, 0);
        assert_eq!(v.legacy_channels(), None);
    }

    #[test]
    fn set_slice_updates_z_as_single_plane() {
        let mut v = ViewState::new();
        v.set_slice("z", 42).unwrap();
        assert_eq!(v.z_range, 42..43);
        assert_eq!(v.t, 0);
    }

    #[test]
    fn each_plane_cuts_at_its_own_axis_position() {
        let mut v = ViewState::new();
        v.set_z_range(4..6);
        assert_eq!(v.cut(SlicePlane::Xy), 4..6);
        assert_eq!(v.cut(SlicePlane::Xz), 0..1);
        v.set_slice("y", 9).unwrap();
        v.set_slice("x", 3).unwrap();
        assert_eq!(v.cut(SlicePlane::Xz), 9..10);
        assert_eq!(v.cut(SlicePlane::Yz), 3..4);
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(json, r#"{"z_range":{"start":4,"end":6},"t":0,"y":9,"x":3}"#);
        assert_eq!(serde_json::from_str::<ViewState>(&json).unwrap(), v);
    }

    #[test]
    fn set_z_range_for_slab() {
        let mut v = ViewState::new();
        v.set_z_range(10..20);
        assert_eq!(v.z_range, 10..20);
    }

    #[test]
    fn set_slice_rejects_unknown_axis_and_the_channel() {
        let mut v = ViewState::new();
        assert!(v.set_slice("q", 1).is_err());
        assert!(v.set_slice("c", 1).is_err());
    }

    #[test]
    fn a_current_view_serializes_no_channel_selector() {
        let json = serde_json::to_string(&ViewState::new()).unwrap();
        assert_eq!(json, r#"{"z_range":{"start":0,"end":1},"t":0}"#);
        let back: ViewState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.legacy_channels(), None);
    }

    #[test]
    fn a_legacy_view_decodes_its_scene_wide_mode() {
        let single: ViewState = serde_json::from_str(
            r#"{"z_range":{"start":0,"end":1},"t":0,"c":2,"multi_channel":false}"#,
        )
        .unwrap();
        assert_eq!(single.legacy_channels(), Some(LegacyChannels::Solo(2)));

        // Views from before the flag existed meant single-channel.
        let flagless: ViewState =
            serde_json::from_str(r#"{"z_range":{"start":0,"end":1},"t":0,"c":1}"#).unwrap();
        assert_eq!(flagless.legacy_channels(), Some(LegacyChannels::Solo(1)));

        let mut composite: ViewState = serde_json::from_str(
            r#"{"z_range":{"start":0,"end":1},"t":0,"c":1,"multi_channel":true}"#,
        )
        .unwrap();
        assert_eq!(
            composite.take_legacy_channels(),
            Some(LegacyChannels::Composite)
        );
        assert_eq!(composite, ViewState::new());
    }
}
