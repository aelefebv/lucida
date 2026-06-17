use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use indexmap::IndexMap;
use lucida_content::{DatasetId, LayoutId, LayoutSpec};
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

/// The shape of a collaborative annotation. Fixed at `Point` for this
/// slice; the field exists so richer geometries (line, box, freehand) can
/// be added later without a breaking wire change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum AnnotationKind {
    #[default]
    Point,
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
    /// 2D world-space position `[x, y]`.
    pub position: [f64; 2],
    pub author: String,
    #[serde(default)]
    pub kind: AnnotationKind,
    /// Flat, ordered comment thread on this pin. Owns its dedup/order
    /// invariants via [`Annotation::add_comment`] / [`Annotation::remove_comment`].
    #[serde(default)]
    pub comments: Vec<Comment>,
}

impl Annotation {
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
    /// Shared by [`Self::add_comment`] / [`Self::remove_comment`]: both must
    /// target an existing pin and otherwise be a clean no-op. Centralizing the
    /// lookup keeps that "missing pin/dataset is harmless" rule in one place.
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
                self.active_layout_ids.insert(dataset_id, layout_id);
            }
            DocumentCommand::ApplyAssetCatalogDelta { dataset_id, delta } => {
                self.apply_asset_catalog_delta(dataset_id, delta);
            }
            DocumentCommand::AddAnnotation {
                dataset_id,
                id,
                position,
                author,
                kind,
            } => {
                self.add_annotation(
                    dataset_id,
                    Annotation {
                        id,
                        position,
                        author,
                        kind,
                        // A freshly dropped pin starts with an empty thread.
                        // On a re-applied (duplicate) pin id, add_annotation
                        // preserves any thread already accrued on that pin.
                        comments: Vec::new(),
                    },
                );
            }
            DocumentCommand::RemoveAnnotation { dataset_id, id } => {
                self.remove_annotation(&dataset_id, &id);
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
