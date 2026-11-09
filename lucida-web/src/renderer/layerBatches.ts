/**
 * Group layers drawn one pass and composite each into batches drawn one pass
 * and composite per batch, with the same pixels.
 *
 * A layer draws only inside its rect and composites as nothing outside it,
 * and every blend mode leaves the canvas unchanged where a layer is
 * transparent. So layers whose rects do not meet can share one offscreen
 * target and one composite, in any order between them. Layers that do meet
 * keep their order: a layer goes in a batch after every earlier layer it
 * overlaps. The depth a layer writes follows the same order, so the last
 * layer to cover a pixel still sets its depth.
 */

import type { BlendMode } from "./layerCompositor.ts";

/** A device-pixel rect `[x, y, width, height]`. */
export type PixelRect = readonly [number, number, number, number];

export interface BatchLayer {
  /** Where the layer draws; the whole target when null. */
  rect: PixelRect | null | undefined;
  blendMode: BlendMode;
  /** Drawn in a batch of its own, after every layer before it and before every layer after. */
  alone?: boolean;
}

export interface LayerBatch {
  /** Indices into the layers, in their order. */
  layers: number[];
  blendMode: BlendMode;
  alone: boolean;
}

/** The overlap search buckets rects into at most this many cells a side. */
const GRID_CELLS = 64;

/** Batches in draw order. Each holds layers of one blend mode whose rects do not meet. */
export function batchLayers(layers: readonly BatchLayer[], width: number, height: number): LayerBatch[] {
  const cellW = Math.max(1, Math.ceil(width / GRID_CELLS));
  const cellH = Math.max(1, Math.ceil(height / GRID_CELLS));
  const cols = Math.max(1, Math.ceil(width / cellW));
  const rows = Math.max(1, Math.ceil(height / cellH));
  const cells: (number[] | undefined)[] = new Array(cols * rows);
  const levels = new Int32Array(layers.length);
  // Every layer after one drawn alone or over the whole target goes above it.
  let floor = 0;
  let top = -1;

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const rect = layer.rect;
    if (layer.alone || !rect || coversTarget(rect, width, height)) {
      levels[i] = top + 1;
      top = levels[i];
      floor = top + 1;
      continue;
    }
    const [x, y, w, h] = rect;
    const c0 = clampCell(Math.floor(x / cellW), cols);
    const c1 = clampCell(Math.floor((x + w - 1) / cellW), cols);
    const r0 = clampCell(Math.floor(y / cellH), rows);
    const r1 = clampCell(Math.floor((y + h - 1) / cellH), rows);
    let level = floor;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const held = cells[r * cols + c];
        if (!held) continue;
        for (const j of held) {
          if (levels[j] >= level && overlaps(layers[j].rect!, rect)) level = levels[j] + 1;
        }
      }
    }
    levels[i] = level;
    if (level > top) top = level;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const at = r * cols + c;
        (cells[at] ??= []).push(i);
      }
    }
  }

  const byKey = new Map<string, LayerBatch & { level: number }>();
  for (let i = 0; i < layers.length; i++) {
    const key = `${levels[i]}|${layers[i].blendMode}`;
    let batch = byKey.get(key);
    if (!batch) {
      batch = { layers: [], blendMode: layers[i].blendMode, alone: layers[i].alone === true, level: levels[i] };
      byKey.set(key, batch);
    }
    batch.layers.push(i);
  }
  return [...byKey.values()]
    .sort((a, b) => a.level - b.level || a.layers[0] - b.layers[0])
    .map(({ layers: members, blendMode, alone }) => ({ layers: members, blendMode, alone }));
}

function clampCell(cell: number, count: number): number {
  return Math.min(count - 1, Math.max(0, cell));
}

function coversTarget([x, y, w, h]: PixelRect, width: number, height: number): boolean {
  return x <= 0 && y <= 0 && x + w >= width && y + h >= height;
}

function overlaps(a: PixelRect, b: PixelRect): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}
