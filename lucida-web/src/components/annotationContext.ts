/**
 * Shared off-context logic for annotation pins (issue #779).
 *
 * A pin belongs to the slice (Z), timepoint (T), and channel (C) it was placed
 * on. When the current view is on a DIFFERENT Z/T/C, the pin renders
 * "off-context" — dimmed, with a short helptext naming where it actually lives —
 * mirroring how an off-view peer cursor is shown (a peer looking elsewhere).
 * Navigating the view back to the pin's Z/T/C restores its normal look.
 *
 * Both overlays ({@link AnnotationOverlay} 2D and {@link AnnotationOverlay3D} 3D)
 * share this ONE pure function so the on/off-context decision and the helptext
 * are identical in both views — exactly like the shared geometry helper. It is a
 * pure function of `(pin vs viewContext)`, so the overlays don't track any
 * off-context state: the next render under a changed view simply recomputes it,
 * which is what makes navigating to the pin's slice flip it back to normal
 * automatically.
 */
import type { Annotation } from "./AnnotationOverlay.tsx";

/** The current view's discrete Z/T/C selectors — what App passes from `dims`.
 * A pin is on-context iff its own z/t/c all equal these. */
export interface ViewContext {
  z: number;
  t: number;
  c: number;
}

/** A pin's placement Z/T/C as integers, defaulting any field absent on an older
 * pin (pre-depth, or pre-slice-14) to 0 — the same default the wire applies. Z
 * is rounded to the nearest integer for display/compare: a 2D-dropped pin's `z`
 * is the (integer-valued) slice index, and a 3D-dropped pin's picked voxel depth
 * is reported as that integer slice. */
function pinZTC(pin: Annotation): { z: number; t: number; c: number } {
  return {
    z: Math.round(pin.z ?? 0),
    t: Math.round(pin.t ?? 0),
    c: Math.round(pin.c ?? 0),
  };
}

/** Off-context options. `ignoreZ` drops Z from the comparison for the 3D view,
 * where the volume renders ALL slices at once — so a pin on a different Z is
 * still visible and must not dim for Z alone (only T/C take it off-context).
 * Without this, a 3D-created pin — whose picked voxel depth is rarely the
 * slider's current z — would always read off-context. The 2D slice view leaves
 * `ignoreZ` unset: there Z is a real selector. */
export interface OffContextOptions {
  ignoreZ?: boolean;
}

/**
 * Whether `pin` is off-context for `view`: it differs from the current view in
 * ANY of Z, T, or C (Z skipped when {@link OffContextOptions.ignoreZ}). All
 * compared fields equal → on-context (today's normal look, no marker); any
 * difference → off-context (dimmed + the "where it lives" helptext).
 */
export function isOffContext(pin: Annotation, view: ViewContext, opts?: OffContextOptions): boolean {
  const { z, t, c } = pinZTC(pin);
  const zOff = opts?.ignoreZ ? false : z !== Math.round(view.z);
  return zOff || t !== Math.round(view.t) || c !== Math.round(view.c);
}

/**
 * The off-context helptext naming the pin's own Z/T/C, in the exact contract
 * form `slice <z> · t=<t> · ch=<c>` (integer values). Shown only when the pin is
 * off-context; it is what tells a viewer where the pin actually lives.
 */
export function offContextLabel(pin: Annotation): string {
  const { z, t, c } = pinZTC(pin);
  return `slice ${z} · t=${t} · ch=${c}`;
}
