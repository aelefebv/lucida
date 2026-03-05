/** Reusable dimension controller (Z, C, or T) with prev/next buttons and a slider. */

interface Props {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
}

export function DimensionControls({ label, value, max, onChange }: Props) {
  if (max <= 1) return null;

  return (
    <div className="dim-control">
      <span className="dim-label">{label}</span>
      <button
        className="dim-btn"
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <input
        type="range"
        className="dim-slider"
        min={0}
        max={max - 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <button
        className="dim-btn"
        disabled={value >= max - 1}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
      <span className="dim-value">
        {value + 1}/{max}
      </span>
    </div>
  );
}
