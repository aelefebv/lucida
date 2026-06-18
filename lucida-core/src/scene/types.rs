use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use indexmap::IndexMap;
use lucida_content::{DatasetId, DatasetKind, EntityId, LayoutId, LayoutSpec};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelSettings {
    pub visible: bool,
    pub colormap: Colormap,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
}

impl Default for ChannelSettings {
    fn default() -> Self {
        Self {
            visible: true,
            colormap: Colormap::Gray,
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
        }
    }
}

fn default_channel_blend_mode() -> BlendMode {
    BlendMode::Additive
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
            channel_blend_mode: BlendMode::Additive,
            detail_level_override: None,
        }
    }
}

/// Display settings (contrast window + gamma).
#[derive(Debug, Clone, Serialize, Deserialize)]
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
        let [dx, dy] = [position[0] - self.position[0], position[1] - self.position[1]];
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

    /// Remove a dataset by id. Drops its annotations along with its
    /// manifest and asset catalog — annotations are scoped per dataset, so a
    /// removed dataset's pins must not linger.
    pub fn remove_dataset(&mut self, id: &DatasetId) {
        self.manifests.shift_remove(id);
        self.asset_catalogs.shift_remove(id);
        self.annotations.shift_remove(id);
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
