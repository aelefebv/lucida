// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decode } from "../savedView/encoder.ts";
import { SAVED_VIEW_VERSION, type SavedView } from "../savedView/types.ts";
import { ToastRegion } from "../ui/Toast.tsx";
import { toastQueue } from "../ui/toastQueue.ts";
import type { WorkspaceSharingSettings } from "../workspaceApi.ts";
import { ShareButton } from "./ShareButton.tsx";
import { viewLinkCaveats } from "./viewLink.ts";
import { loadWasm } from "../viewProperties.ts";

// The local-path classifier is stubbed; the URL codec is the real one.
vi.mock("lucida-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucida-core")>();
  return {
    initSync: actual.initSync,
    encode_view_payload: actual.encode_view_payload,
    decode_view_payload: actual.decode_view_payload,
    is_local_dataset_url: (url: string) => url.startsWith("/"),
  };
});

beforeAll(() => loadWasm());

function viewOf(datasets: string[]): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets,
    active_layouts: {},
    camera: { mode: "slice", center: [0, 0], zoom: 1, viewport: [800, 600] },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1 },
    dataset_order: [],
    dataset_settings: {},
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let sharing: WorkspaceSharingSettings;
let requests: { method: string; url: string; body?: unknown }[];
let writeText: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  sharing = {
    link_access: "restricted",
    link_role: "viewer",
    members: [{ email: "owner@example.com", role: "owner", display_name: "Owner Person", added_at: "" }],
  };
  requests = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ method, url, body });
    if (url.endsWith("/sharing") && method === "GET") return json(sharing);
    if (url.endsWith("/sharing") && method === "PATCH") {
      sharing = { ...sharing, ...body };
      return json(sharing);
    }
    if (url.endsWith("/members") && method === "POST") {
      if (body.email === "nobody@example.com") return json({ detail: "No such person" }, 400);
      return json({ email: body.email, role: body.role, display_name: "", added_at: "" });
    }
    return json({ detail: "unexpected" }, 500);
  }) as typeof globalThis.fetch;
  writeText = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  toastQueue.clear();
});

// userEvent.setup() installs its own clipboard, so the stub goes in after it.
function setupUser() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return user;
}

function renderShare(canManageAccess: boolean, view: SavedView | null = viewOf(["gs://bucket/a.zarr"])) {
  render(
    <>
      <ShareButton workspaceId="ws-1" canManageAccess={canManageAccess} getCurrentSavedView={() => view} />
      <ToastRegion />
    </>,
  );
}

async function openShare(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Share" }));
  return screen.findByRole("dialog", { name: "Share" });
}

describe("viewLinkCaveats", () => {
  it("names local files and long links, and nothing else", () => {
    expect(viewLinkCaveats("https://host/w/1#view=x", viewOf(["gs://bucket/a.zarr"]))).toEqual([]);
    expect(viewLinkCaveats("https://host/w/1#view=x", null)).toEqual([]);
    const both = viewLinkCaveats(`https://host/w/1#view=${"x".repeat(5000)}`, viewOf(["/data/a.zarr", "/data/b.zarr"]));
    expect(both).toHaveLength(2);
    expect(both[0]).toMatch(/2 local files/);
    expect(both[1]).toMatch(/long/);
  });
});

describe("ShareButton", () => {
  it("copies a link to the current view, closes, and confirms with a toast", async () => {
    const user = setupUser();
    const view = viewOf(["gs://bucket/a.zarr"]);
    view.camera = { mode: "slice", center: [12, 34], zoom: 2, viewport: [800, 600] };
    renderShare(false, view);
    const popover = await openShare(user);
    await user.click(within(popover).getByRole("button", { name: "Copy link to this view" }));

    // The view itself, not whatever the address bar holds.
    expect(writeText).toHaveBeenCalledTimes(1);
    const [link] = writeText.mock.calls[0] as [string];
    const [page, payload] = link.split("#view=");
    expect(page).toBe(`${location.origin}${location.pathname}${location.search}`);
    expect((await decode(payload)).camera).toEqual(view.camera);
    expect(await screen.findByText("Link copied")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share" })).toBeNull());
  });

  it("warns in the same toast when the link opens local files", async () => {
    const user = setupUser();
    renderShare(false, viewOf(["/data/a.zarr"]));
    const popover = await openShare(user);
    await user.click(within(popover).getByRole("button", { name: "Copy link to this view" }));
    expect(await screen.findByText(/opens a local file/)).toBeTruthy();
  });

  it("says so when the copy fails", async () => {
    writeText.mockRejectedValue(new Error("Denied"));
    const user = setupUser();
    renderShare(false);
    const popover = await openShare(user);
    await user.click(within(popover).getByRole("button", { name: "Copy link to this view" }));
    expect(await screen.findByText("Couldn't copy the link")).toBeTruthy();
    expect(screen.getByText("Denied")).toBeTruthy();
  });

  it("offers no access controls to someone who can't manage them, and doesn't ask the server", async () => {
    const user = setupUser();
    renderShare(false);
    const popover = await openShare(user);
    expect(within(popover).getByText("Only the owner can change who has access")).toBeTruthy();
    expect(within(popover).queryByRole("button", { name: /Manage access/ })).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("shows an owner the link access and opens Manage access from it", async () => {
    sharing = { ...sharing, link_access: "anyone_with_link", link_role: "editor" };
    const user = setupUser();
    renderShare(true);
    const popover = await openShare(user);
    expect(await within(popover).findByText("Anyone with the link can edit")).toBeTruthy();

    await user.click(within(popover).getByRole("button", { name: /Manage access/ }));
    const dialog = await screen.findByRole("dialog", { name: "Manage access" });
    expect(await within(dialog).findByText("Owner Person")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Share" })).toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Manage access" })).toBeNull());
  });
});

describe("WorkspaceSharingDialog", () => {
  async function openManage(user: ReturnType<typeof userEvent.setup>) {
    const popover = await openShare(user);
    await within(popover).findByText("Only people with access");
    await user.click(within(popover).getByRole("button", { name: /Manage access/ }));
    const dialog = await screen.findByRole("dialog", { name: "Manage access" });
    await within(dialog).findByText("Owner Person");
    return dialog;
  }

  // The address goes in as one input event. Typed a key at a time, every
  // keystroke re-renders the dialog, and under parallel load the typing alone
  // outran the test timeout.
  async function submitEmail(user: ReturnType<typeof userEvent.setup>, field: HTMLElement, email: string) {
    await user.click(field);
    await user.paste(email);
    await user.keyboard("{Enter}");
  }

  it("adds a person, and reports a failed add in a toast", async () => {
    const user = setupUser();
    renderShare(true);
    const dialog = await openManage(user);
    const emailField = within(dialog).getByRole("textbox", { name: "Email" });

    await submitEmail(user, emailField, "new@example.com");
    expect(await within(dialog).findByText("new@example.com")).toBeTruthy();
    expect(requests).toContainEqual({
      method: "POST",
      url: "/api/workspaces/ws-1/members",
      body: { email: "new@example.com", role: "viewer" },
    });
    expect((emailField as HTMLInputElement).value).toBe("");

    await submitEmail(user, emailField, "nobody@example.com");
    expect(await screen.findByText("Couldn't add nobody@example.com")).toBeTruthy();
    expect(screen.getByText("No such person")).toBeTruthy();
    expect((emailField as HTMLInputElement).value).toBe("nobody@example.com");
  });

  it("opens the link, and the Share popover's summary follows", async () => {
    const user = setupUser();
    renderShare(true);
    const dialog = await openManage(user);

    await user.click(within(dialog).getByRole("button", { name: /Link access/ }));
    await user.click(await screen.findByRole("option", { name: "Anyone with the link" }));
    expect(await within(dialog).findByText(/Anyone who has the link can open the workspace as a viewer/)).toBeTruthy();
    expect(requests).toContainEqual({
      method: "PATCH",
      url: "/api/workspaces/ws-1/sharing",
      body: { link_access: "anyone_with_link", link_role: "viewer" },
    });

    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: "Done" }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Manage access" })).toBeNull());
    const popover = await openShare(user);
    expect(within(popover).getByText("Anyone with the link can view")).toBeTruthy();
  });
});
