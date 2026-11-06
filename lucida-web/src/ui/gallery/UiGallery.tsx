import {
  ArrowsOutIcon,
  BoundingBoxIcon,
  CopyIcon,
  CrosshairIcon,
  CubeIcon,
  DotsThreeIcon,
  EyeIcon,
  EyeSlashIcon,
  GearSixIcon,
  HandIcon,
  LineSegmentIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  MapPinIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  ShareNetworkIcon,
  SidebarSimpleIcon,
  SquareIcon,
  TrashIcon,
  CaretDownIcon,
  FolderOpenIcon,
} from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import {
  ACCENT_PRESETS,
  CANVAS_BACKGROUNDS,
  DENSITIES,
  THEME_OPTIONS,
  accentPreference,
  canvasBackgroundPreference,
  densityPreference,
  isHexColor,
  themePreference,
  useAppearance,
  type Accent,
  type CanvasBackground,
  type Density,
  type ThemeOption,
} from "../../theme/appearance.ts";
import { developerToolsPreference, setPreference, usePreference } from "../../theme/preferences.ts";
import { CANVAS_TOKEN_NAMES, TOKEN_NAMES, readColorToken } from "../../theme/tokens.ts";
import { AccentPicker } from "../../theme/AccentPicker.tsx";
import { Avatar } from "../Avatar.tsx";
import { Badge } from "../Badge.tsx";
import { Button, IconButton } from "../Button.tsx";
import { Card } from "../Card.tsx";
import { Dialog } from "../Dialog.tsx";
import { Kbd } from "../Kbd.tsx";
import { Menu, MenuItem, MenuSection, MenuSeparator } from "../Menu.tsx";
import { NumberField } from "../NumberField.tsx";
import { PanelHeader } from "../PanelHeader.tsx";
import { Popover } from "../Popover.tsx";
import { SegmentedControl } from "../SegmentedControl.tsx";
import { Select } from "../Select.tsx";
import { SHORTCUT_GROUPS, useShortcut, useShortcutList, type KeyCombo } from "../shortcuts.ts";
import { Slider } from "../Slider.tsx";
import { Switch } from "../Switch.tsx";
import { SearchField, TextField } from "../TextField.tsx";
import { toast } from "../toastQueue.ts";
import { Tooltip } from "../Tooltip.tsx";
import "./UiGallery.css";

/** Seed preferences from the URL, so a review link or screenshot can name them. */
function useUrlPreferences(): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const theme = params.get("theme");
    if ((THEME_OPTIONS as readonly string[]).includes(theme ?? "")) {
      setPreference(themePreference, theme as ThemeOption);
    }
    const density = params.get("density");
    if ((DENSITIES as readonly string[]).includes(density ?? "")) {
      setPreference(densityPreference, density as Density);
    }
    const accent = params.get("accent");
    if (accent && ((ACCENT_PRESETS as readonly string[]).includes(accent) || isHexColor(accent))) {
      setPreference(accentPreference, accent as Accent);
    }
    const canvas = params.get("canvas");
    if ((CANVAS_BACKGROUNDS as readonly string[]).includes(canvas ?? "")) {
      setPreference(canvasBackgroundPreference, canvas as CanvasBackground);
    }
  }, []);
}

function AppearanceBar() {
  const [theme, setTheme] = usePreference(themePreference);
  const [density, setDensity] = usePreference(densityPreference);
  const [accent, setAccent] = usePreference(accentPreference);
  const [canvas, setCanvas] = usePreference(canvasBackgroundPreference);
  return (
    <div className="gallery-appearance">
      <SegmentedControl
        label="Theme"
        size="sm"
        options={[
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
          { value: "system", label: "System" },
        ]}
        value={theme}
        onChange={setTheme}
      />
      <SegmentedControl
        label="Density"
        size="sm"
        options={[
          { value: "comfortable", label: "Comfortable" },
          { value: "compact", label: "Compact" },
        ]}
        value={density}
        onChange={setDensity}
      />
      <AccentPicker value={accent} onChange={setAccent} />
      <Select
        label="Canvas"
        labelPosition="hidden"
        options={[
          { value: "black", label: "Black canvas" },
          { value: "dark-gray", label: "Dark gray canvas" },
          { value: "white", label: "White canvas" },
          { value: "theme", label: "Canvas follows theme" },
        ]}
        value={canvas}
        onChange={setCanvas}
        className="gallery-canvas-select"
      />
    </div>
  );
}

function Section({ title, meta, wide, children }: { title: string; meta?: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className="gallery-section" data-wide={wide || undefined}>
      <PanelHeader title={title} meta={meta} />
      <div className="gallery-section-body">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="gallery-row">
      {label && <div className="gallery-row-label">{label}</div>}
      <div className="gallery-row-items">{children}</div>
    </div>
  );
}

const COLOR_GROUPS: readonly { title: string; tokens: readonly string[] }[] = [
  { title: "Surfaces", tokens: ["--lc-bg", "--lc-surface-1", "--lc-surface-2", "--lc-surface-3", "--lc-surface-float", "--lc-field-bg"] },
  { title: "Text", tokens: ["--lc-text", "--lc-text-muted", "--lc-text-subtle", "--lc-text-on-accent"] },
  { title: "Lines", tokens: ["--lc-border", "--lc-border-strong", "--lc-scrim", "--lc-thumb"] },
  { title: "Accent", tokens: ["--lc-accent", "--lc-accent-hover", "--lc-accent-subtle", "--lc-accent-text", "--lc-focus-ring"] },
  {
    title: "Status",
    tokens: ["--lc-danger", "--lc-warning", "--lc-success", "--lc-info", "--lc-danger-subtle", "--lc-warning-subtle", "--lc-success-subtle", "--lc-info-subtle"],
  },
  { title: "Canvas", tokens: CANVAS_TOKEN_NAMES },
];

/** Canvas colors as GPU and 2D-canvas code reads them, re-read on each change. */
function ResolvedCanvasColors() {
  useAppearance(); // re-render, and so re-read, when the appearance changes
  return (
    <div className="gallery-resolved">
      {CANVAS_TOKEN_NAMES.map((token) => (
        <code key={token}>
          {token.replace("--lc-", "")} → {readColorToken(token).css}
        </code>
      ))}
    </div>
  );
}

function ColorSection() {
  return (
    <Section title="Color" meta={`${TOKEN_NAMES.length} tokens`} wide>
      <div className="gallery-colors">
        {COLOR_GROUPS.map((group) => (
          <div key={group.title} className="gallery-color-group">
            <div className="gallery-row-label">{group.title}</div>
            <div className="gallery-swatches">
              {group.tokens.map((token) => (
                <div key={token} className="gallery-swatch">
                  <span className="gallery-swatch-chip" style={{ background: `var(${token})` }} />
                  <code>{token.replace("--lc-", "")}</code>
                </div>
              ))}
            </div>
            {group.title === "Canvas" && <ResolvedCanvasColors />}
          </div>
        ))}
      </div>
      <div className="gallery-contrast">
        {["--lc-bg", "--lc-surface-1", "--lc-surface-2"].map((surface) => (
          <div key={surface} className="gallery-contrast-tile" style={{ background: `var(${surface})` }}>
            <code>{surface.replace("--lc-", "")}</code>
            <span style={{ color: "var(--lc-text)" }}>Text reads here</span>
            <span style={{ color: "var(--lc-text-muted)" }}>Muted reads here</span>
            <span style={{ color: "var(--lc-text-subtle)" }}>Subtle hint</span>
            <span style={{ color: "var(--lc-accent-text)" }}>Accent text</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function TypeSection() {
  const scale = [
    ["2xl", "20", "Workspace overview"],
    ["xl", "16", "Dialog title"],
    ["lg", "14", "Emphasis in a panel"],
    ["md", "13", "Body text, controls, menus"],
    ["sm", "12", "Labels, tooltips, secondary"],
    ["xs", "11", "Keycaps, badges, captions"],
  ] as const;
  return (
    <Section title="Type" meta="system-ui">
      <div className="gallery-type">
        {scale.map(([name, px, sample]) => (
          <div key={name} className="gallery-type-row">
            <code>
              {name} · {px}
            </code>
            <span style={{ fontSize: `var(--lc-text-${name})` }}>{sample}</span>
          </div>
        ))}
      </div>
      <Row label="Readouts use tabular numbers">
        <span className="gallery-readout">Z 034 / 128</span>
        <span className="gallery-readout">T 1 / 2</span>
        <span className="gallery-readout">1.250×</span>
      </Row>
      <Row label="Monospace">
        <code className="gallery-mono">level/t/c/z/y/x · 0/0/1/12/3/7</code>
      </Row>
    </Section>
  );
}

function ShapeSection() {
  return (
    <Section title="Shape, space, depth">
      <Row label="Radius">
        {(["sm", "", "lg", "full"] as const).map((r) => (
          <div key={r} className="gallery-radius" style={{ borderRadius: `var(--lc-radius${r ? `-${r}` : ""})` }}>
            {r || "base"}
          </div>
        ))}
      </Row>
      <Row label="Space (4px grid)">
        <div className="gallery-space">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <div key={n} className="gallery-space-step">
              <span style={{ width: `var(--lc-space-${n})`, height: `var(--lc-space-${n})` }} />
              <code>{n}</code>
            </div>
          ))}
        </div>
      </Row>
      <Row label="Shadow">
        <div className="gallery-shadow" style={{ boxShadow: "var(--lc-shadow-1)" }}>
          shadow-1
        </div>
        <div className="gallery-shadow" style={{ boxShadow: "var(--lc-shadow-2)" }}>
          shadow-2
        </div>
      </Row>
      <Row label="Control height">
        <div className="gallery-control-h" style={{ height: "var(--lc-control-h)" }}>
          control-h
        </div>
        <div className="gallery-control-h" style={{ height: "var(--lc-control-h-sm)" }}>
          control-h-sm
        </div>
      </Row>
    </Section>
  );
}

function ButtonSection() {
  return (
    <Section title="Button">
      <Row label="Variants">
        <Button variant="primary">Primary</Button>
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Delete</Button>
      </Row>
      <Row label="Small">
        <Button variant="primary" size="sm">
          Primary
        </Button>
        <Button size="sm">Secondary</Button>
        <Button variant="ghost" size="sm">
          Ghost
        </Button>
        <Button variant="danger" size="sm">
          Delete
        </Button>
      </Row>
      <Row label="With icons">
        <Button variant="primary" icon={PlusIcon}>
          Add data
        </Button>
        <Button icon={ShareNetworkIcon}>Share</Button>
        <Button variant="ghost" trailingIcon={CaretDownIcon}>
          Workspace
        </Button>
      </Row>
      <Row label="Disabled">
        <Button variant="primary" isDisabled>
          Primary
        </Button>
        <Button isDisabled>Secondary</Button>
        <Button variant="ghost" isDisabled>
          Ghost
        </Button>
      </Row>
    </Section>
  );
}

function IconButtonSection() {
  const [left, setLeft] = useState(true);
  const [tool, setTool] = useState("pan");
  return (
    <Section title="IconButton" meta="tooltips name the shortcut">
      <Row label="Sizes">
        <IconButton icon={GearSixIcon} label="Settings" size="sm" />
        <IconButton icon={GearSixIcon} label="Settings" />
        <IconButton icon={GearSixIcon} label="Settings" size="lg" tooltipPlacement="right" />
        <IconButton icon={CopyIcon} label="Copy link" variant="secondary" />
        <IconButton icon={TrashIcon} label="Delete" isDisabled />
      </Row>
      <Row label="Toggles">
        <IconButton
          icon={SidebarSimpleIcon}
          label="Left panel"
          shortcut="Alt+["
          isSelected={left}
          onSelectedChange={setLeft}
        />
        <IconButton
          icon={SidebarSimpleIcon}
          label="Right panel"
          shortcut="Alt+]"
          isSelected={!left}
          onSelectedChange={(on) => setLeft(!on)}
        />
      </Row>
      <Row label="Tool palette">
        <Card padding="sm" className="gallery-tools" aria-label="Tools">
          {(
            [
              ["pan", HandIcon, "Pan", "V"],
              ["point", MapPinIcon, "Point", "P"],
              ["line", LineSegmentIcon, "Line", "L"],
              ["box", BoundingBoxIcon, "Box", "B"],
            ] as const
          ).map(([id, icon, label, key]) => (
            <IconButton
              key={id}
              icon={icon}
              label={label}
              shortcut={key}
              tooltipPlacement="bottom"
              isSelected={tool === id}
              onSelectedChange={() => setTool(id)}
            />
          ))}
        </Card>
      </Row>
    </Section>
  );
}

function InputSection() {
  const [name, setName] = useState("Untitled workspace");
  const [query, setQuery] = useState("");
  const [z, setZ] = useState(34);
  const [colormap, setColormap] = useState<"gray" | "magma" | "viridis" | "green">("gray");
  return (
    <Section title="Fields">
      <div className="gallery-fields">
        <TextField label="Name" value={name} onChange={setName} description="Shown in the top bar" />
        <TextField label="Address" placeholder="https:// or an absolute path" errorMessage="Not a reachable address" />
        <SearchField label="Search" labelPosition="top" value={query} onChange={setQuery} placeholder="Search datasets" />
        <NumberField label="Z plane" value={z} onChange={setZ} minValue={0} maxValue={127} />
        <Select
          label="Colormap"
          value={colormap}
          onChange={setColormap}
          options={[
            { value: "gray", label: "Gray" },
            { value: "magma", label: "Magma" },
            { value: "viridis", label: "Viridis" },
            { value: "green", label: "Green" },
          ]}
        />
        <TextField label="Read only" value="Disabled field" isDisabled />
      </div>
      <div className="gallery-settings">
        <Select
          label="Colormap"
          labelPosition="side"
          value={colormap}
          onChange={setColormap}
          options={[
            { value: "gray", label: "Gray" },
            { value: "magma", label: "Magma" },
            { value: "viridis", label: "Viridis" },
            { value: "green", label: "Green" },
          ]}
        />
        <NumberField label="Gamma" labelPosition="side" defaultValue={1} step={0.1} minValue={0.1} maxValue={4} formatOptions={{ maximumFractionDigits: 2 }} />
      </div>
    </Section>
  );
}

function ChoiceSection() {
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [layout, setLayout] = useState<"grid" | "row" | "stack">("grid");
  const [developerTools, setDeveloperTools] = usePreference(developerToolsPreference);
  const [restore, setRestore] = useState(true);
  return (
    <Section title="Choice">
      <Row label="SegmentedControl">
        <SegmentedControl
          label="View mode"
          options={[
            { value: "2d", label: "2D" },
            { value: "3d", label: "3D" },
          ]}
          value={mode}
          onChange={setMode}
        />
        <SegmentedControl
          label="Layout"
          iconOnly
          options={[
            { value: "grid", label: "Grid", icon: SquareIcon },
            { value: "row", label: "Row", icon: ArrowsOutIcon },
            { value: "stack", label: "Stack", icon: CubeIcon },
          ]}
          value={layout}
          onChange={setLayout}
        />
        <SegmentedControl
          label="View mode"
          size="sm"
          options={[
            { value: "2d", label: "2D" },
            { value: "3d", label: "3D" },
          ]}
          value={mode}
          onChange={setMode}
        />
      </Row>
      <div className="gallery-settings">
        <SegmentedControl
          label="View mode"
          labelPosition="side"
          options={[
            { value: "2d", label: "2D" },
            { value: "3d", label: "3D" },
          ]}
          value={mode}
          onChange={setMode}
        />
        <Switch label="Restore my last view" isSelected={restore} onChange={setRestore} />
        <Switch
          label="Developer tools"
          description="Monitor, HUD, and dev controls"
          isSelected={developerTools}
          onChange={setDeveloperTools}
        />
        <Switch label="Unavailable" isSelected={false} onChange={() => {}} isDisabled />
      </div>
    </Section>
  );
}

function SliderSection() {
  const [opacity, setOpacity] = useState(0.8);
  const [z, setZ] = useState(34);
  const [range, setRange] = useState<readonly [number, number]>([120, 2400]);
  const [gamma, setGamma] = useState(1);
  return (
    <Section title="Slider">
      <div className="gallery-fields gallery-fields-single">
        <Slider
          label="Opacity"
          value={opacity}
          onChange={setOpacity}
          minValue={0}
          maxValue={1}
          step={0.01}
          formatOptions={{ style: "percent" }}
        />
        <Slider label="Z plane" value={z} onChange={setZ} minValue={0} maxValue={127} valueDisplay="field" />
        <Slider label="Contrast" value={range} onChange={setRange} minValue={0} maxValue={4095} valueDisplay="field" />
        <Slider label="Gamma" value={gamma} onChange={setGamma} minValue={0.1} maxValue={4} step={0.05} isDisabled />
      </div>
    </Section>
  );
}

function OverlaySection() {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Overlays" meta="Escape closes">
      <Row label="Tooltip">
        <Tooltip content="Fit to view" shortcut="0">
          <Button icon={ArrowsOutIcon}>Hover me</Button>
        </Tooltip>
        <IconButton icon={MagnifyingGlassPlusIcon} label="Zoom in" shortcut="+" />
        <IconButton icon={MagnifyingGlassMinusIcon} label="Zoom out" shortcut="-" />
      </Row>
      <Row label="Popover and menu">
        <Popover label="Display settings" trigger={<Button trailingIcon={CaretDownIcon}>Display</Button>}>
          <div className="gallery-popover">
            <Slider label="Opacity" value={0.6} onChange={() => {}} minValue={0} maxValue={1} step={0.01} formatOptions={{ style: "percent" }} />
            <Switch label="Show scale bar" isSelected onChange={() => {}} />
          </div>
        </Popover>
        <Menu label="Dataset actions" trigger={<IconButton icon={DotsThreeIcon} label="More actions" />}>
          <MenuSection title="Dataset">
            <MenuItem icon={PencilSimpleIcon} shortcut="F2" onAction={() => toast("Rename")}>
              Rename
            </MenuItem>
            <MenuItem icon={CopyIcon} shortcut="Mod+D" onAction={() => toast("Duplicated")}>
              Duplicate
            </MenuItem>
            <MenuItem icon={CrosshairIcon} onAction={() => toast("Centered")}>
              Center in view
            </MenuItem>
          </MenuSection>
          <MenuSeparator />
          <MenuItem icon={TrashIcon} variant="danger" onAction={() => toast({ title: "Removed", tone: "danger" })}>
            Remove from workspace
          </MenuItem>
        </Menu>
      </Row>
      <Row label="Dialog">
        <Dialog
          title="Add data"
          trigger={<Button icon={FolderOpenIcon}>Open dialog</Button>}
          footer={(close) => (
            <>
              <Button variant="ghost" onPress={close}>
                Cancel
              </Button>
              <Button variant="primary" onPress={close}>
                Open
              </Button>
            </>
          )}
        >
          <div className="gallery-dialog-body">
            <p>Open an OME-Zarr store by address or path. It is added to this workspace.</p>
            <TextField label="Address" placeholder="https:// or an absolute path" autoFocus />
          </div>
        </Dialog>
        <Button variant="ghost" onPress={() => setOpen(true)}>
          Open from code
        </Button>
        <Dialog
          title="Remove dataset?"
          size="sm"
          isOpen={open}
          onOpenChange={setOpen}
          footer={(close) => (
            <>
              <Button variant="ghost" onPress={close}>
                Keep
              </Button>
              <Button variant="danger" onPress={close}>
                Remove
              </Button>
            </>
          )}
        >
          Annotations on it stay in the workspace and come back if you add it again.
        </Dialog>
      </Row>
    </Section>
  );
}

function FeedbackSection() {
  return (
    <Section title="Feedback">
      <Row label="Toast">
        <Button size="sm" onPress={() => toast("Link copied")}>
          Neutral
        </Button>
        <Button size="sm" onPress={() => toast({ title: "Saved view created", tone: "success" })}>
          Success
        </Button>
        <Button
          size="sm"
          onPress={() =>
            toast({ title: "Some chunks failed to load", description: "3 of 48 timed out; they will be retried.", tone: "warning" })
          }
        >
          Warning
        </Button>
        <Button
          size="sm"
          onPress={() =>
            toast({
              title: "Couldn't share the workspace",
              description: "The server refused the request.",
              tone: "danger",
              action: { label: "Retry", onPress: () => toast("Retrying") },
            })
          }
        >
          With action
        </Button>
      </Row>
      <Row label="Badge">
        <Badge>12 tiles</Badge>
        <Badge tone="accent">New</Badge>
        <Badge tone="success">Ready</Badge>
        <Badge tone="warning">Partial</Badge>
        <Badge tone="danger">Failed</Badge>
        <Badge tone="info">3 comments</Badge>
      </Row>
      <Row label="Avatar">
        <Avatar name="Ada Lovelace" size="sm" />
        <Avatar name="Grace Hopper" />
        <Avatar name="Alan Turing" size="lg" />
        <Avatar name="Katherine Johnson" color="#f0a020" />
        <Avatar name="Edsger Dijkstra" color="#0f8278" />
        <Avatar name="Broken Image" src="/missing-avatar.png" />
      </Row>
      <Row label="Kbd">
        {(["Mod+K", "Shift+ArrowUp", "Alt+[", "?", "PageDown"] as const).map((combo) => (
          <Kbd key={combo} keys={combo} />
        ))}
      </Row>
    </Section>
  );
}

function CanvasSection() {
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [z, setZ] = useState(34);
  const [t, setT] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [tool, setTool] = useState("pan");
  return (
    <Section title="Floating cards over the canvas" meta="float surface, blur, border, shadow" wide>
      <div className="gallery-stage">
        <div className="gallery-stage-data" aria-hidden />
        <div className="gallery-slot gallery-slot-top-left">
          <Card padding="sm" className="gallery-tools gallery-tools-vertical" aria-label="Tools">
            {(
              [
                ["pan", HandIcon, "Pan", "V"],
                ["point", MapPinIcon, "Point", "P"],
                ["line", LineSegmentIcon, "Line", "L"],
                ["box", BoundingBoxIcon, "Box", "B"],
              ] as const
            ).map(([id, icon, label, key]) => (
              <IconButton
                key={id}
                icon={icon}
                label={label}
                shortcut={key}
                tooltipPlacement="right"
                isSelected={tool === id}
                onSelectedChange={() => setTool(id)}
              />
            ))}
          </Card>
        </div>
        <div className="gallery-slot gallery-slot-bottom-left">
          <Card className="gallery-navigator" aria-label="Navigator">
            <div className="gallery-navigator-row">
              <span>Zoom</span>
              <span className="gallery-readout">1.25×</span>
            </div>
            <div className="gallery-navigator-row">
              <span>Level</span>
              <span className="gallery-readout">2 of 5</span>
            </div>
          </Card>
        </div>
        <div className="gallery-slot gallery-slot-bottom-center">
          <Card padding="sm" className="gallery-dimension-bar" aria-label="Dimensions">
            <SegmentedControl
              label="View mode"
              size="sm"
              options={[
                { value: "2d", label: "2D" },
                { value: "3d", label: "3D" },
              ]}
              value={mode}
              onChange={setMode}
            />
            <span className="gallery-divider" />
            <span className="gallery-axis">Z</span>
            <Slider label="Z plane" labelPosition="hidden" valueDisplay="none" value={z} onChange={setZ} minValue={0} maxValue={127} className="gallery-dim-slider" />
            <span className="gallery-readout gallery-dim-readout">
              {z + 1} / 128
            </span>
            <span className="gallery-divider" />
            <span className="gallery-axis">T</span>
            <IconButton
              icon={playing ? PauseIcon : PlayIcon}
              label={playing ? "Pause" : "Play"}
              shortcut="Space"
              size="sm"
              onPress={() => setPlaying(!playing)}
            />
            <Slider label="Timepoint" labelPosition="hidden" valueDisplay="none" value={t} onChange={setT} minValue={0} maxValue={1} className="gallery-dim-slider gallery-dim-slider-short" />
            <span className="gallery-readout gallery-dim-readout">{t + 1} / 2</span>
          </Card>
        </div>
        <div className="gallery-slot gallery-slot-bottom-right">
          <Card padding="none" className="gallery-minimap" aria-label="Minimap">
            <div className="gallery-minimap-view" />
          </Card>
        </div>
      </div>
    </Section>
  );
}

const CHANNELS = [
  { name: "Channel 1", color: "#3d7bff" },
  { name: "Channel 2", color: "#38d26b" },
  { name: "Channel 3", color: "#ff4fd8" },
];

function PanelSection() {
  const [visible, setVisible] = useState([true, true, false]);
  const [selected, setSelected] = useState(1);
  return (
    <Section title="Panel">
      <div className="gallery-panel">
        <PanelHeader
          title="Layers"
          meta="3"
          actions={
            <>
              <IconButton icon={PlusIcon} label="Add data" shortcut="Mod+O" size="sm" />
              <IconButton icon={SidebarSimpleIcon} label="Hide panel" shortcut="Alt+[" size="sm" />
            </>
          }
        />
        <div className="gallery-panel-list">
          {CHANNELS.map((channel, i) => (
            <div
              key={channel.name}
              className="gallery-panel-row"
              data-selected={selected === i || undefined}
              onClick={() => setSelected(i)}
            >
              <span className="gallery-channel-dot" style={{ background: channel.color }} />
              <span className="gallery-panel-name">{channel.name}</span>
              <span className="gallery-readout gallery-panel-meta">{i === 0 ? "0–4095" : i === 1 ? "120–2400" : "0–255"}</span>
              <IconButton
                icon={visible[i] ? EyeIcon : EyeSlashIcon}
                label={visible[i] ? "Hide channel" : "Show channel"}
                shortcut={`${i + 1}` as KeyCombo}
                size="sm"
                onPress={() => setVisible(visible.map((v, j) => (j === i ? !v : v)))}
              />
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function ShortcutSection() {
  const [count, setCount] = useState(0);
  const [theme, setTheme] = usePreference(themePreference);
  const [density, setDensity] = usePreference(densityPreference);
  useShortcut({
    id: "gallery.toast",
    keys: "G",
    label: "Show a toast",
    group: "General",
    onTrigger: () => {
      setCount((c) => c + 1);
      toast(`Shortcut fired ${count + 1}×`);
    },
  });
  useShortcut({
    id: "gallery.theme",
    keys: "Shift+T",
    label: "Switch dark and light",
    group: "View",
    onTrigger: () => setTheme(theme === "light" ? "dark" : "light"),
  });
  useShortcut({
    id: "gallery.density",
    keys: ["Alt+D", "Shift+D"],
    label: "Switch density",
    group: "View",
    onTrigger: () => setDensity(density === "compact" ? "comfortable" : "compact"),
  });
  const shortcuts = useShortcutList();
  return (
    <Section title="Shortcuts" meta="live from the registry">
      <p className="gallery-note">Press a key. Shortcuts stay quiet while you type in a field.</p>
      <div className="gallery-shortcuts">
        {SHORTCUT_GROUPS.filter((g) => shortcuts.some((s) => s.group === g)).map((group) => (
          <div key={group} className="gallery-shortcut-group">
            <div className="gallery-row-label">{group}</div>
            {shortcuts
              .filter((s) => s.group === group)
              .map((s) => (
                <div key={s.id} className="gallery-shortcut">
                  <span>{s.label}</span>
                  <span className="gallery-shortcut-keys">
                    {s.keys.map((k, i) => (
                      <span key={k} className="gallery-shortcut-alt">
                        {i > 0 && <span className="gallery-or">or</span>}
                        <Kbd keys={k} />
                      </span>
                    ))}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </Section>
  );
}

export default function UiGallery() {
  useUrlPreferences();
  useEffect(() => {
    const previous = document.title;
    document.title = "UI gallery · lucida";
    return () => {
      document.title = previous;
    };
  }, []);
  return (
    <div className="gallery">
      <header className="gallery-header">
        <div className="gallery-title">
          <span className="gallery-mark" aria-hidden />
          <h1>UI gallery</h1>
          <Badge>tokens · primitives · shortcuts</Badge>
        </div>
        <AppearanceBar />
      </header>
      <main className="gallery-grid">
        <ColorSection />
        <TypeSection />
        <ShapeSection />
        <ButtonSection />
        <IconButtonSection />
        <InputSection />
        <ChoiceSection />
        <SliderSection />
        <OverlaySection />
        <CanvasSection />
        <FeedbackSection />
        <PanelSection />
        <ShortcutSection />
      </main>
    </div>
  );
}
