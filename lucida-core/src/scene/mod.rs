mod types;

pub use types::{
    Annotation, AnnotationKind, BlendMode, ChannelSettings, Colormap, Comment,
    DatasetDisplaySettings, DisplayState, DocumentState, MemberChunkPlan, RenderMode,
};

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use lucida_content::*;

use crate::camera::Camera;
use crate::chunk::{self, ChunkRequestPlan};
use crate::epoch::SceneEpochs;
use crate::query::{EntityQueryResult, ViewQueryResult};
use crate::transform::{self, VolumeTransform};
use crate::view::ViewState;

/// Per-dataset derived state for fast hot-path lookups.
/// Rebuilt on register/remove. Not serialized.
#[derive(Debug, Clone)]
pub struct DatasetDerivedState {
    pub volume_transforms: HashMap<ImageId, VolumeTransform>,
    pub active_layout: LayoutSpec,
    pub members: Vec<MemberState>,
}

/// Precomputed per image-bearing entity.
#[derive(Debug, Clone)]
pub struct MemberState {
    pub entity_id: EntityId,
    pub image_id: ImageId,
    pub position: [f64; 2],
    pub volume_transform: VolumeTransform,
    pub levels: Vec<LevelGeometry>,
    pub data_type: DataType,
}

/// Aggregate XY extent for visible image content in scene coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VisibleContentBounds2D {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
    pub max_depth: u32,
}

impl VisibleContentBounds2D {
    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    pub fn height(&self) -> f64 {
        self.max_y - self.min_y
    }

    pub fn center_x(&self) -> f64 {
        (self.min_x + self.max_x) / 2.0
    }

    pub fn center_y(&self) -> f64 {
        (self.min_y + self.max_y) / 2.0
    }
}

/// The complete viewer state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub camera: Camera,
    pub view: ViewState,
    /// Shared document state (dataset manifests).
    #[serde(flatten)]
    pub document: DocumentState,
    /// Display settings (contrast window + gamma). Per-client, not part of shared document.
    #[serde(default)]
    pub display: DisplayState,
    #[serde(default)]
    pub dataset_order: Vec<DatasetId>,
    #[serde(default)]
    pub dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    /// Derived state for fast hot-path lookups. Rebuilt on register/remove.
    #[serde(skip)]
    pub derived: HashMap<DatasetId, DatasetDerivedState>,
    /// Monotonic epoch counters for change detection.
    #[serde(default)]
    pub epochs: SceneEpochs,
}

impl Scene {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            camera: Camera::new_2d(viewport),
            view: ViewState::new(),
            document: DocumentState::default(),
            display: DisplayState::default(),
            dataset_order: Vec::new(),
            dataset_settings: HashMap::new(),
            derived: HashMap::new(),
            epochs: SceneEpochs::default(),
        }
    }

    /// Get the volume transform for the first dataset's first image.
    pub fn volume_transform(&self) -> Option<&VolumeTransform> {
        self.derived
            .values()
            .next()
            .and_then(|d| d.members.first())
            .map(|m| &m.volume_transform)
    }

    /// Get the volume shape [Z, Y, X] for the first dataset's first image.
    pub fn volume_shape(&self) -> Option<[u32; 3]> {
        self.derived
            .values()
            .next()
            .and_then(|d| d.members.first())
            .and_then(|m| m.levels.first())
            .map(|l| [l.shape[2] as u32, l.shape[3] as u32, l.shape[4] as u32])
    }

    /// Switch to 2D mode, preserving the current viewport.
    pub fn set_mode_2d(&mut self) {
        if !matches!(self.camera, Camera::Slice(_)) {
            let vp = self.camera.viewport();
            self.camera = Camera::new_2d(vp);
        }
    }

    /// Switch to 3D arcball mode, preserving the current viewport.
    /// If currently in fly mode, converts to arcball preserving eye position and view direction.
    pub fn set_mode_3d(&mut self) {
        if !matches!(self.camera, Camera::Arcball(_)) {
            match &self.camera {
                Camera::Fly(v) => {
                    self.camera = Camera::Arcball(v.to_arcball());
                }
                _ => {
                    let vp = self.camera.viewport();
                    self.camera = Camera::new_3d(vp);
                }
            }
        }
    }

    /// Switch to fly mode, converting from arcball if possible.
    pub fn set_mode_fly(&mut self) {
        if !matches!(self.camera, Camera::Fly(_)) {
            match &self.camera {
                Camera::Arcball(v) => {
                    self.camera = Camera::Fly(v.to_fly());
                }
                _ => {
                    let vp = self.camera.viewport();
                    self.camera = Camera::Fly(crate::camera::Fly::new(vp));
                }
            }
        }
    }

    /// Set viewport on camera (avoids name clash with ViewportCommand::SetViewport).
    pub(crate) fn inner_set_viewport(&mut self, width: u32, height: u32) {
        self.camera.set_viewport(width, height);
    }

    pub fn remove_dataset(&mut self, id: &DatasetId) {
        self.document.remove_dataset(id);
        self.dataset_order.retain(|s| s != id);
        self.dataset_settings.remove(id);
        self.derived.remove(id);
    }

    /// Returns the maximum `max_physical_extent` across all datasets.
    /// Used to apply a global normalization correction so multi-dataset
    /// scenes preserve relative physical sizes in 3D.
    pub fn global_max_physical_extent(&self) -> f64 {
        let max = self
            .derived
            .values()
            .flat_map(|d| d.members.iter())
            .map(|m| {
                let e = m.volume_transform.max_physical_extent;
                if e > 0.0 { e } else { 1.0 }
            })
            .fold(0.0_f64, f64::max);
        if max > 0.0 { max } else { 1.0 }
    }

    /// Returns the maximum physical Y extent across all datasets.
    /// Used to top-align datasets in 3D mode.
    pub fn global_max_physical_y(&self) -> f64 {
        let max = self
            .derived
            .values()
            .flat_map(|d| d.members.iter())
            .map(|m| {
                let t = &m.volume_transform;
                let ds_max = if t.max_physical_extent > 0.0 {
                    t.max_physical_extent
                } else {
                    1.0
                };
                t.model[5] as f64 * ds_max
            })
            .fold(0.0_f64, f64::max);
        if max > 0.0 { max } else { 1.0 }
    }

    /// The per-member **world placement matrix** (`[f32; 16]`, column-major):
    /// the scale-and-translate that maps the member's unit cube `[0,1]³` into the
    /// scene's normalized world space, including the member position, the 3D Y-flip,
    /// the multi-dataset global normalization (`global_max_physical_extent`), and
    /// the 3D top-alignment (`global_max_physical_y`).
    ///
    /// This is a **thin wrapper** over the single source of member world
    /// placement, [`Self::rendering_transform`]: it returns that transform's
    /// forward `model`. The wasm renderer's `member_model_matrix`, the minimap's
    /// framing, and [`Self::dataset_world_bounds`] all route through here, so the
    /// auto-fit can never drift from what is actually drawn. A member with no
    /// levels yields the identity matrix (matching the renderer's fallback), so
    /// callers can fold it in without a special case.
    pub fn member_world_matrix(&self, member: &MemberState) -> [f32; 16] {
        self.rendering_transform(member).0.model
    }

    /// World-space axis-aligned bounds (`(min, max)`) of **a single dataset's**
    /// members — never the union across datasets — so the caller can frame the
    /// newly-opened dataset alone.
    ///
    /// Each member's unit-cube corners are transformed by the renderer's own
    /// forward transform ([`Self::rendering_transform`], the exact matrix the
    /// renderer/minimap use) and folded into a [`framing::Aabb`]. Returns `None`
    /// for an unknown id or a dataset whose members contribute no box (none with
    /// levels) — that is the "nothing to frame" signal
    /// [`Self::fit_camera_to_dataset`] checks.
    pub fn dataset_world_bounds(&self, dataset_id: &str) -> Option<([f64; 3], [f64; 3])> {
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = self.derived.get(&ds_id)?;

        let mut aabb = crate::framing::Aabb::empty();
        for member in &derived.members {
            if member.levels.is_empty() {
                continue;
            }
            for corner in self.rendering_transform(member).0.world_corners() {
                aabb.add_point(corner);
            }
        }

        if aabb.is_empty() {
            None
        } else {
            Some((aabb.min, aabb.max))
        }
    }

    /// Axis-aligned bounds (`(min, max)`) of **a single dataset's** members in
    /// the **2D Slice (voxel) space** — the coordinate system the [`Camera::Slice`]
    /// camera actually operates in (member XY position + the level-0 XY voxel
    /// extent), *not* the normalized unit-cube space [`Self::dataset_world_bounds`]
    /// uses for the 3D arcball/minimap.
    ///
    /// This is the 2D twin of [`Self::dataset_world_bounds`]: each member with a
    /// level 0 contributes the AABB
    /// `[position[0], position[1]] .. [position[0] + X, position[1] + Y]` where
    /// `X = level0.shape[4]` and `Y = level0.shape[3]` (shape is `[t,c,z,y,x]`),
    /// using the *exact* voxel convention the slice-mode ray pick and chunk
    /// culling use (see [`Self::ray_pick`]). The result is the min/max over all
    /// such members. Members with no levels are skipped (they have no voxel
    /// extent), matching the renderer's "nothing to draw" handling.
    ///
    /// Returns `None` for an unknown id or a dataset whose members contribute no
    /// box (none with levels) — the "nothing to frame" signal
    /// [`Self::fit_camera_to_dataset`] checks in 2D.
    pub fn dataset_voxel_bounds_2d(&self, dataset_id: &str) -> Option<([f64; 2], [f64; 2])> {
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = self.derived.get(&ds_id)?;

        let mut min = [f64::MAX; 2];
        let mut max = [f64::MIN; 2];
        let mut any = false;
        for member in &derived.members {
            let Some(level0) = member.levels.first() else {
                continue;
            };
            let x0 = member.position[0];
            let y0 = member.position[1];
            let x1 = x0 + level0.shape[4] as f64; // X extent
            let y1 = y0 + level0.shape[3] as f64; // Y extent
            min[0] = min[0].min(x0);
            min[1] = min[1].min(y0);
            max[0] = max[0].max(x1);
            max[1] = max[1].max(y1);
            any = true;
        }

        if any { Some((min, max)) } else { None }
    }

    /// Frame the named dataset's full extent in the current camera, **dispatching
    /// on the camera mode** so each mode is fed bounds in the coordinate space it
    /// actually uses:
    ///
    /// - In 2D [`Camera::Slice`] mode the Slice camera works in **voxel** space,
    ///   so it is framed with [`Self::dataset_voxel_bounds_2d`] (member XY +
    ///   level-0 XY voxel extent) via [`Slice::fit_to_bounds`] with
    ///   [`crate::framing::FIT_MARGIN_2D`]. Feeding it the normalized unit-cube
    ///   bounds instead would center on ~`[0.5, 0.5]` and zoom onto a sub-pixel
    ///   speck at the origin while the data sits at voxel `[0..width]`.
    /// - In 3D ([`Camera::Arcball`]/[`Camera::Fly`]) modes the camera works in the
    ///   **normalized** world space, so it keeps using
    ///   [`Self::dataset_world_bounds`] via [`Camera::fit_to_bounds`] — the 3D
    ///   path is unchanged.
    ///
    /// Returns `true` if it framed something, `false` if the dataset has no bounds
    /// in the active space (unknown id / no members) — in which case the camera is
    /// left untouched. The borrow is resolved by computing the bounds *before*
    /// mutating the camera.
    pub fn fit_camera_to_dataset(&mut self, dataset_id: &str) -> bool {
        if let Camera::Slice(_) = self.camera {
            // 2D: the Slice camera lives in voxel space — frame the voxel AABB.
            let Some((min, max)) = self.dataset_voxel_bounds_2d(dataset_id) else {
                return false;
            };
            if let Camera::Slice(s) = &mut self.camera {
                s.fit_to_bounds(min, max, crate::framing::FIT_MARGIN_2D);
            }
            true
        } else {
            // 3D (Arcball/Fly): the camera lives in normalized world space.
            let Some((min, max)) = self.dataset_world_bounds(dataset_id) else {
                return false;
            };
            self.camera.fit_to_bounds(min, max);
            true
        }
    }

    /// Return aggregate bounds for all visible image members in scene XY space.
    pub fn visible_content_bounds_2d(&self) -> Option<VisibleContentBounds2D> {
        let mut bounds: Option<VisibleContentBounds2D> = None;

        for id in &self.dataset_order {
            self.accumulate_visible_dataset_bounds_2d(id, &mut bounds);
        }

        // Be tolerant of partially hydrated scenes where derived state exists
        // before dataset_order is fully populated.
        for id in self.derived.keys() {
            if !self.dataset_order.contains(id) {
                self.accumulate_visible_dataset_bounds_2d(id, &mut bounds);
            }
        }

        bounds
    }

    fn accumulate_visible_dataset_bounds_2d(
        &self,
        id: &DatasetId,
        bounds: &mut Option<VisibleContentBounds2D>,
    ) {
        let settings = self.dataset_settings.get(id).cloned().unwrap_or_default();
        if !settings.visible {
            return;
        }
        let Some(derived) = self.derived.get(id) else {
            return;
        };

        for member in &derived.members {
            let Some(level) = member.levels.first() else {
                continue;
            };
            let width = level.shape[4] as f64;
            let height = level.shape[3] as f64;
            if width <= 0.0 || height <= 0.0 {
                continue;
            }
            let candidate = VisibleContentBounds2D {
                min_x: member.position[0],
                min_y: member.position[1],
                max_x: member.position[0] + width,
                max_y: member.position[1] + height,
                max_depth: level.shape[2].min(u32::MAX as u64) as u32,
            };
            *bounds = Some(match *bounds {
                Some(existing) => VisibleContentBounds2D {
                    min_x: existing.min_x.min(candidate.min_x),
                    min_y: existing.min_y.min(candidate.min_y),
                    max_x: existing.max_x.max(candidate.max_x),
                    max_y: existing.max_y.max(candidate.max_y),
                    max_depth: existing.max_depth.max(candidate.max_depth),
                },
                None => candidate,
            });
        }
    }

    /// Compute the chunk request plan for all visible layers across all datasets.
    /// Returns a flat `ChunkRequestPlan` (union of all members of the first dataset).
    pub fn chunk_plan(&self) -> ChunkRequestPlan {
        let ds_id = match self.document.manifests.keys().next() {
            Some(id) => id.clone(),
            None => {
                return ChunkRequestPlan {
                    needed: Vec::new(),
                    prefetch: Vec::new(),
                };
            }
        };
        let members = match self.chunk_plan_for(&ds_id) {
            Some(m) => m,
            None => {
                return ChunkRequestPlan {
                    needed: Vec::new(),
                    prefetch: Vec::new(),
                };
            }
        };
        // Flatten all members into a single ChunkRequestPlan for backward compat.
        let mut needed = Vec::new();
        let mut prefetch = Vec::new();
        for m in members {
            needed.extend(m.needed);
            prefetch.extend(m.prefetch);
        }
        ChunkRequestPlan { needed, prefetch }
    }

    /// Compute the chunk request plan for a specific dataset by ID.
    ///
    /// Returns one `MemberChunkPlan` per visible member. For the common
    /// single-member-at-origin case this is a single element whose
    /// `needed`/`prefetch` lists are identical to the old flat plan.
    ///
    /// For multi-member datasets (plates), each member's AABB is checked
    /// against the visible region, and chunk planning is done in
    /// member-local coordinates.
    pub fn chunk_plan_for(&self, dataset_id: &DatasetId) -> Option<Vec<MemberChunkPlan>> {
        let derived = self.derived.get(dataset_id)?;

        let is_2d = matches!(self.camera, Camera::Slice(_));

        let mut plans = Vec::new();
        for member in &derived.members {
            if member.levels.is_empty() {
                continue;
            }

            let level0 = &member.levels[0];
            let fov_w = level0.shape[4] as f64; // X
            let fov_h = level0.shape[3] as f64; // Y

            // Compute visible region using the member's volume transform.
            let vol_shape = [
                level0.shape[2] as u32,
                level0.shape[3] as u32,
                level0.shape[4] as u32,
            ];
            let region = self.camera.visible_region(
                &self.view.z_range,
                Some(&member.volume_transform),
                Some(&vol_shape),
            );

            // AABB culling (same logic as current but using member.position)
            let pos_x = member.position[0];
            let pos_y = member.position[1];
            let member_max_x = pos_x + fov_w;
            let member_max_y = pos_y + fov_h;

            let [vis_min_x, vis_min_y, vis_max_x, vis_max_y] = region.xy_bounds;

            // AABB overlap test
            if member_max_x <= vis_min_x
                || pos_x >= vis_max_x
                || member_max_y <= vis_min_y
                || pos_y >= vis_max_y
            {
                continue; // member is fully outside the visible region
            }

            // Offset visible region by member position
            let local_region = crate::camera::VisibleRegion {
                xy_bounds: [
                    vis_min_x - pos_x,
                    vis_min_y - pos_y,
                    vis_max_x - pos_x,
                    vis_max_y - pos_y,
                ],
                z_range: region.z_range.clone(),
                effective_zoom: region.effective_zoom,
                radius_basis_vox: region.radius_basis_vox,
                sort_center: region
                    .sort_center
                    .map(|[cx, cy, cz]| [cx - pos_x, cy - pos_y, cz]),
                frustum_planes: region
                    .frustum_planes
                    .map(|planes| planes.map(|[a, b, c, d]| [a, b, c, d + a * pos_x + b * pos_y])),
            };

            // Select level based on effective zoom
            let level =
                chunk::select_level(local_region.effective_zoom, member.levels.len() as u32);
            let level_geo = &member.levels[level as usize];

            let t = self.view.t;
            let c = self.view.c;

            let (needed, prefetch) = if !is_2d {
                (
                    chunk::visible_chunks(&local_region, level_geo, t, c, level0),
                    vec![],
                )
            } else {
                chunk::visible_and_prefetch_chunks(&local_region, level_geo, t, c, level0)
            };

            plans.push(MemberChunkPlan {
                image_id: member.image_id.clone(),
                position: member.position,
                needed,
                prefetch,
            });
        }

        Some(plans)
    }

    /// Build the rendering model matrix for a member — the same transform
    /// the GPU uses, including Y-flip, global normalization, and top-alignment.
    ///
    /// Returns (model, inv_model) in the camera's coordinate space.
    pub fn rendering_transform(&self, member: &MemberState) -> (VolumeTransform, VolumeTransform) {
        let level0 = match member.levels.first() {
            Some(l) => l,
            None => {
                let id = VolumeTransform {
                    model: [
                        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
                        1.0,
                    ],
                    inv_model: [
                        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
                        1.0,
                    ],
                    max_physical_extent: 1.0,
                };
                return (id.clone(), id);
            }
        };

        let t = &member.volume_transform;
        let max_phys = if t.max_physical_extent > 0.0 {
            t.max_physical_extent
        } else {
            1.0
        };
        let vol_shape = [
            level0.shape[2] as u32,
            level0.shape[3] as u32,
            level0.shape[4] as u32,
        ];

        // Recover voxel scale from volume transform
        let scale_x = if vol_shape[2] > 0 {
            t.model[0] as f64 * max_phys / vol_shape[2] as f64
        } else {
            1.0
        };
        let scale_y = if vol_shape[1] > 0 {
            t.model[5] as f64 * max_phys / vol_shape[1] as f64
        } else {
            1.0
        };
        let scale_z = if vol_shape[0] > 0 {
            t.model[10] as f64 * max_phys / vol_shape[0] as f64
        } else {
            1.0
        };

        // Y-flip for 3D (Y-up convention)
        let flipped_offset = [
            member.position[0],
            vol_shape[1] as f64 - member.position[1] - vol_shape[1] as f64,
        ];
        let mt = transform::compute_member_transform(
            vol_shape,
            [scale_z, scale_y, scale_x],
            flipped_offset,
            max_phys,
        );

        // Global correction for multi-dataset scenes
        let global_max = self.global_max_physical_extent();
        let correction = (max_phys / global_max) as f32;
        let inv_correction = (global_max / max_phys) as f32;

        let phys_y = t.model[5] as f64 * max_phys;
        let global_max_y = self.global_max_physical_y();
        let top_align = ((global_max_y - phys_y) / global_max) as f32;

        // Forward model
        let mut model = mt.model;
        model[0] *= correction;
        model[5] *= correction;
        model[10] *= correction;
        model[12] *= correction;
        model[13] *= correction;
        model[13] += top_align;

        // Inverse model
        let mut inv_model = mt.inv_model;
        inv_model[0] *= inv_correction;
        inv_model[5] *= inv_correction;
        inv_model[10] *= inv_correction;
        inv_model[13] -= top_align * inv_model[5];

        let fwd = VolumeTransform {
            model,
            inv_model: [0.0; 16],
            max_physical_extent: max_phys,
        };
        let inv = VolumeTransform {
            model: [0.0; 16],
            inv_model,
            max_physical_extent: max_phys,
        };
        (fwd, inv)
    }

    /// Pick the closest entity hit by a ray cast from screen coordinates.
    ///
    /// For Slice (2D) mode: tests the voxel-space ray against each member's
    /// voxel-space AABB (position + shape). The Slice camera operates in
    /// voxel coordinates, so the ray and member bounds are in the same space.
    ///
    /// For 3D modes (Arcball/Fly): uses the rendering transform (which
    /// includes Y-flip, global correction, and top-alignment) so the ray
    /// test matches what the camera actually sees.
    pub fn ray_pick(
        &self,
        dataset_id: &DatasetId,
        screen_x: f64,
        screen_y: f64,
    ) -> Option<crate::ray::RayHit> {
        let derived = self.derived.get(dataset_id)?;
        let world_ray = self.camera.unproject_ray(screen_x, screen_y);
        let is_2d = matches!(self.camera, Camera::Slice(_));
        let mut closest: Option<crate::ray::RayHit> = None;

        for member in &derived.members {
            let level0 = match member.levels.first() {
                Some(l) => l,
                None => continue,
            };

            let hit_result = if is_2d {
                // Slice mode: ray and member positions are both in voxel space.
                let pos_x = member.position[0];
                let pos_y = member.position[1];
                let fov_w = level0.shape[4] as f64;
                let fov_h = level0.shape[3] as f64;

                let rx = world_ray.origin[0];
                let ry = world_ray.origin[1];

                if rx >= pos_x && rx <= pos_x + fov_w && ry >= pos_y && ry <= pos_y + fov_h {
                    Some(([rx, ry, 0.0], 0.0))
                } else {
                    None
                }
            } else {
                // 3D mode: use rendering transform to match camera space.
                let (fwd, inv) = self.rendering_transform(member);

                let local_ray = crate::ray::transform_ray(&world_ray, &inv.inv_model);

                local_ray.intersect_unit_cube().map(|t| {
                    let hit_local = [
                        local_ray.origin[0] + t * local_ray.direction[0],
                        local_ray.origin[1] + t * local_ray.direction[1],
                        local_ray.origin[2] + t * local_ray.direction[2],
                    ];
                    let hit_world = crate::ray::transform_point(&hit_local, &fwd.model);
                    let dx = hit_world[0] - world_ray.origin[0];
                    let dy = hit_world[1] - world_ray.origin[1];
                    let dz = hit_world[2] - world_ray.origin[2];
                    (hit_world, (dx * dx + dy * dy + dz * dz).sqrt())
                })
            };

            if let Some((hit_world, distance)) = hit_result
                && closest.as_ref().is_none_or(|c| distance < c.distance)
            {
                closest = Some(crate::ray::RayHit {
                    entity_id: member.entity_id.clone(),
                    image_id: member.image_id.clone(),
                    world_position: hit_world,
                    distance,
                });
            }
        }

        closest
    }

    // --- 3D annotation anchoring ---
    //
    // A pin's stored world point `(position[0], position[1], z)` lives in the
    // SAME in-plane-voxel + voxel-depth frame the 2D pin position has always
    // used (image convention: x right, y down, z = slice index). The helpers
    // below convert that point to/from the arcball camera's world space by
    // **reusing** `rendering_transform` (the exact model matrix the volume
    // render pass uses — Y-flip, global normalization, top-alignment) and the
    // camera's own `project_to_screen` / `ray_pick`. Nothing is re-derived, so
    // a marker tracks the volume identically to how the volume itself renders,
    // and a depth pick is the exact inverse of the projection used to draw it.

    /// Resolve the first member of `dataset_id`, with its level-0 voxel shape
    /// `[X, Y, Z]`. Pins are dataset-scoped and anchored against the dataset's
    /// primary member (the same member `ray_pick`/`view_query` treat as the
    /// volume), so depth is consistent between drop and render.
    fn annotation_member(&self, dataset_id: &DatasetId) -> Option<(&MemberState, [f64; 3])> {
        let derived = self.derived.get(dataset_id)?;
        let member = derived.members.first()?;
        let level0 = member.levels.first()?;
        let shape = [
            level0.shape[4] as f64, // X
            level0.shape[3] as f64, // Y
            level0.shape[2] as f64, // Z
        ];
        Some((member, shape))
    }

    /// Map an in-plane-voxel + voxel-depth pin point to arcball-world space
    /// using the dataset's rendering transform. Image-convention Y (0 = top) is
    /// flipped to the renderer's Y-up unit cube exactly like
    /// `ray_hit_local_image` does in reverse, so a pin drawn here lands where
    /// the matching voxel is drawn in the volume.
    fn annotation_world_point(
        &self,
        member: &MemberState,
        shape: [f64; 3],
        point: [f64; 3],
    ) -> [f64; 3] {
        let (fwd, _) = self.rendering_transform(member);
        let ux = if shape[0] > 0.0 {
            point[0] / shape[0]
        } else {
            0.0
        };
        // Image y-down -> unit y-up.
        let uy = if shape[1] > 0.0 {
            1.0 - point[1] / shape[1]
        } else {
            0.0
        };
        let uz = if shape[2] > 0.0 {
            point[2] / shape[2]
        } else {
            0.0
        };
        crate::ray::transform_point(&[ux, uy, uz], &fwd.model)
    }

    /// Project a pin's stored world point `(x, y, z)` (in-plane voxel + voxel
    /// depth) to screen-space pixels through the active camera.
    ///
    /// In 2D slice mode this is just the in-plane projection the 2D overlay has
    /// always used (depth ignored, matching `Camera::project_to_screen`). In a
    /// 3D mode the point is first lifted to arcball-world via the rendering
    /// transform, so the marker tracks the volume as the camera orbits.
    /// Returns `None` when the point is behind the camera (3D only) or the
    /// dataset has no anchorable member — the caller hides the marker, which is
    /// also what makes a marker vanish as it swings behind the volume.
    pub fn project_annotation(
        &self,
        dataset_id: &DatasetId,
        x: f64,
        y: f64,
        z: f64,
    ) -> Option<[f64; 2]> {
        if matches!(self.camera, Camera::Slice(_)) {
            // 2D: keep the long-standing in-plane behavior verbatim.
            return self.camera.project_to_screen([x, y, z]);
        }
        let (member, shape) = self.annotation_member(dataset_id)?;
        let world = self.annotation_world_point(member, shape, [x, y, z]);
        self.camera.project_to_screen(world)
    }

    /// Lift a pin's stored voxel point `(x, y, z)` (in-plane voxel + voxel depth)
    /// to arcball-WORLD space via the dataset's rendering transform — the SAME
    /// lift [`Self::project_annotation`] does before projecting, so a point fed
    /// here lands where its marker is drawn. Returns `None` for an
    /// unknown/unanchorable dataset (caller treats it as a no-op).
    ///
    /// This is the world point the 3D "center on a pin" viewport command
    /// (`CenterOnVoxel3D`) makes the arcball target, so the recenter and the
    /// marker projection share one definition of the pin's world position.
    pub(crate) fn annotation_world_point_for(
        &self,
        dataset_id: &DatasetId,
        point: [f64; 3],
    ) -> Option<[f64; 3]> {
        let (member, shape) = self.annotation_member(dataset_id)?;
        Some(self.annotation_world_point(member, shape, point))
    }

    /// Depth pick for a pin dropped in a 3D view: ray-cast from screen into the
    /// volume and return the hit as an in-plane-voxel + voxel-depth point
    /// `[x, y, z]`, ready to store as `(position, z)`. This is the exact inverse
    /// of [`Self::annotation_world_point`] (so the new marker re-projects to the
    /// cursor), built on the shared `ray_pick`. Returns `None` if the ray misses
    /// the volume; the caller then declines to drop a pin into empty space.
    pub fn pick_annotation_voxel(
        &self,
        dataset_id: &DatasetId,
        screen_x: f64,
        screen_y: f64,
    ) -> Option<[f64; 3]> {
        let hit = self.ray_pick(dataset_id, screen_x, screen_y)?;
        let (member, shape) = self.annotation_member(dataset_id)?;
        let (_, inv) = self.rendering_transform(member);
        // World -> unit cube, then unit -> image-convention voxel (un-flip Y).
        let unit = crate::ray::transform_point(&hit.world_position, &inv.inv_model);
        let vx = unit[0] * shape[0];
        let vy = (1.0 - unit[1]) * shape[1];
        let vz = unit[2] * shape[2];
        Some([vx, vy, vz])
    }

    /// Rebuild derived state from the document's dataset manifests.
    /// Call this after deserializing a Scene (since derived is not serialized).
    pub fn rebuild_derived(&mut self) {
        self.derived.clear();
        for (id, manifest) in &self.document.manifests {
            let layout = resolve_layout(
                manifest,
                self.document.registered_layouts.get(id),
                self.document.active_layout_ids.get(id),
            );
            self.derived
                .insert(id.clone(), build_derived_state(manifest, &layout));
        }
    }

    /// Query the scene for geometric information about all entities in a dataset
    /// from the current camera viewpoint.
    pub fn view_query(&self, dataset_id: &DatasetId) -> Option<ViewQueryResult> {
        let derived = self.derived.get(dataset_id)?;
        let manifest = self.document.manifests.get(dataset_id)?;
        let vp = self.camera.viewport();
        let eye = self.camera.eye_position();

        let mut results = Vec::with_capacity(derived.members.len());

        let is_2d = matches!(self.camera, Camera::Slice(_));

        for member in &derived.members {
            let pos = member.position;

            // Compute screen-space bounding box.
            // 2D: corners in voxel space (pos to pos+fov_size).
            // 3D: corners from rendering_transform (includes position, Y-flip, global correction).
            let mut screen_min = [f64::MAX, f64::MAX];
            let mut screen_max = [f64::MIN, f64::MIN];
            let mut any_visible = false;

            let centroid;

            if is_2d {
                let level0 = member.levels.first();
                let (fw, fh, fd) = level0
                    .map(|l| (l.shape[4] as f64, l.shape[3] as f64, l.shape[2] as f64))
                    .unwrap_or((1.0, 1.0, 1.0));
                centroid = [pos[0] + fw / 2.0, pos[1] + fh / 2.0, fd / 2.0];
                let corners = [
                    [pos[0], pos[1], 0.0],
                    [pos[0] + fw, pos[1], 0.0],
                    [pos[0], pos[1] + fh, 0.0],
                    [pos[0] + fw, pos[1] + fh, 0.0],
                ];
                for corner in &corners {
                    if let Some([sx, sy]) = self.camera.project_to_screen(*corner) {
                        screen_min[0] = screen_min[0].min(sx);
                        screen_min[1] = screen_min[1].min(sy);
                        screen_max[0] = screen_max[0].max(sx);
                        screen_max[1] = screen_max[1].max(sy);
                        any_visible = true;
                    }
                }
            } else {
                let (rt, _) = self.rendering_transform(member);
                let corners = rt.world_corners();
                let rt_centroid = rt.world_centroid();
                centroid = rt_centroid;
                for corner in &corners {
                    if let Some([sx, sy]) = self.camera.project_to_screen(*corner) {
                        screen_min[0] = screen_min[0].min(sx);
                        screen_min[1] = screen_min[1].min(sy);
                        screen_max[0] = screen_max[0].max(sx);
                        screen_max[1] = screen_max[1].max(sy);
                        any_visible = true;
                    }
                }
            }

            // Check if screen rect overlaps viewport
            let visible = any_visible
                && screen_max[0] > 0.0
                && screen_max[1] > 0.0
                && screen_min[0] < vp[0] as f64
                && screen_min[1] < vp[1] as f64;

            let (projected_diagonal_px, projected_area_px2) = if visible {
                let w = (screen_max[0] - screen_min[0]).max(0.0);
                let h = (screen_max[1] - screen_min[1]).max(0.0);
                ((w * w + h * h).sqrt(), w * h)
            } else {
                (0.0, 0.0)
            };

            // Per-entity ideal LOD
            let num_levels = member.levels.len() as u32;
            let ideal_target_lod = if visible && projected_diagonal_px > 0.0 {
                let level_0 = member.levels.first();
                let voxel_diagonal = level_0
                    .map(|l| {
                        let sx = l.shape[4] as f64; // X
                        let sy = l.shape[3] as f64; // Y
                        let sz = l.shape[2] as f64; // Z
                        (sx * sx + sy * sy + sz * sz).sqrt()
                    })
                    .unwrap_or(1.0);

                let ppv = projected_diagonal_px / voxel_diagonal.max(1.0);
                let raw = (-ppv.log2()).floor().max(0.0) as u32;
                raw.min(num_levels.saturating_sub(1))
            } else {
                num_levels.saturating_sub(1) // coarsest
            };

            // Distance from camera
            let dx = centroid[0] - eye[0];
            let dy = centroid[1] - eye[1];
            let dz = centroid[2] - eye[2];
            let distance = (dx * dx + dy * dy + dz * dz).sqrt();

            // Importance: larger on screen + closer = more important
            let importance = if distance > 1e-6 {
                projected_area_px2 / distance
            } else {
                projected_area_px2
            };

            // Determine entity kind
            let kind = manifest
                .entities()
                .iter()
                .find(|e| e.id == member.entity_id)
                .map(|e| e.kind.clone())
                .unwrap_or(EntityKind::Image);

            results.push(EntityQueryResult {
                entity_id: member.entity_id.clone(),
                image_id: member.image_id.clone(),
                kind,
                visible,
                projected_diagonal_px,
                projected_area_px2,
                centroid_world: centroid,
                ideal_target_lod,
                importance,
            });
        }

        // Sort by importance descending
        results.sort_by(|a, b| {
            b.importance
                .partial_cmp(&a.importance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Some(ViewQueryResult {
            epochs: self.epochs.clone(),
            visible_entities: results,
        })
    }
}

/// Resolve which layout to use for a dataset.
///
/// Search order:
/// 1. If `active_id` is Some, search source_layouts then registered for matching ID
/// 2. Otherwise use `manifest.default_layout_id` to search source_layouts
/// 3. Fallback to first source layout
/// 4. Fallback to empty LayoutSpec
pub fn resolve_layout(
    manifest: &DatasetManifest,
    registered: Option<&Vec<LayoutSpec>>,
    active_id: Option<&LayoutId>,
) -> LayoutSpec {
    if let Some(id) = active_id {
        // Search source layouts first
        if let Some(layout) = manifest.source_layouts().iter().find(|l| &l.id == id) {
            return layout.clone();
        }
        // Then registered layouts
        if let Some(layouts) = registered
            && let Some(layout) = layouts.iter().find(|l| &l.id == id)
        {
            return layout.clone();
        }
    }

    // Fallback: use default_layout_id from the manifest
    manifest
        .default_layout_id
        .as_ref()
        .and_then(|id| manifest.source_layouts().iter().find(|l| &l.id == id))
        .or_else(|| manifest.source_layouts().first())
        .cloned()
        .unwrap_or_else(|| LayoutSpec {
            id: LayoutId("default".into()),
            name: "Default".into(),
            placements: vec![],
        })
}

pub fn build_derived_state(manifest: &DatasetManifest, layout: &LayoutSpec) -> DatasetDerivedState {
    let active_layout = layout.clone();

    // Build per-image member state
    let mut members = Vec::new();
    let mut volume_transforms = HashMap::new();

    for image in manifest.images() {
        // Find position from layout placements
        let position = find_entity_position(
            &image.owner,
            &active_layout,
            manifest.entities(),
            manifest.transforms(),
        );

        // Compute volume transform from level 0 geometry
        let vt = if let Some(level0) = image.multiscale.levels.first() {
            let shape_3d = [
                level0.shape[2] as u32,
                level0.shape[3] as u32,
                level0.shape[4] as u32,
            ];
            let scale_3d = [level0.scale[2], level0.scale[3], level0.scale[4]];
            transform::compute_volume_transform(shape_3d, scale_3d)
        } else {
            VolumeTransform {
                model: [
                    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                ],
                inv_model: [
                    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                ],
                max_physical_extent: 1.0,
            }
        };

        volume_transforms.insert(image.image_id.clone(), vt.clone());

        members.push(MemberState {
            entity_id: image.owner.clone(),
            image_id: image.image_id.clone(),
            position,
            volume_transform: vt,
            levels: image.multiscale.levels.clone(),
            data_type: image.multiscale.data_type,
        });
    }

    DatasetDerivedState {
        volume_transforms,
        active_layout,
        members,
    }
}

/// Find the position of an entity in the layout.
/// For Image entities: look up directly in layout placements.
/// For Field entities: look up parent well's placement + field->well transform translation.
///
/// Returns `[0.0, 0.0]` as a last-resort fallback for an entity with no resolvable
/// placement, so render-path callers always get *some* position. Annotation
/// anchoring instead uses [`resolve_entity_position`] (this function's `Option`
/// sibling) so it never mistakes that fallback for a real origin placement.
///
/// `pub(crate)` so `DocumentState::apply` (in `scene::types`) can reuse the exact
/// same entity→position mapping the renderer uses when it re-anchors pins on a
/// layout switch — the displacement a pin rides must match where the entity is
/// actually drawn.
pub(crate) fn find_entity_position(
    entity_id: &EntityId,
    layout: &LayoutSpec,
    entities: &[Entity],
    transforms: &[TransformEdge],
) -> [f64; 2] {
    resolve_entity_position(entity_id, layout, entities, transforms).unwrap_or([0.0, 0.0])
}

/// Resolve an entity's `[x, y]` in `layout`, or `None` when it has no placement
/// there (neither a direct placement nor a placed parent to compose against).
///
/// This is the strict, fallback-free sibling of [`find_entity_position`]: where
/// that function collapses an unplaceable entity to `[0.0, 0.0]` for the render
/// path, this distinguishes "genuinely placed at the origin" from "not placeable
/// in this layout". Annotation anchoring depends on that distinction:
///   - picking the nearest entity must not treat unplaceable entities as if they
///     sat at the origin, and
///   - re-anchoring on a layout switch must skip a pin whose anchor isn't placed
///     in *both* layouts (leaving it untouched) rather than yanking it toward a
///     phantom `[0, 0]`.
pub(crate) fn resolve_entity_position(
    entity_id: &EntityId,
    layout: &LayoutSpec,
    entities: &[Entity],
    transforms: &[TransformEdge],
) -> Option<[f64; 2]> {
    // Direct placement?
    if let Some(p) = layout.placements.iter().find(|p| &p.entity_id == entity_id) {
        return Some(p.position);
    }

    // Otherwise, compose a field's position from its parent well's placement plus
    // the field->well transform translation. Only resolvable if the parent is
    // itself placed in this layout.
    let entity = entities.iter().find(|e| &e.id == entity_id)?;
    let parent_id = entity.parent.as_ref()?;
    let parent_pos = layout
        .placements
        .iter()
        .find(|p| &p.entity_id == parent_id)
        .map(|p| p.position)?;

    let transform_offset = transforms
        .iter()
        .find(|t| &t.from == entity_id && &t.to == parent_id)
        .map(|t| [t.transform.matrix()[12], t.transform.matrix()[13]])
        .unwrap_or([0.0, 0.0]);

    Some([
        parent_pos[0] + transform_offset[0],
        parent_pos[1] + transform_offset[1],
    ])
}

/// Test helpers for constructing dataset manifests and DatasetOpened events.
#[cfg(test)]
pub(crate) mod test_helpers {
    use lucida_content::*;
    use lucida_protocol::*;

    /// Create a DatasetOpened with a simple single-image manifest.
    pub fn make_dataset_opened(id: &str, name: &str, channels: u64) -> DatasetOpened {
        let entity_id = EntityId(format!("{id}-entity"));
        let image_id = ImageId(format!("{id}-image"));

        let manifest = DatasetManifest::new(
            DatasetId(id.to_string()),
            name.to_string(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some(name.to_string()),
                    ..Default::default()
                },
            }],
            vec![],
            vec![ImageSpec {
                image_id: image_id.clone(),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".to_string(),
                            kind: AxisKind::Channel,
                        },
                        Axis {
                            name: "z".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".to_string(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, channels, 10, 256, 256],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, channels, 10, 2, 2],
                        scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    channel_infos: vec![],
                },
            }],
            vec![],
            None,
        );

        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });

        DatasetOpened {
            manifest,
            fetch,
            catalog: AssetCatalog::default(),
        }
    }

    /// Create a DatasetOpened with specific shape and multiple levels.
    pub fn make_dataset_opened_with_shape(
        id: &str,
        name: &str,
        _channels: u64,
        shape: [u64; 5],
        chunk_shape: [u64; 5],
        num_levels: u32,
    ) -> DatasetOpened {
        let entity_id = EntityId(format!("{id}-entity"));
        let image_id = ImageId(format!("{id}-image"));

        let mut levels = Vec::new();
        for l in 0..num_levels {
            let scale = 1u64 << l;
            levels.push(LevelGeometry {
                level_index: l,
                shape: [
                    shape[0],
                    shape[1],
                    shape[2].div_ceil(scale),
                    shape[3].div_ceil(scale),
                    shape[4].div_ceil(scale),
                ],
                chunk_shape,
                grid_shape: [
                    shape[0].div_ceil(chunk_shape[0]),
                    shape[1].div_ceil(chunk_shape[1]),
                    shape[2].div_ceil(scale).div_ceil(chunk_shape[2]),
                    shape[3].div_ceil(scale).div_ceil(chunk_shape[3]),
                    shape[4].div_ceil(scale).div_ceil(chunk_shape[4]),
                ],
                scale: [1.0, 1.0, 1.0, 1.0, 1.0],
            });
        }

        let manifest = DatasetManifest::new(
            DatasetId(id.to_string()),
            name.to_string(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some(name.to_string()),
                    ..Default::default()
                },
            }],
            vec![],
            vec![ImageSpec {
                image_id: image_id.clone(),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".to_string(),
                            kind: AxisKind::Channel,
                        },
                        Axis {
                            name: "z".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".to_string(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels,
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    channel_infos: vec![],
                },
            }],
            vec![],
            None,
        );

        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });

        DatasetOpened {
            manifest,
            fetch,
            catalog: AssetCatalog::default(),
        }
    }

    /// Create a DatasetOpened for a plate with multiple image members.
    pub fn make_plate_dataset_opened(
        id: &str,
        name: &str,
        members: Vec<(&str, [f64; 2])>,
        image_shape: [u64; 5],
        chunk_shape: [u64; 5],
    ) -> DatasetOpened {
        use lucida_content::layout::EntityPlacement;

        let mut entities = Vec::new();
        let mut images = Vec::new();
        let mut placements = Vec::new();
        let mut fetch_images = Vec::new();

        for (member_id, position) in &members {
            let entity_id = EntityId(member_id.to_string());
            let image_id = ImageId(format!("{member_id}-image"));

            entities.push(Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some(member_id.to_string()),
                    ..Default::default()
                },
            });

            placements.push(EntityPlacement {
                entity_id: entity_id.clone(),
                position: *position,
            });

            images.push(ImageSpec {
                image_id: image_id.clone(),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".to_string(),
                            kind: AxisKind::Channel,
                        },
                        Axis {
                            name: "z".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".to_string(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: image_shape,
                        chunk_shape,
                        grid_shape: [
                            image_shape[0].div_ceil(chunk_shape[0]),
                            image_shape[1].div_ceil(chunk_shape[1]),
                            image_shape[2].div_ceil(chunk_shape[2]),
                            image_shape[3].div_ceil(chunk_shape[3]),
                            image_shape[4].div_ceil(chunk_shape[4]),
                        ],
                        scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    channel_infos: vec![],
                },
            });

            fetch_images.push(ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            });
        }

        let layout = LayoutSpec {
            id: LayoutId("default".into()),
            name: "Default".into(),
            placements,
        };

        let manifest = DatasetManifest::new(
            DatasetId(id.to_string()),
            name.to_string(),
            DatasetKind::Plate {
                rows: vec!["A".to_string()],
                columns: vec!["1".to_string(), "2".to_string()],
                positioning_mode: PositioningMode::Grid,
                has_stage_positions: false,
            },
            entities,
            vec![],
            images,
            vec![layout],
            Some(LayoutId("default".into())),
        );

        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: fetch_images,
        });

        DatasetOpened {
            manifest,
            fetch,
            catalog: AssetCatalog::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::DocumentCommand;

    #[test]
    fn empty_scene_produces_empty_plan() {
        let scene = Scene::new([800, 600]);
        let plan = scene.chunk_plan();
        assert!(plan.needed.is_empty());
    }

    #[test]
    fn registered_dataset_produces_chunks() {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 256, 4096, 4096],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let plan = scene.chunk_plan();
        assert!(!plan.needed.is_empty());
    }

    #[test]
    fn changing_slice_updates_chunk_coords() {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 256, 4096, 4096],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let plan_z0 = scene.chunk_plan();
        scene.view.set_slice("z", 100).unwrap();
        let plan_z100 = scene.chunk_plan();

        assert_eq!(plan_z0.needed[0].z, 0);
        assert_eq!(plan_z100.needed[0].z, 1);
    }

    #[test]
    fn z_slab_produces_chunks_across_z() {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 256, 4096, 4096],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.view.set_z_range(0..128);
        let plan = scene.chunk_plan();
        let z_values: Vec<u32> = plan.needed.iter().map(|c| c.z).collect();
        assert!(z_values.contains(&0));
        assert!(z_values.contains(&1));
    }

    #[test]
    fn mode_switching_preserves_viewport() {
        let mut scene = Scene::new([800, 600]);
        assert!(matches!(scene.camera, Camera::Slice(_)));

        scene.set_mode_3d();
        assert!(matches!(scene.camera, Camera::Arcball(_)));
        assert_eq!(scene.camera.viewport(), [800, 600]);

        scene.set_mode_2d();
        assert!(matches!(scene.camera, Camera::Slice(_)));
        assert_eq!(scene.camera.viewport(), [800, 600]);
    }

    #[test]
    fn scene_serialization_round_trip() {
        let mut scene = Scene::new([800, 600]);
        scene.view.set_z(5);
        scene.view.t = 2;
        scene.view.c = 1;

        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let json = serde_json::to_string(&scene).unwrap();
        let mut parsed: Scene = serde_json::from_str(&json).unwrap();
        // Rebuild derived state after deserialization
        parsed.rebuild_derived();

        assert_eq!(parsed.view.z_range, 5..6);
        assert_eq!(parsed.view.t, 2);
        assert_eq!(parsed.view.c, 1);
        assert_eq!(parsed.document.manifests.len(), 1);
        assert!(
            parsed
                .document
                .manifests
                .contains_key(&DatasetId("ds1".into()))
        );
        if let Camera::Slice(v) = &parsed.camera {
            assert_eq!(v.viewport, [800, 600]);
        } else {
            panic!("expected Slice");
        }
    }

    #[test]
    fn dataset_opened_populates_dataset_order_and_settings() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "first", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("ds1".into());
        assert_eq!(scene.dataset_order, vec![ds_id.clone()]);
        assert!(scene.dataset_settings.contains_key(&ds_id));
        let settings = &scene.dataset_settings[&ds_id];
        assert!(settings.visible);
        assert_eq!(settings.opacity, 1.0);
    }

    #[test]
    fn remove_dataset_cleans_up_state() {
        let mut scene = Scene::new([800, 600]);
        let reg1 = test_helpers::make_dataset_opened("ds1", "first", 1);
        let reg2 = test_helpers::make_dataset_opened("ds2", "second", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg1).into());
        scene.apply(DocumentCommand::DatasetOpened(reg2).into());
        let ds1_id = DatasetId("ds1".into());
        let ds2_id = DatasetId("ds2".into());
        scene.remove_dataset(&ds1_id);
        assert_eq!(scene.dataset_order, vec![ds2_id.clone()]);
        assert!(!scene.dataset_settings.contains_key(&ds1_id));
        assert!(scene.dataset_settings.contains_key(&ds2_id));
        assert!(!scene.derived.contains_key(&ds1_id));
    }

    #[test]
    fn scene_backward_compat_deserialization_without_settings() {
        // JSON without dataset_order/dataset_settings should deserialize with defaults
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        // Serialize, then strip optional fields
        let json = serde_json::to_string(&scene).unwrap();
        let mut val: serde_json::Value = serde_json::from_str(&json).unwrap();
        val.as_object_mut().unwrap().remove("dataset_order");
        val.as_object_mut().unwrap().remove("dataset_settings");
        let parsed: Scene = serde_json::from_value(val).unwrap();
        assert!(parsed.dataset_order.is_empty());
        assert!(parsed.dataset_settings.is_empty());
    }

    #[test]
    fn dataset_opened_deduplicates_by_id() {
        let mut scene = Scene::new([800, 600]);
        let reg1 = test_helpers::make_dataset_opened("ds1", "first", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg1).into());
        assert_eq!(scene.document.manifests.len(), 1);
        let reg2 = test_helpers::make_dataset_opened("ds1", "updated", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg2).into());
        assert_eq!(scene.document.manifests.len(), 1);
        assert_eq!(
            scene.document.manifests[&DatasetId("ds1".into())].name,
            "updated"
        );
    }

    #[test]
    fn remove_dataset_by_id() {
        let mut scene = Scene::new([800, 600]);
        let reg1 = test_helpers::make_dataset_opened("ds1", "first", 1);
        let reg2 = test_helpers::make_dataset_opened("ds2", "second", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg1).into());
        scene.apply(DocumentCommand::DatasetOpened(reg2).into());
        assert_eq!(scene.document.manifests.len(), 2);
        scene.remove_dataset(&DatasetId("ds1".into()));
        assert_eq!(scene.document.manifests.len(), 1);
        assert!(
            scene
                .document
                .manifests
                .contains_key(&DatasetId("ds2".into()))
        );
    }

    #[test]
    fn chunk_plan_for_returns_member_plans() {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 256, 4096, 4096],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("ds1".into());
        let plans = scene.chunk_plan_for(&ds_id).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].image_id, ImageId("ds1-image".into()));
        assert!(!plans[0].needed.is_empty());
    }

    #[test]
    fn chunk_plan_for_single_member_matches_flat_plan() {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 256, 4096, 4096],
            [1, 1, 64, 256, 256],
            5,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let flat = scene.chunk_plan();
        let ds_id = DatasetId("ds1".into());
        let member_plans = scene.chunk_plan_for(&ds_id).unwrap();
        assert_eq!(member_plans.len(), 1);
        assert_eq!(flat.needed.len(), member_plans[0].needed.len());
        assert_eq!(flat.prefetch.len(), member_plans[0].prefetch.len());
        for (a, b) in flat.needed.iter().zip(member_plans[0].needed.iter()) {
            assert_eq!(a.key(), b.key());
        }
    }

    #[test]
    fn chunk_plan_for_missing_dataset_returns_none() {
        let scene = Scene::new([512, 512]);
        let ds_id = DatasetId("nonexistent".into());
        assert!(scene.chunk_plan_for(&ds_id).is_none());
    }

    #[test]
    fn visible_content_bounds_include_all_visible_plate_members() {
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_plate_dataset_opened(
            "plate",
            "plate",
            vec![("m1", [0.0, 0.0]), ("m2", [300.0, 100.0])],
            [1, 1, 5, 64, 32],
            [1, 1, 1, 32, 32],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let bounds = scene.visible_content_bounds_2d().unwrap();
        assert_eq!(
            bounds,
            VisibleContentBounds2D {
                min_x: 0.0,
                min_y: 0.0,
                max_x: 332.0,
                max_y: 164.0,
                max_depth: 5,
            },
        );

        scene
            .dataset_settings
            .get_mut(&DatasetId("plate".into()))
            .unwrap()
            .visible = false;
        assert_eq!(scene.visible_content_bounds_2d(), None);
    }

    #[test]
    fn multi_member_aabb_culling() {
        // Two members side-by-side, each 256x256 in XY. Camera at origin
        // should see member at [0,0] but not the one at [10000, 0].
        let mut scene = Scene::new([512, 512]);
        let reg = test_helpers::make_plate_dataset_opened(
            "plate",
            "plate",
            vec![("m1", [0.0, 0.0]), ("m2", [10000.0, 0.0])],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 256, 256],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("plate".into());
        let plans = scene.chunk_plan_for(&ds_id).unwrap();
        // Only the member at origin should be visible
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].image_id, ImageId("m1-image".into()));
        assert!(!plans[0].needed.is_empty());
    }

    #[test]
    fn ray_pick_single_image_center() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        // Ray through viewport center should hit the single image
        let hit = scene.ray_pick(&DatasetId::from("ds1"), 400.0, 300.0);
        assert!(hit.is_some());
        let h = hit.unwrap();
        assert_eq!(h.entity_id, EntityId::from("ds1-entity"));
    }

    #[test]
    fn ray_pick_miss() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        // Ray way off screen should miss
        let hit = scene.ray_pick(&DatasetId::from("ds1"), -10000.0, -10000.0);
        assert!(hit.is_none());
    }

    #[test]
    fn ray_pick_nonexistent_dataset() {
        let scene = Scene::new([800, 600]);
        assert!(
            scene
                .ray_pick(&DatasetId::from("nope"), 400.0, 300.0)
                .is_none()
        );
    }

    // --- 3D annotation anchoring ---

    #[test]
    fn project_annotation_2d_matches_in_plane_projection() {
        // In slice mode the pin projection must be byte-for-byte the in-plane
        // projection the 2D overlay already relied on (depth ignored), so the
        // existing 2D overlay keeps working unchanged when a pin gains a z.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let id = DatasetId::from("ds1");
        let with_z = scene.project_annotation(&id, 40.0, 30.0, 7.0).unwrap();
        let without_z = scene.camera.project_to_screen([40.0, 30.0, 0.0]).unwrap();
        assert_eq!(with_z, without_z);
    }

    #[test]
    fn pick_annotation_voxel_round_trips_through_projection_in_3d() {
        // The core of the 3D path: a depth pick at a screen point, stored as a
        // voxel triple, must re-project to (essentially) that same screen point
        // — i.e. the marker lands under the cursor that dropped it. This proves
        // the drop math is the inverse of the render math (both reuse the
        // rendering transform), independent of camera angle. A cubic volume is
        // used so the viewport-center ray reliably strikes a face.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 64, 64, 64],
            [1, 1, 64, 64, 64],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        // Orbit a little so we're not in a degenerate head-on view.
        scene.apply(
            crate::command::ViewportCommand::Rotate3D {
                d_theta: 0.5,
                d_phi: 0.3,
            }
            .into(),
        );
        let id = DatasetId::from("ds1");
        let (sx, sy) = (400.0, 300.0); // viewport center → hits the cube
        let voxel = scene
            .pick_annotation_voxel(&id, sx, sy)
            .expect("center ray should hit the volume");
        let screen = scene
            .project_annotation(&id, voxel[0], voxel[1], voxel[2])
            .expect("picked point should project in front of the camera");
        assert!(
            (screen[0] - sx).abs() < 1.0 && (screen[1] - sy).abs() < 1.0,
            "re-projected pin {screen:?} should land at the pick point [{sx}, {sy}]",
        );
    }

    #[test]
    fn annotation_world_point_is_inside_volume_world_bounds() {
        // A pin at the volume's voxel center must map to a world point inside
        // the volume's world AABB — a sanity check that the voxel→world lift
        // uses the same transform as the rendered volume (so the marker can't
        // float off in space).
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1); // 256x256x10
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        let id = DatasetId::from("ds1");
        let (member, shape) = scene.annotation_member(&id).unwrap();
        let center = [shape[0] / 2.0, shape[1] / 2.0, shape[2] / 2.0];
        let world = scene.annotation_world_point(member, shape, center);
        let (fwd, _) = scene.rendering_transform(member);
        let corners = fwd.world_corners();
        let mut lo = [f64::MAX; 3];
        let mut hi = [f64::MIN; 3];
        for corner in &corners {
            for k in 0..3 {
                lo[k] = lo[k].min(corner[k]);
                hi[k] = hi[k].max(corner[k]);
            }
        }
        for k in 0..3 {
            assert!(
                world[k] >= lo[k] - 1e-6 && world[k] <= hi[k] + 1e-6,
                "axis {k}: {} not within [{}, {}]",
                world[k],
                lo[k],
                hi[k],
            );
        }
    }

    #[test]
    fn pick_annotation_voxel_misses_return_none() {
        // A ray that misses the volume yields no depth, so the caller declines
        // to drop a pin into empty space rather than anchoring it nowhere.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        let id = DatasetId::from("ds1");
        assert!(
            scene
                .pick_annotation_voxel(&id, -10_000.0, -10_000.0)
                .is_none()
        );
    }

    #[test]
    fn project_annotation_unknown_dataset_is_none_in_3d() {
        let mut scene = Scene::new([800, 600]);
        scene.set_mode_3d();
        assert!(
            scene
                .project_annotation(&DatasetId::from("nope"), 1.0, 2.0, 3.0)
                .is_none()
        );
    }

    #[test]
    fn center_on_voxel_3d_brings_an_off_center_pin_to_the_viewport_center() {
        // The 3D "jump to a mention" mechanism (issue #526): in arcball mode the
        // 2D `SetCenter` is a no-op (it only moves the slice camera), so a pin
        // off-center stays off-center. `CenterOnVoxel3D` must actually MOVE the
        // 3D projection — proving it, since happy-dom can't see the camera math:
        // project an off-center pin BEFORE and AFTER the op and assert (a) the
        // screen point moved, and (b) it lands at the viewport center, mirroring
        // how the 2D `SetCenter` centers its own camera.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 64, 64, 64],
            [1, 1, 64, 64, 64],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        // Orbit off head-on so the view is a generic 3D pose, not a degenerate
        // axis-aligned one (matches the sibling pick round-trip test).
        scene.apply(
            crate::command::ViewportCommand::Rotate3D {
                d_theta: 0.5,
                d_phi: 0.3,
            }
            .into(),
        );
        let id = DatasetId::from("ds1");
        let center = [400.0, 300.0]; // viewport center in pixels (800x600)

        // A pin near a corner of the volume — deliberately NOT the voxel center —
        // so its marker starts well away from the viewport center.
        let pin = [8.0, 8.0, 8.0];
        let before = scene
            .project_annotation(&id, pin[0], pin[1], pin[2])
            .expect("corner pin should project in front of the camera");
        let off_center = ((before[0] - center[0]).powi(2) + (before[1] - center[1]).powi(2)).sqrt();
        assert!(
            off_center > 50.0,
            "precondition: the pin should start off-center, was {before:?} ({off_center} px from center)",
        );

        scene.apply(
            crate::command::ViewportCommand::CenterOnVoxel3D {
                dataset_id: "ds1".to_string(),
                x: pin[0],
                y: pin[1],
                z: pin[2],
            }
            .into(),
        );

        let after = scene
            .project_annotation(&id, pin[0], pin[1], pin[2])
            .expect("pin should still project in front of the camera after centering");

        // (a) The op actually moved the 3D projection (the no-op bug would leave
        // `after == before`).
        let moved = ((after[0] - before[0]).powi(2) + (after[1] - before[1]).powi(2)).sqrt();
        assert!(
            moved > 1.0,
            "CenterOnVoxel3D should move the projection: before {before:?}, after {after:?}",
        );

        // (b) The pin now sits at the viewport center — setting the arcball
        // target puts the look-at axis through the pin's world point, so it
        // projects to screen center (the 3D analogue of `SetCenter`).
        assert!(
            (after[0] - center[0]).abs() < 1.0 && (after[1] - center[1]).abs() < 1.0,
            "after centering the pin {after:?} should land at the viewport center {center:?}",
        );
    }

    #[test]
    fn center_on_voxel_3d_is_a_noop_for_unknown_dataset() {
        // An unanchorable/unknown dataset yields no world point, so the camera is
        // left untouched (a stale pin id can never wedge the view). The arcball
        // target is unchanged and the same point projects to the same place.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 64, 64, 64],
            [1, 1, 64, 64, 64],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        scene.set_mode_3d();
        let id = DatasetId::from("ds1");
        let before = scene.project_annotation(&id, 8.0, 8.0, 8.0).unwrap();
        scene.apply(
            crate::command::ViewportCommand::CenterOnVoxel3D {
                dataset_id: "does-not-exist".to_string(),
                x: 8.0,
                y: 8.0,
                z: 8.0,
            }
            .into(),
        );
        let after = scene.project_annotation(&id, 8.0, 8.0, 8.0).unwrap();
        assert_eq!(before, after, "unknown dataset must not move the camera");
    }

    #[test]
    fn multi_member_both_visible_when_overlapping_view() {
        // Two adjacent members within the viewport.
        let mut scene = Scene::new([1024, 512]);
        // Pan camera to see both members
        if let Camera::Slice(ref mut v) = scene.camera {
            v.center = [256.0, 128.0];
        }
        let reg = test_helpers::make_plate_dataset_opened(
            "plate",
            "plate",
            vec![("m1", [0.0, 0.0]), ("m2", [256.0, 0.0])],
            [1, 1, 1, 256, 256],
            [1, 1, 1, 256, 256],
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let ds_id = DatasetId("plate".into());
        let plans = scene.chunk_plan_for(&ds_id).unwrap();
        let ids: Vec<&ImageId> = plans.iter().map(|p| &p.image_id).collect();
        assert!(
            ids.contains(&&ImageId("m1-image".into())),
            "m1 should be visible"
        );
        assert!(
            ids.contains(&&ImageId("m2-image".into())),
            "m2 should be visible"
        );
    }

    // --- dataset_world_bounds / fit_camera_to_dataset (slice 2) ---

    #[test]
    fn dataset_world_bounds_is_some_and_finite_for_known_id() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let (min, max) = scene
            .dataset_world_bounds("ds1")
            .expect("known dataset has bounds");
        for v in min.iter().chain(max.iter()) {
            assert!(v.is_finite(), "non-finite bound leaked: {v}");
        }
        // Properly ordered, non-degenerate in XY (256x256 footprint, isotropic).
        assert!(min[0] <= max[0] && min[1] <= max[1] && min[2] <= max[2]);
        assert!(
            max[0] > min[0] && max[1] > min[1],
            "XY extent should be > 0"
        );
    }

    #[test]
    fn dataset_world_bounds_none_for_unknown_id() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert!(scene.dataset_world_bounds("nope").is_none());
    }

    #[test]
    fn dataset_world_bounds_frames_each_dataset_not_the_union() {
        // A single image at the origin plus a 2-well plate offset along X. The
        // single dataset's box must be its OWN footprint, never the union that
        // would also include the offset plate well.
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened("a", "a", 1)).into(),
        );
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_plate_dataset_opened(
                "b",
                "b",
                vec![("b-m1", [0.0, 0.0]), ("b-m2", [256.0, 0.0])],
                [1, 1, 1, 256, 256],
                [1, 1, 1, 256, 256],
            ))
            .into(),
        );

        let (a_min, a_max) = scene.dataset_world_bounds("a").expect("a has bounds");
        let (b_min, b_max) = scene.dataset_world_bounds("b").expect("b has bounds");

        // Each frames its own dataset → different boxes.
        assert!(
            a_min != b_min || a_max != b_max,
            "per-dataset bounds must differ for differently-placed datasets"
        );
        // The plate spans two wells along X, so it is wider than the single image.
        let a_width = a_max[0] - a_min[0];
        let b_width = b_max[0] - b_min[0];
        assert!(
            b_width > a_width + 1e-9,
            "plate width {b_width} should exceed single-image width {a_width}"
        );
        // Crucially, "a" must NOT have grown to the union: its max-x stays near
        // its own footprint, well short of the offset plate's far edge.
        assert!(
            a_max[0] < b_max[0] - 1e-9,
            "dataset_world_bounds('a') leaked the union (max-x {} vs plate max-x {})",
            a_max[0],
            b_max[0]
        );
    }

    #[test]
    fn dataset_world_bounds_matches_member_world_matrix_corners() {
        // The bounds must be exactly the AABB of the SAME per-member world matrix
        // the renderer/minimap use — no second, drifting path.
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_plate_dataset_opened(
                "p",
                "p",
                vec![("p-m1", [0.0, 0.0]), ("p-m2", [256.0, 128.0])],
                [1, 1, 4, 256, 256],
                [1, 1, 4, 256, 256],
            ))
            .into(),
        );

        let mut expected = crate::framing::Aabb::empty();
        let derived = scene
            .derived
            .get(&DatasetId("p".into()))
            .expect("derived state");
        for member in &derived.members {
            let vt = VolumeTransform {
                model: scene.member_world_matrix(member),
                inv_model: [0.0; 16],
                max_physical_extent: 1.0,
            };
            for corner in vt.world_corners() {
                expected.add_point(corner);
            }
        }

        let (min, max) = scene.dataset_world_bounds("p").expect("p has bounds");
        assert_eq!(min, expected.min);
        assert_eq!(max, expected.max);
    }

    /// `member_world_matrix` is now a thin wrapper over `rendering_transform`
    /// (the single source — what is actually drawn). Assert it returns the
    /// forward `model` element-for-element, across a single dataset, an
    /// XY-offset member, and a multi-dataset scene, so the wrapper can never
    /// drift from the render path.
    #[test]
    fn member_world_matrix_equals_rendering_transform_forward_model() {
        let mut scene = Scene::new([800, 600]);
        // Config 1: a single dataset at the origin (256x256 footprint).
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened("solo", "solo", 1))
                .into(),
        );
        // Config 2 + 3: a second, multi-member dataset — one well at the origin
        // and one with a non-trivial XY offset + anisotropic footprint.
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_plate_dataset_opened(
                "plate",
                "plate",
                vec![("plate-m1", [0.0, 0.0]), ("plate-m2", [256.0, 128.0])],
                [1, 1, 4, 200, 256],
                [1, 1, 4, 200, 256],
            ))
            .into(),
        );

        let mut members_seen = 0;
        for ds in ["solo", "plate"] {
            let derived = scene
                .derived
                .get(&DatasetId(ds.into()))
                .expect("derived state");
            for member in &derived.members {
                let wrapper = scene.member_world_matrix(member);
                let canonical = scene.rendering_transform(member).0.model;
                for i in 0..16 {
                    assert!(
                        (wrapper[i] - canonical[i]).abs() < 1e-6,
                        "member_world_matrix drifted from rendering_transform at \
                         element {i}: {} vs {} (dataset {ds})",
                        wrapper[i],
                        canonical[i],
                    );
                }
                members_seen += 1;
            }
        }
        // Guard the test itself: we really exercised ≥3 member configs.
        assert!(
            members_seen >= 3,
            "expected at least 3 members across the configs, saw {members_seen}"
        );
    }

    /// The forward and inverse halves of `rendering_transform` must compose to
    /// the identity (within fp epsilon) — picking/upload run the inverse, the
    /// render runs the forward, so a broken round-trip would desync them. Check
    /// it for an offset, anisotropic member inside a multi-dataset scene (the
    /// hardest case: non-zero translation + global correction + top-align).
    #[test]
    fn rendering_transform_forward_inverse_round_trips_to_identity() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_dataset_opened("a", "a", 1)).into(),
        );
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_plate_dataset_opened(
                "b",
                "b",
                vec![("b-m1", [0.0, 0.0]), ("b-m2", [256.0, 128.0])],
                [1, 1, 4, 200, 256],
                [1, 1, 4, 200, 256],
            ))
            .into(),
        );

        // Multiply two column-major 4x4 matrices: returns a*b.
        let mul = |a: &[f32; 16], b: &[f32; 16]| -> [f32; 16] {
            let mut out = [0.0f32; 16];
            for col in 0..4 {
                for row in 0..4 {
                    let mut sum = 0.0f32;
                    for k in 0..4 {
                        sum += a[k * 4 + row] * b[col * 4 + k];
                    }
                    out[col * 4 + row] = sum;
                }
            }
            out
        };
        let identity = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];

        for ds in ["a", "b"] {
            let derived = scene
                .derived
                .get(&DatasetId(ds.into()))
                .expect("derived state");
            for member in &derived.members {
                let (fwd, inv) = scene.rendering_transform(member);
                let composed = mul(&fwd.model, &inv.inv_model);
                for i in 0..16 {
                    assert!(
                        (composed[i] - identity[i]).abs() < 1e-5,
                        "model · inv_model not identity at element {i}: {} \
                         (expected {}) for dataset {ds}",
                        composed[i],
                        identity[i],
                    );
                }
            }
        }
    }

    /// `dataset_world_bounds` is folded directly from
    /// `rendering_transform(member).0.world_corners()`. Assert it returns finite,
    /// sensible bounds that match recomputing that exact fold — the same AABB the
    /// renderer's transform yields, with no second, drifting derivation.
    #[test]
    fn dataset_world_bounds_equals_rendering_transform_corner_fold() {
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(test_helpers::make_plate_dataset_opened(
                "p",
                "p",
                vec![("p-m1", [0.0, 0.0]), ("p-m2", [256.0, 128.0])],
                [1, 1, 4, 200, 256],
                [1, 1, 4, 200, 256],
            ))
            .into(),
        );

        let mut expected = crate::framing::Aabb::empty();
        let derived = scene
            .derived
            .get(&DatasetId("p".into()))
            .expect("derived state");
        for member in &derived.members {
            if member.levels.is_empty() {
                continue;
            }
            for corner in scene.rendering_transform(member).0.world_corners() {
                expected.add_point(corner);
            }
        }

        let (min, max) = scene.dataset_world_bounds("p").expect("p has bounds");
        // Folded from the same source → identical, and finite/non-degenerate.
        assert_eq!(min, expected.min);
        assert_eq!(max, expected.max);
        for v in min.iter().chain(max.iter()) {
            assert!(v.is_finite(), "non-finite bound leaked: {v}");
        }
        assert!(min[0] <= max[0] && min[1] <= max[1] && min[2] <= max[2]);
        assert!(
            max[0] > min[0] && max[1] > min[1],
            "XY extent should be > 0"
        );
    }

    #[test]
    fn fit_camera_to_dataset_centers_slice_on_voxel_xy_midpoint() {
        // The Slice camera lives in VOXEL space (see ray_pick), so the 2D fit must
        // center on the VOXEL midpoint [W/2, H/2] — not the normalized unit-cube
        // midpoint (~0.5) that dataset_world_bounds yields for the 3D arcball.
        // Centering on ~0.5 would frame a sub-pixel speck at the origin while the
        // data sits at voxel [0..W] — the auto-fit bug this slice fixes.
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1); // 256x256 XY
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let (min2, max2) = scene
            .dataset_voxel_bounds_2d("ds1")
            .expect("known dataset has voxel bounds");
        let mid_x = (min2[0] + max2[0]) / 2.0;
        let mid_y = (min2[1] + max2[1]) / 2.0;

        assert!(scene.fit_camera_to_dataset("ds1"));
        match &scene.camera {
            Camera::Slice(s) => {
                assert!(
                    (s.center[0] - mid_x).abs() < 1e-9 && (s.center[1] - mid_y).abs() < 1e-9,
                    "2D center {:?} should be the VOXEL XY midpoint ({mid_x}, {mid_y})",
                    s.center
                );
                // Sanity: this is the voxel midpoint of a 256x256 footprint, NOT
                // the normalized ~[0.5, 0.5] the buggy path produced.
                assert!(
                    (s.center[0] - 128.0).abs() < 1e-9 && (s.center[1] - 128.0).abs() < 1e-9,
                    "2D center {:?} should be [128, 128] (256/2), not normalized ~[0.5, 0.5]",
                    s.center
                );
            }
            other => panic!("expected a Slice camera, got {other:?}"),
        }
    }

    #[test]
    fn fit_camera_to_dataset_targets_midpoint_in_3d_with_valid_clip() {
        let mut scene = Scene::new([800, 600]);
        // Put the camera in 3D arcball mode first; the fit must preserve it.
        scene.camera = Camera::new_3d([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let (min, max) = scene.dataset_world_bounds("ds1").unwrap();
        let mid = [
            (min[0] + max[0]) / 2.0,
            (min[1] + max[1]) / 2.0,
            (min[2] + max[2]) / 2.0,
        ];

        assert!(scene.fit_camera_to_dataset("ds1"));
        match &scene.camera {
            Camera::Arcball(a) => {
                for (axis, &m) in mid.iter().enumerate() {
                    assert!(
                        (a.target[axis] - m).abs() < 1e-9,
                        "arcball target[{axis}] {} != midpoint {m}",
                        a.target[axis],
                    );
                }
                assert!(
                    a.distance.is_finite() && a.distance > 0.0,
                    "distance {}",
                    a.distance
                );
                assert!(
                    a.near.is_finite() && a.far.is_finite() && 0.0 < a.near && a.near < a.far,
                    "clip range near {} far {}",
                    a.near,
                    a.far
                );
            }
            other => panic!("expected an Arcball camera, got {other:?}"),
        }
    }

    #[test]
    fn fit_camera_to_dataset_unknown_id_returns_false_and_leaves_camera_unchanged() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        let before = scene.camera.clone();
        assert!(!scene.fit_camera_to_dataset("ghost"));
        assert_eq!(
            scene.camera, before,
            "camera must be untouched on no-bounds"
        );
    }

    // --- dataset_voxel_bounds_2d / mode-aware fit (slice 2) ---

    #[test]
    fn dataset_voxel_bounds_2d_is_origin_to_voxel_extent() {
        // A single image of shape [1,1,Z,H,W] at the default origin placement
        // must yield voxel bounds [0,0]..[W,H] — exactly the AABB the slice-mode
        // ray pick / chunk culling test against (X = shape[4], Y = shape[3]).
        let mut scene = Scene::new([800, 600]);
        let (w, h) = (2048u64, 2048u64);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 16, h, w],
            [1, 1, 1, 256, 256],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let (min, max) = scene
            .dataset_voxel_bounds_2d("ds1")
            .expect("known dataset has voxel bounds");
        for v in min.iter().chain(max.iter()) {
            assert!(v.is_finite(), "non-finite voxel bound leaked: {v}");
        }
        assert!(
            min[0] <= max[0] && min[1] <= max[1],
            "bounds must be ordered"
        );
        assert_eq!(min, [0.0, 0.0], "min should be the origin placement");
        assert_eq!(
            max,
            [w as f64, h as f64],
            "max should be the level-0 X/Y voxel extent"
        );
    }

    #[test]
    fn dataset_voxel_bounds_2d_none_for_unknown_id() {
        let mut scene = Scene::new([800, 600]);
        let reg = test_helpers::make_dataset_opened("ds1", "test", 1);
        scene.apply(DocumentCommand::DatasetOpened(reg).into());
        assert!(scene.dataset_voxel_bounds_2d("nope").is_none());
    }

    #[test]
    fn fit_camera_to_dataset_2d_puts_data_on_screen_in_voxel_space() {
        // The core fix: in 2D the fit must center on the VOXEL midpoint [W/2, H/2]
        // (NOT the normalized ~[0.5, 0.5] that the 3D bounds produce) and the
        // resulting world_bounds() must CONTAIN the full voxel footprint
        // [0,0,W,H] — i.e. the data is actually visible, not a speck at the origin.
        let (vw, vh) = (1280u32, 800u32);
        let (w, h) = (2048u64, 2048u64);
        let mut scene = Scene::new([vw, vh]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 16, h, w],
            [1, 1, 1, 256, 256],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        scene.camera = Camera::new_2d([vw, vh]);
        assert!(scene.fit_camera_to_dataset("ds1"));

        match &scene.camera {
            Camera::Slice(s) => {
                assert!(
                    (s.center[0] - w as f64 / 2.0).abs() < 1e-9
                        && (s.center[1] - h as f64 / 2.0).abs() < 1e-9,
                    "2D center {:?} should be the voxel midpoint [{}, {}]",
                    s.center,
                    w as f64 / 2.0,
                    h as f64 / 2.0,
                );
                // world_bounds() = [min_x, min_y, max_x, max_y] must contain the
                // whole footprint, so the data is on-screen with margin to spare.
                let [bx0, by0, bx1, by1] = s.world_bounds();
                assert!(
                    bx0 <= 0.0 && by0 <= 0.0 && bx1 >= w as f64 && by1 >= h as f64,
                    "visible world_bounds {:?} must contain the footprint [0,0,{w},{h}]",
                    [bx0, by0, bx1, by1],
                );
            }
            other => panic!("expected a Slice camera, got {other:?}"),
        }
    }

    #[test]
    fn fit_camera_to_dataset_3d_path_is_unchanged_and_uses_normalized_bounds() {
        // The 3D dispatch must still frame the NORMALIZED unit-cube bounds via
        // dataset_world_bounds: the arcball target is the normalized midpoint
        // (~[0.5, 0.5, ..]) with a positive distance — proving the 3D path was
        // left intact while only 2D became voxel-aware.
        let (vw, vh) = (1280u32, 800u32);
        let mut scene = Scene::new([vw, vh]);
        let reg = test_helpers::make_dataset_opened_with_shape(
            "ds1",
            "test",
            1,
            [1, 1, 16, 2048, 2048],
            [1, 1, 1, 256, 256],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(reg).into());

        let (min3, max3) = scene
            .dataset_world_bounds("ds1")
            .expect("known dataset has normalized bounds");
        let mid = [
            (min3[0] + max3[0]) / 2.0,
            (min3[1] + max3[1]) / 2.0,
            (min3[2] + max3[2]) / 2.0,
        ];

        scene.camera = Camera::new_3d([vw, vh]);
        assert!(scene.fit_camera_to_dataset("ds1"));

        match &scene.camera {
            Camera::Arcball(a) => {
                for (axis, &m) in mid.iter().enumerate() {
                    assert!(
                        (a.target[axis] - m).abs() < 1e-9,
                        "arcball target[{axis}] {} should be the normalized midpoint {m}",
                        a.target[axis],
                    );
                }
                // Normalized space → the XY midpoint is ~0.5, decidedly not voxel.
                assert!(
                    a.target[0] < 2.0 && a.target[1] < 2.0,
                    "3D target {:?} should be normalized (~0.5), not voxel (~1024)",
                    a.target,
                );
                assert!(
                    a.distance.is_finite() && a.distance > 0.0,
                    "distance {} should be finite and positive",
                    a.distance,
                );
            }
            other => panic!("expected an Arcball camera, got {other:?}"),
        }
    }
}
