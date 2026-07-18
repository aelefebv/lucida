import { useCallback, useSyncExternalStore } from "react";

import type { LayoutRegistry } from "../pipeline/layoutRegistry.ts";
import { LayoutSwitcher } from "./LayoutSwitcher.tsx";

interface Props {
  datasetId: string;
  registry: LayoutRegistry | null;
  sendCommand: (json: string) => void;
  /** Marks derived render state dirty after the command applies locally. */
  onAfterChange?: () => void;
}

/** Application adapter; keeps registry mutation out of the presentation view. */
export function LayoutSwitcherController({
  datasetId,
  registry,
  sendCommand,
  onAfterChange,
}: Props) {
  useSyncExternalStore(
    (listener) => registry?.subscribe(listener) ?? (() => {}),
    () => registry?.getVersion() ?? 0,
    () => 0,
  );

  const onSelect = useCallback((layoutId: string) => {
    if (!registry) return;
    registry.setActive(datasetId, layoutId, sendCommand);
    onAfterChange?.();
  }, [datasetId, onAfterChange, registry, sendCommand]);

  return (
    <LayoutSwitcher
      layouts={registry?.available(datasetId) ?? []}
      activeLayoutId={registry?.activeId(datasetId) ?? null}
      onSelect={onSelect}
    />
  );
}
