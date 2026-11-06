import { CheckIcon } from "@phosphor-icons/react";
import { Button as AriaButton, ListBox, ListBoxItem } from "react-aria-components";
import { COLORMAP_NAMES } from "../colormaps.ts";
import type { Colormap } from "../savedView/types.ts";
import { Popover, Tooltip } from "../ui/index.ts";
import { colormapTitle, rampGradient } from "./colormapSwatch.ts";
import "./ColormapPicker.css";

interface Props {
  value: string;
  onChange: (colormap: Colormap) => void;
  /** Whose colormap it is, e.g. the channel's name. */
  label: string;
}

/**
 * A swatch of the current colormap that opens a list of every colormap, each
 * drawn as its ramp.
 */
export function ColormapPicker({ value, onChange, label }: Props) {
  const title = colormapTitle(value);
  return (
    <Popover
      label={`${label} colormap`}
      className="lc-colormap-popover"
      trigger={
        <Tooltip content={`Colormap: ${title}`}>
          <AriaButton
            className="lc-colormap-swatch"
            aria-label={`${label} colormap: ${title}`}
            style={{ background: rampGradient(value, 96) }}
          />
        </Tooltip>
      }
    >
      {(close) => (
        <ListBox
          className="lc-colormap-list"
          aria-label={`${label} colormap`}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[value]}
          autoFocus
          onSelectionChange={(keys) => {
            const next = keys === "all" ? undefined : [...keys][0];
            if (typeof next === "string" && next !== value) onChange(next as Colormap);
            close();
          }}
        >
          {COLORMAP_NAMES.map((name) => (
            <ListBoxItem key={name} id={name} textValue={colormapTitle(name)} className="lc-colormap-option">
              {({ isSelected }) => (
                <>
                  <span className="lc-colormap-ramp" style={{ background: rampGradient(name) }} aria-hidden />
                  <span className="lc-colormap-name">{colormapTitle(name)}</span>
                  {isSelected && <CheckIcon className="lc-colormap-check" size={14} aria-hidden />}
                </>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      )}
    </Popover>
  );
}
