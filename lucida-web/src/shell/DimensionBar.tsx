import { ColumnsIcon, PauseIcon, PlayIcon, RowsIcon, VideoCameraIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { stepIndex, type IndexChange } from "../axes.ts";
import type { ClipDepth } from "../components/clipDepth.ts";
import { ClipPlaneControl } from "../components/ClipPlaneControl.tsx";
import { FocalDepthControl } from "../components/FocalDepthControl.tsx";
import { useFineInputAvailable } from "../input/fineInput.ts";
import { IconButton } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Popover } from "../ui/Popover.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { useShortcut, type KeyCombo } from "../ui/shortcuts.ts";
import { useCommand } from "../ui/commands.ts";
import { cutAxis, type SlicePlane } from "../renderer/slicePlane.ts";
import { AxisScrubber } from "./AxisScrubber.tsx";
import { LinkPopover, type LinkPopoverProps } from "./LinkPopover.tsx";
import "./DimensionBar.css";

const MODE_KEYS: readonly KeyCombo[] = ["M"];
const PLANE_KEYS: readonly KeyCombo[] = ["Shift+M"];
const PLANES: readonly SlicePlane[] = ["xy", "xz", "yz"];
const PREVIOUS_Z_KEYS: readonly KeyCombo[] = ["PageUp", "Shift+ArrowUp"];
const NEXT_Z_KEYS: readonly KeyCombo[] = ["PageDown", "Shift+ArrowDown"];
const PREVIOUS_T_KEYS: readonly KeyCombo[] = [","];
const NEXT_T_KEYS: readonly KeyCombo[] = ["."];
const PLAY_KEYS: readonly KeyCombo[] = ["Space"];

/**
 * Time between timepoints while playing. Each timepoint loads its own chunks,
 * so a faster rate mostly shows half-loaded frames.
 */
export const PLAYBACK_INTERVAL_MS = 250;

/** Controls that Space presses or toggles. A slider is not one, so Space still plays after a scrub. */
const SPACE_ACTIVATES =
  "button, a[href], summary, select, input:not([type=range]), " +
  "[role=button], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=tab], [role=option]";

export type CameraMode = "arcball" | "fly";

export interface DimensionBarProps {
  viewMode: "2d" | "3d";
  onViewModeToggle: () => void;
  /** Whether two views divide the canvas. */
  split: boolean;
  /** Whether a split stacks the views, as a phone does, rather than setting them side by side. */
  stacked: boolean;
  /** Divide the canvas into two views, or show one again. */
  onSplitToggle: () => void;
  /** How the two views link, while two views divide the canvas. */
  links?: LinkPopoverProps;
  /** The plane the 2D view cuts. Its choice shows only in 2D, and only with depth to cut. */
  slicePlane: SlicePlane;
  onSlicePlaneChange: (plane: SlicePlane) => void;
  /** Planes along Z, the depth a side view cuts through. */
  dimZ: number;
  /** The axis position along the plane's cut axis: Z, or Y or X for a side view. */
  cut: number;
  /** Positions along the cut axis; its scrubber shows only in 2D, and only with more than one. */
  dimCut: number;
  onCutChange: (index: IndexChange) => void;
  t: number;
  /** Timepoints; the T scrubber shows only with more than one. */
  dimT: number;
  onTChange: (t: IndexChange) => void;
  /** The 3D camera's mode. */
  cameraMode: CameraMode;
  onCameraModeToggle: () => void;
  /** The 3D clip plane, when there is a volume to clip. */
  clipDepth?: ClipDepth;
}

/**
 * The floating bar at the bottom of the canvas: the 2D/3D switch, the 3D
 * camera, and a scrubber for each axis the data has more than one position on.
 * Channels live in the layer panel, where they composite and solo.
 */
export function DimensionBar({
  viewMode,
  onViewModeToggle,
  split,
  stacked,
  onSplitToggle,
  links,
  slicePlane,
  onSlicePlaneChange,
  dimZ,
  cut,
  dimCut,
  onCutChange,
  t,
  dimT,
  onTChange,
  cameraMode,
  onCameraModeToggle,
  clipDepth,
}: DimensionBarProps) {
  const showPlane = viewMode === "2d" && dimZ > 1;
  const showCut = viewMode === "2d" && dimCut > 1;
  const showT = dimT > 1;
  const [playRequested, setPlayRequested] = useState(false);
  const playing = playRequested && showT;
  const cutLetter = cutAxis(slicePlane).toUpperCase();

  const stepCut = (delta: number) => onCutChange(stepIndex(delta, dimCut));
  // A scrub is the user taking over, so it stops playback.
  const scrubT = (next: IndexChange) => {
    setPlayRequested(false);
    onTChange(next);
  };

  usePlayback(playing, () => onTChange((current) => (current + 1) % dimT));

  useShortcut({
    id: "view.toggleMode",
    keys: MODE_KEYS,
    label: "Switch 2D and 3D",
    group: "View",
    onTrigger: onViewModeToggle,
  });
  useCommand({
    id: "view.split",
    label: split ? "Show one view" : "Split view",
    group: "View",
    keywords: ["layout", "side by side", "compare", "two views"],
    run: onSplitToggle,
  });
  useShortcut({
    id: "view.cyclePlane",
    keys: PLANE_KEYS,
    label: "Cut the next plane: XY, XZ, YZ",
    group: "View",
    enabled: showPlane,
    onTrigger: () => onSlicePlaneChange(PLANES[(PLANES.indexOf(slicePlane) + 1) % PLANES.length]),
  });
  useShortcut({
    id: "dimensions.previousZ",
    keys: PREVIOUS_Z_KEYS,
    label: `Previous ${cutLetter} plane`,
    group: "Dimensions",
    repeat: true,
    enabled: showCut,
    onTrigger: () => stepCut(-1),
  });
  useShortcut({
    id: "dimensions.nextZ",
    keys: NEXT_Z_KEYS,
    label: `Next ${cutLetter} plane`,
    group: "Dimensions",
    repeat: true,
    enabled: showCut,
    onTrigger: () => stepCut(1),
  });
  useShortcut({
    id: "dimensions.previousT",
    keys: PREVIOUS_T_KEYS,
    label: "Previous timepoint",
    group: "Dimensions",
    repeat: true,
    enabled: showT,
    onTrigger: () => scrubT(stepIndex(-1, dimT)),
  });
  useShortcut({
    id: "dimensions.nextT",
    keys: NEXT_T_KEYS,
    label: "Next timepoint",
    group: "Dimensions",
    repeat: true,
    enabled: showT,
    onTrigger: () => scrubT(stepIndex(1, dimT)),
  });
  useShortcut({
    id: "dimensions.togglePlayback",
    keys: PLAY_KEYS,
    label: "Play or pause time",
    group: "Dimensions",
    enabled: showT,
    when: () => !document.activeElement?.closest(SPACE_ACTIVATES),
    onTrigger: () => setPlayRequested(!playing),
  });

  return (
    <Card padding="sm" className="lc-dimension-bar" aria-label="Dimensions">
      <div className="lc-dim-group">
        <SegmentedControl
          label="View mode"
          size="sm"
          options={[
            { value: "2d", label: "2D", shortcut: viewMode === "3d" ? MODE_KEYS[0] : undefined },
            { value: "3d", label: "3D", shortcut: viewMode === "2d" ? MODE_KEYS[0] : undefined },
          ]}
          value={viewMode}
          onChange={(mode) => {
            if (mode !== viewMode) onViewModeToggle();
          }}
        />
        <IconButton
          icon={stacked ? RowsIcon : ColumnsIcon}
          size="sm"
          label={split ? "Show one view" : "Split view"}
          isSelected={split}
          onSelectedChange={onSplitToggle}
        />
        {split && links && <LinkPopover {...links} />}
        {viewMode === "3d" && <CameraPopover mode={cameraMode} onToggle={onCameraModeToggle} clipDepth={clipDepth} />}
        {showPlane && (
          <SegmentedControl
            label="Slice plane"
            size="sm"
            options={PLANES.map((plane) => ({ value: plane, label: plane.toUpperCase() }))}
            value={slicePlane}
            onChange={onSlicePlaneChange}
          />
        )}
      </div>
      {showCut && (
        <AxisScrubber
          axis={cutLetter}
          name={`${cutLetter} plane`}
          value={cut}
          count={dimCut}
          onChange={onCutChange}
          previousShortcut={PREVIOUS_Z_KEYS}
          nextShortcut={NEXT_Z_KEYS}
        />
      )}
      {showT && (
        <AxisScrubber
          axis="T"
          name="timepoint"
          value={t}
          count={dimT}
          onChange={scrubT}
          previousShortcut={PREVIOUS_T_KEYS}
          nextShortcut={NEXT_T_KEYS}
          leading={
            <IconButton
              icon={playing ? PauseIcon : PlayIcon}
              size="sm"
              label={playing ? "Pause" : "Play"}
              shortcut={PLAY_KEYS}
              onPress={() => setPlayRequested(!playing)}
            />
          }
        />
      )}
    </Card>
  );
}

/** Calls `step` once per playback interval while `playing`. */
function usePlayback(playing: boolean, step: () => void): void {
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  });
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => stepRef.current(), PLAYBACK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing]);
}

function CameraPopover({ mode, onToggle, clipDepth }: { mode: CameraMode; onToggle: () => void; clipDepth?: ClipDepth }) {
  // Fly mode steers with keys and a mouse, so with neither it is left out,
  // unless the camera is already flying and needs a way back.
  const canFly = useFineInputAvailable() || mode === "fly";
  return (
    <Popover
      label="Camera"
      placement="top"
      trigger={<IconButton icon={VideoCameraIcon} size="sm" label="Camera" />}
    >
      <div className="lc-camera-popover">
        {canFly && (
          <SegmentedControl
            label="Camera"
            labelPosition="side"
            size="sm"
            options={[
              { value: "arcball", label: "Arcball" },
              { value: "fly", label: "Fly" },
            ]}
            value={mode}
            onChange={(next) => {
              if (next !== mode) onToggle();
            }}
          />
        )}
        {clipDepth && <ClipPlaneControl depth={clipDepth} />}
        <FocalDepthControl />
      </div>
    </Popover>
  );
}
