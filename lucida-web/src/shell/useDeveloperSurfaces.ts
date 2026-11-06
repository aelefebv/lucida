import { useCallback, useState } from "react";
import { developerToolsPreference, usePreference } from "../theme/preferences.ts";
import { useShortcut } from "../ui/shortcuts.ts";

/** Which developer surfaces show. Each is false while developer tools are off. */
export interface DeveloperSurfaces {
  /** The Developer tools setting. */
  readonly enabled: boolean;
  readonly monitor: boolean;
  readonly hud: boolean;
  readonly devControls: boolean;
  /** The frame-rate readout, which has no toggle of its own. */
  readonly fps: boolean;
  toggleMonitor(): void;
  closeMonitor(): void;
  toggleHud(): void;
  toggleDevControls(): void;
}

/**
 * The developer surfaces' open state, gated on the Developer tools setting.
 * Turning the setting off hides every surface and unbinds `H`; turning it back
 * on shows again whatever was open.
 */
export function useDeveloperSurfaces({ captureSurface }: { captureSurface: boolean }): DeveloperSurfaces {
  const [setting] = usePreference(developerToolsPreference);
  const enabled = setting && !captureSurface;
  const [monitor, setMonitor] = useState(false);
  const [hud, setHud] = useState(false);
  const [devControls, setDevControls] = useState(false);

  const toggleMonitor = useCallback(() => setMonitor((v) => !v), []);
  const closeMonitor = useCallback(() => setMonitor(false), []);
  const toggleHud = useCallback(() => setHud((v) => !v), []);
  const toggleDevControls = useCallback(() => setDevControls((v) => !v), []);

  useShortcut({
    id: "developer.toggleHud",
    keys: "H",
    label: "Show or hide the HUD",
    group: "Developer",
    onTrigger: toggleHud,
    enabled,
  });

  return {
    enabled,
    monitor: enabled && monitor,
    hud: enabled && hud,
    devControls: enabled && devControls,
    fps: enabled,
    toggleMonitor,
    closeMonitor,
    toggleHud,
    toggleDevControls,
  };
}
