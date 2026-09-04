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
   * Per-channel display labels from the manifest's omero block, in channel
   * order. Optional/positional: an entry may be missing for a given channel,
   * in which case the row falls back to `Ch {i}`. Names are immutable manifest
   * data, decoupled from the mutable `channelSettings` (which carries the
   * user's per-channel `name` override that takes precedence over these).
   */
  channelInfos?: { label: string; color?: string | null }[];
  /**
   * Per-label overlay rows for the "Labels" subsection + count badge — every
   * label drawable in EITHER view mode (2D or 3D), so the panel is stable across
   * a mode switch and a control never lies about a label that can't draw (a
   * uint8/uint16 mask, an orphan, or one over-caps in both modes is omitted).
   * Each row carries its MANIFEST index (the key the toggle/opacity handlers
   * pass), name, and current visibility + opacity. A row NOT drawable in the
   * CURRENT view mode carries a `disabledReason`: its controls render disabled
   * and the reason shows as text, so the user sees WHY the overlay is inert
   * rather than toggling a control that draws nothing. Absent/empty when the
   * dataset has no drawable labels — the subsection + badge are gated on this
   * having entries.
   */
  labelRows?: { index: number; name: string; visible: boolean; opacity: number; disabledReason?: string }[];
  channelBlendMode: string;
  detailLevelOverride: number | null;
  detailLevelOptions: { level: number; label: string }[];
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
  onSetDetailLevelOverride: (id: string, level: number | null) => void;
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
  /** Set (`name`) or clear (`null`) a user display-name override for a
   *  channel. Editor-only; gated behind the same `canEdit` as the layer
   *  rename. An emptied input passes `null` to clear back to the omero
   *  label / `Ch N`. */
  onChannelSetName?: (id: string, ch: number, name: string | null) => void;
  onChannelSetContrast?: (id: string, ch: number, min: number, max: number) => void;
  onChannelSetGamma?: (id: string, ch: number, gamma: number) => void;
  onChannelSetBlendMode?: (id: string, blendMode: BlendMode) => void;
  /** Toggle a single label overlay's visibility. */
  onLabelSetVisible?: (id: string, label: number, visible: boolean) => void;
  /** Set a single label overlay's opacity (0..1). */
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
  onSetDetailLevelOverride,
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
  // Which layer row's name is currently being edited inline (editor-only).
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null);
  // Which channel sublayer's name is currently being edited inline
  // (editor-only). Keyed by `${layerId}::${channelIndex}` so only one channel
  // across all layers is in edit mode at a time, mirroring `renamingLayerId`.
  const [renamingChannelKey, setRenamingChannelKey] = useState<string | null>(null);
  // Ephemeral per-channel collapse state, mirroring the LAYER-level `isExpanded`
  // disclosure. Channels are **collapsed by default** (a many-channel layer opens
  // tidy); a channel is listed here only once it has been expanded. Keyed by the
  // `${layerId}::${channelIndex}` channel key, so it is tracked independently per
  // channel (no cross-channel bleed) and is decoupled from visibility — view-only
  // React state, never persisted or broadcast.
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());
  const channelKeyOf = (layerId: string, chIdx: number) => `${layerId}::${chIdx}`;
  // Flip a single channel's expanded flag without touching any other channel.
  // A fresh Set keeps the state update immutable (so React re-renders) and the
  // per-key add/delete guarantees siblings are untouched.
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
  // Collapse-all / expand-all for ONE layer's channels at once. Keys are
  // per-layer, so we only ever clear/add this layer's keys — other layers'
  // collapse state is left untouched.
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
                  Discoverability affordance: a small count pill on the row when
                  the dataset carries DRAWABLE segmentation labels, so the user
                  knows to expand the layer and reach the "Labels" panel (toggle +
                  opacity). Counts only renderable labels (matches the rows the
                  panel shows) so the badge never over-promises. Non-interactive
                  (the row/expand button owns disclosure); its title + aria-label
                  carry the meaning. Mirrors the MentionsOfMe count-pill style.
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
                        // Display-name precedence: user override \u2192 omero label
                        // (B1) \u2192 `Ch N`. The override is the mutable per-channel
                        // `name`; the omero label is immutable manifest data.
                        const chName =
                          ch.name?.trim() ||
                          layer.channelInfos?.[chIdx]?.label?.trim() ||
                          `Ch ${chIdx}`;
                        const channelKey = `${layer.id}::${chIdx}`;
                        const isRenamingChannel = renamingChannelKey === channelKey;
                        // Expanded by default; only collapsed once the user opts
                        // in via the per-channel toggle. Decoupled from
                        // `ch.visible`: gating the colormap + contrast on this
                        // (not visibility) lets a channel stay visible while its
                        // controls are tucked away.
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
                                // Pre-fill with the user override if one is set;
                                // otherwise start empty so the placeholder shows
                                // the inherited (omero/`Ch N`) name and a blank
                                // commit clears back to it.
                                initial={ch.name ?? ""}
                                placeholder={chName}
                                onCommit={(name) => {
                                  setRenamingChannelKey(null);
                                  const trimmed = name.trim();
                                  // Empty \u2192 clear the override (null); else set.
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
                              Per-channel disclosure toggle. A real <button> with
                              `aria-expanded` that controls the channel's own
                              detail region (colormap + contrast). Mirrors the
                              LAYER expand button (\u25B2 open / \u25BC collapsed) and
                              its accessible-name shape, but is purely about
                              showing/hiding controls \u2014 it never touches
                              visibility (`onChannelSetVisible`) or any sibling
                              channel. Lives at the row's end so the eye + name +
                              rename keep their place and the tab order reads
                              left-to-right.
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
                    Labels subsection — the per-label overlay controls, a sibling
                    of the channel controls above but independent of multi-channel
                    mode (labels overlay the intensity image regardless). Shows a
                    row per DRAWABLE label (ineligible ones are omitted, so no inert
                    control). Each row: an eye toggle (hide/show the overlay) + an
                    opacity slider ("adjust opacity so we can see the data
                    underneath"). Handlers pass the label's MANIFEST index (row.index)
                    — not the row position — so they hit the right label even when
                    earlier labels were skipped. Neither ever reframes the camera.
                    The enclosing `.layer-detail` already stops row-click
                    propagation, so these controls don't need their own.
                  */}
                  {layer.labelRows && layer.labelRows.length > 0 && (
                    <div className="layer-labels-section" data-testid={`labels-section-${layer.id}`}>
                      <div className="layer-detail-row">
                        <label>Labels</label>
                      </div>
                      {layer.labelRows.map((row) => {
                        const labelName = row.name.trim() || `Label ${row.index}`;
                        const labelPct = Math.round((row.opacity ?? 0.5) * 100);
                        // A label drawable only in the OTHER view mode: its
                        // controls are inert here, so disable them and show the
                        // reason as text. This keeps the panel honest — no eye
                        // toggle or slider that "works" but draws nothing.
                        const disabled = row.disabledReason !== undefined;
                        return (
                          <div key={row.index} className="label-sublayer">
                            <div className="label-sublayer-header">
                              <button
                                className="layer-eye-btn"
                                title={disabled ? row.disabledReason : row.visible ? "Hide label" : "Show label"}
                                // When disabled the toggle can't act, so name the
                                // STATE (why it's off) instead of a "Hide/Show"
                                // action a screen-reader user cannot perform.
                                aria-label={
                                  disabled
                                    ? `${layer.name} ${labelName} — ${row.disabledReason}`
                                    : `${row.visible ? "Hide" : "Show"} ${layer.name} ${labelName}`
                                }
                                // A disabled label draws nothing in the current
                                // mode, so the toggle is not "pressed" here
                                // regardless of the persisted visible flag —
                                // report the state the user actually sees.
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
                  {layer.detailLevelOptions.length > 0 && (
                    <div className="layer-detail-row">
                      <label>Detail</label>
                      <select
                        aria-label={`${layer.name} detail level`}
                        value={layer.detailLevelOverride ?? ""}
                        onChange={(e) => {
                          const value = e.target.value;
                          onSetDetailLevelOverride(layer.id, value === "" ? null : Number(value));
                        }}
                      >
                        <option value="">Highest res</option>
                        {layer.detailLevelOptions.map((option) => (
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
 * Inline rename input for a layer name. Auto-focuses and selects on mount;
 * Enter (or blur) commits, Escape cancels. Stops click propagation so editing
 * the name does not select/collapse the row. Mirrors the saved-view rename
 * affordance for a consistent feel.
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
 * Inline rename input for a single channel's display-name override. Mirrors
 * {@link LayerNameInput} (auto-focus + select on mount; Enter/blur commits,
 * Escape cancels; stops click propagation), with two channel-specific
 * differences:
 *  - it starts from the current override (empty when none is set) and shows the
 *    inherited name (omero label / `Ch N`) as the `placeholder`, and
 *  - an **empty** commit is meaningful: it clears the override (the caller maps
 *    blank → `null`), falling the label back to the omero/`Ch N` name. (The
 *    layer rename, by contrast, ignores a blank value.)
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
