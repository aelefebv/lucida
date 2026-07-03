/** Shared utilities for the chunk rendering tick pipeline (slice + volume). */
import type { WasmScene } from "lucida-core";

let cachedSettings: SceneSettings | null = null;
let settingsGeneration = -1;
let currentGeneration = 0;

/** Bump after any apply_command that changes dataset settings or order. */
export function bumpSettingsGeneration(): void {
  currentGeneration++;
}

export interface ChannelSettingsJS {
  visible: boolean;
  colormap: string;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
}

/** Per-label overlay settings (mirrors `lucida_core::scene::LabelSettings`). */
export interface LabelSettingsJS {
  visible: boolean;
  opacity: number;
  /** The manifest label name this entry controls. In-session, entries are
   *  positional against the live label list; the name is the stable key a
   *  saved view uses to survive a label-list change. Absent on settings that
   *  predate names. */
  name?: string;
}

export interface DatasetSettings {
  visible: boolean;
  opacity: number;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
  blend_mode: string;
  render_mode?: string;
  channel_settings: ChannelSettingsJS[];
  /** Per-label visibility/opacity, positional by manifest label order. Absent
   *  on settings from snapshots that predate per-label controls. */
  label_settings?: LabelSettingsJS[];
  channel_blend_mode: string;
  detail_level_override?: number | null;
}

export interface SceneSettings {
  layerOrder: string[];
  allSettings: Record<string, DatasetSettings>;
}

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

/** Visible channel indices; falls back to [0] when none visible. */
export function getActiveChannels(dsSettings: DatasetSettings): number[] {
  if (!dsSettings.channel_settings || dsSettings.channel_settings.length === 0) return [0];
  const channels: number[] = [];
  for (let i = 0; i < dsSettings.channel_settings.length; i++) {
    if (dsSettings.channel_settings[i].visible) channels.push(i);
  }
  return channels.length > 0 ? channels : [0];
}

export function compositeKey(memberId: string, channel: number): string {
  return `${memberId}:ch${channel}`;
}

export function stripChannelSuffix(key: string): string {
  return key.replace(/:ch\d+$/, "");
}
