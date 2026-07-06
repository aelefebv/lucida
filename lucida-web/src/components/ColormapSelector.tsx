import { COLORMAP_NAMES } from "../colormaps.ts";
import type { Colormap } from "../savedView/types.ts";

interface Props {
  value: string;
  onChange: (colormap: Colormap) => void;
  label?: string;
}

export function ColormapSelector({ value, onChange, label = "Colormap" }: Props) {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as Colormap)}
    >
      {COLORMAP_NAMES.map((name) => (
        <option key={name} value={name}>
          {name.charAt(0).toUpperCase() + name.slice(1)}
        </option>
      ))}
    </select>
  );
}
