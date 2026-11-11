/**
 * Where a person put a dataset by hand. lucida-core composes the transform
 * onto the dataset's declared placement and does every view's math with the
 * result; the web reads the transform, turns a gesture into a map of the scene
 * frame or a turn, and asks the scene what transform that makes.
 */
import type { WasmScene } from "lucida-core";
import type { SetUserTransformCommand } from "./commands.ts";
import type { UserTransform } from "./savedView/types.ts";

export type { UserTransform };

export const IDENTITY_USER_TRANSFORM: UserTransform = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

type Triple = [number, number, number];

export function sameUserTransform(a: UserTransform, b: UserTransform): boolean {
  const same = (x: readonly number[], y: readonly number[]) => x.every((v, i) => v === y[i]);
  return same(a.translation, b.translation) && same(a.rotation, b.rotation) && same(a.scale, b.scale);
}

export function isIdentityTransform(t: UserTransform): boolean {
  return sameUserTransform(t, IDENTITY_USER_TRANSFORM);
}

/** `datasetId`'s transform, or null where nobody placed it by hand. */
export function readUserTransform(
  scene: Pick<WasmScene, "dataset_user_transform">,
  datasetId: string,
): UserTransform | null {
  return JSON.parse(scene.dataset_user_transform(datasetId)) as UserTransform | null;
}

/** Every dataset placed by hand and how, in document order. */
export function readUserTransforms(scene: Pick<WasmScene, "user_transforms">): Record<string, UserTransform> {
  return JSON.parse(scene.user_transforms()) as Record<string, UserTransform>;
}

/** The length unit each of `datasetId`'s axes declares, `[x, y, z]`, which a
 *  transform's translation is in. */
export function readUnits(
  scene: Pick<WasmScene, "dataset_units">,
  datasetId: string,
): [string | null, string | null, string | null] {
  return JSON.parse(scene.dataset_units(datasetId)) as [string | null, string | null, string | null];
}

/** A map of the scene frame, `linear · point + offset`, `linear` by rows. */
export interface SceneMap {
  linear: readonly [Triple, Triple, Triple];
  offset: Triple;
}

/** The scene-frame map that moves everything by `delta`. */
export function moveBy(delta: Triple): SceneMap {
  return { linear: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], offset: delta };
}

/** The scene-frame map that stretches by `factor` about `anchor`, which stays put. */
export function scaleAbout(anchor: Triple, factor: Triple): SceneMap {
  return {
    linear: [[factor[0], 0, 0], [0, factor[1], 0], [0, 0, factor[2]]],
    offset: [0, 1, 2].map((i) => anchor[i] * (1 - factor[i])) as Triple,
  };
}

/** `inner`, then `outer`. */
export function thenMap(inner: SceneMap, outer: SceneMap): SceneMap {
  const row = (r: number): Triple =>
    [0, 1, 2].map((c) => [0, 1, 2].reduce((sum, k) => sum + outer.linear[r][k] * inner.linear[k][c], 0)) as Triple;
  return {
    linear: [row(0), row(1), row(2)],
    offset: [0, 1, 2].map((r) =>
      outer.offset[r] + [0, 1, 2].reduce((sum, k) => sum + outer.linear[r][k] * inner.offset[k], 0)) as Triple,
  };
}

/**
 * `from`, a transform of `datasetId`, followed by `map`: the transform that
 * draws the dataset where `map` takes it from where `from` draws it. Null for
 * a dataset the scene doesn't hold.
 */
export function userTransformAfter(
  scene: Pick<WasmScene, "user_transform_after">,
  datasetId: string,
  from: UserTransform,
  map: SceneMap,
): UserTransform | null {
  const json = scene.user_transform_after(
    datasetId,
    JSON.stringify(from),
    new Float64Array(map.linear.flat()),
    new Float64Array(map.offset),
  );
  return json ? (JSON.parse(json) as UserTransform) : null;
}

/** `datasetId`'s rotation by hand as degrees about X, then Y, then Z. */
export function readRotationDegrees(
  scene: Pick<WasmScene, "dataset_rotation_degrees">,
  datasetId: string,
): Triple {
  const [x = 0, y = 0, z = 0] = scene.dataset_rotation_degrees(datasetId);
  return [x, y, z];
}

/**
 * `from`, a transform of `datasetId`, turned to `degrees` about X, then Y,
 * then Z, about the dataset's center, which stays put. Null for a dataset
 * the scene can't turn.
 */
export function userTransformTurned(
  scene: Pick<WasmScene, "user_transform_turned">,
  datasetId: string,
  from: UserTransform,
  degrees: Triple,
): UserTransform | null {
  const json = scene.user_transform_turned(datasetId, JSON.stringify(from), new Float64Array(degrees));
  return json ? (JSON.parse(json) as UserTransform) : null;
}

/**
 * `from` turned by `angle` radians in `view`'s plane, from its across axis
 * toward its down axis, about the dataset's center. Null for a dataset the
 * scene can't turn.
 */
export function userTransformTurnedInView(
  scene: Pick<WasmScene, "user_transform_turned_in_view">,
  view: number,
  datasetId: string,
  from: UserTransform,
  angle: number,
): UserTransform | null {
  const json = scene.user_transform_turned_in_view(view, datasetId, JSON.stringify(from), angle);
  return json ? (JSON.parse(json) as UserTransform) : null;
}

export function setUserTransformCommand(datasetId: string, transform: UserTransform): SetUserTransformCommand {
  return { type: "set_user_transform", dataset_id: datasetId, transform };
}
