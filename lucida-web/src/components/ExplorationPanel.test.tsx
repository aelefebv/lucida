// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SAVED_VIEW_VERSION, type SavedView } from "../savedView/types.ts";

// Mock the wasm generator. `explore_view` returns a sidecar JSON string; tests
// override its return per case via the typed handle below. The component parses
// the string and renders the cells, so the mock is the seam that decides what
// candidates appear — AND which manual nudge buttons are enabled (a nudge is a
// shortcut to its matching cell, so it's live only when that transform is in the
// sidecar's cells). lucida-core is the only wasm import in the panel.
const exploreView = vi.fn(() => JSON.stringify(defaultSidecar()));

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

/** A child view with a distinct camera `theta` so an applyView call can be
 *  matched back to the cell that produced it. */
function viewWithTheta(theta: number): SavedView {
  const v = arcballView();
  (v.camera as { theta: number }).theta = theta;
  return v;
}

/** The default sidecar: an arcball root that offers the full nudge set (both
 *  rotates + both zooms) plus a generic StepZ row, each with a distinct child
 *  view. Mirrors what the core generator returns for an interior 3D view, so the
 *  manual nudge buttons (shortcuts to these cells) are all live. */
function defaultSidecar() {
  return {
    v: 1,
    current: { handle: "vh-0", view: arcballView() },
    extent: { min: [0, 0, 0], max: [256, 256, 40], z_count: 40, t_count: 1, c_count: 1 },
    cells: [
      {
        handle: "vh-rot-right",
        transform: "azimuth:+45",
        label: "Rotate right 45°",
        z: 20,
        t: 0,
        c: 0,
        view: viewWithTheta(0.785),
      },
      {
        handle: "vh-rot-left",
        transform: "azimuth:-45",
        label: "Rotate left 45°",
        z: 20,
        t: 0,
        c: 0,
        view: viewWithTheta(-0.785),
      },
      {
        handle: "vh-zoom-in",
        transform: "zoom:in",
        label: "Zoom in",
        z: 20,
        t: 0,
        c: 0,
        view: viewWithTheta(0.111),
      },
      {
        handle: "vh-zoom-out",
        transform: "zoom:out",
        label: "Zoom out",
        z: 20,
        t: 0,
        c: 0,
        view: viewWithTheta(0.222),
      },
      {
        handle: "vh-stepz",
        transform: "stepz:+1",
        label: "Next slice (deeper)",
        z: 21,
        t: 0,
        c: 0,
        view: viewWithTheta(0.333),
      },
    ],
  };
}

function baseProps(over: Partial<ExplorationPanelProps> = {}): ExplorationPanelProps {
  return {
    visible: true,
    captureBuilder: () => arcballView(),
    applyView: vi.fn(async () => {}),
    createSavedView: vi.fn(async () => ({})),
    datasetId: "ds-1",
    datasetName: "sample.ome.zarr",
    dims: [1, 1, 40, 256, 256],
    viewport: [800, 600],
    ...over,
  };
}

beforeEach(() => {
  // Reset BOTH call history and implementation so a test that installs a custom
  // sidecar (mockReturnValue) can't leak into the next test.
  exploreView.mockReset();
  exploreView.mockImplementation(() => JSON.stringify(defaultSidecar()));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The thumbnail tests stub IntersectionObserver via vi.stubGlobal; clear it so
  // a fake observer can't leak into later test files.
  vi.unstubAllGlobals();
});

async function renderPanel(over: Partial<ExplorationPanelProps> = {}) {
  const props = baseProps(over);
  await act(async () => {
    render(<ExplorationPanel {...props} />);
  });
  return props;
}

describe("ExplorationPanel empty-state semantics", () => {
  it("does not present the no-dataset message as a list child", async () => {
    await renderPanel({ datasetId: null, datasetName: null });
    const empty = screen.getByText("Open a dataset to start exploring.");
    expect(empty.closest("[role='list']")).toBeNull();
  });
});

/** The candidate row whose label matches — disambiguates now that the panel
 *  renders several cells. */
function cellByLabel(label: string): HTMLElement {
  const cell = screen
    .getAllByTestId("explore-cell")
    .find((el) => within(el).queryByText(label));
  if (!cell) throw new Error(`no explore-cell labelled ${label}`);
  return within(cell).getByRole("button", {
    name: `Open suggested view: ${label}`,
  });
}

/** A manual nudge BUTTON by its text. Targets the role so it doesn't collide
 *  with a candidate ROW that happens to share the label (e.g. "Zoom in"). */
function nudgeButton(text: string): HTMLButtonElement {
  return screen.getByRole("button", { name: text }) as HTMLButtonElement;
}

describe("ExplorationPanel — candidates", () => {
  it("renders the plain-language label without exposing an internal transform id", async () => {
    await renderPanel();
    const cell = cellByLabel("Rotate right 45°");
    expect(within(cell).getByText("Rotate right 45°")).toBeTruthy();
    expect(within(cell).queryByText("azimuth:+45")).toBeNull();
  });

  it("calls explore_view when it becomes visible (refresh on open)", async () => {
    await renderPanel();
    expect(exploreView).toHaveBeenCalled();
  });

  it("clicking a candidate descends via applyView with that cell's view", async () => {
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(cellByLabel("Rotate right 45°"));
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

describe("ExplorationPanel — manual controls (shortcuts to generator moves)", () => {
  it("Rotate right descends into the generator's azimuth:+45 cell (no TS move math)", async () => {
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-rotate-right"));
    });
    // The nudge runs the SAME descend path as the row: applyView with the
    // matching candidate's view (theta 0.785 from the azimuth:+45 cell).
    expect(props.applyView).toHaveBeenCalledTimes(1);
    const applied = (props.applyView as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as SavedView;
    expect((applied.camera as { theta: number }).theta).toBeCloseTo(0.785);
  });

  it("Zoom in descends into the generator's zoom:in cell", async () => {
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(nudgeButton("Zoom in"));
    });
    expect(props.applyView).toHaveBeenCalledTimes(1);
    const applied = (props.applyView as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as SavedView;
    expect((applied.camera as { theta: number }).theta).toBeCloseTo(0.111);
  });

  it("disables a nudge whose move the generator does not offer (Rotate on a 2D view)", async () => {
    // A 2D slice sidecar offers no azimuth cells, so the Rotate buttons disable.
    exploreView.mockReturnValue(
      JSON.stringify({
        v: 1,
        current: { handle: "vh-2d", view: arcballView() },
        extent: { min: [0, 0, 0], max: [256, 256, 1], z_count: 1, t_count: 1, c_count: 1 },
        cells: [
          {
            handle: "vh-zoom-in",
            transform: "zoom:in",
            label: "Zoom in",
            z: 0,
            t: 0,
            c: 0,
            view: viewWithTheta(0.111),
          },
        ],
      }),
    );
    await renderPanel();
    expect(
      (screen.getByTestId("explore-rotate-right") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("explore-rotate-left") as HTMLButtonElement).disabled,
    ).toBe(true);
    // Zoom in is offered, so it stays enabled.
    expect(nudgeButton("Zoom in").disabled).toBe(false);
  });

  it("Previous view is disabled until a descend happens, then restores the previous view", async () => {
    const props = await renderPanel();
    const back = () => screen.getByTestId("explore-back") as HTMLButtonElement;
    expect(back().textContent).toBe("Previous view");
    expect(back().disabled).toBe(true);
    // Descend into the rotated child; the current (theta 0) view is pushed.
    await act(async () => {
      await userEvent.click(cellByLabel("Rotate right 45°"));
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

  it("a manual nudge pushes onto the Back stack — Back returns to the pre-nudge view (Part D)", async () => {
    // captureBuilder returns the live (pre-nudge) view; after a Rotate nudge,
    // Back must re-apply THAT view, not the nudge's child. This is the finer-Back
    // behavior unlocked by routing nudges through the descend path.
    const props = await renderPanel();
    const back = () => screen.getByTestId("explore-back") as HTMLButtonElement;
    expect(back().disabled).toBe(true);

    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-rotate-right"));
    });
    // The nudge descended (applied the azimuth child) AND enabled Back.
    expect(back().disabled).toBe(false);

    await act(async () => {
      await userEvent.click(back());
    });
    const applyCalls = (props.applyView as ReturnType<typeof vi.fn>).mock.calls;
    // 1st apply = the nudge's child (theta 0.785); 2nd = Back → the pre-nudge
    // view captured before the nudge (theta 0).
    expect(applyCalls).toHaveLength(2);
    expect((applyCalls[0][0] as SavedView).camera).toMatchObject({ theta: 0.785 });
    expect((applyCalls[1][0] as SavedView).camera).toMatchObject({ theta: 0 });
    // Stack drained → Back disabled again.
    expect(back().disabled).toBe(true);
  });

  it("keeps Back history and breadcrumb intact when restoring the previous view fails", async () => {
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(cellByLabel("Rotate right 45°"));
    });
    const back = screen.getByTestId("explore-back") as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(screen.getByTestId("explore-breadcrumb").textContent).toBe(
      "Home › Rotate right 45°",
    );

    vi.mocked(props.applyView).mockRejectedValueOnce(new Error("restore failed"));
    await act(async () => {
      await userEvent.click(back);
    });

    expect(screen.getByTestId("explore-error").textContent).toContain("restore failed");
    expect(back.disabled).toBe(false);
    expect(screen.getByTestId("explore-breadcrumb").textContent).toBe(
      "Home › Rotate right 45°",
    );

    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(back.disabled).toBe(true);
    expect(screen.getByTestId("explore-breadcrumb").textContent).toBe("Home");
  });

  it("coalesces concurrent navigation attempts behind one in-flight transition", async () => {
    let resolveApply!: () => void;
    const applyView = vi.fn(() => new Promise<void>((resolve) => {
      resolveApply = resolve;
    }));
    await renderPanel({ applyView });
    const row = cellByLabel("Rotate right 45°");

    act(() => {
      fireEvent.click(row);
      fireEvent.click(row);
    });
    expect(applyView).toHaveBeenCalledOnce();
    expect((screen.getByTestId("explore-back") as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveApply();
      await Promise.resolve();
    });
    expect((screen.getByTestId("explore-back") as HTMLButtonElement).disabled).toBe(false);
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
      await userEvent.click(cellByLabel("Rotate right 45°"));
    });
    expect(crumb()).toBe("Home › Rotate right 45°");

    // Back → the step is popped.
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-back"));
    });
    expect(crumb()).toBe("Home");
  });

  it("pushes the matching cell's plain-language label on a manual nudge", async () => {
    await renderPanel();
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-rotate-right"));
    });
    // The label comes from the generator's azimuth:+45 cell, not a TS literal.
    expect(screen.getByTestId("explore-breadcrumb").textContent).toBe(
      "Home › Rotate right 45°",
    );
    // A second nudge appends again, proving the trail accumulates.
    await act(async () => {
      await userEvent.click(nudgeButton("Zoom in"));
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
      await userEvent.click(cellByLabel("Rotate right 45°"));
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

describe("ExplorationPanel — save view", () => {
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
      await userEvent.click(screen.getByTestId("explore-save-view"));
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
      await userEvent.click(screen.getByTestId("explore-save-view"));
    });
    expect(props.createSavedView).not.toHaveBeenCalled();
  });
});

describe("ExplorationPanel — preview thumbnails", () => {
  // A controllable IntersectionObserver: capture every (callback, element) pair
  // so a test can decide WHEN a row "scrolls into view". This is the seam that
  // lets us prove laziness — the panel must not request a render until the
  // observer reports the row intersecting.
  type IOEntry = { cb: IntersectionObserverCallback; el: Element; obs: IntersectionObserver };
  let observed: IOEntry[] = [];

  function installControllableIO() {
    observed = [];
    class FakeIO {
      cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe(el: Element) {
        observed.push({ cb: this.cb, el, obs: this as unknown as IntersectionObserver });
      }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    }
    vi.stubGlobal("IntersectionObserver", FakeIO as unknown as typeof IntersectionObserver);
  }

  /** Fire intersection for every currently-observed row. */
  function scrollAllIntoView() {
    for (const { cb, el, obs } of observed) {
      cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], obs);
    }
  }

  beforeEach(() => {
    installControllableIO();
  });

  /** A thumbnail requester that resolves to a stand-in bitmap, recording the
   *  views it was asked to render. The real `ImageBitmap`/canvas isn't available
   *  in happy-dom, so we hand back a minimal object with a `close()` (the panel
   *  only calls `.close()` and `drawImage`, the latter guarded on a 2d context
   *  that happy-dom returns null for). */
  function fakeBitmap(): ImageBitmap {
    return { width: 8, height: 8, close: vi.fn() } as unknown as ImageBitmap;
  }

  it("does NOT request a thumbnail until the row scrolls into view (lazy)", async () => {
    const requestThumbnail = vi.fn(async () => fakeBitmap());
    await renderPanel({ requestThumbnail });
    // Rows are mounted, observers registered — but nothing requested yet.
    expect(observed.length).toBeGreaterThan(0);
    expect(requestThumbnail).not.toHaveBeenCalled();
    // Now reveal them.
    await act(async () => {
      scrollAllIntoView();
    });
    expect(requestThumbnail).toHaveBeenCalled();
  });

  it("requests a render for a candidate with THAT candidate's child camera", async () => {
    const requestThumbnail = vi.fn(async () => fakeBitmap());
    await renderPanel({ requestThumbnail });
    await act(async () => {
      scrollAllIntoView();
    });
    // The default sidecar's rotate-right cell carries theta 0.785; assert some
    // request was made with a view whose camera is that child camera (proving the
    // tile renders from its own angle, not the current view's).
    const views = (requestThumbnail as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as SavedView,
    );
    const thetas = views.map((v) => (v.camera as { theta: number }).theta);
    expect(thetas).toContain(0.785);
    // Size is a positive device-pixel edge.
    const size = (requestThumbnail as ReturnType<typeof vi.fn>).mock.calls[0][1] as number;
    expect(size).toBeGreaterThan(0);
  });

  it("falls back to the label-only row when a thumbnail fails (null)", async () => {
    const requestThumbnail = vi.fn(async () => null);
    await renderPanel({ requestThumbnail });
    await act(async () => {
      scrollAllIntoView();
    });
    // The candidate's LABEL is still present (the row never breaks)...
    expect(cellByLabel("Rotate right 45°")).toBeTruthy();
    // ...and the failed thumbnail box unmounts (empty status → null render).
    await act(async () => {});
    const cell = cellByLabel("Rotate right 45°");
    expect(within(cell).queryByTestId("explore-thumb")).toBeNull();
  });

  it("falls back gracefully when the requester throws", async () => {
    const requestThumbnail = vi.fn(async () => {
      throw new Error("gpu hiccup");
    });
    await renderPanel({ requestThumbnail });
    await act(async () => {
      scrollAllIntoView();
    });
    await act(async () => {});
    // Row still renders by label; no thumbnail box, no error surfaced.
    expect(cellByLabel("Rotate right 45°")).toBeTruthy();
    expect(screen.queryByTestId("explore-error")).toBeNull();
  });

  it("does not let an obsolete thumbnail completion overwrite a refreshed candidate", async () => {
    const first = defaultSidecar();
    first.cells = [first.cells[0]];
    exploreView.mockReturnValue(JSON.stringify(first));
    const oldBitmap = fakeBitmap();
    const newBitmap = fakeBitmap();
    let resolveOld!: (bitmap: ImageBitmap) => void;
    let resolveNew!: (bitmap: ImageBitmap) => void;
    const requestThumbnail = vi.fn((view: SavedView) =>
      new Promise<ImageBitmap>((resolve) => {
        const theta = (view.camera as { theta: number }).theta;
        if (theta === 0.785) resolveOld = resolve;
        else resolveNew = resolve;
      }));
    await renderPanel({ requestThumbnail });
    const firstObservers = observed.length;
    act(() => {
      const entry = observed[0];
      entry.cb([{ isIntersecting: true, target: entry.el } as IntersectionObserverEntry], entry.obs);
    });

    const refreshed = defaultSidecar();
    refreshed.cells = [{
      ...refreshed.cells[0],
      // Keep the same logical handle to prove the `view` dependency, rather
      // than a React remount, cancels the stale completion.
      view: viewWithTheta(1.57),
    }];
    exploreView.mockReturnValue(JSON.stringify(refreshed));
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-suggest"));
    });
    const nextEntry = observed.slice(firstObservers).at(-1)!;
    act(() => {
      nextEntry.cb(
        [{ isIntersecting: true, target: nextEntry.el } as IntersectionObserverEntry],
        nextEntry.obs,
      );
    });

    await act(async () => {
      resolveOld(oldBitmap);
      await Promise.resolve();
    });
    expect(oldBitmap.close).toHaveBeenCalledOnce();
    expect(screen.getByTestId("explore-thumb").getAttribute("data-thumb-status"))
      .toBe("pending");

    await act(async () => {
      resolveNew(newBitmap);
      await Promise.resolve();
    });
    expect(screen.getByTestId("explore-thumb").getAttribute("data-thumb-status"))
      .toBe("ready");
  });

  it("hides previews (and stops requesting) when 'Show previews' is unchecked", async () => {
    const requestThumbnail = vi.fn(async () => fakeBitmap());
    await renderPanel({ requestThumbnail });
    // Toggle previews OFF before revealing rows.
    await act(async () => {
      await userEvent.click(
        within(screen.getByTestId("explore-previews-toggle")).getByRole("checkbox"),
      );
    });
    observed = []; // ignore any observers registered before the toggle
    await act(async () => {
      scrollAllIntoView();
    });
    expect(requestThumbnail).not.toHaveBeenCalled();
    // No thumbnail boxes are mounted.
    expect(screen.queryByTestId("explore-thumb")).toBeNull();
  });

  it("shows no preview toggle and no thumbnails when no requester is wired", async () => {
    await renderPanel(); // requestThumbnail omitted
    expect(screen.queryByTestId("explore-previews-toggle")).toBeNull();
    expect(screen.queryByTestId("explore-thumb")).toBeNull();
  });
});
