// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { WorkspaceRoot } from "./WorkspaceRoot.tsx";
import { openWorkspace, type WorkspaceRecord } from "./workspaceApi.ts";
import { createWorkspaceFromDatasets } from "./workspaceFromDataset.ts";

// App pulls in the WASM viewer; stub it so the route renders without a GPU/WASM
// runtime. The stub records the props it was last rendered with so we can assert
// the seed dataset URLs (#697) reach the viewer, and exposes a button to drive
// the in-viewer "create workspace from datasets" callback.
interface CapturedAppProps {
  workspaceId: string;
  initialDatasetUrls?: readonly string[];
  onCreateWorkspaceFromDatasets?: (paths: string[]) => void;
  onOpenMonitor?: () => void;
}
const lastAppProps: { current: CapturedAppProps | null } = { current: null };
// Every `initialDatasetUrls` value the viewer was rendered with, in order — used
// to assert the seed is delivered exactly once.
const seedRenders: (readonly string[] | undefined)[] = [];
vi.mock("./App.tsx", () => ({
  default: (props: CapturedAppProps) => {
    lastAppProps.current = props;
    seedRenders.push(props.initialDatasetUrls);
    return (
      <div data-testid="app-mounted">
        <button
          type="button"
          onClick={() =>
            props.onCreateWorkspaceFromDatasets?.(["/data/new.zarr"])
          }
        >
          in-viewer-create-from-datasets
        </button>
        <button type="button" onClick={() => props.onOpenMonitor?.()}>
          in-viewer-open-monitor
        </button>
      </div>
    );
  },
}));

// Stub the dashboard (it needs <AuthGate> context + the file browser fetch).
// We only care that WorkspaceRoot wires `onOpenWorkspace(id, urls)` correctly,
// so expose a button that drives it with a seed.
vi.mock("./WorkspaceDashboard.tsx", () => ({
  WorkspaceDashboard: ({
    onOpenWorkspace,
  }: {
    onOpenWorkspace: (id: string, datasetUrls?: readonly string[]) => void;
  }) => (
    <div data-testid="dashboard-mounted">
      <button
        type="button"
        onClick={() => onOpenWorkspace("ws-created", ["/data/sample.ome.zarr"])}
      >
        dashboard-open-with-seed
      </button>
    </div>
  ),
}));

vi.mock("./workspaceFromDataset.ts", () => ({
  createWorkspaceFromDatasets: vi.fn(),
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

describe("WorkspaceRoot — create workspace from dataset(s) (#697)", () => {
  const createFromDatasetsMock = vi.mocked(createWorkspaceFromDatasets);

  function record(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
    return {
      id: "ws-created",
      name: "sample.ome.zarr",
      role: "owner",
      created_by: "me@example.com",
      created_at: "2026-06-23T00:00:00Z",
      updated_at: "2026-06-23T00:00:00Z",
      archived_at: null,
      seq: 0,
      default_saved_view_id: null,
      last_opened_at: null,
      pinned_at: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    createFromDatasetsMock.mockReset();
    lastAppProps.current = null;
    seedRenders.length = 0;
  });

  it("forwards the seed dataset URL into the viewer when the dashboard opens with a seed", async () => {
    // Start on the dashboard (no /w/:id).
    window.history.replaceState({}, "", "/");
    // The created workspace is then opened by id.
    openWorkspaceMock.mockResolvedValue(record({ id: "ws-created" }));

    render(<WorkspaceRoot />);

    // The dashboard (stubbed) drives onOpenWorkspace(id, [seed]).
    fireEvent.click(
      await screen.findByRole("button", { name: "dashboard-open-with-seed" }),
    );

    // The viewer mounts for the new workspace WITH the seed to auto-open.
    await waitFor(() => {
      expect(screen.getByTestId("app-mounted")).toBeTruthy();
      expect(lastAppProps.current?.workspaceId).toBe("ws-created");
      expect(lastAppProps.current?.initialDatasetUrls).toEqual([
        "/data/sample.ome.zarr",
      ]);
    });
  });

  it("delivers the seed only ONCE: a plain re-open of the same workspace carries no seed", async () => {
    window.history.replaceState({}, "", "/");
    openWorkspaceMock.mockResolvedValue(record({ id: "ws-created" }));

    render(<WorkspaceRoot />);

    // Create → navigate in with the seed.
    fireEvent.click(
      await screen.findByRole("button", { name: "dashboard-open-with-seed" }),
    );
    await waitFor(() => {
      expect(lastAppProps.current?.initialDatasetUrls).toEqual([
        "/data/sample.ome.zarr",
      ]);
    });

    // Navigate back to the dashboard (the back-arrow / "Workspaces" affordance).
    // This consumes/clears the seed for that workspace.
    await act(async () => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByTestId("dashboard-mounted");

    // Re-open the SAME workspace via a plain (seed-less) navigation, simulating
    // clicking the existing row in the dashboard.
    await act(async () => {
      window.history.pushState({}, "", "/w/ws-created");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(lastAppProps.current?.workspaceId).toBe("ws-created");
    });
    // The seed was delivered exactly once (the create), never on the re-open.
    const seededRenders = seedRenders.filter((s) => s && s.length > 0);
    expect(seededRenders).toEqual([["/data/sample.ome.zarr"]]);
  });

  it("in-viewer 'create from datasets' creates a new workspace and navigates in with the seed", async () => {
    // Start inside an existing workspace.
    window.history.replaceState({}, "", "/w/ws-old");
    openWorkspaceMock.mockResolvedValue(record({ id: "ws-old", name: "Old" }));
    createFromDatasetsMock.mockResolvedValue(record({ id: "ws-fresh" }));

    render(<WorkspaceRoot />);

    // The viewer for ws-old is mounted; trigger the in-viewer create.
    await screen.findByTestId("app-mounted");
    expect(lastAppProps.current?.workspaceId).toBe("ws-old");
    // The destination workspace will be opened by id next.
    openWorkspaceMock.mockResolvedValue(record({ id: "ws-fresh" }));

    fireEvent.click(
      screen.getByRole("button", { name: "in-viewer-create-from-datasets" }),
    );

    await waitFor(() => {
      expect(createFromDatasetsMock).toHaveBeenCalledWith(["/data/new.zarr"]);
      expect(lastAppProps.current?.workspaceId).toBe("ws-fresh");
      expect(lastAppProps.current?.initialDatasetUrls).toEqual([
        "/data/new.zarr",
      ]);
    });
  });

  it("SURFACES an in-viewer create-from-selection failure to the user and keeps the workspace mounted", async () => {
    // Start inside an existing workspace.
    window.history.replaceState({}, "", "/w/ws-old");
    openWorkspaceMock.mockResolvedValue(record({ id: "ws-old", name: "Old" }));
    // The create step fails (e.g. server rejected the new workspace).
    createFromDatasetsMock.mockRejectedValue(
      new Error("workspace quota exceeded"),
    );

    render(<WorkspaceRoot />);

    await screen.findByTestId("app-mounted");
    fireEvent.click(
      screen.getByRole("button", { name: "in-viewer-create-from-datasets" }),
    );

    // The failure is surfaced to the user (not just console.warn'd), mirroring
    // the dashboard's create-from-dataset failure path...
    const errEl = await screen.findByTestId("workspace-create-error");
    expect(errEl.textContent).toContain("workspace quota exceeded");
    // ...and the current workspace is NOT unwound — <App> stays mounted.
    expect(screen.getByTestId("app-mounted")).toBeTruthy();
    // No navigation happened: still in ws-old.
    expect(lastAppProps.current?.workspaceId).toBe("ws-old");
  });

  it("the surfaced create error is dismissible", async () => {
    window.history.replaceState({}, "", "/w/ws-old");
    openWorkspaceMock.mockResolvedValue(record({ id: "ws-old", name: "Old" }));
    createFromDatasetsMock.mockRejectedValue(new Error("boom"));

    render(<WorkspaceRoot />);
    await screen.findByTestId("app-mounted");
    fireEvent.click(
      screen.getByRole("button", { name: "in-viewer-create-from-datasets" }),
    );

    await screen.findByTestId("workspace-create-error");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("workspace-create-error")).toBeNull();
  });
});

describe("WorkspaceRoot — the monitor route (#936)", () => {
  it("renders the monitor at its own path rather than an overlay on the viewer", () => {
    window.history.replaceState({}, "", "/monitor");
    render(<WorkspaceRoot />);

    expect(screen.getByRole("heading", { name: "Pipeline monitor" })).toBeTruthy();
    // A separate page: the viewer is not mounted underneath it.
    expect(screen.queryByTestId("app-mounted")).toBeNull();
    expect(screen.queryByTestId("dashboard-mounted")).toBeNull();
  });

  it("leaves the viewer for the monitor and comes back to the same workspace", async () => {
    openWorkspaceMock.mockResolvedValue({
      id: "ws-secret",
      name: "Workspace",
      role: "owner",
      default_saved_view_id: null,
    } as unknown as WorkspaceRecord);
    render(<WorkspaceRoot />);
    await screen.findByTestId("app-mounted");

    fireEvent.click(screen.getByText("in-viewer-open-monitor"));
    expect(screen.getByRole("heading", { name: "Pipeline monitor" })).toBeTruthy();
    expect(window.location.pathname).toBe("/monitor");

    fireEvent.click(screen.getByTestId("monitor-close"));
    await screen.findByTestId("app-mounted");
    expect(window.location.pathname).toBe("/w/ws-secret");
  });

  it("says there is nothing to read rather than failing when no run was recorded", () => {
    window.history.replaceState({}, "", "/monitor");
    render(<WorkspaceRoot />);

    expect(screen.getByTestId("monitor-empty")).toBeTruthy();
  });
});
