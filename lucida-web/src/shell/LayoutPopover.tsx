/**
 * How the canvas divides among the views, as a menu of presets: one view,
 * two side by side or stacked, four free views, or four-up, the same
 * datasets as three slices and a volume crossing at one point.
 */
import { ColumnsIcon, GridFourIcon, LayoutIcon, RowsIcon, SquareIcon, type Icon } from "@phosphor-icons/react";
import type { ViewLayoutName } from "../commands.ts";
import { IconButton } from "../ui/Button.tsx";
import { Popover } from "../ui/Popover.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { LAYOUT_LABELS } from "../viewLayout.ts";

const LAYOUT_ICONS: Readonly<Record<ViewLayoutName, Icon>> = {
  single: SquareIcon,
  columns: ColumnsIcon,
  rows: RowsIcon,
  grid: GridFourIcon,
  four_up: LayoutIcon,
};

export interface LayoutPopoverProps {
  layout: ViewLayoutName;
  /** The presets this screen offers. */
  layouts: readonly ViewLayoutName[];
  onChange: (layout: ViewLayoutName) => void;
}

export function LayoutPopover({ layout, layouts, onChange }: LayoutPopoverProps) {
  return (
    <Popover
      label="View layout"
      placement="top"
      trigger={<IconButton icon={LAYOUT_ICONS[layout]} size="sm" label="View layout" />}
    >
      <SegmentedControl
        label="View layout"
        size="sm"
        options={layouts.map((value) => ({ value, label: LAYOUT_LABELS[value] }))}
        value={layout}
        onChange={(next) => {
          if (next !== layout) onChange(next);
        }}
      />
    </Popover>
  );
}
