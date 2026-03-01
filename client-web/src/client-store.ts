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
    warnings: WarningEntry[];
  };
  client_view: {
    client_id: string;
    view_rev: number;
    warnings: WarningEntry[];
    active_layer_id: string | null;
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
  sources: Record<string, SourceState>;
  datasets: Record<string, DatasetState>;
  layers: Record<string, LayerState>;
  generations: Record<string, GenerationState>;
  warnings: WarningEntry[];
  reconnectCount: number;
};

function generationKey(sourceId: string, generationSeq: number): string {
  return `${sourceId}:${generationSeq.toString()}`;
}

export function hydrateClientState(snapshot: SnapshotPayload): ClientState {
  return {
    sessionId: snapshot.session.session_id,
    sessionRev: snapshot.session.session_rev,
    sceneRev: snapshot.shared_scene.scene_rev,
    clientId: snapshot.client_view.client_id,
    viewRev: snapshot.client_view.view_rev,
    activeLayerId: snapshot.client_view.active_layer_id,
    sources: { ...snapshot.shared_scene.sources },
    datasets: { ...snapshot.shared_scene.datasets },
    layers: { ...snapshot.shared_scene.layers },
    generations: {},
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
      };
      if (payload.client_id !== next.clientId) {
        return next;
      }
      next.viewRev = payload.view_rev;
      next.activeLayerId = payload.active_layer_id;
      return next;
    }
    case "source_generation_detected":
    case "source_generation_started":
    case "source_generation_progress":
    case "source_generation_ready": {
      const payload = event.payload as GenerationState;
      next.generations = {
        ...next.generations,
        [generationKey(payload.sourceId, payload.generationSeq)]: payload,
      };
      return next;
    }
  }
}
