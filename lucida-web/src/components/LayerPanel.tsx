import { ContrastControls } from "./ContrastControls.tsx";
import { ColormapSelector } from "./ColormapSelector.tsx";
import { LayoutSwitcher } from "./LayoutSwitcher.tsx";
import type { LayoutRegistry } from "../pipeline/layoutRegistry.ts";
import "./LayerPanel.css";

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  colormap: string;
  blendMode: string;
  renderMode: string;
  autoContrast: boolean;
  fullRange: boolean;
  dataRange: { min: number; max: number } | null;
  fullRangeMax: number;
  channelSettings?: { visible: boolean; colormap: string; contrast_min: number; contrast_max: number; gamma: number }[];
  channelBlendMode: string;
}

interface Props {
  layers: LayerInfo[];
  selectedLayerId: string | null;
  expandedLayerId: string | null;
  multiChannel: boolean;
  onSelectLayer: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onSetVisible: (id: string, visible: boolean) => void;
  onSetOpacity: (id: string, opacity: number) => void;
  onSetContrast: (id: string, min: number, max: number) => void;
  onSetGamma: (id: string, gamma: number) => void;
  onSetColormap: (id: string, colormap: string) => void;
  onSetBlendMode: (id: string, mode: string) => void;
  onSetRenderMode: (id: string, mode: string) => void;
  onAutoContrast: (id: string) => void;
  onAutoContrastToggle: (id: string) => void;
  onFullRangeToggle: (id: string) => void;
  onMoveLayer: (id: string, direction: "up" | "down") => void;
  onRemoveLayer: (id: string) => void;
  onAddLayer: () => void;
  onChannelSetVisible?: (id: string, ch: number, visible: boolean) => void;
  onChannelSetColormap?: (id: string, ch: number, colormap: string) => void;
  onChannelSetContrast?: (id: string, ch: number, min: number, max: number) => void;
  onChannelSetGamma?: (id: string, ch: number, gamma: number) => void;
  onChannelSetBlendMode?: (id: string, blendMode: string) => void;
  viewModeToggle: { label: string; onClick: () => void } | null;
  cameraModeToggle: { label: string; onClick: () => void } | null;
  debugToggle?: { label: string; active: boolean; onClick: () => void };
  layoutRegistry: LayoutRegistry | null;
  sendCommand: (json: string) => void;
  onLayoutChange?: () => void;
  style?: React.CSSProperties;
}

export function LayerPanel({
  layers,
  selectedLayerId,
  expandedLayerId,
  multiChannel,
  onSelectLayer,
  onToggleExpand,
  onSetVisible,
  onSetOpacity,
  onSetContrast,
  onSetGamma,
  onSetColormap,
  onSetBlendMode,
  onSetRenderMode,
  onAutoContrast,
  onAutoContrastToggle,
  onFullRangeToggle,
  onMoveLayer,
  onRemoveLayer,
  onAddLayer,
  onChannelSetVisible,
  onChannelSetColormap,
  onChannelSetContrast,
  onChannelSetGamma,
  onChannelSetBlendMode,
  viewModeToggle,
  cameraModeToggle,
  debugToggle,
  layoutRegistry,
  sendCommand,
  onLayoutChange,
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
          {cameraModeToggle && (
            <button onClick={cameraModeToggle.onClick} title="Toggle camera mode (F)">{cameraModeToggle.label}</button>
          )}
          {debugToggle && (
            <button
              onClick={debugToggle.onClick}
              title="Toggle debug overlay"
              style={debugToggle.active ? { background: "#4a9eff", color: "#fff" } : undefined}
            >
              {debugToggle.label}
            </button>
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
                  <LayoutSwitcher
                    datasetId={layer.id}
                    registry={layoutRegistry}
                    sendCommand={sendCommand}
                    onAfterChange={onLayoutChange}
                  />
                  {multiChannel && layer.channelSettings ? (
                    <>
                      {layer.channelSettings.map((ch, chIdx) => (
                        <div key={chIdx} className="channel-sublayer">
                          <div className="channel-sublayer-header">
                            <button
                              className="layer-eye-btn"
                              title={ch.visible ? "Hide channel" : "Show channel"}
                              onClick={() => onChannelSetVisible?.(layer.id, chIdx, !ch.visible)}
                            >
                              {ch.visible ? "\u25C9" : "\u25CB"}
                            </button>
                            <span className="channel-label">Ch {chIdx}</span>
                            <ColormapSelector
                              value={ch.colormap}
                              onChange={(cmap) => onChannelSetColormap?.(layer.id, chIdx, cmap)}
                            />
                          </div>
                          {ch.visible && (
                            <div className="channel-sublayer-detail">
                              <ContrastControls
                                dataMin={0}
                                dataMax={layer.fullRangeMax}
                                contrastMin={ch.contrast_min}
                                contrastMax={ch.contrast_max}
                                gamma={ch.gamma}
                                autoContrast={false}
                                onContrastChange={(min, max) => onChannelSetContrast?.(layer.id, chIdx, min, max)}
                                onGammaChange={(g) => onChannelSetGamma?.(layer.id, chIdx, g)}
                                onAutoContrast={() => {}}
                                onAutoContrastToggle={() => {}}
                                fullRange={false}
                                onFullRangeToggle={() => {}}
                                fullRangeMax={layer.fullRangeMax}
                              />
                            </div>
                          )}
                        </div>
                      ))}
                      <div className="layer-detail-row">
                        <label>Ch Blend</label>
                        <select
                          value={layer.channelBlendMode}
                          onChange={(e) => onChannelSetBlendMode?.(layer.id, e.target.value)}
                        >
                          <option value="alpha">Alpha</option>
                          <option value="additive">Additive</option>
                          <option value="max">Max</option>
                        </select>
                      </div>
                    </>
                  ) : (
                    <>
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
                        <label>Colormap</label>
                        <ColormapSelector
                          value={layer.colormap}
                          onChange={(cmap) => onSetColormap(layer.id, cmap)}
                        />
                      </div>
                    </>
                  )}
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
