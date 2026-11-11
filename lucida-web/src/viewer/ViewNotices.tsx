/**
 * A view's notices as one icon in its column. The most severe notice sets
 * its look, a count says how many when there are several, and a press opens
 * the list under it. The list lies over the view, out of the column's flow,
 * so opening it moves nothing else there.
 *
 * A notice the view hasn't shown before opens the list for a few seconds,
 * so it is read once without a press; after that it waits behind the icon,
 * however often it comes back. A pointer or focus in the list keeps it
 * open, and a press on the icon or Escape closes it.
 */
import { InfoIcon, WarningIcon } from "@phosphor-icons/react";
import { useEffect, useId, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { pushEscapeLayer } from "../ui/escape.ts";
import { Tooltip } from "../ui/Tooltip.tsx";
import { noticesLabel, type ViewNotice } from "./viewNotices.ts";
import "./ViewNotices.css";

/** How long a list opened by a new notice stays open on its own. */
export const NEW_NOTICE_OPEN_MS = 5000;

export function ViewNotices({ notices }: { notices: readonly ViewNotice[] }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  // Opened by a new notice rather than a press, so it closes on its own.
  const [passing, setPassing] = useState(false);
  const [held, setHeld] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());

  const fresh = notices.filter((notice) => !seen.has(notice.key));
  if (fresh.length > 0) {
    setSeen(new Set([...seen, ...fresh.map((notice) => notice.key)]));
    setOpen(true);
    setPassing(true);
  }
  if (notices.length === 0 && open) {
    setOpen(false);
    setPassing(false);
  }

  useEffect(() => {
    if (!passing || held) return;
    const timer = setTimeout(() => {
      setOpen(false);
      setPassing(false);
    }, NEW_NOTICE_OPEN_MS);
    return () => clearTimeout(timer);
  }, [passing, held]);

  useEffect(() => {
    if (!open) return;
    return pushEscapeLayer(() => {
      setOpen(false);
      setPassing(false);
    });
  }, [open]);

  if (notices.length === 0) return null;
  const severity = notices[0].severity;
  const label = noticesLabel(notices);
  return (
    <div
      className="lc-view-notices"
      data-severity={severity}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div className="lc-view-notices-icon">
        <Tooltip content={label}>
          <Button
            variant={severity === "warning" ? "warning" : "ghost"}
            size="sm"
            icon={severity === "warning" ? WarningIcon : InfoIcon}
            aria-label={label}
            aria-expanded={open}
            aria-controls={listId}
            onPress={() => {
              setOpen(!open);
              setPassing(false);
            }}
          >
            {notices.length > 1 ? notices.length : null}
          </Button>
        </Tooltip>
      </div>
      <ul className="lc-view-notices-list" id={listId} aria-label="View notices" hidden={!open} data-keep-clear="">
        {notices.map((notice) => (
          <li key={notice.key} data-severity={notice.severity}>
            {notice.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
