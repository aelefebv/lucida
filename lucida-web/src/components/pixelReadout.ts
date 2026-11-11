/**
 * The pixel readout's wording: the samples a probe found under the pointer,
 * grouped by entity, with their position, level, and values in data units.
 */

import type { ProbeSample } from "../renderer/workerProtocol.ts";
import { drawnAtFloat32Precision } from "../renderer/dataTypeUtil.ts";
import type { SpatialAxis } from "../renderer/slicePlane.ts";

/** What the readout needs to know about the datasets its samples come from. */
export interface ReadoutContext {
  datasetName(datasetId: string): string;
  /** The tile's name in a collection, or null for a single image. */
  entityName(datasetId: string, entityId: string): string | null;
  dataType(datasetId: string): string;
  /** Level-0 depth, so a flat image's position leaves Z out. */
  depth(datasetId: string): number;
  /**
   * The axis the view stands at a position on: the slice view's cut, and Z
   * in the volume view. Absent: Z.
   */
  cutAxis?(): SpatialAxis;
  channel(datasetId: string, channel: number): { name: string; colormap: string };
  /** A label overlay by its label image id, or null when the manifest has none by that id. */
  label(datasetId: string, labelImageId: string): ReadoutLabel | null;
}

/** What the readout shows of a label overlay. */
export interface ReadoutLabel {
  name: string;
  /** The name the label's property table gives an id, or null. */
  idName(id: number): string | null;
  /** The CSS color the overlay draws an id in. */
  color(id: number): string;
}

export interface ReadoutRow {
  key: string;
  name: string;
  /** The channel's colormap; absent on a label row, which shows `color`. */
  colormap?: string;
  /** The color a label row's id draws in. */
  color?: string;
  value: string;
  /** The name a label table gives the row's id. */
  detail: string | null;
  /** Set only when the block's rows come from different levels. */
  level: string | null;
  /** Set only when the block's rows lie at different positions. */
  position: string | null;
  /** Nothing resident, the chunk failed, or a 3D ray drew nothing: no value to read. */
  absent: boolean;
}

export interface ReadoutBlock {
  key: string;
  /** Shown when the readout spans entities, or the entity is a collection tile. */
  title: string | null;
  /**
   * The position every row lies at, when they share one: `x`, `y` as 0-based
   * sample indices, `Z` as people count it, from 1.
   */
  position: { label: string; value: string }[];
  /** How a 3D march chose the rows' samples, where it did. */
  note: string | null;
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
    const { datasetId, entityId } = group[0];
    // Channels in channel order, then label overlays in the order they draw.
    const channels = group.filter((s) => s.channel !== undefined).sort((a, b) => a.channel! - b.channel!);
    const labels = group.filter((s) => s.channel === undefined);
    const ordered = [...channels, ...labels];
    const levels = new Set(channels.flatMap((s) => (s.level === undefined ? [] : [s.level])));
    const sharedLevel = levels.size === 1 ? [...levels][0] : null;
    const depth = context.depth(datasetId);
    const cut = context.cutAxis?.() ?? "z";
    const placed = ordered.flatMap((s) => (s.position ? [positionAxes(s.position, depth, cut)] : []));
    const sharedPosition = placed.length > 0 && placed.every((p) => sameAxes(p, placed[0])) ? placed[0] : null;
    const tile = context.entityName(datasetId, entityId);
    const name = context.datasetName(datasetId);
    const rows: ReadoutRow[] = [];
    for (const sample of ordered) {
      const position = sample.position && !sharedPosition
        ? positionAxes(sample.position, depth, cut).map((a) => `${a.label} ${a.value}`).join(" ")
        : null;
      const rowKey = `${key}\u0000${sample.labelImageId ?? sample.channel}`;
      if (sample.channel !== undefined) {
        const channel = context.channel(datasetId, sample.channel);
        rows.push({
          key: rowKey,
          name: channel.name,
          colormap: channel.colormap,
          value: sampleText(sample, context.dataType(datasetId)),
          detail: null,
          level: sharedLevel === null && sample.level !== undefined ? `level ${sample.level}` : null,
          position,
          absent: sample.state !== "value",
        });
        continue;
      }
      const label = sample.labelImageId ? context.label(datasetId, sample.labelImageId) : null;
      if (!label) continue;
      const id = sample.state === "value" ? sample.value : undefined;
      rows.push({
        key: rowKey,
        name: label.name,
        color: id === undefined ? undefined : label.color(id),
        // Label ids are held as exact 32-bit integers, never as floats.
        value: id === undefined ? sampleText(sample, "uint32") : String(id),
        detail: id === undefined ? null : label.idName(id),
        level: null,
        position,
        absent: id === undefined,
      });
    }
    if (rows.length === 0) continue;
    blocks.push({
      key,
      title: tile ? `${name} · ${tile}` : byEntity.size > 1 ? name : null,
      position: sharedPosition ?? [],
      note: marchNote(channels, labels),
      level: sharedLevel === null ? null : `level ${sharedLevel}`,
      rows,
    });
  }
  return blocks;
}

/**
 * A sample's place: the axes on screen as sample coordinates from 0, and the
 * axis the view stands at a position on as the layer's own plane there,
 * counted from 1. The scrubber counts positions of a grid every layer shares,
 * so a layer placed or spaced apart from the grid reads its own number here.
 */
function positionAxes(
  [x, y, z]: readonly number[],
  depth: number,
  cut: SpatialAxis = "z",
): { label: string; value: string }[] {
  const axis = (name: SpatialAxis, index: number) =>
    name === cut ? { label: name.toUpperCase(), value: String(index + 1) } : { label: name, value: String(index) };
  const axes = [axis("x", x), axis("y", y)];
  if (depth > 1) axes.push(axis("z", z));
  return axes;
}

function sameAxes(a: readonly { value: string }[], b: readonly { value: string }[]): boolean {
  return a.length === b.length && a.every((axis, i) => axis.value === b[i].value);
}

/**
 * What a block's 3D march read, in words. A label overlay is always marched to
 * its first id, while a channel is marched only without a clip plane cutting
 * the entity, and to its brightest sample in MIP.
 */
function marchNote(channels: readonly ProbeSample[], labels: readonly ProbeSample[]): string | null {
  const channelPick = channels.find((s) => s.along)?.along;
  const labelMarched = labels.some((s) => s.along);
  if (channelPick === "brightest") {
    return labelMarched ? "Brightest sample along the ray, first label" : "Brightest sample along the ray";
  }
  if (channelPick === "first") return "First sample drawn along the ray";
  return labelMarched ? "First label along the ray" : null;
}

function sampleText(sample: ProbeSample, dataType: string): string {
  if (sample.state === "missing") return "not loaded";
  if (sample.state === "failed") return "unavailable";
  if (sample.state === "none") return "nothing drawn";
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
export function shortestFloat32Text(value: number): string {
  const single = Math.fround(value);
  for (let digits = 1; digits <= 9; digits++) {
    const shortest = Number(single.toPrecision(digits));
    if (Math.fround(shortest) === single) return String(shortest);
  }
  return String(single);
}
