// Theme tokens, appearance, and per-browser preferences (ADR 0066).
export { AccentPicker, type AccentPickerProps } from "./AccentPicker.tsx";
export {
  ACCENT_PRESETS,
  CANVAS_BACKGROUNDS,
  DENSITIES,
  THEME_OPTIONS,
  accentPreference,
  canvasBackgroundPreference,
  densityPreference,
  installAppearance,
  isHexColor,
  subscribeAppearance,
  themePreference,
  useAppearance,
  type Accent,
  type AccentPreset,
  type Appearance,
  type CanvasBackground,
  type Density,
  type HexColor,
  type ResolvedTheme,
  type ThemeOption,
} from "./appearance.ts";
export {
  booleanPreference,
  definePreference,
  developerToolsPreference,
  getPreference,
  numberPreference,
  oneOfPreference,
  resetPreference,
  setPreference,
  setPreferenceDefaults,
  subscribePreferences,
  usePreference,
  type Preference,
} from "./preferences.ts";
export { readColorToken, readToken, type ResolvedColor, type TokenName } from "./tokens.ts";
