// TypeScript mirror of `lucida_core::saved_view::SavedView`. The wire format
// is the contract, so keep this in step with `lucida-core/src/saved_view.rs`.
import type { SlicePlane } from "../renderer/slicePlane.ts";
import type { Comparison } from "../comparison.ts";
import type { LinkMode, LinkProperty, ViewLayoutName } from "../commands.ts";
import type { LinkBasis } from "../viewLinks.ts";

/** Version 2 moved solo onto each layer, and version 3 made axis positions
 *  places; see `SAVED_VIEW_VERSION` in Rust. */
export const SAVED_VIEW_VERSION = 3;

/** What chose a camera's pose: a fit of everything visible, which a new
 *  canvas fits again, or a stand-in nothing chose, which is never persisted. */
export type CameraFraming = "framed" | "unframed";

/** 2D slice camera. `serde(tag = "mode")` puts `mode: "slice"` at top level. */
export interface SliceCamera {
  mode: "slice";
  center: [number, number];
  zoom: number;
  viewport: [number, number];
  /** Absent when someone placed the view. See `Framing` in
   *  `lucida-core/src/camera.rs`. */
  framing?: CameraFraming;
  /** The plane the view cuts. Absent for XY, which every older view was. */
  plane?: SlicePlane;
  /** The plane drawn with its axes swapped on screen, as four-up's YZ view
   *  is. Absent when not. */
  transposed?: boolean;
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
  /** Absent when someone placed the view. See `Framing` in
   *  `lucida-core/src/camera.rs`. */
  framing?: CameraFraming;
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
  /** Absent when someone placed the view. See `Framing` in
   *  `lucida-core/src/camera.rs`. */
  framing?: CameraFraming;
}

export type Camera = SliceCamera | ArcballCamera | FlyCamera;

/** The spaces a camera's numbers are in, as the scene reports them
 *  (`WasmScene.camera_space`). The web only carries it from a capture to a
 *  restore; the scene reads it. See `CameraSpace` in
 *  `lucida-core/src/placement.rs`. */
export interface CameraSpace {
  frame: {
    spacing: [number, number, number];
    origin: [number, number, number];
    meters?: [number, number, number];
  };
  world: { extent: number; top: number };
}

/** Where a person put a dataset by hand, on top of where its declared frame
 *  places it: `scale` multiplies its declared sample size and `translation`
 *  moves it, `[x, y, z]` in its own declared units. `rotation` is a unit
 *  quaternion `[x, y, z, w]`, the identity for now. See `UserTransform` in
 *  `lucida-core/src/placement.rs`. */
export interface UserTransform {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

/** Whether a client may persist `view`. A stand-in camera, one nothing has
 *  fitted or placed yet, would restore as a pose nobody chose. */
export function isPersistable(view: SavedView): boolean {
  return view.camera.framing !== "unframed";
}

export interface ZRange {
  start: number;
  end: number;
}

/**
 * Where a view stands: places in the scene frame along Z, Y and X, which every
 * layer reads its own plane at, and a timepoint. An absent place reads as the
 * first position of the view's grid.
 */
export interface ViewState {
  /** The places along Z an XY view cuts: one grid position, or a slab. */
  z?: ZRange;
  t: number;
  /** The place an XZ view cuts along Y, absent until one first opened. */
  y?: number;
  /** The place a YZ view cuts along X, absent until one first opened. */
  x?: number;
  /** The Z slab of a view recorded before positions were places, as plane
   *  numbers. Present only on such a view; the scene places it when the view
   *  is imported. */
  z_range?: ZRange;
  /** The scene-wide channel of a view recorded before solo was per layer.
   *  Present only on such a view; the scene decodes it into each layer's
   *  `solo` when the view is imported. */
  c?: number;
  /** The scene-wide composite flag of such a view, with `c`. */
  multi_channel?: boolean;
}

/** One view of a layout. See `ViewRecord` in
 *  `lucida-core/src/scene/views_record.rs`. */
export interface ViewRecord {
  /** Its 2D or 3D mode, slice plane and transposed flag are its camera's. */
  camera: Camera;
  axes: ViewState;
  /** Every dataset, or these alone. */
  datasets: "all" | { only: DatasetId[] };
  comparison?: Comparison;
}

/** How two views link: each property's mode, for the pair of datasets they
 *  linked by, in the basis that pair compares in. */
export interface LinksRecord {
  datasets: [DatasetId, DatasetId];
  basis: LinkBasis;
  /** A property left out is off. */
  modes: Partial<Record<LinkProperty, LinkMode>>;
}

/** Every view of a layout, as `WasmScene.export_views` writes it. See
 *  `ViewsRecord` in `lucida-core/src/scene/views_record.rs`. */
export interface ViewsRecord {
  layout: ViewLayoutName;
  /** Which of `views` commands steer. */
  active: number;
  /** Which of `views` is shown alone, if one is. */
  maximized?: number;
  views: ViewRecord[];
  links?: LinksRecord;
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
  /** The channel the layer shows alone; omitted for its composite. */
  solo?: number | null;
}

export type DatasetId = string;
export type LayoutId = string;
export type DatasetReferenceMode = "source-url" | "workspace-dataset-id";

/**
 * What a restore may do when the view it applies names a different active
 * layout, or places a dataset by hand differently, than the document
 * currently has. Both are *document* state, shared with every peer and
 * persisted by the server, so who is allowed to change them, and how, is not
 * one boolean:
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
 * newer senders best-effort (see `encoder.ts::decode`).
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
  /** The spaces `camera` was saved in. A restore hands it to the scene with
   *  the camera, which carries the camera into its own spaces, so the view
   *  shows its region whichever dataset the document holds first. Absent on
   *  views saved before it existed, whose cameras read in the restoring
   *  scene's spaces. Last, as in Rust, so a pin's view rebroadcasts byte for
   *  byte. */
  camera_space?: CameraSpace;
  /** Where datasets sat by hand when it was saved; a dataset it names and
   *  this leaves out sat where it declares. Absent, the view records no
   *  placement and a restore leaves the document's. After `camera_space`, as
   *  in Rust. */
  user_transforms?: Record<DatasetId, UserTransform>;
  /** Every view and how they link. `camera` and `view` are the active
   *  view's, which a restore gives it last. Absent, the view is one view of
   *  every dataset. Last, as in Rust. */
  views?: ViewsRecord;
}
