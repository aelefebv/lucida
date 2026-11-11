/**
 * Says in a view where a link took it past what it shows: a position or a
 * depth outside its data, or a timepoint past its last. A linked view
 * follows the other wherever it goes, so it can land where it draws
 * nothing.
 */
import { linkNoticeMessage, type LinkNotice } from "../viewLinks.ts";

export function LinkNotices({ notices }: { notices: readonly LinkNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="lc-view-notice" role="status" data-link-notices="">
      {notices.map((notice) => (
        <p key={notice.kind}>{linkNoticeMessage(notice)}</p>
      ))}
    </div>
  );
}
