import { snapshotProxyFootprint } from "../assetCatalog.ts";
import type { PlanningConfig } from "./config.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  FieldSnapshot,
  PlanningSnapshot,
  ProxyRequest,
} from "./types.ts";

const FALLBACK_PROXY_BYTES = 1 * 128 * 128 * 2;

type ProxyRepresentation = "field" | "well";

interface ProxyResidencyGroup {
  snapshot: PlanningSnapshot;
  datasetId: string;
  wellId: string;
  t: number;
  fields: FieldSnapshot[];
  well: EntitySnapshot | null;
  fieldRequests: ProxyRequest[];
  wellRequests: ProxyRequest[];
}

interface ProxyBundleCandidate {
  groupKey: string;
  datasetId: string;
  wellId: string;
  representation: ProxyRepresentation;
  requests: ProxyRequest[];
  proxyKeys: string[];
  bytes: number;
  score: number;
  tieBreak: string;
  missingFootprints: number;
}

export interface ProxyResidencyBundleDecision {
  datasetId: string;
  wellId: string;
  representation: ProxyRepresentation;
  proxyKeys: string[];
  bytes: number;
  score: number;
  reason: "admitted" | "over-budget" | "replaced";
}

export interface ProxyResidencyStats {
  budgetBytes: number;
  admittedBytes: number;
  desiredProxyCount: number;
  candidateBundleCount: number;
  admittedBundleCount: number;
  skippedBundleCount: number;
  skippedProxyCount: number;
  missingFootprintCount: number;
}

export interface ProxyResidencyPlan {
  desiredProxyKeys: Set<string>;
  admittedProxyRequests: ProxyRequest[];
  skippedProxyRequests: ProxyRequest[];
  decisions: ProxyResidencyBundleDecision[];
  stats: ProxyResidencyStats;
}

export interface ProxyResidencyInput {
  snapshot: PlanningSnapshot;
  activeSet: ActiveSetEntry[];
  proxyRequests: ProxyRequest[];
}

export function proxyRequestKey(req: ProxyRequest): string {
  return `${req.datasetId}|${req.entityId}|${req.kind}|${req.t}|${req.c}`;
}

export function planProxyResidency({
  snapshot,
  activeSet,
  proxyRequests,
  config,
}: {
  snapshot: PlanningSnapshot;
  activeSet: ActiveSetEntry[];
  proxyRequests: ProxyRequest[];
  config: PlanningConfig;
}): ProxyResidencyPlan {
  return planProxyResidencyForInputs({
    inputs: [{ snapshot, activeSet, proxyRequests }],
    config,
  });
}

export function planProxyResidencyForInputs({
  inputs,
  config,
}: {
  inputs: ProxyResidencyInput[];
  config: PlanningConfig;
}): ProxyResidencyPlan {
  const budgetBytes = Math.max(0, config.proxyResidencyBudgetBytes);
  const groups = inputs.flatMap((input) =>
    buildGroups(input.snapshot, input.activeSet, input.proxyRequests),
  );
  const candidates = buildCandidates(groups, config);
  candidates.sort(compareCandidates);

  const desiredProxyKeys = new Set<string>();
  const admittedProxyRequests: ProxyRequest[] = [];
  const skippedProxyRequests: ProxyRequest[] = [];
  const decisions: ProxyResidencyBundleDecision[] = [];
  const admittedGroups = new Set<string>();
  let admittedBytes = 0;
  let missingFootprintCount = 0;

  for (const candidate of candidates) {
    missingFootprintCount += candidate.missingFootprints;

    if (admittedGroups.has(candidate.groupKey)) {
      skippedProxyRequests.push(...candidate.requests);
      decisions.push(decisionFor(candidate, "replaced"));
      continue;
    }

    if (admittedBytes + candidate.bytes > budgetBytes) {
      skippedProxyRequests.push(...candidate.requests);
      decisions.push(decisionFor(candidate, "over-budget"));
      continue;
    }

    admittedGroups.add(candidate.groupKey);
    admittedBytes += candidate.bytes;
    admittedProxyRequests.push(...candidate.requests);
    for (const key of candidate.proxyKeys) desiredProxyKeys.add(key);
    decisions.push(decisionFor(candidate, "admitted"));
  }

  const skippedBundleCount = decisions.filter((d) => d.reason !== "admitted").length;

  return {
    desiredProxyKeys,
    admittedProxyRequests,
    skippedProxyRequests,
    decisions,
    stats: {
      budgetBytes,
      admittedBytes,
      desiredProxyCount: desiredProxyKeys.size,
      candidateBundleCount: candidates.length,
      admittedBundleCount: admittedGroups.size,
      skippedBundleCount,
      skippedProxyCount: skippedProxyRequests.length,
      missingFootprintCount,
    },
  };
}

function buildGroups(
  snapshot: PlanningSnapshot,
  activeSet: ActiveSetEntry[],
  proxyRequests: ProxyRequest[],
): ProxyResidencyGroup[] {
  const entityById = new Map<string, EntitySnapshot>();
  for (const entity of snapshot.entities) entityById.set(entity.entityId, entity);

  const activeFieldById = new Map<string, FieldSnapshot>();
  const activeWellById = new Map<string, EntitySnapshot>();
  for (const entry of activeSet) {
    if (entry.kind === "field") {
      const entity = entityById.get(entry.entityId);
      if (entity?.kind === "Field") activeFieldById.set(entity.entityId, entity);
      if (entity !== undefined && entity.kind !== "Field") {
        activeWellById.set(entity.entityId, entity);
      }
    } else if (entry.kind === "well-as-proxy") {
      const entity = entityById.get(entry.entityId);
      if (entity !== undefined) activeWellById.set(entity.entityId, entity);
    }
  }

  const groups = new Map<string, ProxyResidencyGroup>();
  const getGroup = (datasetId: string, wellId: string, t: number): ProxyResidencyGroup => {
    const key = groupKey(datasetId, wellId, t);
    let group = groups.get(key);
    if (!group) {
      group = {
        snapshot,
        datasetId,
        wellId,
        t,
        fields: [],
        well: activeWellById.get(wellId) ?? entityById.get(wellId) ?? null,
        fieldRequests: [],
        wellRequests: [],
      };
      groups.set(key, group);
    }
    return group;
  };

  for (const req of proxyRequests) {
    const entity = entityById.get(req.entityId);
    const wellId = wellIdForRequest(req, entity);
    const group = getGroup(req.datasetId, wellId, req.t);
    if (req.kind === "FieldProxy3D") {
      group.fieldRequests.push(req);
      if (entity?.kind === "Field" && !group.fields.some((f) => f.entityId === entity.entityId)) {
        group.fields.push(entity);
      } else {
        const activeField = activeFieldById.get(req.entityId);
        if (activeField && !group.fields.some((f) => f.entityId === activeField.entityId)) {
          group.fields.push(activeField);
        }
      }
    } else {
      group.wellRequests.push(req);
      group.well = entity ?? group.well;
    }
  }

  return [...groups.values()];
}

function buildCandidates(groups: ProxyResidencyGroup[], config: PlanningConfig): ProxyBundleCandidate[] {
  const out: ProxyBundleCandidate[] = [];
  for (const group of groups) {
    if (group.fieldRequests.length > 0) {
      out.push(buildCandidate(group, "field", group.fieldRequests, config));
    }
    if (group.wellRequests.length > 0) {
      out.push(buildCandidate(group, "well", group.wellRequests, config));
    }
  }
  return out;
}

function buildCandidate(
  group: ProxyResidencyGroup,
  representation: ProxyRepresentation,
  requests: ProxyRequest[],
  config: PlanningConfig,
): ProxyBundleCandidate {
  const proxyKeys = requests.map(proxyRequestKey);
  let bytes = 0;
  let missingFootprints = 0;
  for (const req of requests) {
    const footprint = group.snapshot.assetCatalog
      ? snapshotProxyFootprint(group.snapshot.assetCatalog, req.entityId, req.kind)
      : null;
    if (footprint) {
      bytes += footprint.bytes;
    } else {
      bytes += FALLBACK_PROXY_BYTES;
      missingFootprints += 1;
    }
  }

  const entities = representativeEntities(group, representation);
  const importance = maxImportance(entities);
  const distance = nearestDistanceFromViewCenter(group.snapshot, entities);
  const representationBias = representation === "field" ? 0 : 1;
  const score =
    representationBias +
    (1 - importance) * config.importanceWeight +
    distance * config.distanceWeight;

  return {
    groupKey: groupKey(group.datasetId, group.wellId, group.t),
    datasetId: group.datasetId,
    wellId: group.wellId,
    representation,
    requests,
    proxyKeys,
    bytes,
    score,
    tieBreak: `${group.datasetId}|${group.wellId}|${representation}`,
    missingFootprints,
  };
}

function representativeEntities(
  group: ProxyResidencyGroup,
  representation: ProxyRepresentation,
): EntitySnapshot[] {
  if (representation === "field" && group.fields.length > 0) return group.fields;
  if (group.well) return [group.well];
  return group.fields;
}

function maxImportance(entities: EntitySnapshot[]): number {
  if (entities.length === 0) return 0;
  return Math.max(...entities.map((entity) => entity.importance));
}

function nearestDistanceFromViewCenter(
  snapshot: PlanningSnapshot,
  entities: EntitySnapshot[],
): number {
  if (entities.length === 0) return 0;
  const center = snapshot.visibleRegion.sortCenterVox ?? [
    (snapshot.visibleRegion.xyBoundsVox[0] + snapshot.visibleRegion.xyBoundsVox[2]) / 2,
    (snapshot.visibleRegion.xyBoundsVox[1] + snapshot.visibleRegion.xyBoundsVox[3]) / 2,
    (snapshot.visibleRegion.zRangeVox[0] + snapshot.visibleRegion.zRangeVox[1]) / 2,
  ];

  let best = Number.POSITIVE_INFINITY;
  for (const entity of entities) {
    const x = entity.layoutPositionVox[0] + entity.centroidWorld[0];
    const y = entity.layoutPositionVox[1] + entity.centroidWorld[1];
    const z = entity.centroidWorld[2];
    const dx = x - center[0];
    const dy = y - center[1];
    const dz = z - center[2];
    best = Math.min(best, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return best;
}

function compareCandidates(a: ProxyBundleCandidate, b: ProxyBundleCandidate): number {
  const score = a.score - b.score;
  if (score !== 0) return score;
  return a.tieBreak.localeCompare(b.tieBreak);
}

function decisionFor(
  candidate: ProxyBundleCandidate,
  reason: ProxyResidencyBundleDecision["reason"],
): ProxyResidencyBundleDecision {
  return {
    datasetId: candidate.datasetId,
    wellId: candidate.wellId,
    representation: candidate.representation,
    proxyKeys: [...candidate.proxyKeys],
    bytes: candidate.bytes,
    score: candidate.score,
    reason,
  };
}

function wellIdForRequest(req: ProxyRequest, entity: EntitySnapshot | undefined): string {
  if (req.kind === "WellProxy3D") return req.entityId;
  if (entity?.kind === "Field") return entity.parentId;
  return req.entityId;
}

function groupKey(datasetId: string, wellId: string, t: number): string {
  return `${datasetId}|${wellId}|${t}`;
}
