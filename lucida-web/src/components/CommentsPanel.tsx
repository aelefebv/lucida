/**
 * The Comments rail panel: the current dataset's annotation threads, newest
 * first, and the comments that @-mention the current user.
 *
 * Pure: it reads only its props and reports picks through `onNavigate`, so the
 * host owns opening the thread and restoring the author's view. Read state for
 * mentions is the host's too, persisted per browser.
 */
import {
  BoundingBoxIcon,
  EyeSlashIcon,
  LineSegmentIcon,
  MapPinIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { IconButton } from "../ui/Button.tsx";
import { PanelHeader } from "../ui/PanelHeader.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import type { Annotation } from "./annotationDocument.ts";
import { deriveHandle } from "./annotationParticipants.ts";
import { countUnread, type MentionHit } from "./mentionsOfMe.ts";
import "./BookmarkSidebar.css";
import "./CommentsPanel.css";

export interface CommentsPanelProps {
  visible: boolean;
  /** The current dataset's pins with their threads, in document order. */
  annotations: readonly Annotation[];
  /** Comments in `annotations` that mention the current user. */
  mentions: readonly MentionHit[];
  /** Comment ids this viewer has opened. */
  viewedCommentIds: readonly string[];
  /** The browser's annotation author id, so its own comments read "you". */
  currentUserId: string;
  /** Plane and timepoint counts; a pin's Z or T shows only where there are several. */
  extents?: { z: number; t: number };
  /** Opens the pin's thread and brings it into view. */
  onNavigate: (pinId: string) => void;
  onMarkViewed: (commentId: string) => void;
}

type Tab = "threads" | "mentions";

const KIND_ICON: Record<string, { icon: Icon; label: string }> = {
  point: { icon: MapPinIcon, label: "Point" },
  line: { icon: LineSegmentIcon, label: "Line" },
  box: { icon: BoundingBoxIcon, label: "Box" },
};

/** Snippet length before eliding. The full text stays in the item's title. */
const SNIPPET_MAX = 80;

/** Display only: matching runs on the full text, never on this. */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SNIPPET_MAX ? `${oneLine.slice(0, SNIPPET_MAX - 1)}…` : oneLine;
}

export function CommentsPanel({
  visible,
  annotations,
  mentions,
  viewedCommentIds,
  currentUserId,
  extents,
  onNavigate,
  onMarkViewed,
}: CommentsPanelProps) {
  const viewed = useMemo(() => new Set(viewedCommentIds), [viewedCommentIds]);
  const unread = countUnread(mentions, viewed);
  // Opening the panel with unread mentions shows them first: they are why the
  // rail icon carries a badge.
  const [tab, setTab] = useState<Tab>(() => (visible && unread > 0 ? "mentions" : "threads"));
  const [hideViewed, setHideViewed] = useState(false);
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible && unread > 0) setTab("mentions");
  }

  // Pins carry no timestamps, but the document appends them, so the newest
  // thread is the last one.
  const threads = useMemo(() => [...annotations].reverse(), [annotations]);
  const unreadByPin = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const hit of mentions) {
      if (viewed.has(hit.commentId)) continue;
      out.set(hit.pinId, [...(out.get(hit.pinId) ?? []), hit.commentId]);
    }
    return out;
  }, [mentions, viewed]);

  if (!visible) return null;

  const openThread = (pinId: string) => {
    onNavigate(pinId);
    // Opening the thread shows its mentions, so they count as read.
    for (const commentId of unreadByPin.get(pinId) ?? []) onMarkViewed(commentId);
  };

  const author = (id: string) => (id === currentUserId ? "you" : deriveHandle(id));

  return (
    <section className="lc-rail-panel" aria-label="Comments" data-testid="comments-panel">
      <PanelHeader
        className="lc-rail-panel-header"
        title="Comments"
        meta={threads.length > 0 ? threads.length : undefined}
      />
      <div className="lc-rail-panel-toolbar">
        <SegmentedControl
          label="Show"
          size="sm"
          className="lc-comments-tabs"
          value={tab}
          onChange={setTab}
          options={[
            { value: "threads", label: "All threads" },
            { value: "mentions", label: unread > 0 ? `Mentions (${unread})` : "Mentions" },
          ]}
        />
      </div>

      <div className="lc-rail-panel-body">
        {tab === "threads" ? (
          threads.length === 0 ? (
            <p className="lc-rail-panel-empty">
              No comments on this dataset yet. Choose the point tool (P) and click the canvas to pin one.
            </p>
          ) : (
            <ul className="lc-rail-list">
              {threads.map((pin) => {
                const comments = pin.comments ?? [];
                const first = comments[0];
                const kind = KIND_ICON[pin.kind] ?? KIND_ICON.point;
                const KindIcon = kind.icon;
                const where = [
                  extents && extents.z > 1 ? `Z ${(pin.z ?? 0) + 1}` : null,
                  extents && extents.t > 1 ? `T ${(pin.t ?? 0) + 1}` : null,
                ].filter(Boolean);
                const meta = [
                  author(first?.author ?? pin.author),
                  comments.length === 1 ? "1 comment" : `${comments.length} comments`,
                  ...where,
                ].join(" · ");
                const hasUnread = unreadByPin.has(pin.id);
                return (
                  <li key={pin.id} className="lc-rail-row">
                    <button
                      type="button"
                      className="lc-rail-row-open"
                      data-testid={`comment-thread-${pin.id}`}
                      data-unread={hasUnread || undefined}
                      title={first?.text}
                      onClick={() => openThread(pin.id)}
                    >
                      <KindIcon className="lc-comments-kind" size={16} aria-label={kind.label} />
                      <span className="lc-rail-row-text">
                        <span
                          className="lc-rail-row-name"
                          data-empty={first ? undefined : ""}
                        >
                          {first ? snippet(first.text) : "No comments yet"}
                        </span>
                        <span className="lc-rail-row-meta">{meta}</span>
                      </span>
                      {hasUnread && (
                        <span className="lc-comments-dot" role="img" aria-label="Unread mention" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <MentionsList
            mentions={mentions}
            viewed={viewed}
            unread={unread}
            hideViewed={hideViewed}
            onHideViewedChange={setHideViewed}
            onPick={(hit) => {
              onNavigate(hit.pinId);
              onMarkViewed(hit.commentId);
            }}
          />
        )}
      </div>
    </section>
  );
}

function MentionsList({
  mentions,
  viewed,
  unread,
  hideViewed,
  onHideViewedChange,
  onPick,
}: {
  mentions: readonly MentionHit[];
  viewed: ReadonlySet<string>;
  unread: number;
  hideViewed: boolean;
  onHideViewedChange: (hide: boolean) => void;
  onPick: (hit: MentionHit) => void;
}) {
  const visibleHits = hideViewed ? mentions.filter((h) => !viewed.has(h.commentId)) : mentions;
  return (
    <div className="lc-comments-mentions" data-testid="mentions-of-me-panel">
      {/* Keyed off whether any mention exists, not the unread count, so a fully
          read list doesn't claim no one ever mentioned you. */}
      <div className="lc-comments-mentions-header">
        <span className="lc-comments-mentions-summary" data-testid="mentions-of-me-summary">
          {mentions.length === 0
            ? "No one has mentioned you here"
            : unread === 0
              ? "All mentions read"
              : `${unread} unread mention${unread === 1 ? "" : "s"}`}
        </span>
        <IconButton
          size="sm"
          icon={EyeSlashIcon}
          label="Hide read mentions"
          tooltipPlacement="left"
          isSelected={hideViewed}
          onSelectedChange={onHideViewedChange}
          data-testid="mentions-of-me-hide-viewed-toggle"
        />
      </div>
      {mentions.length === 0 ? (
        <p className="lc-rail-panel-empty">
          When a collaborator @-mentions you in a comment on this dataset, it shows up here.
        </p>
      ) : visibleHits.length === 0 ? (
        <p className="lc-rail-panel-empty">
          No unread mentions. Turn off &ldquo;Hide read mentions&rdquo; to see the read ones.
        </p>
      ) : (
        <ul className="lc-rail-list">
          {visibleHits.map((hit) => {
            const isViewed = viewed.has(hit.commentId);
            return (
              <li key={hit.commentId} className="lc-rail-row">
                <button
                  type="button"
                  className="lc-rail-row-open lc-comments-mention"
                  data-testid={`mention-of-me-item-${hit.commentId}`}
                  data-viewed={isViewed ? "true" : "false"}
                  title={hit.text}
                  onClick={() => onPick(hit)}
                >
                  <span className="lc-rail-row-name">{snippet(hit.text)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
