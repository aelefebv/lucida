import {
  booleanPreference,
  definePreference,
  numberPreference,
  usePreference,
} from "../theme/preferences.ts";

export const LEFT_PANEL_MIN_WIDTH = 200;
export const LEFT_PANEL_MAX_WIDTH = 560;

export const leftPanelOpenPreference = booleanPreference("shell.leftPanelOpen", true);
export const leftPanelWidthPreference = numberPreference("shell.leftPanelWidth", 280, {
  min: LEFT_PANEL_MIN_WIDTH,
  max: LEFT_PANEL_MAX_WIDTH,
});

export const rightPanelOpenPreference = booleanPreference("shell.rightPanelOpen", false);
/**
 * The rail panel last opened. Any id is kept, so a panel added later can be
 * remembered; one the rail doesn't have reads as its first panel.
 */
export const rightPanelPreference = definePreference<string>("shell.rightPanel", "savedViews", (raw) =>
  typeof raw === "string" && raw !== "" ? raw : undefined,
);

/**
 * The open rail panel's id, or null when the panel area is closed. For code
 * outside the rail that should run only while a panel shows.
 */
export function useOpenRightPanel(): string | null {
  const [open] = usePreference(rightPanelOpenPreference);
  const [panelId] = usePreference(rightPanelPreference);
  return open ? panelId : null;
}
