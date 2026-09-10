/**
 * The bundle: one file that carries everything a reader needs to read a run
 * and everything the driver needs to replay it (#1055).
 *
 * A saved run is the trace document alone. A bundle adds the settled frame as
 * a PNG at the run's device pixel ratio, the view URL, the planning
 * configuration, the level and display pins, the server's dataset health
 * counters, the diagnostic with its text renderings, and a header sufficient
 * for replay. One function produces it behind the trace seam, so the bundle a
 * person saves from the monitor and the bundle `lucida trace` writes are the
 * same artifact (ADR 0051 as amended).
 *
 * Where a field comes from decides what it means. The view URL, viewport,
 * device pixel ratio, mode, build, adapter, and cache warmth are read off the
 * header the recorder closed the run with, so a bundle saved long after a run
 * describes the view the run measured rather than the view on screen when
 * somebody pressed the button. The pins are decoded from that same view URL
 * for the same reason. Two things have no record in the trace and are read
 * when the bundle is made: the planning configuration and the server's health
 * counters. The header says when that was.
 */

import type { DatasetSourceHealth } from "../bridge.ts";
import type { PlanningConfig } from "../pipeline/planning/config.ts";
import type { FrameCaptureResult } from "../renderer/workerProtocol.ts";
import { decode } from "../savedView/encoder.ts";
import type { Colormap, RenderMode, SavedView } from "../savedView/types.ts";
import { toChromeTraceJson } from "./chromeTrace.ts";
import { diagnoseRun } from "./diagnose/diagnose.ts";
import { renderDiagnostic } from "./diagnose/renderText.ts";
import type { ChunkLookup, DiagnosticDocument } from "./diagnose/types.ts";
import { flatColourOf, type PngDecoder, type Rect } from "./flatFrame.ts";
import type {
  BuildIdentity,
  CacheWarmth,
  EndReason,
  GpuIdentity,
  RunCause,
  TraceDocument,
  TraceRun,
  Viewport,
} from "./types.ts";

/** What a bundle file says it is, so a reader can tell it from a saved run. */
export const BUNDLE_FORMAT = "lucida-trace-bundle";

/**
 * The bundle's own version, independent of the trace schema it carries.
 * Bumped when the bundle's shape changes incompatibly.
 */
export const BUNDLE_VERSION = 1;

/**
 * The header fields the driver needs to replay a bundle, in the order the
 * spec names them (#1048): dataset, view URL, viewport, device pixel ratio,
 * mode, planning configuration, the level, render mode, contrast and colormap
 * pins, build, adapter, and cache warmth. `pins` carries the four pin kinds
 * per dataset. Every other header field is in {@link IDENTITY_HEADER_FIELDS};
 * the two lists partition the header, and tests on both sides of the golden
 * fixture assert that, so a field added to the header lands in one list or
 * fails.
 */
export const REPLAY_HEADER_FIELDS = [
  "datasets",
  "viewUrl",
  "viewport",
  "devicePixelRatio",
  "mode",
  "planning",
  "pins",
  "build",
  "gpu",
  "cacheWarmth",
] as const satisfies readonly (keyof BundleHeader)[];

/** The header fields that say which run this is and when the bundle was made. Not replay inputs. */
export const IDENTITY_HEADER_FIELDS = [
  "runId",
  "cause",
  "endReason",
  "startedAtEpochMs",
  "durationUs",
  "quiescenceHoldMs",
  "savedAtEpochMs",
] as const satisfies readonly (keyof BundleHeader)[];

/** One dataset the run loaded, named the way `lucida trace <dataset>` takes it. */
export interface BundleDataset {
  id: string;
  /** Null when the server's health did not name it. */
  name: string | null;
  /** The canonical source URL, or null when the server's health did not carry it. */
  sourceUrl: string | null;
}

/**
 * The pins one dataset carried in the run's view. Null means the view URL
 * carried nothing for that dataset, never that the pin was absent. A bundle
 * whose URL has no view cannot say what the page had pinned.
 */
export interface DatasetPins {
  datasetId: string;
  /** The level pin. Absent means the target followed the screen (ADR 0061). */
  level: number | null;
  renderMode: RenderMode | null;
  /** One window per channel. */
  contrast: { min: number; max: number }[] | null;
  /** One colormap per channel. */
  colormap: Colormap[] | null;
  /** Whether the page fitted the contrast window to the data as it arrived. */
  autoContrast: boolean | null;
}

export interface BundleHeader {
  /** Null when the page recorded no run. */
  runId: string | null;
  cause: RunCause | null;
  endReason: EndReason | null;
  startedAtEpochMs: number | null;
  durationUs: number | null;
  quiescenceHoldMs: number | null;
  /** When the bundle was made. The planning configuration and the health were read then. */
  savedAtEpochMs: number;
  datasets: BundleDataset[];
  /** The page the run happened on, absolute, view fragment and all. */
  viewUrl: string | null;
  viewport: Viewport | null;
  devicePixelRatio: number | null;
  mode: "slice" | "volume" | null;
  planning: PlanningConfig;
  pins: DatasetPins[];
  build: BuildIdentity | null;
  gpu: GpuIdentity | null;
  /** What the browser already held when the run opened. */
  cacheWarmth: CacheWarmth | null;
}

/**
 * The frame, taken when the bundle is made. The page reads what is on its
 * canvas then. For the driver that is the settled frame. For a person saving
 * an older run from the monitor it is whatever is on screen now, and the
 * header's `savedAtEpochMs` dates it.
 */
export interface BundleFrame {
  /** PNG bytes, base64. */
  png: string;
  /** Device pixels. */
  width: number;
  height: number;
  /** The page's ratio when the frame was taken. Null where no page was there to say. */
  devicePixelRatio: number | null;
  /**
   * Who took the frame. The page reads its own canvas through the render
   * worker, from inside a rendered frame, and that is the frame from any
   * caller with a page: the monitor's buttons and the driver alike. The
   * driver also takes a screenshot over the DevTools protocol, which exists
   * even when the worker never came up, and hands it over as the fallback.
   * The page carries that only when its own capture fails, and then
   * `fallbackReason` says why. This is the one section of a bundle that
   * depends on the caller, and it says so.
   */
  capturedBy: "page" | "driver";
  /**
   * Why the page's own capture failed, on a frame the caller's fallback
   * stood in for. Absent on a frame the page took, and on a frame a caller
   * passed as `frame` to be carried as given.
   */
  fallbackReason?: string;
}

/**
 * The server's dataset health when the bundle was made. The driver makes its
 * bundle as soon as the run closes, so for a driven run this is the health
 * at close. A person saving from the monitor can save an older run, and then
 * these are the counters at save time, which `fetchedAtEpochMs` dates
 * against the run's own start and duration in the header.
 */
export interface BundleHealth {
  fetchedAtEpochMs: number;
  /**
   * The server's dataset health for the run's datasets, as the dataset health
   * message reports it: source reads, cache hits and misses, and the
   * generated-coarse counts.
   */
  datasets: DatasetSourceHealth[];
}

/** A section the bundle could not capture, with the reason, so an absence is a statement and not a gap. */
export interface BundleAbsence {
  section: "frame" | "health";
  reason: string;
}

/** The text renderings of the diagnostic, at every depth the show command reads. */
export interface BundleRenderings {
  summary: string;
  phases: string;
  /** One rendering per phase, keyed by phase id. */
  perPhase: Record<string, string>;
  /** What is where: rows by state and level with their boxes. */
  spatial: string;
  /**
   * The chunk reading the document points at, keyed by its selector, with
   * the section it was rendered from so a JSON reading names the same chunk.
   * Any other chunk needs the page.
   */
  perChunk: Record<string, { text: string; section: ChunkLookup | null }>;
}

export interface TraceBundle {
  format: typeof BUNDLE_FORMAT;
  bundleVersion: number;
  /** The trace document's schema version. */
  schemaVersion: number;
  header: BundleHeader;
  renderings: BundleRenderings;
  /** The diagnostic exactly as the page derived it, or null when there was no run to read. */
  diagnostic: DiagnosticDocument | null;
  /** The full trace document, every retained run included. */
  trace: TraceDocument;
  frame: BundleFrame | null;
  health: BundleHealth | null;
  absent: BundleAbsence[];
  /** The Chrome Trace Event projection, only when asked for. Off by default. */
  perfetto: string | null;
  /**
   * The trace driver's script, when the driver ran one: its steps in order,
   * each with the run it opened and the view before and after. The page
   * carries it so a replay can run the same steps, and reads nothing from
   * it. Null for a bundle the monitor saved or a driver run with no script.
   */
  script: BundleScript | null;
}

/**
 * What the driver hands over about its script. The step shape is the
 * driver's own and is kept as it arrived; a reader that wants the fields goes
 * to the CLI, which writes and reads them.
 */
export interface BundleScript {
  steps: Record<string, unknown>[];
}

/**
 * What the viewer registers so a bundle can carry more than the trace: the
 * server's health counters and the frame on the canvas. Both are live
 * services, not state, which is why they are registered and not recorded.
 */
export interface BundleServices {
  requestDatasetHealth(): Promise<DatasetSourceHealth[]>;
  /** The frame on the canvas, or the reason the render worker could not read one. */
  captureFrame(): Promise<FrameCaptureResult>;
  /**
   * Where the render canvas is on the page, in CSS pixels, clipped to the
   * document's client area so a scrollbar falls outside it. Null when no
   * canvas is mounted or none of it is in view. The flat-colour check on a
   * fallback frame reads this region of the screenshot.
   */
  canvasRect(): Rect | null;
}

export interface BundleOptions {
  /** The run to carry. The newest when absent. A run the trace does not hold is an error. */
  runId?: string;
  /** A frame the caller already has, carried as given. The page captures none. */
  frame?: BundleFrame;
  /**
   * A frame for the page to carry only when its own capture fails, which is
   * how the driver hands over its DevTools screenshot. The page's capture
   * comes first because it copies the canvas texture from inside a rendered
   * frame, while a screenshot can leave a WebGPU canvas out: headless Chrome
   * on Vulkan returns solid black for it (#1098). So a fallback whose canvas
   * region decodes to one flat colour is not carried either. The bundle
   * records the frame as absent and names the colour. Ignored when `frame`
   * is given.
   */
  fallbackFrame?: BundleFrame;
  /** Include the Chrome Trace Event projection. Off by default. */
  perfetto?: boolean;
  /** The driver's script and what each step did. Carried as given. */
  script?: BundleScript | null;
}

/** Everything `exportBundle` reads from the page, injectable so the assembly is assertable without one. */
export interface BundleContext {
  /** The trace seam's export. Closes the run in progress, as every export does. */
  exportTrace(): TraceDocument;
  services: BundleServices | null;
  planning: PlanningConfig;
  /** The page's origin, or null where there is no page. */
  origin: string | null;
  /** The page's device pixel ratio now, which is what a frame the page takes is at. Null where there is no page. */
  devicePixelRatio: number | null;
  /**
   * The page's PNG decoder, through its 2D canvas, which the flat-colour
   * check on a fallback frame reads through. Null where there is no page,
   * and then a fallback frame is carried unchecked and says so.
   */
  decodePng: PngDecoder | null;
  /** Wall-clock epoch milliseconds. */
  now: number;
}

let registered: BundleServices | null = null;

/**
 * Register the viewer's services, or withdraw them with null. Called by the
 * app once the session socket and the render client exist.
 */
export function setBundleServices(services: BundleServices | null): void {
  registered = services;
}

export function bundleServices(): BundleServices | null {
  return registered;
}

/** The file name for a bundle, named for the run so the file and the follow-up command agree. */
export function bundleFilename(bundle: TraceBundle): string {
  return `lucida-${bundle.header.runId ?? "empty"}.bundle.json`;
}

/**
 * Make the bundle. The frame and the health are gathered before the export,
 * so neither waits on the other and the frame is the run's last state. The
 * export then closes whatever run is open, and the run the bundle carries is
 * read out of the document that comes back.
 */
export async function exportBundle(
  context: BundleContext,
  options: BundleOptions = {},
): Promise<TraceBundle> {
  const absent: BundleAbsence[] = [];
  const [frameResult, healthResult] = await Promise.all([
    options.frame
      ? Promise.resolve(null)
      : captureFrame(context.services, context.devicePixelRatio),
    fetchHealth(context.services),
  ]);
  const trace = context.exportTrace();
  const run = selectRun(trace, options.runId);
  const view = run ? await decodeView(run.header.composedView.url) : null;
  const health = healthResult.value;
  const datasetIds = run?.header.datasetIds ?? [];

  const { value: frame, reason: frameReason } = frameResult
    ? await resolveFrame(frameResult, options.fallbackFrame, context)
    : { value: options.frame ?? null, reason: null };
  if (!frame) absent.push({ section: "frame", reason: frameReason ?? "no frame was captured" });
  if (!health) absent.push({ section: "health", reason: healthResult.reason ?? "no health was fetched" });

  const diagnostic = run ? diagnose(run) : null;
  return {
    format: BUNDLE_FORMAT,
    bundleVersion: BUNDLE_VERSION,
    schemaVersion: trace.schemaVersion,
    header: buildHeader(run, view, health, context),
    renderings: render(diagnostic),
    diagnostic: diagnostic?.document ?? null,
    trace,
    frame,
    health: health
      ? {
          fetchedAtEpochMs: context.now,
          datasets:
            datasetIds.length > 0
              ? health.filter((entry) => datasetIds.includes(entry.workspace_dataset_id))
              : health,
        }
      : null,
    absent,
    perfetto: options.perfetto ? toChromeTraceJson(trace) : null,
    script: options.script ?? null,
  };
}

function selectRun(trace: TraceDocument, runId: string | undefined): TraceRun | null {
  if (runId === undefined) return trace.runs[trace.runs.length - 1] ?? null;
  const run = trace.runs.find((candidate) => candidate.header.runId === runId);
  if (!run) throw new Error(`no run ${runId} in this trace document`);
  return run;
}

interface Captured<T> {
  value: T | null;
  reason: string | null;
}

/**
 * A fallback that stands in carries the page's failure as its
 * `fallbackReason`, so a reader learns why the picture is a screenshot. A
 * fallback the page cannot check is carried too, and says so: a frame that
 * exists beats an absence decided on a guess.
 */
async function resolveFrame(
  captured: Captured<BundleFrame>,
  fallback: BundleFrame | undefined,
  context: BundleContext,
): Promise<Captured<BundleFrame>> {
  if (captured.value) return captured;
  const failure = captured.reason ?? "no frame was captured";
  if (!fallback) return { value: null, reason: failure };
  const region = canvasRegion(fallback, context);
  const check = await flatColourOfPng(fallback.png, region, context.decodePng);
  if (check.colour) {
    const where = region ? "the canvas region of the fallback frame" : "the fallback frame";
    return {
      value: null,
      reason:
        `${failure}; ${where} from the ${fallback.capturedBy} was one flat colour, ` +
        `${check.colour}, so the screenshot did not include the canvas and was not kept`,
    };
  }
  const fallbackReason = check.unchecked
    ? `${failure}; the fallback frame was carried unchecked because ${check.unchecked}`
    : failure;
  return { value: { ...fallback, fallbackReason }, reason: null };
}

function canvasRegion(fallback: BundleFrame, context: BundleContext): Rect | null {
  const rect = context.services?.canvasRect() ?? null;
  if (!rect) return null;
  const scale = fallback.devicePixelRatio ?? context.devicePixelRatio ?? 1;
  return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}

async function flatColourOfPng(
  base64: string,
  region: Rect | null,
  decodePng: PngDecoder | null,
): Promise<{ colour: string | null; unchecked: string | null }> {
  if (!decodePng) return { colour: null, unchecked: "there was no page to decode it" };
  try {
    const image = await decodePng(base64ToBytes(base64));
    return { colour: flatColourOf(image, region), unchecked: null };
  } catch (error) {
    return { colour: null, unchecked: `it could not be decoded: ${message(error)}` };
  }
}

async function captureFrame(
  services: BundleServices | null,
  devicePixelRatio: number | null,
): Promise<Captured<BundleFrame>> {
  if (!services) {
    return {
      value: null,
      reason: "the viewer was not registered with the seam, so there was no canvas to read",
    };
  }
  try {
    const captured = await services.captureFrame();
    if (!captured.frame) return { value: null, reason: captured.reason };
    const { png, width, height } = captured.frame;
    return {
      value: {
        png: bytesToBase64(new Uint8Array(png)),
        width,
        height,
        devicePixelRatio,
        capturedBy: "page",
      },
      reason: null,
    };
  } catch (error) {
    return { value: null, reason: `the frame capture failed: ${message(error)}` };
  }
}

async function fetchHealth(
  services: BundleServices | null,
): Promise<Captured<DatasetSourceHealth[]>> {
  if (!services) {
    return {
      value: null,
      reason: "the viewer was not registered with the seam, so the server was not asked",
    };
  }
  try {
    return { value: await services.requestDatasetHealth(), reason: null };
  } catch (error) {
    return { value: null, reason: `the dataset health request failed: ${message(error)}` };
  }
}

/**
 * The view the run's URL carries, or null when it carries none or cannot be
 * read. A URL that fails to decode is not an error here. The bundle still
 * carries the URL verbatim, and the pins say they are unknown.
 */
async function decodeView(url: string): Promise<SavedView | null> {
  const payload = viewPayload(url);
  if (!payload) return null;
  try {
    return await decode(payload);
  } catch {
    return null;
  }
}

/** The `view=` value of a URL's fragment, which may share the fragment with other `&`-separated parts. */
function viewPayload(url: string): string | null {
  const hash = url.indexOf("#");
  if (hash < 0) return null;
  for (const part of url.slice(hash + 1).split("&")) {
    if (part.startsWith("view=")) return part.slice("view=".length) || null;
  }
  return null;
}

function buildHeader(
  run: TraceRun | null,
  view: SavedView | null,
  health: DatasetSourceHealth[] | null,
  context: BundleContext,
): BundleHeader {
  const header = run?.header ?? null;
  const datasetIds = header?.datasetIds ?? [];
  const relative = header?.composedView.url ?? "";
  return {
    runId: header?.runId ?? null,
    cause: header?.cause ?? null,
    endReason: header?.endReason ?? null,
    startedAtEpochMs: header?.startedAtEpochMs ?? null,
    durationUs: header?.durationUs ?? null,
    quiescenceHoldMs: header?.quiescenceHoldMs ?? null,
    savedAtEpochMs: context.now,
    datasets: datasetIds.map((id) => {
      const entry = health?.find((candidate) => candidate.workspace_dataset_id === id) ?? null;
      return { id, name: entry?.name ?? null, sourceUrl: entry?.source_url ?? null };
    }),
    viewUrl: relative ? `${context.origin ?? ""}${relative}` : null,
    viewport: header?.viewport ?? null,
    devicePixelRatio: header?.devicePixelRatio ?? null,
    mode: header?.composedView.mode ?? null,
    planning: context.planning,
    pins: datasetIds.map((datasetId) => pinsFor(datasetId, view)),
    build: header?.build ?? null,
    gpu: header?.gpu ?? null,
    cacheWarmth: header?.cacheWarmth ?? null,
  };
}

function pinsFor(datasetId: string, view: SavedView | null): DatasetPins {
  const settings = view?.dataset_settings[datasetId];
  if (!view || !settings) {
    return {
      datasetId,
      level: null,
      renderMode: null,
      contrast: null,
      colormap: null,
      autoContrast: null,
    };
  }
  const channels = settings.channel_settings ?? [];
  return {
    datasetId,
    level: settings.detail_level_override ?? null,
    renderMode: settings.render_mode ?? null,
    contrast:
      channels.length > 0
        ? channels.map((channel) => ({ min: channel.contrast_min, max: channel.contrast_max }))
        : [{ min: settings.contrast_min, max: settings.contrast_max }],
    colormap: channels.length > 0 ? channels.map((channel) => channel.colormap) : null,
    // Omitted on the wire means the default, which is on, for every dataset.
    autoContrast: view.auto_contrast?.[datasetId] ?? true,
  };
}

interface Diagnosed {
  document: DiagnosticDocument | null;
  failure: string | null;
}

/** A run the derivation cannot read still gets a bundle, and the bundle says so. */
function diagnose(run: TraceRun): Diagnosed {
  try {
    return { document: diagnoseRun(run), failure: null };
  } catch (error) {
    return { document: null, failure: `diagnosis failed: ${message(error)}` };
  }
}

const NO_RUN_RECORDED =
  "no run was recorded: the page never opened one, so there is nothing to read.";

/**
 * Every rendering the show command can ask for, taken now, because the
 * browser that can render them is gone by the time a bundle is read. A
 * rendering that fails reports itself in place instead of losing the bundle.
 */
function render(diagnosed: Diagnosed | null): BundleRenderings {
  if (!diagnosed) {
    return { summary: NO_RUN_RECORDED, phases: NO_RUN_RECORDED, perPhase: {}, spatial: NO_RUN_RECORDED, perChunk: {} };
  }
  const document = diagnosed.document;
  if (!document) {
    const failure = diagnosed.failure ?? "diagnosis failed";
    return { summary: failure, phases: failure, perPhase: {}, spatial: failure, perChunk: {} };
  }
  const attempt = (make: () => string): string => {
    try {
      return make();
    } catch (error) {
      return `rendering failed: ${message(error)}`;
    }
  };
  const perPhase: Record<string, string> = {};
  for (const phase of document.phases) {
    perPhase[phase.id] = attempt(
      () => renderDiagnostic(document, { depth: "phase", phase: phase.id }).text,
    );
  }
  const perChunk: BundleRenderings["perChunk"] = {};
  const selector = document.chunk.selector;
  if (selector !== null) {
    perChunk[selector] = {
      text: attempt(() => renderDiagnostic(document, { depth: "chunk" }).text),
      section: document.chunk,
    };
  }
  return {
    summary: attempt(() => renderDiagnostic(document).text),
    phases: attempt(() => renderDiagnostic(document, { depth: "phases" }).text),
    perPhase,
    spatial: attempt(() => renderDiagnostic(document, { depth: "spatial" }).text),
    perChunk,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Base64 without building one string of every byte, which a retina frame would overflow. */
export function bytesToBase64(bytes: Uint8Array): string {
  const step = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

/** The bytes a base64 string carries, as the frame's PNG rides in the bundle. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
