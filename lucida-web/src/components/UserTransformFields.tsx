/**
 * A layer's placement by hand as numbers: its offset and scale on each axis,
 * and the one action that puts it back where its metadata places it. The
 * Move and scale tool changes the same transform on the canvas.
 */
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { Button, NumberField } from "../ui/index.ts";
import { IDENTITY_USER_TRANSFORM, sameUserTransform, type UserTransform } from "../userTransform.ts";
import "./UserTransformFields.css";

const AXES = ["X", "Y", "Z"] as const;

/** The smallest scale a field takes; a layer always keeps a size. */
const MIN_SCALE = 0.0001;

export interface UserTransformFieldsProps {
  /** The layer's name, for the fields' labels. */
  name: string;
  /** Its transform, or null where it sits as its metadata places it. */
  transform: UserTransform | null;
  /** The unit each axis declares, `[x, y, z]`, which the offset is in. */
  units: readonly [string | null, string | null, string | null];
  /** Whether this member may change the shared workspace. */
  canEdit: boolean;
  onChange(from: UserTransform, to: UserTransform): void;
  onReset(): void;
}

/** The one unit the offset is in, or null when the axes declare none or differ.
 *  A flat image declares no Z unit, and its Z offset reads in X's. */
function offsetUnit([x, y, z]: readonly (string | null)[]): string | null {
  return x !== null && x === y && (z === null || z === x) ? x : null;
}

export function UserTransformFields({ name, transform, units, canEdit, onChange, onReset }: UserTransformFieldsProps) {
  const current = transform ?? IDENTITY_USER_TRANSFORM;
  const set = (part: "translation" | "scale", axis: number, value: number) => {
    const values = current[part].map((v, i) => (i === axis ? value : v)) as [number, number, number];
    const next = { ...current, [part]: values };
    if (!sameUserTransform(next, current)) onChange(current, next);
  };
  const unit = offsetUnit(units);
  return (
    <div className="lc-user-transform" role="group" aria-label={`${name} position and size`}>
      <span className="lc-layer-field-label">Position and size</span>
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
      </div>
      <Button
        className="lc-user-transform-reset"
        size="sm"
        variant="ghost"
        icon={ArrowCounterClockwiseIcon}
        isDisabled={!canEdit || transform === null}
        onPress={onReset}
      >
        Reset position and size
      </Button>
    </div>
  );
}
