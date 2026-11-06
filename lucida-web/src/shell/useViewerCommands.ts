import { useSyncExternalStore } from "react";
import { CANVAS_CARDS } from "../components/canvasCards.ts";
import {
  ACCENT_PRESETS,
  accentPreference,
  canvasBackgroundPreference,
  densityPreference,
  themePreference,
  type CanvasBackground,
  type Density,
  type ThemeOption,
} from "../theme/appearance.ts";
import {
  developerToolsPreference,
  getPreference,
  setPreference,
  subscribePreferences,
  usePreference,
  type Preference,
} from "../theme/preferences.ts";
import { useCommands, type CommandOptions } from "../ui/commands.ts";
import {
  leftPanelOpenPreference,
  rightPanelOpenPreference,
  rightPanelPreference,
  useOpenRightPanel,
} from "./layoutPreferences.ts";
import type { DeveloperSurfaces } from "./useDeveloperSurfaces.ts";

export interface ViewerCommandsOptions {
  viewMode: "2d" | "3d";
  /** Whether a dataset is open; switching the view mode needs one. */
  hasData: boolean;
  onToggleViewMode: () => void;
  onBackToDashboard: () => void;
  /** The rail's panels, which the palette opens directly. */
  rightPanels: readonly { id: string; label: string }[];
  developer: DeveloperSurfaces;
}

const THEMES: readonly [ThemeOption, string][] = [
  ["dark", "Dark"],
  ["light", "Light"],
  ["system", "System"],
];
const DENSITIES: readonly [Density, string][] = [
  ["comfortable", "Comfortable"],
  ["compact", "Compact"],
];
const CANVAS_BACKGROUNDS: readonly [CanvasBackground, string][] = [
  ["black", "Black"],
  ["dark-gray", "Dark gray"],
  ["white", "White"],
  ["theme", "Match theme"],
];

function toggle(pref: Preference<boolean>): void {
  setPreference(pref, !getPreference(pref));
}

/**
 * The palette's commands for what the viewer shell owns: the view mode,
 * panels, appearance, developer tools, and workspace actions. Where a
 * component already binds a key for one, the command shares the shortcut's
 * id, so the palette shows that key.
 */
export function useViewerCommands({
  viewMode,
  hasData,
  onToggleViewMode,
  onBackToDashboard,
  rightPanels,
  developer,
}: ViewerCommandsOptions): void {
  const openPanel = useOpenRightPanel();
  const [developerTools, setDeveloperTools] = usePreference(developerToolsPreference);
  // Re-render as any card is hidden or brought back, wherever that happens.
  useSyncExternalStore(subscribePreferences, () =>
    CANVAS_CARDS.map((card) => getPreference(card.preference)).join(),
  );

  const commands: CommandOptions[] = [
    {
      id: "view.toggleMode",
      label: viewMode === "2d" ? "Switch to 3D" : "Switch to 2D",
      group: "View",
      keywords: ["2d", "3d", "volume", "slice"],
      run: onToggleViewMode,
      enabled: hasData,
    },
    {
      id: "workspace.all",
      label: "Go to all workspaces",
      group: "General",
      keywords: ["dashboard", "home"],
      run: onBackToDashboard,
    },

    {
      id: "panels.toggleLeft",
      label: "Show or hide the layers panel",
      group: "Panels",
      keywords: ["sidebar", "channels"],
      run: () => toggle(leftPanelOpenPreference),
    },
    {
      id: "panels.toggleRight",
      label: "Show or hide the right panel",
      group: "Panels",
      keywords: ["sidebar"],
      run: () => toggle(rightPanelOpenPreference),
      enabled: rightPanels.length > 0,
    },
    ...rightPanels.map(({ id, label }): CommandOptions => {
      const open = openPanel === id;
      return {
        id: `panels.${id}`,
        label: `${open ? "Close" : "Open"} panel: ${label}`,
        group: "Panels",
        run: () => {
          if (!open) setPreference(rightPanelPreference, id);
          setPreference(rightPanelOpenPreference, !open);
        },
      };
    }),

    ...CANVAS_CARDS.map(({ preference, label }): CommandOptions => {
      const hidden = getPreference(preference) === "hidden";
      return {
        id: `view.card.${preference.key}`,
        label: `${hidden ? "Show" : "Hide"} the ${label.toLowerCase()}`,
        group: "View",
        keywords: ["card"],
        run: () => setPreference(preference, hidden ? "open" : "hidden"),
      };
    }),

    ...THEMES.map(([value, label]) => appearance(`theme.${value}`, `Theme: ${label}`, ["mode"], () =>
      setPreference(themePreference, value),
    )),
    ...ACCENT_PRESETS.map((accent) =>
      appearance(`accent.${accent}`, `Accent: ${accent[0].toUpperCase()}${accent.slice(1)}`, ["color"], () =>
        setPreference(accentPreference, accent),
      ),
    ),
    ...DENSITIES.map(([value, label]) => appearance(`density.${value}`, `Density: ${label}`, ["spacing"], () =>
      setPreference(densityPreference, value),
    )),
    ...CANVAS_BACKGROUNDS.map(([value, label]) =>
      appearance(`canvas.${value}`, `Canvas background: ${label}`, ["color"], () =>
        setPreference(canvasBackgroundPreference, value),
      ),
    ),

    {
      id: "developer.tools",
      label: developerTools ? "Turn off developer tools" : "Turn on developer tools",
      group: "Developer",
      keywords: ["debug", "monitor", "hud"],
      run: () => setDeveloperTools(!developerTools),
    },
    {
      id: "developer.toggleMonitor",
      label: developer.monitor ? "Hide the pipeline monitor" : "Show the pipeline monitor",
      group: "Developer",
      run: developer.toggleMonitor,
      enabled: developer.enabled,
    },
    {
      id: "developer.toggleHud",
      label: developer.hud ? "Hide the HUD" : "Show the HUD",
      group: "Developer",
      run: developer.toggleHud,
      enabled: developer.enabled,
    },
    {
      id: "developer.toggleDevControls",
      label: developer.devControls ? "Hide dev controls" : "Show dev controls",
      group: "Developer",
      run: developer.toggleDevControls,
      enabled: developer.enabled,
    },
  ];
  useCommands(commands);
}

function appearance(id: string, label: string, keywords: string[], run: () => void): CommandOptions {
  return { id: `appearance.${id}`, label, group: "Appearance", keywords, run };
}
