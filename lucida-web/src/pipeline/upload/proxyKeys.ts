/**
 * Composite key for the proxy-delivered tracking set:
 *
 *     `${datasetId}|${entityId}|${proxyKind}|${t}|${c}`
 *
 * Three input shapes use slightly different field names for the proxy
 * kind, so one helper per shape keeps each call site type-honest without
 * runtime branching.
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
