// TypeScript mirror of `lucida_core::saved_view::SavedView`. Kept in
// lock-step with the Rust definition; the wire format is the contract
// (see `lucida-core/src/saved_view.rs` for the canonical schema and
// `wiki/decisions/0013-url-as-app-state-for-saved-views.md` for the
// rationale).

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
  channel_blend_mode?: BlendMode;
}

export type DatasetId = string;
export type LayoutId = string;

/**
 * Capture record for the URL-as-app-state saved-views feature. Spans both
 * tiers of the document/viewport split: `datasets` + `active_layouts` are
 * the document surface; the rest mirrors `PresenceState`.
 *
 * `v` is `number` (not the `1` literal) because decoders must accept
 * payloads from future-version senders best-effort — the runtime check
 * lives in `encoder.ts::validateAndRestore`.
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
  /** Per-dataset auto-contrast preference. Client-side state (not in
   *  the WASM scene); captured + restored so manually-set contrast
   *  values aren't immediately overwritten by the recipient's
   *  intensity batcher. Optional in the wire format — empty/omitted
   *  means "use default (true) for every dataset". */
  auto_contrast?: Record<DatasetId, boolean>;
}
