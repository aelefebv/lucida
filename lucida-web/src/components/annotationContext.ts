/**
 * Off-context logic for annotation pins. A pin belongs to the Z, T, and C it
 * was placed on; on any other Z/T/C it renders dimmed with a label naming where
 * it lives. This is a pure function of pin and view, so overlays keep no
 * off-context state and navigating back restores the pin on the next render.
 */
import type { Annotation } from "./annotationDocument.ts";

/** The current view's Z/T/C selectors. */
export interface ViewContext {
  z: number;
  t: number;
  c: number;
}

/** A pin's placement Z/T/C as integers, with absent fields defaulting to 0 as
 * on the wire. A 3D-dropped pin's voxel depth rounds to its slice. */
function pinZTC(pin: Annotation): { z: number; t: number; c: number } {
  return {
    z: Math.round(pin.z ?? 0),
    t: Math.round(pin.t ?? 0),
    c: Math.round(pin.c ?? 0),
  };
}

/** `ignoreZ` is for the 3D view, which renders all slices at once. Without it a
 * 3D-created pin, whose picked depth is rarely the slider's z, would always
 * read off-context. */
export interface OffContextOptions {
  ignoreZ?: boolean;
}

/** Whether `pin` differs from `view` in any of Z, T, or C. */
export function isOffContext(pin: Annotation, view: ViewContext, opts?: OffContextOptions): boolean {
  const { z, t, c } = pinZTC(pin);
  const zOff = opts?.ignoreZ ? false : z !== Math.round(view.z);
  return zOff || t !== Math.round(view.t) || c !== Math.round(view.c);
}

/** The off-context label naming the pin's own Z/T/C. */
export function offContextLabel(pin: Annotation): string {
  const { z, t, c } = pinZTC(pin);
  return `slice ${z} · t=${t} · ch=${c}`;
}
