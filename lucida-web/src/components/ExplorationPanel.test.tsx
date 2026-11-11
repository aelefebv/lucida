// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WasmScene } from "lucida-core";
import { SavedViewApplier } from "../savedView/applier.ts";
import { buildCapture } from "../savedView/captureBuilder.ts";
import { SAVED_VIEW_VERSION, type SavedView } from "../savedView/types.ts";
import {
  FIXTURES,
  PIXEL_RATIOS,
  PropertyReport,
  VIEWPORTS,
  cssSize,
  cssSizesDiffer,
  datasetId,
  dims as fixtureDims,
  fixture,
  loadWasm,
  newScene,
  notFramed,
  openIn,
  openedScene,
  renamed,
  type ViewFixture,
  type Viewport,
} from "../viewProperties.ts";
import { ExplorationPanel, type ExplorationPanelProps } from "./ExplorationPanel.tsx";

beforeAll(loadWasm);

/** A page holding the volume fixture as `ds-1`, the dataset the views name. */
function pageScene(mode: "slice" | "arcball" = "arcball"): WasmScene {
  const scene = newScene(VIEWPORTS[0], 1);
  if (mode === "arcball") scene.apply_command(JSON.stringify({ type: "set_mode_arcball" }));
  openIn(scene, renamed(fixture("volume"), "ds-1"));
  return scene;
}

// The real generator runs on the panel's scene; the spy only records its
// arguments.
let explore: MockInstance<WasmScene["explore"]>;

const QUARTER_TURN = Math.PI / 4;

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
    view: { z_range: { start: 20, end: 21 }, t: 0 },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
    dataset_order: ["ds-1"],
    dataset_settings: {},
  };
}

function sliceView(): SavedView {
  return {
    ...arcballView(),
    camera: { mode: "slice", center: [128, 128], zoom: 1, viewport: [800, 600] },
  };
}

function cameraOf(view: SavedView): Record<string, number> {
  return view.camera as unknown as Record<string, number>;
}

function baseProps(over: Partial<ExplorationPanelProps> = {}): ExplorationPanelProps {
  const scene = pageScene();
  explore = vi.spyOn(scene, "explore");
  return {
    visible: true,
    captureBuilder: () => arcballView(),
    applyView: vi.fn(async () => {}),
    createSavedView: vi.fn(async () => ({})),
    datasetId: "ds-1",
    datasetName: "sample.ome.zarr",
    dims: [1, 1, 40, 256, 256],
    viewport: [800, 600],
    getScene: () => scene,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The thumbnail tests stub IntersectionObserver; don't leak it to later files.
  vi.unstubAllGlobals();
});

async function renderPanel(over: Partial<ExplorationPanelProps> = {}) {
  const props = baseProps(over);
  await act(async () => {
    render(<ExplorationPanel {...props} />);
  });
  return props;
}

function appliedViews(props: ExplorationPanelProps): SavedView[] {
  return (props.applyView as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as SavedView);
}

function cellByLabel(label: string): HTMLElement {
  const cell = screen
    .getAllByTestId("explore-cell")
    .find((el) => within(el).queryByText(label));
  if (!cell) throw new Error(`no explore-cell labelled ${label}`);
  return cell;
}

/** A nudge button by its text. Targets the role so it doesn't collide with a
 *  candidate row that shares the label (e.g. "Zoom in"). */
function nudgeButton(text: string): HTMLButtonElement {
  return screen.getByRole("button", { name: text }) as HTMLButtonElement;
}

describe("ExplorationPanel — candidates", () => {
  it("renders the plain-language label and its transform tag for each candidate", async () => {
    await renderPanel();
    const cell = cellByLabel("Rotate right 45°");
    expect(within(cell).getByText("Rotate right 45°")).toBeTruthy();
    expect(within(cell).getByText("azimuth:+45")).toBeTruthy();
  });

  it("explores when it becomes visible (refresh on open)", async () => {
    await renderPanel();
    expect(explore).toHaveBeenCalled();
  });

  it("clicking a candidate descends via applyView with that cell's view", async () => {
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(cellByLabel("Rotate right 45°"));
    });
    // The cell's view (the rotated child), not the current view.
    const applied = appliedViews(props);
    expect(applied).toHaveLength(1);
    expect(cameraOf(applied[0]).theta).toBeCloseTo(QUARTER_TURN);
  });

  it("does not render anything when not visible", async () => {
    await renderPanel({ visible: false });
    expect(screen.queryByTestId("explore-panel")).toBeNull();
  });

  it("shows the error text when the generator returns an error envelope", async () => {
    // A view with no camera is one the generator cannot read.
    await renderPanel({ captureBuilder: () => ({ v: SAVED_VIEW_VERSION }) as unknown as SavedView });
    expect(screen.getByTestId("explore-error").textContent).toMatch(/camera/);
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
    // Same descend path as the row: the azimuth:+45 cell's view.
    const applied = appliedViews(props);
    expect(applied).toHaveLength(1);
    expect(cameraOf(applied[0]).theta).toBeCloseTo(QUARTER_TURN);
  });

  it("Zoom in descends into the generator's zoom:in cell", async () => {
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(nudgeButton("Zoom in"));
    });
    const applied = appliedViews(props);
    expect(applied).toHaveLength(1);
    expect(cameraOf(applied[0]).distance).toBeCloseTo(50);
  });

  it("disables a nudge whose move the generator does not offer (Rotate on a 2D view)", async () => {
    // A 2D slice view offers no azimuth cells, so the Rotate buttons disable.
    await renderPanel({ captureBuilder: () => sliceView() });
    expect(
      (screen.getByTestId("explore-rotate-right") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("explore-rotate-left") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(nudgeButton("Zoom in").disabled).toBe(false);
  });

  it("Back is disabled until a descend happens, then enabled, and applies the previous view", async () => {
    const props = await renderPanel();
    const back = () => screen.getByTestId("explore-back") as HTMLButtonElement;
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
    const applied = appliedViews(props);
    // 1st apply = descend (a quarter turn); 2nd = back (theta 0).
    expect(applied).toHaveLength(2);
    expect(applied[1].camera).toMatchObject({ theta: 0 });
    expect(back().disabled).toBe(true);
  });

  it("a manual nudge pushes onto the Back stack, so Back returns to the pre-nudge view", async () => {
    // captureBuilder returns the pre-nudge view; after a Rotate nudge, Back must
    // re-apply that view, not the nudge's child.
    const props = await renderPanel();
    const back = () => screen.getByTestId("explore-back") as HTMLButtonElement;
    expect(back().disabled).toBe(true);

    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-rotate-right"));
    });
    // The nudge descended and enabled Back.
    expect(back().disabled).toBe(false);

    await act(async () => {
      await userEvent.click(back());
    });
    const applied = appliedViews(props);
    // 1st apply = the nudge's child; 2nd = Back → the pre-nudge view.
    expect(applied).toHaveLength(2);
    expect(cameraOf(applied[0]).theta).toBeCloseTo(QUARTER_TURN);
    expect(applied[1].camera).toMatchObject({ theta: 0 });
    // Stack drained → Back disabled again.
    expect(back().disabled).toBe(true);
  });
});

describe("ExplorationPanel — breadcrumb trail (proof of navigation)", () => {
  it("starts at Home, pushes the cell label on descend, and pops on Back", async () => {
    await renderPanel();
    const crumb = () => screen.getByTestId("explore-breadcrumb").textContent ?? "";
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

  it("passes the breadcrumb depth into the generator", async () => {
    await renderPanel();
    // Initial refresh: depth 0.
    const depthArg = (call: unknown[]) => call[4] as number;
    expect(depthArg(explore.mock.calls[0])).toBe(0);
    explore.mockClear();

    // After one descend the trail has length 1 → the next generate uses depth 1.
    await act(async () => {
      await userEvent.click(cellByLabel("Rotate right 45°"));
    });
    expect(depthArg(explore.mock.calls.at(-1)!)).toBe(1);
  });
});

describe("ExplorationPanel — you-are-here readout reveals the axes", () => {
  it("shows azimuth + Z, T counted from 1, and the composite when the dataset has several channels", async () => {
    // A 40-timepoint, 3-channel volume: the readout must show T and the
    // channels exist. Home shows the composite.
    await renderPanel({ dims: [40, 3, 340, 512, 512] });
    const here = screen.getByTestId("explore-here").textContent ?? "";
    expect(here).toMatch(/3D/);
    expect(here).toMatch(/az \d+°/);
    expect(here).toMatch(/Z \d+\/340/);
    expect(here).toMatch(/T 1\/40/);
    expect(here).toMatch(/composite/);
  });

  it("reads the channel of the dataset in hand, not another layer's solo", async () => {
    const layer = {
      visible: true, opacity: 1, contrast_min: 0, contrast_max: 65535, gamma: 1, blend_mode: "alpha",
    };
    const view = {
      ...arcballView(),
      dataset_order: ["ds-1", "ds-2"],
      dataset_settings: { "ds-1": layer, "ds-2": { ...layer, solo: 1 } },
    } as unknown as SavedView;
    await renderPanel({ dims: [1, 3, 340, 512, 512], captureBuilder: () => view });
    expect(screen.getByTestId("explore-here").textContent).toMatch(/composite/);
    // From the composite, the next channel solos this layer's first.
    expect(cellByLabel("Next channel")).toBeTruthy();
    expect(screen.queryAllByTestId("explore-cell").some((el) => within(el).queryByText("Previous channel"))).toBe(false);
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
  it("asks for a name and saves a personal view", async () => {
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-bookmark"));
    });
    const dialog = await screen.findByRole("dialog", { name: /bookmark this view/i });
    const name = within(dialog).getByTestId("explore-bookmark-name");
    await act(async () => {
      await userEvent.clear(name);
      await userEvent.type(name, "My spot{Enter}");
    });
    expect(props.createSavedView).toHaveBeenCalledTimes(1);
    const [saved, , visibility] = (props.createSavedView as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(saved).toBe("My spot");
    expect(visibility).toBe("personal");
  });

  it("cancelling the dialog does not save", async () => {
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-bookmark"));
    });
    const dialog = await screen.findByRole("dialog", { name: /bookmark this view/i });
    await act(async () => {
      await userEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(props.createSavedView).not.toHaveBeenCalled();
  });
});

describe("ExplorationPanel — Home", () => {
  it("explores the live view of the panel's dataset on its canvas", async () => {
    await renderPanel();
    const [viewJson, id, width, height] = explore.mock.calls.at(-1)!;
    expect(JSON.parse(viewJson!)).toEqual(arcballView());
    expect([id, width, height]).toEqual(["ds-1", 800, 600]);
  });

  it("applies the generator's Home move from the live view, framing the world box", async () => {
    const props = await renderPanel();
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-home"));
    });
    // The live view went in, so the Home move keeps its camera mode and
    // frames the dataset in the space that camera works in.
    const [home] = appliedViews(props);
    expect(home.camera.mode).toBe("arcball");
    const b = pageScene("arcball").dataset_fit_bounds("ds-1");
    const target = (home.camera as { target: number[] }).target;
    for (let axis = 0; axis < 3; axis++) {
      expect(target[axis]).toBeCloseTo((b[axis] + b[axis + 3]) / 2);
    }
  });
});

describe("ExplorationPanel — Home on a page", () => {
  /** The page after Home: `f` opened and fitted in `mode` on a real scene, the
   *  panel wired as the viewer wires it, Home pressed. `live` false is a page
   *  whose capture is unavailable, so the generator synthesizes Home. */
  async function afterHome(
    f: ViewFixture,
    vp: Viewport,
    dpr: number,
    mode: "slice" | "arcball",
    live: boolean,
  ): Promise<WasmScene> {
    const page = openedScene(f, vp, dpr, mode);
    const applier = new SavedViewApplier(
      { sendOpenRemoteDataset: () => {}, sendCommand: () => {} },
      () => page,
      (url) => url,
      1000,
      "workspace-dataset-id",
      "local",
    );
    const capture = () =>
      buildCapture({ scene: page, urlByDatasetId: new Map(), datasetReferenceMode: "workspace-dataset-id" });
    await renderPanel({
      captureBuilder: live ? capture : () => null,
      applyView: async (view) => {
        await applier.apply(view);
      },
      datasetId: datasetId(f),
      dims: fixtureDims(f),
      // The viewer passes the canvas's client size, in CSS pixels.
      viewport: vp.css,
      getScene: () => page,
    });
    await act(async () => {
      await userEvent.click(screen.getByTestId("explore-home"));
    });
    cleanup();
    return page;
  }

  /** Whether Home frames every fixture, and whether it shows each at one CSS
   *  size at both ratios. */
  async function homeReports(
    live: boolean,
  ): Promise<{ framed: PropertyReport; sized: PropertyReport }> {
    const framed = new PropertyReport();
    const sized = new PropertyReport();
    for (const f of FIXTURES) {
      const id = datasetId(f);
      for (const vp of VIEWPORTS) {
        for (const mode of ["slice", "arcball"] as const) {
          const pages: WasmScene[] = [];
          for (const dpr of PIXEL_RATIOS) {
            const page = await afterHome(f, vp, dpr, mode, live);
            framed.check(`${f.name} on ${vp.name} ${dpr}x, from ${mode}`, notFramed(page, id));
            pages.push(page);
          }
          sized.check(
            `${f.name} on ${vp.name}, from ${mode}`,
            cssSizesDiffer(cssSize(pages[0], id, 1), cssSize(pages[1], id, 2)),
          );
        }
      }
    }
    return { framed, sized };
  }

  it("frames the dataset from the live view", async () => {
    const { framed, sized } = await homeReports(true);
    framed.assertHolds();
    sized.assertHolds();
  });

  // The panel fits the synthesized Home to the canvas in CSS pixels, and the
  // page fits that region to its canvas in device pixels.
  it("shows the synthesized Home at one CSS size at both pixel ratios", async () => {
    (await homeReports(false)).sized.assertHolds();
  });

  it("frames the dataset when the generator synthesizes Home", async () => {
    (await homeReports(false)).framed.assertHolds();
  });
});

describe("ExplorationPanel — preview thumbnails", () => {
  // A controllable IntersectionObserver, so a test decides when a row scrolls
  // into view. The panel must not request a render before then.
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

  function scrollAllIntoView() {
    for (const { cb, el, obs } of observed) {
      cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], obs);
    }
  }

  beforeEach(() => {
    installControllableIO();
  });

  /** happy-dom has no `ImageBitmap`. The panel only calls `close()` and a
   *  `drawImage` guarded on a 2d context happy-dom returns null for. */
  function fakeBitmap(): ImageBitmap {
    return { width: 8, height: 8, close: vi.fn() } as unknown as ImageBitmap;
  }

  it("does NOT request a thumbnail until the row scrolls into view (lazy)", async () => {
    const requestThumbnail = vi.fn(async () => fakeBitmap());
    await renderPanel({ requestThumbnail });
    // Rows are mounted and observed, but nothing is requested yet.
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
    // The rotate-right cell is a quarter turn round: the tile renders from its
    // own angle, not the current view's.
    const views = (requestThumbnail as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as SavedView,
    );
    const thetas = views.map((v) => cameraOf(v).theta);
    expect(thetas.some((theta) => Math.abs(theta - QUARTER_TURN) < 1e-9)).toBe(true);
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
    // The label is still present, and the failed thumbnail box unmounts.
    expect(cellByLabel("Rotate right 45°")).toBeTruthy();
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

  it("hides previews (and stops requesting) when 'Show previews' is unchecked", async () => {
    const requestThumbnail = vi.fn(async () => fakeBitmap());
    await renderPanel({ requestThumbnail });
    // Toggle previews off before revealing rows.
    await act(async () => {
      await userEvent.click(
        within(screen.getByTestId("explore-previews-toggle")).getByRole("switch"),
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

  it("requests no previews for 2D candidates, which would all look alike", async () => {
    const requestThumbnail = vi.fn(async () => fakeBitmap());
    await renderPanel({ captureBuilder: () => sliceView(), requestThumbnail });
    await act(async () => {
      scrollAllIntoView();
    });
    expect(requestThumbnail).not.toHaveBeenCalled();
    expect(screen.queryByTestId("explore-thumb")).toBeNull();
    expect(screen.queryByTestId("explore-previews-toggle")).toBeNull();
  });
});
