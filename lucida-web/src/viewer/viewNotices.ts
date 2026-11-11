/**
 * What a view says of itself beyond what it draws: that it shows less detail
 * than it asks for, where a link took it past its data, and which layers a
 * comparison hides. A warning means the view shows something other than
 * what was asked of it; a note says where it stands or what it leaves out
 * by choice. The view's notice icon wears the most severe.
 */
import { linkNoticeMessage, type LinkNotice } from "../viewLinks.ts";
import { coverageMessage, type Coverage } from "./coverage.ts";

export type NoticeSeverity = "warning" | "note";

export interface ViewNotice {
  /** Which notice it is, kept while its numbers change, so a notice is new only once. */
  readonly key: string;
  readonly severity: NoticeSeverity;
  readonly message: string;
}

export interface ViewNoticeSources {
  /** With several views, how much of what the view asks for fit in the memory they share. */
  coverage?: Coverage;
  /** Where a link took the view past its data. */
  links: readonly LinkNotice[];
  /** What the view's comparison says of the layers it hides, or null. */
  setAside: string | null;
}

/** The view's notices, warnings first. */
export function viewNotices({ coverage, links, setAside }: ViewNoticeSources): ViewNotice[] {
  const notices: ViewNotice[] = [];
  if (coverage && coverage.short > 0) {
    notices.push({ key: "coverage", severity: "warning", message: coverageMessage(coverage.wanted, coverage.short) });
  }
  for (const notice of links) {
    // A timepoint held at a layer's last is a value shown as another; a
    // place past the data draws nothing, which the view shows plainly.
    const severity = notice.kind === "time" ? "warning" : "note";
    notices.push({ key: `link-${notice.kind}`, severity, message: linkNoticeMessage(notice) });
  }
  if (setAside) notices.push({ key: "set-aside", severity: "note", message: setAside });
  return notices.sort((a, b) => rank(a.severity) - rank(b.severity));
}

function rank(severity: NoticeSeverity): number {
  return severity === "warning" ? 0 : 1;
}

/** The icon's accessible name: how many notices, and the most severe. */
export function noticesLabel(notices: readonly ViewNotice[]): string {
  const count = notices.length === 1 ? "1 notice" : `${notices.length} notices`;
  return notices.length > 0 ? `${count}: ${notices[0].message}` : "No notices";
}
