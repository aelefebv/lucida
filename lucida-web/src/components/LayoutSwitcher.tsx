import { useSyncExternalStore } from "react";
import type { LayoutRegistry } from "../pipeline/layoutRegistry.ts";
import { Select } from "../ui/index.ts";

interface Props {
  datasetId: string;
  registry: LayoutRegistry | null;
  sendCommand: (json: string) => void;
  /** Called after a local layout switch, so the caller can mark the canvas
   *  dirty and the view updates without a pan or zoom. */
  onAfterChange?: () => void;
  className?: string;
}

/**
 * Switches between a dataset's layouts. Renders nothing when there are <= 1
 * layouts to choose from (single-image datasets) or when the registry isn't
 * available yet.
 */
export function LayoutSwitcher({ datasetId, registry, sendCommand, onAfterChange, className }: Props) {
  // Subscribe to registry changes. The version counter is the stable
  // snapshot; we read fresh state via available()/activeId() below.
  useSyncExternalStore(
    (cb) => registry?.subscribe(cb) ?? (() => {}),
    () => registry?.getVersion() ?? 0,
    () => 0,
  );

  if (!registry) return null;
  const available = registry.available(datasetId);
  if (available.length <= 1) return null;

  const activeId = registry.activeId(datasetId) ?? available[0]?.id ?? "";

  return (
    <Select
      className={className}
      label="Layout"
      description="How the dataset's images are arranged"
      options={available.map((l) => ({ value: l.id, label: l.name }))}
      value={activeId}
      onChange={(id) => {
        registry.setActive(datasetId, id, sendCommand);
        onAfterChange?.();
      }}
    />
  );
}
