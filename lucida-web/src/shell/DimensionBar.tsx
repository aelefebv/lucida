import { PauseIcon, PlayIcon, VideoCameraIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ClipDepth } from "../components/clipDepth.ts";
import { ClipPlaneControl } from "../components/ClipPlaneControl.tsx";
import { FocalDepthControl } from "../components/FocalDepthControl.tsx";
import { useFineInputAvailable } from "../input/pointerCapabilities.ts";
import { IconButton } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Popover } from "../ui/Popover.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { useShortcut, type KeyCombo } from "../ui/shortcuts.ts";
import { AxisScrubber } from "./AxisScrubber.tsx";
import "./DimensionBar.css";

const MODE_KEYS: readonly KeyCombo[] = ["M"];
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
  z: number;
  /** Planes along Z; the Z scrubber shows only in 2D, and only with more than one. */
  dimZ: number;
  onZChange: (z: number) => void;
  t: number;
  /** Timepoints; the T scrubber shows only with more than one. */
  dimT: number;
  onTChange: (t: number) => void;
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
  z,
  dimZ,
  onZChange,
  t,
  dimT,
  onTChange,
  cameraMode,
  onCameraModeToggle,
  clipDepth,
}: DimensionBarProps) {
  const showZ = viewMode === "2d" && dimZ > 1;
  const showT = dimT > 1;
  const [playRequested, setPlayRequested] = useState(false);
  const playing = playRequested && showT;

  const stepZ = (delta: number) => onZChange(Math.min(dimZ - 1, Math.max(0, z + delta)));
  // A scrub is the user taking over, so it stops playback.
  const scrubT = (next: number) => {
    setPlayRequested(false);
    onTChange(Math.min(dimT - 1, Math.max(0, next)));
  };

  usePlayback(playing, () => onTChange((t + 1) % dimT));

  useShortcut({
    id: "view.toggleMode",
    keys: MODE_KEYS,
    label: "Switch 2D and 3D",
    group: "View",
    onTrigger: onViewModeToggle,
  });
  useShortcut({
    id: "dimensions.previousZ",
    keys: PREVIOUS_Z_KEYS,
    label: "Previous Z plane",
    group: "Dimensions",
    repeat: true,
    enabled: showZ,
    onTrigger: () => stepZ(-1),
  });
  useShortcut({
    id: "dimensions.nextZ",
    keys: NEXT_Z_KEYS,
    label: "Next Z plane",
    group: "Dimensions",
    repeat: true,
    enabled: showZ,
    onTrigger: () => stepZ(1),
  });
  useShortcut({
    id: "dimensions.previousT",
    keys: PREVIOUS_T_KEYS,
    label: "Previous timepoint",
    group: "Dimensions",
    repeat: true,
    enabled: showT,
    onTrigger: () => scrubT(t - 1),
  });
  useShortcut({
    id: "dimensions.nextT",
    keys: NEXT_T_KEYS,
    label: "Next timepoint",
    group: "Dimensions",
    repeat: true,
    enabled: showT,
    onTrigger: () => scrubT(t + 1),
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
        {viewMode === "3d" && <CameraPopover mode={cameraMode} onToggle={onCameraModeToggle} clipDepth={clipDepth} />}
      </div>
      {showZ && (
        <AxisScrubber
          axis="Z"
          name="Z plane"
          value={z}
          count={dimZ}
          onChange={onZChange}
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
