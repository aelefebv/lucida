use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use lucida_content::{
    DatasetId, DatasetKind, DatasetManifest, EntityId, EntityKind, LayoutId, LayoutSpec,
};
use lucida_protocol::{AssetCatalogDelta, DatasetOpened};

use crate::camera::Camera;
use crate::scene::{BlendMode, Colormap, RenderMode, Scene};

/// Commands that mutate shared document state (datasets).
/// These are sequenced, persisted, and broadcast to all clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DocumentCommand {
    DatasetOpened(DatasetOpened),
    RemoveDataset {
        id: DatasetId,
    },
    RegisterLayout {
        dataset_id: DatasetId,
        layout: LayoutSpec,
    },
    SetActiveLayout {
        dataset_id: DatasetId,
        layout_id: LayoutId,
    },
    /// Merge an asset catalog delta into the document. Bumps `epochs.asset`.
    /// Idempotent on identical re-apply.
    ApplyAssetCatalogDelta {
        dataset_id: DatasetId,
        delta: AssetCatalogDelta,
    },
    /// Drop a collaborative annotation (point pin) onto `dataset_id` at an
    /// in-plane world-space `position` and additive depth `z` (the pin's world
    /// point is `(position[0], position[1], z)`). The `id` is client-supplied
    /// (a uuid string) so this command and its rebroadcast are byte-identical
    /// and apply identically on every peer. Idempotent on a repeated `id` (last
    /// write wins). Bumps `epochs.annotation`.
    ///
    /// `z` is `#[serde(default)]` so this stays wire-compatible with slices
    /// 1/2: an `add_annotation` command with no `z` field (an older client, or
    /// a replayed older log entry) applies with `z = 0.0` rather than failing
    /// to parse. There is no `[2] -> [3]` break — `position` is unchanged.
    ///
    /// `end` is the **second** in-plane vertex — a line's far endpoint or a
    /// box's opposite corner (for a `Point`, omit it / send `null`). Like `z`
    /// and `kind`, it is `#[serde(default)]`, so a slice-1..4 `add_annotation`
    /// (no `end` field) applies as `end: None`, i.e. a plain point — additive,
    /// no wire break. The shared depth `z` applies to both vertices.
    ///
    /// `t` (timepoint) and `c` (channel) record the **current view's** discrete
    /// T/C selectors at creation, so a pin belongs to the slice/timepoint/channel
    /// it was dropped on (issue #779) and the overlay can show it off-context when
    /// the view differs. Both are `#[serde(default)]`, mirroring `z`/`end`/`kind`,
    /// so an `add_annotation` from a client that predates this slice (or a
    /// replayed older log entry) applies with `t = 0, c = 0` rather than failing
    /// to parse — additive, no wire break.
    AddAnnotation {
        dataset_id: DatasetId,
        id: String,
        position: [f64; 2],
        #[serde(default)]
        end: Option<[f64; 2]>,
        #[serde(default)]
        z: f64,
        #[serde(default)]
        t: i64,
        #[serde(default)]
        c: i64,
        author: String,
        #[serde(default)]
        kind: crate::scene::AnnotationKind,
    },
    /// Remove a collaborative annotation by `id` from `dataset_id`. No-op if
    /// the id is unknown. Bumps `epochs.annotation`.
    RemoveAnnotation {
        dataset_id: DatasetId,
        id: String,
    },
    /// Attach a text comment to the pin `annotation_id` under `dataset_id`,
    /// forming a flat discussion thread. The comment `id` is client-supplied
    /// (a uuid string) so this command and its rebroadcast are byte-identical
    /// and apply identically on every peer. Idempotent on a repeated comment
    /// `id` (last write wins on `text`/`author`). A `add_comment` to a missing
    /// annotation or dataset is a clean no-op — it must not mint a phantom pin.
    /// Bumps `epochs.annotation` (the pin's thread is part of annotation state).
    AddComment {
        dataset_id: DatasetId,
        annotation_id: String,
        id: String,
        author: String,
        text: String,
    },
    /// Remove a comment by `id` from the pin `annotation_id` under `dataset_id`.
    /// No-op if the dataset, pin, or comment id is unknown. Bumps
    /// `epochs.annotation`.
    RemoveComment {
        dataset_id: DatasetId,
        annotation_id: String,
        id: String,
    },
    /// Reposition an existing pin: find the annotation by `id` within
    /// `dataset_id` and overwrite its in-plane `position` and depth `z`. A
    /// **no-op** if the pin or dataset is absent — this command must NOT mint a
    /// pin (that is `AddAnnotation`'s job), so a stray move for an unknown id
    /// leaves the document untouched. Every other field (author, kind, and the
    /// pin's comment thread) is preserved. Idempotent: re-applying the same move
    /// is equivalent to applying it once, so a replayed/twice-delivered command
    /// keeps every peer convergent. Bumps `epochs.annotation`.
    ///
    /// `z` is `#[serde(default)]`, mirroring [`Self::AddAnnotation`], so a move
    /// emitted by a depth-unaware client (or a replayed older log entry) applies
    /// with `z = 0.0` rather than failing to parse.
    ///
    /// `end` is the optional second in-plane vertex (a box's opposite corner /
    /// a line's far endpoint). It distinguishes the two move shapes:
    /// - `end: None` (the slice #776 default) → **rigid whole-shape translate**:
    ///   the anchor goes to `position`/`z` and any second vertex rides along by
    ///   the same in-plane delta, so a box/line keeps its size, length, and
    ///   angle (see [`crate::scene::Annotation::set_position`]).
    /// - `end: Some([x, y])` → **reshape**: `position`, `end`, and `z` are set
    ///   to exactly the given values — the two opposite corners are placed
    ///   independently, no rigid translate (see
    ///   [`crate::scene::Annotation::set_vertices`]). This is how a corner/edge
    ///   resize lands: the handle recomputes the two opposite corners and sends
    ///   both. A `Point` has no second vertex and ignores `end`.
    ///
    /// `#[serde(default)]` keeps this additive — an existing `move_annotation`
    /// with no `end` field (a slice-#776 client, or a replayed older log entry)
    /// parses as `end: None`, i.e. the rigid translate. No wire break.
    MoveAnnotation {
        dataset_id: DatasetId,
        id: String,
        position: [f64; 2],
        #[serde(default)]
        end: Option<[f64; 2]>,
        #[serde(default)]
        z: f64,
    },
    /// Edit an existing comment's text: find the comment by `id` within the pin
    /// `annotation_id` under `dataset_id` and overwrite its `text`. A **no-op**
    /// if the dataset, pin, or comment id is unknown — this command must NOT mint
    /// a comment (that is `AddComment`'s job). The comment's `id` and `author`
    /// are preserved, as is its position in the thread. Idempotent: re-applying
    /// the same edit is a no-op-equivalent. Bumps `epochs.annotation`.
    EditComment {
        dataset_id: DatasetId,
        annotation_id: String,
        id: String,
        text: String,
    },
}

/// Commands that mutate local-only viewport/display state.
/// These are applied locally and emitted as presence updates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ViewportCommand {
    // Mode
    #[serde(rename = "set_mode_slice")]
    SetMode2D,
    #[serde(rename = "set_mode_arcball")]
    SetMode3D,
    #[serde(rename = "set_mode_fly")]
    SetModeFly,
    // Viewport
    SetViewport {
        width: u32,
        height: u32,
    },
    // 2D camera
    Pan {
        dx: f64,
        dy: f64,
    },
    ZoomBy {
        factor: f64,
    },
    SetCenter {
        x: f64,
        y: f64,
    },
    SetZoom {
        value: f64,
    },
    // 3D camera
    #[serde(rename = "arcball_rotate")]
    Rotate3D {
        d_theta: f64,
        d_phi: f64,
    },
    #[serde(rename = "arcball_zoom")]
    Zoom3D {
        delta: f64,
    },
    #[serde(rename = "arcball_pan")]
    Pan3D {
        dx: f64,
        dy: f64,
    },
    // Fly camera
    FlyTick {
        dt: f64,
        forward: f64,
        right: f64,
        up: f64,
        yaw: f64,
        pitch: f64,
        roll: f64,
    },
    // View state
    SetZ {
        z: u32,
    },
    SetZRange {
        start: u32,
        end: u32,
    },
    SetT {
        t: u32,
    },
    SetC {
        c: u32,
    },
    // Display
    SetContrast {
        min: f64,
        max: f64,
    },
    SetGamma {
        gamma: f64,
    },
    // Per-dataset display
    SetDatasetOrder {
        order: Vec<String>,
    },
    SetDatasetVisible {
        dataset_id: String,
        visible: bool,
    },
    SetDatasetOpacity {
        dataset_id: String,
        opacity: f32,
    },
    SetDatasetContrast {
        dataset_id: String,
        min: f64,
        max: f64,
    },
    SetDatasetGamma {
        dataset_id: String,
        gamma: f64,
    },
    SetDatasetBlendMode {
        dataset_id: String,
        blend_mode: BlendMode,
    },
    SetDatasetRenderMode {
        dataset_id: String,
        render_mode: RenderMode,
    },
    SetDatasetDetailLevelOverride {
        dataset_id: String,
        level: Option<u32>,
    },
    // Multi-channel
    SetMultiChannel {
        enabled: bool,
    },
    SetChannelVisible {
        dataset_id: String,
        channel: u32,
        visible: bool,
    },
    SetChannelColormap {
        dataset_id: String,
        channel: u32,
        colormap: Colormap,
    },
    SetChannelContrast {
        dataset_id: String,
        channel: u32,
        min: f64,
        max: f64,
    },
    SetChannelGamma {
        dataset_id: String,
        channel: u32,
        gamma: f64,
    },
    SetChannelBlendMode {
        dataset_id: String,
        blend_mode: BlendMode,
    },
}

/// Wrapper enum for serde compatibility. Deserializes from the same
/// JSON format as before (e.g. `{"type":"pan","dx":10.0,"dy":-5.0}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
// Command is dispatched per UI interaction (keypress, mouse, presence event);
// the 280-byte DocumentCommand variant is not on a hot copy path. Boxing
// would add a heap allocation per command for no measurable benefit.
#[allow(clippy::large_enum_variant)]
pub enum Command {
    Document(DocumentCommand),
    Viewport(ViewportCommand),
}

impl From<DocumentCommand> for Command {
    fn from(cmd: DocumentCommand) -> Self {
        Command::Document(cmd)
    }
}

impl From<ViewportCommand> for Command {
    fn from(cmd: ViewportCommand) -> Self {
        Command::Viewport(cmd)
    }
}

impl Scene {
    pub fn apply(&mut self, cmd: Command) {
        match cmd {
            Command::Document(doc_cmd) => {
                // Handle Scene-level side effects for document commands.
                // SetActiveLayout needs special ordering: apply doc state first,
                // then rebuild derived. All others do side effects first, then apply.
                if let DocumentCommand::SetActiveLayout { dataset_id, .. } = &doc_cmd {
                    let dataset_id = dataset_id.clone();
                    self.document.apply(doc_cmd);
                    if let Some(content) = self.document.manifests.get(&dataset_id) {
                        let layout = crate::scene::resolve_layout(
                            content,
                            self.document.registered_layouts.get(&dataset_id),
                            self.document.active_layout_ids.get(&dataset_id),
                        );
                        let derived = crate::scene::build_derived_state(content, &layout);
                        self.derived.insert(dataset_id, derived);
                    }
                    self.epochs.layout += 1;
                    return;
                }
                match &doc_cmd {
                    DocumentCommand::DatasetOpened(event) => {
                        let dataset_id = event.manifest.dataset_id.clone();

                        // Dataset ordering
                        if !self.dataset_order.contains(&dataset_id) {
                            self.dataset_order.push(dataset_id.clone());
                        }

                        // Channel count from first image's C dimension
                        let channel_count = event
                            .manifest
                            .images()
                            .first()
                            .and_then(|img| img.multiscale.levels.first())
                            .map(|l| l.shape[1] as usize)
                            .unwrap_or(1);

                        // Display settings
                        self.dataset_settings
                            .entry(dataset_id.clone())
                            .or_insert_with(|| crate::scene::DatasetDisplaySettings {
                                channel_settings: (0..channel_count)
                                    .map(|i| crate::scene::ChannelSettings {
                                        colormap: Colormap::default_for_channel(i),
                                        ..Default::default()
                                    })
                                    .collect(),
                                ..Default::default()
                            });

                        // Build derived state
                        let layout = crate::scene::resolve_layout(
                            &event.manifest,
                            self.document.registered_layouts.get(&dataset_id),
                            self.document.active_layout_ids.get(&dataset_id),
                        );
                        let derived = crate::scene::build_derived_state(&event.manifest, &layout);
                        self.derived.insert(dataset_id.clone(), derived);

                        self.epochs.content += 1;
                        self.epochs.layout += 1;

                        let shape = analyze_manifest_shape(&event.manifest);
                        crate::wasm_log!("scene.dataset_opened.applied", {
                            "dataset_id": dataset_id.0,
                            "n_entities": event.manifest.entities().len(),
                            "n_images": event.manifest.images().len(),
                            "n_wells": shape.n_wells,
                            "n_fields": shape.n_fields,
                            "n_orphans": shape.n_orphans,
                            "n_layouts": shape.n_layouts,
                            "channel_count": channel_count,
                            "kind": kind_label(&event.manifest.kind),
                            "plate_rows": shape.plate_rows,
                            "plate_columns": shape.plate_columns,
                            "has_stage_positions": shape.has_stage_positions,
                            "default_layout_id": event.manifest.default_layout_id.as_ref().map(|id| id.0.clone()),
                            "epochs": {
                                "content": self.epochs.content,
                                "layout": self.epochs.layout,
                            },
                        });

                        let issues = manifest_anomalies(&event.manifest, &shape);
                        if !issues.is_empty() {
                            crate::wasm_log!("manifest.shape_anomaly", {
                                "dataset_id": dataset_id.0,
                                "kind": kind_label(&event.manifest.kind),
                                "issues": issues,
                            });
                        }
                    }
                    DocumentCommand::RemoveDataset { id } => {
                        self.dataset_order.retain(|s| s != id);
                        self.dataset_settings.remove(id);
                        self.derived.remove(id);

                        self.epochs.content += 1;
                        self.epochs.layout += 1;
                    }
                    DocumentCommand::RegisterLayout { .. } => {
                        // Document state update happens below via self.document.apply().
                        // No derived rebuild needed for register alone (a registered
                        // layout doesn't take effect until SetActiveLayout selects it),
                        // but bump layout epoch so consumers (e.g., LayoutSwitcher
                        // populating its dropdown) see the new option promptly.
                        self.epochs.layout += 1;
                    }
                    DocumentCommand::SetActiveLayout { .. } => {
                        unreachable!("handled above");
                    }
                    DocumentCommand::ApplyAssetCatalogDelta { .. } => {
                        // Bump the asset epoch. Document state update happens
                        // below via self.document.apply().
                        self.epochs.asset += 1;
                    }
                    DocumentCommand::AddAnnotation { .. }
                    | DocumentCommand::RemoveAnnotation { .. }
                    | DocumentCommand::MoveAnnotation { .. }
                    | DocumentCommand::AddComment { .. }
                    | DocumentCommand::RemoveComment { .. }
                    | DocumentCommand::EditComment { .. } => {
                        // Bump the annotation epoch. A pin's comment thread is
                        // part of its annotation state, so add/remove/edit_comment
                        // and move_annotation all invalidate the same epoch as
                        // add/remove_annotation. Document state update happens
                        // below via self.document.apply().
                        self.epochs.annotation += 1;
                    }
                }
                self.document.apply(doc_cmd);
            }
            Command::Viewport(vp_cmd) => self.apply_viewport(vp_cmd),
        }
    }

    fn apply_viewport(&mut self, cmd: ViewportCommand) {
        match cmd {
            ViewportCommand::SetMode2D => {
                self.set_mode_2d();
                self.epochs.view += 1;
            }
            ViewportCommand::SetMode3D => {
                self.set_mode_3d();
                self.epochs.view += 1;
            }
            ViewportCommand::SetModeFly => {
                self.set_mode_fly();
                self.epochs.view += 1;
            }
            ViewportCommand::SetViewport { width, height } => {
                self.inner_set_viewport(width, height);
                self.epochs.view += 1;
            }
            ViewportCommand::Pan { dx, dy } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.pan(dx, dy);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::ZoomBy { factor } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.zoom_by(factor);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::SetCenter { x, y } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.center = [x, y];
                }
                self.epochs.view += 1;
            }
            ViewportCommand::SetZoom { value } => {
                if let Camera::Slice(ref mut v) = self.camera {
                    v.zoom = value;
                }
                self.epochs.view += 1;
            }
            ViewportCommand::Rotate3D { d_theta, d_phi } => {
                if let Camera::Arcball(ref mut v) = self.camera {
                    v.rotate(d_theta, d_phi);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::Zoom3D { delta } => {
                if let Camera::Arcball(ref mut v) = self.camera {
                    v.zoom(delta);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::Pan3D { dx, dy } => {
                if let Camera::Arcball(ref mut v) = self.camera {
                    v.pan(dx, dy);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::FlyTick {
                dt,
                forward,
                right,
                up,
                yaw,
                pitch,
                roll,
            } => {
                if let Camera::Fly(ref mut v) = self.camera {
                    v.fly_tick(dt, forward, right, up, yaw, pitch, roll);
                }
                self.epochs.view += 1;
            }
            ViewportCommand::SetZ { z } => {
                self.view.set_z(z);
                self.epochs.selection += 1;
            }
            ViewportCommand::SetZRange { start, end } => {
                self.view.set_z_range(start..end);
                self.epochs.selection += 1;
            }
            ViewportCommand::SetT { t } => {
                self.view.t = t;
                self.epochs.selection += 1;
            }
            ViewportCommand::SetC { c } => {
                self.view.c = c;
                self.epochs.selection += 1;
            }
            ViewportCommand::SetContrast { min, max } => {
                self.display.contrast_min = min;
                self.display.contrast_max = max;
                self.epochs.selection += 1;
            }
            ViewportCommand::SetGamma { gamma } => {
                self.display.gamma = gamma;
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetOrder { order } => {
                self.dataset_order = order.into_iter().map(DatasetId).collect();
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetVisible {
                dataset_id,
                visible,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.visible = visible;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetOpacity {
                dataset_id,
                opacity,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.opacity = opacity;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetContrast {
                dataset_id,
                min,
                max,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.contrast_min = min;
                    s.contrast_max = max;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetGamma { dataset_id, gamma } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.gamma = gamma;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetBlendMode {
                dataset_id,
                blend_mode,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.blend_mode = blend_mode;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetRenderMode {
                dataset_id,
                render_mode,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.render_mode = render_mode;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetDatasetDetailLevelOverride { dataset_id, level } => {
                let ds_id = DatasetId(dataset_id);
                let clamped = level.and_then(|l| self.clamp_detail_level_override(&ds_id, l));
                if let Some(s) = self.dataset_settings.get_mut(&ds_id) {
                    s.detail_level_override = clamped;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetMultiChannel { enabled } => {
                self.view.multi_channel = enabled;
                self.epochs.selection += 1;
            }
            ViewportCommand::SetChannelVisible {
                dataset_id,
                channel,
                visible,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.ensure_channel(channel as usize).visible = visible;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetChannelColormap {
                dataset_id,
                channel,
                colormap,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.ensure_channel(channel as usize).colormap = colormap;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetChannelContrast {
                dataset_id,
                channel,
                min,
                max,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    let ch = s.ensure_channel(channel as usize);
                    ch.contrast_min = min;
                    ch.contrast_max = max;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetChannelGamma {
                dataset_id,
                channel,
                gamma,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.ensure_channel(channel as usize).gamma = gamma;
                }
                self.epochs.selection += 1;
            }
            ViewportCommand::SetChannelBlendMode {
                dataset_id,
                blend_mode,
            } => {
                if let Some(s) = self.dataset_settings.get_mut(&DatasetId(dataset_id)) {
                    s.channel_blend_mode = blend_mode;
                }
                self.epochs.selection += 1;
            }
        }
    }

    fn clamp_detail_level_override(&self, dataset_id: &DatasetId, requested: u32) -> Option<u32> {
        let levels = self
            .document
            .manifests
            .get(dataset_id)?
            .images()
            .first()?
            .multiscale
            .selectable_detail_levels();
        if levels.is_empty() {
            return None;
        }
        if levels.contains(&requested) {
            return Some(requested);
        }
        levels
            .iter()
            .copied()
            .filter(|level| *level <= requested)
            .max()
            .or_else(|| levels.first().copied())
    }
}

/// Aggregated counts and plate metadata used by both the
/// `scene.dataset_opened.applied` log enrichment and the
/// `manifest.shape_anomaly` check. Single pass over `entities()` so the
/// extra accounting is cheap even for plates with many fields.
struct ManifestShape {
    n_wells: usize,
    n_fields: usize,
    n_orphans: usize,
    n_layouts: usize,
    n_fields_without_image: usize,
    plate_rows: Option<usize>,
    plate_columns: Option<usize>,
    has_stage_positions: Option<bool>,
}

fn analyze_manifest_shape(manifest: &DatasetManifest) -> ManifestShape {
    let entities = manifest.entities();
    let entity_ids: HashSet<&EntityId> = entities.iter().map(|e| &e.id).collect();
    let image_owners: HashSet<&EntityId> = manifest.images().iter().map(|i| &i.owner).collect();

    let (plate_rows, plate_columns, has_stage_positions) = match &manifest.kind {
        DatasetKind::Plate {
            rows,
            columns,
            has_stage_positions,
            ..
        } => (
            Some(rows.len()),
            Some(columns.len()),
            Some(*has_stage_positions),
        ),
        DatasetKind::Single => (None, None, None),
    };

    let mut shape = ManifestShape {
        n_wells: 0,
        n_fields: 0,
        n_orphans: 0,
        n_layouts: manifest.source_layouts().len(),
        n_fields_without_image: 0,
        plate_rows,
        plate_columns,
        has_stage_positions,
    };

    for entity in entities {
        match entity.kind {
            EntityKind::Well => shape.n_wells += 1,
            EntityKind::Field => {
                shape.n_fields += 1;
                if let Some(parent) = &entity.parent
                    && !entity_ids.contains(parent)
                {
                    shape.n_orphans += 1;
                }
                if !image_owners.contains(&entity.id) {
                    shape.n_fields_without_image += 1;
                }
            }
            EntityKind::Image => {}
        }
    }

    shape
}

fn manifest_anomalies(manifest: &DatasetManifest, shape: &ManifestShape) -> Vec<String> {
    let mut issues = Vec::new();

    if matches!(manifest.kind, DatasetKind::Plate { .. }) {
        if shape.plate_rows == Some(0) {
            issues.push("plate has zero rows".into());
        }
        if shape.plate_columns == Some(0) {
            issues.push("plate has zero columns".into());
        }
        if shape.n_fields == 0 {
            issues.push("plate has wells but no fields".into());
        }
    }

    if shape.n_orphans > 0 {
        issues.push(format!(
            "{} field(s) reference a parent entity that doesn't exist",
            shape.n_orphans
        ));
    }
    if shape.n_fields_without_image > 0 {
        issues.push(format!(
            "{} field(s) have no associated image",
            shape.n_fields_without_image
        ));
    }

    if let Some(default_id) = &manifest.default_layout_id {
        let layout_ids: HashSet<&LayoutId> =
            manifest.source_layouts().iter().map(|l| &l.id).collect();
        if !layout_ids.contains(default_id) {
            issues.push(format!(
                "default_layout_id '{}' is not in source_layouts",
                default_id.0
            ));
        }
    }

    issues
}

/// Short, stable label for the dataset kind (e.g. `"Single"`, `"Plate"`).
/// Avoids leaking the full Debug output (which includes row/column lists).
fn kind_label(kind: &DatasetKind) -> &'static str {
    match kind {
        DatasetKind::Single => "Single",
        DatasetKind::Plate { .. } => "Plate",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::test_helpers;

    #[test]
    fn viewport_command_round_trips_through_json() {
        let cmd = ViewportCommand::Pan { dx: 10.0, dy: -5.0 };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"pan","dx":10.0,"dy":-5.0}"#);
        let _parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn command_wrapper_round_trips_viewport() {
        let cmd = Command::Viewport(ViewportCommand::Pan { dx: 10.0, dy: -5.0 });
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"pan","dx":10.0,"dy":-5.0}"#);
        let parsed: Command = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            parsed,
            Command::Viewport(ViewportCommand::Pan { .. })
        ));
    }

    #[test]
    fn command_wrapper_round_trips_document() {
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        let cmd = Command::Document(DocumentCommand::DatasetOpened(reg));
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"dataset_opened\""));
        let parsed: Command = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            parsed,
            Command::Document(DocumentCommand::DatasetOpened(_))
        ));
    }

    #[test]
    fn apply_pan_updates_center() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::Pan { dx: 100.0, dy: 0.0 }.into());
        if let Camera::Slice(ref v) = scene.camera {
            assert_eq!(v.center, [100.0, 0.0]);
        } else {
            panic!("expected Slice");
        }
    }

    #[test]
    fn apply_set_z_updates_view() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::SetZ { z: 42 }.into());
        assert_eq!(scene.view.z_range, 42..43);
    }

    #[test]
    fn apply_set_mode_3d_switches_camera() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::SetMode3D.into());
        assert!(matches!(scene.camera, Camera::Arcball(_)));
    }

    #[test]
    fn dataset_opened_command_round_trips() {
        let reg = test_helpers::make_dataset_opened("ds1", "test dataset", 1);
        let cmd = DocumentCommand::DatasetOpened(reg);
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"dataset_opened\""));
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::DatasetOpened(r) => {
                assert_eq!(r.manifest.dataset_id, DatasetId("ds1".into()));
                assert_eq!(r.manifest.name, "test dataset");
            }
            _ => panic!("expected DatasetOpened"),
        }
    }

    #[test]
    fn remove_dataset_command_round_trips() {
        let cmd = DocumentCommand::RemoveDataset {
            id: DatasetId("ds1".into()),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"remove_dataset\""));
        let _parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn apply_dataset_opened_populates_scene() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert_eq!(scene.document.manifests.len(), 1);
        assert!(
            scene
                .document
                .manifests
                .contains_key(&DatasetId("ds1".into()))
        );
        assert!(scene.derived.contains_key(&DatasetId("ds1".into())));
    }

    #[test]
    fn set_dataset_order_round_trips() {
        let cmd = ViewportCommand::SetDatasetOrder {
            order: vec!["a".into(), "b".into()],
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_dataset_order\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetDatasetOrder { order } => assert_eq!(order, vec!["a", "b"]),
            _ => panic!("expected SetDatasetOrder"),
        }
    }

    #[test]
    fn set_dataset_visible_round_trips() {
        let cmd = ViewportCommand::SetDatasetVisible {
            dataset_id: "ds1".into(),
            visible: false,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_dataset_visible\""));
        let _parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn set_dataset_blend_mode_round_trips() {
        let cmd = ViewportCommand::SetDatasetBlendMode {
            dataset_id: "ds1".into(),
            blend_mode: crate::scene::BlendMode::Additive,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"additive\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetDatasetBlendMode { blend_mode, .. } => {
                assert_eq!(blend_mode, crate::scene::BlendMode::Additive);
            }
            _ => panic!("expected SetDatasetBlendMode"),
        }
    }

    #[test]
    fn set_dataset_render_mode_round_trips() {
        let cmd = ViewportCommand::SetDatasetRenderMode {
            dataset_id: "ds1".into(),
            render_mode: crate::scene::RenderMode::MaxIntensity,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"max_intensity\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetDatasetRenderMode { render_mode, .. } => {
                assert_eq!(render_mode, crate::scene::RenderMode::MaxIntensity);
            }
            _ => panic!("expected SetDatasetRenderMode"),
        }
    }

    #[test]
    fn set_dataset_detail_level_override_round_trips() {
        let cmd = ViewportCommand::SetDatasetDetailLevelOverride {
            dataset_id: "ds1".into(),
            level: Some(2),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(
            json,
            r#"{"type":"set_dataset_detail_level_override","dataset_id":"ds1","level":2}"#
        );
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetDatasetDetailLevelOverride { dataset_id, level } => {
                assert_eq!(dataset_id, "ds1");
                assert_eq!(level, Some(2));
            }
            _ => panic!("expected SetDatasetDetailLevelOverride"),
        }
    }

    #[test]
    fn apply_set_dataset_visible_updates_settings() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert!(scene.dataset_settings[&DatasetId("ds1".into())].visible);
        scene.apply(
            ViewportCommand::SetDatasetVisible {
                dataset_id: "ds1".into(),
                visible: false,
            }
            .into(),
        );
        assert!(!scene.dataset_settings[&DatasetId("ds1".into())].visible);
    }

    #[test]
    fn apply_set_dataset_opacity_updates_settings() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert_eq!(
            scene.dataset_settings[&DatasetId("ds1".into())].opacity,
            1.0
        );
        scene.apply(
            ViewportCommand::SetDatasetOpacity {
                dataset_id: "ds1".into(),
                opacity: 0.5,
            }
            .into(),
        );
        assert_eq!(
            scene.dataset_settings[&DatasetId("ds1".into())].opacity,
            0.5
        );
    }

    #[test]
    fn apply_set_dataset_detail_level_override_updates_settings() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 8, 512, 512],
            [1, 1, 1, 128, 128],
            3,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(
            ViewportCommand::SetDatasetDetailLevelOverride {
                dataset_id: "ds1".into(),
                level: Some(2),
            }
            .into(),
        );
        assert_eq!(
            scene.dataset_settings[&DatasetId("ds1".into())].detail_level_override,
            Some(2)
        );
        scene.apply(
            ViewportCommand::SetDatasetDetailLevelOverride {
                dataset_id: "ds1".into(),
                level: None,
            }
            .into(),
        );
        assert_eq!(
            scene.dataset_settings[&DatasetId("ds1".into())].detail_level_override,
            None
        );
    }

    #[test]
    fn detail_level_override_clamps_to_selectable_source_levels() {
        let mut scene = Scene::new([800, 600]);
        let mut reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 8, 512, 512],
            [1, 1, 1, 128, 128],
            4,
        );
        let multiscale = &mut reg.manifest.images_mut()[0].multiscale;
        multiscale.coarse_level_index = Some(3);
        multiscale
            .generated_levels
            .push(lucida_content::GeneratedLevelInfo {
                level_index: 3,
                role: lucida_content::GeneratedLevelRole::Coarse,
                provenance: lucida_content::GeneratedLevelProvenance {
                    generator: "test".into(),
                    config_id: "coarse".into(),
                    source_content_id: None,
                },
            });

        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(
            ViewportCommand::SetDatasetDetailLevelOverride {
                dataset_id: "ds1".into(),
                level: Some(3),
            }
            .into(),
        );
        assert_eq!(
            scene.dataset_settings[&DatasetId("ds1".into())].detail_level_override,
            Some(2)
        );
    }

    #[test]
    fn apply_remove_dataset_removes_from_scene() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert_eq!(scene.document.manifests.len(), 1);
        scene.apply(
            DocumentCommand::RemoveDataset {
                id: DatasetId("ds1".into()),
            }
            .into(),
        );
        assert!(scene.document.manifests.is_empty());
    }

    #[test]
    fn document_state_apply_dataset_opened() {
        let mut doc = crate::scene::DocumentState::default();
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        doc.apply(DocumentCommand::DatasetOpened(reg));
        assert_eq!(doc.manifests.len(), 1);
        assert!(doc.manifests.contains_key(&DatasetId("ds1".into())));
    }

    #[test]
    fn document_state_apply_remove_dataset() {
        let mut doc = crate::scene::DocumentState::default();
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        doc.apply(DocumentCommand::DatasetOpened(reg));
        assert_eq!(doc.manifests.len(), 1);
        doc.apply(DocumentCommand::RemoveDataset {
            id: DatasetId("ds1".into()),
        });
        assert!(doc.manifests.is_empty());
    }

    #[test]
    fn viewport_commands_are_not_document_commands() {
        // These should all deserialize as ViewportCommand, not DocumentCommand
        let cmds = vec![
            r#"{"type":"set_dataset_order","order":[]}"#,
            r#"{"type":"set_dataset_visible","dataset_id":"x","visible":true}"#,
            r#"{"type":"pan","dx":1.0,"dy":2.0}"#,
        ];
        for json in cmds {
            assert!(
                serde_json::from_str::<DocumentCommand>(json).is_err(),
                "should not parse as DocumentCommand: {}",
                json
            );
            assert!(
                serde_json::from_str::<ViewportCommand>(json).is_ok(),
                "should parse as ViewportCommand: {}",
                json
            );
        }
    }

    // --- Colormap / Channel tests ---

    #[test]
    fn colormap_serde_round_trips() {
        use crate::scene::Colormap;
        let all = vec![
            Colormap::Gray,
            Colormap::Magenta,
            Colormap::Green,
            Colormap::Cyan,
            Colormap::Red,
            Colormap::Blue,
            Colormap::Yellow,
            Colormap::Viridis,
            Colormap::Inferno,
            Colormap::Plasma,
            Colormap::Magma,
            Colormap::Turbo,
            Colormap::Hot,
            Colormap::Cool,
            Colormap::Jet,
        ];
        for cm in &all {
            let json = serde_json::to_string(cm).unwrap();
            let parsed: Colormap = serde_json::from_str(&json).unwrap();
            assert_eq!(*cm, parsed);
        }
    }

    #[test]
    fn channel_settings_serde_round_trips() {
        use crate::scene::{ChannelSettings, Colormap};
        let cs = ChannelSettings {
            visible: false,
            colormap: Colormap::Viridis,
            contrast_min: 100.0,
            contrast_max: 50000.0,
            gamma: 0.8,
        };
        let json = serde_json::to_string(&cs).unwrap();
        let parsed: ChannelSettings = serde_json::from_str(&json).unwrap();
        assert!(!parsed.visible);
        assert_eq!(parsed.colormap, Colormap::Viridis);
        assert_eq!(parsed.contrast_min, 100.0);
        assert_eq!(parsed.contrast_max, 50000.0);
        assert_eq!(parsed.gamma, 0.8);
    }

    #[test]
    fn set_multi_channel_round_trips() {
        let cmd = ViewportCommand::SetMultiChannel { enabled: true };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_multi_channel\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetMultiChannel { enabled } => assert!(enabled),
            _ => panic!("expected SetMultiChannel"),
        }
    }

    #[test]
    fn set_channel_visible_round_trips() {
        let cmd = ViewportCommand::SetChannelVisible {
            dataset_id: "ds1".into(),
            channel: 2,
            visible: false,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_channel_visible\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetChannelVisible {
                dataset_id,
                channel,
                visible,
            } => {
                assert_eq!(dataset_id, "ds1");
                assert_eq!(channel, 2);
                assert!(!visible);
            }
            _ => panic!("expected SetChannelVisible"),
        }
    }

    #[test]
    fn set_channel_colormap_round_trips() {
        let cmd = ViewportCommand::SetChannelColormap {
            dataset_id: "ds1".into(),
            channel: 0,
            colormap: crate::scene::Colormap::Viridis,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"viridis\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetChannelColormap { colormap, .. } => {
                assert_eq!(colormap, crate::scene::Colormap::Viridis);
            }
            _ => panic!("expected SetChannelColormap"),
        }
    }

    #[test]
    fn set_channel_contrast_round_trips() {
        let cmd = ViewportCommand::SetChannelContrast {
            dataset_id: "ds1".into(),
            channel: 1,
            min: 50.0,
            max: 30000.0,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_channel_contrast\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetChannelContrast {
                dataset_id,
                channel,
                min,
                max,
            } => {
                assert_eq!(dataset_id, "ds1");
                assert_eq!(channel, 1);
                assert_eq!(min, 50.0);
                assert_eq!(max, 30000.0);
            }
            _ => panic!("expected SetChannelContrast"),
        }
    }

    #[test]
    fn set_channel_gamma_round_trips() {
        let cmd = ViewportCommand::SetChannelGamma {
            dataset_id: "ds1".into(),
            channel: 0,
            gamma: 2.2,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_channel_gamma\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetChannelGamma {
                dataset_id,
                channel,
                gamma,
            } => {
                assert_eq!(dataset_id, "ds1");
                assert_eq!(channel, 0);
                assert_eq!(gamma, 2.2);
            }
            _ => panic!("expected SetChannelGamma"),
        }
    }

    #[test]
    fn set_channel_blend_mode_round_trips() {
        let cmd = ViewportCommand::SetChannelBlendMode {
            dataset_id: "ds1".into(),
            blend_mode: crate::scene::BlendMode::Additive,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"additive\""));
        let parsed: ViewportCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            ViewportCommand::SetChannelBlendMode {
                dataset_id,
                blend_mode,
            } => {
                assert_eq!(dataset_id, "ds1");
                assert_eq!(blend_mode, crate::scene::BlendMode::Additive);
            }
            _ => panic!("expected SetChannelBlendMode"),
        }
    }

    #[test]
    fn apply_set_multi_channel_updates_view() {
        let mut scene = Scene::new([800, 600]);
        assert!(!scene.view.multi_channel);
        scene.apply(ViewportCommand::SetMultiChannel { enabled: true }.into());
        assert!(scene.view.multi_channel);
        scene.apply(ViewportCommand::SetMultiChannel { enabled: false }.into());
        assert!(!scene.view.multi_channel);
    }

    #[test]
    fn apply_set_channel_colormap_updates_settings() {
        use crate::scene::Colormap;
        let mut scene = Scene::new([800, 600]);
        // Register a dataset with 2 channels
        let reg = test_helpers::make_dataset_opened("ds1", "test", 2);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        // Verify default colormap assignments
        let ds_id = DatasetId("ds1".into());
        assert_eq!(
            scene.dataset_settings[&ds_id].channel_settings[0].colormap,
            Colormap::Magenta
        );
        assert_eq!(
            scene.dataset_settings[&ds_id].channel_settings[1].colormap,
            Colormap::Green
        );
        // Apply SetChannelColormap
        scene.apply(
            ViewportCommand::SetChannelColormap {
                dataset_id: "ds1".into(),
                channel: 1,
                colormap: Colormap::Viridis,
            }
            .into(),
        );
        assert_eq!(
            scene.dataset_settings[&ds_id].channel_settings[1].colormap,
            Colormap::Viridis
        );
    }

    #[test]
    fn dataset_opened_initializes_channel_settings() {
        use crate::scene::Colormap;
        let mut scene = Scene::new([800, 600]);
        // Register with 4 channels
        let reg = test_helpers::make_dataset_opened("ds1", "test", 4);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("ds1".into());
        let ch = &scene.dataset_settings[&ds_id].channel_settings;
        assert_eq!(ch.len(), 4);
        // Cycling: Magenta, Green, Cyan, Magenta
        assert_eq!(ch[0].colormap, Colormap::Magenta);
        assert_eq!(ch[1].colormap, Colormap::Green);
        assert_eq!(ch[2].colormap, Colormap::Cyan);
        assert_eq!(ch[3].colormap, Colormap::Magenta);
        // All visible by default
        for c in ch {
            assert!(c.visible);
            assert_eq!(c.contrast_min, 0.0);
            assert_eq!(c.contrast_max, 65535.0);
            assert_eq!(c.gamma, 1.0);
        }
    }

    // --- Epoch tests ---

    #[test]
    fn dataset_opened_bumps_content_and_layout_epochs() {
        let mut scene = Scene::new([800, 600]);
        assert_eq!(scene.epochs.content, 0);
        assert_eq!(scene.epochs.layout, 0);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert_eq!(scene.epochs.content, 1);
        assert_eq!(scene.epochs.layout, 1);
        assert_eq!(scene.epochs.view, 0);
        assert_eq!(scene.epochs.selection, 0);
    }

    #[test]
    fn remove_dataset_bumps_content_and_layout_epochs() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(
            DocumentCommand::RemoveDataset {
                id: DatasetId("ds1".into()),
            }
            .into(),
        );
        assert_eq!(scene.epochs.content, 2);
        assert_eq!(scene.epochs.layout, 2);
    }

    #[test]
    fn pan_bumps_only_view_epoch() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::Pan { dx: 10.0, dy: 0.0 }.into());
        assert_eq!(scene.epochs.view, 1);
        assert_eq!(scene.epochs.content, 0);
        assert_eq!(scene.epochs.layout, 0);
        assert_eq!(scene.epochs.selection, 0);
    }

    #[test]
    fn set_t_bumps_only_selection_epoch() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::SetT { t: 5 }.into());
        assert_eq!(scene.epochs.selection, 1);
        assert_eq!(scene.epochs.view, 0);
        assert_eq!(scene.epochs.content, 0);
        assert_eq!(scene.epochs.layout, 0);
    }

    #[test]
    fn epochs_increase_monotonically() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(ViewportCommand::Pan { dx: 1.0, dy: 0.0 }.into());
        scene.apply(ViewportCommand::Pan { dx: 1.0, dy: 0.0 }.into());
        scene.apply(ViewportCommand::Pan { dx: 1.0, dy: 0.0 }.into());
        assert_eq!(scene.epochs.view, 3);
    }

    // --- Asset catalog tests ---

    #[test]
    fn apply_asset_catalog_delta_bumps_only_asset_epoch() {
        use lucida_protocol::{AssetCatalogDelta, ProxyAvailability, ProxyKind};
        let mut scene = Scene::new([800, 600]);
        // Register a dataset first so the catalog is initialized.
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let baseline = scene.epochs.clone();
        assert_eq!(baseline.asset, 0);

        let cmd = DocumentCommand::ApplyAssetCatalogDelta {
            dataset_id: DatasetId("ds1".into()),
            delta: AssetCatalogDelta {
                added: vec![ProxyAvailability {
                    entity_id: lucida_content::EntityId("ds1-entity".into()),
                    kinds: vec![ProxyKind::FieldProxy3D],
                    footprints: vec![],
                }],
            },
        };
        scene.apply(cmd.into());

        assert_eq!(scene.epochs.asset, 1);
        // No other epoch should change.
        assert_eq!(scene.epochs.content, baseline.content);
        assert_eq!(scene.epochs.layout, baseline.layout);
        assert_eq!(scene.epochs.view, baseline.view);
        assert_eq!(scene.epochs.selection, baseline.selection);
    }

    #[test]
    fn apply_asset_catalog_delta_idempotent_on_repeat() {
        use lucida_protocol::{AssetCatalogDelta, ProxyAvailability, ProxyKind};
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let delta = AssetCatalogDelta {
            added: vec![ProxyAvailability {
                entity_id: lucida_content::EntityId("ds1-entity".into()),
                kinds: vec![ProxyKind::FieldProxy3D],
                footprints: vec![],
            }],
        };
        let cmd1 = DocumentCommand::ApplyAssetCatalogDelta {
            dataset_id: DatasetId("ds1".into()),
            delta: delta.clone(),
        };
        let cmd2 = DocumentCommand::ApplyAssetCatalogDelta {
            dataset_id: DatasetId("ds1".into()),
            delta,
        };

        scene.apply(cmd1.into());
        let after_first = scene.document.asset_catalogs[&DatasetId("ds1".into())].clone();
        // Asset epoch bumps each call (it's the message-arrival counter; whether
        // catalog *contents* changed is checked separately below).
        assert_eq!(scene.epochs.asset, 1);

        scene.apply(cmd2.into());
        let after_second = scene.document.asset_catalogs[&DatasetId("ds1".into())].clone();

        // Catalog contents must be identical — the merge must dedupe.
        assert_eq!(after_first, after_second);
        assert_eq!(after_second.entries.len(), 1);
        assert_eq!(after_second.entries[0].kinds, vec![ProxyKind::FieldProxy3D]);
    }

    #[test]
    fn apply_asset_catalog_delta_merges_kinds_for_same_entity() {
        use lucida_protocol::{AssetCatalogDelta, ProxyAvailability, ProxyKind};
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        scene.apply(
            DocumentCommand::ApplyAssetCatalogDelta {
                dataset_id: DatasetId("ds1".into()),
                delta: AssetCatalogDelta {
                    added: vec![ProxyAvailability {
                        entity_id: lucida_content::EntityId("e1".into()),
                        kinds: vec![ProxyKind::FieldProxy3D],
                        footprints: vec![],
                    }],
                },
            }
            .into(),
        );

        scene.apply(
            DocumentCommand::ApplyAssetCatalogDelta {
                dataset_id: DatasetId("ds1".into()),
                delta: AssetCatalogDelta {
                    added: vec![ProxyAvailability {
                        entity_id: lucida_content::EntityId("e1".into()),
                        kinds: vec![ProxyKind::WellProxy3D],
                        footprints: vec![],
                    }],
                },
            }
            .into(),
        );

        let cat = &scene.document.asset_catalogs[&DatasetId("ds1".into())];
        assert_eq!(cat.entries.len(), 1);
        assert!(cat.entries[0].kinds.contains(&ProxyKind::FieldProxy3D));
        assert!(cat.entries[0].kinds.contains(&ProxyKind::WellProxy3D));
    }

    #[test]
    fn dataset_opened_seeds_catalog_from_event() {
        use lucida_protocol::{AssetCatalog, ProxyAvailability, ProxyKind};
        let mut scene = Scene::new([800, 600]);
        let mut reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        reg.catalog = AssetCatalog {
            entries: vec![ProxyAvailability {
                entity_id: lucida_content::EntityId("seed".into()),
                kinds: vec![ProxyKind::WellProxy3D],
                footprints: vec![],
            }],
        };
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let cat = &scene.document.asset_catalogs[&DatasetId("ds1".into())];
        assert_eq!(cat.entries.len(), 1);
        assert_eq!(
            cat.entries[0].entity_id,
            lucida_content::EntityId("seed".into())
        );
    }

    #[test]
    fn apply_asset_catalog_delta_command_round_trips() {
        use lucida_protocol::{AssetCatalogDelta, ProxyAvailability, ProxyKind};
        let cmd = DocumentCommand::ApplyAssetCatalogDelta {
            dataset_id: DatasetId("ds1".into()),
            delta: AssetCatalogDelta {
                added: vec![ProxyAvailability {
                    entity_id: lucida_content::EntityId("e1".into()),
                    kinds: vec![ProxyKind::FieldProxy3D],
                    footprints: vec![],
                }],
            },
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"apply_asset_catalog_delta\""));
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::ApplyAssetCatalogDelta { dataset_id, delta } => {
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(delta.added.len(), 1);
                assert_eq!(delta.added[0].kinds, vec![ProxyKind::FieldProxy3D]);
            }
            _ => panic!("expected ApplyAssetCatalogDelta"),
        }
    }

    #[test]
    fn scene_epochs_serde_round_trip() {
        use crate::epoch::SceneEpochs;
        let epochs = SceneEpochs {
            content: 1,
            layout: 2,
            view: 3,
            selection: 4,
            asset: 5,
            annotation: 6,
        };
        let json = serde_json::to_string(&epochs).unwrap();
        let parsed: SceneEpochs = serde_json::from_str(&json).unwrap();
        assert_eq!(epochs, parsed);
    }

    #[test]
    fn dataset_display_settings_backward_compat() {
        // Deserialize JSON without channel_settings or channel_blend_mode
        let json = r#"{
            "visible": true,
            "opacity": 1.0,
            "contrast_min": 0.0,
            "contrast_max": 65535.0,
            "gamma": 1.0,
            "blend_mode": "alpha"
        }"#;
        let settings: crate::scene::DatasetDisplaySettings = serde_json::from_str(json).unwrap();
        assert!(settings.channel_settings.is_empty());
        assert_eq!(settings.detail_level_override, None);
        assert_eq!(
            settings.channel_blend_mode,
            crate::scene::BlendMode::Additive
        );
    }

    // --- Layout registration and switching tests ---

    #[test]
    fn register_layout_command_serde_round_trip() {
        use lucida_content::{EntityId, LayoutId, LayoutSpec, layout::EntityPlacement};
        let cmd = DocumentCommand::RegisterLayout {
            dataset_id: DatasetId("ds1".into()),
            layout: LayoutSpec {
                id: LayoutId("custom".into()),
                name: "Custom Layout".into(),
                placements: vec![EntityPlacement {
                    entity_id: EntityId("e1".into()),
                    position: [10.0, 20.0],
                }],
            },
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"register_layout\""));
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::RegisterLayout { dataset_id, layout } => {
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(layout.id, LayoutId("custom".into()));
                assert_eq!(layout.name, "Custom Layout");
                assert_eq!(layout.placements.len(), 1);
            }
            _ => panic!("expected RegisterLayout"),
        }
    }

    #[test]
    fn set_active_layout_command_serde_round_trip() {
        use lucida_content::LayoutId;
        let cmd = DocumentCommand::SetActiveLayout {
            dataset_id: DatasetId("ds1".into()),
            layout_id: LayoutId("layout-2".into()),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"set_active_layout\""));
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::SetActiveLayout {
                dataset_id,
                layout_id,
            } => {
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(layout_id, LayoutId("layout-2".into()));
            }
            _ => panic!("expected SetActiveLayout"),
        }
    }

    #[test]
    fn register_layout_makes_it_available() {
        use lucida_content::{EntityId, LayoutId, LayoutSpec, layout::EntityPlacement};
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let layout = LayoutSpec {
            id: LayoutId("new-layout".into()),
            name: "New Layout".into(),
            placements: vec![EntityPlacement {
                entity_id: EntityId("ds1-entity".into()),
                position: [100.0, 200.0],
            }],
        };
        scene.apply(
            DocumentCommand::RegisterLayout {
                dataset_id: DatasetId("ds1".into()),
                layout,
            }
            .into(),
        );

        let ds_id = DatasetId("ds1".into());
        assert!(scene.document.registered_layouts.contains_key(&ds_id));
        let layouts = &scene.document.registered_layouts[&ds_id];
        assert_eq!(layouts.len(), 1);
        assert_eq!(layouts[0].id, LayoutId("new-layout".into()));
        assert_eq!(layouts[0].name, "New Layout");
    }

    #[test]
    fn register_layout_dedupes_by_id() {
        use lucida_content::{EntityId, LayoutId, LayoutSpec, layout::EntityPlacement};
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("ds1".into());

        let spec = LayoutSpec {
            id: LayoutId("derived:dense".into()),
            name: "Dense".into(),
            placements: vec![EntityPlacement {
                entity_id: EntityId("ds1-entity".into()),
                position: [0.0, 0.0],
            }],
        };

        scene.apply(
            DocumentCommand::RegisterLayout {
                dataset_id: ds_id.clone(),
                layout: spec.clone(),
            }
            .into(),
        );
        scene.apply(
            DocumentCommand::RegisterLayout {
                dataset_id: ds_id.clone(),
                layout: spec.clone(),
            }
            .into(),
        );

        let layouts = &scene.document.registered_layouts[&ds_id];
        assert_eq!(layouts.len(), 1);
        assert_eq!(layouts[0].id, LayoutId("derived:dense".into()));
    }

    #[test]
    fn set_active_layout_rebuilds_derived_state() {
        use lucida_content::{EntityId, LayoutId, LayoutSpec, layout::EntityPlacement};
        let mut scene = Scene::new([800, 600]);

        // Register a plate dataset with two members
        let reg = test_helpers::make_plate_dataset_opened(
            "plate",
            "plate",
            vec![("m1", [0.0, 0.0]), ("m2", [256.0, 0.0])],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 256, 256],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let ds_id = DatasetId("plate".into());
        // Verify initial positions
        let derived = &scene.derived[&ds_id];
        assert_eq!(derived.members[0].position, [0.0, 0.0]);
        assert_eq!(derived.members[1].position, [256.0, 0.0]);

        // Register a layout with different positions
        let alt_layout = LayoutSpec {
            id: LayoutId("alt".into()),
            name: "Alternative".into(),
            placements: vec![
                EntityPlacement {
                    entity_id: EntityId("m1".into()),
                    position: [500.0, 500.0],
                },
                EntityPlacement {
                    entity_id: EntityId("m2".into()),
                    position: [1000.0, 500.0],
                },
            ],
        };
        scene.apply(
            DocumentCommand::RegisterLayout {
                dataset_id: ds_id.clone(),
                layout: alt_layout,
            }
            .into(),
        );

        // Set the alt layout as active
        scene.apply(
            DocumentCommand::SetActiveLayout {
                dataset_id: ds_id.clone(),
                layout_id: LayoutId("alt".into()),
            }
            .into(),
        );

        // Verify positions changed
        let derived = &scene.derived[&ds_id];
        assert_eq!(derived.members[0].position, [500.0, 500.0]);
        assert_eq!(derived.members[1].position, [1000.0, 500.0]);
        assert_eq!(derived.active_layout.id, LayoutId("alt".into()));
    }

    #[test]
    fn set_active_layout_updates_active_layout_ids() {
        use lucida_content::LayoutId;
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let ds_id = DatasetId("ds1".into());
        assert!(!scene.document.active_layout_ids.contains_key(&ds_id));

        scene.apply(
            DocumentCommand::SetActiveLayout {
                dataset_id: ds_id.clone(),
                layout_id: LayoutId("some-layout".into()),
            }
            .into(),
        );

        assert_eq!(
            scene.document.active_layout_ids[&ds_id],
            LayoutId("some-layout".into()),
        );
    }

    // --- Annotation tests ---

    #[test]
    fn add_annotation_command_matches_wire_contract() {
        // Field-for-field check against the slice's documented add wire shape.
        let cmd = DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-abc".into()),
            id: "11111111-2222-3333-4444-555555555555".into(),
            position: [12.5, -7.25],
            end: None,
            z: 3.5,
            t: 4,
            c: 2,
            author: "biologist".into(),
            kind: crate::scene::AnnotationKind::Point,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "add_annotation");
        assert_eq!(v["dataset_id"], "wds-abc");
        assert_eq!(v["id"], "11111111-2222-3333-4444-555555555555");
        assert_eq!(v["position"][0], 12.5);
        assert_eq!(v["position"][1], -7.25);
        assert_eq!(v["z"], 3.5);
        // The view's timepoint/channel ride the wire alongside z.
        assert_eq!(v["t"], 4);
        assert_eq!(v["c"], 2);
        assert_eq!(v["author"], "biologist");
        assert_eq!(v["kind"], "point");
        // A point carries `end: null` on the wire.
        assert!(v["end"].is_null());

        // And it parses back from exactly that shape.
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
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
                assert_eq!(dataset_id, DatasetId("wds-abc".into()));
                assert_eq!(id, "11111111-2222-3333-4444-555555555555");
                assert_eq!(position, [12.5, -7.25]);
                assert_eq!(end, None);
                assert_eq!(z, 3.5);
                assert_eq!(t, 4);
                assert_eq!(c, 2);
                assert_eq!(author, "biologist");
                assert_eq!(kind, crate::scene::AnnotationKind::Point);
            }
            _ => panic!("expected AddAnnotation"),
        }
    }

    #[test]
    fn add_annotation_parses_from_documented_client_payload() {
        // Verbatim client->server payload from the slice-3 wire contract,
        // which now carries an additive `z` depth alongside `position`.
        let json = r#"{"type":"add_annotation","dataset_id":"wds-1","id":"pin-1","position":[3.0,4.0],"z":5.0,"author":"alice","kind":"point"}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
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
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(id, "pin-1");
                assert_eq!(position, [3.0, 4.0]);
                // No `end` in the slice-1..4 payload → a point.
                assert_eq!(end, None);
                assert_eq!(z, 5.0);
                // This payload predates t/c → they default to 0 (no wire break).
                assert_eq!(t, 0);
                assert_eq!(c, 0);
                assert_eq!(author, "alice");
                assert_eq!(kind, crate::scene::AnnotationKind::Point);
            }
            _ => panic!("expected AddAnnotation"),
        }
    }

    #[test]
    fn add_annotation_z_defaults_to_zero_for_slice12_payload() {
        // A slice-1/2 client (or a replayed older log entry) sends no `z`.
        // #[serde(default)] must parse it as z = 0.0 rather than failing —
        // this is the wire backward-compatibility guarantee, no [2]->[3] break.
        let json = r#"{"type":"add_annotation","dataset_id":"wds-1","id":"pin-1","position":[3.0,4.0],"author":"alice","kind":"point"}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::AddAnnotation { position, z, .. } => {
                assert_eq!(position, [3.0, 4.0]);
                assert_eq!(z, 0.0);
            }
            _ => panic!("expected AddAnnotation"),
        }
    }

    // --- slice 014: a pin records its view T/C (issue #779) ---

    #[test]
    fn add_annotation_t_c_round_trip_through_command_wire() {
        // The view's timepoint/channel must survive serialize -> parse
        // byte-for-byte (the per-peer broadcast path), exactly like z.
        let cmd = DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-tc".into(),
            position: [1.0, 2.0],
            end: None,
            z: 0.0,
            t: 7,
            c: 3,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::AddAnnotation { t, c, .. } => {
                assert_eq!(t, 7);
                assert_eq!(c, 3);
            }
            _ => panic!("expected AddAnnotation"),
        }
    }

    #[test]
    fn add_annotation_carries_t_c_into_stored_pin() {
        // Applying the command must land t/c on the stored pin — the state the
        // overlay reads back to decide on-context vs off-context.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-tc".into(),
            position: [1.0, 2.0],
            end: None,
            z: 4.0,
            t: 9,
            c: 5,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
        });
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.t, 9);
        assert_eq!(pin.c, 5);
        // z still rides through unchanged alongside the new t/c.
        assert_eq!(pin.z, 4.0);
    }

    #[test]
    fn add_annotation_t_c_default_to_zero_for_pre_slice14_payload() {
        // A pin payload from before this slice carries neither `t` nor `c`.
        // #[serde(default)] must parse them as 0 rather than failing — the wire
        // backward-compatibility guarantee (additive, no break).
        let json = r#"{"type":"add_annotation","dataset_id":"wds-1","id":"pin-old","position":[3.0,4.0],"z":5.0,"author":"alice","kind":"point"}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::AddAnnotation { t, c, z, .. } => {
                assert_eq!(t, 0);
                assert_eq!(c, 0);
                assert_eq!(z, 5.0);
            }
            _ => panic!("expected AddAnnotation"),
        }
    }

    #[test]
    fn old_pin_blob_without_t_c_deserializes_with_t0_c0() {
        // A persisted `Annotation` blob (a snapshot pin) from before this slice
        // has no t/c keys. It must deserialize with t = 0, c = 0 so an older
        // document loads without a wire break.
        let json =
            r#"{"id":"pin-old","position":[3.0,4.0],"z":2.0,"author":"alice","kind":"point"}"#;
        let pin: crate::scene::Annotation = serde_json::from_str(json).unwrap();
        assert_eq!(pin.t, 0);
        assert_eq!(pin.c, 0);
        // The pre-existing fields still load as before.
        assert_eq!(pin.z, 2.0);
        assert_eq!(pin.position, [3.0, 4.0]);
        assert_eq!(pin.end, None);
    }

    #[test]
    fn annotation_with_t_c_round_trips_through_blob() {
        // A pin carrying t/c serializes and parses back identically — the
        // snapshot/persistence path (document_json) preserves the view context.
        let pin = crate::scene::Annotation {
            id: "pin-tc".into(),
            position: [10.0, 20.0],
            end: None,
            z: 1.0,
            t: 12,
            c: 2,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
            comments: Vec::new(),
            anchor: None,
        };
        let json = serde_json::to_string(&pin).unwrap();
        let back: crate::scene::Annotation = serde_json::from_str(&json).unwrap();
        assert_eq!(back, pin);
        assert_eq!(back.t, 12);
        assert_eq!(back.c, 2);
    }

    #[test]
    fn remove_annotation_command_matches_wire_contract() {
        let cmd = DocumentCommand::RemoveAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "remove_annotation");
        assert_eq!(v["dataset_id"], "wds-1");
        assert_eq!(v["id"], "pin-1");
        // Remove carries only dataset_id + id.
        assert!(v.get("position").is_none());
        assert!(v.get("author").is_none());

        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, DocumentCommand::RemoveAnnotation { .. }));
    }

    #[test]
    fn add_annotation_kind_defaults_to_point_when_absent() {
        // `kind` is #[serde(default)] for forward-compat; absent => point.
        let json = r#"{"type":"add_annotation","dataset_id":"wds-1","id":"p","position":[0.0,0.0],"author":"a"}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::AddAnnotation { kind, .. } => {
                assert_eq!(kind, crate::scene::AnnotationKind::Point);
            }
            _ => panic!("expected AddAnnotation"),
        }
    }

    // --- slice 005: line + box (kind + end) ---

    #[test]
    fn add_annotation_line_round_trips_kind_and_end() {
        // A line carries kind:"line" and a second vertex `end`; both must
        // survive serialize -> parse byte-for-byte (this is the per-peer
        // broadcast path).
        let cmd = DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "ln-1".into(),
            position: [1.0, 2.0],
            end: Some([5.5, -6.5]),
            z: 3.0,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Line,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["kind"], "line");
        assert_eq!(v["position"][0], 1.0);
        assert_eq!(v["position"][1], 2.0);
        assert_eq!(v["end"][0], 5.5);
        assert_eq!(v["end"][1], -6.5);

        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::AddAnnotation {
                end,
                kind,
                position,
                ..
            } => {
                assert_eq!(kind, crate::scene::AnnotationKind::Line);
                assert_eq!(position, [1.0, 2.0]);
                assert_eq!(end, Some([5.5, -6.5]));
            }
            _ => panic!("expected AddAnnotation"),
        }
    }

    #[test]
    fn add_annotation_box_round_trips_kind_and_end() {
        let json = r#"{"type":"add_annotation","dataset_id":"wds-1","id":"bx-1","position":[0.0,0.0],"end":[10.0,4.0],"z":0.0,"author":"alice","kind":"box"}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::AddAnnotation {
                end,
                kind,
                position,
                ..
            } => {
                assert_eq!(kind, crate::scene::AnnotationKind::Box);
                assert_eq!(position, [0.0, 0.0]);
                assert_eq!(end, Some([10.0, 4.0]));
            }
            _ => panic!("expected AddAnnotation"),
        }
    }

    #[test]
    fn add_annotation_end_defaults_to_none_when_absent() {
        // The backward-compat guarantee: a slice-1..4 command (no `end` key)
        // parses as `end: None` — a plain point — rather than failing.
        let json = r#"{"type":"add_annotation","dataset_id":"wds-1","id":"p","position":[3.0,4.0],"z":1.0,"author":"a","kind":"point"}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::AddAnnotation { end, .. } => assert_eq!(end, None),
            _ => panic!("expected AddAnnotation"),
        }
    }

    #[test]
    fn document_state_add_line_and_box_store_kind_and_end() {
        // Applying line/box commands lands kind + end on the stored pins, and a
        // point still stores end: None — the state the WS harness reads back.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "ln",
            [1.0, 2.0],
            [3.0, 4.0],
            crate::scene::AnnotationKind::Line,
        ));
        doc.apply(add_shape_cmd(
            "wds-1",
            "bx",
            [0.0, 0.0],
            [8.0, 6.0],
            crate::scene::AnnotationKind::Box,
        ));
        doc.apply(add_annotation_cmd("wds-1", "pt", [9.0, 9.0], "alice"));

        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 3);

        let line = pins.iter().find(|p| p.id == "ln").unwrap();
        assert_eq!(line.kind, crate::scene::AnnotationKind::Line);
        assert_eq!(line.end, Some([3.0, 4.0]));

        let r#box = pins.iter().find(|p| p.id == "bx").unwrap();
        assert_eq!(r#box.kind, crate::scene::AnnotationKind::Box);
        assert_eq!(r#box.end, Some([8.0, 6.0]));

        let point = pins.iter().find(|p| p.id == "pt").unwrap();
        assert_eq!(point.kind, crate::scene::AnnotationKind::Point);
        assert_eq!(point.end, None);
    }

    #[test]
    fn line_and_box_survive_document_round_trip() {
        // Restart durability: a line and a box serialize into the document blob
        // and restore with kind + end intact (acceptance behavior 3).
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "ln",
            [1.5, 2.5],
            [3.5, 4.5],
            crate::scene::AnnotationKind::Line,
        ));
        doc.apply(add_shape_cmd(
            "wds-1",
            "bx",
            [-1.0, -2.0],
            [7.0, 8.0],
            crate::scene::AnnotationKind::Box,
        ));
        let blob = serde_json::to_string(&doc).unwrap();
        let restored: crate::scene::DocumentState = serde_json::from_str(&blob).unwrap();
        let pins = &restored.annotations[&DatasetId("wds-1".into())];
        let line = pins.iter().find(|p| p.id == "ln").unwrap();
        assert_eq!(line.kind, crate::scene::AnnotationKind::Line);
        assert_eq!(line.end, Some([3.5, 4.5]));
        let r#box = pins.iter().find(|p| p.id == "bx").unwrap();
        assert_eq!(r#box.kind, crate::scene::AnnotationKind::Box);
        assert_eq!(r#box.end, Some([7.0, 8.0]));
    }

    #[test]
    fn move_annotation_translates_a_lines_end_vertex_rigidly() {
        // MoveAnnotation moves the WHOLE line: the anchor goes to position/z and
        // the far vertex `end` rides along by the same delta, so length/angle are
        // preserved (not a stretch/rotate). The wire still carries only
        // position + z, and `kind` is untouched. Anchor (0,0) -> (2,3) is a
        // +2,+3 delta, so end (10,10) -> (12,13).
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "ln",
            [0.0, 0.0],
            [10.0, 10.0],
            crate::scene::AnnotationKind::Line,
        ));
        doc.apply(DocumentCommand::MoveAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "ln".into(),
            position: [2.0, 3.0],
            // No `end` → the rigid #776 whole-shape translate.
            end: None,
            z: 5.0,
        });
        let line = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(line.position, [2.0, 3.0]);
        assert_eq!(line.z, 5.0);
        assert_eq!(line.kind, crate::scene::AnnotationKind::Line);
        assert_eq!(line.end, Some([12.0, 13.0]));
    }

    // --- Plate annotation anchoring (issue #780) ---

    /// A two-well plate driven entirely through `DocumentState::apply` (the
    /// server's canonical, persisted path), plus a second registered layout
    /// "moved" in which well `w1` shifts by `+[0, 50]` and well `w2` stays put.
    /// The base/source layout is "default" (from `make_plate_dataset_opened`),
    /// placing `w1` at `[0, 0]` and `w2` at `[100, 0]`. Returns the populated
    /// document and the dataset id.
    fn plate_with_two_layouts() -> (crate::scene::DocumentState, DatasetId) {
        use lucida_content::{EntityId, LayoutId, LayoutSpec, layout::EntityPlacement};
        let mut doc = crate::scene::DocumentState::default();
        let reg = test_helpers::make_plate_dataset_opened(
            "plate",
            "plate",
            vec![("w1", [0.0, 0.0]), ("w2", [100.0, 0.0])],
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
        );
        doc.apply(DocumentCommand::DatasetOpened(reg));
        let ds = DatasetId("plate".into());

        // A second layout: w1 slides by +[0, 50]; w2 unchanged at [100, 0].
        let moved = LayoutSpec {
            id: LayoutId("moved".into()),
            name: "Moved".into(),
            placements: vec![
                EntityPlacement {
                    entity_id: EntityId("w1".into()),
                    position: [0.0, 50.0],
                },
                EntityPlacement {
                    entity_id: EntityId("w2".into()),
                    position: [100.0, 0.0],
                },
            ],
        };
        doc.apply(DocumentCommand::RegisterLayout {
            dataset_id: ds.clone(),
            layout: moved,
        });
        (doc, ds)
    }

    fn switch_to(doc: &mut crate::scene::DocumentState, ds: &DatasetId, layout: &str) {
        use lucida_content::LayoutId;
        doc.apply(DocumentCommand::SetActiveLayout {
            dataset_id: ds.clone(),
            layout_id: LayoutId(layout.into()),
        });
    }

    fn pin<'a>(
        doc: &'a crate::scene::DocumentState,
        ds: &DatasetId,
        id: &str,
    ) -> &'a crate::scene::Annotation {
        doc.annotations[ds].iter().find(|p| p.id == id).unwrap()
    }

    #[test]
    fn add_annotation_on_plate_anchors_to_nearest_well() {
        // A pin dropped near w1's active-layout position is glued to w1; one near
        // w2 is glued to w2. The anchor is derived inside apply from synced state.
        use lucida_content::EntityId;
        let (mut doc, ds) = plate_with_two_layouts();
        doc.apply(add_annotation_cmd("plate", "near-w1", [5.0, 5.0], "alice"));
        doc.apply(add_annotation_cmd(
            "plate",
            "near-w2",
            [102.0, 1.0],
            "alice",
        ));
        assert_eq!(
            pin(&doc, &ds, "near-w1").anchor,
            Some(EntityId("w1".into()))
        );
        assert_eq!(
            pin(&doc, &ds, "near-w2").anchor,
            Some(EntityId("w2".into()))
        );
    }

    #[test]
    fn add_annotation_on_non_plate_leaves_anchor_none() {
        // A single-image dataset has nothing to anchor to: the pin stays
        // unanchored and a (hypothetical) layout switch would never move it.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(DocumentCommand::DatasetOpened(
            test_helpers::make_dataset_opened("single", "single", 1),
        ));
        doc.apply(add_annotation_cmd("single", "p", [3.0, 4.0], "alice"));
        assert_eq!(pin(&doc, &DatasetId("single".into()), "p").anchor, None);
    }

    #[test]
    fn point_pin_reanchors_across_layout_switch_and_back_is_exact() {
        // The crux (critical): a point glued to the MOVING well rides the well's
        // +[0,50] delta on switch, and switching back restores the original
        // position exactly.
        let (mut doc, ds) = plate_with_two_layouts();
        doc.apply(add_annotation_cmd("plate", "p", [5.0, 5.0], "alice"));
        assert_eq!(pin(&doc, &ds, "p").position, [5.0, 5.0]);

        switch_to(&mut doc, &ds, "moved");
        assert_eq!(
            pin(&doc, &ds, "p").position,
            [5.0, 55.0],
            "rides w1 by +[0,50]"
        );

        switch_to(&mut doc, &ds, "default");
        assert_eq!(
            pin(&doc, &ds, "p").position,
            [5.0, 5.0],
            "switching back is exact"
        );
    }

    #[test]
    fn line_reanchors_both_vertices_by_the_well_delta() {
        // A line on the moving well: BOTH position and end shift by the same
        // delta (rigid whole-shape translate), length/angle preserved.
        let (mut doc, ds) = plate_with_two_layouts();
        doc.apply(add_shape_cmd(
            "plate",
            "ln",
            [2.0, 2.0],
            [8.0, 6.0],
            crate::scene::AnnotationKind::Line,
        ));
        switch_to(&mut doc, &ds, "moved");
        let ln = pin(&doc, &ds, "ln");
        assert_eq!(ln.position, [2.0, 52.0]);
        assert_eq!(ln.end, Some([8.0, 56.0]));
        // The anchor->end vector is invariant (it's a translate, not a stretch).
        let v_before = [8.0 - 2.0, 6.0 - 2.0];
        let v_after = [
            ln.end.unwrap()[0] - ln.position[0],
            ln.end.unwrap()[1] - ln.position[1],
        ];
        assert_eq!(v_before, v_after);
    }

    #[test]
    fn box_reanchors_both_corners_by_the_well_delta() {
        // A box on the moving well: both opposite corners shift by the delta, so
        // the box keeps its size and slides with the well.
        let (mut doc, ds) = plate_with_two_layouts();
        doc.apply(add_shape_cmd(
            "plate",
            "bx",
            [1.0, 1.0],
            [9.0, 5.0],
            crate::scene::AnnotationKind::Box,
        ));
        switch_to(&mut doc, &ds, "moved");
        let bx = pin(&doc, &ds, "bx");
        assert_eq!(bx.position, [1.0, 51.0]);
        assert_eq!(bx.end, Some([9.0, 55.0]));
    }

    #[test]
    fn pin_on_static_well_does_not_move_across_switch() {
        // Per-entity (critical): a pin glued to w2 (which doesn't move between the
        // two layouts) stays exactly where it was after the switch.
        let (mut doc, ds) = plate_with_two_layouts();
        doc.apply(add_annotation_cmd("plate", "static", [101.0, 2.0], "alice"));
        switch_to(&mut doc, &ds, "moved");
        assert_eq!(pin(&doc, &ds, "static").position, [101.0, 2.0]);
    }

    #[test]
    fn two_pins_each_follow_their_own_well() {
        // Per-entity (critical): in one switch, the w1 pin moves by the w1 delta
        // and the w2 pin doesn't move — each tracks its own anchor independently.
        let (mut doc, ds) = plate_with_two_layouts();
        doc.apply(add_annotation_cmd("plate", "on-w1", [5.0, 5.0], "alice"));
        doc.apply(add_annotation_cmd("plate", "on-w2", [101.0, 2.0], "alice"));
        switch_to(&mut doc, &ds, "moved");
        assert_eq!(pin(&doc, &ds, "on-w1").position, [5.0, 55.0]);
        assert_eq!(pin(&doc, &ds, "on-w2").position, [101.0, 2.0]);
    }

    #[test]
    fn pin_without_anchor_is_left_in_place_on_switch() {
        // Backward-compat (critical): an annotation inserted with NO anchor (as a
        // pre-slice pin would deserialize) is untouched by a layout switch.
        let (mut doc, ds) = plate_with_two_layouts();
        // Insert a pin directly with anchor == None (bypasses the auto-anchor at
        // creation, mimicking a pin that predates this slice).
        doc.add_annotation(
            ds.clone(),
            crate::scene::Annotation {
                id: "legacy".into(),
                position: [5.0, 5.0],
                end: None,
                z: 0.0,
                t: 0,
                c: 0,
                author: "alice".into(),
                kind: crate::scene::AnnotationKind::Point,
                comments: Vec::new(),
                anchor: None,
            },
        );
        switch_to(&mut doc, &ds, "moved");
        assert_eq!(pin(&doc, &ds, "legacy").position, [5.0, 5.0]);
    }

    #[test]
    fn pre_slice_json_without_anchor_parses_and_is_not_moved() {
        // The exact interaction contract: an Annotation deserialized from
        // pre-slice JSON (no `anchor` key) must still parse (as None) and not be
        // moved by a layout switch.
        let legacy_json = r#"{
            "id": "old",
            "position": [5.0, 5.0],
            "author": "alice"
        }"#;
        let legacy: crate::scene::Annotation = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(
            legacy.anchor, None,
            "missing anchor key deserializes as None"
        );

        let (mut doc, ds) = plate_with_two_layouts();
        doc.add_annotation(ds.clone(), legacy);
        switch_to(&mut doc, &ds, "moved");
        assert_eq!(pin(&doc, &ds, "old").position, [5.0, 5.0]);
    }

    #[test]
    fn anchor_survives_document_state_serde_round_trip() {
        // Critical: after serialize -> deserialize, the anchor is preserved and a
        // SetActiveLayout still re-anchors correctly on the restored document.
        use lucida_content::EntityId;
        let (mut doc, ds) = plate_with_two_layouts();
        doc.apply(add_annotation_cmd("plate", "p", [5.0, 5.0], "alice"));

        let blob = serde_json::to_string(&doc).unwrap();
        let mut restored: crate::scene::DocumentState = serde_json::from_str(&blob).unwrap();
        assert_eq!(
            pin(&restored, &ds, "p").anchor,
            Some(EntityId("w1".into())),
            "anchor persists through the document blob"
        );

        switch_to(&mut restored, &ds, "moved");
        assert_eq!(
            pin(&restored, &ds, "p").position,
            [5.0, 55.0],
            "re-anchor still works after a round-trip"
        );
    }

    #[test]
    fn switch_between_three_positions_tracks_well_each_time() {
        // Robustness beyond the two-layout contract: a third layout moves w1 to a
        // different delta; the pin tracks w1 across default -> moved -> far ->
        // default, each hop applying the displacement between just those two.
        use lucida_content::{EntityId, LayoutId, LayoutSpec, layout::EntityPlacement};
        let (mut doc, ds) = plate_with_two_layouts();
        doc.apply(DocumentCommand::RegisterLayout {
            dataset_id: ds.clone(),
            layout: LayoutSpec {
                id: LayoutId("far".into()),
                name: "Far".into(),
                placements: vec![
                    EntityPlacement {
                        entity_id: EntityId("w1".into()),
                        position: [-30.0, 10.0],
                    },
                    EntityPlacement {
                        entity_id: EntityId("w2".into()),
                        position: [100.0, 0.0],
                    },
                ],
            },
        });
        doc.apply(add_annotation_cmd("plate", "p", [5.0, 5.0], "alice"));

        switch_to(&mut doc, &ds, "moved"); // w1 [0,0]->[0,50], delta [0,50]
        assert_eq!(pin(&doc, &ds, "p").position, [5.0, 55.0]);
        switch_to(&mut doc, &ds, "far"); // w1 [0,50]->[-30,10], delta [-30,-40]
        assert_eq!(pin(&doc, &ds, "p").position, [-25.0, 15.0]);
        switch_to(&mut doc, &ds, "default"); // w1 [-30,10]->[0,0], delta [30,-10]
        assert_eq!(pin(&doc, &ds, "p").position, [5.0, 5.0]);
    }

    #[test]
    fn switching_to_the_already_active_layout_does_not_shift_pins() {
        // Convergence/idempotency: a replayed or echoed `set_active_layout` to the
        // layout that's already active must not translate pins a second time. The
        // pin should sit where the first switch left it, not double-shifted.
        let (mut doc, ds) = plate_with_two_layouts();
        doc.apply(add_annotation_cmd("plate", "p", [5.0, 5.0], "alice"));
        switch_to(&mut doc, &ds, "moved");
        assert_eq!(pin(&doc, &ds, "p").position, [5.0, 55.0]);
        // Re-apply the SAME switch (as a duplicate/echo would): no further move.
        switch_to(&mut doc, &ds, "moved");
        assert_eq!(pin(&doc, &ds, "p").position, [5.0, 55.0]);
    }

    #[test]
    fn reanchor_leaves_z_unchanged() {
        // Layouts are 2-D in-plane: the pin's depth must not be touched by a
        // re-anchor, only its in-plane position.
        let (mut doc, ds) = plate_with_two_layouts();
        doc.apply(add_annotation_cmd_z("plate", "p", [5.0, 5.0], 7.5, "alice"));
        switch_to(&mut doc, &ds, "moved");
        let p = pin(&doc, &ds, "p");
        assert_eq!(p.position, [5.0, 55.0]);
        assert_eq!(p.z, 7.5, "z is in-plane-invariant across a layout switch");
    }

    #[test]
    fn reanchor_runs_identically_through_scene_apply() {
        // The re-anchor lives in DocumentState::apply, so it also fires when the
        // command flows through the wasm Scene::apply wrapper (which delegates to
        // document.apply) — same corrected position the server would persist.
        use lucida_content::{EntityId, LayoutId, LayoutSpec, layout::EntityPlacement};
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_plate_dataset_opened(
            "plate",
            "plate",
            vec![("w1", [0.0, 0.0]), ("w2", [100.0, 0.0])],
            [1, 1, 1, 64, 64],
            [1, 1, 1, 64, 64],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds = DatasetId("plate".into());
        scene.apply(
            DocumentCommand::RegisterLayout {
                dataset_id: ds.clone(),
                layout: LayoutSpec {
                    id: LayoutId("moved".into()),
                    name: "Moved".into(),
                    placements: vec![
                        EntityPlacement {
                            entity_id: EntityId("w1".into()),
                            position: [0.0, 50.0],
                        },
                        EntityPlacement {
                            entity_id: EntityId("w2".into()),
                            position: [100.0, 0.0],
                        },
                    ],
                },
            }
            .into(),
        );
        scene.apply(add_annotation_cmd("plate", "p", [5.0, 5.0], "alice").into());
        assert_eq!(
            scene.document.annotations[&ds][0].anchor,
            Some(EntityId("w1".into()))
        );
        scene.apply(
            DocumentCommand::SetActiveLayout {
                dataset_id: ds.clone(),
                layout_id: LayoutId("moved".into()),
            }
            .into(),
        );
        assert_eq!(scene.document.annotations[&ds][0].position, [5.0, 55.0]);
    }

    fn add_annotation_cmd(ds: &str, id: &str, position: [f64; 2], author: &str) -> DocumentCommand {
        add_annotation_cmd_z(ds, id, position, 0.0, author)
    }

    fn add_annotation_cmd_z(
        ds: &str,
        id: &str,
        position: [f64; 2],
        z: f64,
        author: &str,
    ) -> DocumentCommand {
        DocumentCommand::AddAnnotation {
            dataset_id: DatasetId(ds.into()),
            id: id.into(),
            position,
            end: None,
            z,
            t: 0,
            c: 0,
            author: author.into(),
            kind: crate::scene::AnnotationKind::Point,
        }
    }

    /// Build an `add_annotation` for a non-point kind carrying a second vertex.
    fn add_shape_cmd(
        ds: &str,
        id: &str,
        position: [f64; 2],
        end: [f64; 2],
        kind: crate::scene::AnnotationKind,
    ) -> DocumentCommand {
        DocumentCommand::AddAnnotation {
            dataset_id: DatasetId(ds.into()),
            id: id.into(),
            position,
            end: Some(end),
            z: 0.0,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind,
        }
    }

    #[test]
    fn document_state_add_annotation_carries_z_into_stored_pin() {
        // The depth from the command must land on the stored pin's `z`.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd_z(
            "wds-1",
            "p1",
            [1.0, 2.0],
            7.5,
            "alice",
        ));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].position, [1.0, 2.0]);
        assert_eq!(pins[0].z, 7.5);
    }

    #[test]
    fn document_state_add_annotation_default_z_is_zero() {
        // A pin dropped without depth (the slice-1/2 path) stores z = 0.0.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        assert_eq!(doc.annotations[&DatasetId("wds-1".into())][0].z, 0.0);
    }

    #[test]
    fn document_state_add_annotation_z_last_write_wins() {
        // Re-applying the same pin id with a new depth replaces z in place.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd_z(
            "wds-1",
            "p1",
            [1.0, 2.0],
            3.0,
            "alice",
        ));
        doc.apply(add_annotation_cmd_z(
            "wds-1",
            "p1",
            [1.0, 2.0],
            9.0,
            "alice",
        ));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].z, 9.0);
    }

    #[test]
    fn annotation_z_round_trips_with_full_float_precision() {
        // The durability/broadcast path is serde of DocumentState. A non-round
        // depth must survive byte-for-byte (no f32 narrowing, no truncation).
        let depth = std::f64::consts::PI * 1_000.0; // 3141.592653589793...
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd_z(
            "wds-1",
            "p1",
            [1.5, 2.5],
            depth,
            "alice",
        ));
        let blob = serde_json::to_string(&doc).unwrap();
        let restored: crate::scene::DocumentState = serde_json::from_str(&blob).unwrap();
        let pins = &restored.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins[0].z, depth);
        assert_eq!(pins[0].z.to_bits(), depth.to_bits());
    }

    #[test]
    fn annotation_negative_and_fractional_z_round_trip() {
        // Depth is a signed world coordinate, not an index; negatives are valid.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd_z(
            "wds-1",
            "p1",
            [0.0, 0.0],
            -42.25,
            "alice",
        ));
        let blob = serde_json::to_string(&doc).unwrap();
        let restored: crate::scene::DocumentState = serde_json::from_str(&blob).unwrap();
        assert_eq!(
            restored.annotations[&DatasetId("wds-1".into())][0].z,
            -42.25
        );
    }

    #[test]
    fn slice12_persisted_pin_without_z_loads_as_zero() {
        // A pin blob written by slice 1/2 has no `z` key. #[serde(default)] on
        // Annotation::z must load it as 0.0 (and the comment thread still works).
        let json = r#"{"manifests":{},"annotations":{"wds-1":[
            {"id":"p1","position":[10.0,20.0],"author":"alice","kind":"point",
             "comments":[{"id":"c1","author":"bob","text":"hi"}]}
        ]}}"#;
        let doc: crate::scene::DocumentState = serde_json::from_str(json).unwrap();
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].position, [10.0, 20.0]);
        assert_eq!(pins[0].z, 0.0);
        assert_eq!(pins[0].comments.len(), 1);
        assert_eq!(pins[0].comments[0].text, "hi");
    }

    #[test]
    fn document_state_add_annotation_inserts_keyed_by_dataset() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].id, "p1");
        assert_eq!(pins[0].position, [1.0, 2.0]);
        assert_eq!(pins[0].author, "alice");
    }

    #[test]
    fn document_state_two_pins_same_dataset_are_independent() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        doc.apply(add_annotation_cmd("wds-1", "p2", [9.0, 9.0], "alice"));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 2);
        assert_eq!(pins[0].id, "p1");
        assert_eq!(pins[1].id, "p2");
    }

    #[test]
    fn document_state_add_annotation_dedups_by_id_last_write_wins() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        // Re-apply the same id with a new position (e.g. a replayed/duplicated
        // command): must replace in place, not append.
        doc.apply(add_annotation_cmd("wds-1", "p1", [5.0, 6.0], "alice"));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].position, [5.0, 6.0]);
    }

    #[test]
    fn document_state_remove_annotation_by_id() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        doc.apply(add_annotation_cmd("wds-1", "p2", [3.0, 4.0], "alice"));
        doc.apply(DocumentCommand::RemoveAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "p1".into(),
        });
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].id, "p2");
    }

    #[test]
    fn document_state_remove_last_annotation_drops_dataset_entry() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        doc.apply(DocumentCommand::RemoveAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "p1".into(),
        });
        assert!(!doc.annotations.contains_key(&DatasetId("wds-1".into())));
    }

    #[test]
    fn document_state_remove_unknown_annotation_is_noop() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        // Unknown id and unknown dataset must both be harmless no-ops.
        doc.apply(DocumentCommand::RemoveAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "does-not-exist".into(),
        });
        doc.apply(DocumentCommand::RemoveAnnotation {
            dataset_id: DatasetId("wds-other".into()),
            id: "p1".into(),
        });
        assert_eq!(doc.annotations[&DatasetId("wds-1".into())].len(), 1);
    }

    #[test]
    fn annotations_are_scoped_per_dataset() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        doc.apply(add_annotation_cmd("wds-2", "p2", [3.0, 4.0], "bob"));
        assert_eq!(doc.annotations[&DatasetId("wds-1".into())].len(), 1);
        assert_eq!(doc.annotations[&DatasetId("wds-2".into())].len(), 1);
        // Removing from one dataset leaves the other untouched.
        doc.apply(DocumentCommand::RemoveAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "p1".into(),
        });
        assert!(!doc.annotations.contains_key(&DatasetId("wds-1".into())));
        assert_eq!(doc.annotations[&DatasetId("wds-2".into())].len(), 1);
    }

    #[test]
    fn remove_dataset_drops_its_annotations() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(add_annotation_cmd("ds1", "p1", [1.0, 2.0], "alice").into());
        assert_eq!(
            scene.document.annotations[&DatasetId("ds1".into())].len(),
            1
        );

        scene.apply(
            DocumentCommand::RemoveDataset {
                id: DatasetId("ds1".into()),
            }
            .into(),
        );
        assert!(
            !scene
                .document
                .annotations
                .contains_key(&DatasetId("ds1".into()))
        );
    }

    #[test]
    fn add_and_remove_annotation_bump_only_annotation_epoch() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let baseline = scene.epochs.clone();
        assert_eq!(baseline.annotation, 0);

        scene.apply(add_annotation_cmd("ds1", "p1", [1.0, 2.0], "alice").into());
        assert_eq!(scene.epochs.annotation, 1);
        // Adding a pin is not a content/layout/view/selection/asset change.
        assert_eq!(scene.epochs.content, baseline.content);
        assert_eq!(scene.epochs.layout, baseline.layout);
        assert_eq!(scene.epochs.view, baseline.view);
        assert_eq!(scene.epochs.selection, baseline.selection);
        assert_eq!(scene.epochs.asset, baseline.asset);

        scene.apply(
            DocumentCommand::RemoveAnnotation {
                dataset_id: DatasetId("ds1".into()),
                id: "p1".into(),
            }
            .into(),
        );
        assert_eq!(scene.epochs.annotation, 2);
    }

    #[test]
    fn snapshot_document_annotations_shape_matches_wire_contract() {
        // The snapshot ships `DocumentState` whole under `document`, so its
        // serialized shape IS `snapshot.document.annotations`. Assert the
        // documented nested shape:
        // { "<dataset_id>": [ {id,position,z,author,kind,comments} ] }.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd_z(
            "wds-1",
            "p1",
            [10.0, 20.0],
            6.0,
            "alice",
        ));
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&doc).unwrap()).unwrap();
        let arr = &v["annotations"]["wds-1"];
        assert!(arr.is_array());
        assert_eq!(arr[0]["id"], "p1");
        assert_eq!(arr[0]["position"][0], 10.0);
        assert_eq!(arr[0]["position"][1], 20.0);
        assert_eq!(arr[0]["z"], 6.0);
        assert_eq!(arr[0]["author"], "alice");
        assert_eq!(arr[0]["kind"], "point");
    }

    #[test]
    fn document_state_without_annotations_field_deserializes() {
        // Older persisted snapshots predate the field; #[serde(default)]
        // must let them load with an empty annotations map.
        let json = r#"{"manifests":{}}"#;
        let doc: crate::scene::DocumentState = serde_json::from_str(json).unwrap();
        assert!(doc.annotations.is_empty());
    }

    #[test]
    fn annotation_survives_document_serde_round_trip() {
        // Stand-in for the durability path: DocumentState is what gets
        // blob-serialized to document_json and restored on workspace reload.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.5, 2.5], "alice"));
        let blob = serde_json::to_string(&doc).unwrap();
        let restored: crate::scene::DocumentState = serde_json::from_str(&blob).unwrap();
        let pins = &restored.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].id, "p1");
        assert_eq!(pins[0].position, [1.5, 2.5]);
        assert_eq!(pins[0].author, "alice");
    }

    // --- Move-annotation (reposition) tests ---
    //
    // The reposition mutation lives on `Annotation::set_position` and is
    // unit-testable on a bare pin with no DocumentState scaffolding. The
    // DocumentState arm only locates the pin (via the same find-by-id used by
    // add/remove) and delegates.

    /// A whole-shape move (no `end`) — the rigid #776 translate path. The
    /// existing move tests all exercise this shape.
    fn move_annotation_cmd(ds: &str, id: &str, position: [f64; 2], z: f64) -> DocumentCommand {
        DocumentCommand::MoveAnnotation {
            dataset_id: DatasetId(ds.into()),
            id: id.into(),
            position,
            end: None,
            z,
        }
    }

    /// A reshape move (`end: Some`) — the resize path: the two opposite corners
    /// are placed explicitly, no rigid translate.
    fn reshape_annotation_cmd(
        ds: &str,
        id: &str,
        position: [f64; 2],
        end: [f64; 2],
        z: f64,
    ) -> DocumentCommand {
        DocumentCommand::MoveAnnotation {
            dataset_id: DatasetId(ds.into()),
            id: id.into(),
            position,
            end: Some(end),
            z,
        }
    }

    #[test]
    fn move_annotation_command_matches_wire_contract() {
        // Field-for-field check against the slice's documented move wire shape.
        let cmd = move_annotation_cmd("wds-abc", "pin-1", [12.5, -7.25], 3.5);
        let json = serde_json::to_string(&cmd).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "move_annotation");
        assert_eq!(v["dataset_id"], "wds-abc");
        assert_eq!(v["id"], "pin-1");
        assert_eq!(v["position"][0], 12.5);
        assert_eq!(v["position"][1], -7.25);
        assert_eq!(v["z"], 3.5);
        // Move carries only dataset_id + id + position + z (no author/kind).
        assert!(v.get("author").is_none());
        assert!(v.get("kind").is_none());
        // A whole-shape move serializes `end` as null (the field defaults to
        // None; serde emits the key as null for an Option).
        assert!(v["end"].is_null());

        // And it parses back from exactly that shape.
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::MoveAnnotation {
                dataset_id,
                id,
                position,
                end,
                z,
            } => {
                assert_eq!(dataset_id, DatasetId("wds-abc".into()));
                assert_eq!(id, "pin-1");
                assert_eq!(position, [12.5, -7.25]);
                assert_eq!(end, None);
                assert_eq!(z, 3.5);
            }
            _ => panic!("expected MoveAnnotation"),
        }
    }

    #[test]
    fn move_annotation_parses_from_documented_client_payload() {
        // Verbatim client->server payload from the slice wire contract.
        let json = r#"{"type":"move_annotation","dataset_id":"wds-1","id":"pin-1","position":[3.0,4.0],"z":5.0}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::MoveAnnotation {
                dataset_id,
                id,
                position,
                end,
                z,
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(id, "pin-1");
                assert_eq!(position, [3.0, 4.0]);
                // A slice-#776 client payload carries no `end` → None.
                assert_eq!(end, None);
                assert_eq!(z, 5.0);
            }
            _ => panic!("expected MoveAnnotation"),
        }
    }

    #[test]
    fn move_annotation_z_defaults_to_zero_when_absent() {
        // A depth-unaware client (or a replayed older log entry) sends no `z`.
        // #[serde(default)] must parse it as z = 0.0 rather than failing —
        // mirroring AddAnnotation's wire backward-compatibility guarantee.
        let json =
            r#"{"type":"move_annotation","dataset_id":"wds-1","id":"pin-1","position":[3.0,4.0]}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::MoveAnnotation { position, z, .. } => {
                assert_eq!(position, [3.0, 4.0]);
                assert_eq!(z, 0.0);
            }
            _ => panic!("expected MoveAnnotation"),
        }
    }

    #[test]
    fn move_annotation_broadcast_is_byte_identical_to_inbound_command() {
        // A peer sees the pin's new position (and z) because the inbound command
        // and its rebroadcast carry the same command object byte-for-byte.
        use crate::protocol::{ClientMessage, ServerMessage};
        let cmd = move_annotation_cmd("wds-1", "pin-1", [3.0, 4.0], 8.5);
        let inbound = ClientMessage::Command {
            command: cmd.clone(),
        };
        let broadcast = ServerMessage::CommandBroadcast {
            seq: 11,
            command: cmd,
        };
        let inbound_v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&inbound).unwrap()).unwrap();
        let broadcast_v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&broadcast).unwrap()).unwrap();
        assert_eq!(inbound_v["command"], broadcast_v["command"]);
        assert_eq!(broadcast_v["command"]["position"][0], 3.0);
        assert_eq!(broadcast_v["command"]["z"], 8.5);
        assert_eq!(broadcast_v["seq"], 11);
    }

    // --- Annotation-level reposition helper (no DocumentState) ---

    #[test]
    fn annotation_set_position_overwrites_position_and_z() {
        let mut pin = point_pin("pin-1");
        pin.set_position([5.0, 6.0], 7.5);
        assert_eq!(pin.position, [5.0, 6.0]);
        assert_eq!(pin.z, 7.5);
    }

    #[test]
    fn annotation_set_position_preserves_other_fields_including_thread() {
        let mut pin = point_pin("pin-1");
        pin.author = "biologist".into();
        pin.add_comment(comment("c1", "alice", "look here"));
        pin.set_position([9.0, 9.0], 1.0);
        // Position/z change; id, author, kind, and the thread are untouched.
        assert_eq!(pin.position, [9.0, 9.0]);
        assert_eq!(pin.z, 1.0);
        assert_eq!(pin.id, "pin-1");
        assert_eq!(pin.author, "biologist");
        assert_eq!(pin.kind, crate::scene::AnnotationKind::Point);
        assert_eq!(pin.comments.len(), 1);
        assert_eq!(pin.comments[0].id, "c1");
        assert_eq!(pin.comments[0].text, "look here");
    }

    #[test]
    fn annotation_set_position_keeps_point_end_none() {
        // A point has no second vertex: moving it must never invent an `end`.
        let mut pin = point_pin("pin-1");
        pin.set_position([5.0, 6.0], 2.0);
        assert_eq!(pin.position, [5.0, 6.0]);
        assert_eq!(pin.z, 2.0);
        assert_eq!(pin.end, None, "moving a point must not synthesize an end");
    }

    #[test]
    fn annotation_set_position_translates_line_end_by_the_anchor_delta() {
        // Anchor (1,1) -> (11,11) is a +10,+10 delta; the far endpoint must ride
        // along by the same delta so the line moves as a whole — same length and
        // angle, not a stretch/rotate about the far end.
        let mut line = shape_pin(
            "ln",
            [1.0, 1.0],
            Some([3.0, 3.0]),
            crate::scene::AnnotationKind::Line,
        );
        line.set_position([11.0, 11.0], 0.0);
        assert_eq!(line.position, [11.0, 11.0]);
        assert_eq!(line.end, Some([13.0, 13.0]));
    }

    #[test]
    fn annotation_set_position_translates_box_opposite_corner_by_the_delta() {
        // Both corners shift by the same delta, so the box keeps its size/shape
        // (only its location changes). Anchor (1,1) -> (4,5) is a +3,+4 delta;
        // the opposite corner (5,5) -> (8,9).
        let mut r#box = shape_pin(
            "bx",
            [1.0, 1.0],
            Some([5.0, 5.0]),
            crate::scene::AnnotationKind::Box,
        );
        r#box.set_position([4.0, 5.0], 0.0);
        assert_eq!(r#box.position, [4.0, 5.0]);
        assert_eq!(r#box.end, Some([8.0, 9.0]));
    }

    #[test]
    fn annotation_set_position_preserves_line_length_and_angle() {
        // Stronger than the point-check: the vector from anchor to far endpoint
        // is identical before and after an arbitrary (non-diagonal, negative)
        // move, which is exactly "length + angle preserved".
        let mut line = shape_pin(
            "ln",
            [2.0, 9.0],
            Some([6.0, 1.0]),
            crate::scene::AnnotationKind::Line,
        );
        let before = [
            line.end.unwrap()[0] - line.position[0],
            line.end.unwrap()[1] - line.position[1],
        ];
        line.set_position([-3.5, 4.0], 7.0);
        let after = [
            line.end.unwrap()[0] - line.position[0],
            line.end.unwrap()[1] - line.position[1],
        ];
        assert_eq!(before, after, "anchor->end vector must be invariant");
        assert_eq!(line.position, [-3.5, 4.0]);
        assert_eq!(line.z, 7.0);
    }

    #[test]
    fn annotation_set_position_zero_delta_leaves_shape_unchanged() {
        // Moving a line to its current anchor (a zero delta — e.g. a replayed
        // command) must be a no-op on the far endpoint, not a drift.
        let mut line = shape_pin(
            "ln",
            [4.0, 4.0],
            Some([10.0, 2.0]),
            crate::scene::AnnotationKind::Line,
        );
        line.set_position([4.0, 4.0], 0.0);
        assert_eq!(line.position, [4.0, 4.0]);
        assert_eq!(line.end, Some([10.0, 2.0]));
    }

    // --- DocumentState delegation ---

    #[test]
    fn document_state_move_annotation_overwrites_position_and_z() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd_z(
            "wds-1",
            "p1",
            [1.0, 2.0],
            3.0,
            "alice",
        ));
        doc.apply(move_annotation_cmd("wds-1", "p1", [10.0, 20.0], 30.0));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1, "move must not create extra pins");
        assert_eq!(pins[0].position, [10.0, 20.0]);
        assert_eq!(pins[0].z, 30.0);
    }

    #[test]
    fn document_state_move_annotation_preserves_author_kind_and_thread() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "p1", "c1", "bob", "keep me"));
        doc.apply(move_annotation_cmd("wds-1", "p1", [5.0, 6.0], 0.0));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.position, [5.0, 6.0]);
        assert_eq!(pin.author, "alice");
        assert_eq!(pin.kind, crate::scene::AnnotationKind::Point);
        assert_eq!(pin.comments.len(), 1, "thread must survive a move");
        assert_eq!(pin.comments[0].id, "c1");
        assert_eq!(pin.comments[0].text, "keep me");
    }

    #[test]
    fn document_state_move_only_targets_the_matching_pin() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        doc.apply(add_annotation_cmd("wds-1", "p2", [3.0, 4.0], "alice"));
        doc.apply(move_annotation_cmd("wds-1", "p2", [99.0, 99.0], 0.0));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        // p1 untouched, only p2 moved; order preserved.
        assert_eq!(pins[0].id, "p1");
        assert_eq!(pins[0].position, [1.0, 2.0]);
        assert_eq!(pins[1].id, "p2");
        assert_eq!(pins[1].position, [99.0, 99.0]);
    }

    #[test]
    fn document_state_move_missing_pin_is_noop_no_phantom() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        // Wrong pin id, wrong dataset id: both must be clean no-ops that do NOT
        // create a phantom pin or dataset entry.
        doc.apply(move_annotation_cmd("wds-1", "p-missing", [7.0, 7.0], 7.0));
        doc.apply(move_annotation_cmd("wds-missing", "p1", [7.0, 7.0], 7.0));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        // The real pin is unchanged.
        assert_eq!(pins[0].position, [1.0, 2.0]);
        assert_eq!(pins[0].z, 0.0);
        assert!(
            !doc.annotations
                .contains_key(&DatasetId("wds-missing".into()))
        );
    }

    #[test]
    fn document_state_move_into_empty_document_is_noop() {
        // No pins at all: a move must not conjure a dataset entry or a pin.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(move_annotation_cmd("wds-1", "p1", [1.0, 2.0], 3.0));
        assert!(doc.annotations.is_empty());
    }

    #[test]
    fn document_state_move_annotation_is_idempotent() {
        // Re-applying the same move (a replayed/twice-delivered command) lands
        // on the same state — peers stay convergent.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        doc.apply(move_annotation_cmd("wds-1", "p1", [8.0, 9.0], 4.0));
        doc.apply(move_annotation_cmd("wds-1", "p1", [8.0, 9.0], 4.0));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].position, [8.0, 9.0]);
        assert_eq!(pins[0].z, 4.0);
    }

    #[test]
    fn moved_position_survives_document_serde_round_trip() {
        // Durability/persistence path: the moved position + z persist via the
        // document_json blob and restore for a post-restart reconnect.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd_z(
            "wds-1",
            "p1",
            [1.0, 2.0],
            3.0,
            "alice",
        ));
        doc.apply(move_annotation_cmd("wds-1", "p1", [42.5, -8.25], 16.0));
        let blob = serde_json::to_string(&doc).unwrap();
        let restored: crate::scene::DocumentState = serde_json::from_str(&blob).unwrap();
        let pin = &restored.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.position, [42.5, -8.25]);
        assert_eq!(pin.z, 16.0);
    }

    #[test]
    fn document_state_move_line_translates_whole_shape() {
        // Full apply path (the wire path peers use): adding a line then moving
        // its anchor 1,1 -> 11,11 must carry the far endpoint 3,3 -> 13,13.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "ln",
            [1.0, 1.0],
            [3.0, 3.0],
            crate::scene::AnnotationKind::Line,
        ));
        doc.apply(move_annotation_cmd("wds-1", "ln", [11.0, 11.0], 0.0));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.position, [11.0, 11.0]);
        assert_eq!(pin.end, Some([13.0, 13.0]));
        assert_eq!(pin.kind, crate::scene::AnnotationKind::Line);
    }

    #[test]
    fn document_state_move_box_translates_opposite_corner() {
        // A box shares the same reposition owner, so it too moves as a whole:
        // anchor 0,0 -> 2,3 carries the opposite corner 4,4 -> 6,7.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "bx",
            [0.0, 0.0],
            [4.0, 4.0],
            crate::scene::AnnotationKind::Box,
        ));
        doc.apply(move_annotation_cmd("wds-1", "bx", [2.0, 3.0], 0.0));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.position, [2.0, 3.0]);
        assert_eq!(pin.end, Some([6.0, 7.0]));
        assert_eq!(pin.kind, crate::scene::AnnotationKind::Box);
    }

    #[test]
    fn moved_line_whole_shape_survives_document_serde_round_trip() {
        // Persistence of a whole-line move: both the moved anchor AND the
        // rigidly-carried far endpoint must restore after a (simulated) restart.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "ln",
            [1.0, 1.0],
            [3.0, 3.0],
            crate::scene::AnnotationKind::Line,
        ));
        doc.apply(move_annotation_cmd("wds-1", "ln", [11.0, 11.0], 0.0));
        let blob = serde_json::to_string(&doc).unwrap();
        let restored: crate::scene::DocumentState = serde_json::from_str(&blob).unwrap();
        let pin = &restored.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.position, [11.0, 11.0]);
        assert_eq!(pin.end, Some([13.0, 13.0]));
        assert_eq!(pin.kind, crate::scene::AnnotationKind::Line);
    }

    #[test]
    fn document_state_move_point_keeps_end_null() {
        // Regression guard on the wire path: moving a point never invents an
        // `end` (it stays null), so a point still moves as a plain point.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "p1", [1.0, 2.0], "alice"));
        doc.apply(move_annotation_cmd("wds-1", "p1", [7.0, 8.0], 0.0));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.position, [7.0, 8.0]);
        assert_eq!(pin.end, None);
        assert_eq!(pin.kind, crate::scene::AnnotationKind::Point);
    }

    // --- Reshape: MoveAnnotation with `end: Some` (the resize path) ----------
    // A whole-shape move (`end: None`) rigidly translates both vertices (#776,
    // covered above). A reshape (`end: Some`) sets the two opposite corners
    // EXACTLY — that is how a corner/edge resize lands. These pin both shapes.

    #[test]
    fn annotation_set_vertices_places_both_corners_exactly() {
        // The reshape owner on a bare pin: position AND end are set verbatim,
        // with NO delta math — the box takes the passed geometry as-is.
        let mut r#box = shape_pin(
            "bx",
            [0.0, 0.0],
            Some([4.0, 4.0]),
            crate::scene::AnnotationKind::Box,
        );
        r#box.set_vertices([1.0, 1.0], [9.0, 7.0], 2.5);
        assert_eq!(r#box.position, [1.0, 1.0]);
        assert_eq!(r#box.end, Some([9.0, 7.0]));
        assert_eq!(r#box.z, 2.5);
    }

    #[test]
    fn annotation_set_vertices_is_not_a_rigid_translate() {
        // The crux of the slice: contrast with set_position. Moving the anchor
        // 0,0 -> 1,1 via a RESHAPE that holds the opposite corner at 4,4 must
        // leave end at 4,4 (the box shrinks). A rigid translate would have
        // dragged end to 5,5 instead. This is what makes a corner resize work.
        let mut r#box = shape_pin(
            "bx",
            [0.0, 0.0],
            Some([4.0, 4.0]),
            crate::scene::AnnotationKind::Box,
        );
        r#box.set_vertices([1.0, 1.0], [4.0, 4.0], 0.0);
        assert_eq!(r#box.position, [1.0, 1.0]);
        assert_eq!(
            r#box.end,
            Some([4.0, 4.0]),
            "reshape holds the opposite corner; it does not ride the anchor delta"
        );
    }

    #[test]
    fn annotation_set_vertices_preserves_other_fields_including_thread() {
        // A reshape edits the existing pin: id, author, kind, and the comment
        // thread all survive — exactly like set_position.
        let mut r#box = shape_pin(
            "bx",
            [0.0, 0.0],
            Some([4.0, 4.0]),
            crate::scene::AnnotationKind::Box,
        );
        r#box.author = "biologist".into();
        r#box.add_comment(comment("c1", "alice", "this region"));
        r#box.set_vertices([2.0, 2.0], [6.0, 5.0], 1.0);
        assert_eq!(r#box.id, "bx");
        assert_eq!(r#box.author, "biologist");
        assert_eq!(r#box.kind, crate::scene::AnnotationKind::Box);
        assert_eq!(r#box.comments.len(), 1);
        assert_eq!(r#box.comments[0].text, "this region");
    }

    #[test]
    fn annotation_set_vertices_on_point_keeps_end_none() {
        // A point has no second vertex; a reshape of one repositions its anchor
        // but must NOT invent an `end` (that would silently make it a line/box).
        let mut pin = point_pin("p1");
        pin.set_vertices([3.0, 4.0], [9.0, 9.0], 5.0);
        assert_eq!(pin.position, [3.0, 4.0]);
        assert_eq!(pin.z, 5.0);
        assert_eq!(pin.end, None, "reshape must not mint a vertex on a point");
        assert_eq!(pin.kind, crate::scene::AnnotationKind::Point);
    }

    #[test]
    fn document_state_move_with_end_reshapes_the_box() {
        // The full apply path with `end: Some`: a box's two opposite corners are
        // placed independently (a resize), not rigidly translated.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "bx",
            [0.0, 0.0],
            [4.0, 4.0],
            crate::scene::AnnotationKind::Box,
        ));
        // Drag the SE (opposite) corner out to 7,9: anchor held, end -> 7,9.
        doc.apply(reshape_annotation_cmd(
            "wds-1",
            "bx",
            [0.0, 0.0],
            [7.0, 9.0],
            0.0,
        ));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.position, [0.0, 0.0], "se drag leaves the anchor put");
        assert_eq!(
            pin.end,
            Some([7.0, 9.0]),
            "se drag moves the opposite corner"
        );
        assert_eq!(pin.kind, crate::scene::AnnotationKind::Box);
    }

    #[test]
    fn document_state_move_with_end_can_move_the_anchor_corner() {
        // The NW handle reshapes from the other side: the anchor (position)
        // moves while the opposite corner is held — both placed explicitly.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "bx",
            [0.0, 0.0],
            [4.0, 4.0],
            crate::scene::AnnotationKind::Box,
        ));
        doc.apply(reshape_annotation_cmd(
            "wds-1",
            "bx",
            [-2.0, -1.0],
            [4.0, 4.0],
            0.0,
        ));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(
            pin.position,
            [-2.0, -1.0],
            "nw drag moves the anchor corner"
        );
        assert_eq!(
            pin.end,
            Some([4.0, 4.0]),
            "nw drag holds the opposite corner"
        );
    }

    #[test]
    fn document_state_move_without_end_still_rigid_translates() {
        // The #776 guarantee, asserted side-by-side with the reshape test: the
        // SAME anchor move, but with NO `end`, carries the opposite corner along
        // (a whole-shape slide), proving the two shapes are distinct paths.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "bx",
            [0.0, 0.0],
            [4.0, 4.0],
            crate::scene::AnnotationKind::Box,
        ));
        doc.apply(move_annotation_cmd("wds-1", "bx", [2.0, 3.0], 0.0));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.position, [2.0, 3.0]);
        assert_eq!(
            pin.end,
            Some([6.0, 7.0]),
            "no `end` → the opposite corner rides the +2,+3 anchor delta (rigid)"
        );
    }

    #[test]
    fn document_state_reshape_is_idempotent() {
        // Re-applying the same reshape (a replayed/twice-delivered command)
        // lands on the same geometry — peers stay convergent.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "bx",
            [0.0, 0.0],
            [4.0, 4.0],
            crate::scene::AnnotationKind::Box,
        ));
        doc.apply(reshape_annotation_cmd(
            "wds-1",
            "bx",
            [1.0, 1.0],
            [8.0, 6.0],
            2.0,
        ));
        doc.apply(reshape_annotation_cmd(
            "wds-1",
            "bx",
            [1.0, 1.0],
            [8.0, 6.0],
            2.0,
        ));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].position, [1.0, 1.0]);
        assert_eq!(pins[0].end, Some([8.0, 6.0]));
        assert_eq!(pins[0].z, 2.0);
    }

    #[test]
    fn document_state_reshape_missing_pin_is_noop_no_phantom() {
        // A reshape for an unknown pin/dataset is a clean no-op — it must never
        // mint a phantom pin (same rule as a whole-shape move).
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "bx",
            [0.0, 0.0],
            [4.0, 4.0],
            crate::scene::AnnotationKind::Box,
        ));
        doc.apply(reshape_annotation_cmd(
            "wds-1",
            "ghost",
            [1.0, 1.0],
            [2.0, 2.0],
            0.0,
        ));
        doc.apply(reshape_annotation_cmd(
            "wds-missing",
            "bx",
            [1.0, 1.0],
            [2.0, 2.0],
            0.0,
        ));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(
            pins[0].position,
            [0.0, 0.0],
            "real box untouched by a stray reshape"
        );
        assert_eq!(pins[0].end, Some([4.0, 4.0]));
        assert!(
            !doc.annotations
                .contains_key(&DatasetId("wds-missing".into()))
        );
    }

    #[test]
    fn reshaped_box_survives_document_serde_round_trip() {
        // Persistence: the reshaped corners persist via the document_json blob
        // and restore after a (simulated) restart.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_shape_cmd(
            "wds-1",
            "bx",
            [0.0, 0.0],
            [4.0, 4.0],
            crate::scene::AnnotationKind::Box,
        ));
        doc.apply(reshape_annotation_cmd(
            "wds-1",
            "bx",
            [-1.5, 2.0],
            [10.25, 6.5],
            3.0,
        ));
        let blob = serde_json::to_string(&doc).unwrap();
        let restored: crate::scene::DocumentState = serde_json::from_str(&blob).unwrap();
        let pin = &restored.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.position, [-1.5, 2.0]);
        assert_eq!(pin.end, Some([10.25, 6.5]));
        assert_eq!(pin.z, 3.0);
    }

    #[test]
    fn reshape_move_command_round_trips_with_end() {
        // The reshape wire shape: `end` rides as a 2-element array and parses
        // back into Some. (The no-`end` shape is covered above as null/None.)
        let cmd = reshape_annotation_cmd("wds-1", "bx", [1.0, 2.0], [7.0, 9.0], 4.0);
        let json = serde_json::to_string(&cmd).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "move_annotation");
        assert_eq!(v["position"][0], 1.0);
        assert_eq!(v["end"][0], 7.0);
        assert_eq!(v["end"][1], 9.0);
        assert_eq!(v["z"], 4.0);

        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::MoveAnnotation {
                position, end, z, ..
            } => {
                assert_eq!(position, [1.0, 2.0]);
                assert_eq!(end, Some([7.0, 9.0]));
                assert_eq!(z, 4.0);
            }
            _ => panic!("expected MoveAnnotation"),
        }
    }

    #[test]
    fn reshape_move_parses_from_documented_client_payload() {
        // A verbatim resize payload the frontend emits: position + end + z.
        let json = r#"{"type":"move_annotation","dataset_id":"wds-1","id":"bx","position":[1.0,2.0],"end":[7.0,9.0],"z":4.0}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::MoveAnnotation {
                position, end, z, ..
            } => {
                assert_eq!(position, [1.0, 2.0]);
                assert_eq!(end, Some([7.0, 9.0]));
                assert_eq!(z, 4.0);
            }
            _ => panic!("expected MoveAnnotation"),
        }
    }

    #[test]
    fn move_annotation_bumps_only_annotation_epoch() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(add_annotation_cmd("ds1", "p1", [1.0, 2.0], "alice").into());
        let baseline = scene.epochs.clone();

        scene.apply(move_annotation_cmd("ds1", "p1", [5.0, 6.0], 0.0).into());
        assert_eq!(scene.epochs.annotation, baseline.annotation + 1);
        assert_eq!(scene.epochs.content, baseline.content);
        assert_eq!(scene.epochs.layout, baseline.layout);
        assert_eq!(scene.epochs.view, baseline.view);
        assert_eq!(scene.epochs.selection, baseline.selection);
        assert_eq!(scene.epochs.asset, baseline.asset);
    }

    #[test]
    fn move_missing_pin_still_bumps_epoch_but_creates_nothing() {
        // The annotation epoch is the message-arrival counter (mirrors the
        // add/remove_comment semantics): it bumps per applied command even when
        // the state-level effect is a no-op. The no-op must not mint a pin.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let before = scene.epochs.annotation;
        scene.apply(move_annotation_cmd("ds1", "ghost", [1.0, 2.0], 3.0).into());
        assert_eq!(scene.epochs.annotation, before + 1);
        assert!(
            !scene
                .document
                .annotations
                .contains_key(&DatasetId("ds1".into()))
        );
    }

    // --- Comment thread tests ---
    //
    // Comments nest on the annotation, so the dedup + insertion-order
    // invariants live on `Annotation` (`add_comment`/`remove_comment`) and are
    // unit-testable on a bare pin with no DocumentState scaffolding. The
    // DocumentState arms below only locate the pin and delegate.

    fn add_comment_cmd(ds: &str, ann: &str, id: &str, author: &str, text: &str) -> DocumentCommand {
        DocumentCommand::AddComment {
            dataset_id: DatasetId(ds.into()),
            annotation_id: ann.into(),
            id: id.into(),
            author: author.into(),
            text: text.into(),
        }
    }

    fn remove_comment_cmd(ds: &str, ann: &str, id: &str) -> DocumentCommand {
        DocumentCommand::RemoveComment {
            dataset_id: DatasetId(ds.into()),
            annotation_id: ann.into(),
            id: id.into(),
        }
    }

    fn point_pin(id: &str) -> crate::scene::Annotation {
        crate::scene::Annotation {
            id: id.into(),
            position: [0.0, 0.0],
            end: None,
            z: 0.0,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
            comments: Vec::new(),
            anchor: None,
        }
    }

    /// Bare line/box pin (no DocumentState) for geometry-helper tests.
    fn shape_pin(
        id: &str,
        position: [f64; 2],
        end: Option<[f64; 2]>,
        kind: crate::scene::AnnotationKind,
    ) -> crate::scene::Annotation {
        crate::scene::Annotation {
            id: id.into(),
            position,
            end,
            z: 0.0,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind,
            comments: Vec::new(),
            anchor: None,
        }
    }

    #[test]
    fn vertices_point_is_single_anchor() {
        let pin = point_pin("p");
        assert_eq!(pin.vertices(), vec![[0.0, 0.0]]);
        assert!(!pin.is_closed());
    }

    #[test]
    fn vertices_line_is_two_endpoints_in_order() {
        let line = shape_pin(
            "ln",
            [1.0, 2.0],
            Some([5.0, 6.0]),
            crate::scene::AnnotationKind::Line,
        );
        assert_eq!(line.vertices(), vec![[1.0, 2.0], [5.0, 6.0]]);
        // A line is an open run, not a closed ring.
        assert!(!line.is_closed());
    }

    #[test]
    fn vertices_box_is_four_corner_ring() {
        // Opposite corners (0,0) and (10,4) expand to the full axis-aligned
        // rectangle, wound so consecutive corners share an edge — the shared
        // draw path strokes them and closes back to the first.
        let r#box = shape_pin(
            "bx",
            [0.0, 0.0],
            Some([10.0, 4.0]),
            crate::scene::AnnotationKind::Box,
        );
        assert_eq!(
            r#box.vertices(),
            vec![[0.0, 0.0], [10.0, 0.0], [10.0, 4.0], [0.0, 4.0]]
        );
        assert!(r#box.is_closed());
    }

    #[test]
    fn vertices_line_or_box_without_end_collapses_to_anchor() {
        // A malformed/partially-applied line/box (no `end`) must not panic or
        // vanish: the geometry helper degrades to the single anchor point.
        let line = shape_pin("ln", [3.0, 7.0], None, crate::scene::AnnotationKind::Line);
        assert_eq!(line.vertices(), vec![[3.0, 7.0]]);
        assert!(!line.is_closed());
        let r#box = shape_pin("bx", [3.0, 7.0], None, crate::scene::AnnotationKind::Box);
        assert_eq!(r#box.vertices(), vec![[3.0, 7.0]]);
        assert!(!r#box.is_closed());
    }

    fn comment(id: &str, author: &str, text: &str) -> crate::scene::Comment {
        crate::scene::Comment {
            id: id.into(),
            author: author.into(),
            text: text.into(),
        }
    }

    #[test]
    fn add_comment_command_matches_wire_contract() {
        // Field-for-field check against the slice's documented add wire shape.
        let cmd = add_comment_cmd("wds-abc", "pin-1", "c-1", "biologist", "nice finding");
        let json = serde_json::to_string(&cmd).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "add_comment");
        assert_eq!(v["dataset_id"], "wds-abc");
        assert_eq!(v["annotation_id"], "pin-1");
        assert_eq!(v["id"], "c-1");
        assert_eq!(v["author"], "biologist");
        assert_eq!(v["text"], "nice finding");

        // And it parses back from exactly that shape.
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::AddComment {
                dataset_id,
                annotation_id,
                id,
                author,
                text,
            } => {
                assert_eq!(dataset_id, DatasetId("wds-abc".into()));
                assert_eq!(annotation_id, "pin-1");
                assert_eq!(id, "c-1");
                assert_eq!(author, "biologist");
                assert_eq!(text, "nice finding");
            }
            _ => panic!("expected AddComment"),
        }
    }

    #[test]
    fn add_comment_parses_from_documented_client_payload() {
        // Verbatim client->server payload from the slice wire contract.
        let json = r#"{"type":"add_comment","dataset_id":"wds-1","annotation_id":"pin-1","id":"c-1","author":"alice","text":"hello"}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::AddComment {
                dataset_id,
                annotation_id,
                id,
                author,
                text,
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(annotation_id, "pin-1");
                assert_eq!(id, "c-1");
                assert_eq!(author, "alice");
                assert_eq!(text, "hello");
            }
            _ => panic!("expected AddComment"),
        }
    }

    #[test]
    fn remove_comment_command_matches_wire_contract() {
        let json =
            r#"{"type":"remove_comment","dataset_id":"wds-1","annotation_id":"pin-1","id":"c-1"}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::RemoveComment {
                dataset_id,
                annotation_id,
                id,
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(annotation_id, "pin-1");
                assert_eq!(id, "c-1");
            }
            _ => panic!("expected RemoveComment"),
        }

        // Remove carries only dataset_id + annotation_id + id (no author/text).
        let cmd = remove_comment_cmd("wds-1", "pin-1", "c-1");
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&cmd).unwrap()).unwrap();
        assert!(v.get("author").is_none());
        assert!(v.get("text").is_none());
    }

    #[test]
    fn add_comment_broadcast_is_byte_identical_to_inbound_command() {
        // Client-supplied comment id means the inbound command and its
        // rebroadcast carry the same command object byte-for-byte.
        use crate::protocol::{ClientMessage, ServerMessage};
        let cmd = add_comment_cmd("wds-1", "pin-1", "c-1", "alice", "hi");
        let inbound = ClientMessage::Command {
            command: cmd.clone(),
        };
        let broadcast = ServerMessage::CommandBroadcast {
            seq: 9,
            command: cmd,
        };
        let inbound_v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&inbound).unwrap()).unwrap();
        let broadcast_v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&broadcast).unwrap()).unwrap();
        assert_eq!(inbound_v["command"], broadcast_v["command"]);
        assert_eq!(broadcast_v["seq"], 9);
    }

    // --- Annotation-level helpers (no DocumentState) ---

    #[test]
    fn annotation_add_comment_appends_in_insertion_order() {
        let mut pin = point_pin("pin-1");
        pin.add_comment(comment("c1", "alice", "first"));
        pin.add_comment(comment("c2", "bob", "second"));
        pin.add_comment(comment("c3", "alice", "third"));
        let ids: Vec<&str> = pin.comments.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["c1", "c2", "c3"]);
    }

    #[test]
    fn annotation_add_comment_dedups_by_id_last_write_wins() {
        let mut pin = point_pin("pin-1");
        pin.add_comment(comment("c1", "alice", "draft"));
        pin.add_comment(comment("c2", "bob", "keep"));
        // Re-apply c1 with new text: replace in place, do not append, and do
        // not disturb the order of the other comments.
        pin.add_comment(comment("c1", "alice", "final"));
        assert_eq!(pin.comments.len(), 2);
        assert_eq!(pin.comments[0].id, "c1");
        assert_eq!(pin.comments[0].text, "final");
        assert_eq!(pin.comments[1].id, "c2");
    }

    #[test]
    fn annotation_remove_comment_reports_and_preserves_order() {
        let mut pin = point_pin("pin-1");
        pin.add_comment(comment("c1", "alice", "a"));
        pin.add_comment(comment("c2", "bob", "b"));
        pin.add_comment(comment("c3", "alice", "c"));
        assert!(pin.remove_comment("c2"));
        let ids: Vec<&str> = pin.comments.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["c1", "c3"]);
        // Removing an unknown id is a no-op and reports false.
        assert!(!pin.remove_comment("c2"));
        assert_eq!(pin.comments.len(), 2);
    }

    // --- DocumentState delegation ---

    #[test]
    fn document_state_add_comment_nests_on_the_pin_in_order() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "first"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c2", "bob", "second"));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1, "must not create extra pins");
        assert_eq!(pins[0].comments.len(), 2);
        assert_eq!(pins[0].comments[0].id, "c1");
        assert_eq!(pins[0].comments[0].text, "first");
        assert_eq!(pins[0].comments[1].id, "c2");
        assert_eq!(pins[0].comments[1].author, "bob");
    }

    #[test]
    fn document_state_add_comment_dedups_by_id_last_write_wins() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "v1"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "v2"));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.comments.len(), 1);
        assert_eq!(pin.comments[0].text, "v2");
    }

    #[test]
    fn document_state_remove_comment_by_id() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "a"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c2", "bob", "b"));
        doc.apply(remove_comment_cmd("wds-1", "pin-1", "c1"));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.comments.len(), 1);
        assert_eq!(pin.comments[0].id, "c2");
    }

    #[test]
    fn document_state_add_comment_to_missing_pin_is_noop_no_phantom() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        // Wrong pin id, wrong dataset id: both must be clean no-ops that do
        // NOT create a phantom pin or dataset entry.
        doc.apply(add_comment_cmd("wds-1", "pin-missing", "c1", "alice", "x"));
        doc.apply(add_comment_cmd("wds-missing", "pin-1", "c1", "alice", "x"));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert!(pins[0].comments.is_empty());
        assert!(
            !doc.annotations
                .contains_key(&DatasetId("wds-missing".into()))
        );
    }

    #[test]
    fn document_state_remove_missing_comment_is_noop() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "a"));
        // Unknown comment id, unknown pin, unknown dataset: all harmless.
        doc.apply(remove_comment_cmd("wds-1", "pin-1", "nope"));
        doc.apply(remove_comment_cmd("wds-1", "pin-missing", "c1"));
        doc.apply(remove_comment_cmd("wds-missing", "pin-1", "c1"));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.comments.len(), 1);
        assert_eq!(pin.comments[0].id, "c1");
    }

    #[test]
    fn cross_peer_comments_on_same_pin_are_ordered_for_a_late_joiner() {
        // Two peers each comment on the same pin; the thread that a late joiner
        // would load (the serialized DocumentState) carries both in the order
        // the server sequenced them.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd(
            "wds-1", "pin-1", "c-alice", "alice", "from A",
        ));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c-bob", "bob", "from B"));
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&doc).unwrap()).unwrap();
        let thread = &v["annotations"]["wds-1"][0]["comments"];
        assert_eq!(thread[0]["id"], "c-alice");
        assert_eq!(thread[0]["author"], "alice");
        assert_eq!(thread[1]["id"], "c-bob");
        assert_eq!(thread[1]["author"], "bob");
    }

    #[test]
    fn removing_pin_cascades_its_comments() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "a"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c2", "bob", "b"));
        doc.apply(DocumentCommand::RemoveAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
        });
        // The pin (and therefore its whole thread) is gone — no orphans.
        assert!(!doc.annotations.contains_key(&DatasetId("wds-1".into())));
    }

    #[test]
    fn removing_dataset_cascades_pins_and_their_comments() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(add_annotation_cmd("ds1", "pin-1", [1.0, 2.0], "alice").into());
        scene.apply(add_comment_cmd("ds1", "pin-1", "c1", "alice", "a").into());
        scene.apply(
            DocumentCommand::RemoveDataset {
                id: DatasetId("ds1".into()),
            }
            .into(),
        );
        assert!(
            !scene
                .document
                .annotations
                .contains_key(&DatasetId("ds1".into()))
        );
    }

    #[test]
    fn re_applied_add_annotation_preserves_existing_thread() {
        // A rebroadcast/replayed add_annotation for an existing pin id must not
        // wipe a discussion that has accrued on that pin.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "a"));
        // Re-deliver the pin (same id, new position).
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [9.0, 9.0], "alice"));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.position, [9.0, 9.0]);
        assert_eq!(pin.comments.len(), 1, "thread must survive pin re-apply");
        assert_eq!(pin.comments[0].id, "c1");
    }

    #[test]
    fn add_and_remove_comment_bump_only_annotation_epoch() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(add_annotation_cmd("ds1", "pin-1", [1.0, 2.0], "alice").into());
        let baseline = scene.epochs.clone();

        scene.apply(add_comment_cmd("ds1", "pin-1", "c1", "alice", "a").into());
        assert_eq!(scene.epochs.annotation, baseline.annotation + 1);
        assert_eq!(scene.epochs.content, baseline.content);
        assert_eq!(scene.epochs.layout, baseline.layout);
        assert_eq!(scene.epochs.view, baseline.view);
        assert_eq!(scene.epochs.selection, baseline.selection);
        assert_eq!(scene.epochs.asset, baseline.asset);

        scene.apply(remove_comment_cmd("ds1", "pin-1", "c1").into());
        assert_eq!(scene.epochs.annotation, baseline.annotation + 2);
    }

    #[test]
    fn add_comment_to_missing_pin_still_bumps_epoch_but_creates_nothing() {
        // The epoch is the message-arrival counter (mirrors asset-delta
        // semantics): it bumps per applied command even when the state-level
        // effect is a no-op. The no-op must not create a phantom pin.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let before = scene.epochs.annotation;
        scene.apply(add_comment_cmd("ds1", "ghost", "c1", "alice", "a").into());
        assert_eq!(scene.epochs.annotation, before + 1);
        assert!(
            !scene
                .document
                .annotations
                .contains_key(&DatasetId("ds1".into()))
        );
    }

    #[test]
    fn comment_thread_survives_document_serde_round_trip() {
        // Durability path: the thread persists via the document_json blob.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.5, 2.5], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "first"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c2", "bob", "second"));
        let blob = serde_json::to_string(&doc).unwrap();
        let restored: crate::scene::DocumentState = serde_json::from_str(&blob).unwrap();
        let pin = &restored.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.comments.len(), 2);
        assert_eq!(pin.comments[0].id, "c1");
        assert_eq!(pin.comments[0].text, "first");
        assert_eq!(pin.comments[1].id, "c2");
        assert_eq!(pin.comments[1].author, "bob");
    }

    #[test]
    fn slice1_pin_without_comments_field_deserializes_with_empty_thread() {
        // A pin persisted by slice 1 (before threads existed) has no `comments`
        // field; #[serde(default)] must load it with an empty thread.
        let json = r#"{"manifests":{},"annotations":{"wds-1":[{"id":"pin-1","position":[1.0,2.0],"author":"alice","kind":"point"}]}}"#;
        let doc: crate::scene::DocumentState = serde_json::from_str(json).unwrap();
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert!(pin.comments.is_empty());
    }

    #[test]
    fn pin_with_empty_thread_serializes_like_a_slice1_pin() {
        // A comment-less pin must still expose the documented snapshot shape;
        // `comments` serializes as an empty array (harmless for old clients).
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [10.0, 20.0], "alice"));
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&doc).unwrap()).unwrap();
        let pin = &v["annotations"]["wds-1"][0];
        assert_eq!(pin["id"], "pin-1");
        assert_eq!(pin["kind"], "point");
        assert!(pin["comments"].is_array());
        assert_eq!(pin["comments"].as_array().unwrap().len(), 0);
    }

    // --- Edit-comment tests ---
    //
    // The text-overwrite mutation lives on `Annotation::edit_comment`, sibling
    // to add/remove_comment, and is unit-testable on a bare pin. The
    // DocumentState arm only locates the pin (via the shared find-by-id) and
    // delegates.

    fn edit_comment_cmd(ds: &str, ann: &str, id: &str, text: &str) -> DocumentCommand {
        DocumentCommand::EditComment {
            dataset_id: DatasetId(ds.into()),
            annotation_id: ann.into(),
            id: id.into(),
            text: text.into(),
        }
    }

    #[test]
    fn edit_comment_command_matches_wire_contract() {
        // Field-for-field check against the slice's documented edit wire shape.
        let cmd = edit_comment_cmd("wds-abc", "pin-1", "c-1", "fixed typo");
        let json = serde_json::to_string(&cmd).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "edit_comment");
        assert_eq!(v["dataset_id"], "wds-abc");
        assert_eq!(v["annotation_id"], "pin-1");
        assert_eq!(v["id"], "c-1");
        assert_eq!(v["text"], "fixed typo");
        // Edit carries no author (author is preserved on the existing comment).
        assert!(v.get("author").is_none());

        // And it parses back from exactly that shape.
        let parsed: DocumentCommand = serde_json::from_str(&json).unwrap();
        match parsed {
            DocumentCommand::EditComment {
                dataset_id,
                annotation_id,
                id,
                text,
            } => {
                assert_eq!(dataset_id, DatasetId("wds-abc".into()));
                assert_eq!(annotation_id, "pin-1");
                assert_eq!(id, "c-1");
                assert_eq!(text, "fixed typo");
            }
            _ => panic!("expected EditComment"),
        }
    }

    #[test]
    fn edit_comment_parses_from_documented_client_payload() {
        // Verbatim client->server payload from the slice wire contract.
        let json = r#"{"type":"edit_comment","dataset_id":"wds-1","annotation_id":"pin-1","id":"c-1","text":"edited"}"#;
        let parsed: DocumentCommand = serde_json::from_str(json).unwrap();
        match parsed {
            DocumentCommand::EditComment {
                dataset_id,
                annotation_id,
                id,
                text,
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(annotation_id, "pin-1");
                assert_eq!(id, "c-1");
                assert_eq!(text, "edited");
            }
            _ => panic!("expected EditComment"),
        }
    }

    #[test]
    fn edit_comment_broadcast_is_byte_identical_to_inbound_command() {
        // A peer sees the new text because the inbound command and its
        // rebroadcast carry the same command object byte-for-byte.
        use crate::protocol::{ClientMessage, ServerMessage};
        let cmd = edit_comment_cmd("wds-1", "pin-1", "c-1", "new text");
        let inbound = ClientMessage::Command {
            command: cmd.clone(),
        };
        let broadcast = ServerMessage::CommandBroadcast {
            seq: 13,
            command: cmd,
        };
        let inbound_v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&inbound).unwrap()).unwrap();
        let broadcast_v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&broadcast).unwrap()).unwrap();
        assert_eq!(inbound_v["command"], broadcast_v["command"]);
        assert_eq!(broadcast_v["command"]["text"], "new text");
        assert_eq!(broadcast_v["seq"], 13);
    }

    // --- Annotation-level edit helper (no DocumentState) ---

    #[test]
    fn annotation_edit_comment_overwrites_text_in_place() {
        let mut pin = point_pin("pin-1");
        pin.add_comment(comment("c1", "alice", "first"));
        pin.add_comment(comment("c2", "bob", "second"));
        // Edit c1: replace its text, keep id/author and its place in the thread.
        assert!(pin.edit_comment("c1", "edited".into()));
        assert_eq!(pin.comments.len(), 2);
        assert_eq!(pin.comments[0].id, "c1");
        assert_eq!(pin.comments[0].author, "alice");
        assert_eq!(pin.comments[0].text, "edited");
        assert_eq!(pin.comments[1].id, "c2");
        assert_eq!(pin.comments[1].text, "second");
    }

    #[test]
    fn annotation_edit_missing_comment_is_noop_and_reports_false() {
        let mut pin = point_pin("pin-1");
        pin.add_comment(comment("c1", "alice", "only"));
        // Unknown comment id: no edit, no append, reports false.
        assert!(!pin.edit_comment("c-missing", "ignored".into()));
        assert_eq!(pin.comments.len(), 1);
        assert_eq!(pin.comments[0].id, "c1");
        assert_eq!(pin.comments[0].text, "only");
    }

    #[test]
    fn annotation_edit_comment_on_empty_thread_is_noop() {
        let mut pin = point_pin("pin-1");
        assert!(!pin.edit_comment("c1", "x".into()));
        assert!(pin.comments.is_empty());
    }

    // --- DocumentState delegation ---

    #[test]
    fn document_state_edit_comment_overwrites_text() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "draft"));
        doc.apply(edit_comment_cmd("wds-1", "pin-1", "c1", "final"));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.comments.len(), 1, "edit must not append a comment");
        assert_eq!(pin.comments[0].id, "c1");
        assert_eq!(pin.comments[0].author, "alice");
        assert_eq!(pin.comments[0].text, "final");
    }

    #[test]
    fn document_state_edit_comment_only_targets_the_matching_comment() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "a"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c2", "bob", "b"));
        doc.apply(edit_comment_cmd("wds-1", "pin-1", "c2", "b-edited"));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.comments[0].id, "c1");
        assert_eq!(pin.comments[0].text, "a");
        assert_eq!(pin.comments[1].id, "c2");
        assert_eq!(pin.comments[1].text, "b-edited");
    }

    #[test]
    fn document_state_edit_missing_comment_is_noop_no_phantom() {
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "keep"));
        // Unknown comment id, unknown pin, unknown dataset: all clean no-ops that
        // create no phantom comment, pin, or dataset entry.
        doc.apply(edit_comment_cmd("wds-1", "pin-1", "c-missing", "x"));
        doc.apply(edit_comment_cmd("wds-1", "pin-missing", "c1", "x"));
        doc.apply(edit_comment_cmd("wds-missing", "pin-1", "c1", "x"));
        let pins = &doc.annotations[&DatasetId("wds-1".into())];
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].comments.len(), 1);
        assert_eq!(pins[0].comments[0].text, "keep");
        assert!(
            !doc.annotations
                .contains_key(&DatasetId("wds-missing".into()))
        );
    }

    #[test]
    fn document_state_edit_comment_is_idempotent() {
        // Re-applying the same edit (a replayed/twice-delivered command) lands on
        // the same text — peers stay convergent.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "v1"));
        doc.apply(edit_comment_cmd("wds-1", "pin-1", "c1", "v2"));
        doc.apply(edit_comment_cmd("wds-1", "pin-1", "c1", "v2"));
        let pin = &doc.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.comments.len(), 1);
        assert_eq!(pin.comments[0].text, "v2");
    }

    #[test]
    fn edited_comment_text_survives_document_serde_round_trip() {
        // Durability/persistence path: the edited text persists via the
        // document_json blob and restores for a late joiner / post-restart peer.
        let mut doc = crate::scene::DocumentState::default();
        doc.apply(add_annotation_cmd("wds-1", "pin-1", [1.0, 2.0], "alice"));
        doc.apply(add_comment_cmd("wds-1", "pin-1", "c1", "alice", "before"));
        doc.apply(edit_comment_cmd("wds-1", "pin-1", "c1", "after"));
        let blob = serde_json::to_string(&doc).unwrap();
        let restored: crate::scene::DocumentState = serde_json::from_str(&blob).unwrap();
        let pin = &restored.annotations[&DatasetId("wds-1".into())][0];
        assert_eq!(pin.comments.len(), 1);
        assert_eq!(pin.comments[0].id, "c1");
        assert_eq!(pin.comments[0].author, "alice");
        assert_eq!(pin.comments[0].text, "after");
    }

    #[test]
    fn edit_comment_bumps_only_annotation_epoch() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(add_annotation_cmd("ds1", "pin-1", [1.0, 2.0], "alice").into());
        scene.apply(add_comment_cmd("ds1", "pin-1", "c1", "alice", "a").into());
        let baseline = scene.epochs.clone();

        scene.apply(edit_comment_cmd("ds1", "pin-1", "c1", "a-edited").into());
        assert_eq!(scene.epochs.annotation, baseline.annotation + 1);
        assert_eq!(scene.epochs.content, baseline.content);
        assert_eq!(scene.epochs.layout, baseline.layout);
        assert_eq!(scene.epochs.view, baseline.view);
        assert_eq!(scene.epochs.selection, baseline.selection);
        assert_eq!(scene.epochs.asset, baseline.asset);
    }

    #[test]
    fn edit_missing_comment_still_bumps_epoch_but_creates_nothing() {
        // The annotation epoch is the message-arrival counter: it bumps per
        // applied command even when the state-level effect is a no-op. The no-op
        // must not mint a comment or a pin.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.apply(add_annotation_cmd("ds1", "pin-1", [1.0, 2.0], "alice").into());
        let before = scene.epochs.annotation;
        scene.apply(edit_comment_cmd("ds1", "pin-1", "ghost-comment", "x").into());
        assert_eq!(scene.epochs.annotation, before + 1);
        let pin = &scene.document.annotations[&DatasetId("ds1".into())][0];
        assert!(pin.comments.is_empty());
    }

    #[test]
    fn unknown_layout_id_is_no_op_for_derived() {
        use lucida_content::LayoutId;
        let mut scene = Scene::new([800, 600]);

        // Register a plate dataset with a known default layout
        let reg = test_helpers::make_plate_dataset_opened(
            "plate",
            "plate",
            vec![("m1", [0.0, 0.0]), ("m2", [256.0, 0.0])],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 256, 256],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let ds_id = DatasetId("plate".into());
        let positions_before: Vec<[f64; 2]> = scene.derived[&ds_id]
            .members
            .iter()
            .map(|m| m.position)
            .collect();

        // Set an unknown layout ID
        scene.apply(
            DocumentCommand::SetActiveLayout {
                dataset_id: ds_id.clone(),
                layout_id: LayoutId("nonexistent".into()),
            }
            .into(),
        );

        // active_layout_ids should be updated
        assert_eq!(
            scene.document.active_layout_ids[&ds_id],
            LayoutId("nonexistent".into()),
        );
        // But derived state should use fallback (default layout), positions unchanged
        let positions_after: Vec<[f64; 2]> = scene.derived[&ds_id]
            .members
            .iter()
            .map(|m| m.position)
            .collect();
        assert_eq!(positions_before, positions_after);
    }
}
