import { COLORMAP_NAMES } from "../colormaps.ts";

interface Props {
  value: string;
  onChange: (colormap: string) => void;
}

export function ColormapSelector({ value, onChange }: Props) {
  return (
    <select
      value={value}
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
