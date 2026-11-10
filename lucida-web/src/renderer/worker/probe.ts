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
import { datasetModeKey } from "../poolKeys.ts";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
  PoolMode,
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
  betweenCubes,
  clipPlaneHit,
  levelZeroPosition,
  locateSample,
  marchSamples,
  marchSpan,
  pickIntensitySample,
  pickLabelSample,
  sliceHits,
  texelValue,
  type MarchSpan,
  type MarchStep,
  type MarchedValue,
  type ProbeAtlas,
  type ProbeSource,
  type SliceHit,
} from "../probe.ts";

type ProbeAtlasState = SliceAtlasState | AtlasState;

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
      return datasetId ? ctx.lookupEntityDescriptor(datasetId, "slice")?.memberByIndex[entityIndex] : undefined;
    });
    for (const hit of hits) {
      if (hit.label) probeSliceLabel(ctx, hit, samples, reads);
      else probeMember(ctx, hit.memberId, hit.uv, samples, reads, "slice");
    }
  } else if (frame?.type === "volumeRenderMultiPass") {
    for (const layer of frame.layers) {
      if (layer.isLabel) {
        probeVolumeLabel(ctx, frame, layer, msg, samples, reads);
        continue;
      }
      const member = memberOf(ctx, layer.datasetId, "volume");
      if (!member) continue;
      const invModel = member.entry.invModelMatrix;
      const face = clipPlaneHit(frame, msg.x, msg.y, invModel);
      if (face) {
        probeMember(ctx, layer.datasetId, face, samples, reads, "volume");
        continue;
      }
      const span = marchSpan(frame, msg.x, msg.y, invModel);
      if (span) marchMember(ctx, layer.datasetId, span, layer.renderMode, samples, reads);
    }
  }
  reads.submit(ctx, msg.id, samples);
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

/** A member's level sources finest first and its coarse source, each with the pool its draw binds. */
function memberSources(
  ctx: WorkerCtx,
  memberId: string,
  member: ColdMember,
  mode: "slice" | "volume",
): { levels: ProbeSource<ProbeAtlasState>[]; coarse: ProbeSource<ProbeAtlasState> | null } | null {
  const descIndex = ctx.lookupEntityDescriptor(member.datasetId, mode);
  const sources = ctx.state.currentSourcesByDatasetMode.get(datasetModeKey(member.datasetId, mode))?.get(memberId);
  if (!descIndex || !sources) return null;
  const atlases: Map<string, ProbeAtlasState> = mode === "slice" ? ctx.state.sliceAtlases : ctx.state.volumeAtlases;
  const pools = resolveMemberPools(atlases, descIndex, memberId);
  const selection = selectEntitySources(member.entry, sources);
  return {
    levels: selection.levels.map(({ source, poolIndex }) => ({
      meta: source.meta,
      atlas: pools.levels[poolIndex] ?? null,
    })),
    coarse: selection.coarse ? { meta: selection.coarse.meta, atlas: pools.coarse } : null,
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
  memberId: string,
  pos: readonly number[],
  samples: ProbeSample[],
  reads: TexelReads,
  mode: "slice" | "volume",
): void {
  const member = memberOf(ctx, memberId, mode);
  if (!member) return;
  const sources = memberSources(ctx, memberId, member, mode);
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
  memberId: string,
  span: MarchSpan,
  renderMode: VolumeLayerParams["renderMode"],
  samples: ProbeSample[],
  reads: TexelReads,
): void {
  const member = memberOf(ctx, memberId, "volume");
  if (!member) return;
  const sources = memberSources(ctx, memberId, member, "volume");
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
function probeSliceLabel(ctx: WorkerCtx, hit: SliceHit, samples: ProbeSample[], reads: TexelReads): void {
  const pool = ctx.state.labelSlicePools.get(hit.memberId);
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
  const position = levelZeroPosition(hit.uv, [1, hit.label.dataH, hit.label.dataW], "slice");
  position[2] = ctx.state.coldStateByDatasetMode.get(datasetModeKey(pool.datasetId, "slice"))?.currentZ ?? 0;
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
  msg: ProbeMessage,
  samples: ProbeSample[],
  reads: TexelReads,
): void {
  const pool = ctx.state.labelVolumePools.get(layer.datasetId);
  const model = layer.modelMatrix;
  const invModel = layer.invModelMatrix;
  if (!pool || !model || !invModel) return;
  const readable: ReadablePool = {
    texture: pool.texture,
    indirectionData: pool.indirectionData,
    slotsX: pool.slotsX,
    slotsY: pool.slotsY,
    slotsZ: pool.slotsZ,
  };
  const source: ProbeSource<ReadablePool> = {
    meta: {
      level: layer.labelChunk?.level ?? 0,
      levelDims: [pool.depth, pool.height, pool.width],
      chunkDims: [pool.chunkZ, pool.chunkY, pool.chunkX],
      gridDims: [pool.gridZ, pool.gridY, pool.gridX],
      offset: 0,
    },
    atlas: readable,
  };
  // The overlay's cube spans the label's own extent, so a position is carried
  // into its source entity's cube to count that entity's samples.
  const entry = ctx.state.coldStateByDatasetMode.get(datasetModeKey(pool.datasetId, "volume"))?.activeSet
    .find((e) => e.entityId === layer.entityId);
  const dims = entry ? levelZeroDims(entry) : null;
  const position = (pos: readonly number[]) => entry && dims
    ? levelZeroPosition(betweenCubes(pos, model, entry.invModelMatrix), dims, "volume")
    : undefined;
  const span = marchSpan(frame, msg.x, msg.y, invModel);
  if (!span) return;
  const steps = marchSamples([source], null, span, MARCH_STEPS.label);
  const sample: ProbeSample = {
    datasetId: pool.datasetId,
    entityId: layer.entityId ?? "",
    labelImageId: layer.datasetId,
    state: "none",
    along: "first",
  };
  samples.push(sample);
  const pending = readMarch(steps, reads, () => "id");
  reads.then((values) => {
    const marched = pending(values);
    settleMarch(sample, steps, marched, pickLabelSample(marched), position);
  });
}

interface ColdMember {
  datasetId: string;
  cold: ColdStateMessage;
  entry: ColdStateActiveEntry;
  channel: number;
}

/** Each active set's members by id, so a hover over a large collection is no scan. */
const membersByActiveSet = new WeakMap<ColdStateActiveEntry[], Map<string, { entry: ColdStateActiveEntry; channel: number }>>();

/** A member as the cold state of its dataset's pools of `mode` lays it out. */
function memberOf(ctx: WorkerCtx, memberId: string, mode: PoolMode): ColdMember | null {
  const datasetId = ctx.state.memberToDataset.get(memberId);
  const cold = datasetId ? ctx.state.coldStateByDatasetMode.get(datasetModeKey(datasetId, mode)) : undefined;
  if (!datasetId || !cold) return null;
  let members = membersByActiveSet.get(cold.activeSet);
  if (!members) {
    members = new Map();
    for (const entry of cold.activeSet) {
      for (const channel of cold.visibleChannels) members.set(memberIdForColdEntry(entry, channel), { entry, channel });
    }
    membersByActiveSet.set(cold.activeSet, members);
  }
  const member = members.get(memberId);
  return member ? { datasetId, cold, ...member } : null;
}
