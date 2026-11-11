/**
 * Four-up's planes follow the tile the pointer was last over, read from the
 * scene only once it or the tile moved, and a drag on that tile names the
 * position every tile shares.
 */
import { describe, expect, it, vi } from "vitest";
import { FourUpPlanes } from "./planeLines.ts";

const T0 = '{"dataset":"d","entity":"t0"}';
const T4 = '{"dataset":"d","entity":"t4"}';

function fixture() {
  let epochs = { view: 0 };
  const listeners = new Set<() => void>();
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getEpochs: () => epochs as never,
  };
  const under = new Map<string, string>([["0.2,0.2", T0], ["0.8,0.8", T4]]);
  const scene = {
    tile_at: vi.fn((_view: number, x: number, y: number) => under.get(`${x},${y}`) ?? "null"),
    plane_lines: vi.fn((view: number, tile?: string | null) =>
      JSON.stringify([{ axis: "x", from: [tile === T4 ? 0.8 : 0.2, 0], to: [tile === T4 ? 0.8 : 0.2, 1] }, { view }])),
    plane_line_position: vi.fn((_view: number, _axis: string, fraction: number, tile?: string | null) =>
      BigInt(Math.round(fraction * 10) + (tile === T4 ? -6 : 0))),
  };
  const moveScene = () => {
    epochs = { view: epochs.view + 1 };
    for (const listener of [...listeners]) listener();
  };
  return { planes: new FourUpPlanes(scene, store), scene, moveScene };
}

describe("four-up's planes", () => {
  it("stand on the first tile until the pointer is over one, and keep the last outside every tile", () => {
    const { planes, scene } = fixture();
    const changed = vi.fn();
    planes.subscribe(changed);
    expect(planes.linesOf(0)[0].from[0]).toBe(0.2);
    expect(scene.plane_lines).toHaveBeenLastCalledWith(0, null);

    planes.hover(0, [0.8, 0.8]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(planes.linesOf(0)[0].from[0]).toBe(0.8);
    // Within the tile, and off every tile, nothing moves.
    planes.hover(0, [0.8, 0.8]);
    planes.hover(0, [0.5, 0.5]);
    expect(scene.tile_at).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(planes.linesOf(3)[0].from[0]).toBe(0.8);

    planes.forget();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(planes.linesOf(0)[0].from[0]).toBe(0.2);
  });

  it("read a view's lines again only once the scene or the tile moved", () => {
    const { planes, scene, moveScene } = fixture();
    const first = planes.linesOf(1);
    expect(planes.linesOf(1)).toBe(first);
    expect(scene.plane_lines).toHaveBeenCalledTimes(1);
    // A scene write that leaves the lines where they were keeps them.
    moveScene();
    expect(planes.linesOf(1)).toBe(first);
    expect(scene.plane_lines).toHaveBeenCalledTimes(2);
    planes.hover(1, [0.8, 0.8]);
    expect(planes.linesOf(1)).not.toBe(first);
    expect(scene.plane_lines).toHaveBeenLastCalledWith(1, T4);
  });

  it("name the position a drag on the followed tile sets", () => {
    const { planes, scene } = fixture();
    expect(planes.positionAt(0, "x", 0.5)).toBe(5);
    planes.hover(0, [0.8, 0.8]);
    expect(planes.positionAt(0, "x", 0.9)).toBe(3);
    expect(scene.plane_line_position).toHaveBeenLastCalledWith(0, "x", 0.9, T4);
    scene.plane_line_position.mockReturnValueOnce(-1n);
    expect(planes.positionAt(0, "z", 0.5)).toBeNull();
  });
});
