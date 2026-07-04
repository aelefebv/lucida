// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import type { WasmScene } from "lucida-core";
import {
  PIN_CLICK_SLOP,
  capturePointer,
  emitMoveAnnotation,
  exceedsClickSlop,
  releasePointer,
} from "./annotationInteraction.ts";

describe("exceedsClickSlop", () => {
  it("travel AT the slop is still a click (strictly-greater comparison)", () => {
    expect(exceedsClickSlop(0, 0, PIN_CLICK_SLOP, 0)).toBe(false);
    expect(exceedsClickSlop(0, 0, 0, PIN_CLICK_SLOP)).toBe(false);
  });

  it("travel past the slop is a drag", () => {
    expect(exceedsClickSlop(0, 0, PIN_CLICK_SLOP + 0.01, 0)).toBe(true);
  });

  it("measures euclidean travel, not per-axis", () => {
    // 3² + 4² = 5² > 4² — diagonal travel crosses the slop even though each
    // axis alone stays within it.
    expect(exceedsClickSlop(10, 10, 13, 14)).toBe(true);
    // 2² + 2² = 8 < 16 — a small diagonal jitter stays a click.
    expect(exceedsClickSlop(10, 10, 12, 12)).toBe(false);
  });
});

describe("capturePointer / releasePointer", () => {
  it("captures and releases through the element's pointer-capture API", () => {
    const captured: number[] = [];
    const released: number[] = [];
    const el = {
      setPointerCapture: (id: number) => captured.push(id),
      releasePointerCapture: (id: number) => released.push(id),
    } as unknown as Element;
    capturePointer(el, 7);
    releasePointer(el, 7);
    expect(captured).toEqual([7]);
    expect(released).toEqual([7]);
  });

  it("tolerates an element without the API (e.g. a bare test node)", () => {
    // A plain object standing in for a DOM node in an environment that never
    // implemented pointer capture at all.
    const el = {} as Element;
    expect(() => capturePointer(el, 1)).not.toThrow();
    expect(() => releasePointer(el, 1)).not.toThrow();
  });

  it("swallows a throwing capture/release (a browser rejecting a stale pointer)", () => {
    const el = {
      setPointerCapture: () => {
        throw new DOMException("NotFoundError");
      },
      releasePointerCapture: () => {
        throw new DOMException("NotFoundError");
      },
    } as unknown as Element;
    expect(() => capturePointer(el, 1)).not.toThrow();
    expect(() => releasePointer(el, 1)).not.toThrow();
  });
});

describe("emitMoveAnnotation", () => {
  function makeScene(): { scene: WasmScene; applied: string[] } {
    const applied: string[] = [];
    const scene = {
      apply_command: (json: string) => applied.push(json),
    } as unknown as WasmScene;
    return { scene, applied };
  }

  it("applies locally AND sends the identical JSON (apply-locally-and-send)", () => {
    const { scene, applied } = makeScene();
    const sent: string[] = [];
    emitMoveAnnotation(
      scene,
      { datasetId: "wds-1", id: "pin-a", position: [100, 100], z: 3 },
      (json) => sent.push(json),
    );
    expect(applied).toHaveLength(1);
    expect(sent).toEqual(applied);
  });

  it("a rigid move (no end) serializes with the locked field order and NO end key", () => {
    const { scene, applied } = makeScene();
    emitMoveAnnotation(scene, { datasetId: "wds-1", id: "pin-a", position: [100, 100], z: 3 }, () => {});
    expect(applied[0]).toBe(
      '{"type":"move_annotation","dataset_id":"wds-1","id":"pin-a","position":[100,100],"z":3}',
    );
  });

  it("a reshape (both vertices) serializes with end between position and z", () => {
    const { scene, applied } = makeScene();
    emitMoveAnnotation(
      scene,
      { datasetId: "wds-0f3a", id: "pin-4c1d", position: [355, 470.5], end: [465, 520.5], z: 12.5 },
      () => {},
    );
    // The exact byte shape the wire golden locks for the reshape envelope.
    expect(applied[0]).toBe(
      '{"type":"move_annotation","dataset_id":"wds-0f3a","id":"pin-4c1d","position":[355,470.5],"end":[465,520.5],"z":12.5}',
    );
  });
});
