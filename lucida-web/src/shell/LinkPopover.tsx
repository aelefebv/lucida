import { LinkSimpleBreakIcon, LinkSimpleIcon } from "@phosphor-icons/react";
import type { LinkMode, LinkProperty } from "../commands.ts";
import { IconButton } from "../ui/Button.tsx";
import { Popover } from "../ui/Popover.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import {
  basisNote,
  channelPairText,
  LINK_LABELS,
  LINK_MODE_LABELS,
  linkModes,
  unlinkableReason,
  type PropertyLink,
  type ViewLinks,
} from "../viewLinks.ts";
import "./LinkPopover.css";

export interface LinkPopoverProps {
  links: ViewLinks;
  onChange: (property: LinkProperty, mode: LinkMode) => void;
}

/**
 * How the two views follow each other, one property at a time, and what
 * they compare in. A property the cameras don't share keeps its mode for
 * when they do and says why it waits; with a view showing nothing, none
 * can be set.
 */
export function LinkPopover({ links, onChange }: LinkPopoverProps) {
  const anyLinked = links.properties.some((link) => link.mode !== "off" && !link.unlinkable);
  return (
    <Popover
      label="Link views"
      placement="top"
      trigger={<IconButton icon={anyLinked ? LinkSimpleIcon : LinkSimpleBreakIcon} size="sm" label="Link views" />}
    >
      <div className="lc-link-popover">
        {links.basis && <p className="lc-link-basis">{basisNote(links.basis, links.alike)}</p>}
        {links.properties.map((link) => (
          <LinkRow key={link.property} link={link} onChange={onChange} />
        ))}
        {links.channels && links.channels.length > 0 && (
          <div className="lc-link-channels">
            <p className="lc-link-reason">Contrast and colormap pair these channels:</p>
            <ul>
              {links.channels.map((pair) => (
                <li key={pair.first} data-paired-by={pair.by}>{channelPairText(pair)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Popover>
  );
}

function LinkRow({ link, onChange }: { link: PropertyLink; onChange: LinkPopoverProps["onChange"] }) {
  const settable = link.unlinkable !== "empty" && link.unlinkable !== "shared";
  return (
    <div className="lc-link-row" data-link-property={link.property}>
      <SegmentedControl
        label={LINK_LABELS[link.property]}
        labelPosition="side"
        size="sm"
        options={linkModes(link.property).map((mode) => ({ value: mode, label: LINK_MODE_LABELS[mode] }))}
        value={link.mode}
        isDisabled={!settable}
        onChange={(mode) => onChange(link.property, mode)}
      />
      {link.unlinkable && <p className="lc-link-reason">{unlinkableReason(link.property, link.unlinkable)}</p>}
    </div>
  );
}
