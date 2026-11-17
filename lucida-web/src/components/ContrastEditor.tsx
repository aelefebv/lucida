import type { ReactNode } from "react";
import { CornersOutIcon } from "@phosphor-icons/react";
import { useViewportClass } from "../theme/viewport.ts";
import { Dialog, IconButton, Popover } from "../ui/index.ts";
import "./ContrastEditor.css";

interface Props {
  /** Whose contrast it is, e.g. the channel's name. */
  label: string;
  /** The controls the editor holds, mounted each time it opens. */
  children: ReactNode;
}

/**
 * A button that opens a channel's contrast controls at a size for precise
 * work: in a popover beside the channel, or on a phone in a sheet from the
 * bottom edge, since a phone's channels sit in its own bottom sheet with no
 * room beside them.
 */
export function ContrastEditor({ label, children }: Props) {
  const phone = useViewportClass() === "phone";
  const title = `${label} contrast`;
  const trigger = (
    <IconButton className="lc-contrast-expand" icon={CornersOutIcon} size="sm" label="Expand contrast" />
  );
  const content = <div className="lc-contrast-editor">{children}</div>;
  return phone ? (
    <Dialog title={title} placement="bottom" trigger={trigger}>
      {content}
    </Dialog>
  ) : (
    <Popover label={title} placement="right" className="lc-contrast-editor-popover" trigger={trigger}>
      {content}
    </Popover>
  );
}
