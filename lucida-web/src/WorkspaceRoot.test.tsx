// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkspaceRoot } from "./WorkspaceRoot.tsx";
import { openWorkspace } from "./workspaceApi.ts";

// App pulls in the WASM viewer; stub it so the route renders without a GPU/WASM
// runtime. We only exercise WorkspaceRoot's error (denied/not-found) branch.
vi.mock("./App.tsx", () => ({
  default: () => <div data-testid="app-mounted" />,
}));

vi.mock("./workspaceApi.ts", () => ({
  openWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  updateWorkspaceDefaultSavedView: vi.fn(),
}));

const openWorkspaceMock = vi.mocked(openWorkspace);

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  openWorkspaceMock.mockReset();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  // A workspace route so WorkspaceRoot renders the viewer (not the dashboard).
  window.history.replaceState({}, "", "/w/ws-secret#a=pin-1");
});
afterEach(() => {
  warnSpy.mockRestore();
  cleanup();
});

async function renderRouteAndGetMessage(rejection: Error): Promise<string> {
  openWorkspaceMock.mockRejectedValueOnce(rejection);
  render(<WorkspaceRoot />);
  const el = await screen.findByTestId("workspace-access-message");
  return el.textContent ?? "";
}

// Everything WorkspaceRoot wrote to the console during this render, as one
// string — used to assert the recipient's console never reveals the cause.
function consoleOutput(): string {
  return warnSpy.mock.calls
    .map((args: unknown[]) => args.map(String).join(" "))
    .join("\n");
}

describe("WorkspaceRoot — denied/not-found deep-link UX (slice 3, never-leak)", () => {
  it("renders a friendly access message (not the raw error) on failure", async () => {
    const msg = await renderRouteAndGetMessage(new Error("403 Forbidden"));
    expect(msg).toContain("don’t have access");
    expect(msg).toContain("ask the person who shared it");
    // The raw status is NOT rendered (it would leak existence).
    expect(msg).not.toContain("403");
    expect(msg).not.toContain("Forbidden");
  });

  it("NEVER-LEAK: a 403 (denied) and a 404 (not found) render the SAME message", async () => {
    const denied = await renderRouteAndGetMessage(new Error("403 Forbidden"));
    cleanup();
    const notFound = await renderRouteAndGetMessage(new Error("404 Not Found"));
    expect(denied).toBe(notFound);
    // Neither distinguishes the cause.
    expect(denied).not.toContain("404");
    expect(notFound).not.toContain("403");
  });

  it("offers a way back to the workspaces list (no dead-end, no request-access flow)", async () => {
    await renderRouteAndGetMessage(new Error("403 Forbidden"));
    expect(screen.getByRole("button", { name: "Workspaces" })).toBeTruthy();
    // No "request access" affordance (we deliberately don't build that backend
    // flow — see the never-leak note in WorkspaceRoot).
    expect(screen.queryByText(/request access/i)).toBeNull();
  });

  it("NEVER-LEAK at the STATUS level: a non-member open is a uniform 404, indistinguishable from missing", async () => {
    // After the server-side never-leak fix, any non-member open (exists-but-
    // restricted, archived, or genuinely missing) is the SAME 404 the recipient
    // receives. The route renders one message and the console reveals nothing —
    // there is no exists-vs-missing signal anywhere the recipient can read.
    const restrictedExists = await renderRouteAndGetMessage(new Error("404 Not Found"));
    const restrictedConsole = consoleOutput();
    cleanup();
    warnSpy.mockClear();

    const missing = await renderRouteAndGetMessage(new Error("404 Not Found"));
    const missingConsole = consoleOutput();

    expect(restrictedExists).toBe(missing);
    expect(restrictedConsole).toBe(missingConsole);
  });

  it("NEVER-LEAK in the CONSOLE: the recipient's console never echoes the distinguishing status", async () => {
    // The slice originally logged the raw error to the recipient's devtools
    // console (`console.warn("...", e)`), leaking 403-vs-404 even though the DOM
    // was unified. Assert the console output carries no status/cause for either
    // rejection — and that the two are byte-identical.
    await renderRouteAndGetMessage(new Error("403 Forbidden"));
    const deniedConsole = consoleOutput();
    cleanup();
    warnSpy.mockClear();

    await renderRouteAndGetMessage(new Error("404 Not Found"));
    const missingConsole = consoleOutput();

    for (const out of [deniedConsole, missingConsole]) {
      expect(out).not.toContain("403");
      expect(out).not.toContain("404");
      expect(out).not.toContain("Forbidden");
      expect(out).not.toContain("Not Found");
    }
    expect(deniedConsole).toBe(missingConsole);
  });
});
