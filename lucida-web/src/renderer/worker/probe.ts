/**
 * The pixel readout's worker half: find the texel each visible channel and
 * label overlay draws under a canvas point, copy those texels out of their
 * pools, and post their values once the copy maps.
 *
 * The handler encodes and submits the copy and returns, so the frames queued
 * behind it never wait on the read-back.
 */

import type { WorkerCtx } from "../workerContext.ts";
import { coversCanvas } from "./viewFrame.ts";
import { drawOf } from "./draws.ts";
import { labelSlicePoolKey, labelVolumePoolKey } from "../labelPools.ts";
import type { ViewDraw } from "./state.ts";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
  ProbeMessage,
  ProbeSample,
  SliceRenderMultiPassMessage,
  VolumeLayerParams,
  VolumeRenderMultiPassMessage,
} from "../workerProtocol.ts";
import type { AtlasState } from "../volume/atlas.ts";
import type { SliceAtlasState } from "../slice/atlas.ts";
import { labelCellKey } from "../slice/atlas.ts";
import type { SampleFormat } from "../dataTypeUtil.ts";
import { memberIdForColdEntry, resolveMemberPools } from "../descriptorBuffer.ts";
import { selectEntitySources } from "../entitySources.ts";
import { fromPlaneFrame } from "../slicePlane.ts";
import {
  ANY_PIXEL,
  betweenCubes,
  clipPlaneHit,
  cubePoint,
  inBounds,
  levelZeroPosition,
  locateSample,
  marchSamples,
  marchSpan,
  pickIntensitySample,
  pickLabelSample,
  pixelRay,
  screenBounds,
  cutHits, sliceHits,
  texelValue,
  type MarchSpan,
  type MarchStep,
  type MarchedValue,
  type PixelRay,
  type ProbeAtlas,
  type ProbeSource,
  type ScreenBounds,
  type SliceHit,
} from "../probe.ts";

/** A pool as one view samples it: the shared texture, read through the view's indirection. */
interface ProbeAtlasState extends ReadablePool {
  format: SampleFormat;
}

/** A pool as a probe reads it: where samples sit, and the texture that holds them. */
interface ReadablePool extends ProbeAtlas {
  texture: GPUTexture;
}

/** How a texel's bits read: as a sample in a pool's format, or as a label id. */
type TexelFormat = SampleFormat | "id";

/** Bytes each texel takes in the read-back buffer: a multiple of every pool format's texel. */
const READ_STRIDE = 4;

/** A volume march's step budget, as volume.wgsl's loops set it. */
const MARCH_STEPS = { translucent: 512, max_intensity: 256, label: 512 } as const;

type ViewFrameMessage = SliceRenderMultiPassMessage | VolumeRenderMultiPassMessage;

/**
 * The last frame of the view under the canvas point `(fx, fy)`, fractions
 * of the canvas, with the point in fractions of that view and the frame
 * read in the view's own pixels. Null when no view's last frame holds it.
 */
export function frameAt(
  frames: Iterable<ViewFrameMessage>,
  fx: number,
  fy: number,
): { frame: ViewFrameMessage; x: number; y: number } | null {
  for (const frame of frames) {
    const [rx, ry, rw, rh] = frame.rect;
    if (coversCanvas(frame.rect, frame.canvasW, frame.canvasH)) return { frame, x: fx, y: fy };
    const px = fx * frame.canvasW - rx;
    const py = fy * frame.canvasH - ry;
    if (px < 0 || py < 0 || px >= rw || py >= rh) continue;
    return { frame: { ...frame, canvasW: rw, canvasH: rh }, x: px / rw, y: py / rh };
  }
  return null;
}

export function handleProbe(ctx: WorkerCtx, probe: ProbeMessage): void {
  const samples: ProbeSample[] = [];
  const reads = new TexelReads();
  const located = frameAt(ctx.state.lastFrames.values(), probe.x, probe.y);
  const frame = located?.frame;
  const msg = { ...probe, x: located?.x ?? probe.x, y: located?.y ?? probe.y };
  if (frame?.type === "sliceRenderMultiPass") {
    const hits = sliceHits(frame, msg.x, msg.y, (poolMemberId, entityIndex) => {
      const datasetId = ctx.state.memberToDataset.get(poolMemberId);
      return datasetId ? ctx.lookupEntityDescriptor(datasetId, frame.view)?.memberByIndex[entityIndex] : undefined;
    });
    for (const hit of hits) {
      if (hit.label) probeSliceLabel(ctx, frame.view, hit, samples, reads);
      else probeMember(ctx, memberOf(ctx, hit.memberId, frame.view), hit.uv, samples, reads, "slice");
    }
    // A tilted cut samples its member's bricks, as a volume view's clip face does.
    const cuts = cutHits(frame, msg.x, msg.y, (memberId) => memberOf(ctx, memberId, frame.view)?.entry.invModelMatrix);
    for (const cut of cuts) probeMember(ctx, memberOf(ctx, cut.memberId, frame.view), cut.local, samples, reads, "volume");
  } else if (frame?.type === "volumeRenderMultiPass") {
    const layers = probedLayers(ctx, frame);
    if (probe.point) {
      for (const layer of layers) probeVolumeLayerAt(ctx, frame.view, layer, probe.point, samples, reads);
    } else {
      // A collection's frame has a layer for every tile and channel, and the
      // point is over a few of them.
      const ray = pixelRay(frame, msg.x, msg.y);
      for (const layer of layers) {
        if (inBounds(layer.bounds, ray)) probeVolumeLayer(ctx, frame, layer, ray, samples, reads);
      }
    }
  }
  reads.submit(ctx, msg.id, samples);
}

/** Read one layer of a volume frame under a pixel, as its march drew it. */
function probeVolumeLayer(
  ctx: WorkerCtx,
  frame: VolumeRenderMultiPassMessage,
  { layer, member }: ProbedLayer,
  ray: PixelRay,
  samples: ProbeSample[],
  reads: TexelReads,
): void {
  if (layer.isLabel) {
    probeVolumeLabel(ctx, frame, layer, ray, samples, reads);
    return;
  }
  if (!member) return;
  const invModel = member.entry.invModelMatrix;
  const face = clipPlaneHit(frame, ray, invModel);
  if (face) {
    probeMember(ctx, member, face, samples, reads, "volume");
    return;
  }
  const span = marchSpan(frame, ray, invModel);
  if (span) marchMember(ctx, member, span, layer.renderMode, samples, reads);
}

/**
 * The texels a probe copies out, each once however many samples read it, and
 * what completes each sample once their values are in.
 */
class TexelReads {
  private readonly reads: { texture: GPUTexture; texel: [number, number, number]; format: TexelFormat }[] = [];
  private readonly byTexture = new Map<GPUTexture, Map<number, number>>();
  private readonly finishers: ((values: readonly number[]) => void)[] = [];

  /** The index the texel's value will have in the read-back. */
  add(pool: ReadablePool, texel: [number, number, number], format: TexelFormat): number {
    let indices = this.byTexture.get(pool.texture);
    if (!indices) this.byTexture.set(pool.texture, (indices = new Map()));
    const key = (texel[2] * 0x10000 + texel[1]) * 0x10000 + texel[0];
    let index = indices.get(key);
    if (index === undefined) {
      index = this.reads.length;
      indices.set(key, index);
      this.reads.push({ texture: pool.texture, texel, format });
    }
    return index;
  }

  /** Run `finish` with the values read back, before the reply goes out. */
  then(finish: (values: readonly number[]) => void): void {
    this.finishers.push(finish);
  }

  submit(ctx: WorkerCtx, id: number, samples: ProbeSample[]): void {
    const reply = (values: readonly number[]) => {
      for (const finish of this.finishers) finish(values);
      ctx.post({ type: "probeResult", id, samples });
    };
    if (this.reads.length === 0) {
      reply([]);
      return;
    }
    const device = ctx.device;
    const buffer = device.createBuffer({
      size: this.reads.length * READ_STRIDE,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    this.reads.forEach(({ texture, texel }, i) => {
      encoder.copyTextureToBuffer(
        { texture, origin: { x: texel[0], y: texel[1], z: texel[2] } },
        { buffer, offset: i * READ_STRIDE },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      );
    });
    device.queue.submit([encoder.finish()]);
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const view = new DataView(buffer.getMappedRange());
        const values = this.reads.map(({ format }, i) => {
          if (format === "u16") return view.getUint16(i * READ_STRIDE, true);
          const bits = view.getUint32(i * READ_STRIDE, true);
          return format === "id" ? bits : texelValue(bits, format);
        });
        buffer.unmap();
        buffer.destroy();
        reply(values);
      },
      () => {
        // A lost device or a destroyed pool: the values are gone, so is the answer.
        buffer.destroy();
        ctx.post({ type: "probeResult", id, samples: [] });
      },
    );
  }
}

/**
 * A member's level sources finest first and its coarse source in `member`'s
 * view, each with the pool its draw binds, read through that view's
 * indirection.
 */
function memberSources(
  ctx: WorkerCtx,
  member: ColdMember,
): { levels: ProbeSource<ProbeAtlasState>[]; coarse: ProbeSource<ProbeAtlasState> | null } | null {
  const { draw, memberId } = member;
  const sources = draw.sources.get(memberId);
  if (!draw.descriptor || !sources) return null;
  const atlases: Map<string, SliceAtlasState | AtlasState> =
    draw.mode === "slice" ? ctx.state.sliceAtlases : ctx.state.volumeAtlases;
  const pools = resolveMemberPools(atlases, draw.descriptor, memberId, draw.view);
  const asSampled = (atlas: SliceAtlasState | AtlasState | null): ProbeAtlasState | null => {
    const view = atlas?.views.get(draw.view);
    if (!atlas || !view) return null;
    return {
      texture: atlas.texture,
      format: atlas.format,
      indirectionData: view.indirectionData,
      slotsX: atlas.slotsX,
      slotsY: atlas.slotsY,
      slotsZ: "slotsZ" in atlas ? atlas.slotsZ : undefined,
    };
  };
  const selection = selectEntitySources(member.entry, sources);
  return {
    levels: selection.levels.map(({ source, poolIndex }) => ({
      meta: source.meta,
      atlas: asSampled(pools.levels[poolIndex] ?? null),
    })),
    coarse: selection.coarse ? { meta: selection.coarse.meta, atlas: asSampled(pools.coarse) } : null,
  };
}

/** An entity's level-0 extent, `[Z, Y, X]`. */
function levelZeroDims(entry: ColdStateActiveEntry): [number, number, number] | null {
  return (entry.levels.find((l) => l.level === 0) ?? entry.levels[0])?.levelDims ?? null;
}

/**
 * Locate one member's sample at a member-local position and record it: a
 * resident one as a texel to read, a failed or missing one as it is.
 */
function probeMember(
  ctx: WorkerCtx,
  member: ColdMember | null,
  pos: readonly number[],
  samples: ProbeSample[],
  reads: TexelReads,
  mode: "slice" | "volume",
): void {
  if (!member) return;
  const sources = memberSources(ctx, member);
  const dims = levelZeroDims(member.entry);
  if (!sources || !dims) return;
  const location = locateSample(sources.levels, sources.coarse, pos, mode);
  let position = levelZeroPosition(pos, dims, mode);
  if (mode === "slice") {
    position[2] = member.cold.currentZ;
    // A side view's worker frame is across, down and the cut; the readout
    // names the image's own X, Y and Z.
    const axis = member.cold.sliceAxis;
    if (axis) position = fromPlaneFrame(position, axis);
  }
  const sample: ProbeSample = {
    datasetId: member.datasetId,
    entityId: member.entry.entityId,
    channel: member.channel,
    position,
    state: location.kind === "resident" ? "value" : location.kind,
  };
  if (location.kind !== "missing") sample.level = location.level;
  samples.push(sample);
  if (location.kind === "resident") {
    const index = reads.add(location.atlas, location.texel, location.atlas.format);
    reads.then((values) => {
      sample.value = values[index];
    });
  }
}

/**
 * March one member's ray as its frame did and record the sample its pixel is
 * drawn from: the first the pixel counts as its surface, or in MIP the
 * brightest. Which samples the march reads is known now; which one it picks
 * waits on their values.
 */
function marchMember(
  ctx: WorkerCtx,
  member: ColdMember,
  span: MarchSpan,
  renderMode: VolumeLayerParams["renderMode"],
  samples: ProbeSample[],
  reads: TexelReads,
): void {
  const sources = memberSources(ctx, member);
  const dims = levelZeroDims(member.entry);
  const window = member.entry.displayStateByChannel[member.channel];
  if (!sources || !dims || !window) return;
  const steps = marchSamples(sources.levels, sources.coarse, span, MARCH_STEPS[renderMode]);
  const sample: ProbeSample = {
    datasetId: member.datasetId,
    entityId: member.entry.entityId,
    channel: member.channel,
    state: "none",
    along: renderMode === "max_intensity" ? "brightest" : "first",
  };
  samples.push(sample);
  const pending = readMarch(steps, reads, (pool) => pool.format);
  reads.then((values) => {
    const marched = pending(values);
    const pick = pickIntensitySample(marched, window, member.cold.sampleFormat, renderMode);
    const location = settleMarch(sample, steps, marched, pick, (pos) => levelZeroPosition(pos, dims, "volume"))?.location;
    if (location && location.kind !== "missing") sample.level = location.level;
  });
}

/**
 * Queue a read for each resident sample of a march, and hand back what turns
 * the read-back into the march's values in order.
 */
function readMarch<A extends ReadablePool>(
  steps: readonly MarchStep<A>[],
  reads: TexelReads,
  format: (pool: A) => TexelFormat,
): (values: readonly number[]) => MarchedValue[] {
  const indices = steps.map(({ location }) =>
    location.kind === "resident" ? reads.add(location.atlas, location.texel, format(location.atlas)) : -1);
  return (values) => steps.map(({ location }, i) =>
    location.kind === "resident" ? values[indices[i]] : location.kind);
}

/**
 * Fill in a marched sample from the step its march picked, or say why there
 * is none. Returns the picked step.
 */
function settleMarch<A extends ProbeAtlas>(
  sample: ProbeSample,
  steps: readonly MarchStep<A>[],
  values: readonly MarchedValue[],
  pick: number,
  position: (pos: readonly number[]) => [number, number, number] | undefined,
): MarchStep<A> | undefined {
  const step = steps[pick];
  if (!step) {
    sample.state = values.includes("failed") ? "failed" : values.includes("missing") ? "missing" : "none";
    return undefined;
  }
  const value = values[pick];
  sample.position = position(step.pos);
  if (typeof value === "number") {
    sample.state = "value";
    sample.value = value;
  } else {
    sample.state = value;
  }
  return step;
}

/**
 * The sample a slice frame's label overlay draws under the point: its
 * plane-sized pool maps each chunk cell to itself, so the texel is the
 * sample, unless the cell failed. A cell never written draws nothing, so it
 * reads as not loaded rather than as background.
 */
function probeSliceLabel(ctx: WorkerCtx, view: number, hit: SliceHit, samples: ProbeSample[], reads: TexelReads): void {
  const chunk = hit.label?.chunk;
  const pool = chunk && ctx.state.labelSlicePools.get(labelSlicePoolKey(hit.memberId, chunk.t, chunk.plane, chunk.axis));
  if (!pool || !hit.label) return;
  const readable: ReadablePool = {
    texture: pool.texture,
    indirectionData: pool.indirection,
    slotsX: pool.grid.x,
    slotsY: pool.grid.y,
  };
  const source: ProbeSource<ReadablePool> = {
    meta: {
      level: 0,
      levelDims: [1, pool.height, pool.width],
      chunkDims: [1, pool.chunkY, pool.chunkX],
      gridDims: [1, pool.grid.y, pool.grid.x],
      offset: 0,
    },
    atlas: readable,
  };
  const location = locateSample([source], null, hit.uv, "slice");
  const written = location.kind !== "resident"
    || pool.planes.has(labelCellKey(Math.floor(location.texel[0] / pool.chunkX), Math.floor(location.texel[1] / pool.chunkY)));
  const planePosition = levelZeroPosition(hit.uv, [1, hit.label.dataH, hit.label.dataW], "slice");
  planePosition[2] = drawOf(ctx.state, pool.datasetId, view)?.cold.currentZ ?? 0;
  // As for an image: the readout names the source's own X, Y and Z.
  const position = fromPlaneFrame(planePosition, pool.axis);
  const sample: ProbeSample = {
    datasetId: pool.datasetId,
    entityId: hit.label.entityId ?? "",
    labelImageId: hit.memberId,
    position,
    state: location.kind === "resident" ? (written ? "value" : "missing") : location.kind,
  };
  samples.push(sample);
  if (location.kind === "resident" && written) {
    const index = reads.add(location.atlas, location.texel, "id");
    reads.then((values) => {
      sample.value = values[index];
    });
  }
}

/**
 * The label id a volume frame's label overlay draws under the point: the
 * first id along the ray that isn't background, where the overlay paints its
 * surface. With a clip plane that is the id on the cut face, or the first one
 * behind it where the face is background, so unlike a channel's sample it is
 * always marched.
 */
function probeVolumeLabel(
  ctx: WorkerCtx,
  frame: VolumeRenderMultiPassMessage,
  layer: VolumeLayerParams,
  ray: PixelRay,
  samples: ProbeSample[],
  reads: TexelReads,
): void {
  const label = labelVolumeRead(ctx, frame.view, layer);
  const span = label && marchSpan(frame, ray, label.invModel);
  if (!label || !span) return;
  const steps = marchSamples([label.source], null, span, MARCH_STEPS.label);
  const sample: ProbeSample = {
    datasetId: label.datasetId,
    entityId: layer.entityId ?? "",
    labelImageId: layer.datasetId,
    state: "none",
    along: "first",
  };
  samples.push(sample);
  const pending = readMarch(steps, reads, () => "id");
  reads.then((values) => {
    const marched = pending(values);
    settleMarch(sample, steps, marched, pickLabelSample(marched), label.position);
  });
}

/** A volume frame's label overlay as a probe reads it. */
interface LabelVolumeRead {
  datasetId: string;
  /** The overlay's pool, as the one source of its ids. */
  source: ProbeSource<ReadablePool>;
  /** World space to the overlay's cube. */
  invModel: ArrayLike<number>;
  /** A point of the overlay's cube among its source entity's level-0 samples. */
  position(pos: readonly number[]): [number, number, number] | undefined;
}

function labelVolumeRead(ctx: WorkerCtx, view: number, layer: VolumeLayerParams): LabelVolumeRead | null {
  const pool = layer.labelChunk && ctx.state.labelVolumePools.get(labelVolumePoolKey(layer.datasetId, layer.labelChunk.t));
  const model = layer.modelMatrix;
  const invModel = layer.invModelMatrix;
  if (!pool || !model || !invModel) return null;
  const source: ProbeSource<ReadablePool> = {
    meta: {
      level: layer.labelChunk?.level ?? 0,
      levelDims: [pool.depth, pool.height, pool.width],
      chunkDims: [pool.chunkZ, pool.chunkY, pool.chunkX],
      gridDims: [pool.gridZ, pool.gridY, pool.gridX],
      offset: 0,
    },
    atlas: {
      texture: pool.texture,
      indirectionData: pool.indirectionData,
      slotsX: pool.slotsX,
      slotsY: pool.slotsY,
      slotsZ: pool.slotsZ,
    },
  };
  // The overlay's cube spans the label's own extent, so a position is carried
  // into its source entity's cube to count that entity's samples.
  const entry = drawOf(ctx.state, pool.datasetId, view)?.cold.activeSet
    .find((e) => e.entityId === layer.entityId);
  const dims = entry ? levelZeroDims(entry) : null;
  const position = (pos: readonly number[]) => entry && dims
    ? levelZeroPosition(betweenCubes(pos, model, entry.invModelMatrix), dims, "volume")
    : undefined;
  return { datasetId: pool.datasetId, source, invModel, position };
}

/**
 * One layer of a volume frame read at a point of world space: each channel's
 * sample there, or the label id there, as the layer's pools hold them. A
 * layer whose cube the point misses reads nothing.
 */
function probeVolumeLayerAt(
  ctx: WorkerCtx,
  view: number,
  { layer, member }: ProbedLayer,
  point: readonly number[],
  samples: ProbeSample[],
  reads: TexelReads,
): void {
  if (!layer.isLabel) {
    const local = member && cubePoint(point, member.entry.invModelMatrix);
    if (local) probeMember(ctx, member, local, samples, reads, "volume");
    return;
  }
  const label = labelVolumeRead(ctx, view, layer);
  const local = label && cubePoint(point, label.invModel);
  if (!label || !local) return;
  const location = locateSample([label.source], null, local, "volume");
  const sample: ProbeSample = {
    datasetId: label.datasetId,
    entityId: layer.entityId ?? "",
    labelImageId: layer.datasetId,
    state: location.kind === "resident" ? "value" : location.kind,
  };
  const position = label.position(local);
  if (position) sample.position = position;
  samples.push(sample);
  if (location.kind === "resident") {
    const index = reads.add(location.atlas, location.texel, "id");
    reads.then((values) => {
      sample.value = values[index];
    });
  }
}

interface ColdMember {
  memberId: string;
  datasetId: string;
  /** The draw of the member's dataset in the probed view. */
  draw: ViewDraw;
  cold: ColdStateMessage;
  entry: ColdStateActiveEntry;
  channel: number;
}

/** Each active set's members by id, so a hover over a large collection is no scan. */
const membersByActiveSet = new WeakMap<ColdStateActiveEntry[], { draw: ViewDraw; members: Map<string, ColdMember> }>();

/** The members `draw`'s cold state lays out, by id. */
function membersOf(draw: ViewDraw): ReadonlyMap<string, ColdMember> {
  const { cold, datasetId } = draw;
  const kept = membersByActiveSet.get(cold.activeSet);
  if (kept?.draw === draw) return kept.members;
  const members = new Map<string, ColdMember>();
  for (const entry of cold.activeSet) {
    for (const channel of cold.visibleChannels) {
      const memberId = memberIdForColdEntry(entry, channel);
      members.set(memberId, { memberId, datasetId, draw, cold, entry, channel });
    }
  }
  membersByActiveSet.set(cold.activeSet, { draw, members });
  return members;
}

/** A member as `view`'s cold state for its dataset lays it out. */
function memberOf(ctx: WorkerCtx, memberId: string, view: number): ColdMember | null {
  const datasetId = ctx.state.memberToDataset.get(memberId);
  const draw = datasetId ? drawOf(ctx.state, datasetId, view) : undefined;
  return (draw && membersOf(draw).get(memberId)) ?? null;
}

/** One layer of a volume frame as its probes find it. */
interface ProbedLayer {
  layer: VolumeLayerParams;
  /** The member an intensity layer draws; null for a label overlay, or a member its view no longer lays out. */
  member: ColdMember | null;
  bounds: ScreenBounds;
}

/** A volume frame's layers as its probes find them, and the layout their members were read from. */
interface ProbedFrame {
  layers: ProbedLayer[];
  /** Each draw the members came from, with the active set it held then. */
  from: { draw: ViewDraw; activeSet: ColdStateActiveEntry[] }[];
}

/**
 * Keyed by a frame's layers, which the copy {@link frameAt} makes of a view
 * that doesn't cover the canvas shares with the message drawn.
 */
const probedFrames = new WeakMap<readonly VolumeLayerParams[], ProbedFrame>();

/**
 * A volume frame's layers with their members and screen bounds, worked out
 * at the frame's first probe and kept for the rest: a pointer moving over a
 * still view probes one frame many times. A cold state that lays the
 * members out again in between has them read afresh.
 */
function probedLayers(ctx: WorkerCtx, frame: VolumeRenderMultiPassMessage): ProbedLayer[] {
  const { view } = frame;
  const kept = probedFrames.get(frame.layers);
  if (kept?.from.every(({ draw, activeSet }) => drawOf(ctx.state, draw.datasetId, view) === draw && draw.cold.activeSet === activeSet)) {
    return kept.layers;
  }
  const draws = new Map<string, ViewDraw | undefined>();
  // An entity's channels are layers of one cube.
  const entityBounds = new Map<ColdStateActiveEntry, ScreenBounds>();
  const layers = frame.layers.map((layer): ProbedLayer => {
    if (layer.isLabel) {
      return { layer, member: null, bounds: layer.modelMatrix ? screenBounds(frame, layer.modelMatrix) : ANY_PIXEL };
    }
    const datasetId = ctx.state.memberToDataset.get(layer.datasetId);
    if (datasetId !== undefined && !draws.has(datasetId)) draws.set(datasetId, drawOf(ctx.state, datasetId, view));
    const draw = datasetId === undefined ? undefined : draws.get(datasetId);
    const member = (draw && membersOf(draw).get(layer.datasetId)) ?? null;
    if (!member) return { layer, member, bounds: ANY_PIXEL };
    let bounds = entityBounds.get(member.entry);
    if (!bounds) entityBounds.set(member.entry, (bounds = screenBounds(frame, member.entry.modelMatrix)));
    return { layer, member, bounds };
  });
  const from = [...draws.values()].flatMap((draw) => (draw ? [{ draw, activeSet: draw.cold.activeSet }] : []));
  probedFrames.set(frame.layers, { layers, from });
  return layers;
}
