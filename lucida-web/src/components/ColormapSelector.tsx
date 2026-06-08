import { COLORMAP_NAMES } from "../colormaps.ts";

interface Props {
  value: string;
  onChange: (colormap: string) => void;
  label?: string;
}

export function ColormapSelector({ value, onChange, label = "Colormap" }: Props) {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    >
      {COLORMAP_NAMES.map((name) => (
        <option key={name} value={name}>
          {name.charAt(0).toUpperCase() + name.slice(1)}
        </option>
      ))}
    </select>
  );
}
