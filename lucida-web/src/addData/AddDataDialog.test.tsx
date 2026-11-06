// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import initWasm from "lucida-core";
import { useState } from "react";
import { __resetPreferencesForTesting, getPreference } from "../theme/preferences.ts";
import { Button } from "../ui/Button.tsx";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";
import { AddDataDialog } from "./AddDataDialog.tsx";
import { AddDataPrompt } from "./AddDataPrompt.tsx";
import {
  __resetRecentSourcesForTesting,
  recentSourcesPreference,
  rememberRecentSource,
} from "./recentSources.ts";

interface Listing {
  path: string;
  entries: { name: string; type: "directory" | "file" }[];
}

const listings: Record<string, Listing> = {
  "": { path: "/", entries: [{ name: "data", type: "directory" }] },
  "/data": {
    path: "/data",
    entries: [
      { name: "volume.zarr", type: "directory" },
      { name: "notes.txt", type: "file" },
    ],
  },
  "/data/volume.zarr": { path: "/data/volume.zarr", entries: [{ name: "zarr.json", type: "file" }] },
};

let originalFetch: typeof globalThis.fetch;

beforeAll(async () => {
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  __resetPreferencesForTesting();
  __resetRecentSourcesForTesting();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const path = new URL(input, "http://localhost").searchParams.get("path") ?? "";
    return new Response(JSON.stringify(listings[path] ?? { path, entries: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  __resetShortcutsForTesting();
});

function Harness({ onOpen }: { onOpen: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)}>Add</Button>
      <AddDataDialog isOpen={open} onOpenChange={setOpen} onOpen={onOpen} />
    </>
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add" }));
  return screen.findByRole("dialog", { name: "Add data" });
}

describe("AddDataDialog", () => {
  it("opens a typed absolute path in its canonical form, closes, and remembers it", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    const dialog = await openDialog(user);
    // happy-dom leaves focus on the dialog; a browser puts it in the field.
    await user.click(within(dialog).getByRole("textbox", { name: "Dataset path or URL" }));
    await user.keyboard("C:\\data\\volume.zarr{Enter}");
    expect(onOpen).toHaveBeenCalledWith("c:/data/volume.zarr");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(getPreference(recentSourcesPreference)).toEqual(["c:/data/volume.zarr"]);
  });

  it("opens a remote URL", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Dataset path or URL" }), "gs://bucket/volume.zarr");
    await user.click(within(dialog).getAllByRole("button", { name: "Open" })[0]);
    expect(onOpen).toHaveBeenCalledWith("gs://bucket/volume.zarr");
  });

  it("explains a relative path and opens nothing", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("textbox", { name: "Dataset path or URL" }));
    await user.keyboard("data/volume.zarr{Enter}");
    expect(onOpen).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/This path is relative\. Enter the full path from the root/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(getPreference(recentSourcesPreference)).toEqual([]);
  });

  it("opens a recent dataset", async () => {
    rememberRecentSource("/data/earlier.zarr");
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    const dialog = await openDialog(user);
    const recent = within(dialog).getByRole("region", { name: "Recent" });
    await user.click(within(recent).getByText("earlier.zarr"));
    expect(onOpen).toHaveBeenCalledWith("/data/earlier.zarr");
  });

  it("opens the dataset folder reached in the file browser", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    const dialog = await openDialog(user);
    const browse = within(dialog).getByRole("region", { name: "Browse files" });
    await user.click(await within(browse).findByText("data"));
    await user.click(await within(browse).findByText("volume.zarr"));
    await within(browse).findByText("Dataset found");
    await user.click(within(browse).getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith("/data/volume.zarr");
  });

  it("closes on Escape and returns focus to the control that opened it", async () => {
    const user = userEvent.setup();
    render(<Harness onOpen={() => {}} />);
    await openDialog(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
  });

  it("opens from Ctrl or Cmd O", async () => {
    const user = userEvent.setup();
    render(<Harness onOpen={() => {}} />);
    const mod = /mac/i.test(navigator.platform) ? "Meta" : "Control";
    await user.keyboard(`{${mod}>}o{/${mod}}`);
    expect(await screen.findByRole("dialog", { name: "Add data" })).toBeTruthy();
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
