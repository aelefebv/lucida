import type { RendererState } from "../worker/state.ts";
import type { ColdStateMessage, ProxyAssetDataMessage } from "../workerProtocol.ts";
import { proxyDescriptorKey } from "../workerContext.ts";
import type { ProxyHandle, ProxyKind } from "../proxyAtlas.ts";
import { releaseProxySlot } from "../proxyAtlas.ts";

export type ProxyDeliveryPolicy =
  | { kind: "accept" }
  | { kind: "not-desired" }
  | { kind: "stale-request"; desired: boolean };

export function proxyResidencyKey(
  datasetId: string,
  entityId: string,
  proxyKind: ProxyKind,
  t: number,
  c: number,
): string {
  return `${datasetId}|${entityId}|${proxyKind}|${t}|${c}`;
}

/**
 * Check a proxy delivery against the current desired residency policy.
 * Missing `desiredProxyKeys` preserves the legacy "all advertised proxies
 * are desired" behavior; an empty array means "no proxies are desired".
 */
export function evaluateProxyDeliveryPolicy(
  coldState: ColdStateMessage | null,
  msg: ProxyAssetDataMessage,
): ProxyDeliveryPolicy {
  if (!coldState || coldState.datasetId !== msg.datasetId) return { kind: "accept" };
  if (coldState.desiredProxyKeys === undefined) return { kind: "accept" };

  const desired = coldState.desiredProxyKeys.includes(
    proxyResidencyKey(msg.datasetId, msg.entityId, msg.kind, msg.t, msg.c),
  );
  if (!desired) return { kind: "not-desired" };
  if (msg.epochs.request < coldState.epochs.request) {
    return { kind: "stale-request", desired: true };
  }
  return { kind: "accept" };
}

export function desiredProxyCountForPool(
  coldState: ColdStateMessage | null,
  datasetId: string,
  proxyKind: ProxyKind,
  c: number,
): number | null {
  if (!coldState || coldState.datasetId !== datasetId) return null;
  if (coldState.desiredProxyKeys === undefined) return null;

  let count = 0;
  for (const key of coldState.desiredProxyKeys) {
    const parsed = parseProxyResidencyKey(key);
    if (!parsed) continue;
    if (
      parsed.datasetId === datasetId &&
      parsed.proxyKind === proxyKind &&
      parsed.c === c
    ) {
      count++;
    }
  }
  return count;
}

export function clearResidentProxyDescriptor(
  state: RendererState,
  poolKey: string,
  proxyKind: ProxyKind,
  slotKey: string,
  slotIndex: number,
): boolean {
  const parsed = parseProxySlotKey(slotKey);
  if (!parsed) return false;
  return clearProxyDescriptorHandle(
    state,
    parsed.entityId,
    parsed.t,
    parsed.c,
    proxyKind,
    { poolKey, slotIndex },
  );
}

/**
 * Reconcile resident proxy slots for one dataset against the current
 * budget-admitted desired set. Returns the number of slots released.
 */
export function reconcileProxyResidency(
  state: RendererState,
  datasetId: string,
  desiredProxyKeys: Iterable<string>,
): number {
  const desired = new Set(desiredProxyKeys);
  const dsPools = state.proxyPoolsByDataset.get(datasetId);
  if (!dsPools) return 0;

  let releasedCount = 0;
  for (const [poolKey, pool] of dsPools) {
    for (const [slotKey, slotIndex] of Array.from(pool.slots)) {
      const parsed = parseProxySlotKey(slotKey);
      if (!parsed) continue;
      const fullKey = proxyResidencyKey(
        datasetId,
        parsed.entityId,
        pool.kind,
        parsed.t,
        parsed.c,
      );
      if (desired.has(fullKey)) continue;

      const released = releaseProxySlot(pool, slotKey);
      if (released === undefined) continue;
      clearProxyDescriptorHandle(
        state,
        parsed.entityId,
        parsed.t,
        parsed.c,
        pool.kind,
        { poolKey, slotIndex: released ?? slotIndex },
      );
      releasedCount++;
    }
  }
  return releasedCount;
}

function clearProxyDescriptorHandle(
  state: RendererState,
  entityId: string,
  t: number,
  c: number,
  proxyKind: ProxyKind,
  expectedHandle: ProxyHandle,
): boolean {
  if (proxyKind === "TileProxy3D") {
    return clearDescriptorTileHandle(state, entityId, t, c, expectedHandle);
  }

  let changed = clearDescriptorGroupHandle(state, entityId, t, c, expectedHandle);
  const childTiles = state.groupToTiles.get(entityId);
  if (childTiles) {
    for (const tileId of childTiles) {
      changed = clearDescriptorGroupHandle(state, tileId, t, c, expectedHandle) || changed;
    }
  }
  return changed;
}

function clearDescriptorTileHandle(
  state: RendererState,
  entityId: string,
  t: number,
  c: number,
  expectedHandle: ProxyHandle,
): boolean {
  const desc = state.proxyDescriptorsByEntity.get(proxyDescriptorKey(entityId, t, c));
  if (!desc || !handleMatches(desc.tileProxyHandle, expectedHandle)) return false;
  desc.tileProxyHandle = null;
  return true;
}

function clearDescriptorGroupHandle(
  state: RendererState,
  entityId: string,
  t: number,
  c: number,
  expectedHandle: ProxyHandle,
): boolean {
  const desc = state.proxyDescriptorsByEntity.get(proxyDescriptorKey(entityId, t, c));
  if (!desc || !handleMatches(desc.groupProxyHandle, expectedHandle)) return false;
  desc.groupProxyHandle = null;
  return true;
}

function handleMatches(
  actual: ProxyHandle | null,
  expected: ProxyHandle,
): boolean {
  return (
    actual !== null &&
    actual.poolKey === expected.poolKey &&
    actual.slotIndex === expected.slotIndex
  );
}

function parseProxySlotKey(
  slotKey: string,
): { entityId: string; t: number; c: number } | null {
  const parts = slotKey.split("|");
  if (parts.length < 3) return null;
  const cRaw = parts.pop()!;
  const tRaw = parts.pop()!;
  const c = Number(cRaw);
  const t = Number(tRaw);
  if (!Number.isInteger(t) || !Number.isInteger(c)) return null;
  return { entityId: parts.join("|"), t, c };
}

function parseProxyResidencyKey(
  key: string,
): { datasetId: string; entityId: string; proxyKind: ProxyKind; t: number; c: number } | null {
  const parts = key.split("|");
  if (parts.length < 5) return null;
  const cRaw = parts.pop()!;
  const tRaw = parts.pop()!;
  const kindRaw = parts.pop()!;
  const datasetId = parts.shift()!;
  const c = Number(cRaw);
  const t = Number(tRaw);
  if ((kindRaw !== "GroupProxy3D" && kindRaw !== "TileProxy3D") || !Number.isInteger(t) || !Number.isInteger(c)) {
    return null;
  }
  return {
    datasetId,
    entityId: parts.join("|"),
    proxyKind: kindRaw,
    t,
    c,
  };
}
