import { chunkWithinRenderRadius, RENDER_RADIUS_DISABLED } from "../pipeline/renderRadius.ts";
import type { RendererState } from "./worker/state.ts";
import type { Chunk } from "./workerProtocol.ts";
import { iterateColdMembers } from "./descriptorBuffer.ts";

export function chunkAllowedByCurrentRenderRadius(
  state: RendererState,
  memberId: string,
  tier: "detail" | "coarse" | undefined,
  chunk: Pick<Chunk, "key" | "x" | "y" | "z"> & { level: number },
): boolean {
  const cold = state.currentColdState;
  if (!cold) return true;
  const radiusView = cold.renderRadiusView?.[tier ?? "detail"] ?? RENDER_RADIUS_DISABLED;
  const entry = findEntryForMember(state, memberId);
  if (!entry || entry.kind === "well-as-proxy") return true;
  const level = entry.levels.find((l) => l.level === chunk.level);
  const level0 = entry.levels.find((l) => l.level === 0) ?? level;
  if (!level || !level0) return true;
  const [chunkZ, chunkY, chunkX] = level.chunkShape;
  return chunkWithinRenderRadius({
    region: cold.visibleRegion,
    radiusView,
    layoutPositionVox: entry.layoutPositionVox ?? [0, 0],
    geometry: {
      fullDims: [
        level0.levelDims[2],
        level0.levelDims[1],
        level0.levelDims[0],
      ],
      levelDims: [
        level.levelDims[2],
        level.levelDims[1],
        level.levelDims[0],
      ],
      chunkDims: [chunkX, chunkY, chunkZ],
    },
    chunk,
  });
}

function findEntryForMember(
  state: RendererState,
  memberId: string,
) {
  const cold = state.currentColdState;
  if (!cold) return null;
  for (const member of iterateColdMembers(cold)) {
    if (member.memberId === memberId) return member.entry;
  }
  return null;
}
