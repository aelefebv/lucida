/**
 * The pixel readout's worker half: find the texel each visible channel draws
 * under a canvas point, copy those texels out of their pools, and post their
 * values once the copy maps.
 *
 * The handler encodes and submits the copy and returns, so the frames queued
 * behind it never wait on the read-back.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
  ProbeMessage,
  ProbeSample,
} from "../workerProtocol.ts";
import type { AtlasState } from "../volume/atlas.ts";
import type { SliceAtlasState } from "../slice/atlas.ts";
import { memberIdForColdEntry, resolveMemberPools } from "../descriptorBuffer.ts";
import { selectEntitySources } from "../entitySources.ts";
import {
  clipPlaneHit,
  levelZeroPosition,
  locateSample,
  sliceHits,
  texelValue,
  type ProbeSource,
} from "../probe.ts";

type ProbeAtlasState = SliceAtlasState | AtlasState;

/** One texel to copy out, and the sample its value completes. */
interface TexelRead {
  sample: ProbeSample;
  atlas: ProbeAtlasState;
  texel: [number, number, number];
}

/** Bytes each texel takes in the read-back buffer: a multiple of every pool format's texel. */
const READ_STRIDE = 4;

export function handleProbe(ctx: WorkerCtx, msg: ProbeMessage): void {
  const samples: ProbeSample[] = [];
  const reads: TexelRead[] = [];
  const frame = ctx.state.lastFrame;
  if (frame?.type === "sliceRenderMultiPass") {
    const hits = sliceHits(frame, msg.x, msg.y, (poolMemberId, entityIndex) => {
      const datasetId = ctx.state.memberToDataset.get(poolMemberId);
      return datasetId ? ctx.lookupEntityDescriptor(datasetId)?.memberByIndex[entityIndex] : undefined;
    });
    for (const hit of hits) probeMember(ctx, hit.memberId, hit.uv, "slice", samples, reads);
  } else if (frame?.type === "volumeRenderMultiPass") {
    for (const layer of frame.layers) {
      if (layer.isLabel) continue;
      const member = memberOf(ctx, layer.datasetId);
      if (!member) continue;
      const pos = clipPlaneHit(frame, msg.x, msg.y, member.entry.invModelMatrix);
      if (pos) probeMember(ctx, layer.datasetId, pos, "volume", samples, reads);
    }
  }

  if (reads.length === 0) {
    ctx.post({ type: "probeResult", id: msg.id, samples });
    return;
  }
  const device = ctx.device;
  const buffer = device.createBuffer({
    size: reads.length * READ_STRIDE,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  reads.forEach(({ atlas, texel }, i) => {
    encoder.copyTextureToBuffer(
      { texture: atlas.texture, origin: { x: texel[0], y: texel[1], z: texel[2] } },
      { buffer, offset: i * READ_STRIDE },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
  });
  device.queue.submit([encoder.finish()]);
  buffer.mapAsync(GPUMapMode.READ).then(
    () => {
      const view = new DataView(buffer.getMappedRange());
      reads.forEach(({ sample, atlas }, i) => {
        const bits = atlas.format === "u16"
          ? view.getUint16(i * READ_STRIDE, true)
          : view.getUint32(i * READ_STRIDE, true);
        sample.value = texelValue(bits, atlas.format);
      });
      buffer.unmap();
      buffer.destroy();
      ctx.post({ type: "probeResult", id: msg.id, samples });
    },
    () => {
      // A lost device or a destroyed pool: the values are gone, so is the answer.
      buffer.destroy();
      ctx.post({ type: "probeResult", id: msg.id, samples: [] });
    },
  );
}

/**
 * Locate one member's sample at a member-local position and record it: a
 * resident one as a texel to read, a failed or missing one as it is.
 */
function probeMember(
  ctx: WorkerCtx,
  memberId: string,
  pos: readonly number[],
  mode: "slice" | "volume",
  samples: ProbeSample[],
  reads: TexelRead[],
): void {
  const member = memberOf(ctx, memberId);
  if (!member) return;
  const { datasetId, entry, channel, cold } = member;
  const descIndex = ctx.lookupEntityDescriptor(datasetId);
  const sources = ctx.state.currentSourcesByDataset.get(datasetId)?.get(memberId);
  if (!descIndex || !sources) return;
  const atlases: Map<string, ProbeAtlasState> = mode === "slice" ? ctx.state.sliceAtlases : ctx.state.volumeAtlases;
  const pools = resolveMemberPools(atlases, descIndex, memberId);
  const selection = selectEntitySources(entry, sources);
  const levels: ProbeSource<ProbeAtlasState>[] = selection.levels.map(({ source, poolIndex }) => ({
    meta: source.meta,
    atlas: pools.levels[poolIndex] ?? null,
  }));
  const coarse = selection.coarse ? { meta: selection.coarse.meta, atlas: pools.coarse } : null;
  const location = locateSample(levels, coarse, pos, mode);

  const levelZero = entry.levels.find((l) => l.level === 0) ?? entry.levels[0];
  if (!levelZero) return;
  const position = levelZeroPosition(pos, levelZero.levelDims, mode);
  if (mode === "slice") position[2] = cold.currentZ;
  const sample: ProbeSample = {
    datasetId,
    entityId: entry.entityId,
    channel,
    position,
    state: location.kind === "resident" ? "value" : location.kind,
  };
  if (location.kind !== "missing") sample.level = location.level;
  samples.push(sample);
  if (location.kind === "resident") reads.push({ sample, atlas: location.atlas, texel: location.texel });
}

interface ColdMember {
  datasetId: string;
  cold: ColdStateMessage;
  entry: ColdStateActiveEntry;
  channel: number;
}

/** Each active set's members by id, so a hover over a large collection is no scan. */
const membersByActiveSet = new WeakMap<ColdStateActiveEntry[], Map<string, { entry: ColdStateActiveEntry; channel: number }>>();

function memberOf(ctx: WorkerCtx, memberId: string): ColdMember | null {
  const datasetId = ctx.state.memberToDataset.get(memberId);
  const cold = datasetId ? ctx.state.coldStateByDataset.get(datasetId) : undefined;
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
