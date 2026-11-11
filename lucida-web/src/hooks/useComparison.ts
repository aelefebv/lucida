import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  comparisonActions,
  lineUpReason,
  placedByHandNote,
  readLineUp,
  readLineUpByHand,
  type Comparison,
  type ComparisonActions,
} from "../comparison.ts";
import type { Engine } from "../engine.ts";
import { toast } from "../ui/toastQueue.ts";

export interface ComparisonControls {
  /** The comparison the view shows, re-rendering only when it changes. */
  current: Comparison | null;
  actions: ComparisonActions;
  /** A layer's name, for the controls to say what they compare. */
  nameOf(datasetId: string): string;
  /** Why a layer can't be compared with another, or null when it can. */
  blocker(id: string, other: string): string | null;
  /** Says when a pair lines up because someone placed it by hand, or null. */
  byHand(id: string, other: string): string | null;
  /** Start comparing a layer with another as a swipe, or say why it can't. */
  compareWith(id: string, other: string): void;
}

/** The view's comparison and what changes it, for the layer menu and the canvas controls. */
export function useComparison(
  engine: Engine,
  layers: readonly { id: string; name: string }[],
): ComparisonControls {
  const current = useSyncExternalStore(
    engine.store.subscribe,
    engine.store.getComparison,
    engine.store.getComparison,
  );
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
  const byHand = useCallback(
    (id: string, other: string) => {
      const scene = engine.scene();
      return scene ? placedByHandNote(readLineUpByHand(scene, id, other), nameOf) : null;
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
  return { current, actions, nameOf, blocker, byHand, compareWith };
}
