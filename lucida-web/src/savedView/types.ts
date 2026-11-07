// TypeScript mirror of `lucida_core::saved_view::SavedView`. The wire format
// is the contract, so keep this in step with `lucida-core/src/saved_view.rs`.

export const SAVED_VIEW_VERSION = 1;

/** 2D slice camera. `serde(tag = "mode")` puts `mode: "slice"` at top level. */
export interface SliceCamera {
  mode: "slice";
  center: [number, number];
  zoom: number;
  viewport: [number, number];
}

export interface ArcballCamera {
  mode: "arcball";
  target: [number, number, number];
  theta: number;
  phi: number;
  distance: number;
  fov: number;
  viewport: [number, number];
  near: number;
  far: number;
  clip_distance?: number;
  clip_mode?: "plane" | "sphere";
}

export interface FlyCamera {
  mode: "fly";
  position: [number, number, number];
  /** Quaternion (x, y, z, w). */
  orientation: [number, number, number, number];
  fov: number;
  viewport: [number, number];
  near: number;
  far: number;
  speed_multiplier: number;
  base_speed?: number;
  clip_distance?: number;
  clip_mode?: "plane" | "sphere";
}

export type Camera = SliceCamera | ArcballCamera | FlyCamera;

export interface ZRange {
  start: number;
  end: number;
}

export interface ViewState {
  z_range: ZRange;
  t: number;
  c: number;
  multi_channel?: boolean;
}

export interface DisplayState {
  contrast_min: number;
  contrast_max: number;
  gamma: number;
}

export type Colormap =
  | "gray" | "magenta" | "green" | "cyan" | "red" | "blue" | "yellow"
  | "viridis" | "inferno" | "plasma" | "magma" | "turbo" | "hot" | "cool" | "jet";

export type BlendMode = "alpha" | "additive" | "max";
export type RenderMode = "translucent" | "max_intensity";

export interface ChannelSettings {
  visible: boolean;
  colormap: Colormap;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
  /** User display-name override. Absent means none; the UI falls back to the
   *  omero label, then `Ch {i}`. Omitted on the wire unless set, as in Rust. */
  name?: string;
}

/** Per-label overlay display state, mirroring
 *  `lucida_core::scene::LabelSettings`. */
export interface LabelSettings {
  visible: boolean;
  opacity: number;
}

export interface DatasetDisplaySettings {
  visible: boolean;
  opacity: number;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
  blend_mode: BlendMode;
  render_mode?: RenderMode;
  channel_settings?: ChannelSettings[];
  /** Positional by manifest label order. Optional: older views lack it. */
  label_settings?: LabelSettings[];
  channel_blend_mode?: BlendMode;
  detail_level_override?: number | null;
  /** The author's label names at capture time, parallel to `label_settings`.
   *  Omitted on the wire when empty. Lets a restore match per-label settings
   *  by name and occurrence when the current label list differs. */
  label_names?: string[];
}

export type DatasetId = string;
export type LayoutId = string;
export type DatasetReferenceMode = "source-url" | "workspace-dataset-id";

/**
 * What a restore may do when the view it applies names a different active
 * layout than the document currently has. The active layout is *document*
 * state, shared with every peer and persisted by the server, so who is
 * allowed to change it, and how, is not one boolean:
 *
 * - `broadcast`: apply locally and send the command. An editor restoring a
 *   view is making the change everyone agreed to see.
 * - `local`: apply to this page's scene only, silently. The chrome-free
 *   capture surface renders the layout the view asked for without recording
 *   that anyone chose it (see `captureSurface.ts`).
 * - `refuse`: skip, and warn into the apply result. A viewer without edit
 *   rights should be told the picture differs, not silently shown a lie.
 */
export type LayoutMutationMode = "broadcast" | "local" | "refuse";

/**
 * A saved view. Spans both tiers of the document/viewport split:
 * `datasets` and `active_layouts` are document state; the rest mirrors
 * `PresenceState`.
 *
 * `v` is `number`, not the `1` literal, because decoders accept payloads from
 * newer senders best-effort (see `encoder.ts::validateAndRestore`).
 */
export interface SavedView {
  v: number;
  datasets: string[];
  active_layouts: Record<DatasetId, LayoutId>;
  camera: Camera;
  view: ViewState;
  display: DisplayState;
  dataset_order: DatasetId[];
  dataset_settings: Record<DatasetId, DatasetDisplaySettings>;
  /** Per-dataset auto-contrast preference. Client-side state, captured so the
   *  recipient's intensity batcher doesn't overwrite manual contrast. Omitted
   *  entries mean true. */
  auto_contrast?: Record<DatasetId, boolean>;
}
