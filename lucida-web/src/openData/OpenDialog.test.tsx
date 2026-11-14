// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import initWasm from "lucida-core";
import { useState } from "react";
import { __resetPreferencesForTesting, PREFERENCES_STORAGE_KEY } from "../theme/preferences.ts";
import { VIEWPORT_MEDIA } from "../theme/viewport.ts";
import { Button } from "../ui/Button.tsx";
import { __resetCommandsForTesting, listCommands, runCommand } from "../ui/commands.ts";
import { __resetShortcutsForTesting, listShortcuts } from "../ui/shortcuts.ts";
import { AddDataPrompt } from "./AddDataPrompt.tsx";
import { fakeListingsApi, folder, listing, type FakeListingsApi } from "./fakeListingsApi.ts";
import { OpenDialog, type OpenAction } from "./OpenDialog.tsx";
import { OPEN_DATA_SHORTCUT } from "./shortcut.ts";

// The test loads the wasm build itself, from bytes, in beforeAll.
vi.mock("../wasmInit.ts", () => ({
  initWasmOnce: () => Promise.resolve(),
}));

const runs = folder("/srv/data/runs");
const archive = folder("/srv/data/archive");
const LISTINGS = [
  listing("/srv/data/runs/volume.ome.zarr", { group: runs, date: "2026-11-06T00:00:00Z" }),
  listing("/srv/data/runs/tiles.ome.zarr", { group: runs, kind: "collection", tiles: 12 }),
  listing("/srv/data/archive/old-volume.ome.zarr", { title: "Old volume", group: archive }),
  listing("/srv/data/loose.ome.zarr"),
];

const MOD = /mac/i.test(navigator.platform) ? "Meta" : "Control";

let api: FakeListingsApi;
let originalFetch: typeof globalThis.fetch;

beforeAll(async () => {
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
  originalFetch = globalThis.fetch;
  api = fakeListingsApi(LISTINGS);
  globalThis.fetch = api.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  __resetShortcutsForTesting();
  __resetCommandsForTesting();
});

function Harness({ primary, secondary }: { primary: OpenAction; secondary?: OpenAction }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)}>Open</Button>
      <OpenDialog isOpen={open} onOpenChange={setOpen} primary={primary} secondary={secondary} />
    </>
  );
}

/** The two actions inside a workspace: add, or open in a new workspace. */
function inWorkspace() {
  const add = vi.fn();
  const elsewhere = vi.fn();
  render(
    <Harness
      primary={{ label: "Add to this workspace", run: add }}
      secondary={{ label: "Open in a new workspace", run: elsewhere }}
    />,
  );
  return { add, elsewhere };
}

/** The one action on the dashboard: open in a new workspace. */
function onDashboard() {
  const open = vi.fn();
  render(<Harness primary={{ label: "Open in a new workspace", run: open }} />);
  return { open };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open" }));
  const dialog = await screen.findByRole("dialog", { name: "Open data" });
  // happy-dom leaves focus on the dialog; a browser puts it in the field.
  await user.click(within(dialog).getByRole("combobox"));
  return dialog;
}

function tree(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("tree", { name: "Datasets" });
}

function activeRow(dialog: HTMLElement): HTMLElement {
  const id = within(dialog).getByRole("combobox").getAttribute("aria-activedescendant");
  const row = id ? document.getElementById(id) : null;
  if (!row) throw new Error("no active row");
  return row;
}

/** The visible text of each top-level row, and of each child under its group. */
function outline(dialog: HTMLElement): string[] {
  const lines: string[] = [];
  const walk = (list: HTMLElement, depth: number) => {
    for (const item of list.querySelectorAll<HTMLElement>(":scope > [role=treeitem]")) {
      const row = item.firstElementChild as HTMLElement;
      const title = row.querySelector(".lc-open-title")?.textContent ?? "";
      lines.push(`${"  ".repeat(depth)}${title}`);
      const group = item.querySelector<HTMLElement>(":scope > [role=group]");
      if (group) walk(group, depth + 1);
    }
  };
  walk(tree(dialog), 0);
  return lines;
}

function status(dialog: HTMLElement): string {
  return dialog.querySelector(".lc-open-status")?.textContent ?? "";
}

async function settled(dialog: HTMLElement) {
  await waitFor(() => expect(tree(dialog).getAttribute("aria-busy")).toBeNull());
}

describe("OpenDialog", () => {
  it("shows every listing grouped, with each one's kind and a collection's tile count", async () => {
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await settled(dialog);
    expect(outline(dialog)).toEqual([
      "runs",
      "  volume.ome.zarr",
      "  tiles.ome.zarr",
      "archive",
      "  Old volume",
      "loose.ome.zarr",
    ]);
    expect(within(tree(dialog)).getByText("Collection · 12 tiles")).toBeTruthy();
    expect(within(tree(dialog)).getAllByText("Image")).toHaveLength(3);
    expect(within(tree(dialog)).getByText("Folder · 2 datasets")).toBeTruthy();
  });

  it("searches as you type and shows the server's groups", async () => {
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await user.keyboard("volume");
    await waitFor(() => expect(api.queries.at(-1)).toBe("volume"));
    await settled(dialog);
    expect(outline(dialog)).toEqual(["runs", "  volume.ome.zarr", "archive", "  Old volume"]);
  });

  it("starts a group whose label matched collapsed, and expands and collapses it", async () => {
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await user.keyboard("runs");
    await waitFor(() => expect(api.queries.at(-1)).toBe("runs"));
    await settled(dialog);
    expect(outline(dialog)).toEqual(["runs"]);
    const group = within(tree(dialog)).getByRole("treeitem", { name: "Folder runs" });
    expect(group.getAttribute("aria-expanded")).toBe("false");

    await user.click(group.firstElementChild as HTMLElement);
    expect(outline(dialog)).toEqual(["runs", "  volume.ome.zarr", "  tiles.ome.zarr"]);
    await user.click(group.firstElementChild as HTMLElement);
    expect(outline(dialog)).toEqual(["runs"]);
  });

  it("moves, expands and collapses from the keyboard alone", async () => {
    const user = userEvent.setup();
    const { add } = inWorkspace();
    const dialog = await openDialog(user);
    await user.keyboard("runs");
    await waitFor(() => expect(api.queries.at(-1)).toBe("runs"));
    await settled(dialog);

    // The caret sits at the end of what was typed, so Right is free to expand.
    expect(activeRow(dialog).getAttribute("aria-label")).toBe("Folder runs");
    await user.keyboard("{ArrowRight}");
    expect(activeRow(dialog).getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowRight}");
    expect(activeRow(dialog).textContent).toContain("volume.ome.zarr");
    await user.keyboard("{ArrowDown}");
    expect(activeRow(dialog).textContent).toContain("tiles.ome.zarr");
    await user.keyboard("{ArrowLeft}");
    expect(activeRow(dialog).getAttribute("aria-label")).toBe("Folder runs");
    await user.keyboard("{ArrowLeft}");
    expect(activeRow(dialog).getAttribute("aria-expanded")).toBe("false");
    expect(outline(dialog)).toEqual(["runs"]);

    await user.keyboard("{ArrowRight}{ArrowDown}{ArrowDown}{Enter}");
    expect(add).toHaveBeenCalledWith([{ url: "/srv/data/runs/tiles.ome.zarr", title: "tiles.ome.zarr", group: runs }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("leaves Left and Right to the caret while you type", async () => {
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await user.keyboard("runs");
    await waitFor(() => expect(api.queries.at(-1)).toBe("runs"));
    await settled(dialog);
    await user.keyboard("{ArrowLeft}{ArrowRight}");
    expect(activeRow(dialog).getAttribute("aria-expanded")).toBe("false");
  });

  it("adds the chosen dataset on Enter inside a workspace", async () => {
    const user = userEvent.setup();
    const { add, elsewhere } = inWorkspace();
    const dialog = await openDialog(user);
    await user.keyboard("old");
    await waitFor(() => expect(api.queries.at(-1)).toBe("old"));
    await settled(dialog);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(add).toHaveBeenCalledWith([{ url: "/srv/data/archive/old-volume.ome.zarr", title: "Old volume", group: archive }]);
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it("opens a new workspace on Mod+Enter inside a workspace", async () => {
    const user = userEvent.setup();
    const { add, elsewhere } = inWorkspace();
    const dialog = await openDialog(user);
    await user.keyboard("old");
    await waitFor(() => expect(api.queries.at(-1)).toBe("old"));
    await settled(dialog);
    await user.keyboard(`{ArrowDown}{${MOD}>}{Enter}{/${MOD}}`);
    expect(elsewhere).toHaveBeenCalledWith([{ url: "/srv/data/archive/old-volume.ome.zarr", title: "Old volume", group: archive }]);
    expect(add).not.toHaveBeenCalled();
  });

  it("opens a new workspace on Enter and on Mod+Enter from the dashboard", async () => {
    const user = userEvent.setup();
    const { open } = onDashboard();
    let dialog = await openDialog(user);
    await user.keyboard("loose");
    await waitFor(() => expect(api.queries.at(-1)).toBe("loose"));
    await settled(dialog);
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenLastCalledWith([{ url: "/srv/data/loose.ome.zarr", title: "loose.ome.zarr", group: null }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await openDialog(user);
    await user.keyboard("loose");
    await waitFor(() => expect(api.queries.at(-1)).toBe("loose"));
    await settled(dialog);
    await user.keyboard(`{${MOD}>}{Enter}{/${MOD}}`);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("opens a listing on a click, and in a new workspace on a Mod-click", async () => {
    const user = userEvent.setup();
    const { add, elsewhere } = inWorkspace();
    let dialog = await openDialog(user);
    await settled(dialog);
    await user.click(within(tree(dialog)).getByText("loose.ome.zarr"));
    expect(add).toHaveBeenCalledWith([{ url: "/srv/data/loose.ome.zarr", title: "loose.ome.zarr", group: null }]);

    dialog = await openDialog(user);
    await settled(dialog);
    await user.keyboard(`{${MOD}>}`);
    await user.click(within(tree(dialog)).getByText("loose.ome.zarr"));
    await user.keyboard(`{/${MOD}}`);
    expect(elsewhere).toHaveBeenCalledWith([{ url: "/srv/data/loose.ome.zarr", title: "loose.ome.zarr", group: null }]);
  });

  it("turns the top row into Open <url> for a pasted URL, with the title a source gives it", async () => {
    const user = userEvent.setup();
    const { open } = onDashboard();
    const dialog = await openDialog(user);
    await user.paste("/srv/data/archive/old-volume.ome.zarr/");
    await waitFor(() => expect(outline(dialog)[0]).toBe("Open Old volume"));
    expect(activeRow(dialog).textContent).toContain("/srv/data/archive/old-volume.ome.zarr");
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenCalledWith([{ url: "/srv/data/archive/old-volume.ome.zarr", title: "Old volume", group: null }]);
  });

  it("opens a pasted URL no source lists, in its canonical form", async () => {
    const user = userEvent.setup();
    const { open } = onDashboard();
    const dialog = await openDialog(user);
    await user.paste("GS://bucket/scans/sample.ome.zarr");
    await waitFor(() => expect(outline(dialog)[0]).toBe("Open gs://bucket/scans/sample.ome.zarr"));
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenCalledWith([{ url: "gs://bucket/scans/sample.ome.zarr", title: null, group: null }]);
  });

  it("explains a malformed URL and opens nothing", async () => {
    const user = userEvent.setup();
    const { open } = onDashboard();
    const dialog = await openDialog(user);
    await user.paste("gs:bucket/sample.zarr");
    const top = await within(tree(dialog)).findByText(/needs :\/\/ after its scheme/);
    expect(top.closest("[role=treeitem]")?.getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{Enter}");
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows the person's recent datasets above the listings while the field is empty", async () => {
    globalThis.fetch = fakeListingsApi(LISTINGS, {
      recent: [
        { url: "/data/earlier.zarr", name: "earlier.zarr" },
        { url: "/srv/data/archive/old-volume.ome.zarr", name: "old-volume.ome.zarr" },
      ],
    }).fetch;
    const user = userEvent.setup();
    const { open } = onDashboard();
    const dialog = await openDialog(user);
    await waitFor(() => expect(outline(dialog)[0]).toBe("Recent"));
    await settled(dialog);
    expect(outline(dialog).slice(0, 4)).toEqual(["Recent", "  earlier.zarr", "  Old volume", "runs"]);
    // One no source lists shows where it lives; a listed one shows its listing and group.
    const [recents] = within(tree(dialog)).getAllByRole("group");
    expect(within(recents).getByText("/data/earlier.zarr")).toBeTruthy();
    expect(within(recents).getByText("Folder: archive · Image")).toBeTruthy();

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(open).toHaveBeenCalledWith([{ url: "/srv/data/archive/old-volume.ome.zarr", title: "Old volume", group: archive }]);

    const again = await openDialog(user);
    await waitFor(() => expect(outline(again)[0]).toBe("Recent"));
    await user.click(within(tree(again)).getByText("earlier.zarr"));
    expect(open).toHaveBeenLastCalledWith([{ url: "/data/earlier.zarr", title: "earlier.zarr", group: null }]);
  });

  it("hides the recent datasets once something is typed", async () => {
    globalThis.fetch = fakeListingsApi(LISTINGS, {
      recent: [{ url: "/data/earlier.zarr", name: "earlier.zarr" }],
    }).fetch;
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await waitFor(() => expect(outline(dialog)[0]).toBe("Recent"));
    await user.keyboard("runs");
    await settled(dialog);
    expect(outline(dialog)).not.toContain("Recent");
  });

  it("ignores the recent list an older build kept in this browser", async () => {
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, values: { "addData.recent": ["/data/kept-here.zarr"] } }),
    );
    __resetPreferencesForTesting();
    globalThis.fetch = fakeListingsApi(LISTINGS, {
      recent: [{ url: "/data/earlier.zarr", name: "earlier.zarr" }],
    }).fetch;
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await waitFor(() => expect(outline(dialog)[0]).toBe("Recent"));
    await settled(dialog);
    expect(outline(dialog).slice(0, 3)).toEqual(["Recent", "  earlier.zarr", "runs"]);
    expect(within(dialog).queryByText(/kept-here/)).toBeNull();
  });

  it("searches as usual when the recent datasets can't be read", async () => {
    const listingsOnly = fakeListingsApi(LISTINGS).fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("/api/listings/recent")
        ? new Response(JSON.stringify({ error: "workspace_store_error" }), { status: 500 })
        : listingsOnly(input, init)) as typeof globalThis.fetch;
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await settled(dialog);
    await waitFor(() => expect(outline(dialog)[0]).toBe("runs"));
    expect(outline(dialog)).not.toContain("Recent");
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("says plainly when nothing is listed yet, and when nothing matches", async () => {
    globalThis.fetch = fakeListingsApi([]).fetch;
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await waitFor(() => expect(status(dialog)).toContain("No datasets are listed yet"));
    expect(within(dialog).queryByRole("alert")).toBeNull();

    await user.keyboard("nothing");
    await waitFor(() => expect(status(dialog)).toContain("No datasets match “nothing”"));
  });

  it("never opens results that answer an earlier query", async () => {
    const user = userEvent.setup();
    const { open } = onDashboard();
    const dialog = await openDialog(user);
    await settled(dialog);
    const release = api.hold();
    await user.keyboard("archive");
    await user.keyboard("{Enter}");
    expect(open).not.toHaveBeenCalled();
    expect(tree(dialog).getAttribute("aria-busy")).toBe("true");
    release();
    await settled(dialog);
  });

  it("loads the next page on Show more", async () => {
    globalThis.fetch = fakeListingsApi(LISTINGS, { pageSize: 2 }).fetch;
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await settled(dialog);
    expect(outline(dialog).filter((line) => !line.startsWith(" "))).toEqual(["runs", "archive", "Show more"]);
    await user.click(within(tree(dialog)).getByText("Show more"));
    await waitFor(() =>
      expect(outline(dialog).filter((line) => !line.startsWith(" "))).toEqual(["runs", "archive", "loose.ome.zarr"]),
    );
  });

  it("shows why a search failed", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "internal", detail: "the index is unavailable" }), {
        status: 500,
      })) as typeof globalThis.fetch;
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("the index is unavailable");
  });

  it("closes on Escape and returns focus to the control that opened it", async () => {
    const user = userEvent.setup();
    onDashboard();
    await openDialog(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" }));
  });

  it("opens from Mod+O and from a palette command that carries the same key", async () => {
    const user = userEvent.setup();
    onDashboard();
    expect(listCommands().find((c) => c.id === "data.open")?.label).toBe("Open data…");
    expect(listShortcuts().find((s) => s.id === "data.open")?.keys).toEqual([OPEN_DATA_SHORTCUT]);
    await user.keyboard(`{${MOD}>}o{/${MOD}}`);
    expect(await screen.findByRole("dialog", { name: "Open data" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => {
      runCommand("data.open");
    });
    expect(await screen.findByRole("dialog", { name: "Open data" })).toBeTruthy();
  });
});

describe("OpenDialog ticks", () => {
  const VOLUME = { url: "/srv/data/runs/volume.ome.zarr", title: "volume.ome.zarr", group: runs };
  const TILES = { url: "/srv/data/runs/tiles.ome.zarr", title: "tiles.ome.zarr", group: runs };
  const OLD = { url: "/srv/data/archive/old-volume.ome.zarr", title: "Old volume", group: archive };

  function tickBox(dialog: HTMLElement, title: string): HTMLElement {
    return within(dialog).getByRole("button", { name: `Tick ${title}` });
  }

  function bar(dialog: HTMLElement): HTMLElement | null {
    return within(dialog).queryByRole("group", { name: "Ticked datasets" });
  }

  function groupRow(dialog: HTMLElement, name: string): HTMLElement {
    return within(tree(dialog)).getByRole("treeitem", { name });
  }

  it("ticks without opening, keeps ticks across searches, and opens them together on Enter", async () => {
    const user = userEvent.setup();
    const { add, elsewhere } = inWorkspace();
    const dialog = await openDialog(user);
    await settled(dialog);
    expect(bar(dialog)).toBeNull();

    await user.click(tickBox(dialog, "volume.ome.zarr"));
    expect(tickBox(dialog, "volume.ome.zarr").getAttribute("aria-pressed")).toBe("true");
    expect(tickBox(dialog, "volume.ome.zarr").closest("[role=treeitem]")?.getAttribute("aria-checked")).toBe("true");
    expect(add).not.toHaveBeenCalled();

    await user.keyboard("old");
    await waitFor(() => expect(api.queries.at(-1)).toBe("old"));
    await settled(dialog);
    await user.click(tickBox(dialog, "Old volume"));
    expect(bar(dialog)?.textContent).toContain("2 datasets ticked");

    await user.keyboard("{Enter}");
    expect(add).toHaveBeenCalledExactlyOnceWith([VOLUME, OLD]);
    expect(elsewhere).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the ticks in a new workspace on Mod+Enter", async () => {
    const user = userEvent.setup();
    const { add, elsewhere } = inWorkspace();
    const dialog = await openDialog(user);
    await settled(dialog);
    await user.click(tickBox(dialog, "tiles.ome.zarr"));
    await user.click(tickBox(dialog, "volume.ome.zarr"));
    await user.keyboard(`{${MOD}>}{Enter}{/${MOD}}`);
    // In the order they were ticked.
    expect(elsewhere).toHaveBeenCalledExactlyOnceWith([TILES, VOLUME]);
    expect(add).not.toHaveBeenCalled();
  });

  it("ticks from the keyboard with Space once arrowed onto a row, and leaves a typed space to the words", async () => {
    const user = userEvent.setup();
    const { elsewhere } = inWorkspace();
    const dialog = await openDialog(user);
    await user.keyboard("volume ");
    expect(within(dialog).getByRole("combobox")).toHaveProperty("value", "volume ");
    await waitFor(() => expect(api.queries.at(-1)).toBe("volume"));
    await settled(dialog);
    expect(bar(dialog)).toBeNull();

    await user.keyboard("{ArrowDown} ");
    expect(activeRow(dialog).getAttribute("aria-checked")).toBe("true");
    await user.keyboard(" ");
    expect(activeRow(dialog).getAttribute("aria-checked")).toBe("false");
    await user.keyboard(` {${MOD}>}{Enter}{/${MOD}}`);
    expect(elsewhere).toHaveBeenCalledExactlyOnceWith([VOLUME]);
  });

  it("refuses a fifth tick with a note, and takes one again once another is unticked", async () => {
    const shelf = folder("/srv/data/shelf");
    const five = ["a", "b", "c", "d", "e"].map((name) => listing(`/srv/data/shelf/${name}.ome.zarr`, { group: shelf }));
    globalThis.fetch = fakeListingsApi(five).fetch;
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await settled(dialog);

    for (const name of ["a", "b", "c", "d"]) await user.click(tickBox(dialog, `${name}.ome.zarr`));
    expect(bar(dialog)?.textContent).toContain("4 datasets ticked");
    expect(within(dialog).queryByRole("alert")).toBeNull();

    await user.click(tickBox(dialog, "e.ome.zarr"));
    expect(tickBox(dialog, "e.ome.zarr").getAttribute("aria-pressed")).toBe("false");
    expect(bar(dialog)?.textContent).toContain("4 datasets ticked");
    expect(within(dialog).getByRole("alert").textContent).toBe("4 at most: no view layout holds more");

    await user.click(tickBox(dialog, "a.ome.zarr"));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.click(tickBox(dialog, "e.ome.zarr"));
    expect(tickBox(dialog, "e.ome.zarr").getAttribute("aria-pressed")).toBe("true");
    // Five is more than a group may hold to open whole.
    expect(within(groupRow(dialog, "Folder shelf")).queryByRole("button", { name: "Open folder" })).toBeNull();
  });

  it("holds a phone to two, the most its view layouts hold", async () => {
    const shelf = folder("/srv/data/shelf");
    const three = ["a", "b", "c"].map((name) => listing(`/srv/data/shelf/${name}.ome.zarr`, { group: shelf }));
    globalThis.fetch = fakeListingsApi([...LISTINGS, ...three]).fetch;
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      query === VIEWPORT_MEDIA.phone
        ? { matches: true, addEventListener: () => {}, removeEventListener: () => {} }
        : realMatchMedia(query)) as unknown as typeof window.matchMedia;
    try {
      const user = userEvent.setup();
      onDashboard();
      const dialog = await openDialog(user);
      await settled(dialog);
      expect(within(groupRow(dialog, "Folder runs")).getByRole("button", { name: "Open folder" })).toBeTruthy();
      expect(within(groupRow(dialog, "Folder shelf")).queryByRole("button", { name: "Open folder" })).toBeNull();

      await user.click(tickBox(dialog, "a.ome.zarr"));
      await user.click(tickBox(dialog, "b.ome.zarr"));
      await user.click(tickBox(dialog, "c.ome.zarr"));
      expect(tickBox(dialog, "c.ome.zarr").getAttribute("aria-pressed")).toBe("false");
      expect(bar(dialog)?.textContent).toContain("2 datasets ticked");
      expect(within(dialog).getByRole("alert").textContent).toBe("2 at most: no view layout holds more");
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it("offers Open group, in the source's noun, only for a group the rows hold whole", async () => {
    const user = userEvent.setup();
    const { open } = onDashboard();
    const dialog = await openDialog(user);
    await user.keyboard("volume");
    await waitFor(() => expect(api.queries.at(-1)).toBe("volume"));
    await settled(dialog);
    // Only one of the two datasets in "runs" matched, so it can't open whole.
    expect(within(groupRow(dialog, "Folder runs")).queryByRole("button", { name: "Open folder" })).toBeNull();
    expect(within(groupRow(dialog, "Folder archive")).getByRole("button", { name: "Open folder" })).toBeTruthy();

    await user.clear(within(dialog).getByRole("combobox"));
    await waitFor(() => expect(api.queries.at(-1)).toBe(""));
    await settled(dialog);
    await user.click(within(groupRow(dialog, "Folder runs")).getByRole("button", { name: "Open folder" }));
    expect(open).toHaveBeenCalledExactlyOnceWith([VOLUME, TILES]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens a group in a new workspace on a Mod-click", async () => {
    const user = userEvent.setup();
    const { add, elsewhere } = inWorkspace();
    const dialog = await openDialog(user);
    await settled(dialog);
    await user.keyboard(`{${MOD}>}`);
    await user.click(within(groupRow(dialog, "Folder runs")).getByRole("button", { name: "Open folder" }));
    await user.keyboard(`{/${MOD}}`);
    expect(elsewhere).toHaveBeenCalledExactlyOnceWith([VOLUME, TILES]);
    expect(add).not.toHaveBeenCalled();
  });

  it("gives both actions a button in the selection bar, for a phone without a Mod key, and clears", async () => {
    const user = userEvent.setup();
    const { add, elsewhere } = inWorkspace();
    let dialog = await openDialog(user);
    await settled(dialog);
    await user.click(tickBox(dialog, "volume.ome.zarr"));
    await user.click(within(bar(dialog) as HTMLElement).getByRole("button", { name: "Clear" }));
    expect(bar(dialog)).toBeNull();
    expect(tickBox(dialog, "volume.ome.zarr").getAttribute("aria-pressed")).toBe("false");

    await user.click(tickBox(dialog, "volume.ome.zarr"));
    await user.click(within(bar(dialog) as HTMLElement).getByRole("button", { name: "Open in a new workspace" }));
    expect(elsewhere).toHaveBeenCalledExactlyOnceWith([VOLUME]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Each opening starts with nothing ticked.
    dialog = await openDialog(user);
    await settled(dialog);
    expect(bar(dialog)).toBeNull();
    await user.click(tickBox(dialog, "tiles.ome.zarr"));
    await user.click(within(bar(dialog) as HTMLElement).getByRole("button", { name: "Add to this workspace" }));
    expect(add).toHaveBeenCalledExactlyOnceWith([TILES]);
  });

  describe("on recent datasets", () => {
    const EARLIER = { url: "/data/earlier.zarr", title: "earlier.zarr", group: null };
    const LOOSE = { url: "/srv/data/loose.ome.zarr", title: "loose.ome.zarr", group: null };

    async function withRecents(user: ReturnType<typeof userEvent.setup>) {
      api = fakeListingsApi(LISTINGS, {
        recent: [
          { url: "/data/earlier.zarr", name: "earlier.zarr" },
          // Opened under a spelling its listing drops.
          { url: "/srv/data/archive/old-volume.ome.zarr/", name: "old-volume.ome.zarr" },
        ],
      });
      globalThis.fetch = api.fetch;
      const dialog = await openDialog(user);
      await waitFor(() => expect(outline(dialog)[0]).toBe("Recent"));
      await settled(dialog);
      return dialog;
    }

    /** Whether each "Old volume" row is ticked: the recent one first, then its listing below. */
    function oldVolumeTicks(dialog: HTMLElement): (string | null)[] {
      return within(tree(dialog))
        .getAllByRole("button", { name: "Tick Old volume" })
        .map((box) => box.getAttribute("aria-pressed"));
    }

    it("ticks a recent, listed or not, by Space or a click, as one tick with its listing", async () => {
      const user = userEvent.setup();
      const { add } = inWorkspace();
      const dialog = await withRecents(user);

      await user.keyboard("{ArrowDown}{ArrowDown}");
      expect(activeRow(dialog).textContent).toContain("Old volume");
      await user.keyboard(" ");
      expect(activeRow(dialog).getAttribute("aria-checked")).toBe("true");
      expect(oldVolumeTicks(dialog)).toEqual(["true", "true"]);

      await user.click(tickBox(dialog, "earlier.zarr"));
      expect(tickBox(dialog, "earlier.zarr").getAttribute("aria-pressed")).toBe("true");
      expect(bar(dialog)?.textContent).toContain("2 datasets ticked");
      expect(add).not.toHaveBeenCalled();

      // Unticking the listing unticks the recent, since they are one dataset.
      await user.click(within(tree(dialog)).getAllByRole("button", { name: "Tick Old volume" })[1]);
      expect(oldVolumeTicks(dialog)).toEqual(["false", "false"]);
      expect(bar(dialog)?.textContent).toContain("1 dataset ticked");
    });

    it("counts ticked recents and ticked listings against one limit", async () => {
      const user = userEvent.setup();
      onDashboard();
      const dialog = await withRecents(user);

      await user.click(tickBox(dialog, "earlier.zarr"));
      for (const title of ["volume.ome.zarr", "tiles.ome.zarr", "loose.ome.zarr"]) {
        await user.click(tickBox(dialog, title));
      }
      expect(bar(dialog)?.textContent).toContain("4 datasets ticked");

      await user.click(within(tree(dialog)).getAllByRole("button", { name: "Tick Old volume" })[0]);
      expect(oldVolumeTicks(dialog)).toEqual(["false", "false"]);
      expect(within(dialog).getByRole("alert").textContent).toBe("4 at most: no view layout holds more");

      await user.click(tickBox(dialog, "earlier.zarr"));
      await user.click(within(tree(dialog)).getAllByRole("button", { name: "Tick Old volume" })[0]);
      expect(oldVolumeTicks(dialog)).toEqual(["true", "true"]);
      expect(bar(dialog)?.textContent).toContain("4 datasets ticked");
    });

    it("keeps ticked recents through a search, and opens them with the listings ticked there", async () => {
      const user = userEvent.setup();
      const { add, elsewhere } = inWorkspace();
      const dialog = await withRecents(user);
      const field = within(dialog).getByRole("combobox");

      await user.click(tickBox(dialog, "earlier.zarr"));
      await user.click(within(tree(dialog)).getAllByRole("button", { name: "Tick Old volume" })[0]);

      // A search finds the ticked recent already ticked.
      await user.keyboard("old");
      await waitFor(() => expect(api.queries.at(-1)).toBe("old"));
      await settled(dialog);
      expect(outline(dialog)).toEqual(["archive", "  Old volume"]);
      expect(oldVolumeTicks(dialog)).toEqual(["true"]);

      await user.clear(field);
      await user.keyboard("loose");
      await waitFor(() => expect(api.queries.at(-1)).toBe("loose"));
      await settled(dialog);
      await user.click(tickBox(dialog, "loose.ome.zarr"));
      expect(bar(dialog)?.textContent).toContain("3 datasets ticked");

      await user.clear(field);
      await waitFor(() => expect(api.queries.at(-1)).toBe(""));
      await settled(dialog);
      expect(outline(dialog).slice(0, 3)).toEqual(["Recent", "  earlier.zarr", "  Old volume"]);
      expect(tickBox(dialog, "earlier.zarr").getAttribute("aria-pressed")).toBe("true");
      expect(oldVolumeTicks(dialog)).toEqual(["true", "true"]);

      await user.keyboard("{Enter}");
      expect(add).toHaveBeenCalledExactlyOnceWith([EARLIER, OLD, LOOSE]);
      expect(elsewhere).not.toHaveBeenCalled();
    });
  });
});

describe("OpenDialog scope and filters", () => {
  const now = Date.now();
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const shared = folder("/srv/data/shared");
  const OWNED = [
    listing("/srv/data/shared/mine-new.ome.zarr", { group: shared, owner: "Viewer@Example.com", date: daysAgo(2) }),
    listing("/srv/data/shared/theirs-new.ome.zarr", { group: shared, owner: "someone@example.com", date: daysAgo(3) }),
    listing("/srv/data/shared/mine-grid.ome.zarr", {
      group: shared,
      owner: "viewer@example.com",
      kind: "collection",
      tiles: 4,
      date: daysAgo(20),
    }),
    listing("/srv/data/shared/theirs-old.ome.zarr", { group: shared, owner: "someone@example.com", date: daysAgo(200) }),
    listing("/srv/data/loose.ome.zarr"),
  ];

  function scopeToggle(dialog: HTMLElement): HTMLElement | null {
    return within(dialog).queryByRole("radiogroup", { name: "Whose datasets" });
  }

  function useOwned(options: Parameters<typeof fakeListingsApi>[1] = {}) {
    api = fakeListingsApi(OWNED, options);
    globalThis.fetch = api.fetch;
  }

  it("hides the scope toggle while no listing has an owner", async () => {
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await settled(dialog);
    expect(scopeToggle(dialog)).toBeNull();
    // It asked for the caller's own, and the server answered with everyone's.
    expect(api.searches.at(-1)?.get("scope")).toBe("mine");
    expect(outline(dialog)).toContain("loose.ome.zarr");
  });

  it("hides the scope toggle when callers aren't signed in", async () => {
    useOwned({ me: null });
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await settled(dialog);
    expect(scopeToggle(dialog)).toBeNull();
    expect(outline(dialog)).toHaveLength(6);
    expect(outline(dialog).join("\n")).not.toContain("everyone's");
  });

  it("starts on Mine, offers the rest once Mine runs out, and shows everyone's on Everyone", async () => {
    useOwned();
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await settled(dialog);
    const toggle = scopeToggle(dialog) as HTMLElement;
    expect(within(toggle).getByRole("radio", { name: "Mine" }).getAttribute("aria-checked")).toBe("true");
    expect(outline(dialog)).toEqual([
      "shared",
      "  mine-new.ome.zarr",
      "  mine-grid.ome.zarr",
      "3 more in everyone's",
    ]);

    await user.click(within(toggle).getByRole("radio", { name: "Everyone" }));
    await settled(dialog);
    expect(api.searches.at(-1)?.get("scope")).toBe("everyone");
    expect(outline(dialog)).toEqual([
      "shared",
      "  mine-new.ome.zarr",
      "  theirs-new.ome.zarr",
      "  mine-grid.ome.zarr",
      "  theirs-old.ome.zarr",
      "loose.ome.zarr",
    ]);
    // Pressing the toggle leaves the field in charge of the list.
    expect(document.activeElement).toBe(within(dialog).getByRole("combobox"));
  });

  it("switches to Everyone from the line that offers the rest", async () => {
    useOwned();
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await user.keyboard("theirs");
    await waitFor(() => expect(api.queries.at(-1)).toBe("theirs"));
    await settled(dialog);
    expect(outline(dialog)).toEqual(["2 in everyone's"]);
    expect(within(tree(dialog)).getByText("None of the matches are yours")).toBeTruthy();
    expect(status(dialog)).toBe("");

    await user.keyboard("{Enter}");
    await settled(dialog);
    expect(outline(dialog)).toEqual(["shared", "  theirs-new.ome.zarr", "  theirs-old.ome.zarr"]);
    const toggle = scopeToggle(dialog) as HTMLElement;
    expect(within(toggle).getByRole("radio", { name: "Everyone" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows no line for the rest when every match is the caller's own", async () => {
    useOwned();
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await user.keyboard("mine");
    await waitFor(() => expect(api.queries.at(-1)).toBe("mine"));
    await settled(dialog);
    expect(outline(dialog)).toEqual(["shared", "  mine-new.ome.zarr", "  mine-grid.ome.zarr"]);
  });

  it("narrows by kind and date with chips, along with the words and the scope", async () => {
    useOwned();
    const user = userEvent.setup();
    onDashboard();
    const dialog = await openDialog(user);
    await settled(dialog);
    const chip = (name: string) => within(dialog).getByRole("radio", { name });

    await user.click(chip("Collections"));
    await settled(dialog);
    expect(api.searches.at(-1)?.get("kind")).toBe("collection");
    expect(outline(dialog)).toEqual(["shared", "  mine-grid.ome.zarr"]);
    // Pressed again, a chip turns off.
    await user.click(chip("Collections"));
    await settled(dialog);
    expect(api.searches.at(-1)?.has("kind")).toBe(false);

    await user.click(chip("Last 7 days"));
    await settled(dialog);
    const since = Date.parse(api.searches.at(-1)?.get("since") ?? "");
    expect(Math.abs(since - (Date.now() - 7 * 86_400_000))).toBeLessThan(60_000);
    expect(outline(dialog)).toEqual(["shared", "  mine-new.ome.zarr", "1 more in everyone's"]);

    await user.click(chip("Last 30 days"));
    await user.keyboard("grid");
    await waitFor(() => expect(api.queries.at(-1)).toBe("grid"));
    await settled(dialog);
    expect(api.searches.at(-1)?.get("scope")).toBe("mine");
    expect(outline(dialog)).toEqual(["shared", "  mine-grid.ome.zarr"]);

    await user.click(chip("Images"));
    await settled(dialog);
    expect(outline(dialog)).toEqual([]);
    expect(status(dialog)).toContain("No datasets of that kind or date match “grid”");
  });
});

describe("AddDataPrompt", () => {
  it("offers the dialog from an empty workspace", async () => {
    const user = userEvent.setup();
    const onAddData = vi.fn();
    render(<AddDataPrompt onAddData={onAddData} />);
    expect(screen.getByText("Add data to get started")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add data" }));
    expect(onAddData).toHaveBeenCalled();
  });
});
