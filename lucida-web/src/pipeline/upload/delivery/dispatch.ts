/**
 * Free-function chunk dispatch helpers. Wrap the client's chunk senders with
 * structured args derived from a delivery + level meta.
 */

import type { ReadyChunkDelivery } from "../../fetch/index.ts";
import type { UploadClient } from "../uploadClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import { tczyx, toPlaneFrame, type PoolCut, type SpatialAxis } from "../../../renderer/slicePlane.ts";
import { decodedSampleBytes } from "../../../renderer/dataTypeUtil.ts";

/**
 * The worker's member id for an image's channel; the cold state's wanted
 * chunks use the same one. Every channel has its own id whatever a layer
 * shows, so a solo or a return to the composite keeps the resources of the
 * channels it still shows.
 */
export function workerMemberId(imageId: string, c: number): string {
  return `${imageId}:ch${c}`;
}

export function workerMemberIdForChunk(delivery: ReadyChunkDelivery): string {
  return workerMemberId(delivery.imageId, delivery.c);
}

export function parseWorkerMemberId(memberId: string): {
  imageId: string;
  c: number | null;
} {
  const match = /^(.*):ch(\d+)$/.exec(memberId);
  if (!match) return { imageId: memberId, c: null };
  return { imageId: match[1], c: Number(match[2]) };
}

export function channelFromChunkKey(chunkKey: string): number | null {
  const parts = chunkKey.split("/");
  if (parts.length < 3) return null;
  const c = Number(parts[2]);
  return Number.isFinite(c) ? c : null;
}

/** What a dispatch posted: the worker member it went to and the bytes it carried. */
export interface Dispatched {
  memberId: string;
  bytes: number;
}

/**
 * Why a dispatch posted nothing. `other-plane`: the slice view's plane is in
 * another chunk along its cut, which the plan has moved on to, or the chunk
 * holds planes along another axis. `no-meta`: the geometry to place the
 * chunk is missing, or the chunk is shorter than it says, which should not
 * happen.
 */
export type DispatchSkip = "other-plane" | "no-meta";

/**
 * One Z plane of a decoded chunk, copied out of the cache's buffer, which the
 * cache keeps for later deliveries. `firstZ` is the chunk's first plane the
 * buffer holds, which is 0 for a whole chunk. `null` when the buffer does not
 * hold the plane. Posting transfers the copy and empties it, so its size is
 * read before the post.
 */
function cutPlane(
  data: ArrayBuffer,
  dataType: string,
  localZ: number,
  planeLen: number,
  firstZ = 0,
): ArrayBuffer | null {
  const planeBytes = planeLen * decodedSampleBytes(dataType);
  const start = (localZ - firstZ) * planeBytes;
  if (start < 0 || start + planeBytes > data.byteLength) return null;
  return data.slice(start, start + planeBytes);
}

/**
 * One plane along X or Y of a decoded chunk of `dims` samples along Z, Y
 * and X, copied out row by row, as the slice worker's frame lays it out:
 * a row along the screen's across axis for each Z. `firstPlane` is the
 * chunk's first plane along `axis` the buffer holds, whose extent along
 * `axis` is then the planes it holds rather than the chunk's. `null` when
 * the buffer does not hold the plane.
 */
function cutSidePlane(
  data: ArrayBuffer,
  dataType: string,
  axis: Exclude<SpatialAxis, "z">,
  local: number,
  dims: readonly [number, number, number],
  held: readonly [number, number] | undefined,
): ArrayBuffer | null {
  const sample = decodedSampleBytes(dataType);
  const [dz, dy, dx] = dims;
  const first = held?.[0] ?? 0;
  const span = held ? held[1] - held[0] : axis === "y" ? dy : dx;
  const at = local - first;
  // Samples of each Z of the buffer, and of each row across a plane.
  const ny = axis === "y" ? span : dy;
  const nx = axis === "x" ? span : dx;
  if (at < 0 || at >= span || dz * ny * nx * sample > data.byteLength) return null;
  const from = new Uint8Array(data);
  if (axis === "y") {
    const row = nx * sample;
    const out = new Uint8Array(dz * row);
    for (let z = 0; z < dz; z++) {
      const start = (z * ny + at) * row;
      out.set(from.subarray(start, start + row), z * row);
    }
    return out.buffer;
  }
  const out = new Uint8Array(dz * ny * sample);
  let o = 0;
  for (let z = 0; z < dz; z++) {
    for (let y = 0; y < ny; y++) {
      const start = ((z * ny + y) * nx + at) * sample;
      for (let b = 0; b < sample; b++) out[o++] = from[start + b];
    }
  }
  return out.buffer;
}

/**
 * Post one chunk to the worker. A slice view draws one plane of a chunk, so
 * the slice pools are sent only the plane `cut` names, a chunk-depth fraction
 * of the bytes, and a move to another plane of the same chunk sends that
 * plane. It goes in the worker's frame for the plane drawn
 * (`SliceChunkDataMessage`). Posts nothing, and says why, when it cannot
 * place the chunk or the chunk does not hold the plane. A delivery of some
 * planes of a chunk that lacks the plane is `other-plane`: the plan asks for
 * the plane again.
 */
export function dispatchChunkDelivery(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  meta: ManifestEntry,
  viewMode: "slice" | "volume",
  cut: PoolCut | null,
  epochs: SceneEpochs,
): Dispatched | DispatchSkip {
  const levelMeta = meta.levels[delivery.level];
  if (!levelMeta) return "no-meta";
  const memberId = workerMemberIdForChunk(delivery);
  const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
  const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
  const chunk = {
    data: delivery.data,
    dataType: delivery.dataType,
    x: delivery.x,
    y: delivery.y,
    z: delivery.z,
    key: delivery.chunkKey,
  };

  if (viewMode === "volume") {
    // Planes are never resident for the volume view, which asks for whole
    // chunks; one that is left over from the slice view is not a chunk.
    if (delivery.planes) return "other-plane";
    client.volumeChunkData(
      memberId,
      [chunk],
      delivery.level,
      delivery.t,
      delivery.c,
      levelWidth,
      levelHeight,
      levelDepth,
      chunkX,
      chunkY,
      chunkZ,
      epochs,
      delivery.residencyTier,
    );
    return { memberId, bytes: delivery.data.byteLength };
  }

  if (cut === null) return "no-meta";
  const { axis, plane: levelPlane } = cut;
  const fullShape = meta.image.multiscale.levels[0].shape;
  // The chunk's place and shape across the screen, down it, and along the cut.
  const [cu, cv, cw] = toPlaneFrame([delivery.x, delivery.y, delivery.z], axis);
  const [levelU, levelV, levelW] = toPlaneFrame([levelWidth, levelHeight, levelDepth], axis);
  const [chunkU, chunkV, chunkW] = toPlaneFrame([chunkX, chunkY, chunkZ], axis);
  const fullResW = fullShape[tczyx(axis)];
  const depth = Math.max(chunkW, 1);
  if (cw !== Math.floor(levelPlane / depth)) return "other-plane";
  const local = levelPlane - cw * depth;
  const held = delivery.planes;
  if (held && (delivery.planeAxis ?? "z") !== axis) return "other-plane";
  if (held && (local < held[0] || local >= held[1])) return "other-plane";
  const plane = axis === "z"
    ? cutPlane(delivery.data, delivery.dataType, local, chunkY * chunkX, held?.[0])
    : cutSidePlane(delivery.data, delivery.dataType, axis, local, [chunkZ, chunkY, chunkX], held);
  if (!plane) return "no-meta";
  const bytes = plane.byteLength;
  client.sliceChunkData(
    memberId,
    [{ ...chunk, data: plane, x: cu, y: cv, z: cw }],
    delivery.level,
    delivery.t,
    delivery.c,
    levelU,
    levelV,
    chunkU,
    chunkV,
    chunkW,
    fullResW,
    levelW,
    levelPlane,
    epochs,
    delivery.residencyTier,
    axis,
  );
  return { memberId, bytes };
}

/**
 * Deliver the one Z-plane of a uint32 label chunk that the slice view needs
 * to the r32uint label pool. A 3D label chunk is ~8 MB though the worker
 * draws one ~64 KB plane, and labels sort after intensity, so sending the
 * whole chunk would starve them of upload budget.
 *
 * Posts nothing, and says why, when geometry is missing or the chunk covers
 * a different Z-chunk than the current view. A delivery of some planes of a
 * chunk that lacks the plane is `other-plane`: the plan asks for the plane
 * again.
 */
export function dispatchLabelChunkDelivery(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  meta: ManifestEntry,
  cut: PoolCut | null,
  epochs: SceneEpochs,
): Dispatched | DispatchSkip {
  // A label overlay draws only on an XY cut, from the plane of its level the
  // cut names.
  if (cut !== null && cut.axis !== "z") return "other-plane";
  const levelMeta = meta.levels[delivery.level];
  if (!levelMeta || cut === null) return "no-meta";
  const [, , , levelHeight, levelWidth] = levelMeta.shape;
  const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
  const levelZ = cut.plane;
  const cz = Math.max(chunkZ, 1);
  // This chunk covers a different Z-chunk than the current view — the right
  // one is requested separately; drop this stale plane.
  if (delivery.z !== Math.floor(levelZ / cz)) return "other-plane";
  const localZ = levelZ - delivery.z * cz;
  const held = delivery.planes;
  if (held && (localZ < held[0] || localZ >= held[1])) return "other-plane";
  const plane = cutPlane(delivery.data, delivery.dataType, localZ, chunkY * chunkX, held?.[0]);
  if (!plane) return "no-meta";
  const memberId = delivery.imageId;
  const bytes = plane.byteLength;

  client.labelSliceChunkData(
    memberId,
    meta.datasetId,
    [{
      data: plane,
      dataType: delivery.dataType,
      x: delivery.x,
      y: delivery.y,
      z: 0,
      key: delivery.chunkKey,
    }],
    delivery.level,
    delivery.t,
    delivery.c,
    levelWidth,
    levelHeight,
    chunkX,
    chunkY,
    levelZ,
    epochs,
  );
  return { memberId, bytes };
}

/**
 * Deliver a whole uint32 label chunk to the r32uint label volume pool. The
 * first-hit surface needs the full depth, since each ray stops at the first
 * non-zero voxel anywhere along it. Returns the member id and bytes sent,
 * or `no-meta` when the level geometry is unavailable.
 */
export function dispatchLabelVolumeChunkDelivery(
  client: UploadClient,
  delivery: ReadyChunkDelivery,
  meta: ManifestEntry,
  epochs: SceneEpochs,
): Dispatched | DispatchSkip {
  const levelMeta = meta.levels[delivery.level];
  if (!levelMeta) return "no-meta";
  // As for the image's volume view: planes left over from the slice view are
  // not a chunk.
  if (delivery.planes) return "other-plane";
  const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
  const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;
  const memberId = delivery.imageId;

  client.labelVolumeChunkData(
    memberId,
    meta.datasetId,
    [{
      data: delivery.data,
      dataType: delivery.dataType,
      x: delivery.x,
      y: delivery.y,
      z: delivery.z,
      key: delivery.chunkKey,
    }],
    delivery.level,
    delivery.t,
    delivery.c,
    levelWidth,
    levelHeight,
    levelDepth,
    chunkX,
    chunkY,
    chunkZ,
    epochs,
  );
  return { memberId, bytes: delivery.data.byteLength };
}
