// Encoder/decoder for `SavedView` ↔ URL-hash payload (PRD #454, slice 1).
// Pure functions; no DOM, no scene, no bridge — fully testable in isolation.
//
// Pipeline on encode:
//   SavedView → strip defaults → JSON → gzip (CompressionStream) → base64url
//
// Pipeline on decode:
//   base64url → gunzip (DecompressionStream) → JSON → restore defaults
//     → reject if `v` missing/zero; warn if `v > SAVED_VIEW_VERSION` and
//       best-effort apply known fields
//
// Both flows are async because `CompressionStream` is stream-based.
//
// Defaults stripping is what keeps a 384-well plate share link < 1 KB —
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

// --- Public API ----------------------------------------------------------

export async function encode(view: SavedView): Promise<string> {
  const stripped = stripDefaults(view);
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
  return validateAndRestore(parsed);
}

export class SavedViewDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedViewDecodeError";
  }
}

// --- Validation + version handling --------------------------------------

function validateAndRestore(raw: unknown): SavedView {
  if (typeof raw !== "object" || raw === null) {
    throw new SavedViewDecodeError("payload must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const v = obj.v;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new SavedViewDecodeError(`missing or invalid version (got ${JSON.stringify(v)})`);
  }
  if (v > SAVED_VIEW_VERSION) {
    // Best-effort: warn but try to consume known fields. Future versions
    // are expected to be additive; if they aren't, downstream apply will
    // surface a clean error per the failure-handling policy.
    console.warn(
      `[SavedView] payload version ${v} exceeds known version ${SAVED_VIEW_VERSION}; applying best-effort.`,
    );
  }
  return restoreDefaults(obj);
}

// --- Defaults stripping (encode-side) -----------------------------------
//
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
  // `channel_settings` length is structural — preserve it exactly so
  // roundtrip identity holds. Empty per-channel objects (`{}`) signal
  // "all defaults at this index" and are restored via `defaultChannel`.
  if (s.channel_settings && s.channel_settings.length > 0) {
    out.channel_settings = s.channel_settings.map((c, i) =>
      stripChannel(c, i) ?? {},
    );
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
  return any ? out : undefined;
}

// Mirrors `Colormap::default_for_channel` in `lucida-core/src/scene/types.rs`.
const DEFAULT_COLORMAP_CYCLE = ["magenta", "green", "cyan"] as const;

// --- Defaults restoration (decode-side) ---------------------------------

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
  return {
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
}

function restoreChannel(p: Partial<ChannelSettings>, index: number): ChannelSettings {
  const defaultColormap = DEFAULT_COLORMAP_CYCLE[index % DEFAULT_COLORMAP_CYCLE.length];
  return {
    visible: p.visible ?? true,
    colormap: p.colormap ?? defaultColormap,
    contrast_min: p.contrast_min ?? 0,
    contrast_max: p.contrast_max ?? 65535,
    gamma: p.gamma ?? 1.0,
  };
}

// --- gzip / gunzip via CompressionStream --------------------------------

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

// --- base64url ---------------------------------------------------------
//
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
