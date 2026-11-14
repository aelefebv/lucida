import {
  ArrowSquareInIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  CloudIcon,
  FolderIcon,
  ImageSquareIcon,
  SquaresFourIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { isRemoteDatasetUrl } from "../datasetLocation.ts";
import { formatCount } from "../formatCount.ts";
import { relativeTimeFromIso } from "../relativeTime.ts";
import { usePointerCoarse } from "../theme/viewport.ts";
import { Button } from "../ui/Button.tsx";
import { CheckBox } from "../ui/Checkbox.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { useCommand } from "../ui/commands.ts";
import { isApplePlatform } from "../ui/shortcuts.ts";
import { ComboboxField } from "../ui/TextField.tsx";
import { UnstyledButton } from "../ui/UnstyledButton.tsx";
import { FilterChips, type DatePreset } from "./FilterChips.tsx";
import type { Listing, ListingKind, ListingScope } from "./listingsApi.ts";
import {
  buildRows,
  choiceOf,
  countListings,
  parentOf,
  visibleRows,
  type GroupRow,
  type OpenChoice,
  type OpenRow,
} from "./openRows.ts";
import { groupChoices, tickChoice, toggleTick, useOpenTogetherLimit } from "./openSelection.ts";
import { OPEN_DATA_SHORTCUT } from "./shortcut.ts";
import { useListingSearch } from "./useListingSearch.ts";
import { useRecentDatasets } from "./useRecentDatasets.ts";
import { useTypedLocation } from "./useTypedLocation.ts";
import "./OpenDialog.css";

/** One thing the dialog can do with the datasets someone chose. */
export interface OpenAction {
  /** Says what it does, e.g. "Open in a new workspace". */
  label: string;
  /** Opens one dataset, or up to four ticked together, in the order they were ticked. */
  run: (choices: readonly OpenChoice[]) => void;
}

export interface OpenDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** What Enter, a click, or a tap does with the chosen datasets. */
  primary: OpenAction;
  /** What Mod+Enter or a Mod-click does instead. Without it they do what Enter does. */
  secondary?: OpenAction;
}

const PLACEHOLDER = "Search datasets, or paste a path or URL";

const SCOPES = [
  { value: "mine", label: "Mine" },
  { value: "everyone", label: "Everyone" },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The one way to open data: a field that searches every dataset the server's
 * sources offer, or takes a pasted path or URL. `Mod+O` and the "Open data…"
 * command open it. It closes as soon as an open is sent; whatever the action
 * opens into carries the progress or the failure from there.
 */
export function OpenDialog({ isOpen, onOpenChange, primary, secondary }: OpenDialogProps) {
  useCommand({
    id: "data.open",
    label: "Open data…",
    group: "General",
    keywords: ["add", "dataset", "search", "find", "path", "url"],
    keys: [OPEN_DATA_SHORTCUT],
    run: () => onOpenChange(true),
  });

  return (
    <Dialog title="Open data" size="lg" isOpen={isOpen} onOpenChange={onOpenChange}>
      {(close) => <OpenDialogBody close={close} primary={primary} secondary={secondary} />}
    </Dialog>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

function isModClick(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isApplePlatform() ? event.metaKey : event.ctrlKey;
}

/** Mounted while open, so each opening starts from an empty field. */
function OpenDialogBody({
  close,
  primary,
  secondary,
}: {
  close: () => void;
  primary: OpenAction;
  secondary?: OpenAction;
}) {
  const baseId = useId();
  const [text, setText] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Arrowing into the list hands Left and Right to it; typing takes them back.
  const [navigating, setNavigating] = useState(false);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // Starts on the caller's own datasets; the server answers for everyone's
  // until it can tell them apart.
  const [scope, setScope] = useState<ListingScope>("mine");
  const [kind, setKind] = useState<ListingKind | null>(null);
  // The bound is fixed when its chip is chosen, so every page of one search asks the same one.
  const [dateBound, setDateBound] = useState<{ within: DatePreset; since: string } | null>(null);
  // Kept while the text changes, so datasets found by different searches open together.
  const [ticked, setTicked] = useState<readonly OpenChoice[]>([]);
  const [refused, setRefused] = useState(false);
  const limit = useOpenTogetherLimit();
  const coarse = usePointerCoarse();

  const query = text.trim();
  const within = dateBound?.within ?? null;
  const search = useListingSearch({ q: query, scope, kind, since: dateBound?.since ?? null });
  const location = useTypedLocation(text);
  const recent = useRecentDatasets();
  // Results from an earlier request stay up while the next one is asked, but
  // never open: they don't answer what is asked now.
  const { stale } = search;

  const rows = useMemo(
    () =>
      buildRows({
        location,
        recents: query ? [] : recent.recents,
        results: search.results,
        toggled,
        hasMore: search.hasMore,
        outsideScope: search.outsideScope,
      }),
    [location, query, recent.recents, search.results, search.hasMore, search.outsideScope, toggled],
  );
  const visible = useMemo(() => visibleRows(rows), [rows]);
  const indexOf = useMemo(() => new Map(visible.map((row, index) => [row, index])), [visible]);
  const active = visible.find((row) => row.key === activeKey) ?? visible[0] ?? null;
  const activeIndex = active ? (indexOf.get(active) ?? -1) : -1;
  const domId = (index: number) => `${baseId}-row-${index}`;
  const activeId = activeIndex >= 0 ? domId(activeIndex) : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.firstElementChild?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const toggle = (group: GroupRow, expanded: boolean) =>
    setToggled((map) => new Map(map).set(group.key, expanded));

  // A new request lists new rows, so nothing chosen among the old ones carries over.
  const restartWith = <T,>(set: (value: T) => void, value: T) => {
    set(value);
    setActiveKey(null);
    setNavigating(false);
    setToggled(new Map());
  };
  const setWithin = (days: DatePreset | null) =>
    setDateBound(days && { within: days, since: new Date(Date.now() - days * DAY_MS).toISOString() });

  const isTicked = (choice: OpenChoice) => ticked.some((t) => t.url === choice.url);

  const tick = (choice: OpenChoice) => {
    const next = toggleTick(ticked, choice, limit);
    if (next === null) {
      setRefused(true);
      return;
    }
    setTicked(next);
    setRefused(false);
  };

  const open = (choices: readonly OpenChoice[], elsewhere: boolean) => {
    (elsewhere && secondary ? secondary : primary).run(choices);
    close();
  };

  const activate = (row: OpenRow, elsewhere: boolean) => {
    if (row.type === "group") {
      toggle(row, !row.expanded);
      return;
    }
    if (row.type === "more") {
      search.loadMore();
      return;
    }
    if (row.type === "everyone") {
      restartWith(setScope, "everyone");
      return;
    }
    if (stale && row.type === "listing") return;
    const choice = choiceOf(row);
    if (choice) open([choice], elsewhere);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = visible[Math.min(Math.max(activeIndex + step, 0), visible.length - 1)];
        if (next) setActiveKey(next.key);
        setNavigating(true);
        return;
      }
      case "ArrowRight": {
        const { selectionStart, selectionEnd, value } = event.currentTarget;
        // At the end of the text the caret has nowhere to go, so Right is free.
        const caretAtEnd = selectionStart === value.length && selectionEnd === value.length;
        if (active?.type !== "group" || !(navigating || caretAtEnd)) return;
        event.preventDefault();
        if (!active.expanded) toggle(active, true);
        else if (active.children[0]) setActiveKey(active.children[0].key);
        setNavigating(true);
        return;
      }
      case "ArrowLeft": {
        if (!active || !(navigating || text === "")) return;
        const parent = parentOf(active);
        if (active.type === "group" && active.expanded) {
          event.preventDefault();
          toggle(active, false);
        } else if (parent) {
          event.preventDefault();
          setActiveKey(parent);
        }
        return;
      }
      case " ": {
        // Only once arrowed onto a row: while typing, Space is part of the words.
        const choice = navigating && active && !rowDisabled(active, stale) ? tickChoice(active) : null;
        if (!choice) return;
        event.preventDefault();
        tick(choice);
        return;
      }
      case "Enter": {
        event.preventDefault();
        if (ticked.length > 0) open(ticked, isModClick(event));
        else if (active) activate(active, isModClick(event));
        return;
      }
    }
  };

  const onRowClick = (row: OpenRow) => (event: MouseEvent) => activate(row, isModClick(event));

  const listingCount = countListings(rows);
  const status = describeStatus({
    query,
    stale,
    error: search.error,
    listingCount,
    // Until the recent datasets arrive, the empty field may yet show some.
    hasRecents: !query && (!recent.answered || recent.recents.length > 0),
    location: location !== null,
    outside: search.outsideScope > 0,
    filtered: kind !== null || within !== null,
  });

  const renderRow = (row: OpenRow, level: number, position: number, siblings: number): ReactNode => {
    const index = indexOf.get(row) ?? -1;
    const isActive = index === activeIndex;
    const common = {
      id: domId(index),
      role: "treeitem",
      "aria-level": level,
      "aria-posinset": position,
      "aria-setsize": siblings,
      "aria-selected": isActive,
      "data-active": isActive || undefined,
    } as const;
    const rowProps = {
      className: "lc-open-row",
      "data-type": row.type,
      // Focus stays in the field; the row is chosen by the active descendant.
      onMouseDown: (event: MouseEvent) => event.preventDefault(),
      onMouseMove: () => {
        if (!isActive) setActiveKey(row.key);
      },
      onClick: onRowClick(row),
    };
    if (row.type === "group") {
      const count = row.children.length;
      const detail = row.noun === null ? null : `${row.noun} · ${plural(count, "dataset")}`;
      const whole = groupChoices(row, limit);
      return (
        <li
          key={row.key}
          {...common}
          aria-expanded={row.expanded}
          aria-label={row.noun ? `${row.noun} ${row.label}` : row.label}
        >
          <div {...rowProps} title={row.id ?? undefined}>
            <CaretRightIcon
              className="lc-open-caret"
              size={12}
              aria-hidden
              data-expanded={row.expanded || undefined}
            />
            {row.noun === null && <ClockCounterClockwiseIcon className="lc-open-icon" size={16} aria-hidden />}
            <span className="lc-open-title">{row.label}</span>
            {detail && <span className="lc-open-aside">{detail}</span>}
            {whole && row.noun && (
              <UnstyledButton
                className="lc-open-group-action"
                isDisabled={stale}
                preventFocusOnPress
                onPress={(event) => open(whole, isModClick(event))}
              >
                Open {row.noun.toLowerCase()}
              </UnstyledButton>
            )}
          </div>
          {row.expanded && (
            <ul role="group" className="lc-open-children">
              {row.children.map((child, i) => renderRow(child, level + 1, i + 1, row.children.length))}
            </ul>
          )}
        </li>
      );
    }
    const tickable = tickChoice(row);
    const checked = tickable !== null && isTicked(tickable);
    const disabled = rowDisabled(row, stale);
    return (
      <li
        key={row.key}
        {...common}
        aria-checked={tickable ? checked : undefined}
        aria-disabled={disabled || undefined}
      >
        <div {...rowProps}>
          {tickable && (
            // A press here ticks the row without opening it or taking focus from the field.
            <UnstyledButton
              className="lc-open-tick"
              aria-label={`Tick ${tickable.title ?? tickable.url}`}
              aria-pressed={checked}
              isDisabled={disabled}
              preventFocusOnPress
              onPress={() => tick(tickable)}
            >
              <CheckBox isSelected={checked} />
            </UnstyledButton>
          )}
          {rowContent(row, search.loadingMore)}
        </div>
      </li>
    );
  };

  return (
    <div className="lc-open-data">
      <div className="lc-open-controls" data-scoped={search.mineAvailable || undefined}>
        <ComboboxField
          className="lc-open-field"
          label={PLACEHOLDER}
          value={text}
          onChange={(next) => restartWith(setText, next)}
          onKeyDown={onKeyDown}
          controls={`${baseId}-tree`}
          activeDescendant={activeId}
          autoFocus
        />
        {search.mineAvailable && (
          <SegmentedControl
            label="Whose datasets"
            options={SCOPES}
            value={scope}
            onChange={(next) => restartWith(setScope, next)}
            preventFocusOnPress
            className="lc-open-scope"
          />
        )}
        <FilterChips
          kind={kind}
          onKindChange={(next) => restartWith(setKind, next)}
          within={within}
          onWithinChange={(next) => restartWith(setWithin, next)}
        />
      </div>
      <ul
        id={`${baseId}-tree`}
        className="lc-open-list"
        role="tree"
        aria-label="Datasets"
        aria-busy={stale || undefined}
        data-stale={stale || undefined}
      >
        {rows.map((row, i) => renderRow(row, 1, i + 1, rows.length))}
      </ul>
      {status && (
        <div
          className="lc-open-status"
          data-tone={status.tone}
          role={status.tone === "danger" ? "alert" : undefined}
        >
          <p className="lc-open-status-title">{status.title}</p>
          {status.text && <p className="lc-open-status-text">{status.text}</p>}
        </div>
      )}
      <p className="lc-open-announce" role="status">
        {stale ? "" : status ? status.title : announce(listingCount, search.outsideScope)}
      </p>
      {ticked.length > 0 && (
        <div className="lc-open-selection" role="group" aria-label="Ticked datasets">
          <div className="lc-open-selection-text">
            <span title={ticked.map((choice) => choice.title ?? choice.url).join("\n")}>
              {plural(ticked.length, "dataset")} ticked
            </span>
            <UnstyledButton
              className="lc-open-selection-clear"
              preventFocusOnPress
              onPress={() => {
                setTicked([]);
                setRefused(false);
              }}
            >
              Clear
            </UnstyledButton>
            {refused && (
              <span className="lc-open-selection-note" role="alert">
                {formatCount(limit)} at most: no view layout holds more
              </span>
            )}
          </div>
          <div className="lc-open-selection-actions">
            {/* A phone has no Mod key, so the other action needs a button of its own. */}
            {secondary && (
              <Button size="sm" onPress={() => open(ticked, true)}>
                {secondary.label}
              </Button>
            )}
            <Button size="sm" variant="primary" onPress={() => open(ticked, false)}>
              {primary.label}
            </Button>
          </div>
        </div>
      )}
      {!coarse && (
        <footer className="lc-open-keys">
          <span>
            <Kbd keys="ArrowRight" /> Expand
          </span>
          <span>
            <Kbd keys="Space" /> Tick
          </span>
          <span>
            <Kbd keys="Enter" /> {primary.label}
          </span>
          {secondary && (
            <span>
              <Kbd keys="Mod+Enter" /> {secondary.label}
            </span>
          )}
        </footer>
      )}
    </div>
  );
}

function announce(listingCount: number, outsideScope: number): string {
  const listed = plural(listingCount, "dataset");
  return outsideScope > 0 ? `${listed}, ${formatCount(outsideScope)} more in everyone's` : listed;
}

function rowDisabled(row: OpenRow, stale: boolean): boolean {
  if (row.type === "location") return choiceOf(row) === null;
  return stale && row.type === "listing";
}

/** What a listing is; `withGroup` names its group too, for a row outside it. */
function listingMeta(listing: Listing, withGroup: boolean): string {
  const parts: string[] = [];
  if (withGroup && listing.group) parts.push(`${listing.group.noun}: ${listing.group.label}`);
  parts.push(listing.kind === "collection" ? "Collection" : "Image");
  if (listing.kind === "collection" && listing.tiles !== null) parts.push(plural(listing.tiles, "tile"));
  for (const field of listing.fields) parts.push(`${field.name}: ${field.value}`);
  return parts.join(" · ");
}

function rowContent(row: Exclude<OpenRow, GroupRow>, loadingMore: boolean): ReactNode {
  switch (row.type) {
    case "location": {
      const Icon = row.problem ? WarningCircleIcon : ArrowSquareInIcon;
      const named = row.title ?? row.url ?? row.raw;
      return (
        <>
          <Icon className="lc-open-icon" size={16} aria-hidden data-tone={row.problem ? "danger" : undefined} />
          <span className="lc-open-text">
            <span className="lc-open-title">Open {named}</span>
            {row.problem ? (
              <span className="lc-open-meta" data-tone="danger">
                {row.problem}
              </span>
            ) : row.url === null ? (
              <span className="lc-open-meta">Checking…</span>
            ) : (
              row.title && (
                <span className="lc-open-meta lc-open-url">
                  <span dir="ltr">{row.url}</span>
                </span>
              )
            )}
          </span>
        </>
      );
    }
    case "listing":
      return listingContent(row.listing, false);
    case "recent": {
      const { recent } = row;
      // Out of its group here, so a listed one says which group it is from.
      if (recent.listing) return listingContent(recent.listing, true);
      const Icon = isRemoteDatasetUrl(recent.url) ? CloudIcon : FolderIcon;
      return (
        <>
          <Icon className="lc-open-icon" size={16} aria-hidden />
          <span className="lc-open-text">
            <span className="lc-open-title">{recent.name}</span>
            <span className="lc-open-meta lc-open-url" title={recent.url}>
              <span dir="ltr">{recent.url}</span>
            </span>
          </span>
        </>
      );
    }
    case "more":
      return <span className="lc-open-title lc-open-more">{loadingMore ? "Loading more…" : "Show more"}</span>;
    case "everyone":
      return (
        <>
          <UsersThreeIcon className="lc-open-icon" size={16} aria-hidden />
          <span className="lc-open-text">
            <span className="lc-open-title lc-open-more">
              {formatCount(row.count)} {row.mineAbove ? "more " : ""}in everyone's
            </span>
            {!row.mineAbove && <span className="lc-open-meta">None of the matches are yours</span>}
          </span>
        </>
      );
  }
}

function listingContent(listing: Listing, withGroup: boolean): ReactNode {
  const Icon = listing.kind === "collection" ? SquaresFourIcon : ImageSquareIcon;
  return (
    <>
      <Icon className="lc-open-icon" size={16} aria-hidden />
      <span className="lc-open-text">
        <span className="lc-open-title" title={listing.url}>
          {listing.title}
        </span>
        <span className="lc-open-meta">{listingMeta(listing, withGroup)}</span>
      </span>
      {listing.date && (
        <time className="lc-open-aside" dateTime={listing.date} title={new Date(listing.date).toLocaleString()}>
          {relativeTimeFromIso(listing.date)}
        </time>
      )}
    </>
  );
}

interface Status {
  title: string;
  text?: string;
  tone?: "danger";
}

/** What the list says when it has nothing to show, or the search failed. */
function describeStatus({
  query,
  stale,
  error,
  listingCount,
  hasRecents,
  location,
  outside,
  filtered,
}: {
  query: string;
  stale: boolean;
  error: string | null;
  listingCount: number;
  hasRecents: boolean;
  location: boolean;
  /** Some matches are someone else's, and a row offers them. */
  outside: boolean;
  /** A kind or date chip is on. */
  filtered: boolean;
}): Status | null {
  if (stale) return null;
  if (error) return { title: "Couldn't search the datasets", text: error, tone: "danger" };
  if (listingCount > 0 || location || outside) return null;
  if (filtered) {
    return {
      title: query ? `No datasets of that kind or date match “${query}”` : "No datasets of that kind or date",
      text: "Turn a filter off to see more.",
    };
  }
  if (query) {
    return {
      title: `No datasets match “${query}”`,
      text: "Search looks at names, folders, and the end of each dataset's path. A dataset that isn't listed opens from its path or URL.",
    };
  }
  if (hasRecents) return null;
  // The server lists its sources in the background after it starts, so an
  // empty list may only mean it hasn't finished yet.
  return {
    title: "No datasets are listed yet",
    text: "The server lists the datasets it can find, which can take a little while after it starts. Paste a path or URL to open one now.",
  };
}
