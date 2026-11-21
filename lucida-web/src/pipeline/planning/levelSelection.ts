/**
 * The planner's side of the core's level selection
 * (`lucida-core/src/level_selection.rs`): which level each chunk a view
 * draws comes from, within the memory budget. One call into the core per
 * view covers every visible entity of every dataset the view draws, so they
 * share one refinement order. Views share the budget max-min fairly by their
 * area on the canvas.
 *
 * Pure: the selection a view made last time is an explicit input and output
 * ({@link LevelSelectionMemory}), never a cache held here.
 */

import { select_levels } from "lucida-core";
import type { DatasetManifest } from "../../manifestTypes.ts";
import { bytesPerTexel, datasetSampleFormat, decodedBytesPerSample } from "../../renderer/dataTypeUtil.ts";
import { toPlaneFrame } from "../../renderer/slicePlane.ts";
import { groupMembers } from "./activeSet.ts";
import type { PlanningConfig } from "./config.ts";
import { slicePlaneAt } from "./emit.ts";
import { regionFields } from "./enumerate.ts";
import type {
  DatasetLevelSelection,
  EntityLevelSelection,
  EntitySnapshot,
  ViewSnapshotBase,
  ZoomDirection,
} from "./types.ts";

/**
 * `PREVIOUS_STRIDE`, `CELL_STRIDE` and `SELECTION_HEADER` in
 * `level_selection.rs`. Each entity goes in as its `ENTITY_HEADER` seven
 * numbers, then `LEVEL_STRIDE` twelve per level.
 */
const PREVIOUS_STRIDE = 6;
const CELL_STRIDE = 8;
const SELECTION_HEADER = 13;

/**
 * How far the focal zoom must move between two plans of a moving view to be
 * a zoom. A pan of a volume camera's focus moves it a little, and a wheel
 * step or a pinch far more.
 */
const ZOOM_MOVE = 1.02;

/** Bytes on each side: what the CPU cache holds, and what the GPU pools hold. */
export interface SelectionBytes {
  cpu: number;
  gpu: number;
}

/** One dataset a view draws, as the view sees it, and the manifest its chunks are priced from. */
export interface SelectionDataset {
  datasetId: string;
  view: ViewSnapshotBase;
  manifest: DatasetManifest;
}

/** One view to select for. */
export interface SelectionView {
  view: number;
  datasets: readonly SelectionDataset[];
  /** Its area on the canvas, which weighs its share of the budget against other views'. */
  area: number;
}

/** What one view's selection spent of its share, for the trace and the readout. */
export interface ViewSelectionSummary {
  used: SelectionBytes;
  /** The share of the budget the view selected within. */
  share: SelectionBytes;
  /**
   * How many device pixels a sample spans where the budget stopped the
   * refinement, or null when every chunk reached the level the screen calls for.
   */
  limit: number | null;
}

/** What the last selection chose, which the next leans toward. Callers store it and pass it back. */
export interface LevelSelectionMemory {
  readonly views: ReadonlyMap<number, ViewMemory>;
}

interface ViewMemory {
  /**
   * By dataset id, then entity id: each cell the last selection kept or
   * refined, `PREVIOUS_STRIDE` numbers with the entity index left for the
   * next call to fill in.
   */
  cells: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>;
  /** The focal zoom of the view's first dataset (`VisibleRegion.focalZoom`), as last seen. */
  zoom: number | null;
  /** That dataset's region as last seen, to tell a move from a replan of a view that held still. */
  region: string | null;
  /** Which way the zoom last moved, kept while the view holds still. */
  zoomDirection: ZoomDirection | null;
}

/** Memory before the first selection: nothing to lean toward. */
export function initialLevelSelectionMemory(): LevelSelectionMemory {
  return { views: new Map() };
}

export interface LevelSelectionResult {
  /** By view id, then dataset id. */
  byView: Map<number, Map<string, DatasetLevelSelection>>;
  summaries: Map<number, ViewSelectionSummary>;
  memory: LevelSelectionMemory;
  /**
   * Whether a view held back a refinement the screen calls for while it
   * zoomed in, so the selection has refining to do once the views stop.
   */
  held: boolean;
}

/**
 * Select the levels every view draws at, within `budget`. Each view selects
 * to `config.selectionShare` of its share, which leaves the rest for the
 * chunks a refinement replaces while the finer ones load, and for prefetch.
 * A volume view's ancestors take from that rest, up to
 * `config.ancestorShare`.
 *
 * A volume view that zooms in while the views are `moving` holds its
 * refinement: it keeps what it last chose or coarsens it, refines only what
 * comes into view, and looks ahead to the refinements it holds back, which
 * the CPU cache fetches and the GPU does not take until the view stops. A
 * zoom in calls for finer levels across the view, so each replan of a deep
 * volume would otherwise fetch and upload cells the zoom passes. An orbit or
 * a pan refines as it moves: its replans change little but what comes into
 * view. A slice view's selection is one band of planes, which the screen
 * bounds.
 */
export function selectLevels(
  views: readonly SelectionView[],
  budget: SelectionBytes,
  memory: LevelSelectionMemory,
  config: PlanningConfig,
  moving = false,
): LevelSelectionResult {
  const encoded = views.map((view) => encodeView(view, memory.views.get(view.view), config, moving));
  let runs = encoded.map((input) => runView(input, budget, config));

  // Several views share the budget. Each first selected at the whole of
  // it, which bounds the work and tells what it wants; a view wanting more
  // than its share by area selects again at its share.
  if (views.length > 1) {
    const room = scale(budget, config.selectionShare);
    const wants = (side: keyof SelectionBytes) =>
      new Map(runs.map((run, i) => [i, run.limit === null ? run.used[side] : room[side]]));
    const areas = new Map(views.map((view, i) => [i, view.area]));
    const cpu = fairShares(wants("cpu"), areas, room.cpu);
    const gpu = fairShares(wants("gpu"), areas, room.gpu);
    runs = runs.map((run, i) => {
      const share = { cpu: cpu.get(i) ?? 0, gpu: gpu.get(i) ?? 0 };
      if (run.used.cpu <= share.cpu && run.used.gpu <= share.gpu) return run;
      return runView(encoded[i], scale(share, 1 / config.selectionShare), config);
    });
  }

  const byView = new Map<number, Map<string, DatasetLevelSelection>>();
  const summaries = new Map<number, ViewSelectionSummary>();
  const remembered = new Map<number, ViewMemory>();
  views.forEach((view, i) => {
    const run = runs[i];
    byView.set(view.view, run.datasets);
    summaries.set(view.view, { used: run.used, share: scale(run.budget, config.selectionShare), limit: run.limit });
    const { zoom, region, zoomDirection } = encoded[i];
    remembered.set(view.view, { cells: run.cells, zoom, region, zoomDirection });
  });
  return { byView, summaries, memory: { views: remembered }, held: runs.some((run) => run.held) };
}

/** Which dataset and entity each entity index of a view's call stands for. */
interface Owner {
  datasetId: string;
  entityId: string;
  /** The level the coarse tier holds, where cells cost the detail tier nothing, or null. */
  coarse: number | null;
}

interface EncodedView {
  regions: string;
  entities: Float64Array;
  previous: Float64Array;
  owners: Owner[];
  datasetIds: string[];
  lookahead: number;
  /** Whether the selection refines none of the cells the previous one kept. */
  holdRefinement: boolean;
  /** The scale of the frames the view keeps ancestors for, or 0 for none. */
  ancestorScale: number;
  zoom: number | null;
  region: string | null;
  zoomDirection: ZoomDirection | null;
}

function encodeView(
  view: SelectionView,
  memory: ViewMemory | undefined,
  config: PlanningConfig,
  moving: boolean,
): EncodedView {
  const regions: Record<string, unknown>[] = [];
  const entities: number[] = [];
  const previous: number[] = [];
  const owners: Owner[] = [];
  for (const dataset of view.datasets) {
    const region = regions.push(regionFields(dataset.view.visibleRegion)) - 1;
    const remembered = memory?.cells.get(dataset.datasetId);
    const costOf = levelCosts(dataset, config);
    for (const entity of visibleTiles(dataset.view.entities)) {
      if (entity.levels.length === 0) continue;
      const index = owners.length;
      const coarse = usableCoarseLevel(entity);
      owners.push({ datasetId: dataset.datasetId, entityId: entity.entityId, coarse });
      entities.push(
        region,
        entity.layoutPositionVox[0],
        entity.layoutPositionVox[1],
        coarse ?? -1,
        entity.levelPinned ? entity.targetLevel : -1,
        config.detailRenderRadiusView,
        entity.levels.length,
      );
      entity.levels.forEach((geo, level) => {
        const [, , z, y, x] = geo.shape;
        const [, , cz, cy, cx] = geo.chunk_shape;
        const [, , gz, gy, gx] = geo.grid_shape;
        const cost = costOf(entity, level);
        entities.push(x, y, z, cx, cy, cz, gx, gy, gz, cost.cpu, cost.gpu, entity.sourceLevels.includes(level) ? 1 : 0);
      });
      const cells = remembered?.get(entity.entityId) ?? [];
      for (let at = 0; at + PREVIOUS_STRIDE <= cells.length; at += PREVIOUS_STRIDE) {
        previous.push(index, cells[at + 1], cells[at + 2], cells[at + 3], cells[at + 4], cells[at + 5]);
      }
    }
  }

  // The selection looks ahead the way the view last zoomed, through the
  // replans of a view that holds still while its chunks arrive. A move that
  // is not a zoom, an orbit or a pan, ends it: its lookahead would follow the
  // view's near side around and fetch cells nothing draws. A held zoom in
  // looks ahead first to the refinements it holds back.
  const first = view.datasets[0]?.view.visibleRegion;
  const zoom = first === undefined ? null : first.focalZoom ?? first.effectiveZoom;
  const region = regions.length === 0 ? null : JSON.stringify(regions[0]);
  let zoomDirection = memory?.zoomDirection ?? null;
  if (zoom !== null && memory?.zoom != null && region !== memory.region) {
    const ratio = zoom / memory.zoom;
    zoomDirection = ratio > ZOOM_MOVE ? "in" : ratio < 1 / ZOOM_MOVE ? "out" : null;
  }
  const lookahead = config.prefetchDepth <= 0 || zoomDirection === null ? 0 : zoomDirection === "in" ? 1 : 2;
  // Only a volume view's gesture frames march coarser levels: a slice view
  // samples once a pixel at any level.
  const volume = view.datasets[0]?.view.selection.renderMode === "volume";
  return {
    regions: JSON.stringify(regions),
    entities: Float64Array.from(entities),
    previous: Float64Array.from(previous),
    owners,
    datasetIds: view.datasets.map((dataset) => dataset.datasetId),
    lookahead,
    holdRefinement: moving && volume && zoomDirection === "in",
    ancestorScale: volume ? config.ancestorScale : 0,
    zoom,
    region,
    zoomDirection,
  };
}

/** The image-bearing entities the view shows, in entity order, as the active set lists them. */
function visibleTiles(entities: readonly EntitySnapshot[]): EntitySnapshot[] {
  const tiles = new Set(groupMembers([...entities]).flatMap((group) => group.tiles));
  return entities.filter((entity) => tiles.has(entity));
}

/** The level the coarse tier holds for an entity, when it holds one the pyramid has. */
function usableCoarseLevel(entity: EntitySnapshot): number | null {
  const coarse = entity.coarseLevel;
  if (coarse === null || !Number.isInteger(coarse) || coarse < 0 || coarse >= entity.levels.length) return null;
  return coarse;
}

/**
 * What one cell of each level costs, over the channels shown: what the CPU
 * cache holds for it and what a GPU slot holds. A slice view holds the band
 * of planes around its cut, not the whole chunk, and its pools a plane of it.
 */
function levelCosts(
  dataset: SelectionDataset,
  config: PlanningConfig,
): (entity: EntitySnapshot, level: number) => SelectionBytes {
  const { view, manifest } = dataset;
  const texel = bytesPerTexel(datasetSampleFormat(manifest));
  const sampleBytes = new Map(manifest.images.map((image) => [image.image_id, decodedBytesPerSample(image.multiscale.data_type)]));
  const channels = view.selection.visibleChannels.length;
  const volume = view.selection.renderMode === "volume";
  return (entity, level) => {
    const geo = entity.levels[level];
    const [, , cz, cy, cx] = geo.chunk_shape;
    const voxels = cx * cy * cz;
    const whole = voxels * (sampleBytes.get(entity.imageId) ?? 2);
    const slice = slicePlaneAt(entity, level, view, config);
    const depth = slice === null ? 1 : Math.max(1, slice.axis === "x" ? cx : slice.axis === "y" ? cy : cz);
    const cpu = slice === null ? whole : (whole / depth) * (slice.planes[1] - slice.planes[0]);
    const [across, down] = toPlaneFrame([cx, cy, cz], view.selection.cut.axis);
    const gpu = texel * (volume ? voxels : across * down);
    return { cpu: cpu * channels, gpu: gpu * channels };
  };
}

/** The core's answer for a view with nothing to select: no cells, nothing spent, nothing refused. */
const NOTHING_SELECTED = Float64Array.from({ length: SELECTION_HEADER }, (_, i) => (i === 5 ? -1 : 0));

interface ViewRun {
  datasets: Map<string, DatasetLevelSelection>;
  cells: Map<string, Map<string, number[]>>;
  used: SelectionBytes;
  budget: SelectionBytes;
  limit: number | null;
  held: boolean;
}

/** One call into the core for one view, read back per dataset and entity. */
function runView(input: EncodedView, budget: SelectionBytes, config: PlanningConfig): ViewRun {
  const out = input.owners.length === 0
    ? NOTHING_SELECTED
    : select_levels(
      input.regions,
      config.depthBiasView,
      input.entities,
      input.previous,
      input.holdRefinement,
      budget.cpu,
      budget.gpu,
      config.selectionShare,
      input.lookahead,
      input.ancestorScale,
      config.ancestorShare,
    );
  const [fetchedCount, lookaheadCount, refinedCount] = [out[0], out[1], out[2]];
  const limited = out[5] >= 0;

  const byOwner = input.owners.map((): EntityLevelSelection => ({
    detail: [],
    ancestors: [],
    lookahead: [],
    detailLevels: [],
    coarseCells: 0,
  }));
  const remembered = input.owners.map((): number[] => []);
  let at = SELECTION_HEADER;
  for (let rank = 0; rank < fetchedCount; rank++, at += CELL_STRIDE) {
    const owner = out[at];
    const level = out[at + 1];
    const chosen = byOwner[owner];
    // Remembered so the next selection keeps an ancestor near its bound.
    if (out[at + 7] > 0) {
      remembered[owner].push(0, level, out[at + 2], out[at + 3], out[at + 4], 2);
      chosen.ancestors.push({ level, x: out[at + 2], y: out[at + 3], z: out[at + 4], rank });
      continue;
    }
    remembered[owner].push(0, level, out[at + 2], out[at + 3], out[at + 4], 0);
    if (level === input.owners[owner].coarse) {
      chosen.coarseCells++;
      continue;
    }
    chosen.detail.push({ level, x: out[at + 2], y: out[at + 3], z: out[at + 4], rank });
    if (!chosen.detailLevels.includes(level)) chosen.detailLevels.push(level);
  }
  for (let rank = 0; rank < lookaheadCount; rank++, at += CELL_STRIDE) {
    byOwner[out[at]].lookahead.push({ level: out[at + 1], x: out[at + 2], y: out[at + 3], z: out[at + 4], rank });
  }
  for (let i = 0; i < refinedCount; i++, at += CELL_STRIDE) {
    remembered[out[at]].push(0, out[at + 1], out[at + 2], out[at + 3], out[at + 4], 1);
  }

  const datasets = new Map<string, DatasetLevelSelection>();
  const cells = new Map<string, Map<string, number[]>>();
  const entitiesOf = new Map<string, Map<string, EntityLevelSelection>>();
  for (const datasetId of input.datasetIds) {
    const entities = new Map<string, EntityLevelSelection>();
    entitiesOf.set(datasetId, entities);
    datasets.set(datasetId, { entities, budgetLimited: limited });
    cells.set(datasetId, new Map());
  }
  input.owners.forEach((owner, i) => {
    const selection = byOwner[i];
    selection.detailLevels.sort((a, b) => a - b);
    entitiesOf.get(owner.datasetId)!.set(owner.entityId, selection);
    cells.get(owner.datasetId)!.set(owner.entityId, remembered[i]);
  });
  return {
    datasets,
    cells,
    used: { cpu: out[3], gpu: out[4] },
    budget,
    limit: limited ? out[5] : null,
    held: out[12] > 0,
  };
}

function scale(bytes: SelectionBytes, by: number): SelectionBytes {
  return { cpu: bytes.cpu * by, gpu: bytes.gpu * by };
}

/**
 * Divide `room` among claims in proportion to their weights, max-min fair: a
 * claim that wants less than its share takes only what it wants, and what it
 * leaves is divided again among the rest.
 *
 * A view's weight is its area on screen, so it gets room for what it can
 * show, however much it asks for. Room in proportion to what each view asks
 * for would favor a volume view, which asks for chunks along its depth, and
 * a fixed floor per view would be a guess at what a view needs.
 */
export function fairShares(
  demand: ReadonlyMap<number, number>,
  weights: ReadonlyMap<number, number>,
  room: number,
): Map<number, number> {
  const shares = new Map<number, number>();
  const weightOf = (view: number): number => Math.max(weights.get(view) ?? 0, 0);
  let open = [...demand].filter(([, wants]) => wants > 0);
  let left = Math.max(0, room);
  while (open.length > 0) {
    const total = open.reduce((sum, [view]) => sum + weightOf(view), 0);
    const shareOf = (view: number): number => (total > 0 ? (left * weightOf(view)) / total : left / open.length);
    const met = open.filter(([view, wants]) => wants <= shareOf(view));
    if (met.length === 0) {
      for (const [view] of open) shares.set(view, shareOf(view));
      break;
    }
    for (const [view, wants] of met) {
      shares.set(view, wants);
      left -= wants;
    }
    open = open.filter((claim) => !met.includes(claim));
  }
  return shares;
}
