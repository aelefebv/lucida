/**
 * Typed vocabulary for the `scene.apply_command(json)` boundary — hand-written
 * TS mirrors of the serde wire shapes of `lucida_core::command::DocumentCommand`
 * and `lucida_core::command::ViewportCommand` (snake_case `type` tags; see
 * `lucida-core/src/command.rs` for the canonical definitions), in the style of
 * `manifestTypes.ts`.
 *
 * Scope: every command the web produces as a JSON literal, plus `set_zoom`
 * (no producer authors it today — interactive 2D zoom is the relative
 * `zoom_by` — but it is kept so the 2D camera's absolute setters, `set_center`
 * and `set_zoom`, travel together). The server-originated `dataset_opened`
 * command is consumed by applying its inbound JSON verbatim. Camera ops issued
 * through dedicated typed wasm methods (`set_viewport`, `fly_set_base_speed`,
 * `fly_adjust_speed`, `adjust_clip_distance`) are deliberately absent: their
 * contracts are locked elsewhere (wire goldens / the wasm-bindgen `.d.ts`).
 *
 * The two unions are tag-disjoint by construction, mirroring the Rust enums
 * (`wiki/decisions/0001-document-vs-viewport-split.md`): a command is either
 * shared document state (sequenced + broadcast via `applyDocumentCommand`) or
 * local viewport state (`applyViewportCommand`), never both. The assertion at
 * the bottom of this file makes any future tag collision a compile error.
 *
 * Runtime lock: `commands.test.ts` round-trips one representative value of
 * every variant below through the REAL wasm `apply_command`, so a Rust-side
 * tag/field rename fails that suite even though these mirrors are hand-written.
 * The wire goldens lock producer field PRESENCE and VALUES, not key order:
 * the web suite compares parsed frames (`toStrictEqual`), and serde ignores
 * JSON key order — so reordering fields in a producer literal is safe, while
 * adding/dropping/renaming one fails the goldens.
 */

import type { LayoutSpec } from "./manifestTypes.ts";
import type {
  BlendMode,
  Colormap,
  RenderMode,
  SavedView,
} from "./savedView/types.ts";

/** Mirrors `lucida_core::scene::AnnotationKind` (serde snake_case). */
export type AnnotationKind = "point" | "line" | "box";

// ---------------------------------------------------------------------------
// Document commands — shared state; sequenced, persisted, broadcast to peers.
// Mirrors `lucida_core::command::DocumentCommand` (web-produced variants).
// ---------------------------------------------------------------------------

export interface RemoveDatasetCommand {
  type: "remove_dataset";
  id: string;
}

export interface RenameDatasetCommand {
  type: "rename_dataset";
  id: string;
  name: string;
}

export interface RegisterLayoutCommand {
  type: "register_layout";
  dataset_id: string;
  layout: LayoutSpec;
}

export interface SetActiveLayoutCommand {
  type: "set_active_layout";
  dataset_id: string;
  layout_id: string;
}

/**
 * Drop a pin. `end`/`z`/`t`/`c`/`kind`/`view` are `#[serde(default)]` on the
 * Rust side (optional on the wire); `view` must be OMITTED — not `null` — when
 * absent, so the command and its rebroadcast stay byte-identical.
 */
export interface AddAnnotationCommand {
  type: "add_annotation";
  dataset_id: string;
  id: string;
  position: [number, number];
  end?: [number, number] | null;
  z?: number;
  t?: number;
  c?: number;
  author: string;
  kind?: AnnotationKind;
  view?: SavedView;
}

export interface RemoveAnnotationCommand {
  type: "remove_annotation";
  dataset_id: string;
  id: string;
}

/**
 * Reposition a pin. `end: undefined`/`null` → rigid whole-shape translate;
 * `end: [x, y]` → reshape placing both vertices (see the Rust doc comment).
 */
export interface MoveAnnotationCommand {
  type: "move_annotation";
  dataset_id: string;
  id: string;
  position: [number, number];
  end?: [number, number] | null;
  z?: number;
}

export interface AddCommentCommand {
  type: "add_comment";
  dataset_id: string;
  annotation_id: string;
  id: string;
  author: string;
  text: string;
}

export interface RemoveCommentCommand {
  type: "remove_comment";
  dataset_id: string;
  annotation_id: string;
  id: string;
}

export interface EditCommentCommand {
  type: "edit_comment";
  dataset_id: string;
  annotation_id: string;
  id: string;
  text: string;
}

export type DocumentCommand =
  | RemoveDatasetCommand
  | RenameDatasetCommand
  | RegisterLayoutCommand
  | SetActiveLayoutCommand
  | AddAnnotationCommand
  | RemoveAnnotationCommand
  | MoveAnnotationCommand
  | AddCommentCommand
  | RemoveCommentCommand
  | EditCommentCommand;

// ---------------------------------------------------------------------------
// Viewport commands — local-only camera/view/display state; never sequenced.
// Mirrors `lucida_core::command::ViewportCommand` (web-produced variants).
// ---------------------------------------------------------------------------

/** Rust `SetMode2D` (`#[serde(rename = "set_mode_slice")]`). */
export interface SetModeSliceCommand {
  type: "set_mode_slice";
}

/** Rust `SetMode3D` (`#[serde(rename = "set_mode_arcball")]`). */
export interface SetModeArcballCommand {
  type: "set_mode_arcball";
}

export interface SetModeFlyCommand {
  type: "set_mode_fly";
}

export interface PanCommand {
  type: "pan";
  dx: number;
  dy: number;
}

export interface ZoomByCommand {
  type: "zoom_by";
  factor: number;
}

export interface SetCenterCommand {
  type: "set_center";
  x: number;
  y: number;
}

export interface SetZoomCommand {
  type: "set_zoom";
  value: number;
}

/** Rust `Rotate3D` (`#[serde(rename = "arcball_rotate")]`). */
export interface ArcballRotateCommand {
  type: "arcball_rotate";
  d_theta: number;
  d_phi: number;
}

/** Rust `Zoom3D` (`#[serde(rename = "arcball_zoom")]`). */
export interface ArcballZoomCommand {
  type: "arcball_zoom";
  delta: number;
}

/** Rust `Pan3D` (`#[serde(rename = "arcball_pan")]`). */
export interface ArcballPanCommand {
  type: "arcball_pan";
  dx: number;
  dy: number;
}

/** Rust `CenterOnVoxel3D` (`#[serde(rename = "arcball_center_on_voxel")]`). */
export interface ArcballCenterOnVoxelCommand {
  type: "arcball_center_on_voxel";
  dataset_id: string;
  x: number;
  y: number;
  z: number;
}

export interface FlyTickCommand {
  type: "fly_tick";
  dt: number;
  forward: number;
  right: number;
  up: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface SetZCommand {
  type: "set_z";
  z: number;
}

export interface SetZRangeCommand {
  type: "set_z_range";
  start: number;
  end: number;
}

export interface SetTCommand {
  type: "set_t";
  t: number;
}

export interface SetCCommand {
  type: "set_c";
  c: number;
}

export interface SetContrastCommand {
  type: "set_contrast";
  min: number;
  max: number;
}

export interface SetGammaCommand {
  type: "set_gamma";
  gamma: number;
}

export interface SetDatasetOrderCommand {
  type: "set_dataset_order";
  order: string[];
}

export interface SetDatasetVisibleCommand {
  type: "set_dataset_visible";
  dataset_id: string;
  visible: boolean;
}

export interface SetDatasetOpacityCommand {
  type: "set_dataset_opacity";
  dataset_id: string;
  opacity: number;
}

export interface SetDatasetContrastCommand {
  type: "set_dataset_contrast";
  dataset_id: string;
  min: number;
  max: number;
}

export interface SetDatasetGammaCommand {
  type: "set_dataset_gamma";
  dataset_id: string;
  gamma: number;
}

export interface SetDatasetBlendModeCommand {
  type: "set_dataset_blend_mode";
  dataset_id: string;
  blend_mode: BlendMode;
}

export interface SetDatasetRenderModeCommand {
  type: "set_dataset_render_mode";
  dataset_id: string;
  render_mode: RenderMode;
}

/** `level: null` clears the override (Rust `Option<u32>`, always present). */
export interface SetDatasetDetailLevelOverrideCommand {
  type: "set_dataset_detail_level_override";
  dataset_id: string;
  level: number | null;
}

export interface SetMultiChannelCommand {
  type: "set_multi_channel";
  enabled: boolean;
}

export interface SetChannelVisibleCommand {
  type: "set_channel_visible";
  dataset_id: string;
  channel: number;
  visible: boolean;
}

export interface SetChannelColormapCommand {
  type: "set_channel_colormap";
  dataset_id: string;
  channel: number;
  colormap: Colormap;
}

/** `name: null` clears the per-channel display-name override. */
export interface SetChannelNameCommand {
  type: "set_channel_name";
  dataset_id: string;
  channel: number;
  name: string | null;
}

export interface SetChannelContrastCommand {
  type: "set_channel_contrast";
  dataset_id: string;
  channel: number;
  min: number;
  max: number;
}

export interface SetChannelGammaCommand {
  type: "set_channel_gamma";
  dataset_id: string;
  channel: number;
  gamma: number;
}

export interface SetChannelBlendModeCommand {
  type: "set_channel_blend_mode";
  dataset_id: string;
  blend_mode: BlendMode;
}

export interface SetLabelVisibleCommand {
  type: "set_label_visible";
  dataset_id: string;
  label: number;
  visible: boolean;
}

export interface SetLabelOpacityCommand {
  type: "set_label_opacity";
  dataset_id: string;
  label: number;
  opacity: number;
}

export type ViewportCommand =
  | SetModeSliceCommand
  | SetModeArcballCommand
  | SetModeFlyCommand
  | PanCommand
  | ZoomByCommand
  | SetCenterCommand
  | SetZoomCommand
  | ArcballRotateCommand
  | ArcballZoomCommand
  | ArcballPanCommand
  | ArcballCenterOnVoxelCommand
  | FlyTickCommand
  | SetZCommand
  | SetZRangeCommand
  | SetTCommand
  | SetCCommand
  | SetContrastCommand
  | SetGammaCommand
  | SetDatasetOrderCommand
  | SetDatasetVisibleCommand
  | SetDatasetOpacityCommand
  | SetDatasetContrastCommand
  | SetDatasetGammaCommand
  | SetDatasetBlendModeCommand
  | SetDatasetRenderModeCommand
  | SetDatasetDetailLevelOverrideCommand
  | SetMultiChannelCommand
  | SetChannelVisibleCommand
  | SetChannelColormapCommand
  | SetChannelNameCommand
  | SetChannelContrastCommand
  | SetChannelGammaCommand
  | SetChannelBlendModeCommand
  | SetLabelVisibleCommand
  | SetLabelOpacityCommand;

// ---------------------------------------------------------------------------
// Compile-time disjointness lock (ADR-0001): the document and viewport tag
// sets must never intersect. If a variant is ever added to both unions, the
// intersection below stops being `never` and this line fails to compile.
// ---------------------------------------------------------------------------

type SharedCommandTags = DocumentCommand["type"] & ViewportCommand["type"];
const documentAndViewportTagsAreDisjoint: [SharedCommandTags] extends [never]
  ? true
  : never = true;
void documentAndViewportTagsAreDisjoint;
