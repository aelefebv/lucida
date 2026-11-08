import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  CaretUpIcon,
  DotsThreeIcon,
  DotsThreeVerticalIcon,
  EyeIcon,
  EyeSlashIcon,
  HeadphonesIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import type { PressEvent } from "react-aria-components";
import {
  Badge,
  Button,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  PanelHeader,
  Select,
  Slider,
  Switch,
  TextField,
  useCommands,
  type CommandOptions,
  type KeyCombo,
} from "../ui/index.ts";
import { ContrastControls } from "./ContrastControls.tsx";
import { ColormapPicker } from "./ColormapPicker.tsx";
import { colormapTitle } from "./colormapSwatch.ts";
import { LayoutSwitcher } from "./LayoutSwitcher.tsx";
import type { LayoutRegistry } from "../pipeline/layoutRegistry.ts";
import type { LevelRange } from "../renderer/workerProtocol.ts";
import type { DatasetImportWarning } from "../bridge.ts";
import { displayedLevelNotice, levelNumbers } from "./levelReadout.ts";
import { coverageNotice, useCoverageLoss } from "../hooks/useCoverageLoss.ts";
import type { BlendMode, Colormap, RenderMode } from "../savedView/types.ts";
import {
  applyChannelToggle,
  channelDisplayName,
  channelShortcutTarget,
  isChannelShown,
  isLastShownChannel,
} from "./channels.ts";
import { positionLabel } from "../axes.ts";
import "./LayerPanel.css";

export interface LayerChannel {
  /** The override, else the metadata label, else `Channel n`. */
  name: string;
  /** The user's override, or `null` when the name is inherited. */
  nameOverride: string | null;
  /** The name without the override: the placeholder while renaming. */
  inheritedName: string;
  visible: boolean;
  colormap: string;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  /** The loaded data's range for this channel, or `null` before any has loaded. */
  dataRange: { min: number; max: number } | null;
}

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  /** One per channel in the data, so a single-channel image has one. */
  channels: LayerChannel[];
  /** Continuous auto-contrast: every channel keeps fitting its loaded data. */
  autoContrast: boolean;
  /** Every value the data type holds, or `null` for a float type. */
  valueRange: readonly [number, number] | null;
  /** Whether values are whole numbers. */
  integerData: boolean;
  blendMode: string;
  renderMode: string;
  channelBlendMode: string;
  /**
   * Rows for every label drawable in either view mode, so the panel is stable
   * across a mode switch. `index` is the manifest index the handlers take. A row
   * not drawable in the current mode carries a `disabledReason`, shown as text
   * beside disabled controls. Empty hides the Labels subsection and badge.
   */
  labelRows?: { index: number; name: string; visible: boolean; opacity: number; disabledReason?: string }[];
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
  /** The channel shown alone, or `null` for the composite. One for the whole scene. */
  soloChannel: number | null;
  /** Each dataset's import warnings, by layer id. Those that say the data is
   *  shown wrong mark the layer degraded and are spelled out under it. */
  importWarnings?: ReadonlyMap<string, readonly DatasetImportWarning[]>;
  /** Editor-only affordances (rename) are shown only when true. */
  canEdit: boolean;
  onSelectLayer: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onSetVisible: (id: string, visible: boolean) => void;
  onSetOpacity: (id: string, opacity: number) => void;
  onRenameLayer: (id: string, name: string) => void;
  onMoveLayer: (id: string, direction: "up" | "down") => void;
  onRemoveLayer: (id: string) => void;
  /** Opens whatever adds data to the workspace. */
  onAddData: () => void;
  onSetBlendMode: (id: string, mode: BlendMode) => void;
  onSetRenderMode: (id: string, mode: RenderMode) => void;
  onSetLevelPin: (id: string, level: number | null) => void;
  onAutoContrastChange: (id: string, on: boolean) => void;
  onChannelSetVisible: (id: string, ch: number, visible: boolean) => void;
  onChannelSetColormap: (id: string, ch: number, colormap: Colormap) => void;
  /** Set or clear (`null`) a channel's display-name override. Editor-only. An
   *  emptied input passes `null` to fall back to the metadata label. */
  onChannelSetName: (id: string, ch: number, name: string | null) => void;
  onChannelSetContrast: (id: string, ch: number, min: number, max: number) => void;
  onChannelSetGamma: (id: string, ch: number, gamma: number) => void;
  /** Fit a channel's contrast to its loaded data once. */
  onChannelAutoFit: (id: string, ch: number) => void;
  onChannelSetBlendMode: (id: string, blendMode: BlendMode) => void;
  /** Solo a channel, or return to the composite when it is already soloed. */
  onSoloChannel: (ch: number) => void;
  onShowAllChannels: () => void;
  onLabelSetVisible: (id: string, label: number, visible: boolean) => void;
  /** Opacity in 0..1. */
  onLabelSetOpacity: (id: string, label: number, opacity: number) => void;
  layoutRegistry: LayoutRegistry | null;
  sendCommand: (json: string) => void;
  onLayoutChange?: () => void;
}

const CHANNEL_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const satisfies readonly KeyCombo[];
const SOLO_KEYS = [
  "Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5", "Alt+6", "Alt+7", "Alt+8", "Alt+9",
] as const satisfies readonly KeyCombo[];

const BLEND_OPTIONS = [
  { value: "alpha", label: "Alpha" },
  { value: "additive", label: "Additive" },
  { value: "max", label: "Maximum" },
] as const;

const RENDER_OPTIONS = [
  { value: "translucent", label: "Translucent" },
  { value: "max_intensity", label: "Maximum intensity" },
] as const;

export function LayerPanel(props: Props) {
  const { layers, selectedLayerId, soloChannel, onAddData } = props;
  const coverage = useCoverageLoss();

  const toggleLayerChannel = (layer: LayerInfo, channel: number) =>
    applyChannelToggle(layer, soloChannel, channel, props);

  // One command per channel the target layer has, so the palette and the
  // shortcut sheet list only channels that exist, by name.
  const shortcutTarget = channelShortcutTarget(layers, selectedLayerId);
  const channelCommands: CommandOptions[] = (shortcutTarget?.channels ?? [])
    .slice(0, CHANNEL_KEYS.length)
    .flatMap((channel, i) => [
      {
        id: `channels.toggle${i + 1}`,
        label: `Show or hide ${channel.name}`,
        group: "Channels",
        keys: [CHANNEL_KEYS[i]],
        keywords: [positionLabel("channel", i), "visibility"],
        run: () => {
          if (shortcutTarget) toggleLayerChannel(shortcutTarget, i);
        },
      },
      {
        id: `channels.solo${i + 1}`,
        label: soloChannel === i ? "Show all channels" : `Solo ${channel.name}`,
        group: "Channels",
        keys: [SOLO_KEYS[i]],
        keywords: [positionLabel("channel", i), "solo", "composite"],
        run: () => props.onSoloChannel(i),
      },
    ]);
  useCommands(channelCommands);

  return (
    <div className="lc-layer-panel">
      <PanelHeader
        className="lc-layer-panel-header"
        title="Layers"
        actions={
          <IconButton icon={PlusIcon} size="sm" label="Add data" tooltipPlacement="bottom" onPress={onAddData} />
        }
      />
      <div className="lc-layer-list">
        {layers.length === 0 && (
          <div className="lc-layer-empty">
            <p>No layers yet.</p>
            <Button icon={PlusIcon} size="sm" onPress={onAddData}>
              Add data
            </Button>
          </div>
        )}
        {layers.map((layer, index) => (
          <LayerRow
            key={layer.id}
            {...props}
            layer={layer}
            index={index}
            isShortcutTarget={shortcutTarget?.id === layer.id}
            onToggleChannel={(channel) => toggleLayerChannel(layer, channel)}
          />
        ))}
      </div>
      {coverage !== null && layers.length > 0 && (
        <p
          className="lc-coverage-notice"
          role="status"
          title="The view settled with what fits in memory. Zoom in or show fewer channels or datasets to cover more."
        >
          {coverageNotice(coverage)}
        </p>
      )}
    </div>
  );
}

interface LayerRowProps extends Props {
  layer: LayerInfo;
  index: number;
  /** The channel keys act on this layer, so its toggles show them. */
  isShortcutTarget: boolean;
  onToggleChannel: (channel: number) => void;
}

function LayerRow(props: LayerRowProps) {
  const { layer, index, layers, canEdit, soloChannel } = props;
  const [renaming, setRenaming] = useState(false);
  const isSelected = layer.id === props.selectedLayerId;
  const isExpanded = layer.id === props.expandedLayerId;
  const bodyId = useId();
  const multichannel = layer.channels.length > 1;
  // One `c` serves the scene, so a layer without the soloed channel draws nothing.
  const hiddenBySolo = soloChannel !== null && soloChannel >= layer.channels.length;
  const problems = (props.importWarnings?.get(layer.id) ?? []).filter((warning) => warning.degrades);
  const problemsId = useId();

  return (
    <section
      className="lc-layer"
      aria-label={layer.name}
      data-selected={isSelected || undefined}
      onClick={() => props.onSelectLayer(layer.id)}
    >
      <div className="lc-layer-head">
        <IconButton
          icon={isExpanded ? CaretDownIcon : CaretRightIcon}
          size="sm"
          label={`${isExpanded ? "Collapse" : "Expand"} layer ${layer.name}`}
          aria-expanded={isExpanded}
          aria-controls={isExpanded ? bodyId : undefined}
          onPress={() => props.onToggleExpand(layer.id)}
        />
        <IconButton
          icon={layer.visible ? EyeIcon : EyeSlashIcon}
          size="sm"
          label={`${layer.visible ? "Hide" : "Show"} layer ${layer.name}`}
          onPress={() => props.onSetVisible(layer.id, !layer.visible)}
        />
        {canEdit && renaming ? (
          <InlineNameField
            label="Layer name"
            initial={layer.name}
            onCommit={(name) => {
              setRenaming(false);
              props.onRenameLayer(layer.id, name);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span
            className="lc-layer-name"
            data-hidden={!layer.visible || undefined}
            title={canEdit ? `${layer.name} (double-click to rename)` : layer.name}
            onDoubleClick={canEdit ? () => setRenaming(true) : undefined}
          >
            {layer.name}
          </span>
        )}
        {layer.labelRows && layer.labelRows.length > 0 && (
          <span data-testid={`layer-label-count-${layer.id}`}>
            <Badge>{`${layer.labelRows.length} label${layer.labelRows.length === 1 ? "" : "s"}`}</Badge>
          </span>
        )}
        {problems.length > 0 && (
          <span data-testid={`layer-degraded-${layer.id}`} aria-describedby={problemsId}>
            <Badge tone="warning">Degraded</Badge>
          </span>
        )}
        <Menu
          label={`Layer ${layer.name} actions`}
          placement="bottom end"
          trigger={<IconButton icon={DotsThreeIcon} size="sm" label={`More for layer ${layer.name}`} />}
        >
          {canEdit && (
            <MenuItem icon={PencilSimpleIcon} onAction={() => setRenaming(true)}>
              Rename
            </MenuItem>
          )}
          <MenuItem icon={ArrowUpIcon} isDisabled={index === 0} onAction={() => props.onMoveLayer(layer.id, "up")}>
            Move up
          </MenuItem>
          <MenuItem
            icon={ArrowDownIcon}
            isDisabled={index === layers.length - 1}
            onAction={() => props.onMoveLayer(layer.id, "down")}
          >
            Move down
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={TrashIcon} variant="danger" onAction={() => props.onRemoveLayer(layer.id)}>
            Remove
          </MenuItem>
        </Menu>
      </div>
      <div className="lc-layer-opacity">
        <Slider<number>
          label="Opacity"
          value={layer.opacity}
          minValue={0}
          maxValue={1}
          step={0.01}
          formatOptions={{ style: "percent" }}
          onChange={(v) => props.onSetOpacity(layer.id, v)}
        />
      </div>
      {problems.length > 0 && (
        <ul className="lc-layer-problems" id={problemsId} aria-label={`${layer.name} data problems`}>
          {problems.map((warning) => (
            <li key={warning.message}>{warning.message}</li>
          ))}
        </ul>
      )}
      {hiddenBySolo && (
        <p className="lc-layer-note">
          {`Not shown while ${positionLabel("channel", soloChannel ?? 0)} is soloed.`}
        </p>
      )}
      {isExpanded && (
        <div className="lc-layer-body" id={bodyId}>
          {multichannel ? <ChannelList {...props} /> : <SingleChannel {...props} />}
          {layer.labelRows && layer.labelRows.length > 0 && <LabelList {...props} />}
          <Advanced {...props} />
        </div>
      )}
    </section>
  );
}

/** The colormap and contrast of an image with one channel. */
function SingleChannel({ layer, ...props }: LayerRowProps) {
  const channel = layer.channels[0];
  const [fullRange, setFullRange] = useState(false);
  if (!channel) return null;
  return (
    <div className="lc-layer-single">
      <div className="lc-layer-field">
        <span className="lc-layer-field-label">Colormap</span>
        <ColormapPicker
          value={channel.colormap}
          label={layer.name}
          onChange={(cmap) => props.onChannelSetColormap(layer.id, 0, cmap)}
        />
        <span className="lc-layer-field-value">{colormapTitle(channel.colormap)}</span>
      </div>
      <ContrastControls
        label={layer.name}
        contrastMin={channel.contrastMin}
        contrastMax={channel.contrastMax}
        gamma={channel.gamma}
        dataRange={channel.dataRange}
        valueRange={layer.valueRange}
        integer={layer.integerData}
        fullRange={fullRange}
        onFullRangeChange={setFullRange}
        onContrastChange={(min, max) => props.onChannelSetContrast(layer.id, 0, min, max)}
        onGammaChange={(g) => props.onChannelSetGamma(layer.id, 0, g)}
        onAutoFit={() => props.onChannelAutoFit(layer.id, 0)}
        continuous={{
          isSelected: layer.autoContrast,
          onChange: (on) => props.onAutoContrastChange(layer.id, on),
        }}
      />
    </div>
  );
}

function ChannelList(props: LayerRowProps) {
  const { layer, soloChannel } = props;
  return (
    <div className="lc-channels" role="group" aria-label={`${layer.name} channels`}>
      <div className="lc-channels-head">
        <span className="lc-layer-section-title">Channels</span>
        <Switch
          className="lc-channels-auto"
          label="Keep contrast fitted"
          isSelected={layer.autoContrast}
          onChange={(on) => props.onAutoContrastChange(layer.id, on)}
        />
      </div>
      <ul className="lc-channel-list">
        {layer.channels.map((channel, i) => (
          <ChannelRow key={i} {...props} channel={channel} channelIndex={i} />
        ))}
      </ul>
      {soloChannel !== null && (
        <div className="lc-channels-solo">
          <span>{`${layer.channels[soloChannel]?.name ?? channelDisplayName(soloChannel)} is soloed.`}</span>
          <Button size="sm" variant="ghost" onPress={props.onShowAllChannels}>
            Show all
          </Button>
        </div>
      )}
    </div>
  );
}

function ChannelRow(props: LayerRowProps & { channel: LayerChannel; channelIndex: number }) {
  const { layer, channel, channelIndex: i, soloChannel, canEdit, isShortcutTarget } = props;
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [fullRange, setFullRange] = useState(false);
  const detailId = useId();
  const visible = layer.channels.map((c) => c.visible);
  const shown = isChannelShown(visible, soloChannel, i);
  const isSolo = soloChannel === i;
  const lastShown = isLastShownChannel(visible, soloChannel, i);
  const key = i < 9 ? CHANNEL_KEYS[i] : undefined;
  const soloKey = i < 9 ? SOLO_KEYS[i] : undefined;

  const eyeLabel = isSolo ? `Show all channels` : `${shown ? "Hide" : "Show"} ${channel.name}`;
  const onEyePress = (event: PressEvent) => {
    if (event.altKey) props.onSoloChannel(i);
    else props.onToggleChannel(i);
  };

  return (
    <li className="lc-channel" data-shown={shown || undefined} data-solo={isSolo || undefined}>
      <div className="lc-channel-row">
        <IconButton
          icon={expanded ? CaretDownIcon : CaretRightIcon}
          size="sm"
          label={`${expanded ? "Hide" : "Show"} ${channel.name} contrast`}
          aria-expanded={expanded}
          aria-controls={expanded ? detailId : undefined}
          onPress={() => setExpanded(!expanded)}
        />
        <ColormapPicker
          value={channel.colormap}
          label={channel.name}
          onChange={(cmap) => props.onChannelSetColormap(layer.id, i, cmap)}
        />
        {canEdit && renaming ? (
          <InlineNameField
            label="Channel name"
            // Start from the override, or empty so the placeholder shows the
            // inherited name and a blank commit clears back to it.
            initial={channel.nameOverride ?? ""}
            placeholder={channel.inheritedName}
            onCommit={(name) => {
              setRenaming(false);
              const trimmed = name.trim();
              props.onChannelSetName(layer.id, i, trimmed.length === 0 ? null : trimmed);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span
            className="lc-channel-name"
            title={canEdit ? `${channel.name} (double-click to rename)` : channel.name}
            onDoubleClick={canEdit ? () => setRenaming(true) : undefined}
          >
            {channel.name}
          </span>
        )}
        {isSolo && <Badge tone="accent">Solo</Badge>}
        <IconButton
          icon={shown ? EyeIcon : EyeSlashIcon}
          size="sm"
          label={eyeLabel}
          shortcut={isShortcutTarget ? key : undefined}
          isDisabled={lastShown}
          onPress={onEyePress}
        />
        <Menu
          label={`${channel.name} actions`}
          placement="bottom end"
          trigger={<IconButton icon={DotsThreeVerticalIcon} size="sm" label={`More for ${channel.name}`} />}
        >
          <MenuItem
            icon={HeadphonesIcon}
            shortcut={isShortcutTarget ? soloKey : undefined}
            onAction={() => props.onSoloChannel(i)}
          >
            {isSolo ? "Show all channels" : "Solo"}
          </MenuItem>
          {canEdit && (
            <MenuItem icon={PencilSimpleIcon} onAction={() => setRenaming(true)}>
              Rename
            </MenuItem>
          )}
        </Menu>
      </div>
      {expanded && (
        <div className="lc-channel-detail" id={detailId}>
          <ContrastControls
            label={channel.name}
            contrastMin={channel.contrastMin}
            contrastMax={channel.contrastMax}
            gamma={channel.gamma}
            dataRange={channel.dataRange}
            valueRange={layer.valueRange}
            integer={layer.integerData}
            fullRange={fullRange}
            onFullRangeChange={setFullRange}
            onContrastChange={(min, max) => props.onChannelSetContrast(layer.id, i, min, max)}
            onGammaChange={(g) => props.onChannelSetGamma(layer.id, i, g)}
            onAutoFit={() => props.onChannelAutoFit(layer.id, i)}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Per-label overlays. Handlers pass the manifest index (`row.index`), not the
 * row position, so they hit the right label when earlier labels were skipped.
 */
function LabelList({ layer, ...props }: LayerRowProps) {
  const rows = layer.labelRows ?? [];
  return (
    <div className="lc-labels" role="group" aria-label={`${layer.name} labels`} data-testid={`labels-section-${layer.id}`}>
      <span className="lc-layer-section-title">Labels</span>
      <ul className="lc-label-list">
        {rows.map((row) => {
          const labelName = row.name.trim() || `Label ${row.index}`;
          // A label drawable only in the other view mode gets disabled
          // controls and its reason as text, rather than a toggle that draws
          // nothing.
          const disabled = row.disabledReason !== undefined;
          return (
            <li key={row.index} className="lc-label">
              <div className="lc-label-row">
                <IconButton
                  icon={!disabled && row.visible ? EyeIcon : EyeSlashIcon}
                  size="sm"
                  // When disabled, name the state (why it's off) rather than
                  // an action the user can't perform.
                  label={
                    disabled
                      ? `${layer.name} ${labelName}: ${row.disabledReason}`
                      : `${row.visible ? "Hide" : "Show"} ${layer.name} ${labelName}`
                  }
                  isDisabled={disabled}
                  data-testid={`label-eye-${layer.id}-${row.index}`}
                  onPress={() => props.onLabelSetVisible(layer.id, row.index, !row.visible)}
                />
                <span className="lc-label-name" title={labelName}>{labelName}</span>
                <Slider<number>
                  className="lc-label-opacity"
                  label={`${labelName} opacity`}
                  labelPosition="hidden"
                  valueDisplay="none"
                  value={row.opacity ?? 0.5}
                  minValue={0}
                  maxValue={1}
                  step={0.01}
                  isDisabled={disabled}
                  onChange={(v) => props.onLabelSetOpacity(layer.id, row.index, v)}
                />
              </div>
              {disabled && <p className="lc-label-reason">{row.disabledReason}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Settings most people never change, closed until asked for. */
function Advanced(props: LayerRowProps) {
  const { layer } = props;
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const levelNotice = displayedLevelNotice(layer);
  const multichannel = layer.channels.length > 1;
  const pinValue = layer.levelPin === null ? "follow" : String(layer.levelPin);

  return (
    <div className="lc-advanced">
      <Button
        className="lc-advanced-toggle"
        size="sm"
        variant="ghost"
        trailingIcon={open ? CaretUpIcon : CaretDownIcon}
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        onPress={() => setOpen(!open)}
      >
        Advanced
      </Button>
      {open && (
        <div className="lc-advanced-body" id={regionId}>
          <Select
            label="Layer blend"
            description="How this layer combines with the layers below it"
            options={BLEND_OPTIONS}
            value={layer.blendMode as BlendMode}
            onChange={(mode) => props.onSetBlendMode(layer.id, mode)}
          />
          {multichannel && (
            <Select
              label="Channel blend"
              description="How this layer's channels combine with each other"
              options={BLEND_OPTIONS}
              value={layer.channelBlendMode as BlendMode}
              onChange={(mode) => props.onChannelSetBlendMode(layer.id, mode)}
            />
          )}
          <Select
            label="Rendering"
            description="How a 3D view draws the volume"
            options={RENDER_OPTIONS}
            value={layer.renderMode as RenderMode}
            onChange={(mode) => props.onSetRenderMode(layer.id, mode)}
          />
          <LayoutSwitcher
            className="lc-advanced-layout"
            datasetId={layer.id}
            registry={props.layoutRegistry}
            sendCommand={props.sendCommand}
            onAfterChange={props.onLayoutChange}
          />
          {(layer.targetLevel || layer.levelPinOptions.length > 0) && (
            <div className="lc-level-row">
              <span className="lc-layer-field-label">Level</span>
              {layer.targetLevel && (
                <span
                  className="lc-level-readout"
                  aria-label={`${layer.name} target level`}
                  title="The level the screen calls for, or the pinned level"
                >
                  {levelNumbers(layer.targetLevel)}
                </span>
              )}
              {levelNotice && layer.displayedLevel && (
                <span
                  className="lc-level-readout lc-level-displayed"
                  aria-label={`${layer.name} displayed level`}
                  title="The level on screen until the target is resident"
                >
                  {`showing ${levelNumbers(layer.displayedLevel)}`}
                </span>
              )}
              {layer.levelPinOptions.length > 0 && (
                <Select
                  className="lc-level-pin"
                  label={`${layer.name} level pin`}
                  labelPosition="hidden"
                  options={[
                    { value: "follow", label: "Follow the screen" },
                    ...layer.levelPinOptions.map((o) => ({ value: String(o.level), label: o.label })),
                  ]}
                  value={pinValue}
                  onChange={(value) => props.onSetLevelPin(layer.id, value === "follow" ? null : Number(value))}
                />
              )}
            </div>
          )}
          {levelNotice && (
            <p className="lc-level-notice" role="status">
              {levelNotice}
            </p>
          )}
          {layer.downsamplingMethod && (
            <p className="lc-level-meta" aria-label={`${layer.name} downsampling method`}>
              {`Downsampled by ${layer.downsamplingMethod}`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Inline rename. Enter or blur commits, Escape cancels. Clicks stay inside,
 * so editing doesn't select or collapse the row.
 */
function InlineNameField({
  label,
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  label: string;
  initial: string;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const settled = useRef(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    wrapper.current?.querySelector("input")?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <span ref={wrapper} className="lc-inline-name" onClick={(e) => e.stopPropagation()}>
      <TextField
        label={label}
        labelPosition="hidden"
        value={value}
        placeholder={placeholder}
        autoFocus
        onChange={setValue}
        onBlur={() => finish(true)}
        onKeyDown={(e: ReactKeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
          }
        }}
      />
    </span>
  );
}
