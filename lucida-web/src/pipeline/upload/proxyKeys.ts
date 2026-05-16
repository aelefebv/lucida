/**
 * Composite-key helpers for the proxy-delivered tracking set.
 *
 * `proxyDeliveredToWorker` keys are strings of the form
 *
 *     `${datasetId}|${entityId}|${proxyKind}|${t}|${c}`
 *
 * Three shapes feed into that map:
 *
 * - `ReadyProxyDelivery` — emitted by `CpuCache.drain()` once a proxy is
 *   decoded and ready to ship. Carries `proxyKind`.
 * - `ProxyRequest` — produced by the planner; carries `kind` (the same
 *   "WellProxy3D" / "FieldProxy3D" enum) and feeds the resend pass.
 * - `MissingProxy` — emitted by the worker's wanted-set delta when an
 *   entry got evicted; carries `proxyKind`.
 *
 * Each shape uses a slightly different field name for the proxy kind,
 * so a one-shot helper per shape keeps each call site honest about
 * which type it has without runtime branching.
 */

import type { MissingProxy } from "../../renderer/workerProtocol.ts";
import type { ProxyRequest } from "../planning/index.ts";
import type { ReadyProxyDelivery } from "../fetch/index.ts";

export function proxyKeyFromDelivery(delivery: ReadyProxyDelivery): string {
  return `${delivery.datasetId}|${delivery.entityId}|${delivery.proxyKind}|${delivery.t}|${delivery.c}`;
}

export function proxyKeyFromRequest(req: ProxyRequest): string {
  return `${req.datasetId}|${req.entityId}|${req.kind}|${req.t}|${req.c}`;
}

export function proxyKeyFromMissing(missing: MissingProxy): string {
  return `${missing.datasetId}|${missing.entityId}|${missing.proxyKind}|${missing.t}|${missing.c}`;
}
