/**
 * A layer's placement by hand as numbers: its offset, scale and rotation on
 * each axis, and the one action that puts it back where its metadata places
 * it. The Move, scale and rotate tool changes the same transform on the
 * canvas.
 */
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { Button, NumberField } from "../ui/index.ts";
import { IDENTITY_USER_TRANSFORM, sameUserTransform, type UserTransform } from "../userTransform.ts";
import "./UserTransformFields.css";

const AXES = ["X", "Y", "Z"] as const;

type Triple = [number, number, number];

/** The smallest scale a field takes; a layer always keeps a size. */
const MIN_SCALE = 0.0001;

/** How a person reads the three angles, which lucida-core turns by in this order. */
const ROTATION_ORDER =
  "Degrees about X, then Y, then Z, each about the axis the turns before it left. The layer turns about its center.";

export interface UserTransformFieldsProps {
  /** The layer's name, for the fields' labels. */
  name: string;
  /** Its transform, or null where it sits as its metadata places it. */
  transform: UserTransform | null;
  /** Its rotation as degrees about X, then Y, then Z. */
  rotation: readonly [number, number, number];
  /** The unit each axis declares, `[x, y, z]`, which the offset is in. */
  units: readonly [string | null, string | null, string | null];
  /** Whether this member may change the shared workspace. */
  canEdit: boolean;
  onChange(from: UserTransform, to: UserTransform): void;
  /** Turn the layer to `degrees` about its center, from `from`. */
  onTurn(from: UserTransform, degrees: Triple): void;
  onReset(): void;
}

/** The one unit the offset is in, or null when the axes declare none or differ.
 *  A flat image declares no Z unit, and its Z offset reads in X's. */
function offsetUnit([x, y, z]: readonly (string | null)[]): string | null {
  return x !== null && x === y && (z === null || z === x) ? x : null;
}

export function UserTransformFields({
  name,
  transform,
  rotation,
  units,
  canEdit,
  onChange,
  onTurn,
  onReset,
}: UserTransformFieldsProps) {
  const current = transform ?? IDENTITY_USER_TRANSFORM;
  const set = (part: "translation" | "scale", axis: number, value: number) => {
    const values = current[part].map((v, i) => (i === axis ? value : v)) as Triple;
    const next = { ...current, [part]: values };
    if (!sameUserTransform(next, current)) onChange(current, next);
  };
  const turn = (axis: number, value: number) => {
    if (!Number.isFinite(value) || value === rotation[axis]) return;
    onTurn(current, rotation.map((v, i) => (i === axis ? value : v)) as Triple);
  };
  const unit = offsetUnit(units);
  return (
    <div className="lc-user-transform" role="group" aria-label={`${name} placement`}>
      <span className="lc-layer-field-label">Placement</span>
      <div className="lc-user-transform-grid">
        <span aria-hidden />
        {AXES.map((axis) => (
          <span key={axis} className="lc-user-transform-axis" aria-hidden>
            {axis}
          </span>
        ))}
        <span className="lc-user-transform-row" title={unit ? `In ${unit}s, as the data declares them` : undefined}>
          Offset
        </span>
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            label={`${name} offset ${axis}${unit ? ` in ${unit}s` : ""}`}
            labelPosition="hidden"
            hideSteppers
            value={current.translation[i]}
            formatOptions={{ maximumFractionDigits: 3 }}
            isDisabled={!canEdit}
            onChange={(v) => set("translation", i, v)}
          />
        ))}
        <span className="lc-user-transform-row">Scale</span>
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            label={`${name} scale ${axis}`}
            labelPosition="hidden"
            hideSteppers
            value={current.scale[i]}
            minValue={MIN_SCALE}
            formatOptions={{ maximumFractionDigits: 4 }}
            isDisabled={!canEdit}
            onChange={(v) => set("scale", i, v)}
          />
        ))}
        <span className="lc-user-transform-row" title={ROTATION_ORDER}>
          Rotation
        </span>
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            label={`${name} rotation ${axis} in degrees`}
            labelPosition="hidden"
            hideSteppers
            value={rotation[i]}
            formatOptions={{ maximumFractionDigits: 2 }}
            isDisabled={!canEdit}
            onChange={(v) => turn(i, v)}
          />
        ))}
      </div>
      <Button
        className="lc-user-transform-reset"
        size="sm"
        variant="ghost"
        icon={ArrowCounterClockwiseIcon}
        isDisabled={!canEdit || transform === null}
        onPress={onReset}
      >
        Reset placement
      </Button>
    </div>
  );
}
