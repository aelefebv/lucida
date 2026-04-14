/** Shared utilities for the chunk rendering tick pipeline (slice + volume). */
import type { WasmScene } from "lucida-core";

// --- Scene settings cache ---
let cachedSettings: SceneSettings | null = null;
let settingsGeneration = -1;
let currentGeneration = 0;

/** Bump this after any apply_command that changes dataset settings or order. */
export function bumpSettingsGeneration(): void {
  currentGeneration++;
}

/** Per-channel display settings parsed from the WASM scene. */
export interface ChannelSettingsJS {
  visible: boolean;
  colormap: string;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
}

/** Per-dataset settings parsed from the WASM scene. */
export interface DatasetSettings {
  visible: boolean;
  opacity: number;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
  blend_mode: string;
  render_mode?: string;
  channel_settings: ChannelSettingsJS[];
  channel_blend_mode: string;
}

/** Parsed scene-level settings: layer order + per-dataset settings map. */
export interface SceneSettings {
  layerOrder: string[];
  allSettings: Record<string, DatasetSettings>;
}

/**
 * Parse layer order and all dataset settings from the WASM scene.
 *
 * Both slice and volume paths call `scene.dataset_order()` and
 * `scene.all_dataset_settings()` then JSON.parse the results.
 */
export function getSceneSettings(scene: WasmScene): SceneSettings {
  if (cachedSettings && settingsGeneration === currentGeneration) {
    return cachedSettings;
  }
  const layerOrder: string[] = JSON.parse(scene.dataset_order());
  const allSettings: Record<string, DatasetSettings> = JSON.parse(scene.all_dataset_settings());
  cachedSettings = { layerOrder, allSettings };
  settingsGeneration = currentGeneration;
  return cachedSettings;
}

// ---------------------------------------------------------------------------
// Multi-channel helpers
// ---------------------------------------------------------------------------

/**
 * Return the list of visible channel indices from a dataset's settings.
 * Falls back to [0] when there are no channel settings or none are visible.
 */
export function getActiveChannels(dsSettings: DatasetSettings): number[] {
  if (!dsSettings.channel_settings || dsSettings.channel_settings.length === 0) return [0];
  const channels: number[] = [];
  for (let i = 0; i < dsSettings.channel_settings.length; i++) {
    if (dsSettings.channel_settings[i].visible) channels.push(i);
  }
  return channels.length > 0 ? channels : [0];
}

/**
 * Build a composite key for a (member, channel) pair in multi-channel mode.
 */
export function compositeKey(memberId: string, channel: number): string {
  return `${memberId}:ch${channel}`;
}

/**
 * Strip the channel suffix from a composite key to recover the original member ID.
 */
export function stripChannelSuffix(key: string): string {
  return key.replace(/:ch\d+$/, "");
}
