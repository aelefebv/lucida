/**
 * Why a view leaves a dataset out: another view holds its GPU pools in
 * another form, and a dataset's pools hold one cut or one volume at a time
 * for now.
 */
import type { PoolForm, ViewPane, WithheldDataset } from "../sceneStore.ts";

/** Why a view leaves `name` out, as one sentence. */
export function withheldMessage(entry: WithheldDataset, views: readonly ViewPane[], name: string): string {
  const position = views.findIndex((view) => view.id === entry.holder);
  const holder = position >= 0 ? `view ${position + 1}` : "another view";
  const later = entry.held.kind !== entry.wanted.kind
    ? "one dataset in 2D and 3D at once comes later"
    : entry.held.t !== entry.wanted.t
      ? "one dataset at two timepoints comes later"
      : "one dataset at two cuts comes later";
  return `${name} is shown in ${holder} ${describe(entry.held)}; ${later}.`;
}

function describe(form: PoolForm): string {
  if (form.kind === "volume") return `in 3D at T ${form.t}`;
  const axis = { xy: "Z", xz: "Y", yz: "X" }[form.plane];
  return `at ${axis} ${form.cut.start}, T ${form.t}`;
}
