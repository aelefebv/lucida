import { ContrastControls } from "./ContrastControls.tsx";
import "./LayerPanel.css";

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  blendMode: string;
  renderMode: string;
  autoContrast: boolean;
  fullRange: boolean;
  dataRange: { min: number; max: number } | null;
  fullRangeMax: number;
}

interface Props {
  layers: LayerInfo[];
  selectedLayerId: string | null;
  expandedLayerId: string | null;
  onSelectLayer: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onSetVisible: (id: string, visible: boolean) => void;
  onSetOpacity: (id: string, opacity: number) => void;
  onSetContrast: (id: string, min: number, max: number) => void;
  onSetGamma: (id: string, gamma: number) => void;
  onSetBlendMode: (id: string, mode: string) => void;
  onSetRenderMode: (id: string, mode: string) => void;
  onAutoContrast: (id: string) => void;
  onAutoContrastToggle: (id: string) => void;
  onFullRangeToggle: (id: string) => void;
  onMoveLayer: (id: string, direction: "up" | "down") => void;
  onRemoveLayer: (id: string) => void;
  onAddLayer: () => void;
  viewModeToggle: { label: string; onClick: () => void } | null;
  style?: React.CSSProperties;
}

export function LayerPanel({
  layers,
  selectedLayerId,
  expandedLayerId,
  onSelectLayer,
  onToggleExpand,
  onSetVisible,
  onSetOpacity,
  onSetContrast,
  onSetGamma,
  onSetBlendMode,
  onSetRenderMode,
  onAutoContrast,
  onAutoContrastToggle,
  onFullRangeToggle,
  onMoveLayer,
  onRemoveLayer,
  onAddLayer,
  viewModeToggle,
  style,
}: Props) {
  return (
    <div className="layer-panel" style={style}>
      <div className="layer-panel-header">
        <h3>Layers</h3>
        <div className="layer-panel-header-buttons">
          {viewModeToggle && (
            <button onClick={viewModeToggle.onClick}>{viewModeToggle.label}</button>
          )}
          <button onClick={onAddLayer}>+ Add</button>
        </div>
      </div>
      <div className="layer-list">
        {layers.length === 0 && (
          <div className="layer-empty">No layers. Click "+ Add" to open a folder.</div>
        )}
        {layers.map((layer, index) => {
          const isSelected = layer.id === selectedLayerId;
          const isExpanded = layer.id === expandedLayerId;

          return (
            <div
              key={layer.id}
              className={`layer-row${isSelected ? " selected" : ""}`}
              onClick={() => onSelectLayer(layer.id)}
            >
              <div className="layer-row-header">
                <button
                  className="layer-eye-btn"
                  title={layer.visible ? "Hide" : "Show"}
                  onClick={(e) => { e.stopPropagation(); onSetVisible(layer.id, !layer.visible); }}
                >
                  {layer.visible ? "\u25C9" : "\u25CB"}
                </button>
                <span className="layer-name" title={layer.name}>{layer.name}</span>
                <input
                  type="range"
                  className="layer-opacity-slider"
                  min={0}
                  max={100}
                  value={Math.round(layer.opacity * 100)}
                  title={`Opacity: ${Math.round(layer.opacity * 100)}%`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => { e.stopPropagation(); onSetOpacity(layer.id, Number(e.target.value) / 100); }}
                />
                <button
                  className="layer-expand-btn"
                  title={isExpanded ? "Collapse" : "Expand"}
                  onClick={(e) => { e.stopPropagation(); onToggleExpand(layer.id); }}
                >
                  {isExpanded ? "\u25B2" : "\u25BC"}
                </button>
              </div>
              {isExpanded && (
                <div className="layer-detail" onClick={(e) => e.stopPropagation()}>
                  <ContrastControls
                    dataMin={layer.dataRange?.min ?? 0}
                    dataMax={layer.dataRange?.max ?? 65535}
                    contrastMin={layer.contrastMin}
                    contrastMax={layer.contrastMax}
                    gamma={layer.gamma}
                    autoContrast={layer.autoContrast}
                    onContrastChange={(min, max) => onSetContrast(layer.id, min, max)}
                    onGammaChange={(g) => onSetGamma(layer.id, g)}
                    onAutoContrast={() => onAutoContrast(layer.id)}
                    onAutoContrastToggle={() => onAutoContrastToggle(layer.id)}
                    fullRange={layer.fullRange}
                    onFullRangeToggle={() => onFullRangeToggle(layer.id)}
                    fullRangeMax={layer.fullRangeMax}
                  />
                  <div className="layer-detail-row">
                    <label>Blend</label>
                    <select
                      value={layer.blendMode}
                      onChange={(e) => onSetBlendMode(layer.id, e.target.value)}
                    >
                      <option value="alpha">Alpha</option>
                      <option value="additive">Additive</option>
                      <option value="max">Max</option>
                    </select>
                  </div>
                  <div className="layer-detail-row">
                    <label>Rendering</label>
                    <select
                      value={layer.renderMode}
                      onChange={(e) => onSetRenderMode(layer.id, e.target.value)}
                    >
                      <option value="translucent">Translucent</option>
                      <option value="max_intensity">Max Intensity</option>
                    </select>
                  </div>
                  <div className="layer-actions">
                    <button
                      onClick={() => onMoveLayer(layer.id, "up")}
                      disabled={index === 0}
                      title="Move up (render later / on top)"
                    >
                      Up
                    </button>
                    <button
                      onClick={() => onMoveLayer(layer.id, "down")}
                      disabled={index === layers.length - 1}
                      title="Move down (render first / behind)"
                    >
                      Down
                    </button>
                    <button
                      onClick={() => onRemoveLayer(layer.id)}
                      style={{ marginLeft: "auto", color: "#f44" }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
