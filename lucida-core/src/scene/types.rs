use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use indexmap::IndexMap;
use lucida_content::{
    DataType, DatasetId, DatasetKind, DatasetManifest, EntityId, LabelSpec, LayoutId, LayoutSpec,
};
use lucida_protocol::AssetCatalog;

use crate::chunk::ChunkCoord;
use crate::command::DocumentCommand;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum BlendMode {
    #[default]
    Alpha,
    Additive,
    Max,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum RenderMode {
    #[default]
    Translucent,
    MaxIntensity,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum Colormap {
    #[default]
    Gray,
    Magenta,
    Green,
    Cyan,
    Red,
    Blue,
    Yellow,
    Viridis,
    Inferno,
    Plasma,
    Magma,
    Turbo,
    Hot,
    Cool,
    Jet,
}

impl Colormap {
    pub fn default_for_channel(index: usize) -> Self {
        const CYCLE: [Colormap; 3] = [Colormap::Magenta, Colormap::Green, Colormap::Cyan];
        CYCLE[index % CYCLE.len()]
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelSettings {
    pub visible: bool,
    pub colormap: Colormap,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
    /// User-supplied display name override for this channel. `None` (the
    /// default) means "no override" — the UI falls back to the manifest's
    /// omero label and then `Ch {index}`. A local-only per-channel display
    /// setting like `colormap`/`contrast`: set via `SetChannelName`, it rides
    /// saved views and broadcasts to followers via the selection epoch, but is
    /// NOT durable document state (out of scope for this slice).
    ///
    /// `#[serde(default, skip_serializing_if = "Option::is_none")]` keeps this
    /// strictly additive: a presence snapshot / saved view persisted before
    /// this slice carries no `name` key and deserializes as `None`, and a
    /// channel WITHOUT an override serializes byte-identically to a pre-slice
    /// one (the key is omitted). No wire break.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Default for ChannelSettings {
    fn default() -> Self {
        Self {
            visible: true,
            colormap: Colormap::Gray,
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
            name: None,
        }
    }
}

fn default_channel_blend_mode() -> BlendMode {
    BlendMode::Additive
}

/// Per-label overlay display state: whether a segmentation-mask label is drawn,
/// and how strongly it composites over the intensity image. The per-label
/// analogue of [`ChannelSettings`] — a local, per-client display setting that
/// rides presence and saved views (via the enclosing [`DatasetDisplaySettings`])
/// but is not durable document state.
///
/// `visible` defaults to `true` and `opacity` to `0.5`: a freshly opened dataset
/// shows its label overlay at half strength — the same fixed opacity used before
/// per-label controls existed — leaving the intensity data visible underneath.
/// The user can then hide individual labels or tune each one's opacity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelSettings {
    pub visible: bool,
    pub opacity: f32,
    /// The manifest (OME `labels`) name of the label this entry controls.
    /// `label_settings` is positional against the live scene's CURRENT label
    /// list, but a saved view can outlive a re-import that reorders/adds/
    /// removes labels — the name is the stable key that lets a restore land
    /// each entry on the label it was saved for (see
    /// [`DatasetDisplaySettings::reconcile_label_settings`]) instead of on
    /// whatever now sits at the same index. Populated from the manifest by
    /// [`DatasetDisplaySettings::seeded_for`], so presence exports and saved
    /// views carry it automatically.
    ///
    /// `#[serde(default, skip_serializing_if = "Option::is_none")]` keeps this
    /// strictly additive: a presence snapshot / saved view persisted before
    /// names existed carries no `name` key and deserializes as `None` (and is
    /// then applied positionally, exactly as before), while an entry WITHOUT a
    /// name serializes byte-identically to a pre-name one. No wire break.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Default for LabelSettings {
    fn default() -> Self {
        Self {
            visible: true,
            opacity: 0.5,
            name: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DatasetDisplaySettings {
    pub visible: bool,
    pub opacity: f32,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub render_mode: RenderMode,
    #[serde(default)]
    pub channel_settings: Vec<ChannelSettings>,
    /// Per-label overlay settings, positional by manifest (OME `labels`) order:
    /// index `i` controls the visibility/opacity of the `i`-th attached label.
    /// Seeded on open from the manifest's label count. `#[serde(default)]` keeps
    /// this additive — a presence snapshot or saved view persisted before
    /// per-label controls existed carries no `label_settings` key and
    /// deserializes as an empty Vec (the render path then falls back to the
    /// default single-label overlay), so there is no wire break.
    #[serde(default)]
    pub label_settings: Vec<LabelSettings>,
    #[serde(default = "default_channel_blend_mode")]
    pub channel_blend_mode: BlendMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_level_override: Option<u32>,
}

impl DatasetDisplaySettings {
    /// Get a mutable reference to channel settings at the given index,
    /// growing the vec with defaults if needed.
    pub fn ensure_channel(&mut self, index: usize) -> &mut ChannelSettings {
        while self.channel_settings.len() <= index {
            let i = self.channel_settings.len();
            self.channel_settings.push(ChannelSettings {
                colormap: Colormap::default_for_channel(i),
                ..Default::default()
            });
        }
        &mut self.channel_settings[index]
    }

    /// Get a mutable reference to label settings at the given index, growing
    /// the vec with defaults if needed. The per-label mirror of
    /// [`Self::ensure_channel`]: a per-label edit that targets an index past
    /// the seeded count back-fills intervening entries with the default
    /// (visible, 0.5) rather than panicking. Callers bound the index to the
    /// dataset's real label count first (see the `SetLabel*` apply arms), so a
    /// stray/huge index can never balloon the vec.
    pub fn ensure_label(&mut self, index: usize) -> &mut LabelSettings {
        while self.label_settings.len() <= index {
            self.label_settings.push(LabelSettings::default());
        }
        &mut self.label_settings[index]
    }

    /// Build the complete default per-dataset display settings for a freshly
    /// opened OR restored dataset: one channel-settings entry per channel
    /// (cycling the default colormaps) and one label-settings entry per attached
    /// label. This is the single seeding source shared by the `DatasetOpened`
    /// apply path and the document-restore path (`load_document`), so both
    /// produce identical, COMPLETE settings — the layer panel and render path
    /// depend on `label_settings` / `channel_settings` being present and
    /// full-length however the dataset entered the scene.
    ///
    /// Label policy: only the first label that could plausibly draw (see
    /// [`Self::label_could_draw`]) is visible by default (the rest start
    /// hidden), all at opacity 0.5 — one clean overlay on open, the user
    /// reveals the others via the per-label toggles. This keeps a labeled
    /// plate from fetching + pooling every mask on open and avoids stacking
    /// masks into a muddy first impression, while still exposing the full set
    /// for control.
    ///
    /// The pick applies every render-eligibility check knowable from the
    /// manifest alone: the label must be uint32 (the only dtype the render/
    /// fetch path draws — uint8/uint16 are common), its source image must
    /// resolve in `manifest.images()` with a level 0 to place the overlay
    /// against, and its own level-0 spatial footprint must be non-empty.
    /// Spending the single visible pick on a label that
    /// fails any of these would open with NO overlay even when a drawable
    /// sibling exists — the web draws exactly the visible-AND-eligible set and
    /// does NOT substitute a fallback for an undrawable visible label. If no
    /// label qualifies, none is visible (nothing can draw); the layer panel's
    /// count badge still surfaces that labels exist. Device/budget eligibility
    /// (whether some multiscale level fits the client's texture/chunk caps in
    /// the active 2D/3D mode) is NOT knowable here, so a label ineligible only
    /// by those caps can still take the pick and open with no overlay until
    /// the user toggles a drawable label on.
    pub fn seeded_for(manifest: &DatasetManifest) -> Self {
        let channel_count = manifest
            .images()
            .first()
            .and_then(|img| img.multiscale.levels.first())
            .map(|l| l.shape[1] as usize)
            .unwrap_or(1);
        Self {
            channel_settings: (0..channel_count)
                .map(|i| ChannelSettings {
                    colormap: Colormap::default_for_channel(i),
                    ..Default::default()
                })
                .collect(),
            label_settings: Self::seeded_label_settings(manifest),
            ..Default::default()
        }
    }

    /// The default per-label settings for `manifest`'s attached labels: one
    /// entry per label in manifest (OME `labels`) order, carrying that label's
    /// NAME, with only the first label that could plausibly draw (see
    /// [`Self::label_could_draw`]) visible and all at opacity 0.5 (the seeding
    /// policy documented on [`Self::seeded_for`]).
    /// Shared by [`Self::seeded_for`] and
    /// [`Self::reconcile_label_settings`] so a reconciled entry vec and a
    /// freshly seeded one agree on defaults and names.
    fn seeded_label_settings(manifest: &DatasetManifest) -> Vec<LabelSettings> {
        let labels = manifest.label_specs();
        // Index of the first label that could plausibly draw, or `None` when
        // no label qualifies. Only that one is seeded visible.
        let default_visible = labels
            .iter()
            .position(|l| Self::label_could_draw(manifest, l));
        labels
            .iter()
            .enumerate()
            .map(|(i, l)| LabelSettings {
                visible: Some(i) == default_visible,
                opacity: 0.5,
                name: Some(l.name.clone()),
            })
            .collect()
    }

    /// Whether `label` passes every render-eligibility check knowable from the
    /// manifest alone — i.e. whether it could plausibly draw on some client:
    ///
    /// - **Drawable dtype**: the render/fetch path only draws uint32 masks.
    /// - **Drawable source**: `source_image_id` names an image present in
    ///   `manifest.images()` that carries a level 0. The render path places
    ///   the overlay against its source's level-0 geometry, so a label whose
    ///   source lacks a level 0 (an image with an empty `levels` list — never
    ///   importer-produced, but expressible in a persisted/foreign manifest)
    ///   is exactly as unplaceable as an orphan label with no source at all.
    /// - **Positive footprint**: the label's own level-0 spatial extent is
    ///   non-empty. A zero Y or X dimension — or no level 0 at all — covers no
    ///   pixels.
    ///
    /// Device/budget eligibility (whether some multiscale level fits the
    /// client's texture/chunk caps for the active 2D/3D view mode) is
    /// deliberately NOT checked: it depends on per-client GPU limits and view
    /// mode, which the scene cannot know.
    fn label_could_draw(manifest: &DatasetManifest, label: &LabelSpec) -> bool {
        if label.image.multiscale.data_type != DataType::Uint32 {
            return false;
        }
        let source_has_level0 = manifest
            .images()
            .iter()
            .find(|img| img.image_id == label.source_image_id)
            .is_some_and(|source| !source.multiscale.levels.is_empty());
        if !source_has_level0 {
            return false;
        }
        // Canonical 5D shape order is [t, c, z, y, x].
        label
            .image
            .multiscale
            .levels
            .first()
            .is_some_and(|l0| l0.shape[3] > 0 && l0.shape[4] > 0)
    }

    /// Re-key restored per-label settings against `manifest`'s CURRENT label
    /// list, by label NAME.
    ///
    /// A restored `label_settings` vec was captured against the label list the
    /// dataset had WHEN IT WAS SAVED; the manifest arriving now (a re-import,
    /// a per-field label set) may order, add, or remove labels differently, so
    /// applying the vec positionally would put settings on the wrong labels.
    /// Called wherever an already-present settings entry meets an arriving
    /// manifest (the `DatasetOpened` apply path and the document restore),
    /// with these rules:
    ///
    /// - **Non-empty nameless vec (legacy)**: if the vec has entries but NO
    ///   entry carries a name — settings persisted before names existed — it
    ///   is left untouched, keeping the exact positional behavior such data
    ///   always had. An **empty vec is not legacy data**: it carries no
    ///   positional meaning to preserve, so it falls through and reseeds
    ///   full-length from the manifest. This matters after a label-less
    ///   manifest revision (a re-import that lost its labels, or a transient
    ///   label-less broadcast) emptied the vec: when a later revision brings
    ///   labels back, the entries must reseed — treating the empty vec as
    ///   legacy would strand the dataset with no per-label entries forever
    ///   (the `DatasetOpened` path only seeds a MISSING entry, never an
    ///   existing-but-empty one), and panel edits would then regrow nameless
    ///   positional entries.
    /// - **Named entries** land on the current label with the SAME name
    ///   (visible/opacity copied onto that label's slot); a name the dataset
    ///   no longer has is dropped.
    /// - **Repeated names** match by OCCURRENCE: the k-th restored `"cells"`
    ///   lands on the k-th current `"cells"`. A label name is only unique per
    ///   source image — a plate whose fields each carry a `"cells"` group
    ///   repeats the name once per field, in field order — so first-match
    ///   would pile every field's setting onto one label, while occurrence
    ///   order keeps an unchanged list restoring exactly as saved.
    /// - **Nameless entries in a mixed vec** keep their positional meaning:
    ///   index `i` targets the current list's label `i` when in range.
    /// - **Labels with no restored entry** get their seeded default (the
    ///   [`Self::seeded_label_settings`] policy), so the result is always
    ///   full-length with every entry carrying the current manifest's name.
    pub fn reconcile_label_settings(&mut self, manifest: &DatasetManifest) {
        // Only a NON-EMPTY all-nameless vec is legacy positional data to be
        // preserved verbatim. An empty vec falls through so it reseeds from
        // the manifest (see the rules above).
        if !self.label_settings.is_empty() && !self.label_settings.iter().any(|l| l.name.is_some())
        {
            return;
        }
        let mut next = Self::seeded_label_settings(manifest);
        let labels = manifest.label_specs();
        // Occurrence counter per restored name, so the k-th restored entry
        // named X targets the k-th current label named X.
        let mut occurrence: HashMap<String, usize> = HashMap::new();
        for (i, entry) in std::mem::take(&mut self.label_settings)
            .into_iter()
            .enumerate()
        {
            let target = match &entry.name {
                Some(name) => {
                    let k = occurrence.entry(name.clone()).or_insert(0);
                    let pos = labels
                        .iter()
                        .enumerate()
                        .filter(|(_, l)| &l.name == name)
                        .map(|(j, _)| j)
                        .nth(*k);
                    *k += 1;
                    pos
                }
                None => (i < next.len()).then_some(i),
            };
            if let Some(j) = target {
                // Only the user-adjustable fields move; the slot keeps the
                // current manifest's canonical name.
                next[j].visible = entry.visible;
                next[j].opacity = entry.opacity;
            }
        }
        self.label_settings = next;
    }
}

impl Default for DatasetDisplaySettings {
    fn default() -> Self {
        Self {
            visible: true,
            opacity: 1.0,
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
            blend_mode: BlendMode::Alpha,
            render_mode: RenderMode::Translucent,
            channel_settings: Vec::new(),
            label_settings: Vec::new(),
            channel_blend_mode: BlendMode::Additive,
            detail_level_override: None,
        }
    }
}

/// Display settings (contrast window + gamma).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DisplayState {
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
}

impl Default for DisplayState {
    fn default() -> Self {
        Self {
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
        }
    }
}

/// The shape of a collaborative annotation.
///
/// - `Point` — a single pin at `position` (no second vertex). The `#[default]`,
///   so a kind-less command/blob (slices 1..4) loads as a point.
/// - `Line` — a segment from `position` to `end`.
/// - `Box` — an axis-aligned rectangle whose opposite corners are `position`
///   and `end`.
///
/// `Line`/`Box` carry their second vertex in [`Annotation::end`]; a `Point`
/// leaves `end` `None`. Freehand (an N-point polyline) is intentionally not a
/// variant here — it needs a `Vec` of vertices and is a later slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum AnnotationKind {
    #[default]
    Point,
    Line,
    Box,
}

/// A single text comment attached to an [`Annotation`], forming a flat
/// discussion thread on a pin.
///
/// The `id` is client-supplied (a uuid string) so — exactly like the pin
/// itself — an inbound `add_comment` command and its rebroadcast are
/// byte-identical and apply identically on every peer. Comments live
/// nested on the annotation (`Annotation::comments`), so they ride the
/// existing snapshot, broadcast, and `document_json` persistence machinery
/// for free, and cascade away when the pin (or its dataset) is removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub text: String,
}

/// A single collaborative annotation: a marker anchored to a position in
/// 2D world space (the same frame `centroidWorld`/layout positions use, per
/// ADR-0030) so it stays glued to the data for every peer regardless of
/// their viewport.
///
/// The `id` is client-supplied (a uuid string) so an inbound command and
/// its rebroadcast are byte-identical — one command applied identically on
/// every peer, with no server-side id asymmetry. Apply is idempotent on a
/// repeated `id` (last write wins; see [`DocumentState::add_annotation`]).
///
/// `comments` is the pin's discussion thread (insertion-ordered, deduped by
/// comment id). It is `#[serde(default)]` so pins persisted by slice 1
/// (before threads existed) still deserialize with an empty thread, and so a
/// pin with no comments serializes/round-trips identically to a slice-1 pin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Annotation {
    pub id: String,
    /// In-plane world-space position `[x, y]`.
    pub position: [f64; 2],
    /// Additive depth (the third coordinate) in the same world frame as
    /// `position`, so the pin's full world point is `(position[0],
    /// position[1], z)`. Kept as a separate scalar — rather than widening
    /// `position` to `[f64; 3]` — so the wire stays backward compatible with
    /// slices 1/2: `#[serde(default)]` means pins (and persisted documents)
    /// written before depth existed deserialize with `z = 0.0`, and a pin at
    /// `z = 0.0` serializes identically whether or not it carries depth.
    #[serde(default)]
    pub z: f64,
    /// The **timepoint** (T) the pin was placed on — the view's `t` at creation,
    /// an integer frame index. Unlike `z` (a world-space depth in the same
    /// continuous frame as `position`), `t`/`c` are discrete view selectors: a
    /// pin "belongs to" the slice/timepoint/channel it was dropped on, and the
    /// overlay renders it off-context (dimmed + a "where it lives" helptext, like
    /// an off-view peer cursor) when the current view differs.
    ///
    /// `#[serde(default)]` keeps this additive — a pin persisted (or broadcast)
    /// before this slice carries no `t` key and deserializes as `t = 0`, and a
    /// pin at `t = 0` serializes identically whether or not it predates the
    /// field. No wire break.
    #[serde(default)]
    pub t: i64,
    /// The **channel** (C) the pin was placed on — the view's `c` at creation,
    /// an integer channel index. Like `t`, it is a discrete view selector that
    /// drives off-context rendering, and is `#[serde(default)]` so an older pin
    /// (no `c` key) deserializes as `c = 0` with no wire break.
    #[serde(default)]
    pub c: i64,
    pub author: String,
    #[serde(default)]
    pub kind: AnnotationKind,
    /// The annotation's **second** in-plane world-space vertex: a line's far
    /// endpoint, or a box's opposite corner (the first corner is `position`).
    /// `None` for a `Point` (which has only one vertex).
    ///
    /// `#[serde(default)]` so this stays wire/blob compatible with slices 1..4:
    /// a pin persisted (or broadcast) before this slice carries no `end` key and
    /// deserializes as `None`, i.e. a plain point. A `Point` with `end == None`
    /// serializes identically to a slice-1..4 pin. Depth (`z`) is shared by both
    /// vertices — per-vertex depth is a later slice.
    #[serde(default)]
    pub end: Option<[f64; 2]>,
    /// Flat, ordered comment thread on this pin. Owns its dedup/order
    /// invariants via [`Annotation::add_comment`] / [`Annotation::remove_comment`].
    #[serde(default)]
    pub comments: Vec<Comment>,
    /// The **plate entity (well/field) this pin is glued to** (issue #780). Set
    /// once at creation, inside [`DocumentState::apply`] for `AddAnnotation`, to
    /// the nearest placeable entity in the dataset's resolved active layout (see
    /// [`DocumentState::nearest_anchor`]). `None` for a non-plate dataset, when no
    /// entity position is resolvable, and for any pin created before this slice.
    ///
    /// When the active layout changes, an anchored pin's whole shape is translated
    /// by the displacement of *this* entity between the old and new layouts (see
    /// [`DocumentState::reanchor_for_layout`]), so the pin stays on the data it was
    /// dropped on in every layout — synced and persisted, since this is a
    /// deterministic effect of the canonical `apply` path.
    ///
    /// `#[serde(default)]` keeps this additive: a pin persisted (or broadcast)
    /// before this slice carries no `anchor` key and deserializes as `None` (so it
    /// is left in place by a layout switch), and an unanchored pin serializes
    /// identically to a pre-slice one. No wire break.
    #[serde(default)]
    pub anchor: Option<EntityId>,
    /// The **author's view at creation** — a snapshot of how they were looking
    /// at the data when they dropped this pin (camera, slice/timepoint/channel,
    /// per-dataset display), so a later slice can restore that exact view on
    /// navigation. Reuses the existing [`SavedView`] capture type.
    ///
    /// Captured in **workspace-dataset-id** form: its `datasets` Vec is left
    /// EMPTY (no source URLs), so embedding a view on a pin never leaks dataset
    /// URLs into broadcast/persisted document state — membership is already owned
    /// by the workspace document. `z`/`t`/`c` already record the discrete slice
    /// context; this view carries the *full* viewport (camera + display) on top.
    ///
    /// `#[serde(default, skip_serializing_if = "Option::is_none")]` keeps this
    /// strictly additive: a pin persisted (or broadcast) before this slice carries
    /// no `view` key and deserializes as `None`, and a pin WITHOUT a captured view
    /// serializes byte-identically to a pre-slice pin (the key is omitted). No wire
    /// break.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<crate::saved_view::SavedView>,
}

impl Annotation {
    /// The in-plane world-space vertices that make up this annotation's shape,
    /// in draw order — the single source of geometry for every kind.
    ///
    /// This is the geometry helper the renderers iterate: each returned vertex
    /// is projected to screen by the *same* per-vertex marker projection a point
    /// pin already uses, and then connected by the shared draw path (a dot for
    /// one vertex, a stroked polyline for an open run, a closed ring for a box).
    /// Keeping the per-kind vertex layout here — rather than branching inside
    /// each renderer — means the 2D and 3D overlays share one code path and a
    /// future kind only has to extend this function.
    ///
    /// - **Point** → `[position]` (one vertex).
    /// - **Line** → `[position, end]` (the two endpoints).
    /// - **Box** → the four corners of the axis-aligned rectangle whose opposite
    ///   corners are `position` and `end`, wound `position → (end.x, position.y)
    ///   → end → (position.x, end.y)`. Returned as a 4-corner ring (not 2
    ///   corners) so that in 3D each corner projects independently through the
    ///   volume transform and the box tracks the data as the camera orbits — a
    ///   screen-space rect built from two projected corners would shear.
    ///
    /// A `Line`/`Box` whose `end` is absent (a malformed or partially-applied
    /// command) gracefully collapses to its single anchor `position`, so the
    /// shape always has at least one vertex and never panics or vanishes.
    pub fn vertices(&self) -> Vec<[f64; 2]> {
        match (self.kind, self.end) {
            (AnnotationKind::Line, Some(end)) => vec![self.position, end],
            (AnnotationKind::Box, Some(end)) => {
                let [x0, y0] = self.position;
                let [x1, y1] = end;
                vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
            }
            // Point, or a line/box missing its second vertex: just the anchor.
            _ => vec![self.position],
        }
    }

    /// Whether this annotation's drawn shape is a closed ring (a box) rather
    /// than an open run (a point or a line). The shared draw path uses this to
    /// decide whether to connect the last projected vertex back to the first.
    pub fn is_closed(&self) -> bool {
        matches!(self.kind, AnnotationKind::Box) && self.end.is_some()
    }

    /// Append (or replace) a comment on this annotation's thread.
    ///
    /// Idempotent / last-write-wins on a repeated comment `id`: re-applying a
    /// command with an existing id replaces that comment in place (updating its
    /// text/author) rather than appending a duplicate — so a replayed or
    /// twice-delivered `add_comment` keeps every peer convergent. Distinct ids
    /// are appended, preserving insertion order. This is the single owner of the
    /// thread's dedup + ordering invariants; `DocumentState` only locates the
    /// pin and delegates here, which keeps the comment logic unit-testable on a
    /// bare `Annotation`.
    pub fn add_comment(&mut self, comment: Comment) {
        if let Some(existing) = self.comments.iter_mut().find(|c| c.id == comment.id) {
            *existing = comment;
        } else {
            self.comments.push(comment);
        }
    }

    /// Remove a comment from this annotation's thread by `id`. Returns `true`
    /// if a comment was removed. No-op (returns `false`) if the id is unknown,
    /// so a duplicate/late removal is harmless. Surviving comments keep their
    /// relative insertion order.
    pub fn remove_comment(&mut self, id: &str) -> bool {
        let before = self.comments.len();
        self.comments.retain(|c| c.id != id);
        self.comments.len() != before
    }

    /// Reposition this pin, moving the **whole shape** rigidly.
    ///
    /// The given `position`/`z` become the anchor vertex, and any second vertex
    /// (`end` — a line's far endpoint or a box's opposite corner) is translated
    /// by the *same* in-plane delta the anchor moved, so a line keeps its
    /// length/angle and a box keeps its size: dragging slides the shape, it does
    /// not stretch or rotate it. A `Point` (`end == None`) has no second vertex
    /// and is simply repositioned.
    ///
    /// The delta is `position − self.position` and MUST be read **before**
    /// `self.position` is overwritten — taking it after would always be zero,
    /// silently reverting this to the deform-the-shape behaviour. Depth `z` is
    /// shared by both vertices (per-vertex depth is a later slice), so it is a
    /// plain overwrite, not a delta.
    ///
    /// Every other field — `id`, `author`, `kind`, and the comment thread — is
    /// left untouched: a move repositions the existing pin, it does not replace
    /// it (and editing an *individual* vertex / resizing is a later slice). This
    /// is the single owner of the reposition mutation, so it is unit-testable on
    /// a bare `Annotation`; `DocumentState` only locates the pin and delegates
    /// here. Idempotent by construction (a move by a zero delta — i.e. to the
    /// same anchor/z — leaves the shape unchanged).
    pub fn set_position(&mut self, position: [f64; 2], z: f64) {
        // Delta of the anchor move, captured BEFORE overwriting `position`.
        let [dx, dy] = [
            position[0] - self.position[0],
            position[1] - self.position[1],
        ];
        self.position = position;
        self.z = z;
        // Carry the second vertex rigidly so the whole line/box translates
        // (length/angle and size preserved). A point has no `end`, so this is
        // a no-op for it.
        if let Some(end) = self.end.as_mut() {
            end[0] += dx;
            end[1] += dy;
        }
    }

    /// **Reshape** this annotation by placing its two opposite vertices
    /// *explicitly* — the resize sibling of [`Self::set_position`].
    ///
    /// Where [`Self::set_position`] slides the *whole* shape rigidly (a box
    /// keeps its size; the second vertex rides the anchor delta), this sets the
    /// anchor (`position`) and the second vertex (`end`) to exactly the given
    /// values with **no delta math**, so a box/line can grow, shrink, or flip
    /// about a held corner/edge. That is precisely what a corner/edge resize
    /// needs: the handle recomputes the two opposite corners and hands both
    /// here, and the shape takes that geometry verbatim. Depth `z` is shared by
    /// both vertices (per-vertex depth is a later slice), so it is a plain
    /// overwrite.
    ///
    /// A `Point` has no second vertex, so a reshape of one is meaningless: this
    /// repositions its anchor/`z` and leaves `end` `None` (it never *invents* a
    /// second vertex on a point — that would silently turn a point into a
    /// line/box). For a `Line`/`Box` the passed `end` becomes the new opposite
    /// vertex. Every other field — `id`, `author`, `kind`, and the comment
    /// thread — is preserved, exactly like [`Self::set_position`], so a reshape
    /// edits the existing pin in place. Idempotent by construction (re-applying
    /// the same vertices is a no-op), which keeps a replayed/twice-delivered
    /// reshape convergent across peers. This is the single owner of the reshape
    /// mutation, so it is unit-testable on a bare `Annotation`; `DocumentState`
    /// only locates the pin and delegates here.
    pub fn set_vertices(&mut self, position: [f64; 2], end: [f64; 2], z: f64) {
        self.position = position;
        self.z = z;
        // Only a shape that already has a second vertex is reshaped to the new
        // `end`. A point keeps `end == None` — a resize never mints a vertex on
        // a shape that has none (that is `AddAnnotation`'s job, and would change
        // the pin's kind out from under it).
        if self.end.is_some() {
            self.end = Some(end);
        }
    }

    /// Overwrite an existing comment's `text` by `id`. Returns `true` if a
    /// comment matched and was edited. No-op (returns `false`) if the id is
    /// unknown, so an edit targeting a comment that was never added (or has since
    /// been removed) is harmless and never appends a phantom. The comment's `id`
    /// and `author` — and its position in the thread — are preserved; only the
    /// text changes. The sibling of [`Self::add_comment`] /
    /// [`Self::remove_comment`]: the thread's mutation invariants live here on
    /// `Annotation`, so this is unit-testable on a bare pin.
    pub fn edit_comment(&mut self, id: &str, text: String) -> bool {
        if let Some(existing) = self.comments.iter_mut().find(|c| c.id == id) {
            existing.text = text;
            true
        } else {
            false
        }
    }
}

/// Shared document state — dataset manifests synced across all clients.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DocumentState {
    pub manifests: IndexMap<DatasetId, lucida_content::DatasetManifest>,
    #[serde(default)]
    pub registered_layouts: HashMap<DatasetId, Vec<LayoutSpec>>,
    #[serde(default)]
    pub active_layout_ids: HashMap<DatasetId, LayoutId>,
    /// Per-dataset asset catalog (proxy availability). Populated via
    /// `DatasetOpened.catalog` on open and incrementally via
    /// `DocumentCommand::ApplyAssetCatalogDelta`.
    #[serde(default)]
    pub asset_catalogs: IndexMap<DatasetId, AssetCatalog>,
    /// Per-dataset collaborative annotations, keyed by dataset id (mirrors
    /// `asset_catalogs`). Populated via `DocumentCommand::AddAnnotation` /
    /// `RemoveAnnotation`. `#[serde(default)]` so this persists and restores
    /// for free through the existing `document_json` blob and older snapshots
    /// (without the field) still deserialize.
    #[serde(default)]
    pub annotations: IndexMap<DatasetId, Vec<Annotation>>,
}

impl DocumentState {
    /// Register (or replace) a dataset manifest by dataset id.
    pub fn register_dataset(&mut self, manifest: lucida_content::DatasetManifest) {
        self.manifests.insert(manifest.dataset_id.clone(), manifest);
    }

    /// The **single source of truth** for which fields of a [`DocumentState`]
    /// are keyed by (or embed) a workspace-local [`DatasetId`] — the one place
    /// that must be touched when a new id-keyed field is added.
    ///
    /// Drives every such field from one walk: for each existing entry it calls
    /// `fate(&old_key)` and either
    /// - `Some(new_key)` → **keeps** the entry, rekeyed to `new_key`
    ///   (insertion order preserved), or
    /// - `None` → **drops** the entry entirely.
    ///
    /// The id-keyed maps it covers are `manifests`, `registered_layouts`,
    /// `active_layout_ids`, `asset_catalogs`, and `annotations`. It also keeps
    /// the two *embedded* ids consistent on kept entries: a manifest's own
    /// `manifest.dataset_id` is rewritten to its entry's new key, and each kept
    /// annotation list is handed (with its new key) to `on_kept_annotations`
    /// so a caller can descend into the per-pin captured view
    /// ([`Annotation::view`]) — which carries its *own* id-keyed maps. Dropped
    /// entries need no embedded fixup: their manifest and pins (views included)
    /// go away with them.
    ///
    /// Both [`Self::remap_dataset_ids`] (remap = `Some(new)`) and
    /// [`Self::remove_dataset`] (remove = `None`) are implemented on this, so
    /// the set of fields they walk can never silently diverge — the exact class
    /// of bug that previously left `remove_dataset` orphaning layout entries and
    /// once dropped the embedded-annotation-view remap. A unit test
    /// (`rekey_dataset_ids_covers_every_id_keyed_field`) asserts a removal
    /// clears the removed id from every field this walks, so a future id-keyed
    /// field that isn't wired in here shows up as a failure.
    fn rekey_dataset_ids(
        &mut self,
        fate: impl Fn(&DatasetId) -> Option<DatasetId>,
        mut on_kept_annotations: impl FnMut(&DatasetId, &mut Vec<Annotation>),
    ) {
        // A small helper that rebuilds an id-keyed map, dropping `None`-fated
        // entries and rekeying the rest, with a per-kept-entry value hook for
        // any embedded id fixup. Works for both `IndexMap` and `HashMap`
        // (`FromIterator`), preserving order for the order-bearing `IndexMap`s.
        fn rekey<M, V>(
            map: &mut M,
            fate: &impl Fn(&DatasetId) -> Option<DatasetId>,
            mut on_kept: impl FnMut(&DatasetId, &mut V),
        ) where
            M: Default + IntoIterator<Item = (DatasetId, V)> + FromIterator<(DatasetId, V)>,
        {
            *map = std::mem::take(map)
                .into_iter()
                .filter_map(|(id, mut value)| {
                    let new_id = fate(&id)?;
                    on_kept(&new_id, &mut value);
                    Some((new_id, value))
                })
                .collect();
        }

        rekey(&mut self.manifests, &fate, |new_id, manifest| {
            // The manifest carries its own id; keep it equal to the map key.
            manifest.dataset_id = new_id.clone();
        });
        rekey(&mut self.registered_layouts, &fate, |_, _| {});
        rekey(&mut self.active_layout_ids, &fate, |_, _| {});
        rekey(&mut self.asset_catalogs, &fate, |_, _| {});
        rekey(&mut self.annotations, &fate, |new_id, anns| {
            on_kept_annotations(new_id, anns);
        });
    }

    /// Rewrite every workspace-local [`DatasetId`] in the document through
    /// `remap` (old id → new id), preserving insertion order.
    ///
    /// Every map in the document is keyed by the workspace-local dataset id
    /// (`manifests`, `registered_layouts`, `active_layout_ids`,
    /// `asset_catalogs`, `annotations`), and each manifest *also* carries its
    /// own id in `manifest.dataset_id`. When a workspace is duplicated the copy
    /// mints fresh ids for its datasets, so the source document copied verbatim
    /// would reference the source's (now-foreign) ids. This remaps both the
    /// keys and the embedded `manifest.dataset_id` so the duplicated document
    /// resolves against the copy's own `workspace_datasets`. An id missing from
    /// `remap` is left unchanged (safe no-op); the caller supplies a map
    /// covering every dataset membership of the source.
    ///
    /// This also descends into each annotation's captured author view
    /// ([`Annotation::view`], an embedded [`SavedView`](crate::saved_view::SavedView)),
    /// which carries its own workspace-dataset-id-keyed maps, and remaps it with
    /// the same mapping — otherwise a copied pin's "go to author's view" would
    /// dangle against the source workspace's ids in the duplicate.
    ///
    /// Implemented on [`Self::rekey_dataset_ids`] (the single source of truth
    /// for the id-keyed field set) with a `fate` that maps every key to
    /// `Some(new)` — a remap keeps every entry — so it can never walk a
    /// different set of fields than [`Self::remove_dataset`].
    pub fn remap_dataset_ids(&mut self, remap: &HashMap<DatasetId, DatasetId>) {
        self.rekey_dataset_ids(
            // Remap keeps every entry, rekeyed; an id missing from `remap` maps
            // to itself (safe no-op).
            |id| Some(remap.get(id).cloned().unwrap_or_else(|| id.clone())),
            |_new_id, anns| {
                // Each annotation may carry the author's captured view
                // (`Annotation::view: Option<SavedView>`), itself keyed by the
                // workspace's dataset ids (active_layouts / dataset_order /
                // dataset_settings / auto_contrast). Remapping only the
                // `annotations` map KEY leaves that embedded view pointing at
                // the source workspace's ids, so a copied pin's "go to author's
                // view" would dangle in the duplicate. Descend into the stored
                // view and remap it with the same mapping (mutating in place so
                // the change lands on the annotation we keep, not a copy).
                for ann in anns {
                    if let Some(view) = ann.view.as_mut() {
                        view.remap_dataset_ids(remap);
                        // Copy-point defense: even though `AddAnnotation` now
                        // strips an embedded view's source URLs on apply, a
                        // document persisted BEFORE that fix may carry a pin
                        // whose view still holds them. `remap_dataset_ids` is
                        // only ever run when duplicating a workspace, so clear
                        // `datasets` here too — the COPY's embedded views carry
                        // NO source URLs regardless of how dirty the source is.
                        view.clear_source_urls();
                    }
                }
            },
        );
    }

    /// Remove a dataset by id, clearing it from **every** id-keyed field of the
    /// document: its manifest, registered layouts, active-layout id, asset
    /// catalog, and annotations. Annotations are scoped per dataset, so a
    /// removed dataset's pins must not linger; likewise its layout entries —
    /// leaving `registered_layouts` / `active_layout_ids` behind would orphan
    /// them against a dataset that no longer exists.
    ///
    /// Implemented on [`Self::rekey_dataset_ids`] (the single source of truth
    /// for the id-keyed field set) with a `fate` that drops the target id
    /// (`None`) and keeps every other entry unchanged — so it can never walk a
    /// different set of fields than [`Self::remap_dataset_ids`]. Dropping an
    /// `active_layout_ids` entry simply removes the active selection for the
    /// (now gone) dataset; resolution for any *surviving* dataset is unaffected
    /// (it falls back to that dataset's own manifest default, exactly as for a
    /// dataset that never had an active id set).
    pub fn remove_dataset(&mut self, id: &DatasetId) {
        self.rekey_dataset_ids(
            |candidate| {
                if candidate == id {
                    None
                } else {
                    Some(candidate.clone())
                }
            },
            // Surviving annotation lists are untouched by a removal — only the
            // removed dataset's pins drop (with the whole entry).
            |_new_id, _anns| {},
        );
    }

    /// Rename a dataset's display label in place by id. Overwrites only the
    /// manifest's `name`; the manifest's `dataset_id`, images, transforms,
    /// and the dataset's asset catalog / annotations are untouched. No-op if
    /// `id` is unknown, so a rename racing a removal is harmless and never
    /// mints a phantom manifest. The viewer reads this `name` via
    /// `scene.dataset_name(id)`, so an in-place edit here is what the layer
    /// panel shows — and, because the manifest lives in the persisted
    /// document, what reopen restores.
    pub fn rename_dataset(&mut self, id: &DatasetId, name: String) {
        if let Some(manifest) = self.manifests.get_mut(id) {
            manifest.name = name;
        }
    }

    /// Add (or replace) an annotation under `dataset_id`.
    ///
    /// Idempotent / last-write-wins on a repeated `id`: re-applying a command
    /// with an existing id replaces that annotation's position/author/kind in
    /// place rather than appending a duplicate. This keeps every peer convergent
    /// even if a command is delivered or replayed more than once. Distinct ids
    /// are kept as independent entries, preserving insertion order.
    ///
    /// The pin's existing comment thread is **preserved** across such a
    /// re-apply: an `add_annotation` rebroadcast/replay must not silently wipe a
    /// discussion that has since accrued on that pin. (Threads are mutated only
    /// via add/remove_comment.) A genuinely new pin carries an empty thread, so
    /// for the common unique-id-per-drop case this is a no-op.
    pub fn add_annotation(&mut self, dataset_id: DatasetId, annotation: Annotation) {
        let list = self.annotations.entry(dataset_id).or_default();
        if let Some(existing) = list.iter_mut().find(|a| a.id == annotation.id) {
            let comments = std::mem::take(&mut existing.comments);
            *existing = annotation;
            existing.comments = comments;
        } else {
            list.push(annotation);
        }
    }

    /// Remove an annotation by id from `dataset_id`. No-op if the dataset or
    /// the id is unknown (so a duplicate/late removal is harmless). Drops the
    /// dataset's now-empty entry to keep the map tidy. The pin's comment thread
    /// cascades away with it (comments nest on the annotation).
    pub fn remove_annotation(&mut self, dataset_id: &DatasetId, id: &str) {
        if let Some(list) = self.annotations.get_mut(dataset_id) {
            list.retain(|a| a.id != id);
            if list.is_empty() {
                self.annotations.shift_remove(dataset_id);
            }
        }
    }

    /// Locate the pin `annotation_id` under `dataset_id` for mutation.
    ///
    /// Shared by [`Self::move_annotation`] / [`Self::add_comment`] /
    /// [`Self::remove_comment`] / [`Self::edit_comment`]: each must target an
    /// existing pin and otherwise be a clean no-op. Centralizing the lookup keeps
    /// that "missing pin/dataset is harmless" rule in one place — the same
    /// find-by-id used by `add`/`remove`.
    fn annotation_mut(
        &mut self,
        dataset_id: &DatasetId,
        annotation_id: &str,
    ) -> Option<&mut Annotation> {
        self.annotations
            .get_mut(dataset_id)?
            .iter_mut()
            .find(|a| a.id == annotation_id)
    }

    /// Move the pin `id` under `dataset_id`. The optional `end` picks the move
    /// shape, so this one entry point serves both the whole-shape drag (#776)
    /// and the corner/edge resize (this slice):
    ///
    /// - `end: None` → **rigid whole-shape translate**: the anchor goes to
    ///   `position`/`z` and any second vertex rides the same in-plane delta, so
    ///   a line/box keeps its length, angle, and size (see
    ///   [`Annotation::set_position`]).
    /// - `end: Some(end)` → **reshape**: `position`, `end`, and `z` are placed
    ///   exactly — the two opposite corners are set independently, no rigid
    ///   translate (see [`Annotation::set_vertices`]). This is the resize path.
    ///
    /// Pure delegation either way: locate the pin via the shared
    /// [`Self::annotation_mut`] lookup, then hand the mutation to the matching
    /// owner on `Annotation` (so the same geometry applies in 2D and 3D). Moving
    /// a missing pin or dataset is a clean no-op — it must NOT create a phantom
    /// pin (a move acts on an existing pin, never a way to mint one). The pin's
    /// author, kind, and comment thread are preserved.
    pub fn move_annotation(
        &mut self,
        dataset_id: &DatasetId,
        id: &str,
        position: [f64; 2],
        end: Option<[f64; 2]>,
        z: f64,
    ) {
        if let Some(annotation) = self.annotation_mut(dataset_id, id) {
            match end {
                Some(end) => annotation.set_vertices(position, end, z),
                None => annotation.set_position(position, z),
            }
        }
    }

    /// Add (or replace) a comment on the pin `annotation_id` under `dataset_id`.
    ///
    /// Pure delegation: locate the pin, then hand the dedup + insertion-order
    /// invariants to [`Annotation::add_comment`]. Adding a comment to a missing
    /// annotation or dataset is a clean no-op — it must NOT create a phantom pin
    /// (comments are content *on* an existing pin, never a way to mint one).
    pub fn add_comment(&mut self, dataset_id: &DatasetId, annotation_id: &str, comment: Comment) {
        if let Some(annotation) = self.annotation_mut(dataset_id, annotation_id) {
            annotation.add_comment(comment);
        }
    }

    /// Remove a comment by `comment_id` from the pin `annotation_id` under
    /// `dataset_id`. No-op if the dataset, pin, or comment id is unknown (so a
    /// duplicate/late removal is harmless). Delegates the actual removal to
    /// [`Annotation::remove_comment`].
    pub fn remove_comment(
        &mut self,
        dataset_id: &DatasetId,
        annotation_id: &str,
        comment_id: &str,
    ) {
        if let Some(annotation) = self.annotation_mut(dataset_id, annotation_id) {
            annotation.remove_comment(comment_id);
        }
    }

    /// Overwrite the `text` of the comment `comment_id` on the pin
    /// `annotation_id` under `dataset_id`.
    ///
    /// Pure delegation: locate the pin via the shared [`Self::annotation_mut`]
    /// lookup, then hand the edit to [`Annotation::edit_comment`]. Editing a
    /// comment on a missing dataset, pin, or comment id is a clean no-op — it
    /// must NOT create a phantom pin or comment (an edit acts on an existing
    /// comment, never a way to mint one). The comment's `id`/`author` and its
    /// place in the thread are preserved.
    pub fn edit_comment(
        &mut self,
        dataset_id: &DatasetId,
        annotation_id: &str,
        comment_id: &str,
        text: String,
    ) {
        if let Some(annotation) = self.annotation_mut(dataset_id, annotation_id) {
            annotation.edit_comment(comment_id, text);
        }
    }

    /// Merge an [`AssetCatalogDelta`] into the catalog for `dataset_id`.
    ///
    /// Idempotent: re-applying the same delta is a no-op. Existing
    /// `ProxyAvailability` entries for an entity are merged by union of
    /// their `kinds` lists (preserving original order; new kinds appended
    /// at the end).
    pub fn apply_asset_catalog_delta(
        &mut self,
        dataset_id: DatasetId,
        delta: lucida_protocol::AssetCatalogDelta,
    ) {
        let catalog = self.asset_catalogs.entry(dataset_id).or_default();
        for mut incoming in delta.added {
            for footprint in &incoming.footprints {
                if !incoming.kinds.contains(&footprint.kind) {
                    incoming.kinds.push(footprint.kind);
                }
            }
            if let Some(existing) = catalog
                .entries
                .iter_mut()
                .find(|e| e.entity_id == incoming.entity_id)
            {
                for kind in incoming.kinds {
                    if !existing.kinds.contains(&kind) {
                        existing.kinds.push(kind);
                    }
                }
                for footprint in incoming.footprints {
                    if !existing.kinds.contains(&footprint.kind) {
                        existing.kinds.push(footprint.kind);
                    }
                    if let Some(existing_footprint) = existing
                        .footprints
                        .iter_mut()
                        .find(|candidate| candidate.kind == footprint.kind)
                    {
                        *existing_footprint = footprint;
                    } else {
                        existing.footprints.push(footprint);
                    }
                }
            } else {
                catalog.entries.push(incoming);
            }
        }
    }

    /// Pick the plate entity a freshly-dropped pin should be glued to: the entity
    /// **nearest** to `position` (Euclidean) in `dataset_id`'s currently-resolved
    /// active layout (issue #780).
    ///
    /// Returns `None` — leaving the pin unanchored — when the dataset is not a
    /// plate, is unknown, or has no entity with a resolvable position in the active
    /// layout. Only entities that are actually placed (directly, or as a field via
    /// a placed parent) are candidates; an unplaceable entity is never treated as
    /// if it sat at the origin (that is the whole point of using
    /// [`resolve_entity_position`] rather than the render-path fallback).
    ///
    /// Determinism: ties (equal distance) are broken by **manifest entity order** —
    /// the iteration walks `entities()` in order and only adopts a strictly-closer
    /// candidate, so the first-listed of any tie wins. Both the server and every
    /// client derive the same anchor from the same synced state, so the choice is
    /// convergent without traveling on the wire.
    fn nearest_anchor(&self, dataset_id: &DatasetId, position: [f64; 2]) -> Option<EntityId> {
        let manifest = self.manifests.get(dataset_id)?;
        // Anchoring is plate-only (issue #780): a single-image dataset has no
        // well/field to glue to, and its lone image doesn't move between layouts.
        if !matches!(manifest.kind, DatasetKind::Plate { .. }) {
            return None;
        }

        let layout = crate::scene::resolve_layout(
            manifest,
            self.registered_layouts.get(dataset_id),
            self.active_layout_ids.get(dataset_id),
        );

        let mut best: Option<(EntityId, f64)> = None;
        for entity in manifest.entities() {
            let Some(pos) = crate::scene::resolve_entity_position(
                &entity.id,
                &layout,
                manifest.entities(),
                manifest.transforms(),
            ) else {
                continue;
            };
            let dx = pos[0] - position[0];
            let dy = pos[1] - position[1];
            let dist2 = dx * dx + dy * dy;
            // Strictly-less keeps the FIRST entity (in manifest order) on a tie,
            // making the tiebreak deterministic across server and all clients.
            if best.as_ref().is_none_or(|(_, b)| dist2 < *b) {
                best = Some((entity.id.clone(), dist2));
            }
        }

        best.map(|(id, _)| id)
    }

    /// Re-anchor every anchored pin in `dataset_id` for a layout change from
    /// `from_id` to `to_id` (issue #780).
    ///
    /// For each pin with an anchor `e`, the whole shape is translated rigidly by
    /// `delta = pos(e, to) − pos(e, from)` — `position += delta` and, for a
    /// line/box, `end += delta` too — exactly the rigid translate
    /// [`Annotation::set_position`] performs for a drag. `z` is untouched (layouts
    /// are 2-D in-plane). A pin whose anchor doesn't move has a zero delta and so
    /// stays put; an unanchored pin (`anchor == None`) is left entirely alone, as
    /// is one whose anchor isn't placed in *both* layouts (defensive — no phantom
    /// `[0, 0]` jump).
    ///
    /// The caller MUST pass the **previous** active layout id as `from_id`, read
    /// before `active_layout_ids` is overwritten, so the `from` positions are
    /// correct.
    fn reanchor_for_layout(
        &mut self,
        dataset_id: &DatasetId,
        from_id: Option<&LayoutId>,
        to_id: &LayoutId,
    ) {
        let Some(manifest) = self.manifests.get(dataset_id) else {
            return;
        };
        // Nothing to do (and nothing changed) if the layout didn't actually move.
        if from_id == Some(to_id) {
            return;
        }
        let Some(pins) = self.annotations.get_mut(dataset_id) else {
            return;
        };
        if pins.iter().all(|p| p.anchor.is_none()) {
            return;
        }

        let registered = self.registered_layouts.get(dataset_id);
        let from_layout = crate::scene::resolve_layout(manifest, registered, from_id);
        let to_layout = crate::scene::resolve_layout(manifest, registered, Some(to_id));

        for pin in pins.iter_mut() {
            let Some(anchor) = pin.anchor.as_ref() else {
                continue;
            };
            // Skip a pin whose anchor isn't placed in BOTH layouts — translating
            // it would otherwise drag it toward a fallback origin in one of them.
            let (Some(from_pos), Some(to_pos)) = (
                crate::scene::resolve_entity_position(
                    anchor,
                    &from_layout,
                    manifest.entities(),
                    manifest.transforms(),
                ),
                crate::scene::resolve_entity_position(
                    anchor,
                    &to_layout,
                    manifest.entities(),
                    manifest.transforms(),
                ),
            ) else {
                continue;
            };
            let delta = [to_pos[0] - from_pos[0], to_pos[1] - from_pos[1]];
            // Whole-shape rigid translate (position + any second vertex); z is
            // an in-plane-invariant, so it is never touched here.
            pin.position[0] += delta[0];
            pin.position[1] += delta[1];
            if let Some(end) = pin.end.as_mut() {
                end[0] += delta[0];
                end[1] += delta[1];
            }
        }
    }

    /// Apply a document command directly. Used by the server to avoid
    /// constructing a full Scene for document mutations.
    pub fn apply(&mut self, cmd: DocumentCommand) {
        match cmd {
            DocumentCommand::DatasetOpened(event) => {
                let dataset_id = event.manifest.dataset_id.clone();
                self.register_dataset(event.manifest);
                // Seed the catalog from the open event.
                self.asset_catalogs.insert(dataset_id, event.catalog);
            }
            DocumentCommand::RemoveDataset { id } => {
                self.remove_dataset(&id);
            }
            DocumentCommand::RenameDataset { id, name } => {
                self.rename_dataset(&id, name);
            }
            DocumentCommand::RegisterLayout { dataset_id, layout } => {
                let layouts = self.registered_layouts.entry(dataset_id).or_default();
                if !layouts.iter().any(|l| l.id == layout.id) {
                    layouts.push(layout);
                }
            }
            DocumentCommand::SetActiveLayout {
                dataset_id,
                layout_id,
            } => {
                // Read the PREVIOUS active layout before overwriting it, so the
                // re-anchor's `from` positions are the layout being replaced. A
                // dataset with no active id yet resolves via the manifest default.
                let from_id = self.active_layout_ids.get(&dataset_id).cloned();
                // Re-anchor every glued pin by the displacement of its anchor
                // entity between the old and new layouts (issue #780). Done here in
                // the canonical apply path so it persists and reaches every peer.
                self.reanchor_for_layout(&dataset_id, from_id.as_ref(), &layout_id);
                self.active_layout_ids.insert(dataset_id, layout_id);
            }
            DocumentCommand::ApplyAssetCatalogDelta { dataset_id, delta } => {
                self.apply_asset_catalog_delta(dataset_id, delta);
            }
            DocumentCommand::AddAnnotation {
                dataset_id,
                id,
                position,
                end,
                z,
                t,
                c,
                author,
                kind,
                view,
            } => {
                // Glue the new pin to the nearest plate well/field in the resolved
                // active layout (issue #780), so a later layout switch moves it
                // with that entity. Computed here, inside the canonical apply, from
                // synced state — so the server and every client derive the SAME
                // anchor without it riding the `add_annotation` wire shape. `None`
                // for a non-plate dataset or when nothing is placeable.
                let anchor = self.nearest_anchor(&dataset_id, position);
                self.add_annotation(
                    dataset_id,
                    Annotation {
                        id,
                        position,
                        // Second vertex (line endpoint / box opposite corner).
                        // `None` for a point, or for a slice-1..4 command with
                        // no `end` field.
                        end,
                        z,
                        // The view's timepoint/channel at creation (the slice
                        // context the pin belongs to). Defaulted to 0 for an
                        // older command with no t/c field.
                        t,
                        c,
                        author,
                        kind,
                        // A freshly dropped pin starts with an empty thread.
                        // On a re-applied (duplicate) pin id, add_annotation
                        // preserves any thread already accrued on that pin.
                        comments: Vec::new(),
                        anchor,
                        // The author's captured view at creation. `None` for a
                        // command from a client that predates this slice. The
                        // command boxes the view to keep the enum small; the
                        // stored pin holds it unboxed, so unbox here.
                        //
                        // ENFORCE the documented "embedded view carries NO
                        // source URLs" guarantee (see the `Annotation::view`
                        // field doc + decision 0014): a well-behaved client
                        // already captures in workspace-dataset-id form (empty
                        // `datasets`), but a malformed/hostile command could
                        // smuggle source dataset URLs (incl. local `file:///`
                        // paths) in here, and storing them verbatim would leak
                        // them into broadcast/persisted document state. Strip
                        // `datasets` on every applied annotation so the
                        // invariant holds for ALL new pins (live + persisted +
                        // broadcast); the id-keyed fields that the restore path
                        // actually reads are untouched.
                        view: view.map(|v| {
                            let mut view = *v;
                            view.clear_source_urls();
                            view
                        }),
                    },
                );
            }
            DocumentCommand::RemoveAnnotation { dataset_id, id } => {
                self.remove_annotation(&dataset_id, &id);
            }
            DocumentCommand::MoveAnnotation {
                dataset_id,
                id,
                position,
                end,
                z,
            } => {
                self.move_annotation(&dataset_id, &id, position, end, z);
            }
            DocumentCommand::AddComment {
                dataset_id,
                annotation_id,
                id,
                author,
                text,
            } => {
                self.add_comment(&dataset_id, &annotation_id, Comment { id, author, text });
            }
            DocumentCommand::RemoveComment {
                dataset_id,
                annotation_id,
                id,
            } => {
                self.remove_comment(&dataset_id, &annotation_id, &id);
            }
            DocumentCommand::EditComment {
                dataset_id,
                annotation_id,
                id,
                text,
            } => {
                self.edit_comment(&dataset_id, &annotation_id, &id, text);
            }
        }
    }
}

/// Per-member output of chunk planning.
#[derive(Debug, Clone, Serialize)]
pub struct MemberChunkPlan {
    pub image_id: lucida_content::ImageId,
    pub position: [f64; 2],
    pub needed: Vec<ChunkCoord>,
    pub prefetch: Vec<ChunkCoord>,
}

#[cfg(test)]
mod annotation_view_tests {
    //! Slice 1 (annotation views): a pin captures its author's view at
    //! creation as an embedded [`SavedView`]. These lock the wire/blob
    //! contract — round-trip equality, strict backward-compat (a view-less
    //! pin is byte-identical to a pre-slice pin), the command carrying the
    //! view through to the stored pin, and the embedded view being in
    //! workspace-dataset-id form (no source URLs). They ship as permanent
    //! regression tests; see [[gotchas/scene-document-state-json-compat]].

    use super::*;
    use crate::saved_view::SavedView;

    /// A sample captured view in **workspace-dataset-id form**: its `datasets`
    /// Vec is intentionally EMPTY (no source URLs), exactly as `buildCapture`
    /// emits in `workspace-dataset-id` mode. Carries some non-default
    /// camera/slice/display state so equality is meaningful.
    fn workspace_view() -> SavedView {
        let mut v = SavedView::empty([1024, 768]);
        // datasets stays empty (workspace-dataset-id mode) — assert it below.
        v.view.t = 7;
        v.view.c = 2;
        v.view.set_z_range(10..15);
        v.display.contrast_min = 100.0;
        v.display.contrast_max = 5000.0;
        v
    }

    /// A bare point pin carrying a captured view, for blob round-trip tests.
    fn pin_with_view(view: Option<SavedView>) -> Annotation {
        Annotation {
            id: "pin-view".into(),
            position: [10.0, 20.0],
            end: None,
            z: 3.0,
            t: 7,
            c: 2,
            author: "alice".into(),
            kind: AnnotationKind::Point,
            comments: Vec::new(),
            anchor: None,
            view,
        }
    }

    /// (1) An `Annotation` carrying a captured view round-trips through
    /// `serde_json` (serialize → deserialize → `==`). Equality holds because
    /// `Annotation: PartialEq`, which in turn relies on `SavedView: PartialEq`.
    #[test]
    fn annotation_with_view_round_trips() {
        let pin = pin_with_view(Some(workspace_view()));
        let json = serde_json::to_string(&pin).unwrap();
        let back: Annotation = serde_json::from_str(&json).unwrap();
        assert_eq!(back, pin);
        // The view actually rode along (not silently dropped).
        assert!(back.view.is_some());
        assert_eq!(back.view.unwrap().view.t, 7);
    }

    /// (2a) Backward-compat: an annotation JSON written WITHOUT the `view` key
    /// deserializes with `view == None` — a pin persisted/broadcast before this
    /// slice still loads, no wire break.
    #[test]
    fn pin_without_view_key_deserializes_as_none() {
        // No `view` key — exactly what a pre-slice snapshot pin looks like.
        let json =
            r#"{"id":"pin-old","position":[3.0,4.0],"z":2.0,"author":"alice","kind":"point"}"#;
        let pin: Annotation = serde_json::from_str(json).unwrap();
        assert_eq!(pin.view, None);
    }

    /// (2b) Byte-compat: a pin with NO captured view serializes with NO `view`
    /// key, so a view-less pin is byte-identical to a pre-slice pin (the
    /// `skip_serializing_if = "Option::is_none"` guarantee).
    #[test]
    fn pin_without_view_serializes_without_view_key() {
        let pin = pin_with_view(None);
        let json = serde_json::to_string(&pin).unwrap();
        assert!(
            !json.contains("\"view\""),
            "a view-less pin must not emit a `view` key: {json}"
        );
    }

    /// (3) `AddAnnotation` carries the view through a serde round-trip AND
    /// `DocumentState::add_annotation` (via `apply`) stores it on the created
    /// pin. Also guards the "inbound command == rebroadcast" invariant: the
    /// command round-trips equality-preserving.
    #[test]
    fn add_annotation_command_carries_view_to_stored_pin() {
        let cmd = DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [1.0, 2.0],
            end: None,
            z: 0.0,
            t: 7,
            c: 2,
            author: "alice".into(),
            kind: AnnotationKind::Point,
            // The command boxes the view (keeps the enum small); the stored
            // pin holds it unboxed.
            view: Some(Box::new(workspace_view())),
        };

        // Equality-preserving serde round-trip (inbound command == its
        // rebroadcast). `DocumentCommand` is not `PartialEq`, so — like the
        // existing `add_annotation_broadcast_is_byte_identical_to_inbound_command`
        // test — assert byte-identity via the normalized JSON value: re-encoding
        // the parsed command must reproduce the original wire form, view and all.
        let json = serde_json::to_string(&cmd).unwrap();
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        let reser = serde_json::to_string(&parsed).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&json).unwrap(),
            serde_json::from_str::<serde_json::Value>(&reser).unwrap(),
        );
        // The view survived on the wire (not silently stripped).
        let v: serde_json::Value = serde_json::from_str(&reser).unwrap();
        assert_eq!(v["view"]["view"]["t"], 7);

        // Applying lands the view on the stored pin (Annotation: PartialEq).
        let mut doc = DocumentState::default();
        doc.apply(parsed);
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.view.as_ref(), Some(&workspace_view()));
    }

    /// (3c) ROOT-CAUSE GUARANTEE: applying an `AddAnnotation` whose embedded
    /// view carries source URLs (a malformed/hostile command — a well-behaved
    /// client captures in workspace-dataset-id form) stores a pin whose
    /// `view.datasets` is EMPTY, enforcing the documented "embedded view
    /// carries NO source URLs" invariant on the canonical apply path. The
    /// id-keyed fields the restore path actually reads (active_layouts /
    /// dataset_order / dataset_settings / auto_contrast) are PRESERVED — only
    /// the URL list is dropped.
    #[test]
    fn add_annotation_strips_embedded_view_source_urls_but_keeps_id_keyed_fields() {
        use lucida_content::LayoutId;

        let ds = DatasetId("wds-1".into());

        // A captured view that (wrongly) carries source URLs AND the id-keyed
        // fields the light restore depends on.
        let mut view = workspace_view();
        view.datasets.push("file:///private/secret.zarr".into());
        view.datasets.push("gs://corp/restricted.zarr".into());
        view.active_layouts
            .insert(ds.clone(), LayoutId("img".into()));
        view.dataset_order.push(ds.clone());
        view.dataset_settings
            .insert(ds.clone(), DatasetDisplaySettings::default());
        view.auto_contrast.insert(ds.clone(), false);

        let mut doc = DocumentState::default();
        doc.apply(DocumentCommand::AddAnnotation {
            dataset_id: ds.clone(),
            id: "pin-1".into(),
            position: [1.0, 2.0],
            end: None,
            z: 0.0,
            t: 7,
            c: 2,
            author: "alice".into(),
            kind: AnnotationKind::Point,
            view: Some(Box::new(view)),
        });

        let stored = doc.annotations[&ds][0]
            .view
            .as_ref()
            .expect("applied pin must carry its captured view");
        // The source-URL list was stripped — no leak into document state.
        assert!(
            stored.datasets.is_empty(),
            "AddAnnotation must store an embedded view with NO source URLs, got {:?}",
            stored.datasets
        );
        // The id-keyed fields the restore path reads are preserved verbatim.
        assert!(stored.active_layouts.contains_key(&ds));
        assert_eq!(stored.dataset_order, vec![ds.clone()]);
        assert!(stored.dataset_settings.contains_key(&ds));
        assert_eq!(stored.auto_contrast.get(&ds), Some(&false));
        // And the non-membership view state (slice/contrast) still rode along.
        assert_eq!(stored.view.t, 7);
        assert_eq!(stored.display.contrast_max, 5000.0);
    }

    /// (3b) An `add_annotation` command WITHOUT a `view` key parses with
    /// `view == None` (the additive backward-compat guarantee), and a command
    /// without a view serializes with no `view` key.
    #[test]
    fn add_annotation_view_defaults_to_none_and_is_skipped() {
        let json = r#"{"type":"add_annotation","dataset_id":"wds-1","id":"p","position":[3.0,4.0],"author":"alice","kind":"point"}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match &parsed {
            DocumentCommand::AddAnnotation { view, .. } => assert_eq!(*view, None),
            _ => panic!("expected AddAnnotation"),
        }
        let reser = serde_json::to_string(&parsed).unwrap();
        assert!(
            !reser.contains("\"view\""),
            "a view-less add_annotation must not emit a `view` key: {reser}"
        );
    }

    /// (4) The captured view, as embedded, is in workspace-dataset-id form:
    /// its `datasets` is EMPTY, so embedding a view on a pin never leaks
    /// dataset source URLs onto the document wire.
    #[test]
    fn embedded_view_is_workspace_dataset_id_form_no_source_urls() {
        let pin = pin_with_view(Some(workspace_view()));
        let json = serde_json::to_string(&pin).unwrap();
        let back: Annotation = serde_json::from_str(&json).unwrap();
        let view = back.view.expect("pin should carry a view");
        assert!(
            view.datasets.is_empty(),
            "embedded view must carry no source URLs (workspace-dataset-id form)"
        );
        // And the serialized blob carries an empty datasets array, not URLs.
        assert!(
            !json.contains("zarr") && !json.contains("gs://") && !json.contains("s3://"),
            "no dataset source URL should appear in a pin's serialized view: {json}"
        );
    }

    /// `DocumentState::remap_dataset_ids` moves every dataset-id-keyed map AND
    /// the embedded `manifest.dataset_id` onto the new id. This is the
    /// workspace-duplicate id-consistency contract: a document copied verbatim
    /// would reference the source workspace's ids; after remap it must resolve
    /// entirely against the copy's fresh ids, with no trace of the old id left.
    #[test]
    fn remap_dataset_ids_rewrites_every_keyed_map_and_manifest_id() {
        use lucida_content::{DatasetKind, LayoutId, LayoutSpec};

        let old = DatasetId("wds-old".into());
        let new = DatasetId("wds-new".into());

        let mut doc = DocumentState::default();
        let manifest = lucida_content::DatasetManifest::new(
            old.clone(),
            "Sample".into(),
            DatasetKind::Single,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
        );
        doc.register_dataset(manifest);
        doc.registered_layouts.insert(
            old.clone(),
            vec![LayoutSpec {
                id: LayoutId("img".into()),
                name: "Image".into(),
                placements: Vec::new(),
            }],
        );
        doc.active_layout_ids
            .insert(old.clone(), LayoutId("img".into()));
        doc.asset_catalogs
            .insert(old.clone(), AssetCatalog::empty());
        doc.add_annotation(old.clone(), pin_with_view(None));

        let mut remap = HashMap::new();
        remap.insert(old.clone(), new.clone());
        doc.remap_dataset_ids(&remap);

        // Every map is now keyed by the new id, and the old id is gone.
        assert!(doc.manifests.contains_key(&new));
        assert!(!doc.manifests.contains_key(&old));
        assert!(doc.registered_layouts.contains_key(&new));
        assert!(!doc.registered_layouts.contains_key(&old));
        assert!(doc.active_layout_ids.contains_key(&new));
        assert!(!doc.active_layout_ids.contains_key(&old));
        assert!(doc.asset_catalogs.contains_key(&new));
        assert!(!doc.asset_catalogs.contains_key(&old));
        assert!(doc.annotations.contains_key(&new));
        assert!(!doc.annotations.contains_key(&old));
        // The embedded id inside the manifest moved too (not just the map key).
        assert_eq!(doc.manifests.get(&new).unwrap().dataset_id, new);
    }

    /// `remap_dataset_ids` descends into each annotation's captured author view
    /// (`Annotation::view`) and remaps its workspace-dataset-id-keyed maps too —
    /// not just the `annotations` map key. Without this an embedded view in a
    /// duplicated workspace would still point at the SOURCE workspace's ids
    /// (dangling), so a copied pin's "go to author's view" would silently lose
    /// its per-channel colors/contrast. Builds an annotation whose `view` is
    /// keyed by the source id, remaps source→copy, and asserts the embedded view
    /// now references the COPY id with NO source id left in any of its
    /// id-keyed fields (active_layouts / dataset_order / dataset_settings /
    /// auto_contrast).
    #[test]
    fn remap_dataset_ids_remaps_embedded_annotation_view() {
        use lucida_content::LayoutId;

        let old = DatasetId("wds-old".into());
        let new = DatasetId("wds-new".into());

        // A captured view keyed by the SOURCE id across every id-keyed field.
        let mut view = workspace_view();
        view.active_layouts
            .insert(old.clone(), LayoutId("img".into()));
        view.dataset_order.push(old.clone());
        view.dataset_settings
            .insert(old.clone(), DatasetDisplaySettings::default());
        view.auto_contrast.insert(old.clone(), false);

        let mut doc = DocumentState::default();
        doc.add_annotation(old.clone(), pin_with_view(Some(view)));

        let mut remap = HashMap::new();
        remap.insert(old.clone(), new.clone());
        doc.remap_dataset_ids(&remap);

        // The annotations map key moved (existing contract).
        assert!(doc.annotations.contains_key(&new));
        assert!(!doc.annotations.contains_key(&old));

        // The embedded captured view moved too — the whole point of this test.
        let embedded = doc.annotations[&new][0]
            .view
            .as_ref()
            .expect("annotation must still carry its captured view");
        assert!(embedded.active_layouts.contains_key(&new));
        assert!(!embedded.active_layouts.contains_key(&old));
        assert_eq!(embedded.dataset_order, vec![new.clone()]);
        assert!(embedded.dataset_settings.contains_key(&new));
        assert!(!embedded.dataset_settings.contains_key(&old));
        assert!(embedded.auto_contrast.contains_key(&new));
        assert!(!embedded.auto_contrast.contains_key(&old));
    }

    /// An id absent from the remap is left untouched (safe no-op), so a partial
    /// map never corrupts unrelated datasets.
    #[test]
    fn remap_dataset_ids_leaves_unmapped_ids_unchanged() {
        let kept = DatasetId("wds-kept".into());
        let mut doc = DocumentState::default();
        doc.active_layout_ids
            .insert(kept.clone(), lucida_content::LayoutId("x".into()));
        doc.remap_dataset_ids(&HashMap::new());
        assert!(doc.active_layout_ids.contains_key(&kept));
    }

    /// Build a `DocumentState` with `id` present in EVERY dataset-id-keyed
    /// field — the five id-keyed maps plus the manifest's embedded
    /// `dataset_id`. Used by the `remove_dataset` coverage tests so a future
    /// id-keyed field that isn't wired into the single-source walk surfaces as
    /// a leftover.
    fn doc_with_id_in_every_field(id: &DatasetId) -> DocumentState {
        use lucida_content::{DatasetKind, LayoutId, LayoutSpec};

        let mut doc = DocumentState::default();
        let manifest = lucida_content::DatasetManifest::new(
            id.clone(),
            "Sample".into(),
            DatasetKind::Single,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
        );
        doc.register_dataset(manifest);
        doc.registered_layouts.insert(
            id.clone(),
            vec![LayoutSpec {
                id: LayoutId("img".into()),
                name: "Image".into(),
                placements: Vec::new(),
            }],
        );
        doc.active_layout_ids
            .insert(id.clone(), LayoutId("img".into()));
        doc.asset_catalogs.insert(id.clone(), AssetCatalog::empty());
        doc.add_annotation(id.clone(), pin_with_view(None));
        doc
    }

    /// `DocumentState::remove_dataset` clears the removed id from **every**
    /// id-keyed field — including `registered_layouts` and `active_layout_ids`,
    /// which the pre-refactor implementation left orphaned (the bug this slice
    /// fixes). A second, unrelated dataset is fully preserved, proving removal
    /// targets only the requested id.
    #[test]
    fn remove_dataset_clears_id_from_all_id_keyed_fields() {
        use lucida_content::{DatasetKind, LayoutId, LayoutSpec};

        let gone = DatasetId("wds-gone".into());
        let kept = DatasetId("wds-kept".into());

        let mut doc = doc_with_id_in_every_field(&gone);
        // A second dataset that must survive the removal untouched.
        doc.register_dataset(lucida_content::DatasetManifest::new(
            kept.clone(),
            "Kept".into(),
            DatasetKind::Single,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
        ));
        doc.registered_layouts.insert(
            kept.clone(),
            vec![LayoutSpec {
                id: LayoutId("img".into()),
                name: "Image".into(),
                placements: Vec::new(),
            }],
        );
        doc.active_layout_ids
            .insert(kept.clone(), LayoutId("img".into()));
        doc.asset_catalogs
            .insert(kept.clone(), AssetCatalog::empty());
        doc.add_annotation(kept.clone(), pin_with_view(None));

        doc.remove_dataset(&gone);

        // The removed id is gone from every id-keyed field — the previously
        // ORPHANED `registered_layouts` / `active_layout_ids` are asserted
        // explicitly (they are the bug fix), alongside the fields removal
        // already cleared.
        assert!(!doc.manifests.contains_key(&gone));
        assert!(
            !doc.registered_layouts.contains_key(&gone),
            "remove_dataset must clear registered_layouts (was orphaned)"
        );
        assert!(
            !doc.active_layout_ids.contains_key(&gone),
            "remove_dataset must clear active_layout_ids (was orphaned)"
        );
        assert!(!doc.asset_catalogs.contains_key(&gone));
        assert!(!doc.annotations.contains_key(&gone));

        // The unrelated dataset is fully intact across every field.
        assert!(doc.manifests.contains_key(&kept));
        assert!(doc.registered_layouts.contains_key(&kept));
        assert!(doc.active_layout_ids.contains_key(&kept));
        assert!(doc.asset_catalogs.contains_key(&kept));
        assert!(doc.annotations.contains_key(&kept));
    }

    /// Coverage guard for the single-source [`DocumentState::rekey_dataset_ids`]
    /// walk: removing the only dataset present in EVERY id-keyed field must
    /// leave the whole document empty. If a future id-keyed field is added to
    /// `DocumentState` but not wired into `rekey_dataset_ids`, that field will
    /// still reference the removed id and this test fails — making the
    /// single-source invariant enforced, not just documented.
    #[test]
    fn rekey_dataset_ids_covers_every_id_keyed_field() {
        let id = DatasetId("wds-only".into());
        let mut doc = doc_with_id_in_every_field(&id);

        doc.remove_dataset(&id);

        assert!(doc.manifests.is_empty());
        assert!(doc.registered_layouts.is_empty());
        assert!(doc.active_layout_ids.is_empty());
        assert!(doc.asset_catalogs.is_empty());
        assert!(doc.annotations.is_empty());
    }

    /// DETERMINISM GUARD: a remap (middle rename) and a removal (middle drop)
    /// must preserve the **iteration order** of the id-keyed `IndexMap` fields
    /// (`manifests`, `asset_catalogs`, `annotations`) — not merely their
    /// membership. These maps are `IndexMap` *specifically* to guarantee
    /// byte-identical serialization order on the collaborative-document wire (a
    /// determinism invariant); the sibling `remap`/`remove` tests above assert
    /// only `contains_key`, so a future change that round-tripped one of these
    /// fields through a `HashMap` would silently scramble wire order yet pass
    /// every other test. This locks position, not just presence.
    ///
    /// Both halves rename/remove a **middle** entry (B) of a known A, B, C
    /// insertion order so the assertion is non-vacuous: a sorted or
    /// reordered rebuild would land B (or B') somewhere other than the middle
    /// slot and fail. A membership-only check could not catch that.
    #[test]
    fn rekey_dataset_ids_preserves_index_map_iteration_order() {
        use lucida_content::DatasetKind;

        let a = DatasetId("wds-a".into());
        let b = DatasetId("wds-b".into());
        let c = DatasetId("wds-c".into());
        let b_prime = DatasetId("wds-b-prime".into());

        // Seed a doc with A, B, C inserted in that exact order across the three
        // order-bearing IndexMap fields.
        fn seed(ids: &[&DatasetId]) -> DocumentState {
            let mut doc = DocumentState::default();
            for id in ids {
                doc.register_dataset(lucida_content::DatasetManifest::new(
                    (*id).clone(),
                    "Sample".into(),
                    DatasetKind::Single,
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    None,
                ));
                doc.asset_catalogs
                    .insert((*id).clone(), AssetCatalog::empty());
                doc.add_annotation((*id).clone(), pin_with_view(None));
            }
            doc
        }

        // --- Remap case: rename the MIDDLE entry B -> B', leave A and C ---
        let mut doc = seed(&[&a, &b, &c]);
        let mut remap = HashMap::new();
        remap.insert(b.clone(), b_prime.clone());
        doc.remap_dataset_ids(&remap);

        // B is replaced IN PLACE by B' — A and C keep their original slots, so
        // the order is exactly [A, B', C], not reordered (and not sorted, which
        // would be [A, B', C] only by accident — see the removal half below for
        // the order-sensitive check that a sort could not satisfy).
        let expected = vec![a.clone(), b_prime.clone(), c.clone()];
        assert_eq!(doc.manifests.keys().cloned().collect::<Vec<_>>(), expected);
        assert_eq!(
            doc.asset_catalogs.keys().cloned().collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            doc.annotations.keys().cloned().collect::<Vec<_>>(),
            expected,
        );
        // The embedded manifest id rode along with its in-place slot.
        assert_eq!(doc.manifests[&b_prime].dataset_id, b_prime);

        // --- Remove case: drop the MIDDLE entry B from a fresh A, B, C doc ---
        let mut doc = seed(&[&a, &b, &c]);
        doc.remove_dataset(&b);

        // The survivors keep their relative order: exactly [A, C]. A reordering
        // rebuild (e.g. via HashMap) could leave [C, A]; this asserts it does
        // not.
        let expected = vec![a.clone(), c.clone()];
        assert_eq!(doc.manifests.keys().cloned().collect::<Vec<_>>(), expected);
        assert_eq!(
            doc.asset_catalogs.keys().cloned().collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            doc.annotations.keys().cloned().collect::<Vec<_>>(),
            expected
        );
    }
}
