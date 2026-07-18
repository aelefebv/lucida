/** Pure 3-D slot-grid packing shared by chunk-backed texture atlases. */

export interface TextureAtlasLayout {
  capacity: number;
  slotsX: number;
  slotsY: number;
  slotsZ: number;
  textureSize: [number, number, number];
}

export function computeTextureAtlasLayout(
  slotDims: [number, number, number],
  requestedCapacity: number,
  maxTextureDimension3D: number,
): TextureAtlasLayout {
  const [slotZ, slotY, slotX] = slotDims;
  if (slotX <= 0 || slotY <= 0 || slotZ <= 0) {
    throw new Error(`[atlasLayout] invalid slotDims=${slotDims.join(",")}`);
  }

  const maxSlotsX = Math.floor(maxTextureDimension3D / slotX);
  const maxSlotsY = Math.floor(maxTextureDimension3D / slotY);
  const maxSlotsZ = Math.floor(maxTextureDimension3D / slotZ);
  if (maxSlotsX < 1 || maxSlotsY < 1 || maxSlotsZ < 1) {
    throw new Error(
      `[atlasLayout] slotDims=${slotDims.join(",")} exceed ` +
        `maxTextureDimension3D=${maxTextureDimension3D}`,
    );
  }

  const capacity = Math.min(
    Math.max(1, Math.floor(requestedCapacity)),
    maxSlotsX * maxSlotsY * maxSlotsZ,
  );

  let best: TextureAtlasLayout | null = null;
  for (let slotsX = 1; slotsX <= Math.min(maxSlotsX, capacity); slotsX++) {
    const maxCandidateY = Math.min(maxSlotsY, Math.ceil(capacity / slotsX));
    for (let slotsY = 1; slotsY <= maxCandidateY; slotsY++) {
      const slotsZ = Math.ceil(capacity / (slotsX * slotsY));
      if (slotsZ < 1 || slotsZ > maxSlotsZ) continue;
      const candidate: TextureAtlasLayout = {
        capacity,
        slotsX,
        slotsY,
        slotsZ,
        textureSize: [slotsX * slotX, slotsY * slotY, slotsZ * slotZ],
      };
      if (!best || compareLayouts(candidate, best) < 0) best = candidate;
    }
  }

  if (!best) {
    throw new Error(
      `[atlasLayout] cannot pack capacity=${capacity} slotDims=${slotDims.join(",")} ` +
        `under maxTextureDimension3D=${maxTextureDimension3D}`,
    );
  }
  return best;
}

function compareLayouts(a: TextureAtlasLayout, b: TextureAtlasLayout): number {
  const allocated = a.slotsX * a.slotsY * a.slotsZ - b.slotsX * b.slotsY * b.slotsZ;
  if (allocated !== 0) return allocated;
  const maxAxis = Math.max(...a.textureSize) - Math.max(...b.textureSize);
  if (maxAxis !== 0) return maxAxis;
  const minAxis = Math.min(...b.textureSize) - Math.min(...a.textureSize);
  if (minAxis !== 0) return minAxis;
  return a.textureSize[0] * a.textureSize[1] * a.textureSize[2] -
    b.textureSize[0] * b.textureSize[1] * b.textureSize[2];
}
