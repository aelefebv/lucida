import { GearSixIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { CanvasCardSwitches } from "../components/CanvasCard.tsx";
import { AccentPicker } from "../theme/AccentPicker.tsx";
import {
  accentPreference,
  canvasBackgroundPreference,
  densityPreference,
  themePreference,
} from "../theme/appearance.ts";
import { developerToolsPreference, usePreference } from "../theme/preferences.ts";
import { IconButton } from "../ui/Button.tsx";
import { Popover } from "../ui/Popover.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import "./SettingsMenu.css";

/** The settings in a popover off the top bar. */
export function SettingsMenu() {
  return (
    <Popover
      label="Settings"
      placement="bottom end"
      trigger={<IconButton icon={GearSixIcon} label="Settings" tooltipPlacement="bottom" />}
    >
      <SettingsPanel />
    </Popover>
  );
}

/**
 * Appearance, the cards over the canvas, and developer tools. Each control
 * writes its preference as it changes, so the change shows at once and
 * survives a reload.
 */
export function SettingsPanel() {
  const [theme, setTheme] = usePreference(themePreference);
  const [accent, setAccent] = usePreference(accentPreference);
  const [density, setDensity] = usePreference(densityPreference);
  const [canvas, setCanvas] = usePreference(canvasBackgroundPreference);
  const [developerTools, setDeveloperTools] = usePreference(developerToolsPreference);
  const accentLabelId = useId();

  return (
    <div className="lc-settings">
      <h2 className="lc-settings-heading">Appearance</h2>
      <SegmentedControl
        label="Theme"
        labelPosition="side"
        size="sm"
        options={[
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
          { value: "system", label: "System" },
        ]}
        value={theme}
        onChange={setTheme}
      />
      <div className="lc-settings-row" role="group" aria-labelledby={accentLabelId}>
        <span id={accentLabelId} className="lc-settings-label">
          Accent
        </span>
        <AccentPicker value={accent} onChange={setAccent} />
      </div>
      <SegmentedControl
        label="Density"
        labelPosition="side"
        size="sm"
        options={[
          { value: "comfortable", label: "Comfortable" },
          { value: "compact", label: "Compact" },
        ]}
        value={density}
        onChange={setDensity}
      />
      <Select
        label="Canvas"
        labelPosition="side"
        description="Separate from the theme"
        options={[
          { value: "black", label: "Black" },
          { value: "dark-gray", label: "Dark gray" },
          { value: "white", label: "White" },
          { value: "theme", label: "Match theme" },
        ]}
        value={canvas}
        onChange={setCanvas}
        className="lc-settings-select"
      />
      <div className="lc-settings-divider" role="presentation" />
      <h2 className="lc-settings-heading">View</h2>
      <CanvasCardSwitches />
      <div className="lc-settings-divider" role="presentation" />
      <Switch
        label="Developer tools"
        description="Monitor, HUD, dev controls, and frame rate"
        isSelected={developerTools}
        onChange={setDeveloperTools}
      />
    </div>
  );
}
