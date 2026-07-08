import { describe, it, expect, vi } from "vitest";

import {
  classifySceneError,
  guardedSceneCall,
  observeSceneCalls,
  type SceneCallObserver,
} from "./sceneGuard.ts";

function makeObserver() {
  return {
    onSceneCallApplied: vi.fn<SceneCallObserver["onSceneCallApplied"]>(),
    onSceneCallFailed: vi.fn<SceneCallObserver["onSceneCallFailed"]>(),
  } satisfies SceneCallObserver;
}

describe("classifySceneError", () => {
  it("classifies wasm traps as fatal", () => {
    expect(classifySceneError(new WebAssembly.RuntimeError("unreachable"))).toBe("fatal");
  });

  it("classifies binding borrow poisoning as fatal", () => {
    expect(
      classifySceneError(
        new Error("recursive use of an object detected which would lead to unsafe aliasing in rust"),
      ),
    ).toBe("fatal");
  });

  it("classifies a freed/moved wasm handle (null pointer) as fatal", () => {
    expect(classifySceneError(new Error("null pointer passed to rust"))).toBe("fatal");
  });

  it.each([
    "data did not match any variant of untagged enum Command",
    "unknown variant `set_warp`, expected one of `set_t`, `set_c`",
    "missing field `dataset_id`",
    "invalid type: integer `5`, expected a string",
    "invalid value: -3, expected a non-negative index",
    "expected value at line 1 column 2",
    "EOF while parsing a value at line 1 column 0",
  ])("classifies parse-boundary rejections as incompatible: %s", (message) => {
    expect(classifySceneError(new Error(message))).toBe("incompatible");
  });

  it("classifies state-dependent rejections as recoverable", () => {
    expect(classifySceneError(new Error("dataset wds-1 is not loaded"))).toBe("recoverable");
    expect(classifySceneError("not even an Error")).toBe("recoverable");
  });
});

describe("guardedSceneCall", () => {
  const sceneA = { id: "scene-a" };

  it("passes the value through and reports success (with its subject) to observers", () => {
    const observer = makeObserver();
    const unobserve = observeSceneCalls(observer);
    try {
      const value = guardedSceneCall("apply_command", sceneA, () => 42);
      expect(value).toBe(42);
      expect(observer.onSceneCallApplied).toHaveBeenCalledExactlyOnceWith(
        "apply_command",
        sceneA,
      );
      expect(observer.onSceneCallFailed).not.toHaveBeenCalled();
    } finally {
      unobserve();
    }
  });

  it("rethrows the original error after reporting the failure with its subject", () => {
    const observer = makeObserver();
    const unobserve = observeSceneCalls(observer);
    try {
      const boom = new Error("state mismatch");
      expect(() =>
        guardedSceneCall("load_document", sceneA, () => {
          throw boom;
        }),
      ).toThrow(boom);
      expect(observer.onSceneCallFailed).toHaveBeenCalledExactlyOnceWith(
        boom,
        "load_document",
        sceneA,
      );
      expect(observer.onSceneCallApplied).not.toHaveBeenCalled();
    } finally {
      unobserve();
    }
  });

  it("an unsubscribed observer stops receiving outcomes", () => {
    const observer = makeObserver();
    const unobserve = observeSceneCalls(observer);
    unobserve();

    guardedSceneCall("apply_command", sceneA, () => undefined);
    expect(observer.onSceneCallApplied).not.toHaveBeenCalled();
  });

  it("an observer that throws does not disturb the guarded call or other observers", () => {
    const broken = makeObserver();
    broken.onSceneCallApplied.mockImplementation(() => {
      throw new Error("observer bug");
    });
    const healthy = makeObserver();
    const unobserveBroken = observeSceneCalls(broken);
    const unobserveHealthy = observeSceneCalls(healthy);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(guardedSceneCall("apply_command", sceneA, () => "ok")).toBe("ok");
      expect(healthy.onSceneCallApplied).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      unobserveBroken();
      unobserveHealthy();
    }
  });
});
