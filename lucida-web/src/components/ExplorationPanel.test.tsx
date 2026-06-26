// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SAVED_VIEW_VERSION, type SavedView } from "../savedView/types.ts";

// Mock the wasm generator. `explore_view` returns a sidecar JSON string; tests
// override its return per case via the typed handle below. The component parses
// the string and renders the cells, so the mock is the seam that decides what
// candidates appear. (lucida-core is the only wasm import in the panel's
// dependency graph that runs at module load — applyAndSend.ts imports a type
// only.)
const exploreView = vi.fn(() =>
  JSON.stringify({
    v: 1,
    current: { handle: "vh-0", view: arcballView() },
    cells: [
      {
        handle: "vh-1",
        transform: "azimuth:+45",
        label: "Rotate right 45°",
        view: rotatedView(),
      },
    ],
  }),
);

vi.mock("lucida-core", () => ({
  explore_view: (...args: unknown[]) => exploreView(...(args as [])),
}));

import { ExplorationPanel, type ExplorationPanelProps } from "./ExplorationPanel.tsx";

function arcballView(): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets: [],
    active_layouts: {},
    camera: {
      mode: "arcball",
      target: [0, 0, 0],
      theta: 0,
      phi: 0,
      distance: 100,
      fov: 0.6,
      viewport: [800, 600],
      near: 0.1,
      far: 1000,
    },
    view: { z_range: { start: 20, end: 21 }, t: 0, c: 0, multi_channel: false },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
    dataset_order: ["ds-1"],
    dataset_settings: {},
  };
}

/** A distinct child view so an applyView call can be matched to the cell. */
function rotatedView(): SavedView {
  const v = arcballView();
  (v.camera as { theta: number }).theta = 0.785;
  return v;
}

/** Minimal WasmScene stub: only `apply_command` is exercised by the manual
 *  controls (`applyViewportCommand`). */
function sceneStub() {
  return { apply_command: vi.fn() };
}

function baseProps(over: Partial<ExplorationPanelProps> = {}): ExplorationPanelProps {
  const scene = sceneStub();
  return {
    visible: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wasmSceneRef: { current: scene as any },
    captureBuilder: () => arcballView(),
    applyView: vi.fn(async () => {}),
    onViewportChanged: vi.fn(),
    createSavedView: vi.fn(async () => ({})),
    datasetId: "ds-1",
    datasetName: "sample.ome.zarr",
    dims: [1, 1, 40, 256, 256],
    viewport: [800, 600],
    is3D: true,
    ...over,
  };
}

beforeEach(() => {
  exploreView.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderPanel(over: Partial<ExplorationPanelProps> = {}) {
  const props = baseProps(over);
  await act(async () => {
    render(<ExplorationPanel {...props} />);
  });
  return props;
}

describe("ExplorationPanel — candidates", () => {
  it("renders the plain-language label and its transform tag for each candidate", async () => {
    await renderPanel();
    const cell = screen.getByTestId("explore-cell");
    expect(within(cell).getByText("Rotate right 45°")).toBeTruthy();
    // The muted machine id is shown as a small tag.
    expect(within(cell).getByText("azimuth:+45")).toBeTruthy();
  });

  it("calls explore_view when it becomes visible (refresh on open)", async () => {
    await renderPanel();
    expect(exploreView).toHaveBeenCalled();
  });

  it("clicking a candidate descends via applyView with that cell's view", async () => {
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-cell"));
    });
    expect(props.applyView).toHaveBeenCalledTimes(1);
    // It applies the CELL's view (the rotated child), not the current view.
    const applied = (props.applyView as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as SavedView;
    expect((applied.camera as { theta: number }).theta).toBeCloseTo(0.785);
  });

  it("does not render anything when not visible", async () => {
    await renderPanel({ visible: false });
    expect(screen.queryByTestId("explore-panel")).toBeNull();
  });

  it("shows the error text when the generator returns an error envelope", async () => {
    exploreView.mockReturnValueOnce(JSON.stringify({ error: "bad view" }));
    await renderPanel();
    expect(screen.getByTestId("explore-error").textContent).toContain("bad view");
  });

  it("prompts to open a dataset when none is loaded", async () => {
    await renderPanel({ datasetId: null, dims: null });
    expect(screen.getByText(/open a dataset to start exploring/i)).toBeTruthy();
  });
});

describe("ExplorationPanel — manual controls", () => {
  it("Rotate right issues an arcball_rotate command AND fires the repaint hook", async () => {
    const scene = sceneStub();
    const onViewportChanged = vi.fn();
    await renderPanel({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wasmSceneRef: { current: scene as any },
      onViewportChanged,
    });
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-rotate-right"));
    });
    expect(scene.apply_command).toHaveBeenCalled();
    const cmd = JSON.parse(
      scene.apply_command.mock.calls[0][0] as string,
    ) as Record<string, unknown>;
    expect(cmd.type).toBe("arcball_rotate");
    expect(cmd.d_theta as number).toBeGreaterThan(0);
    // BLOCKER #1: the nudge must mark the canvas dirty via the repaint hook
    // (applyViewportCommand alone doesn't), or the view wouldn't move on screen.
    expect(onViewportChanged).toHaveBeenCalledTimes(1);
  });

  it("Zoom in fires the repaint hook (so the canvas repaints)", async () => {
    const onViewportChanged = vi.fn();
    await renderPanel({ onViewportChanged });
    await act(async () => {
      await userEvent.click(screen.getByText("Zoom in"));
    });
    expect(onViewportChanged).toHaveBeenCalledTimes(1);
  });

  it("disables Rotate in 2D mode", async () => {
    await renderPanel({ is3D: false });
    expect(
      (screen.getByTestId("explore-rotate-right") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("Back is disabled until a descend happens, then enabled, and applies the previous view", async () => {
    const props = await renderPanel();
    const back = () => screen.getByTestId("explore-back") as HTMLButtonElement;
    expect(back().disabled).toBe(true);
    // Descend into the rotated child; the current (theta 0) view is pushed.
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-cell"));
    });
    expect(back().disabled).toBe(false);

    // Going back applies the previously-captured view (theta 0), then the stack
    // empties and Back disables again.
    await act(async () => {
      await userEvent.click(back());
    });
    const applyCalls = (props.applyView as ReturnType<typeof vi.fn>).mock.calls;
    // 1st apply = descend (theta 0.785); 2nd = back (theta 0).
    expect(applyCalls).toHaveLength(2);
    expect((applyCalls[1][0] as SavedView).camera).toMatchObject({ theta: 0 });
    expect(back().disabled).toBe(true);
  });
});

describe("ExplorationPanel — breadcrumb trail (proof of navigation)", () => {
  it("starts at Home, pushes the cell label on descend, and pops on Back", async () => {
    await renderPanel();
    const crumb = () => screen.getByTestId("explore-breadcrumb").textContent ?? "";
    // Root.
    expect(crumb()).toBe("Home");

    // Descend → the cell's label is appended.
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-cell"));
    });
    expect(crumb()).toBe("Home › Rotate right 45°");

    // Back → the step is popped.
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-back"));
    });
    expect(crumb()).toBe("Home");
  });

  it("pushes the nudge's plain-language label on a manual move", async () => {
    await renderPanel();
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-rotate-right"));
    });
    expect(screen.getByTestId("explore-breadcrumb").textContent).toBe(
      "Home › Rotate right 45°",
    );
    // A second move appends again, proving the trail accumulates.
    await act(async () => {
      await userEvent.click(screen.getByText("Zoom in"));
    });
    expect(screen.getByTestId("explore-breadcrumb").textContent).toBe(
      "Home › Rotate right 45° › Zoom in",
    );
  });

  it("passes the breadcrumb depth into explore_view", async () => {
    await renderPanel();
    // Initial refresh: depth 0.
    const depthArg = (call: unknown[]) => call[9] as number;
    expect(depthArg(exploreView.mock.calls[0])).toBe(0);
    exploreView.mockClear();

    // After one descend the trail has length 1 → the next generate uses depth 1.
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-cell"));
    });
    const lastCall = exploreView.mock.calls[exploreView.mock.calls.length - 1];
    expect(depthArg(lastCall)).toBe(1);
  });
});

describe("ExplorationPanel — you-are-here readout reveals the axes", () => {
  it("shows azimuth + Z, and surfaces T and C when the dataset has them", async () => {
    // A 40-timepoint, 3-channel volume: the readout must announce T and C exist
    // even though stepping them isn't offered yet (the flat-2D blind spot).
    await renderPanel({ dims: [40, 3, 340, 512, 512] });
    const here = screen.getByTestId("explore-here").textContent ?? "";
    expect(here).toMatch(/3D/);
    expect(here).toMatch(/az \d+°/);
    expect(here).toMatch(/Z \d+\/340/);
    expect(here).toMatch(/T 0\/40/);
    expect(here).toMatch(/C 0\/3/);
  });

  it("omits T and C when the dataset is single-timepoint, single-channel", async () => {
    await renderPanel({ dims: [1, 1, 40, 256, 256] });
    const here = screen.getByTestId("explore-here").textContent ?? "";
    expect(here).toMatch(/Z \d+\/40/);
    expect(here).not.toMatch(/\bT \d/);
    expect(here).not.toMatch(/\bC \d/);
  });
});

describe("ExplorationPanel — bookmark", () => {
  // happy-dom doesn't implement window.prompt, so install a stub directly
  // (vi.spyOn can't spy on an undefined property).
  function stubPrompt(value: string | null) {
    const fn = vi.fn(() => value);
    Object.defineProperty(window, "prompt", { configurable: true, value: fn });
    return fn;
  }

  it("prompts for a name and saves a personal view", async () => {
    const promptStub = stubPrompt("My spot");
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-bookmark"));
    });
    expect(promptStub).toHaveBeenCalled();
    expect(props.createSavedView).toHaveBeenCalledTimes(1);
    const [name, , visibility] = (props.createSavedView as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(name).toBe("My spot");
    expect(visibility).toBe("personal");
  });

  it("cancelling the prompt does not save", async () => {
    stubPrompt(null);
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-bookmark"));
    });
    expect(props.createSavedView).not.toHaveBeenCalled();
  });
});
