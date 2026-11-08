/**
 * The pixel readout's wording: the samples a probe found under the pointer,
 * grouped by entity, with their position, level, and values in data units.
 */

import type { ProbeSample } from "../renderer/workerProtocol.ts";
import { drawnAtFloat32Precision } from "../renderer/dataTypeUtil.ts";

/** What the readout needs to know about the datasets its samples come from. */
export interface ReadoutContext {
  datasetName(datasetId: string): string;
  /** The tile's name in a collection, or null for a single image. */
  entityName(datasetId: string, entityId: string): string | null;
  dataType(datasetId: string): string;
  /** Level-0 depth, so a flat image's position leaves Z out. */
  depth(datasetId: string): number;
  channel(datasetId: string, channel: number): { name: string; colormap: string };
}

export interface ReadoutRow {
  key: string;
  name: string;
  colormap: string;
  value: string;
  /** Set only when the block's rows come from different levels. */
  level: string | null;
  /** Nothing resident or the chunk failed: no value to read. */
  absent: boolean;
}

export interface ReadoutBlock {
  key: string;
  /** Shown when the readout spans entities, or the entity is a collection tile. */
  title: string | null;
  /** `x`, `y` as 0-based sample indices; `Z` as people count it, from 1. */
  position: { label: string; value: string }[];
  /** The level every row came from, when they share one. */
  level: string | null;
  rows: ReadoutRow[];
}

/** Group a probe's samples into one block per entity, in the order they came. */
export function readoutBlocks(samples: readonly ProbeSample[], context: ReadoutContext): ReadoutBlock[] {
  const byEntity = new Map<string, ProbeSample[]>();
  for (const sample of samples) {
    const key = `${sample.datasetId}\u0000${sample.entityId}`;
    const group = byEntity.get(key);
    if (group) group.push(sample);
    else byEntity.set(key, [sample]);
  }
  const blocks: ReadoutBlock[] = [];
  for (const [key, group] of byEntity) {
    const { datasetId, entityId, position } = group[0];
    const ordered = [...group].sort((a, b) => a.channel - b.channel);
    const levels = new Set(ordered.flatMap((s) => (s.level === undefined ? [] : [s.level])));
    const shared = levels.size === 1 ? [...levels][0] : null;
    const tile = context.entityName(datasetId, entityId);
    const name = context.datasetName(datasetId);
    const [x, y, z] = position;
    const axes = [
      { label: "x", value: String(x) },
      { label: "y", value: String(y) },
    ];
    if (context.depth(datasetId) > 1) axes.push({ label: "Z", value: String(z + 1) });
    blocks.push({
      key,
      title: tile ? `${name} · ${tile}` : byEntity.size > 1 ? name : null,
      position: axes,
      level: shared === null ? null : `level ${shared}`,
      rows: ordered.map((sample) => {
        const channel = context.channel(datasetId, sample.channel);
        return {
          key: `${key}\u0000${sample.channel}`,
          name: channel.name,
          colormap: channel.colormap,
          value: sampleText(sample, context.dataType(datasetId)),
          level: shared === null && sample.level !== undefined ? `level ${sample.level}` : null,
          absent: sample.state !== "value",
        };
      }),
    });
  }
  return blocks;
}

function sampleText(sample: ProbeSample, dataType: string): string {
  if (sample.state === "missing") return "not loaded";
  if (sample.state === "failed") return "unavailable";
  return formatSampleValue(sample.value ?? Number.NaN, dataType);
}

/**
 * A sample as text, in its data type's terms. A value the viewer holds at
 * float32 precision when its type holds more is marked `≈`, since the digits
 * shown may not be the digits stored.
 */
export function formatSampleValue(value: number, dataType: string): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "-∞";
  const type = dataType.toLowerCase();
  const integer = INTEGER_TYPES.has(type);
  // Below 2^24 a float32 holds every integer, so an integer sample there is exact.
  const exact = !drawnAtFloat32Precision(type) || (integer && Math.abs(value) < 2 ** 24);
  const text = integer ? integerText(value) : shortestFloat32Text(value);
  return exact ? text : `≈${text}`;
}

const INTEGER_TYPES = new Set(["uint8", "uint16", "uint32", "uint64", "int8", "int16", "int32", "int64", "bool"]);

/** Past 15 digits an integer reads better, and no less truly, in exponent form. */
function integerText(value: number): string {
  return Math.abs(value) < 1e15 ? String(value) : value.toPrecision(7);
}

/** The fewest significant digits that read back as the same float32. */
function shortestFloat32Text(value: number): string {
  const single = Math.fround(value);
  for (let digits = 1; digits <= 9; digits++) {
    const shortest = Number(single.toPrecision(digits));
    if (Math.fround(shortest) === single) return String(shortest);
  }
  return String(single);
}
