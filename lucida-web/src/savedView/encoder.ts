// Encoder/decoder for `SavedView` ↔ URL-hash payload.
// Pure functions; no DOM, no scene, no bridge — fully testable in isolation.
//
// Pipeline on encode:
//   SavedView → strip defaults → JSON → gzip (CompressionStream) → base64url
//
// Pipeline on decode:
//   base64url → gunzip (DecompressionStream) → JSON → restore defaults
//     → validate the complete v1 shape before returning it
//
// Both flows are async because `CompressionStream` is stream-based.
//
// Defaults stripping is what keeps a 384-group collection share link < 1 KB —
// a default `DatasetDisplaySettings` carries a vec of identical channel
// settings per dataset; emitting only the non-default deltas crushes the
// payload before gzip even runs.

import {
  SAVED_VIEW_VERSION,
  type SavedView,
  type DatasetDisplaySettings,
  type ChannelSettings,
  type ViewState,
  type DisplayState,
} from "./types.ts";

// Public API

export async function encode(view: SavedView): Promise<string> {
  const stripped = stripDefaults(validateSavedView(view));
  const json = JSON.stringify(stripped);
  const gz = await gzip(new TextEncoder().encode(json));
  return base64UrlEncode(gz);
}

export async function decode(s: string): Promise<SavedView> {
  if (!s) throw new SavedViewDecodeError("empty payload");
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(s);
  } catch (e) {
    throw new SavedViewDecodeError(`base64url decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let jsonBytes: Uint8Array;
  try {
    jsonBytes = await gunzip(bytes);
  } catch (e) {
    throw new SavedViewDecodeError(`gunzip failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch (e) {
    throw new SavedViewDecodeError(`JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateSavedView(parsed);
}

export class SavedViewDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedViewDecodeError";
  }
}

// Validation + version handling

/**
 * Validate and normalize an untrusted saved-view object.
 *
 * This is intentionally the single runtime boundary used by both URL decode
 * and the applier. API responses and hand-authored callers do not pass through
 * `decode()`, so TypeScript's static `SavedView` annotation is not evidence
 * that their nested fields are safe to forward to WASM. Validation completes
 * before a normalized value is returned, giving restore an all-or-nothing
 * preflight: a malformed optional field cannot fail halfway through scene
 * mutation.
 *
 * Version policy is deliberately strict. v1 is the only supported major
 * version; missing/zero/legacy/future versions are rejected. Additive v1
 * fields remain backwards compatible through defaults, while a future major
 * requires an explicit migration instead of a best-effort partial apply.
 */
export function validateSavedView(raw: unknown): SavedView {
  if (typeof raw !== "object" || raw === null) {
    throw new SavedViewDecodeError("payload must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const v = obj.v;
  if (typeof v !== "number" || !Number.isInteger(v) || v !== SAVED_VIEW_VERSION) {
    throw new SavedViewDecodeError(`missing or invalid version (got ${JSON.stringify(v)})`);
  }
  validateStringArray(obj.datasets, "datasets", true);
  validateStringMap(obj.active_layouts, "active_layouts", true);
  validateCamera(obj.camera, "camera");
  validateView(obj.view, "view");
  validateDisplay(obj.display, "display");
  validateStringArray(obj.dataset_order, "dataset_order", true);
  validateDatasetSettingsMap(obj.dataset_settings, "dataset_settings");
  validateBooleanMap(obj.auto_contrast, "auto_contrast", true);
  return restoreDefaults(obj);
}

function fail(path: string, expected: string, value: unknown): never {
  throw new SavedViewDecodeError(
    `${path} must be ${expected} (got ${JSON.stringify(value)})`,
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "an object", value);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value, path);
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "a finite number", value);
  return value;
}

function optionalFinite(value: unknown, path: string): void {
  if (value !== undefined) finite(value, path);
}

function uint(value: unknown, path: string): number {
  const n = finite(value, path);
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffff_ffff) {
    fail(path, "an unsigned 32-bit integer", value);
  }
  return n;
}

function optionalUint(value: unknown, path: string): void {
  if (value !== undefined) uint(value, path);
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "a boolean", value);
  return value;
}

function optionalBool(value: unknown, path: string): void {
  if (value !== undefined) bool(value, path);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "a string", value);
  return value;
}

function optionalText(value: unknown, path: string): void {
  if (value !== undefined) text(value, path);
}

function tuple(value: unknown, length: number, path: string, item: (v: unknown, p: string) => unknown): void {
  if (!Array.isArray(value) || value.length !== length) fail(path, `an array of length ${length}`, value);
  value.forEach((entry, index) => item(entry, `${path}[${index}]`));
}

function validateStringArray(value: unknown, path: string, optional = false): void {
  if (value === undefined && optional) return;
  if (!Array.isArray(value)) fail(path, "an array", value);
  value.forEach((entry, index) => text(entry, `${path}[${index}]`));
}

function validateStringMap(value: unknown, path: string, optional = false): void {
  if (value === undefined && optional) return;
  for (const [key, entry] of Object.entries(record(value, path))) {
    text(key, `${path} key`);
    text(entry, `${path}.${key}`);
  }
}

function validateBooleanMap(value: unknown, path: string, optional = false): void {
  if (value === undefined && optional) return;
  for (const [key, entry] of Object.entries(record(value, path))) {
    text(key, `${path} key`);
    bool(entry, `${path}.${key}`);
  }
}

function validateEnum(value: unknown, allowed: readonly string[], path: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(path, `one of ${allowed.join(", ")}`, value);
  }
}

function validateCamera(value: unknown, path: string): void {
  const camera = record(value, path);
  const mode = text(camera.mode, `${path}.mode`);
  if (mode === "slice") {
    tuple(camera.center, 2, `${path}.center`, finite);
    finite(camera.zoom, `${path}.zoom`);
    tuple(camera.viewport, 2, `${path}.viewport`, uint);
    return;
  }
  if (mode === "arcball") {
    tuple(camera.target, 3, `${path}.target`, finite);
    for (const key of ["theta", "phi", "distance", "fov", "near", "far"] as const) {
      finite(camera[key], `${path}.${key}`);
    }
    tuple(camera.viewport, 2, `${path}.viewport`, uint);
    optionalFinite(camera.clip_distance, `${path}.clip_distance`);
    if (camera.clip_mode !== undefined) {
      validateEnum(camera.clip_mode, ["plane", "sphere"], `${path}.clip_mode`);
    }
    return;
  }
  if (mode === "fly") {
    tuple(camera.position, 3, `${path}.position`, finite);
    tuple(camera.orientation, 4, `${path}.orientation`, finite);
    for (const key of ["fov", "near", "far", "speed_multiplier"] as const) {
      finite(camera[key], `${path}.${key}`);
    }
    tuple(camera.viewport, 2, `${path}.viewport`, uint);
    optionalFinite(camera.base_speed, `${path}.base_speed`);
    optionalFinite(camera.clip_distance, `${path}.clip_distance`);
    if (camera.clip_mode !== undefined) {
      validateEnum(camera.clip_mode, ["plane", "sphere"], `${path}.clip_mode`);
    }
    return;
  }
  fail(`${path}.mode`, "slice, arcball, or fly", mode);
}

function validateView(value: unknown, path: string): void {
  const view = optionalRecord(value, path);
  if (!view) return;
  if (view.z_range !== undefined) {
    const range = record(view.z_range, `${path}.z_range`);
    const start = uint(range.start, `${path}.z_range.start`);
    const end = uint(range.end, `${path}.z_range.end`);
    if (start >= end) fail(`${path}.z_range`, "a non-empty ascending range", view.z_range);
  }
  optionalUint(view.t, `${path}.t`);
  optionalUint(view.c, `${path}.c`);
  optionalBool(view.multi_channel, `${path}.multi_channel`);
}

function validateDisplay(value: unknown, path: string): void {
  const display = optionalRecord(value, path);
  if (!display) return;
  optionalFinite(display.contrast_min, `${path}.contrast_min`);
  optionalFinite(display.contrast_max, `${path}.contrast_max`);
  optionalFinite(display.gamma, `${path}.gamma`);
}

const COLORMAPS = [
  "gray", "magenta", "green", "cyan", "red", "blue", "yellow",
  "viridis", "inferno", "plasma", "magma", "turbo", "hot", "cool", "jet",
] as const;
const BLEND_MODES = ["alpha", "additive", "max"] as const;
const RENDER_MODES = ["translucent", "max_intensity"] as const;

function validateDatasetSettingsMap(value: unknown, path: string): void {
  if (value === undefined) return;
  for (const [id, entry] of Object.entries(record(value, path))) {
    validateDatasetSettings(entry, `${path}.${id}`);
  }
}

function validateDatasetSettings(value: unknown, path: string): void {
  const settings = record(value, path);
  optionalBool(settings.visible, `${path}.visible`);
  optionalFinite(settings.opacity, `${path}.opacity`);
  optionalFinite(settings.contrast_min, `${path}.contrast_min`);
  optionalFinite(settings.contrast_max, `${path}.contrast_max`);
  optionalFinite(settings.gamma, `${path}.gamma`);
  if (settings.blend_mode !== undefined) validateEnum(settings.blend_mode, BLEND_MODES, `${path}.blend_mode`);
  if (settings.render_mode !== undefined) validateEnum(settings.render_mode, RENDER_MODES, `${path}.render_mode`);
  if (settings.channel_blend_mode !== undefined) {
    validateEnum(settings.channel_blend_mode, BLEND_MODES, `${path}.channel_blend_mode`);
  }
  if (settings.detail_level_override !== undefined && settings.detail_level_override !== null) {
    uint(settings.detail_level_override, `${path}.detail_level_override`);
  }
  if (settings.channel_settings !== undefined) {
    if (!Array.isArray(settings.channel_settings)) fail(`${path}.channel_settings`, "an array", settings.channel_settings);
    settings.channel_settings.forEach((entry, index) => validateChannel(entry, `${path}.channel_settings[${index}]`));
  }
  if (settings.label_settings !== undefined) {
    if (!Array.isArray(settings.label_settings)) fail(`${path}.label_settings`, "an array", settings.label_settings);
    settings.label_settings.forEach((entry, index) => {
      const label = record(entry, `${path}.label_settings[${index}]`);
      optionalBool(label.visible, `${path}.label_settings[${index}].visible`);
      optionalFinite(label.opacity, `${path}.label_settings[${index}].opacity`);
    });
  }
  validateStringArray(settings.label_names, `${path}.label_names`, true);
}

function validateChannel(value: unknown, path: string): void {
  const channel = record(value, path);
  optionalBool(channel.visible, `${path}.visible`);
  if (channel.colormap !== undefined) validateEnum(channel.colormap, COLORMAPS, `${path}.colormap`);
  optionalFinite(channel.contrast_min, `${path}.contrast_min`);
  optionalFinite(channel.contrast_max, `${path}.contrast_max`);
  optionalFinite(channel.gamma, `${path}.gamma`);
  optionalText(channel.name, `${path}.name`);
}

// Defaults stripping (encode-side).
// Anything that matches the default in `lucida-core/src/scene/types.rs` and
// `lucida-core/src/view.rs` gets dropped on the wire. The decoder re-fills.
// This is purely a payload-size optimization — the round-trip identity is
// preserved by the corresponding `restoreDefaults` step.

function stripDefaults(view: SavedView): Record<string, unknown> {
  const out: Record<string, unknown> = {
    v: view.v,
    camera: view.camera,
  };
  if (view.datasets.length > 0) out.datasets = view.datasets;
  if (Object.keys(view.active_layouts).length > 0) out.active_layouts = view.active_layouts;
  if (view.dataset_order.length > 0) out.dataset_order = view.dataset_order;

  const view_stripped = stripViewState(view.view);
  if (view_stripped !== undefined) out.view = view_stripped;

  const display_stripped = stripDisplay(view.display);
  if (display_stripped !== undefined) out.display = display_stripped;

  const settings_stripped: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(view.dataset_settings)) {
    // Preserve every key the sender tracked, even if all-default. The
    // entry collapses to `{}` (or `{channel_settings: [{}, ...]}`) on the
    // wire so roundtrip identity holds — the channel count is the only
    // structural fact we have to preserve explicitly.
    settings_stripped[id] = stripDatasetSettings(s);
  }
  if (Object.keys(settings_stripped).length > 0) {
    out.dataset_settings = settings_stripped;
  }
  // auto_contrast: only emit non-default (`false`) entries — the recipient
  // applies `true` for any dataset not present in the map.
  if (view.auto_contrast) {
    const stripped: Record<string, boolean> = {};
    for (const [id, val] of Object.entries(view.auto_contrast)) {
      if (val === false) stripped[id] = false;
    }
    if (Object.keys(stripped).length > 0) out.auto_contrast = stripped;
  }
  return out;
}

function stripViewState(v: ViewState): ViewState | undefined {
  const out: Partial<ViewState> = {};
  let any = false;
  if (v.z_range.start !== 0 || v.z_range.end !== 1) {
    out.z_range = v.z_range;
    any = true;
  }
  if (v.t !== 0) {
    out.t = v.t;
    any = true;
  }
  if (v.c !== 0) {
    out.c = v.c;
    any = true;
  }
  if (v.multi_channel === true) {
    out.multi_channel = true;
    any = true;
  }
  return any ? (out as ViewState) : undefined;
}

function stripDisplay(d: DisplayState): DisplayState | undefined {
  const isDefault =
    d.contrast_min === 0 && d.contrast_max === 65535 && d.gamma === 1.0;
  return isDefault ? undefined : d;
}

function stripDatasetSettings(s: DatasetDisplaySettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.visible !== true) out.visible = s.visible;
  if (s.opacity !== 1.0) out.opacity = s.opacity;
  if (s.contrast_min !== 0) out.contrast_min = s.contrast_min;
  if (s.contrast_max !== 65535) out.contrast_max = s.contrast_max;
  if (s.gamma !== 1.0) out.gamma = s.gamma;
  if (s.blend_mode !== "alpha") out.blend_mode = s.blend_mode;
  if (s.render_mode !== undefined && s.render_mode !== "translucent") {
    out.render_mode = s.render_mode;
  }
  if (s.channel_blend_mode !== undefined && s.channel_blend_mode !== "additive") {
    out.channel_blend_mode = s.channel_blend_mode;
  }
  if (typeof s.detail_level_override === "number") {
    out.detail_level_override = s.detail_level_override;
  }
  // `channel_settings` length is structural — preserve it exactly so
  // roundtrip identity holds. Empty per-channel objects (`{}`) signal
  // "all defaults at this index" and are restored via `defaultChannel`.
  if (s.channel_settings && s.channel_settings.length > 0) {
    out.channel_settings = s.channel_settings.map((c, i) =>
      stripChannel(c, i) ?? {},
    );
  }
  if (s.label_settings && s.label_settings.length > 0) {
    out.label_settings = s.label_settings;
  }
  if (s.label_names && s.label_names.length > 0) {
    out.label_names = s.label_names;
  }
  return out;
}

function stripChannel(c: ChannelSettings, index: number): Record<string, unknown> | undefined {
  const defaultColormap = DEFAULT_COLORMAP_CYCLE[index % DEFAULT_COLORMAP_CYCLE.length];
  const out: Record<string, unknown> = {};
  let any = false;
  if (c.visible !== true) { out.visible = c.visible; any = true; }
  if (c.colormap !== defaultColormap) { out.colormap = c.colormap; any = true; }
  if (c.contrast_min !== 0) { out.contrast_min = c.contrast_min; any = true; }
  if (c.contrast_max !== 65535) { out.contrast_max = c.contrast_max; any = true; }
  if (c.gamma !== 1.0) { out.gamma = c.gamma; any = true; }
  // The default override is "none" (absent), so any present name is non-default
  // and must ride the wire. Mirrors the Rust `skip_serializing_if` on `name`.
  if (c.name !== undefined) { out.name = c.name; any = true; }
  return any ? out : undefined;
}

// Mirrors `Colormap::default_for_channel` in `lucida-core/src/scene/types.rs`.
const DEFAULT_COLORMAP_CYCLE = ["magenta", "green", "cyan"] as const;

// Defaults restoration (decode-side)

function restoreDefaults(obj: Record<string, unknown>): SavedView {
  const out: SavedView = {
    v: obj.v as number,
    datasets: (obj.datasets as string[] | undefined) ?? [],
    active_layouts: (obj.active_layouts as Record<string, string> | undefined) ?? {},
    camera: obj.camera as SavedView["camera"],
    view: restoreView(obj.view),
    display: restoreDisplay(obj.display),
    dataset_order: (obj.dataset_order as string[] | undefined) ?? [],
    dataset_settings: restoreDatasetSettingsMap(obj.dataset_settings),
    auto_contrast: (obj.auto_contrast as Record<string, boolean> | undefined) ?? undefined,
  };
  return out;
}

function restoreView(v: unknown): ViewState {
  const partial = (v as Partial<ViewState> | undefined) ?? {};
  return {
    z_range: partial.z_range ?? { start: 0, end: 1 },
    t: partial.t ?? 0,
    c: partial.c ?? 0,
    multi_channel: partial.multi_channel ?? false,
  };
}

function restoreDisplay(d: unknown): DisplayState {
  const partial = (d as Partial<DisplayState> | undefined) ?? {};
  return {
    contrast_min: partial.contrast_min ?? 0,
    contrast_max: partial.contrast_max ?? 65535,
    gamma: partial.gamma ?? 1.0,
  };
}

function restoreDatasetSettingsMap(
  raw: unknown,
): Record<string, DatasetDisplaySettings> {
  const out: Record<string, DatasetDisplaySettings> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [id, partial] of Object.entries(raw as Record<string, unknown>)) {
    out[id] = restoreDatasetSettings(partial);
  }
  return out;
}

function restoreDatasetSettings(p: unknown): DatasetDisplaySettings {
  const partial = (p as Partial<DatasetDisplaySettings> | undefined) ?? {};
  const channels = partial.channel_settings;
  const out: DatasetDisplaySettings = {
    visible: partial.visible ?? true,
    opacity: partial.opacity ?? 1.0,
    contrast_min: partial.contrast_min ?? 0,
    contrast_max: partial.contrast_max ?? 65535,
    gamma: partial.gamma ?? 1.0,
    blend_mode: partial.blend_mode ?? "alpha",
    render_mode: partial.render_mode ?? "translucent",
    channel_blend_mode: partial.channel_blend_mode ?? "additive",
    channel_settings: channels ? channels.map((c, i) => restoreChannel(c, i)) : [],
  };
  if (typeof partial.detail_level_override === "number") {
    out.detail_level_override = partial.detail_level_override;
  }
  if (partial.label_settings) {
    out.label_settings = partial.label_settings.map((label) => ({
      visible: label.visible ?? true,
      opacity: label.opacity ?? 1,
    }));
  }
  if (partial.label_names) out.label_names = [...partial.label_names];
  return out;
}

function restoreChannel(p: Partial<ChannelSettings>, index: number): ChannelSettings {
  const defaultColormap = DEFAULT_COLORMAP_CYCLE[index % DEFAULT_COLORMAP_CYCLE.length];
  const out: ChannelSettings = {
    visible: p.visible ?? true,
    colormap: p.colormap ?? defaultColormap,
    contrast_min: p.contrast_min ?? 0,
    contrast_max: p.contrast_max ?? 65535,
    gamma: p.gamma ?? 1.0,
  };
  // Restore the user override only when present, so a channel with no name
  // stays `name: undefined` (round-trip identity with a pre-slice payload).
  if (p.name !== undefined) out.name = p.name;
  return out;
}

// gzip / gunzip via CompressionStream

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  // Wrap in a Blob so the BodyInit overload is unambiguous (a raw
  // `Uint8Array<ArrayBufferLike>` doesn't satisfy the lib.dom typing).
  const stream = new Response(new Blob([bytes as BlobPart])).body!
    .pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(new Blob([bytes as BlobPart])).body!
    .pipeThrough(new DecompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// base64url.
// btoa expects a binary string. We chunk the bytes to avoid blowing the
// argument-list size on long payloads (typical limit ~64K).

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  const b64 = btoa(s);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4;
  const padded = pad === 0 ? s : s + "=".repeat(4 - pad);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
