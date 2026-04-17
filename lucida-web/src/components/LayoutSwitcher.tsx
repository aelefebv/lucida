import { useSyncExternalStore } from "react";
import type { LayoutRegistry } from "../pipeline/layoutRegistry.ts";

interface Props {
  datasetId: string;
  registry: LayoutRegistry | null;
  sendCommand: (json: string) => void;
  /** Called after a layout switch is applied locally — hook for the caller
   *  to mark the GPU canvas dirty so the view updates without needing the
   *  user to pan/zoom first. */
  onAfterChange?: () => void;
}

/**
 * Small dropdown that lets the user switch between available layouts for a
 * dataset. Renders nothing when there are <= 1 layouts to choose from
 * (single-image datasets) or when the registry isn't available yet.
 */
export function LayoutSwitcher({ datasetId, registry, sendCommand, onAfterChange }: Props) {
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
    <div className="layer-detail-row">
      <label>Layout</label>
      <select
        value={activeId}
        onChange={(e) => {
          registry.setActive(datasetId, e.target.value, sendCommand);
          onAfterChange?.();
        }}
      >
        {available.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
    </div>
  );
}
