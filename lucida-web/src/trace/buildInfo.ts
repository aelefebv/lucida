/**
 * Which build produced a trace. Two runs from different builds are not
 * comparable, and a run header that omits the build does not stop anyone
 * comparing them — it only stops them noticing.
 */

import type { BuildIdentity } from "./types.ts";

/** Injected by `vite.config.ts` from the release manifest. */
declare const __LUCIDA_VERSION__: string;

export function buildIdentity(): BuildIdentity {
  return {
    version: typeof __LUCIDA_VERSION__ === "string" ? __LUCIDA_VERSION__ : "unknown",
    mode: import.meta.env.MODE,
    dev: import.meta.env.DEV,
  };
}
