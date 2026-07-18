interface Props {
  dataMin: number;
  dataMax: number;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  autoContrast: boolean;
  onContrastChange: (min: number, max: number) => void;
  onGammaChange: (gamma: number) => void;
  onAutoContrast: () => void;
  onAutoContrastToggle: () => void;
  fullRange: boolean;
  onFullRangeToggle: () => void;
  fullRangeMax: number;
  labelPrefix?: string;
}

export function ContrastControls({
  dataMin,
  dataMax,
  contrastMin,
  contrastMax,
  gamma,
  autoContrast,
  onContrastChange,
  onGammaChange,
  onAutoContrast,
  onAutoContrastToggle,
  fullRange,
  onFullRangeToggle,
  fullRangeMax,
  labelPrefix = "",
}: Props) {
  const effectiveMin = fullRange ? 0 : dataMin;
  const effectiveMax = fullRange ? fullRangeMax : dataMax;
  const range = effectiveMax - effectiveMin;
  const fillLeft = range > 0 ? ((contrastMin - effectiveMin) / range) * 100 : 0;
  const fillRight = range > 0 ? ((contrastMax - effectiveMin) / range) * 100 : 100;
  const prefix = labelPrefix ? `${labelPrefix} ` : "";

  return (
    <div className="contrast-controls">
      <div className="dim-control">
        <span className="dim-label" style={{ width: "auto" }}>Contrast</span>
        <div className="range-slider">
          <div className="range-slider-track" />
          <div
            className="range-slider-fill"
            style={{ left: `${fillLeft}%`, width: `${fillRight - fillLeft}%` }}
          />
          <input
            type="range"
            className="range-slider-input"
            aria-label={`${prefix}contrast minimum`}
            min={effectiveMin}
            max={effectiveMax}
            value={contrastMin}
            onChange={(e) => {
              const v = Number(e.target.value);
              onContrastChange(Math.min(v, contrastMax - 1), contrastMax);
            }}
          />
          <input
            type="range"
            className="range-slider-input"
            aria-label={`${prefix}contrast maximum`}
            min={effectiveMin}
            max={effectiveMax}
            value={contrastMax}
            onChange={(e) => {
              const v = Number(e.target.value);
              onContrastChange(contrastMin, Math.max(v, contrastMin + 1));
            }}
          />
        </div>
        <span className="dim-value">{Math.round(contrastMin)}-{Math.round(contrastMax)}</span>
      </div>

      <div className="dim-control">
        <span className="dim-label" style={{ width: "auto" }}>Gamma</span>
        <input
          type="range"
          className="dim-slider"
          aria-label={`${prefix}gamma`}
          min={10}
          max={500}
          value={Math.round(gamma * 100)}
          onChange={(e) => onGammaChange(Number(e.target.value) / 100)}
        />
        <span className="dim-value">{gamma.toFixed(2)}</span>
      </div>

      <div className="dim-control">
        <button
          className="auto-btn"
          aria-label={`${prefix}apply automatic contrast once`}
          onClick={onAutoContrast}
          title="Recalculate contrast from the currently visible data"
        >
          Apply auto
        </button>
        <button
          className={`auto-btn${autoContrast ? " auto-btn-active" : ""}`}
          aria-label={`${prefix}keep contrast automatic`}
          aria-pressed={autoContrast}
          onClick={onAutoContrastToggle}
          title="Keep recalculating contrast as the data changes"
        >
          Keep auto
        </button>
        <button
          className={`auto-btn${fullRange ? " auto-btn-active" : ""}`}
          aria-label={`${prefix}full range`}
          aria-pressed={fullRange}
          onClick={onFullRangeToggle}
        >
          Full
        </button>
      </div>
    </div>
  );
}
