/**
 * Channel naming, visibility, and solo for the layer panel.
 *
 * Solo is the scene's single-channel mode: `multi_channel` off with `c` on
 * the soloed channel. Saved views, URLs, and peers already carry that pair,
 * so a view recorded in single-channel mode reopens soloed and leaving solo
 * returns to the composite exactly as it was, because solo never touches the
 * per-channel visibility flags.
 */

/** The user's override, then the metadata label, then `Channel n` counting from 1. */
export function channelDisplayName(
  index: number,
  override?: string | null,
  label?: string | null,
): string {
  return override?.trim() || label?.trim() || `Channel ${index + 1}`;
}

/**
 * The key a channel's loaded data range is recorded under. It has the shape
 * of the render worker's per-channel member ids, which is how a reported
 * range names its channel.
 */
export function channelRangeKey(datasetId: string, channel: number): string {
  return `${datasetId}:ch${channel}`;
}

/** Split a {@link channelRangeKey}-shaped id; `null` when it names no channel. */
export function parseChannelRangeKey(key: string): { datasetId: string; channel: number } | null {
  const match = /^(.*):ch(\d+)$/.exec(key);
  return match ? { datasetId: match[1], channel: Number(match[2]) } : null;
}

/** Whether a channel is on screen: the soloed one, or a visible one in the composite. */
export function isChannelShown(
  visible: readonly boolean[],
  solo: number | null,
  channel: number,
): boolean {
  return solo !== null ? channel === solo : (visible[channel] ?? false);
}

export interface ChannelToggle {
  /** The visibility flags to write. */
  visible: boolean[];
  /** Return to the composite after writing them. */
  leaveSolo: boolean;
}

/**
 * Show or hide one channel, judged from what is on screen. Soloed, showing
 * another channel leaves solo with just those two visible, and the soloed
 * channel's own toggle returns to the composite. In the composite the last
 * visible channel stays on, since the renderer would draw one anyway; `null`
 * means nothing changes.
 */
export function toggleChannel(
  visible: readonly boolean[],
  solo: number | null,
  channel: number,
): ChannelToggle | null {
  if (channel < 0 || channel >= visible.length) return null;
  if (solo !== null) {
    if (channel === solo) return { visible: [...visible], leaveSolo: true };
    return { visible: visible.map((_, i) => i === solo || i === channel), leaveSolo: true };
  }
  const shown = visible.filter(Boolean).length;
  if (visible[channel] && shown <= 1) return null;
  return { visible: visible.map((v, i) => (i === channel ? !v : v)), leaveSolo: false };
}

/** Whether the channel is the only one shown in the composite, so it cannot be hidden. */
export function isLastShownChannel(
  visible: readonly boolean[],
  solo: number | null,
  channel: number,
): boolean {
  return solo === null && (visible[channel] ?? false) && visible.filter(Boolean).length <= 1;
}

/**
 * The layer the channel keys act on: the selected layer when it has several
 * channels, else the first such layer in panel order.
 */
export function channelShortcutTarget<L extends { id: string; channels: readonly unknown[] }>(
  layers: readonly L[],
  selectedId: string | null,
): L | null {
  const selected = layers.find((l) => l.id === selectedId);
  if (selected && selected.channels.length > 1) return selected;
  return layers.find((l) => l.channels.length > 1) ?? null;
}
