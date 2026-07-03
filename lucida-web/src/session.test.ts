import { describe, it, expect, vi } from "vitest";
import { Session } from "./session.ts";
import type { Bridge } from "./bridge.ts";
import type { ProxiedContentSource, CpuCache, DecodePool } from "./pipeline/fetch/index.ts";

function makeSession() {
  const bridge = { destroy: vi.fn() };
  const contentSource = { rejectAll: vi.fn() };
  const cpuCache = { reset: vi.fn() };
  const decodePool = { terminate: vi.fn() };
  const session = new Session({
    bridge: bridge as unknown as Bridge,
    contentSource: contentSource as unknown as ProxiedContentSource,
    cpuCache: cpuCache as unknown as CpuCache,
    decodePool: decodePool as unknown as DecodePool,
  });
  return { session, bridge, contentSource, cpuCache, decodePool };
}

describe("Session.destroy", () => {
  it("releases every owned resource: bridge, cache, content source, decode pool", () => {
    const { session, bridge, contentSource, cpuCache, decodePool } = makeSession();

    session.destroy();

    expect(bridge.destroy).toHaveBeenCalledTimes(1);
    expect(cpuCache.reset).toHaveBeenCalledTimes(1);
    expect(contentSource.rejectAll).toHaveBeenCalledTimes(1);
    expect(decodePool.terminate).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a second destroy releases nothing twice", () => {
    const { session, bridge, contentSource, cpuCache, decodePool } = makeSession();

    session.destroy();
    session.destroy();

    expect(bridge.destroy).toHaveBeenCalledTimes(1);
    expect(cpuCache.reset).toHaveBeenCalledTimes(1);
    expect(contentSource.rejectAll).toHaveBeenCalledTimes(1);
    expect(decodePool.terminate).toHaveBeenCalledTimes(1);
  });
});
