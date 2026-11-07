import { booleanPreference, definePreference, numberPreference } from "../theme/preferences.ts";

export const LEFT_PANEL_MIN_WIDTH = 200;
export const LEFT_PANEL_MAX_WIDTH = 560;

// Whether each panel is open on desktop. Below it the panels overlay the
// canvas and keep their open state in memory (sidePanels.ts).
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

