import { Radio, RadioGroup } from "react-aria-components";
import { ACCENT_PRESETS, isHexColor, type Accent, type HexColor } from "./appearance.ts";
import "./AccentPicker.css";

export interface AccentPickerProps {
  value: Accent;
  onChange: (accent: Accent) => void;
  className?: string;
}

const CUSTOM_FALLBACK: HexColor = "#8b5cf6";

/** The six accent presets as swatches, then a custom color. */
export function AccentPicker({ value, onChange, className }: AccentPickerProps) {
  const custom = isHexColor(value);
  return (
    <div className={className ? `lc-accent-picker ${className}` : "lc-accent-picker"}>
      <RadioGroup
        className="lc-accent-presets"
        aria-label="Accent color"
        orientation="horizontal"
        value={custom ? null : value}
        onChange={(next) => onChange(next as Accent)}
      >
        {ACCENT_PRESETS.map((name) => (
          <Radio
            key={name}
            value={name}
            className="lc-accent-swatch"
            data-accent={name}
            aria-label={name[0].toUpperCase() + name.slice(1)}
          />
        ))}
      </RadioGroup>
      <label
        className="lc-accent-swatch lc-accent-custom"
        data-selected={custom || undefined}
        style={custom ? { background: value } : undefined}
        title="Custom color"
      >
        <input
          type="color"
          aria-label="Custom accent color"
          value={custom ? value : CUSTOM_FALLBACK}
          onChange={(e) => {
            if (isHexColor(e.target.value)) onChange(e.target.value);
          }}
        />
      </label>
    </div>
  );
}
