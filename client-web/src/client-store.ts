export type WarningEntry = {
  warningCode: string;
  severity: "info" | "warning" | "error";
  message: string;
};

export type SourceState = {
  sourceId: string;
  name: string;
  status: string;
  latestWorkingGenerationSeq: number;
};

export type DatasetState = {
  datasetId: string;
  sourceId: string | null;
  resolvedGenerationSeq: number;
  dtype: string;
  sizeT?: number;
  sizeC?: number;
  sizeZ?: number;
  sizeY?: number;
  sizeX?: number;
};

export type LayerState = {
  layerId: string;
  name: string;
  layerRev: number;
  metadataRev: number;
  writeRev: number;
};

export type GenerationState = {
  sourceId: string;
  generationSeq: number;
  stage: string;
  progressPercent: number;
  previewReady: boolean;
  tile2dReadyLods: number[];
  brick3dReadyLods: number[];
  tileLayout?: TileLayout | null;
};

export type TileLodLayout = {
  lod: number;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  rows: number;
  cols: number;
};

export type TileLayout = {
  defaultChannelBlockSize: number;
  lods: TileLodLayout[];
};

export type SnapshotPayload = {
  session: {
    session_id: string;
    session_rev: number;
  };
  shared_scene: {
    scene_rev: number;
    sources: Record<string, SourceState>;
    datasets: Record<string, DatasetState>;
    layers: Record<string, LayerState>;
    source_generations?: Record<string, GenerationState>;
    warnings: WarningEntry[];
  };
  client_view: {
    client_id: string;
    view_rev: number;
    warnings: WarningEntry[];
    active_layer_id: string | null;
    center_x: number;
    center_y: number;
    zoom: number;
    z_index: number;
    t_index: number;
    selected_channels: number[];
  };
  warnings: WarningEntry[];
};

export type EventEnvelope = {
  session_rev: number;
  event_type:
    | "scene_source_upsert"
    | "scene_dataset_upsert"
    | "scene_layer_upsert"
    | "warnings_updated"
    | "view_updated"
    | "source_generation_detected"
    | "source_generation_started"
    | "source_generation_progress"
    | "source_generation_failed"
    | "source_generation_ready";
  payload: unknown;
};

export type ClientState = {
  sessionId: string;
  sessionRev: number;
  sceneRev: number;
  clientId: string;
  viewRev: number;
  activeLayerId: string | null;
  centerX: number;
  centerY: number;
  zoom: number;
  zIndex: number;
  tIndex: number;
  selectedChannels: number[];
  sources: Record<string, SourceState>;
  datasets: Record<string, DatasetState>;
  layers: Record<string, LayerState>;
  generations: Record<string, GenerationState>;
  warnings: WarningEntry[];
  reconnectCount: number;
};

export type AxisSelectionBounds = {
  sourceId: string | null;
  maxZIndex: number | null;
  maxTIndex: number | null;
  maxChannelIndex: number | null;
};

function generationKey(sourceId: string, generationSeq: number): string {
  return `${sourceId}:${generationSeq.toString()}`;
}

export function selectionBoundsFor(
  clientState: ClientState,
  preferredSourceId: string | null = null,
): AxisSelectionBounds | null {
  const source = resolveSelectionSource(clientState, preferredSourceId);
  if (source === null) {
    return null;
  }
  const dataset = resolveDatasetForSource(clientState, source.sourceId);
  if (dataset === null) {
    return null;
  }
  return {
    sourceId: source.sourceId,
    maxZIndex: sizeToMaxIndex(dataset.sizeZ),
    maxTIndex: sizeToMaxIndex(dataset.sizeT),
    maxChannelIndex: sizeToMaxIndex(dataset.sizeC),
  };
}

function resolveSelectionSource(
  clientState: ClientState,
  preferredSourceId: string | null,
): SourceState | null {
  if (preferredSourceId !== null) {
    const preferred = clientState.sources[preferredSourceId];
    if (preferred !== undefined) {
      return preferred;
    }
  }
  const sources = Object.values(clientState.sources);
  if (sources.length === 0) {
    return null;
  }
  const first = sources[0];
  if (first === undefined) {
    return null;
  }
  let selected: SourceState = first;
  for (const source of sources) {
    if (source.latestWorkingGenerationSeq >= selected.latestWorkingGenerationSeq) {
      selected = source;
    }
  }
  return selected;
}

function resolveDatasetForSource(
  clientState: ClientState,
  sourceId: string,
): DatasetState | null {
  let selected: DatasetState | null = null;
  for (const dataset of Object.values(clientState.datasets)) {
    if (dataset.sourceId !== sourceId) {
      continue;
    }
    if (
      selected === null ||
      dataset.resolvedGenerationSeq >= selected.resolvedGenerationSeq
    ) {
      selected = dataset;
    }
  }
  return selected;
}

function sizeToMaxIndex(size: number | undefined): number | null {
  if (size === undefined || !Number.isFinite(size)) {
    return null;
  }
  const integerSize = Math.floor(size);
  if (integerSize <= 1) {
    return 0;
  }
  return integerSize - 1;
}

export function hydrateClientState(snapshot: SnapshotPayload): ClientState {
  const sourceGenerations = snapshot.shared_scene.source_generations ?? {};
  const generations = Object.fromEntries(
    Object.entries(sourceGenerations)
      .map(([key, generation]) => {
        const parsed = parseGenerationState(generation);
        if (parsed === null) {
          return null;
        }
        return [key, parsed] as const;
      })
      .filter((entry): entry is readonly [string, GenerationState] => entry !== null),
  );
  return {
    sessionId: snapshot.session.session_id,
    sessionRev: snapshot.session.session_rev,
    sceneRev: snapshot.shared_scene.scene_rev,
    clientId: snapshot.client_view.client_id,
    viewRev: snapshot.client_view.view_rev,
    activeLayerId: snapshot.client_view.active_layer_id,
    centerX: snapshot.client_view.center_x,
    centerY: snapshot.client_view.center_y,
    zoom: snapshot.client_view.zoom,
    zIndex: snapshot.client_view.z_index,
    tIndex: snapshot.client_view.t_index,
    selectedChannels: [...snapshot.client_view.selected_channels],
    sources: { ...snapshot.shared_scene.sources },
    datasets: { ...snapshot.shared_scene.datasets },
    layers: { ...snapshot.shared_scene.layers },
    generations,
    warnings: [...snapshot.warnings],
    reconnectCount: 0,
  };
}

export function reconcileWithSnapshot(
  state: ClientState,
  snapshot: SnapshotPayload,
): ClientState {
  const hydrated = hydrateClientState(snapshot);
  return {
    ...hydrated,
    reconnectCount: state.reconnectCount + 1,
  };
}

export function applyEvent(state: ClientState, event: EventEnvelope): ClientState {
  if (event.session_rev < state.sessionRev) {
    return state;
  }

  const next: ClientState = {
    ...state,
    sessionRev: event.session_rev,
  };

  switch (event.event_type) {
    case "scene_source_upsert": {
      const payload = event.payload as SourceState;
      next.sources = {
        ...next.sources,
        [payload.sourceId]: payload,
      };
      return next;
    }
    case "scene_dataset_upsert": {
      const payload = event.payload as DatasetState;
      next.datasets = {
        ...next.datasets,
        [payload.datasetId]: payload,
      };
      return next;
    }
    case "scene_layer_upsert": {
      const payload = event.payload as LayerState;
      next.layers = {
        ...next.layers,
        [payload.layerId]: payload,
      };
      return next;
    }
    case "warnings_updated": {
      const payload = event.payload as {
        client_id: string;
        warnings: WarningEntry[];
      };
      if (payload.client_id !== next.clientId) {
        return next;
      }
      next.warnings = [...payload.warnings];
      return next;
    }
    case "view_updated": {
      const payload = event.payload as {
        client_id: string;
        view_rev: number;
        active_layer_id: string | null;
        center_x: number;
        center_y: number;
        zoom: number;
        z_index: number;
        t_index: number;
        selected_channels: number[];
      };
      if (payload.client_id !== next.clientId) {
        return next;
      }
      next.viewRev = payload.view_rev;
      next.activeLayerId = payload.active_layer_id;
      next.centerX = payload.center_x;
      next.centerY = payload.center_y;
      next.zoom = payload.zoom;
      next.zIndex = payload.z_index;
      next.tIndex = payload.t_index;
      next.selectedChannels = [...payload.selected_channels];
      return next;
    }
    case "source_generation_detected":
    case "source_generation_started":
    case "source_generation_progress":
    case "source_generation_failed":
    case "source_generation_ready": {
      const payload = parseGenerationState(event.payload);
      if (payload === null) {
        return next;
      }
      next.generations = {
        ...next.generations,
        [generationKey(payload.sourceId, payload.generationSeq)]:
          cloneGenerationState(payload),
      };
      return next;
    }
  }
}

function cloneGenerationState(value: GenerationState): GenerationState {
  return {
    sourceId: value.sourceId,
    generationSeq: value.generationSeq,
    stage: value.stage,
    progressPercent: value.progressPercent,
    previewReady: value.previewReady,
    tile2dReadyLods: [...value.tile2dReadyLods],
    brick3dReadyLods: [...value.brick3dReadyLods],
    tileLayout: cloneTileLayout(value.tileLayout),
  };
}

function cloneTileLayout(value: TileLayout | null | undefined): TileLayout | null {
  if (value === null || value === undefined) {
    return null;
  }
  return {
    defaultChannelBlockSize: value.defaultChannelBlockSize,
    lods: value.lods.map((lod) => ({
      lod: lod.lod,
      width: lod.width,
      height: lod.height,
      tileWidth: lod.tileWidth,
      tileHeight: lod.tileHeight,
      rows: lod.rows,
      cols: lod.cols,
    })),
  };
}

function parseGenerationState(value: unknown): GenerationState | null {
  if (!isRecord(value)) {
    return null;
  }
  const sourceId = readString(value, "sourceId");
  const generationSeq = readNumber(value, "generationSeq");
  const stage = readString(value, "stage");
  const progressPercent = readNumber(value, "progressPercent");
  const previewReady = readBoolean(value, "previewReady");
  const tile2dReadyLods = readNumberArray(value, "tile2dReadyLods");
  const brick3dReadyLods = readNumberArray(value, "brick3dReadyLods");
  if (
    sourceId === null ||
    generationSeq === null ||
    stage === null ||
    progressPercent === null ||
    previewReady === null ||
    tile2dReadyLods === null ||
    brick3dReadyLods === null
  ) {
    return null;
  }
  return {
    sourceId,
    generationSeq,
    stage,
    progressPercent,
    previewReady,
    tile2dReadyLods,
    brick3dReadyLods,
    tileLayout: parseTileLayout(value.tileLayout),
  };
}

function parseTileLayout(value: unknown): TileLayout | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const defaultChannelBlockSize = readNumber(value, "defaultChannelBlockSize");
  const lodValues = value.lods;
  if (defaultChannelBlockSize === null || !Array.isArray(lodValues)) {
    return null;
  }
  const lods: TileLodLayout[] = [];
  for (const lodValue of lodValues) {
    if (!isRecord(lodValue)) {
      return null;
    }
    const lod = readNumber(lodValue, "lod");
    const width = readNumber(lodValue, "width");
    const height = readNumber(lodValue, "height");
    const tileWidth = readNumber(lodValue, "tileWidth");
    const tileHeight = readNumber(lodValue, "tileHeight");
    const rows = readNumber(lodValue, "rows");
    const cols = readNumber(lodValue, "cols");
    if (
      lod === null ||
      width === null ||
      height === null ||
      tileWidth === null ||
      tileHeight === null ||
      rows === null ||
      cols === null
    ) {
      return null;
    }
    lods.push({
      lod,
      width,
      height,
      tileWidth,
      tileHeight,
      rows,
      cols,
    });
  }
  return {
    defaultChannelBlockSize,
    lods,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function readNumberArray(record: Record<string, unknown>, key: string): number[] | null {
  const value = record[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const numbers: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      return null;
    }
    numbers.push(entry);
  }
  return numbers;
}
