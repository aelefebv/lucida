import type { MemberRosterEntry } from "./pipeline/tickCoordinator.ts";

export interface MemberPlacementMatrixScene {
  member_model_matrix(datasetId: string, memberId: string): Float32Array;
  inv_member_model_matrix(datasetId: string, memberId: string): Float32Array;
}

export interface MemberPlacementAccessor {
  /** Resolve a source image in the shared 2D layout coordinate system. */
  position2d(sourceImageId: string, sourceOwnerId: string): [number, number];
  /** Resolve a source image's world transform and its matching inverse. */
  matrices3d(sourceImageId: string): {
    modelMatrix: Float32Array;
    invModelMatrix: Float32Array;
  };
}

interface MemberPlacementOptions {
  members: MemberRosterEntry[];
  positions?: Readonly<Record<string, [number, number]>>;
  matrixSource?: {
    datasetId: string;
    scene: MemberPlacementMatrixScene;
  };
}

/**
 * Build the one source-placement policy used by both label render paths.
 *
 * The active roster is indexed once instead of searched once per label. A
 * source outside that roster falls back to the coordinator's cached 2D layout
 * record or the scene's authoritative 3D matrices. Matrix fallbacks are cached
 * too, so sibling labels attached to the same source cross the WASM boundary
 * only once per render assembly.
 */
export function createMemberPlacementAccessor(
  options: MemberPlacementOptions,
): MemberPlacementAccessor {
  const memberByImageId = new Map(
    options.members.map((member) => [member.imageId, member] as const),
  );
  const matrixCache = new Map<string, {
    modelMatrix: Float32Array;
    invModelMatrix: Float32Array;
  }>();

  return {
    position2d(sourceImageId, sourceOwnerId) {
      return memberByImageId.get(sourceImageId)?.position
        ?? options.positions?.[sourceOwnerId]
        ?? [0, 0];
    },

    matrices3d(sourceImageId) {
      const cached = matrixCache.get(sourceImageId);
      if (cached) return cached;

      const member = memberByImageId.get(sourceImageId);
      const source = options.matrixSource;
      if ((!member?.modelMatrix || !member.invModelMatrix) && !source) {
        throw new Error(
          `No 3D placement source is available for member ${sourceImageId}`,
        );
      }

      const matrices = {
        modelMatrix: member?.modelMatrix
          ?? new Float32Array(
            source!.scene.member_model_matrix(source!.datasetId, sourceImageId),
          ),
        invModelMatrix: member?.invModelMatrix
          ?? new Float32Array(
            source!.scene.inv_member_model_matrix(source!.datasetId, sourceImageId),
          ),
      };
      matrixCache.set(sourceImageId, matrices);
      return matrices;
    },
  };
}
