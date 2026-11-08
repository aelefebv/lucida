use std::ops::Range;

use serde::{Deserialize, Serialize};

/// Selected indices for non-displayed dimensions. Which channels show is per
/// layer, in [`crate::scene::DatasetDisplaySettings::solo`] and each channel's
/// `visible` flag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewState {
    /// Z slab range. A single slice is a range of length 1 (e.g. 42..43).
    pub z_range: Range<u32>,
    pub t: u32,
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

    pub fn set_slice(&mut self, axis: &str, index: u32) -> Result<(), String> {
        match axis {
            "z" => self.set_z(index),
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
