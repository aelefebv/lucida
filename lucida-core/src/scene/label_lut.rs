//! Indexed-colour lookup table for segmentation **label** overlays.
//!
//! A label image stores an integer id per voxel; the renderer never decodes
//! colours itself. Instead the core bakes a flat `rgba8` lookup table here and
//! the web uploads it verbatim as a `256×256` texture (the flat 65536-entry
//! table laid out row-major), reading entry `v` at `(v & 255, v >> 8)` for
//! `v < 65536`; ids `>= 65536` — which the table can't hold — get the same
//! deterministic glasbey colour recomputed in-shader, so no id is ever
//! truncated. Keeping colour choice in one deterministic Rust function means
//! every surface (2D slice, 3D volume, minimap, tests) tints a given label id
//! identically, and the web stays a thin texture uploader (plus the in-shader
//! glasbey mirror for the ids past the table).
//!
//! Two colour sources compose, in priority order:
//!
//! 1. An explicit `image-label.colors` entry whose `label-value == i` (the
//!    producer's own palette) wins.
//! 2. Otherwise a deterministic "glasbey-like" hash colour — a golden-ratio hue
//!    walk (see [`glasbey_rgba`]) — so adjacent ids stay visually distinct even
//!    when the producer supplied no palette at all.
//!
//! Value `0` is the segmentation **background** and is always fully transparent,
//! regardless of any explicit palette entry, so a mask composited over the
//! intensity image shows the image (not a wash of colour) wherever nothing is
//! labelled.

use lucida_content::LabelColor;
use serde::{Deserialize, Serialize};

/// Number of entries the label LUT covers, i.e. `[0, CAP)`. The web looks a
/// label voxel value `v < CAP` up directly (no masking); ids `>= CAP`, which
/// the table can't hold, are coloured by the same deterministic [`glasbey_rgba`]
/// walk recomputed in-shader, so no id is truncated to fit. 65536 = a full
/// 256×256 texture and every distinct value a 16-bit id can take.
pub const LABEL_LUT_CAP: u32 = 65536;

/// A flat `rgba8` lookup table for a label overlay: `CAP` entries of 4 bytes
/// each, laid out `[r, g, b, a, r, g, b, a, …]`. The web reshapes these
/// [`width`](Self::width) (== [`LABEL_LUT_CAP`]) entries row-major into a
/// `256×256` `rgba8unorm` texture on upload (a flat `65536×1` texture would
/// exceed the GPU's max 2D texture dimension).
///
/// Built by [`crate::scene::Scene::label_lut`]; `rgba.len() == width * 4`.
///
/// Serialises to `{ "rgba": [...], "width": N }` for the wasm bridge; the web
/// uploads `rgba` directly to a texture.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelLut {
    /// `width * 4` bytes, four per entry (`rgba8`), in ascending value order.
    pub rgba: Vec<u8>,
    /// Number of LUT entries — always [`LABEL_LUT_CAP`].
    pub width: u32,
}

/// A deterministic, stateless colour for label value `value`.
///
/// - **`value == 0`** → `[0, 0, 0, 0]` (transparent background). Nothing is
///   labelled `0`, so it must never paint over the intensity image.
/// - **`value > 0`** → an opaque (`alpha == 255`), visually-distinct colour.
///
/// The hue is a **golden-ratio walk**: `hue = frac(value * φ⁻¹)` where
/// `φ⁻¹ ≈ 0.618`. Successive integers land far apart on the colour wheel (the
/// golden ratio is the "most irrational" number, so the sequence never
/// short-cycles), which is exactly the glasbey goal — maximally-distinct
/// categorical colours — without needing a precomputed palette. Saturation and
/// value are held high and constant so every label reads as a bright, saturated
/// tint. Pure function of `value`: same input, same output, on every platform.
pub fn glasbey_rgba(value: u32) -> [u8; 4] {
    if value == 0 {
        return [0, 0, 0, 0];
    }

    // Golden-ratio conjugate: 1/φ = φ − 1 ≈ 0.6180339887.
    const GOLDEN_RATIO_CONJUGATE: f64 = 0.618_033_988_749_895;
    // Offset so value 1 doesn't land exactly on pure red (hue 0); a small
    // rotation makes the first few ids read more distinctly.
    let hue = ((value as f64) * GOLDEN_RATIO_CONJUGATE + 0.5).fract();

    // Fixed high saturation/value keeps every label bright and vivid. Slight
    // value dither by parity gives immediately-adjacent ids an extra nudge in
    // lightness on top of the hue separation.
    let saturation = 0.65;
    let brightness = if value & 1 == 1 { 0.98 } else { 0.88 };

    let [r, g, b] = hsv_to_rgb(hue, saturation, brightness);
    [r, g, b, 255]
}

/// Convert an HSV colour (each component in `[0, 1]`) to 8-bit RGB. Standard
/// six-sector conversion; `h == 1.0` wraps to sector 0 the same as `h == 0.0`.
fn hsv_to_rgb(h: f64, s: f64, v: f64) -> [u8; 3] {
    let h6 = (h.fract() * 6.0).rem_euclid(6.0);
    let sector = h6.floor() as i32;
    let f = h6 - sector as f64;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));

    let (r, g, b) = match sector {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };

    [to_u8(r), to_u8(g), to_u8(b)]
}

/// Clamp a `[0, 1]` float to a rounded 8-bit channel value.
fn to_u8(c: f64) -> u8 {
    (c.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Build the flat `rgba8` LUT bytes from a label's explicit `image-label.colors`
/// palette. For every `i` in `[0, CAP)`, an explicit palette entry whose
/// `value == i` wins; otherwise the deterministic [`glasbey_rgba`] colour fills
/// the slot. Value `0` is forced transparent regardless of the palette.
///
/// Duplicate palette entries for the same value resolve to the **last** one
/// seen — producers shouldn't emit duplicates, but this keeps the fold total.
pub fn build_label_lut_rgba(colors: &[LabelColor]) -> Vec<u8> {
    let mut rgba = vec![0u8; (LABEL_LUT_CAP as usize) * 4];
    // Default fill: the deterministic hash colour for every id.
    for i in 0..LABEL_LUT_CAP {
        let base = (i as usize) * 4;
        rgba[base..base + 4].copy_from_slice(&glasbey_rgba(i));
    }
    // Overlay explicit palette entries on top.
    for c in colors {
        if c.value >= LABEL_LUT_CAP {
            continue;
        }
        let base = (c.value as usize) * 4;
        rgba[base..base + 4].copy_from_slice(&c.rgba);
    }
    // Background is always fully transparent, even if the producer coloured it.
    rgba[0..4].copy_from_slice(&[0, 0, 0, 0]);
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_zero_is_transparent_background() {
        assert_eq!(glasbey_rgba(0), [0, 0, 0, 0]);
    }

    #[test]
    fn positive_values_are_opaque() {
        for v in [1u32, 2, 7, 42, 255, 1000, 65535] {
            assert_eq!(glasbey_rgba(v)[3], 255, "value {v} must be opaque");
        }
    }

    #[test]
    fn is_deterministic() {
        // Same input → same output, called repeatedly.
        for v in [1u32, 5, 99, 65535] {
            assert_eq!(glasbey_rgba(v), glasbey_rgba(v));
        }
    }

    #[test]
    fn adjacent_values_differ() {
        // The whole point of a glasbey-style palette: neighbours are distinct.
        for v in 1u32..512 {
            assert_ne!(
                glasbey_rgba(v),
                glasbey_rgba(v + 1),
                "values {v} and {} collided",
                v + 1
            );
        }
    }

    #[test]
    fn positive_values_are_not_all_black() {
        // A distinct colour must actually have some chroma/brightness.
        for v in [1u32, 3, 128, 9999] {
            let [r, g, b, _] = glasbey_rgba(v);
            assert!(
                r as u32 + g as u32 + b as u32 > 0,
                "value {v} rendered pure black"
            );
        }
    }

    #[test]
    fn lut_is_cap_wide_and_correctly_sized() {
        let rgba = build_label_lut_rgba(&[]);
        assert_eq!(rgba.len(), (LABEL_LUT_CAP as usize) * 4);
    }

    #[test]
    fn lut_background_slot_is_transparent() {
        let rgba = build_label_lut_rgba(&[]);
        assert_eq!(&rgba[0..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn lut_falls_back_to_glasbey_without_palette() {
        let rgba = build_label_lut_rgba(&[]);
        for v in [1u32, 17, 4096] {
            let base = (v as usize) * 4;
            assert_eq!(&rgba[base..base + 4], &glasbey_rgba(v));
        }
    }

    #[test]
    fn lut_explicit_palette_wins_over_glasbey() {
        let colors = vec![
            LabelColor {
                value: 5,
                rgba: [10, 20, 30, 200],
            },
            LabelColor {
                value: 300,
                rgba: [1, 2, 3, 4],
            },
        ];
        let rgba = build_label_lut_rgba(&colors);
        assert_eq!(&rgba[5 * 4..5 * 4 + 4], &[10, 20, 30, 200]);
        assert_eq!(&rgba[300 * 4..300 * 4 + 4], &[1, 2, 3, 4]);
        // A value with no explicit entry keeps its glasbey colour.
        assert_eq!(&rgba[6 * 4..6 * 4 + 4], &glasbey_rgba(6));
    }

    #[test]
    fn lut_explicit_background_still_transparent() {
        // Even if a producer (wrongly) colours value 0, it stays transparent.
        let colors = vec![LabelColor {
            value: 0,
            rgba: [255, 0, 0, 255],
        }];
        let rgba = build_label_lut_rgba(&colors);
        assert_eq!(&rgba[0..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn lut_ignores_out_of_range_palette_values() {
        // An entry at/above CAP must not panic or write out of bounds.
        let colors = vec![
            LabelColor {
                value: LABEL_LUT_CAP,
                rgba: [9, 9, 9, 9],
            },
            LabelColor {
                value: LABEL_LUT_CAP + 100,
                rgba: [8, 8, 8, 8],
            },
        ];
        let rgba = build_label_lut_rgba(&colors);
        assert_eq!(rgba.len(), (LABEL_LUT_CAP as usize) * 4);
    }
}
