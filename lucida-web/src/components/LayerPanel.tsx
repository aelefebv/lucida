import { useEffect, useRef, useState } from "react";
import { ContrastControls } from "./ContrastControls.tsx";
import { ColormapSelector } from "./ColormapSelector.tsx";
import { LayoutSwitcher } from "./LayoutSwitcher.tsx";
import type { LayoutRegistry } from "../pipeline/layoutRegistry.ts";
import type { LevelRange } from "../renderer/workerProtocol.ts";
import { displayedLevelNotice, levelNumbers } from "./levelReadout.ts";
import type { BlendMode, Colormap, RenderMode } from "../savedView/types.ts";
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
  channelSettings?: { visible: boolean; colormap: string; contrast_min: number; contrast_max: number; gamma: number; name?: string }[];
  /**
   * Per-channel labels from the manifest's omero block, in channel order. A
   * missing entry falls back to `Ch {i}`. The user's `name` override in
   * `channelSettings` takes precedence.
   */
  channelInfos?: { label: string; color?: string | null }[];
  /**
   * Rows for every label drawable in either view mode, so the panel is stable
   * across a mode switch. `index` is the manifest index the handlers take. A row
   * not drawable in the current mode carries a `disabledReason`, shown as text
   * beside disabled controls. Empty hides the Labels subsection and badge.
   */
  labelRows?: { index: number; name: string; visible: boolean; opacity: number; disabledReason?: string }[];
  channelBlendMode: string;
  /** The dataset's level pin; `null` means the target level follows the screen. */
  levelPin: number | null;
  /**
   * The levels a pin may hold, finest first, level 0 included, as the scene
   * reports them (`pinnable_levels`), each with a display label. Empty when
   * the scene knows no pyramid for the dataset, which hides the control.
   */
  levelPinOptions: { level: number; label: string }[];
  /**
   * The target level across the dataset's visible entities: the level pin,
   * or the level the screen calls for. A range for a collection whose tiles
   * differ. `null` until the render worker has reported one.
   */
  targetLevel: LevelRange | null;
  /**
   * The finest and coarsest level actually on screen for the dataset, or
   * `null` while nothing is resident yet. Equals `targetLevel` once the
   * target is resident everywhere it is visible.
   */
  displayedLevel: LevelRange | null;
  /** True while some visible pixel comes from a level coarser than its entity's target. */
  displayedCoarserThanTarget: boolean;
  /** The multiscale metadata's downsampling method, or `null` when it declares none. */
  downsamplingMethod: string | null;
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
  onSetColormap: (id: string, colormap: Colormap) => void;
  onSetBlendMode: (id: string, mode: BlendMode) => void;
  onSetRenderMode: (id: string, mode: RenderMode) => void;
  onSetLevelPin: (id: string, level: number | null) => void;
  onAutoContrast: (id: string) => void;
  onAutoContrastToggle: (id: string) => void;
  onFullRangeToggle: (id: string) => void;
  onMoveLayer: (id: string, direction: "up" | "down") => void;
  onRemoveLayer: (id: string) => void;
  onRenameLayer: (id: string, name: string) => void;
  onAddLayer: () => void;
  /** Editor-only affordances (rename) are shown only when true. */
  canEdit: boolean;
  onChannelSetVisible?: (id: string, ch: number, visible: boolean) => void;
  onChannelSetColormap?: (id: string, ch: number, colormap: Colormap) => void;
  /** Set or clear (`null`) a channel's display-name override. Editor-only. An
   *  emptied input passes `null` to fall back to the omero label or `Ch N`. */
  onChannelSetName?: (id: string, ch: number, name: string | null) => void;
  onChannelSetContrast?: (id: string, ch: number, min: number, max: number) => void;
  onChannelSetGamma?: (id: string, ch: number, gamma: number) => void;
  onChannelSetBlendMode?: (id: string, blendMode: BlendMode) => void;
  onLabelSetVisible?: (id: string, label: number, visible: boolean) => void;
  /** Opacity in 0..1. */
  onLabelSetOpacity?: (id: string, label: number, opacity: number) => void;
  viewModeToggle: { label: string; onClick: () => void } | null;
  cameraModeToggle: { label: string; onClick: () => void } | null;
  /** Opens the dev-controls surface (planning knobs, overlays, cache knobs). */
  devControlsToggle?: { label: string; active: boolean; onClick: () => void };
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
  onSetLevelPin,
  onAutoContrast,
  onAutoContrastToggle,
  onFullRangeToggle,
  onMoveLayer,
  onRemoveLayer,
  onRenameLayer,
  onAddLayer,
  canEdit,
  onChannelSetVisible,
  onChannelSetColormap,
  onChannelSetName,
  onChannelSetContrast,
  onChannelSetGamma,
  onChannelSetBlendMode,
  onLabelSetVisible,
  onLabelSetOpacity,
  viewModeToggle,
  cameraModeToggle,
  devControlsToggle,
  layoutRegistry,
  sendCommand,
  onLayoutChange,
  style,
}: Props) {
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null);
  // Keyed by `${layerId}::${channelIndex}` so only one channel across all layers
  // is in edit mode at a time.
  const [renamingChannelKey, setRenamingChannelKey] = useState<string | null>(null);
  // Channels are collapsed by default, so a many-channel layer opens tidy; a key
  // is listed here once expanded. View-only state, never persisted or broadcast.
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());
  const channelKeyOf = (layerId: string, chIdx: number) => `${layerId}::${chIdx}`;
  const toggleChannelExpanded = (channelKey: string) => {
    setExpandedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channelKey)) {
        next.delete(channelKey);
      } else {
        next.add(channelKey);
      }
      return next;
    });
  };
  // Collapse or expand one layer's channels, leaving other layers untouched.
  const setAllChannelsExpanded = (
    layerId: string,
    count: number,
    expanded: boolean,
  ) => {
    setExpandedChannels((prev) => {
      const next = new Set(
        [...prev].filter((k) => !k.startsWith(`${layerId}::`)),
      );
      if (expanded) {
        for (let i = 0; i < count; i++) next.add(channelKeyOf(layerId, i));
      }
      return next;
    });
  };
  return (
    <div className="layer-panel" style={style}>
      <div className="layer-panel-header">
        <h3>Layers</h3>
        <div className="layer-panel-header-buttons">
          {viewModeToggle && (
            <button
              aria-label={`Switch view mode to ${viewModeToggle.label}`}
              onClick={viewModeToggle.onClick}
            >
              {viewModeToggle.label}
            </button>
          )}
          {cameraModeToggle && (
            <button
              aria-label={`Switch camera mode to ${cameraModeToggle.label}`}
              onClick={cameraModeToggle.onClick}
              title="Toggle camera mode (F)"
            >
              {cameraModeToggle.label}
            </button>
          )}
          {devControlsToggle && (
            <button
              aria-label={devControlsToggle.label}
              onClick={devControlsToggle.onClick}
              title="Toggle dev controls"
              style={devControlsToggle.active ? { background: "#4a9eff", color: "#fff" } : undefined}
            >
              {devControlsToggle.label}
            </button>
          )}
          <button aria-label="Add layer" onClick={onAddLayer}>+ Add</button>
        </div>
      </div>
      <div className="layer-list">
        {layers.length === 0 && (
          <div className="layer-empty">No layers. Click "+ Add" to open a folder.</div>
        )}
        {layers.map((layer, index) => {
          const isSelected = layer.id === selectedLayerId;
          const isExpanded = layer.id === expandedLayerId;
          const levelNotice = displayedLevelNotice(layer);

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
                  aria-label={`${layer.visible ? "Hide" : "Show"} layer ${layer.name}`}
                  aria-pressed={layer.visible}
                  onClick={(e) => { e.stopPropagation(); onSetVisible(layer.id, !layer.visible); }}
                >
                  {layer.visible ? "\u25C9" : "\u25CB"}
                </button>
                {canEdit && renamingLayerId === layer.id ? (
                  <LayerNameInput
                    initial={layer.name}
                    onCommit={(name) => {
                      setRenamingLayerId(null);
                      onRenameLayer(layer.id, name);
                    }}
                    onCancel={() => setRenamingLayerId(null)}
                  />
                ) : (
                  <span
                    className="layer-name"
                    title={canEdit ? "Double-click to rename" : layer.name}
                    onDoubleClick={canEdit ? (e) => { e.stopPropagation(); setRenamingLayerId(layer.id); } : undefined}
                  >
                    {layer.name}
                  </span>
                )}
                {/*
                  A count pill telling the user the layer has drawable labels to
                  reach in the Labels panel. Counts the same rows the panel shows,
                  so it never over-promises. Non-interactive; the expand button
                  owns disclosure.
                */}
                {layer.labelRows && layer.labelRows.length > 0 && (
                  <span
                    className="layer-label-badge"
                    data-testid={`layer-label-count-${layer.id}`}
                    aria-label={`${layer.labelRows.length} label${layer.labelRows.length === 1 ? "" : "s"}`}
                    title={`This dataset has ${layer.labelRows.length} segmentation label${layer.labelRows.length === 1 ? "" : "s"}. Expand the layer to toggle them or adjust their opacity in the Labels panel.`}
                  >
                    {`◰ ${layer.labelRows.length}`}
                  </span>
                )}
                {canEdit && renamingLayerId !== layer.id && (
                  <button
                    className="layer-rename-btn"
                    title={`Rename layer ${layer.name}`}
                    aria-label={`Rename layer ${layer.name}`}
                    onClick={(e) => { e.stopPropagation(); setRenamingLayerId(layer.id); }}
                  >
                    {"✎"}
                  </button>
                )}
                <input
                  type="range"
                  className="layer-opacity-slider"
                  aria-label={`${layer.name} opacity`}
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
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} layer ${layer.name}`}
                  aria-expanded={isExpanded}
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
                      <div className="layer-detail-row channel-collapse-controls">
                        <label>Channels</label>
                        <button
                          className="channel-collapse-all-btn"
                          aria-label={`Collapse all channels of ${layer.name}`}
                          onClick={() =>
                            setAllChannelsExpanded(layer.id, layer.channelSettings?.length ?? 0, false)
                          }
                        >
                          Collapse all
                        </button>
                        <button
                          className="channel-collapse-all-btn"
                          aria-label={`Expand all channels of ${layer.name}`}
                          onClick={() =>
                            setAllChannelsExpanded(layer.id, layer.channelSettings?.length ?? 0, true)
                          }
                        >
                          Expand all
                        </button>
                      </div>
                      {layer.channelSettings.map((ch, chIdx) => {
                        // User override, then omero label, then `Ch N`.
                        const chName =
                          ch.name?.trim() ||
                          layer.channelInfos?.[chIdx]?.label?.trim() ||
                          `Ch ${chIdx}`;
                        const channelKey = `${layer.id}::${chIdx}`;
                        const isRenamingChannel = renamingChannelKey === channelKey;
                        // Gates the channel's controls, not its visibility, so a
                        // channel can stay visible with its controls tucked away.
                        const isChannelExpanded = expandedChannels.has(channelKey);
                        return (
                        <div key={chIdx} className="channel-sublayer">
                          <div className="channel-sublayer-header">
                            <button
                              className="layer-eye-btn"
                              title={ch.visible ? "Hide channel" : "Show channel"}
                              aria-label={`${ch.visible ? "Hide" : "Show"} ${layer.name} ${chName}`}
                              aria-pressed={ch.visible}
                              onClick={() => onChannelSetVisible?.(layer.id, chIdx, !ch.visible)}
                            >
                              {ch.visible ? "\u25C9" : "\u25CB"}
                            </button>
                            {canEdit && isRenamingChannel ? (
                              <ChannelNameInput
                                // Start from the override, or empty so the
                                // placeholder shows the inherited name and a
                                // blank commit clears back to it.
                                initial={ch.name ?? ""}
                                placeholder={chName}
                                onCommit={(name) => {
                                  setRenamingChannelKey(null);
                                  const trimmed = name.trim();
                                  onChannelSetName?.(layer.id, chIdx, trimmed.length === 0 ? null : trimmed);
                                }}
                                onCancel={() => setRenamingChannelKey(null)}
                              />
                            ) : (
                              <span
                                className="channel-label"
                                title={canEdit ? "Double-click to rename channel" : chName}
                                onDoubleClick={canEdit ? () => setRenamingChannelKey(channelKey) : undefined}
                              >
                                {chName}
                              </span>
                            )}
                            {canEdit && !isRenamingChannel && (
                              <button
                                className="channel-rename-btn"
                                title={`Rename ${layer.name} ${chName}`}
                                aria-label={`Rename channel ${chName}`}
                                onClick={() => setRenamingChannelKey(channelKey)}
                              >
                                {"\u270E"}
                              </button>
                            )}
                            {/*
                              Per-channel disclosure toggle. It only shows or
                              hides the channel's controls, never visibility. At
                              the row's end so the tab order reads left to right.
                            */}
                            <button
                              className="channel-expand-btn"
                              title={isChannelExpanded ? "Collapse channel" : "Expand channel"}
                              aria-label={`${isChannelExpanded ? "Collapse" : "Expand"} channel ${chName}`}
                              aria-expanded={isChannelExpanded}
                              onClick={() => toggleChannelExpanded(channelKey)}
                            >
                              {isChannelExpanded ? "\u25B2" : "\u25BC"}
                            </button>
                          </div>
                          {isChannelExpanded && (
                            <div className="channel-sublayer-detail">
                              <div className="layer-detail-row">
                                <label>Colormap</label>
                                <ColormapSelector
                                  value={ch.colormap}
                                  label={`${layer.name} ${chName} colormap`}
                                  onChange={(cmap) => onChannelSetColormap?.(layer.id, chIdx, cmap)}
                                />
                              </div>
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
                                labelPrefix={`${layer.name} ${chName}`}
                              />
                            </div>
                          )}
                        </div>
                        );
                      })}
                      <div className="layer-detail-row">
                        <label>Ch Blend</label>
                        <select
                          aria-label={`${layer.name} channel blend mode`}
                          value={layer.channelBlendMode}
                          onChange={(e) => onChannelSetBlendMode?.(layer.id, e.target.value as BlendMode)}
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
                        labelPrefix={layer.name}
                      />
                      <div className="layer-detail-row">
                        <label>Colormap</label>
                        <ColormapSelector
                          value={layer.colormap}
                          label={`${layer.name} colormap`}
                          onChange={(cmap) => onSetColormap(layer.id, cmap)}
                        />
                      </div>
                    </>
                  )}
                  {/*
                    Labels subsection, independent of multi-channel mode. Handlers
                    pass the manifest index (row.index), not the row position, so
                    they hit the right label when earlier labels were skipped. The
                    enclosing `.layer-detail` already stops row-click propagation.
                  */}
                  {layer.labelRows && layer.labelRows.length > 0 && (
                    <div className="layer-labels-section" data-testid={`labels-section-${layer.id}`}>
                      <div className="layer-detail-row">
                        <label>Labels</label>
                      </div>
                      {layer.labelRows.map((row) => {
                        const labelName = row.name.trim() || `Label ${row.index}`;
                        const labelPct = Math.round((row.opacity ?? 0.5) * 100);
                        // A label drawable only in the other view mode gets
                        // disabled controls and its reason as text, rather than
                        // a toggle that draws nothing.
                        const disabled = row.disabledReason !== undefined;
                        return (
                          <div key={row.index} className="label-sublayer">
                            <div className="label-sublayer-header">
                              <button
                                className="layer-eye-btn"
                                title={disabled ? row.disabledReason : row.visible ? "Hide label" : "Show label"}
                                // When disabled, name the state (why it's off)
                                // rather than an action the user can't perform.
                                aria-label={
                                  disabled
                                    ? `${layer.name} ${labelName} — ${row.disabledReason}`
                                    : `${row.visible ? "Hide" : "Show"} ${layer.name} ${labelName}`
                                }
                                // A disabled label draws nothing here, so report
                                // not pressed whatever the persisted flag says.
                                aria-pressed={disabled ? false : row.visible}
                                disabled={disabled}
                                data-testid={`label-eye-${layer.id}-${row.index}`}
                                onClick={() => onLabelSetVisible?.(layer.id, row.index, !row.visible)}
                              >
                                {row.visible ? "◉" : "○"}
                              </button>
                              <span className="label-name" title={labelName}>{labelName}</span>
                              <input
                                type="range"
                                className="label-opacity-slider"
                                aria-label={`${layer.name} ${labelName} opacity`}
                                data-testid={`label-opacity-${layer.id}-${row.index}`}
                                min={0}
                                max={100}
                                value={labelPct}
                                disabled={disabled}
                                title={disabled ? row.disabledReason : `Label opacity: ${labelPct}%`}
                                onChange={(e) => onLabelSetOpacity?.(layer.id, row.index, Number(e.target.value) / 100)}
                              />
                            </div>
                            {disabled && (
                              <div className="label-disabled-reason">{row.disabledReason}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="layer-detail-row">
                    <label>Blend</label>
                    <select
                      aria-label={`${layer.name} blend mode`}
                      value={layer.blendMode}
                      onChange={(e) => onSetBlendMode(layer.id, e.target.value as BlendMode)}
                    >
                      <option value="alpha">Alpha</option>
                      <option value="additive">Additive</option>
                      <option value="max">Max</option>
                    </select>
                  </div>
                  <div className="layer-detail-row">
                    <label>Rendering</label>
                    <select
                      aria-label={`${layer.name} rendering mode`}
                      value={layer.renderMode}
                      onChange={(e) => onSetRenderMode(layer.id, e.target.value as RenderMode)}
                    >
                      <option value="translucent">Translucent</option>
                      <option value="max_intensity">Max Intensity</option>
                    </select>
                  </div>
                  {layer.targetLevel && (
                    <div className="layer-detail-row">
                      <label>Level</label>
                      <span
                        className="layer-level-readout"
                        aria-label={`${layer.name} target level`}
                        title="The level the screen calls for, or the pinned level"
                      >
                        {levelNumbers(layer.targetLevel)}
                      </span>
                      {levelNotice && layer.displayedLevel && (
                        <span
                          className="layer-level-readout layer-level-displayed"
                          aria-label={`${layer.name} displayed level`}
                          title="The level on screen until the target is resident"
                        >
                          displaying {levelNumbers(layer.displayedLevel)}
                        </span>
                      )}
                    </div>
                  )}
                  {layer.downsamplingMethod && (
                    <div className="layer-detail-row">
                      <label>Downsampling</label>
                      <span
                        className="layer-level-readout"
                        aria-label={`${layer.name} downsampling method`}
                      >
                        {layer.downsamplingMethod}
                      </span>
                    </div>
                  )}
                  {levelNotice && (
                    <div className="layer-level-notice" role="status">
                      {levelNotice}
                    </div>
                  )}
                  {layer.levelPinOptions.length > 0 && (
                    <div className="layer-detail-row">
                      <label>Level</label>
                      <select
                        aria-label={`${layer.name} level pin`}
                        value={layer.levelPin ?? ""}
                        onChange={(e) => {
                          const value = e.target.value;
                          onSetLevelPin(layer.id, value === "" ? null : Number(value));
                        }}
                      >
                        <option value="">Follow the screen</option>
                        {layer.levelPinOptions.map((option) => (
                          <option key={option.level} value={option.level}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="layer-actions">
                    <button
                      onClick={() => onMoveLayer(layer.id, "up")}
                      disabled={index === 0}
                      title="Move up (render later / on top)"
                      aria-label={`Move layer ${layer.name} up`}
                    >
                      Up
                    </button>
                    <button
                      onClick={() => onMoveLayer(layer.id, "down")}
                      disabled={index === layers.length - 1}
                      title="Move down (render first / behind)"
                      aria-label={`Move layer ${layer.name} down`}
                    >
                      Down
                    </button>
                    <button
                      onClick={() => onRemoveLayer(layer.id)}
                      style={{ marginLeft: "auto", color: "#f44" }}
                      aria-label={`Remove layer ${layer.name}`}
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

/**
 * Inline rename input for a layer name. Enter or blur commits, Escape cancels.
 * Stops click propagation so editing doesn't select or collapse the row.
 */
function LayerNameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      className="layer-name-input"
      aria-label="Layer name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

/**
 * Inline rename input for a channel's display-name override. Behaves like
 * {@link LayerNameInput}, except the inherited name is the placeholder and an
 * empty commit is meaningful: it clears the override.
 */
function ChannelNameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      className="channel-name-input"
      aria-label="Channel name"
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}
