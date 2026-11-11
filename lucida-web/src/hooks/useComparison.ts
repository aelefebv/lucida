import { useCallback, useMemo } from "react";
import {
  comparisonActions,
  lineUpReason,
  readLineUp,
  type ComparisonActions,
} from "../comparison.ts";
import type { Engine } from "../engine.ts";
import { toast } from "../ui/toastQueue.ts";

export interface ComparisonControls {
  actions: ComparisonActions;
  /** Why a layer can't be compared with another, or null when it can. */
  blocker(id: string, other: string): string | null;
  /** Start comparing a layer with another as a swipe, or say why it can't. */
  compareWith(id: string, other: string): void;
}

/** What starts and changes the active view's comparison, for the layer menu and the trace driver. */
export function useComparison(
  engine: Engine,
  layers: readonly { id: string; name: string }[],
): ComparisonControls {
  const actions = useMemo(() => comparisonActions(engine.scene, engine.loop), [engine]);
  const nameOf = useCallback(
    (datasetId: string) => layers.find((layer) => layer.id === datasetId)?.name ?? datasetId,
    [layers],
  );
  const blocker = useCallback(
    (id: string, other: string) => {
      const scene = engine.scene();
      return scene ? lineUpReason(readLineUp(scene, id, other), nameOf) : "The view isn't ready yet.";
    },
    [engine, nameOf],
  );
  const compareWith = useCallback(
    (id: string, other: string) => {
      const why = lineUpReason(actions.start(id, other, "swipe"), nameOf);
      if (why) toast({ title: "These layers can't be compared", description: why, tone: "warning" });
    },
    [actions, nameOf],
  );
  return { actions, blocker, compareWith };
}
