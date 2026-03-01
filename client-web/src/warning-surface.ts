export type WarningSeverity = "info" | "warning" | "error";

export type WarningRecord = {
  warningCode:
    | "uncalibrated_overlay"
    | "computed_at_lod"
    | "stale_derived_layer"
    | "generation_build_incomplete"
    | "missing_active_layer"
    | string;
  severity: WarningSeverity;
  message: string;
};

export type WarningBadge = {
  id: string;
  label: string;
  severity: WarningSeverity;
  description: string;
};

export type LayerProvenance = {
  layerId: string;
  generationSeq: number;
  sourceGenerationSeq: number;
  computedAtLod: number | null;
  pinned: boolean;
};

export function warningToBadge(warning: WarningRecord): WarningBadge {
  const label = warningLabel(warning.warningCode);
  return {
    id: `warn:${warning.warningCode}`,
    label,
    severity: warning.severity,
    description: warning.message,
  };
}

export function buildSessionBadges(warnings: WarningRecord[]): WarningBadge[] {
  return warnings.map(warningToBadge);
}

export function buildLayerBadges(
  provenance: LayerProvenance,
  warnings: WarningRecord[],
): WarningBadge[] {
  const badges: WarningBadge[] = [];
  badges.push({
    id: `prov:generation:${provenance.layerId}`,
    label: `gen ${provenance.generationSeq.toString()}`,
    severity: "info",
    description: `Source generation ${provenance.sourceGenerationSeq.toString()}`,
  });
  if (provenance.pinned) {
    badges.push({
      id: `prov:pinned:${provenance.layerId}`,
      label: "Pinned",
      severity: "info",
      description: "Layer is pinned to a fixed generation.",
    });
  }
  if (provenance.computedAtLod !== null) {
    badges.push({
      id: `prov:lod:${provenance.layerId}`,
      label: `LOD ${provenance.computedAtLod.toString()}`,
      severity: "warning",
      description: "Layer content computed at reduced level of detail.",
    });
  }
  return badges.concat(buildSessionBadges(warnings));
}

export function buildSessionNotice(warnings: WarningRecord[]): string | null {
  if (warnings.length === 0) {
    return null;
  }
  const mostSevere = warnings.reduce<WarningRecord>((current, candidate) => {
    return severityRank(candidate.severity) > severityRank(current.severity)
      ? candidate
      : current;
  }, warnings[0] as WarningRecord);
  return `${warningLabel(mostSevere.warningCode)}: ${mostSevere.message}`;
}

function warningLabel(code: WarningRecord["warningCode"]): string {
  switch (code) {
    case "uncalibrated_overlay":
      return "Uncalibrated";
    case "computed_at_lod":
      return "Computed at LOD";
    case "stale_derived_layer":
      return "Stale derived layer";
    case "generation_build_incomplete":
      return "Generation incomplete";
    case "missing_active_layer":
      return "Missing active layer";
    default:
      return code;
  }
}

function severityRank(severity: WarningSeverity): number {
  if (severity === "error") {
    return 3;
  }
  if (severity === "warning") {
    return 2;
  }
  return 1;
}
