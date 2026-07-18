/**
 * Canonical TypeScript mirror of `lucida_core::scene::LabelSettings`.
 *
 * Keep the named defaults aligned with Rust's `DEFAULT_LABEL_*` constants.
 * Scene, saved-view, planning, panel, and renderer layers import this contract
 * instead of redeclaring the wire shape or its fallback policy.
 */
export interface LabelSettings {
  visible: boolean;
  opacity: number;
}

/** Labels are opt-in when a legacy/short settings payload has no entry. */
export const DEFAULT_LABEL_VISIBLE = false;

/** Default overlay strength once a label is made visible. */
export const DEFAULT_LABEL_OPACITY = 0.5;

export const DEFAULT_LABEL_SETTINGS: Readonly<LabelSettings> = Object.freeze({
  visible: DEFAULT_LABEL_VISIBLE,
  opacity: DEFAULT_LABEL_OPACITY,
});

/** Clamp a wire-provided opacity, falling back for missing/non-finite values. */
export function normalizeLabelOpacity(opacity: number | undefined): number {
  if (opacity === undefined || !Number.isFinite(opacity)) {
    return DEFAULT_LABEL_OPACITY;
  }
  return Math.min(1, Math.max(0, opacity));
}

/** Resolve one positional entry under the product-wide label default policy. */
export function resolveLabelSettings(
  settings: readonly LabelSettings[] | undefined,
  index: number,
): LabelSettings {
  const setting = settings?.[index];
  return {
    visible: setting?.visible ?? DEFAULT_LABEL_VISIBLE,
    opacity: normalizeLabelOpacity(setting?.opacity),
  };
}
