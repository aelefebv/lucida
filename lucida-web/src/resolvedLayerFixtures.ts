/** Resolved-layer values for tests, shaped as `resolved_layers()` returns them. */
import type { ResolvedChannel, ResolvedLayer, ResolvedLayers } from "./resolvedLayers.ts";

/** A shown channel in gray over the full u16 window, additively blended. */
export function shownChannel(channel: number, over: Partial<ResolvedChannel> = {}): ResolvedChannel {
  return {
    channel,
    colormap: "gray",
    contrast_min: 0,
    contrast_max: 65535,
    gamma: 1,
    blend_mode: "additive",
    ...over,
  };
}

/** A visible layer showing `channels` (default channel 0) at z 0 and t 0. */
export function resolvedLayer(
  datasetId: string,
  channels: Array<number | ResolvedChannel> = [0],
  over: Partial<ResolvedLayer> = {},
): ResolvedLayer {
  const shown = channels.map((c) => (typeof c === "number" ? shownChannel(c) : c));
  return {
    dataset_id: datasetId,
    visible: true,
    opacity: 1,
    render_mode: "translucent",
    channel_count: Math.max(1, ...shown.map((c) => c.channel + 1)),
    solo: null,
    channels: shown,
    z_range: { start: 0, end: 1 },
    t: 0,
    z_clamped: false,
    t_clamped: false,
    y: 0,
    x: 0,
    ...over,
  };
}

interface FixtureSettings {
  visible: boolean;
  opacity: number;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
  channel_settings?: { visible: boolean; colormap: string; contrast_min: number; contrast_max: number; gamma: number }[];
}

/**
 * `resolved_layers()` for a mock scene holding `settings`, resolved as the
 * core does for the cases tests build: each visible listed channel through its
 * own window, or channel 0 through the layer's when none is listed.
 */
export function resolvedLayersJson(
  order: readonly string[],
  settings: Record<string, unknown>,
  at: { t: number; z: number },
): string {
  return JSON.stringify(order.map((id) => {
    const s = settings[id] as FixtureSettings;
    const listed = s.channel_settings ?? [];
    const shown = listed.length > 0
      ? listed.flatMap((ch, channel) => (ch.visible ? [{ ...ch, channel }] : []))
      : [{ channel: 0, colormap: "gray", contrast_min: s.contrast_min, contrast_max: s.contrast_max, gamma: s.gamma }];
    return resolvedLayer(id, shown.map((ch) => shownChannel(ch.channel, {
      colormap: ch.colormap,
      contrast_min: ch.contrast_min,
      contrast_max: ch.contrast_max,
      gamma: ch.gamma,
    })), {
      visible: s.visible,
      opacity: s.opacity,
      t: at.t,
      z_range: { start: at.z, end: at.z + 1 },
    });
  }));
}

/** A map of layers by dataset id, in the order given. */
export function resolvedLayers(...layers: ResolvedLayer[]): ResolvedLayers {
  return new Map(layers.map((l) => [l.dataset_id, l]));
}
