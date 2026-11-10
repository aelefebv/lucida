/**
 * What each layer shows, as the WASM scene resolves it: which channels,
 * through which colormap and window, at which z and t. The renderer, the
 * planner, the minimap, explore previews, the pin-context check and the layer
 * panel all read this instead of deriving it from the settings.
 */
import type { WasmScene } from "lucida-core";
import type { BlendMode } from "./renderer/layerCompositor.ts";
import { cutAxis, type SliceCut, type SlicePlane } from "./renderer/slicePlane.ts";

/** Mirrors `lucida_core::scene::ShownChannel`. */
export interface ResolvedChannel {
  channel: number;
  colormap: string;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
  blend_mode: BlendMode;
}

/** Mirrors `lucida_core::scene::ResolvedLayer`. */
export interface ResolvedLayer {
  dataset_id: string;
  /** A hidden layer still lists the channels it would show. */
  visible: boolean;
  opacity: number;
  render_mode: "translucent" | "max_intensity";
  channel_count: number;
  solo: number | null;
  /** Ascending by channel, never empty. */
  channels: ResolvedChannel[];
  /** The scene's z slab and timepoint, clamped into this layer. */
  z_range: { start: number; end: number };
  t: number;
  z_clamped: boolean;
  t_clamped: boolean;
  /** The planes an XZ view cuts along Y and a YZ view along X, clamped into this layer. */
  y: number;
  x: number;
}

/** Where a slice view of `plane` cuts `layer`. */
export function layerCut(layer: ResolvedLayer, plane: SlicePlane): SliceCut {
  const axis = cutAxis(plane);
  const index = axis === "x" ? layer.x : axis === "y" ? layer.y : layer.z_range.start;
  return { axis, index };
}

export type ResolvedLayers = ReadonlyMap<string, ResolvedLayer>;

interface Cached {
  key: string;
  layers: ResolvedLayers;
}

const cache = new WeakMap<WasmScene, Cached>();

/** Parse `resolved_layers()`-shaped JSON into a map by dataset id, in panel order. */
export function parseResolvedLayers(json: string): ResolvedLayers {
  const map = new Map<string, ResolvedLayer>();
  try {
    for (const layer of JSON.parse(json) as ResolvedLayer[]) map.set(layer.dataset_id, layer);
  } catch {
    // An unreadable answer reads as no layers.
  }
  return map;
}

/**
 * The scene's resolved layers. Only the content, layout and selection epochs
 * can change them, so a camera move reuses the last answer.
 */
export function readResolvedLayers(scene: WasmScene): ResolvedLayers {
  const key = layerEpochKey(scene);
  const hit = cache.get(scene);
  if (hit && key !== null && hit.key === key) return hit.layers;
  const layers = parseResolvedLayers(scene.resolved_layers());
  if (key !== null) cache.set(scene, { key, layers });
  return layers;
}

function layerEpochKey(scene: WasmScene): string | null {
  try {
    const e = JSON.parse(scene.epochs()) as { content: number; layout: number; selection: number };
    return `${e.content}|${e.layout}|${e.selection}`;
  } catch {
    return null;
  }
}

/** The channel indices a layer shows, ascending. */
export function shownChannels(layer: ResolvedLayer | undefined): number[] {
  return layer ? layer.channels.map((c) => c.channel) : [0];
}
