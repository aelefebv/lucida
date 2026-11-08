use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use indexmap::IndexMap;
use lucida_content::{DatasetId, DatasetKind, DatasetManifest, EntityId, LayoutId, LayoutSpec};

use crate::chunk::ChunkCoord;
use crate::command::DocumentCommand;
use crate::view::LegacyChannels;

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
    /// The colormap channel `index` of `channel_count` opens with: gray for
    /// an image with one channel, else magenta, green and cyan in turn, so
    /// the channels of a composite stay apart.
    ///
    /// This seeds new views only. A saved view leaves out the colormaps of its
    /// own frozen table, not these, so changing this never changes how a
    /// stored view restores.
    pub fn default_for_channel(index: usize, channel_count: usize) -> Self {
        const CYCLE: [Colormap; 3] = [Colormap::Magenta, Colormap::Green, Colormap::Cyan];
        if channel_count == 1 {
            Colormap::Gray
        } else {
            CYCLE[index % CYCLE.len()]
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelSettings {
    pub visible: bool,
    pub colormap: Colormap,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
    /// Display name override for this channel. `None` falls back to the
    /// manifest's omero label, then `Channel n`, counted from 1. Like
    /// `colormap`, it rides saved views and presence but is not durable
    /// document state.
    ///
    /// The serde attributes keep it additive: a blob without `name` loads as
    /// `None`, and a channel with no override serializes without the key.
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

/// Per-label overlay display state: whether a label mask is drawn and how
/// strongly it composites over the intensity image. Like [`ChannelSettings`],
/// it rides presence and saved views but is not durable document state.
///
/// Masks are opt-in: `visible` defaults to `false`, so a freshly opened
/// dataset shows no label overlays, and a mask turned on composites at `0.5`.
/// An explicit on/off the user records is honored verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelSettings {
    pub visible: bool,
    pub opacity: f32,
}

impl Default for LabelSettings {
    fn default() -> Self {
        Self {
            visible: false,
            opacity: 0.5,
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
    /// Per-label overlay settings in manifest (OME `labels`) order: index `i`
    /// controls the `i`-th attached label. `#[serde(default)]` loads a blob
    /// without the key as an empty Vec, which the render path treats as every
    /// mode-eligible mask at the default opacity.
    #[serde(default)]
    pub label_settings: Vec<LabelSettings>,
    #[serde(default = "default_channel_blend_mode")]
    pub channel_blend_mode: BlendMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_level_override: Option<u32>,
    /// The author's label names at capture time, parallel to `label_settings`.
    /// They let [`Self::reconcile_label_settings`] place each saved entry on
    /// the matching current label by name when the recipient's label list is
    /// reordered, grown, shrunk, or repeats names.
    ///
    /// The serde attributes keep it additive: a blob without `label_names`
    /// loads as empty, which reconcile treats as positional, and a blob with no
    /// labels serializes without the key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub label_names: Vec<String>,
    /// The one channel this layer shows alone, or `None` for the composite of
    /// its visible channels. Solo never touches the `visible` flags, so leaving
    /// it returns the composite exactly as it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solo: Option<u32>,
}

impl DatasetDisplaySettings {
    /// The channels this layer shows out of `channel_count`, ascending: the
    /// solo when it names one of them, else every visible channel. A channel
    /// with no settings entry is visible. When none is visible the first one
    /// shows, since the layer panel never lets the last one go dark.
    pub fn shown_channels(&self, channel_count: u32) -> Vec<u32> {
        if let Some(solo) = self.solo
            && solo < channel_count
        {
            return vec![solo];
        }
        let shown: Vec<u32> = (0..channel_count)
            .filter(|&c| {
                self.channel_settings
                    .get(c as usize)
                    .is_none_or(|s| s.visible)
            })
            .collect();
        if shown.is_empty() { vec![0] } else { shown }
    }

    /// Set this layer's solo from the scene-wide mode of a view recorded
    /// before solo was per layer. A solo lands only on a layer that has that
    /// channel and others beside it; every other layer shows its composite.
    pub fn adopt_legacy_channels(&mut self, legacy: LegacyChannels, channel_count: u32) {
        self.solo = match legacy {
            LegacyChannels::Solo(c) if channel_count > 1 && c < channel_count => Some(c),
            _ => None,
        };
    }

    /// Get a mutable reference to channel settings at the given index of a
    /// layer with `channel_count` channels, growing the vec with defaults if
    /// needed.
    pub fn ensure_channel(&mut self, index: usize, channel_count: usize) -> &mut ChannelSettings {
        while self.channel_settings.len() <= index {
            let i = self.channel_settings.len();
            self.channel_settings.push(ChannelSettings {
                colormap: Colormap::default_for_channel(i, channel_count),
                ..Default::default()
            });
        }
        &mut self.channel_settings[index]
    }

    /// Get a mutable reference to label settings at the given index, growing
    /// the vec with hidden defaults if needed. Callers bound the index to the
    /// dataset's real label count first (see the `SetLabel*` apply arms), so a
    /// stray index cannot balloon the vec. Growing never overwrites an existing
    /// entry, so an explicit on survives, and opacity alone never reveals a
    /// mask.
    pub fn ensure_label(&mut self, index: usize) -> &mut LabelSettings {
        while self.label_settings.len() <= index {
            self.label_settings.push(LabelSettings::default());
        }
        &mut self.label_settings[index]
    }

    /// Build the complete default display settings for a freshly opened or
    /// restored dataset: one channel entry per channel (in
    /// [`Colormap::default_for_channel`]) and one label entry per attached
    /// label. Both the `DatasetOpened` apply path and `load_document` seed
    /// from here, because the layer panel and render path need full-length
    /// `channel_settings` and `label_settings` however the dataset entered
    /// the scene.
    ///
    /// Every label seeds hidden at opacity 0.5, since masks are opt-in. This
    /// default is mode-agnostic: once the user turns masks on, the web
    /// `resolveVisibleLabels` filters them by device limits and the 3D memory
    /// guard caps how many volume textures show at once.
    pub fn seeded_for(manifest: &DatasetManifest) -> Self {
        let channel_count = manifest
            .images()
            .first()
            .and_then(|img| img.multiscale.levels.first())
            .map(|l| l.shape[1] as usize)
            .unwrap_or(1);
        let labels = manifest.label_specs();
        Self {
            channel_settings: (0..channel_count)
                .map(|i| ChannelSettings {
                    colormap: Colormap::default_for_channel(i, channel_count),
                    ..Default::default()
                })
                .collect(),
            label_settings: labels
                .iter()
                .map(|_| LabelSettings {
                    visible: false,
                    opacity: 0.5,
                })
                .collect(),
            // Stamp the label names next to the settings so an adopter can key
            // by name.
            label_names: labels.iter().map(|l| l.name.clone()).collect(),
            ..Default::default()
        }
    }

    /// Remap a saved per-label settings list onto a recipient's current label
    /// order, keyed by label name and aware of repeated names. The result is
    /// aligned to `current_names`.
    ///
    /// - `author_names` empty: positional. A blob captured before label names
    ///   were recorded can only map by index.
    /// - `author_names` non-empty: name-keyed. `saved` is parallel to
    ///   `author_names`. The `k`-th current label named `N` takes the `k`-th
    ///   saved entry whose author name is `N`, so two labels both called
    ///   `region-a` do not collapse onto the author's first one.
    ///
    /// A current label the save never addressed takes
    /// [`LabelSettings::default`] (hidden). A matched label restores its saved
    /// entry verbatim.
    pub fn reconcile_label_settings(
        saved: &[LabelSettings],
        author_names: &[String],
        current_names: &[String],
    ) -> Vec<LabelSettings> {
        if author_names.is_empty() {
            // No names to key on, so map by position.
            return (0..current_names.len())
                .map(|i| saved.get(i).cloned().unwrap_or_default())
                .collect();
        }

        // For each name, how many current labels of that name we have already
        // placed — so the k-th current occurrence claims the k-th author entry.
        let mut occurrences_taken: HashMap<&str, usize> = HashMap::new();
        current_names
            .iter()
            .map(|name| {
                let want = occurrences_taken.entry(name.as_str()).or_insert(0);
                let target_occurrence = *want;
                *want += 1;

                // Walk the author's names in order; the `target_occurrence`-th
                // entry whose name matches supplies this current label's saved
                // settings (via the positionally-parallel `saved`).
                let mut matched = 0usize;
                for (author_index, author_name) in author_names.iter().enumerate() {
                    if author_name == name {
                        if matched == target_occurrence {
                            // A malformed blob may lack the parallel `saved`
                            // slot; treat it as never addressed.
                            return saved.get(author_index).cloned().unwrap_or_default();
                        }
                        matched += 1;
                    }
                }
                // The save never addressed this label.
                LabelSettings::default()
            })
            .collect()
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
            label_names: Vec::new(),
            solo: None,
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
/// - `Point`: a single pin at `position`. The default, so a command or blob
///   with no `kind` loads as a point.
/// - `Line`: a segment from `position` to `end`.
/// - `Box`: an axis-aligned rectangle whose opposite corners are `position`
///   and `end`.
///
/// `Line`/`Box` carry their second vertex in [`Annotation::end`]; a `Point`
/// leaves `end` `None`.
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
/// The `id` is client-supplied (a uuid string) so an inbound `add_comment`
/// and its rebroadcast are byte-identical and apply identically on every
/// peer. Comments nest on the annotation, so they ride the pin's snapshot,
/// broadcast, and persistence, and go away with the pin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub text: String,
}

/// A single collaborative annotation: a marker anchored to a position in
/// 2D world space (the same frame `centroidWorld`/layout positions use) so
/// it stays glued to the data for every peer regardless of their viewport.
///
/// The `id` is client-supplied (a uuid string) so an inbound command and
/// its rebroadcast are byte-identical and apply identically on every peer.
/// Apply is idempotent on a repeated `id` (last write wins; see
/// [`DocumentState::add_annotation`]).
///
/// Every field but `id`, `position`, and `author` is `#[serde(default)]`, so
/// pins persisted or broadcast without the newer fields still load.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Annotation {
    pub id: String,
    /// In-plane world-space position `[x, y]`.
    pub position: [f64; 2],
    /// Depth in the same world frame as `position`, so the pin's world point
    /// is `(position[0], position[1], z)`. A separate scalar rather than a
    /// wider `position` keeps the wire compatible: pins without `z` load at
    /// `z = 0.0`.
    #[serde(default)]
    pub z: f64,
    /// The timepoint (T) the pin was placed on, the view's `t` at creation.
    /// Unlike `z`, `t` is a discrete view selector: the pin belongs to the
    /// timepoint it was dropped on, and the overlay dims it off-context when
    /// the current view differs.
    #[serde(default)]
    pub t: i64,
    /// A channel the pin's layer showed when it was placed. A pin with a
    /// [`Self::view`] takes every channel shown then from it instead; see
    /// [`Self::placement_channels`].
    #[serde(default)]
    pub c: i64,
    pub author: String,
    #[serde(default)]
    pub kind: AnnotationKind,
    /// The second in-plane world-space vertex: a line's far endpoint, or a
    /// box's opposite corner. `None` for a `Point`. Both vertices share `z`.
    #[serde(default)]
    pub end: Option<[f64; 2]>,
    /// Flat, ordered comment thread on this pin. Owns its dedup/order
    /// invariants via [`Annotation::add_comment`] / [`Annotation::remove_comment`].
    #[serde(default)]
    pub comments: Vec<Comment>,
    /// The collection entity (group or tile) this pin is glued to. Set once in
    /// [`DocumentState::apply`] for `AddAnnotation`, to the nearest placeable
    /// entity in the active layout (see [`DocumentState::nearest_anchor`]).
    /// `None` for a non-collection dataset or when no entity position resolves;
    /// an unanchored pin stays put on a layout switch.
    ///
    /// When the active layout changes, an anchored pin's whole shape moves by
    /// this entity's displacement (see [`DocumentState::reanchor_for_layout`]),
    /// so the pin stays on the data it was dropped on in every layout.
    #[serde(default)]
    pub anchor: Option<EntityId>,
    /// The author's view when they dropped this pin (camera, slice, timepoint,
    /// channel, per-dataset display), so navigation can restore it.
    ///
    /// Captured in workspace-dataset-id form with an empty `datasets` Vec, so a
    /// view on a pin never leaks source URLs into broadcast or persisted
    /// document state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<crate::saved_view::SavedView>,
}

impl Annotation {
    /// The channels the pin's layer showed when it was placed, read from the
    /// layer's entry in the captured view. A pin without one, or whose entry
    /// lists no channels, belongs to `c` alone.
    pub fn placement_channels(&self, dataset_id: &DatasetId) -> Vec<u32> {
        let settings = self
            .view
            .as_ref()
            .and_then(|view| view.dataset_settings.get(dataset_id))
            .filter(|settings| !settings.channel_settings.is_empty());
        match settings {
            Some(settings) => settings.shown_channels(settings.channel_settings.len() as u32),
            None => vec![self.c.clamp(0, u32::MAX as i64) as u32],
        }
    }

    /// The in-plane world-space vertices of this annotation's shape, in draw
    /// order. The 2D and 3D overlays both project these per vertex, so the
    /// per-kind layout lives here rather than in each renderer.
    ///
    /// - Point: `[position]`.
    /// - Line: `[position, end]`.
    /// - Box: the four corners, wound `position → (end.x, position.y) → end →
    ///   (position.x, end.y)`. Four corners rather than two so each projects
    ///   through the volume transform in 3D; a screen-space rect built from two
    ///   projected corners would shear as the camera orbits.
    ///
    /// A `Line`/`Box` with no `end` collapses to `position`, so the shape always
    /// has at least one vertex.
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
    /// Last write wins on a repeated comment `id`: it replaces that comment in
    /// place, so a replayed or twice-delivered `add_comment` keeps every peer
    /// convergent. Distinct ids append in insertion order.
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

    /// Reposition this pin, moving the whole shape rigidly.
    ///
    /// `position`/`z` become the anchor vertex, and any `end` moves by the same
    /// in-plane delta, so a line keeps its length and angle and a box keeps its
    /// size. Depth `z` is shared by both vertices, so it is a plain overwrite.
    /// Every other field is left untouched.
    pub fn set_position(&mut self, position: [f64; 2], z: f64) {
        // Read the delta before overwriting `position`, or it is always zero.
        let [dx, dy] = [
            position[0] - self.position[0],
            position[1] - self.position[1],
        ];
        self.position = position;
        self.z = z;
        if let Some(end) = self.end.as_mut() {
            end[0] += dx;
            end[1] += dy;
        }
    }

    /// Reshape this annotation by setting both opposite vertices explicitly,
    /// the resize sibling of [`Self::set_position`].
    ///
    /// No delta math: `position` and `end` take the given values, so a corner
    /// or edge handle can grow, shrink, or flip the shape about a held corner.
    /// A `Point` only moves its anchor and `z`. Every other field is preserved,
    /// and re-applying the same vertices is a no-op, so a replayed reshape
    /// stays convergent across peers.
    pub fn set_vertices(&mut self, position: [f64; 2], end: [f64; 2], z: f64) {
        self.position = position;
        self.z = z;
        // A resize never mints a second vertex on a point; that would change
        // the pin's kind out from under it.
        if self.end.is_some() {
            self.end = Some(end);
        }
    }

    /// Overwrite an existing comment's `text` by `id`. Returns `true` if a
    /// comment matched. An unknown id is a no-op, so an edit never appends a
    /// phantom comment. Only the text changes.
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
    /// Per-dataset collaborative annotations, keyed by dataset id. Populated
    /// via `DocumentCommand::AddAnnotation` / `RemoveAnnotation`.
    #[serde(default)]
    pub annotations: IndexMap<DatasetId, Vec<Annotation>>,
}

impl DocumentState {
    /// Register (or replace) a dataset manifest by dataset id.
    pub fn register_dataset(&mut self, manifest: lucida_content::DatasetManifest) {
        self.manifests.insert(manifest.dataset_id.clone(), manifest);
    }

    /// The one place that lists which [`DocumentState`] fields are keyed by, or
    /// embed, a workspace-local [`DatasetId`]. Add any new id-keyed field here.
    ///
    /// For each entry it calls `fate(&old_key)`:
    ///
    /// - `Some(new_key)` keeps the entry, rekeyed, in insertion order.
    /// - `None` drops it.
    ///
    /// On kept entries it rewrites the manifest's own `dataset_id` and hands
    /// each annotation list to `on_kept_annotations`, so a caller can fix the
    /// id-keyed maps inside each pin's [`Annotation::view`].
    ///
    /// [`Self::remap_dataset_ids`] and [`Self::remove_dataset`] both run on this
    /// so the fields they walk cannot diverge.
    /// `rekey_dataset_ids_covers_every_id_keyed_field` fails if a new id-keyed
    /// field is not wired in.
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
        rekey(&mut self.annotations, &fate, |new_id, anns| {
            on_kept_annotations(new_id, anns);
        });
    }

    /// Rewrite every workspace-local [`DatasetId`] in the document through
    /// `remap` (old id → new id), preserving insertion order.
    ///
    /// A duplicated workspace mints fresh dataset ids, so the copied document
    /// must be remapped to resolve against the copy's own
    /// `workspace_datasets`. This rewrites every id-keyed map, each manifest's
    /// own `dataset_id`, and each pin's captured
    /// [`SavedView`](crate::saved_view::SavedView), so a copied pin's "go to
    /// author's view" does not dangle. An id missing from `remap` is left
    /// unchanged.
    pub fn remap_dataset_ids(&mut self, remap: &HashMap<DatasetId, DatasetId>) {
        self.rekey_dataset_ids(
            |id| Some(remap.get(id).cloned().unwrap_or_else(|| id.clone())),
            |_new_id, anns| {
                for ann in anns {
                    if let Some(view) = ann.view.as_mut() {
                        view.remap_dataset_ids(remap);
                        // Older documents can hold pins whose view still has
                        // source URLs; the copy's views carry none.
                        view.clear_source_urls();
                    }
                }
            },
        );
    }

    /// Remove a dataset by id from every id-keyed field of the document: its
    /// manifest, registered layouts, active-layout id, asset catalog, and
    /// annotations, so nothing is left orphaned.
    pub fn remove_dataset(&mut self, id: &DatasetId) {
        self.rekey_dataset_ids(
            |candidate| {
                if candidate == id {
                    None
                } else {
                    Some(candidate.clone())
                }
            },
            |_new_id, _anns| {},
        );
    }

    /// Rename a dataset's display label in place by id. Overwrites only the
    /// manifest's `name`. An unknown `id` is a no-op, so a rename racing a
    /// removal never mints a phantom manifest.
    pub fn rename_dataset(&mut self, id: &DatasetId, name: String) {
        if let Some(manifest) = self.manifests.get_mut(id) {
            manifest.name = name;
        }
    }

    /// Add (or replace) an annotation under `dataset_id`.
    ///
    /// Last write wins on a repeated `id`: the annotation is replaced in place,
    /// so a replayed command keeps every peer convergent. Distinct ids append in
    /// insertion order.
    ///
    /// A replace keeps the pin's existing comment thread, so a replayed
    /// `add_annotation` does not wipe a discussion that has since accrued.
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

    /// Remove an annotation by id from `dataset_id`. An unknown dataset or id
    /// is a no-op, so a late removal is harmless. Drops the dataset's entry
    /// once it is empty.
    pub fn remove_annotation(&mut self, dataset_id: &DatasetId, id: &str) {
        if let Some(list) = self.annotations.get_mut(dataset_id) {
            list.retain(|a| a.id != id);
            if list.is_empty() {
                self.annotations.shift_remove(dataset_id);
            }
        }
    }

    /// Locate the pin `annotation_id` under `dataset_id` for mutation. Every
    /// pin mutation goes through here, so a missing pin or dataset is a no-op
    /// and never mints a phantom.
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

    /// Move the pin `id` under `dataset_id`. The optional `end` picks the move:
    ///
    /// - `end: None`: whole-shape drag. The anchor goes to `position`/`z` and
    ///   any second vertex rides the same delta (see
    ///   [`Annotation::set_position`]).
    /// - `end: Some(end)`: corner or edge resize. `position`, `end`, and `z`
    ///   are placed exactly (see [`Annotation::set_vertices`]).
    ///
    /// A missing pin or dataset is a no-op.
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

    /// Add (or replace) a comment on the pin `annotation_id` under `dataset_id`
    /// (see [`Annotation::add_comment`]). A missing pin or dataset is a no-op.
    pub fn add_comment(&mut self, dataset_id: &DatasetId, annotation_id: &str, comment: Comment) {
        if let Some(annotation) = self.annotation_mut(dataset_id, annotation_id) {
            annotation.add_comment(comment);
        }
    }

    /// Remove a comment by `comment_id` from the pin `annotation_id` under
    /// `dataset_id`. An unknown dataset, pin, or comment id is a no-op.
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
    /// `annotation_id` under `dataset_id`. An unknown dataset, pin, or comment
    /// id is a no-op.
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

    /// Pick the collection entity a freshly dropped pin is glued to: the entity
    /// nearest to `position` in the dataset's active layout.
    ///
    /// Returns `None` when the dataset is unknown, not a collection, or has no
    /// placed entity. It uses [`resolve_entity_position`] rather than the
    /// render-path fallback so an unplaceable entity never counts as sitting at
    /// the origin.
    ///
    /// Ties go to the first entity in manifest order. The server and every
    /// client derive the same anchor from the same synced state, so the anchor
    /// never travels on the wire.
    fn nearest_anchor(&self, dataset_id: &DatasetId, position: [f64; 2]) -> Option<EntityId> {
        let manifest = self.manifests.get(dataset_id)?;
        // A single-image dataset has no group or tile to glue to, and its lone
        // image does not move between layouts.
        if !matches!(manifest.kind, DatasetKind::Collection { .. }) {
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
            // Strictly less keeps the first entity on a tie.
            if best.as_ref().is_none_or(|(_, b)| dist2 < *b) {
                best = Some((entity.id.clone(), dist2));
            }
        }

        best.map(|(id, _)| id)
    }

    /// Re-anchor every anchored pin in `dataset_id` for a layout change from
    /// `from_id` to `to_id`.
    ///
    /// Each anchored pin's whole shape moves by `pos(anchor, to) − pos(anchor,
    /// from)`; `z` is untouched because layouts are in-plane. An unanchored pin,
    /// or one whose anchor is not placed in both layouts, stays put.
    ///
    /// The caller must pass the previous active layout id as `from_id`, read
    /// before `active_layout_ids` is overwritten.
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
            // Translating a pin whose anchor is unplaced in either layout would
            // drag it toward a fallback origin.
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
                self.register_dataset(event.manifest);
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
                // Read the previous active layout before overwriting it. A
                // dataset with no active id yet resolves via the manifest default.
                let from_id = self.active_layout_ids.get(&dataset_id).cloned();
                // Re-anchoring in the canonical apply path makes it persist and
                // reach every peer.
                self.reanchor_for_layout(&dataset_id, from_id.as_ref(), &layout_id);
                self.active_layout_ids.insert(dataset_id, layout_id);
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
                // Computed from synced state inside the canonical apply, so the
                // server and every client derive the same anchor without it
                // riding the `add_annotation` wire shape.
                let anchor = self.nearest_anchor(&dataset_id, position);
                self.add_annotation(
                    dataset_id,
                    Annotation {
                        id,
                        position,
                        end,
                        z,
                        t,
                        c,
                        author,
                        kind,
                        // A replayed pin id keeps its accrued thread; see
                        // `add_annotation`.
                        comments: Vec::new(),
                        anchor,
                        // A malformed or hostile command could smuggle source
                        // URLs (including local `file:///` paths) into the
                        // view. Strip them so they never reach broadcast or
                        // persisted state; the id-keyed fields restore reads
                        // are untouched.
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
    /// The level every chunk below is at, this member's target level, which
    /// is the value the view query reports for it. A level pin, clamped to
    /// the member's source levels, wins over the level the screen calls for.
    pub target_level: u32,
    pub needed: Vec<ChunkCoord>,
    pub prefetch: Vec<ChunkCoord>,
}

#[cfg(test)]
mod annotation_view_tests {
    //! A pin captures its author's view as an embedded [`SavedView`]. These
    //! lock the wire and blob contract: round-trip equality, additive serde,
    //! the command carrying the view to the stored pin, and the embedded view
    //! holding no source URLs.

    use super::*;
    use crate::saved_view::SavedView;

    /// A sample captured view in workspace-dataset-id form: empty `datasets`,
    /// as `buildCapture` emits in that mode, with non-default slice and
    /// display state so equality is meaningful.
    fn workspace_view() -> SavedView {
        let mut v = SavedView::empty([1024, 768]);
        v.view.t = 7;
        v.view.set_z_range(10..15);
        v.display.contrast_min = 100.0;
        v.display.contrast_max = 5000.0;
        v
    }

    /// A view of layer `ds` with `visible` channel flags and `solo`.
    fn layer_view(visible: &[bool], solo: Option<u32>) -> SavedView {
        let mut v = workspace_view();
        v.dataset_settings.insert(
            DatasetId("ds".into()),
            DatasetDisplaySettings {
                channel_settings: visible
                    .iter()
                    .map(|&visible| ChannelSettings {
                        visible,
                        ..Default::default()
                    })
                    .collect(),
                solo,
                ..Default::default()
            },
        );
        v
    }

    #[test]
    fn a_pin_placed_in_the_composite_belongs_to_every_channel_shown_then() {
        let ds = DatasetId("ds".into());
        let pin = pin_with_view(Some(layer_view(&[true, false, true], None)));
        let placed = pin.placement_channels(&ds);
        assert_eq!(placed, vec![0, 2]);
        // Soloing a channel visible at placement keeps the pin in context.
        assert!(crate::scene::in_channel_context(&placed, &[0]));
        assert!(crate::scene::in_channel_context(&placed, &[2]));
        // The hidden one does not.
        assert!(!crate::scene::in_channel_context(&placed, &[1]));
    }

    #[test]
    fn a_pin_placed_on_a_solo_belongs_to_that_channel() {
        let ds = DatasetId("ds".into());
        let pin = pin_with_view(Some(layer_view(&[true, true, true], Some(1))));
        let placed = pin.placement_channels(&ds);
        assert_eq!(placed, vec![1]);
        assert!(crate::scene::in_channel_context(&placed, &[0, 1, 2]));
        assert!(!crate::scene::in_channel_context(&placed, &[2]));
    }

    #[test]
    fn a_pin_without_a_view_belongs_to_its_channel() {
        let pin = pin_with_view(None);
        assert_eq!(pin.placement_channels(&DatasetId("ds".into())), vec![2]);
    }

    #[test]
    fn a_legacy_pin_placed_in_single_channel_mode_belongs_to_its_channel() {
        let json = r#"{"id":"p","position":[0.0,0.0],"author":"a","c":1,"view":{"v":1,"camera":{"mode":"slice","center":[0.0,0.0],"zoom":1.0,"viewport":[800,600]},"view":{"z_range":{"start":0,"end":1},"t":0,"c":1,"multi_channel":false},"display":{"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0},"dataset_settings":{"ds":{"visible":true,"opacity":1.0,"contrast_min":0.0,"contrast_max":65535.0,"gamma":1.0,"blend_mode":"alpha","channel_settings":[{"visible":true,"colormap":"magenta","contrast_min":0.0,"contrast_max":1.0,"gamma":1.0},{"visible":true,"colormap":"green","contrast_min":0.0,"contrast_max":1.0,"gamma":1.0}]}}}}"#;
        let pin: Annotation = serde_json::from_str(json).unwrap();
        assert_eq!(pin.placement_channels(&DatasetId("ds".into())), vec![1]);
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

    #[test]
    fn pin_without_view_key_deserializes_as_none() {
        let json =
            r#"{"id":"pin-old","position":[3.0,4.0],"z":2.0,"author":"alice","kind":"point"}"#;
        let pin: Annotation = serde_json::from_str(json).unwrap();
        assert_eq!(pin.view, None);
    }

    #[test]
    fn pin_without_view_serializes_without_view_key() {
        let pin = pin_with_view(None);
        let json = serde_json::to_string(&pin).unwrap();
        assert!(
            !json.contains("\"view\""),
            "a view-less pin must not emit a `view` key: {json}"
        );
    }

    /// `AddAnnotation` carries the view through a serde round-trip, so the
    /// inbound command equals its rebroadcast, and `apply` stores it on the pin.
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
            view: Some(Box::new(workspace_view())),
        };

        // `DocumentCommand` is not `PartialEq`, so compare normalized JSON.
        let json = serde_json::to_string(&cmd).unwrap();
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        let reser = serde_json::to_string(&parsed).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&json).unwrap(),
            serde_json::from_str::<serde_json::Value>(&reser).unwrap(),
        );
        let v: serde_json::Value = serde_json::from_str(&reser).unwrap();
        assert_eq!(v["view"]["view"]["t"], 7);

        let mut doc = DocumentState::default();
        doc.apply(parsed);
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.view.as_ref(), Some(&workspace_view()));
    }

    /// An `AddAnnotation` whose embedded view carries source URLs stores a pin
    /// with empty `view.datasets`. The id-keyed fields restore reads survive.
    #[test]
    fn add_annotation_strips_embedded_view_source_urls_but_keeps_id_keyed_fields() {
        use lucida_content::LayoutId;

        let ds = DatasetId("wds-1".into());

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
        assert!(
            stored.datasets.is_empty(),
            "AddAnnotation must store an embedded view with NO source URLs, got {:?}",
            stored.datasets
        );
        assert!(stored.active_layouts.contains_key(&ds));
        assert_eq!(stored.dataset_order, vec![ds.clone()]);
        assert!(stored.dataset_settings.contains_key(&ds));
        assert_eq!(stored.auto_contrast.get(&ds), Some(&false));
        assert_eq!(stored.view.t, 7);
        assert_eq!(stored.display.contrast_max, 5000.0);
    }

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
        assert!(
            !json.contains("zarr") && !json.contains("gs://") && !json.contains("s3://"),
            "no dataset source URL should appear in a pin's serialized view: {json}"
        );
    }

    /// After a remap the document resolves entirely against the new ids, with
    /// no trace of the old id in any map or in `manifest.dataset_id`.
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
        doc.add_annotation(old.clone(), pin_with_view(None));

        let mut remap = HashMap::new();
        remap.insert(old.clone(), new.clone());
        doc.remap_dataset_ids(&remap);

        assert!(doc.manifests.contains_key(&new));
        assert!(!doc.manifests.contains_key(&old));
        assert!(doc.registered_layouts.contains_key(&new));
        assert!(!doc.registered_layouts.contains_key(&old));
        assert!(doc.active_layout_ids.contains_key(&new));
        assert!(!doc.active_layout_ids.contains_key(&old));
        assert!(doc.annotations.contains_key(&new));
        assert!(!doc.annotations.contains_key(&old));
        assert_eq!(doc.manifests.get(&new).unwrap().dataset_id, new);
    }

    /// A remap also rewrites the id-keyed maps inside each pin's captured view;
    /// otherwise a copied pin's "go to author's view" loses its per-channel
    /// colors and contrast.
    #[test]
    fn remap_dataset_ids_remaps_embedded_annotation_view() {
        use lucida_content::LayoutId;

        let old = DatasetId("wds-old".into());
        let new = DatasetId("wds-new".into());

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

        assert!(doc.annotations.contains_key(&new));
        assert!(!doc.annotations.contains_key(&old));

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

    /// A partial remap never corrupts unrelated datasets.
    #[test]
    fn remap_dataset_ids_leaves_unmapped_ids_unchanged() {
        let kept = DatasetId("wds-kept".into());
        let mut doc = DocumentState::default();
        doc.active_layout_ids
            .insert(kept.clone(), lucida_content::LayoutId("x".into()));
        doc.remap_dataset_ids(&HashMap::new());
        assert!(doc.active_layout_ids.contains_key(&kept));
    }

    /// A `DocumentState` with `id` in every id-keyed field, so a field missing
    /// from `rekey_dataset_ids` shows up as a leftover.
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
        doc.add_annotation(id.clone(), pin_with_view(None));
        doc
    }

    /// `remove_dataset` clears the id from every id-keyed field, including
    /// `registered_layouts` and `active_layout_ids`, and leaves an unrelated
    /// dataset intact.
    #[test]
    fn remove_dataset_clears_id_from_all_id_keyed_fields() {
        use lucida_content::{DatasetKind, LayoutId, LayoutSpec};

        let gone = DatasetId("wds-gone".into());
        let kept = DatasetId("wds-kept".into());

        let mut doc = doc_with_id_in_every_field(&gone);
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
        doc.add_annotation(kept.clone(), pin_with_view(None));

        doc.remove_dataset(&gone);

        assert!(!doc.manifests.contains_key(&gone));
        assert!(
            !doc.registered_layouts.contains_key(&gone),
            "remove_dataset must clear registered_layouts (was orphaned)"
        );
        assert!(
            !doc.active_layout_ids.contains_key(&gone),
            "remove_dataset must clear active_layout_ids (was orphaned)"
        );
        assert!(!doc.annotations.contains_key(&gone));

        assert!(doc.manifests.contains_key(&kept));
        assert!(doc.registered_layouts.contains_key(&kept));
        assert!(doc.active_layout_ids.contains_key(&kept));
        assert!(doc.annotations.contains_key(&kept));
    }

    /// Removing the only dataset must leave the whole document empty. An
    /// id-keyed field not wired into [`DocumentState::rekey_dataset_ids`] keeps
    /// the id and fails this test.
    #[test]
    fn rekey_dataset_ids_covers_every_id_keyed_field() {
        let id = DatasetId("wds-only".into());
        let mut doc = doc_with_id_in_every_field(&id);

        doc.remove_dataset(&id);

        assert!(doc.manifests.is_empty());
        assert!(doc.registered_layouts.is_empty());
        assert!(doc.active_layout_ids.is_empty());
        assert!(doc.annotations.is_empty());
    }

    /// A remap and a removal preserve the iteration order of the `IndexMap`
    /// fields, not just membership. They are `IndexMap` so serialization order
    /// on the document wire is deterministic; a rebuild through a `HashMap`
    /// would scramble it and pass every membership test. Both halves touch the
    /// middle entry so a sorted or reordered rebuild fails.
    #[test]
    fn rekey_dataset_ids_preserves_index_map_iteration_order() {
        use lucida_content::DatasetKind;

        let a = DatasetId("wds-a".into());
        let b = DatasetId("wds-b".into());
        let c = DatasetId("wds-c".into());
        let b_prime = DatasetId("wds-b-prime".into());

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
                doc.add_annotation((*id).clone(), pin_with_view(None));
            }
            doc
        }

        // Rename the middle entry in place.
        let mut doc = seed(&[&a, &b, &c]);
        let mut remap = HashMap::new();
        remap.insert(b.clone(), b_prime.clone());
        doc.remap_dataset_ids(&remap);

        let expected = vec![a.clone(), b_prime.clone(), c.clone()];
        assert_eq!(doc.manifests.keys().cloned().collect::<Vec<_>>(), expected);
        assert_eq!(
            doc.annotations.keys().cloned().collect::<Vec<_>>(),
            expected,
        );
        assert_eq!(doc.manifests[&b_prime].dataset_id, b_prime);

        // Drop the middle entry; the survivors keep their order.
        let mut doc = seed(&[&a, &b, &c]);
        doc.remove_dataset(&b);

        let expected = vec![a.clone(), c.clone()];
        assert_eq!(doc.manifests.keys().cloned().collect::<Vec<_>>(), expected);
        assert_eq!(
            doc.annotations.keys().cloned().collect::<Vec<_>>(),
            expected
        );
    }
}

#[cfg(test)]
mod ensure_label_tests {
    //! Growing `label_settings` back-fills hidden defaults and never overwrites
    //! an existing entry, so an explicit on survives a later grow.

    use super::*;

    /// A short `label_settings` vec a per-label edit can outrun. Index 0 is an
    /// explicit on, the non-default state a grow must not clobber.
    fn short() -> DatasetDisplaySettings {
        DatasetDisplaySettings {
            label_settings: vec![LabelSettings {
                visible: true,
                opacity: 0.5,
            }],
            ..Default::default()
        }
    }

    #[test]
    fn opacity_edit_at_high_index_backfills_hidden_and_preserves_existing_on() {
        // Mirrors the `SetLabelOpacity` apply arm.
        let mut s = short();
        s.ensure_label(3).opacity = 0.2;
        assert_eq!(s.label_settings.len(), 4);
        assert!(s.label_settings[0].visible);
        assert_eq!(s.label_settings[1], LabelSettings::default());
        assert_eq!(s.label_settings[2], LabelSettings::default());
        // Opacity alone never reveals a mask.
        assert!(!s.label_settings[3].visible);
        assert_eq!(s.label_settings[3].opacity, 0.2);
    }

    #[test]
    fn explicit_visible_set_targets_its_entry_and_backfills_hidden() {
        // Mirrors the `SetLabelVisible(.., true)` apply arm.
        let mut s = short();
        s.ensure_label(2).visible = true;
        assert_eq!(s.label_settings.len(), 3);
        assert!(s.label_settings[0].visible); // existing on untouched
        assert!(!s.label_settings[1].visible); // back-fill defaults hidden
        assert!(s.label_settings[2].visible); // target explicitly on
    }

    #[test]
    fn reaching_an_existing_index_does_not_grow_or_alter() {
        // ensure_label at an in-range index returns the existing entry unchanged.
        let mut s = short();
        s.label_settings[0].visible = true;
        s.label_settings[0].opacity = 0.9;
        let entry = s.ensure_label(0);
        assert!(entry.visible);
        assert_eq!(entry.opacity, 0.9);
        assert_eq!(s.label_settings.len(), 1);
    }
}

#[cfg(test)]
mod reconcile_label_settings_tests {
    //! A saved view, bookmark, or peer restore matches per-label settings to
    //! the right current label after the label list changed. A blob with no
    //! captured names still applies positionally.

    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// Hidden settings with a non-`0.5` opacity, so a match is distinguishable
    /// from the [`LabelSettings::default`] a miss produces.
    fn marked(opacity: f32) -> LabelSettings {
        LabelSettings {
            visible: false,
            opacity,
        }
    }

    /// An explicitly visible entry, to show a matched explicit on survives
    /// reconcile.
    fn visible_marked(opacity: f32) -> LabelSettings {
        LabelSettings {
            visible: true,
            opacity,
        }
    }

    #[test]
    fn result_is_always_aligned_to_current_names() {
        // A total mismatch still yields one hidden default per current label.
        let saved = vec![marked(0.1)];
        let out = DatasetDisplaySettings::reconcile_label_settings(
            &saved,
            &names(&["a"]),
            &names(&["x", "y", "z"]),
        );
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|s| *s == LabelSettings::default()));
        assert!(out.iter().all(|s| !s.visible));
    }

    #[test]
    fn legacy_empty_author_names_is_positional() {
        let saved = vec![marked(0.1), marked(0.2), marked(0.3)];
        let out = DatasetDisplaySettings::reconcile_label_settings(
            &saved,
            &[],
            &names(&["whatever", "these", "are"]),
        );
        assert_eq!(out, saved);
    }

    #[test]
    fn legacy_positional_pads_and_truncates_to_current_len() {
        let saved = vec![marked(0.1), marked(0.2)];
        // Current is longer: extra current labels take the default.
        let longer =
            DatasetDisplaySettings::reconcile_label_settings(&saved, &[], &names(&["a", "b", "c"]));
        assert_eq!(
            longer,
            vec![marked(0.1), marked(0.2), LabelSettings::default()]
        );
        // Current is shorter: trailing saved entries are dropped.
        let shorter = DatasetDisplaySettings::reconcile_label_settings(&saved, &[], &names(&["a"]));
        assert_eq!(shorter, vec![marked(0.1)]);
    }

    #[test]
    fn reordered_names_follow_the_name_not_the_index() {
        let author = names(&["region-a", "region-b", "region-c"]);
        let saved = vec![marked(0.11), marked(0.22), marked(0.33)];
        // Current order is a rotation of the author's.
        let current = names(&["region-c", "region-a", "region-b"]);
        let out = DatasetDisplaySettings::reconcile_label_settings(&saved, &author, &current);
        assert_eq!(out, vec![marked(0.33), marked(0.11), marked(0.22)]);
    }

    #[test]
    fn added_current_label_takes_the_default() {
        let author = names(&["region-a", "region-b"]);
        let saved = vec![marked(0.11), marked(0.22)];
        // The author never named "region-c", so it takes the hidden default.
        let current = names(&["region-a", "region-c", "region-b"]);
        let out = DatasetDisplaySettings::reconcile_label_settings(&saved, &author, &current);
        assert_eq!(
            out,
            vec![marked(0.11), LabelSettings::default(), marked(0.22)]
        );
        assert!(!out[1].visible);
    }

    #[test]
    fn removed_current_label_drops_its_saved_entry() {
        let author = names(&["region-a", "region-b", "region-c"]);
        let saved = vec![marked(0.11), marked(0.22), marked(0.33)];
        // "region-b" is gone from the recipient; its saved entry is not applied
        // to any surviving label.
        let current = names(&["region-a", "region-c"]);
        let out = DatasetDisplaySettings::reconcile_label_settings(&saved, &author, &current);
        assert_eq!(out, vec![marked(0.11), marked(0.33)]);
    }

    #[test]
    fn repeated_names_are_matched_by_occurrence() {
        // A plate that repeats a label name: each current occurrence claims the
        // matching author occurrence, in order.
        let author = names(&["region-a", "region-a", "region-a"]);
        let saved = vec![marked(0.11), marked(0.22), marked(0.33)];
        let current = names(&["region-a", "region-a", "region-a"]);
        let out = DatasetDisplaySettings::reconcile_label_settings(&saved, &author, &current);
        assert_eq!(out, saved);

        // More current occurrences than the author had: the surplus takes the
        // default.
        let current_more = names(&["region-a", "region-a", "region-a", "region-a"]);
        let out_more =
            DatasetDisplaySettings::reconcile_label_settings(&saved, &author, &current_more);
        assert_eq!(
            out_more,
            vec![
                marked(0.11),
                marked(0.22),
                marked(0.33),
                LabelSettings::default()
            ]
        );
    }

    #[test]
    fn mixed_repeats_and_uniques_stay_occurrence_aligned() {
        let author = names(&["region-a", "region-b", "region-a"]);
        let saved = vec![marked(0.11), marked(0.22), marked(0.33)];
        // The first current "region-a" still takes the author's first one.
        let current = names(&["region-a", "region-a", "region-b"]);
        let out = DatasetDisplaySettings::reconcile_label_settings(&saved, &author, &current);
        assert_eq!(out, vec![marked(0.11), marked(0.33), marked(0.22)]);
    }

    #[test]
    fn shorter_saved_than_author_names_defaults_the_gap() {
        // A malformed blob whose `saved` is shorter than its `label_names` must
        // not panic; a name with no saved slot takes the hidden default.
        let author = names(&["a", "b", "c"]);
        let saved = vec![marked(0.11)]; // only "a" has a settings entry
        let current = names(&["c", "a"]);
        let out = DatasetDisplaySettings::reconcile_label_settings(&saved, &author, &current);
        assert_eq!(out, vec![LabelSettings::default(), marked(0.11)]);
        assert!(!out[0].visible);
    }

    #[test]
    fn matched_visible_setting_restores_visible() {
        // The hidden fallback only touches labels the save never addressed.
        let author = names(&["region-a", "region-b"]);
        let saved = vec![visible_marked(0.8), marked(0.3)];
        let current = names(&["region-b", "region-a"]);
        let out = DatasetDisplaySettings::reconcile_label_settings(&saved, &author, &current);
        assert_eq!(out, vec![marked(0.3), visible_marked(0.8)]);
        assert!(out[1].visible);
    }

    #[test]
    fn legacy_positional_restores_a_matched_visible_entry() {
        let saved = vec![visible_marked(0.7), marked(0.2)];
        let out =
            DatasetDisplaySettings::reconcile_label_settings(&saved, &[], &names(&["a", "b"]));
        assert_eq!(out, vec![visible_marked(0.7), marked(0.2)]);
        assert!(out[0].visible);
    }
}
