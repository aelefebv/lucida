/** Assemble all chunks for one timepoint/channel into a contiguous 3D array. */
import type { LevelMeta } from "./metadata.ts";
import { loadChunk } from "./chunkLoader.ts";
import { bufferToUint16 } from "./dtypeConvert.ts";

export interface VolumeData {
  data: Uint16Array;
  width: number; // X
  height: number; // Y
  depth: number; // Z
}

export async function assembleVolume(
  fileIndex: Map<string, File>,
  level: string,
  t: number,
  c: number,
  meta: LevelMeta,
): Promise<VolumeData> {
  const [, , depthFull, heightFull, widthFull] = meta.shape;
  const [, , chunkZ, chunkY, chunkX] = meta.chunkShape;

  const nz = Math.ceil(depthFull / chunkZ);
  const ny = Math.ceil(heightFull / chunkY);
  const nx = Math.ceil(widthFull / chunkX);

  const volume = new Uint16Array(widthFull * heightFull * depthFull);

  // Load all chunks in parallel
  const tasks: Promise<void>[] = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        tasks.push(
          loadChunk(fileIndex, level, t, c, iz, iy, ix, meta.codecs).then((buf) => {
            const chunk = bufferToUint16(buf, meta.dataType);
            const zOff = iz * chunkZ;
            const yOff = iy * chunkY;
            const xOff = ix * chunkX;

            // Voxels to copy (may be smaller at volume edges)
            const cw = Math.min(chunkX, widthFull - xOff);
            const ch = Math.min(chunkY, heightFull - yOff);
            const cd = Math.min(chunkZ, depthFull - zOff);

            // Zarr v3 chunks are always stored at full chunk shape (padded),
            // so source strides use full chunkX/chunkY, not edge-trimmed sizes
            for (let dz = 0; dz < cd; dz++) {
              for (let dy = 0; dy < ch; dy++) {
                const srcStart = (dz * chunkY + dy) * chunkX;
                const dstStart =
                  ((zOff + dz) * heightFull + (yOff + dy)) * widthFull +
                  xOff;
                volume.set(
                  chunk.subarray(srcStart, srcStart + cw),
                  dstStart,
                );
              }
            }
          }),
        );
      }
    }
  }

  await Promise.all(tasks);
  return { data: volume, width: widthFull, height: heightFull, depth: depthFull };
}
