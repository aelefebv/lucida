/**
 * A tick plans every view once and draws each in its own mode. A lone view
 * draws straight onto the canvas; views that divide it each draw their own
 * frame, and one present lands them all. A camera move redraws only the view
 * that moved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TickContext, TickView } from "./renderLoopTypes.ts";

const rendered: Array<[string, number]> = [];

vi.mock("./slicePath.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./slicePath.ts")>()),
  renderSliceView: (_ctx: unknown, _plan: unknown, _layers: unknown, view: TickView) => rendered.push(["slice", view.id]),
}));
vi.mock("./volumePath.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./volumePath.ts")>()),
  renderVolumeView: (_ctx: unknown, _plan: unknown, _layers: unknown, view: TickView) => rendered.push(["volume", view.id]),
}));
vi.mock("./resolvedLayers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolvedLayers.ts")>()),
  readResolvedLayers: () => new Map(),
}));

import { tickViews, ViewRedraws } from "./viewTick.ts";

const LEFT: TickView = { id: 0, mode: "volume", rect: [0, 0, 400, 600] };
const RIGHT: TickView = { id: 1, mode: "slice", rect: [400, 0, 400, 600] };

function makeCtx(views: TickView[]) {
  const camera = new Map<number, number>([[0, 1], [1, 1]]);
  const epochs = { content: 1, layout: 1, view: 1, selection: 1 };
  const client = {
    resize: vi.fn(),
    presentViews: vi.fn(),
  };
  const scene = {
    epochs: () => JSON.stringify(epochs),
    zoom: (view: number) => camera.get(view),
    center: () => [0, 0],
    slice_plane: () => "xy",
    inv_view_proj: (view: number) => [camera.get(view)],
    clip_distance: () => 0,
    clip_mode: () => "none",
    dataset_holder: () => 0,
    set_viewport: vi.fn(),
  };
  const ctx = {
    scene,
    client,
    canvas: { clientWidth: 800, clientHeight: 600 },
    views,
    renderScale: 1,
    resolutionScale: 1,
  } as unknown as TickContext;
  const coordinator = {
    planAndFetch: () => ({ layers: new Map(), memberRoster: new Map(), entityIndexByDataset: new Map() }),
    msUntilUploadsResume: () => null,
  };
  const uploader = { deliverToWorker: vi.fn(() => false), holdDelivery: vi.fn() };
  return { ctx, client, camera, epochs, coordinator, uploader };
}

type Harness = ReturnType<typeof makeCtx>;

function tick(h: Harness, redraws: ViewRedraws, newChunks = false): boolean {
  return tickViews(
    h.ctx,
    h.coordinator as never,
    h.uploader as never,
    new Map(),
    redraws,
    { render: true, newChunks },
  );
}

beforeEach(() => {
  rendered.length = 0;
  vi.stubGlobal("devicePixelRatio", 1);
});

describe("a tick of every view", () => {
  it("draws a lone view straight onto the canvas, with no present", () => {
    const h = makeCtx([{ ...LEFT, mode: "slice", rect: [0, 0, 800, 600] }]);
    tick(h, new ViewRedraws());
    expect(rendered).toEqual([["slice", 0]]);
    expect(h.client.resize).toHaveBeenCalledWith(800, 600);
    expect(h.client.presentViews).not.toHaveBeenCalled();
  });

  it("draws each view in its own mode, then lands them all in one present", () => {
    const h = makeCtx([LEFT, RIGHT]);
    tick(h, new ViewRedraws());
    expect(rendered).toEqual([["volume", 0], ["slice", 1]]);
    expect(h.client.presentViews).toHaveBeenCalledWith(800, 600, [
      { view: 0, rect: [0, 0, 400, 600] },
      { view: 1, rect: [400, 0, 400, 600] },
    ]);
  });

  it("delivers a dataset's chunks in the form of the view that holds it", () => {
    const h = makeCtx([LEFT, RIGHT]);
    tick(h, new ViewRedraws());
    const [, , cutFor] = h.uploader.deliverToWorker.mock.calls[0] as unknown as [unknown, unknown, (id: string) => unknown];
    // The volume view holds it, so no cut: the whole chunk goes.
    expect(cutFor("a")).toBeNull();
  });
});

describe("which views a frame redraws", () => {
  it("redraws only the view whose camera moved, and every view for anything else", () => {
    const h = makeCtx([LEFT, RIGHT]);
    const redraws = new ViewRedraws();
    tick(h, redraws);
    rendered.length = 0;

    // Nothing moved: both keep their frames, and the present lands them again.
    tick(h, redraws);
    expect(rendered).toEqual([]);
    expect(h.client.presentViews).toHaveBeenCalledTimes(2);

    h.camera.set(1, 2);
    tick(h, redraws);
    expect(rendered).toEqual([["slice", 1]]);

    rendered.length = 0;
    tick(h, redraws, true);
    expect(rendered).toEqual([["volume", 0], ["slice", 1]]);

    rendered.length = 0;
    h.epochs.selection += 1;
    tick(h, redraws);
    expect(rendered).toEqual([["volume", 0], ["slice", 1]]);
  });
});
