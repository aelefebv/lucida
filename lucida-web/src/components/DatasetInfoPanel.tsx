/**
 * The Info rail panel: what the active dataset is, where it came from, and
 * whether it is shown as stored, and the workspace's id, each copyable where
 * someone would paste it elsewhere.
 */
import { CopyIcon } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { positionLabel } from "../axes.ts";
import type { DatasetHealthStatus, DatasetSourceHealth } from "../bridge.ts";
import type { DatasetManifest, MultiscaleInfo } from "../manifestTypes.ts";
import { channelDisplayName } from "./channels.ts";
import { healthReasons } from "./healthText.ts";
import { drawnAtFloat32Precision } from "../renderer/dataTypeUtil.ts";
import { Badge, type BadgeTone } from "../ui/Badge.tsx";
import { IconButton } from "../ui/Button.tsx";
import { PanelHeader } from "../ui/PanelHeader.tsx";
import { toast } from "../ui/toastQueue.ts";
import "./BookmarkSidebar.css";
import "./DatasetInfoPanel.css";

export interface InfoDataset {
  id: string;
  /** The name the layer list shows, which a rename may have changed. */
  name: string;
  manifest: DatasetManifest;
}

export interface DatasetInfoPanelProps {
  visible: boolean;
  workspaceId: string;
  /** The selected dataset, else the first; null with none open. */
  dataset: InfoDataset | null;
  /** The server's health for the dataset, which also names its source; null when it has none. */
  getHealth?: (datasetId: string) => Promise<DatasetSourceHealth | null>;
}

/** Level-0 shape order, as every manifest stores it. */
const AXES = ["T", "C", "Z", "Y", "X"] as const;

type HealthState =
  | { datasetId: string; status: "ready"; value: DatasetSourceHealth | null }
  | { datasetId: string; status: "failed" };

const STATUS: Record<DatasetHealthStatus, { label: string; tone: BadgeTone }> = {
  healthy: { label: "Healthy", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  unavailable: { label: "Unavailable", tone: "danger" },
};

export function DatasetInfoPanel(props: DatasetInfoPanelProps) {
  // Mounted only while shown, so each look asks again: health can change
  // while a dataset is open, and nothing is asked while nobody looks.
  return props.visible ? <InfoBody {...props} /> : null;
}

function InfoBody({ workspaceId, dataset, getHealth }: DatasetInfoPanelProps) {
  const datasetId = dataset?.id ?? null;
  const [health, setHealth] = useState<HealthState | null>(null);

  useEffect(() => {
    if (!datasetId || !getHealth) return;
    let cancelled = false;
    getHealth(datasetId).then(
      (value) => {
        if (!cancelled) setHealth({ datasetId, status: "ready", value });
      },
      () => {
        if (!cancelled) setHealth({ datasetId, status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [datasetId, getHealth]);

  const current = health?.datasetId === datasetId ? health : null;

  return (
    <section className="lc-rail-panel" aria-label="Info" data-testid="info-panel">
      <PanelHeader className="lc-rail-panel-header" title="Info" />
      <div className="lc-rail-panel-body lc-info">
        {dataset ? (
          <>
            <DatasetFacts dataset={dataset} health={current} />
            <HealthFacts health={current} />
          </>
        ) : (
          <p className="lc-rail-panel-empty">Open a dataset to see its details.</p>
        )}
        <section className="lc-info-section">
          <h3 className="lc-rail-panel-section-title">Workspace</h3>
          <dl className="lc-info-list">
            <Fact label="Id" copy={workspaceId} mono>
              {workspaceId}
            </Fact>
          </dl>
        </section>
      </div>
    </section>
  );
}

function DatasetFacts({ dataset, health }: { dataset: InfoDataset; health: HealthState | null }) {
  const { manifest } = dataset;
  const images = manifest.images;
  const multiscale: MultiscaleInfo | undefined = images[0]?.multiscale;
  const levels = multiscale?.levels ?? [];
  const shape = levels[0]?.shape;
  const collection = typeof manifest.kind === "object" ? manifest.kind.Collection : null;
  const generated = new Set((multiscale?.generated_levels ?? []).map((g) => g.level_index));
  const channelCount = shape?.[1] ?? 0;
  const channels = Array.from({ length: channelCount }, (_, i) => {
    const info = multiscale?.channel_infos?.[i];
    return {
      name: channelDisplayName(i, null, info?.label),
      color: info?.color ?? null,
      swatch: swatchColor(info?.color),
    };
  });
  const labels = manifest.labels ?? [];

  const source = health?.status === "ready" ? health.value?.source_url : null;
  let sourceText: ReactNode;
  let sourceCopy: string | undefined;
  if (!health) {
    sourceText = <span className="lc-info-muted">Looking up…</span>;
  } else if (!source) {
    sourceText = <span className="lc-info-muted">Not available</span>;
  } else {
    sourceText = source;
    sourceCopy = source;
  }

  return (
    <section className="lc-info-section">
      <h3 className="lc-rail-panel-section-title">Dataset</h3>
      <dl className="lc-info-list">
        <Fact label="Name">{dataset.name}</Fact>
        <Fact label="Source" copy={sourceCopy} mono={!!sourceCopy}>
          {sourceText}
        </Fact>
        {collection && (
          <Fact label="Layout">
            {images.length} images
            {collection.rows.length > 0 && collection.columns.length > 0
              ? ` in ${collection.rows.length} × ${collection.columns.length}`
              : ""}
          </Fact>
        )}
        {shape && (
          <Fact label={collection ? "Image shape" : "Shape"}>
            <span className="lc-info-axes">
              {AXES.map((axis, i) => (
                <span key={axis} className="lc-info-axis" data-single={shape[i] <= 1 || undefined}>
                  <span className="lc-info-axis-name">{axis}</span>
                  {shape[i].toLocaleString()}
                </span>
              ))}
            </span>
          </Fact>
        )}
        {multiscale?.pinned_axes && multiscale.pinned_axes.length > 0 && (
          <Fact label="Fixed axes">
            {multiscale.pinned_axes
              .map((p) => positionLabel(p.name, p.pinned_index, p.size))
              .join(", ")}
          </Fact>
        )}
        {levels.length > 0 && (
          <Fact label={levels.length === 1 ? "1 level" : `${levels.length} levels`}>
            <ol className="lc-info-levels">
              {levels.map((level) => (
                <li key={level.level_index}>
                  <span className="lc-info-level-index">{level.level_index}</span>
                  {spatialShape(level.shape)}
                  {generated.has(level.level_index) && (
                    <span className="lc-info-muted"> generated</span>
                  )}
                </li>
              ))}
            </ol>
          </Fact>
        )}
        {multiscale && (
          <Fact label="Data type">
            {multiscale.data_type.toLowerCase()}
            {drawnAtFloat32Precision(multiscale.data_type) && (
              <span className="lc-info-muted"> drawn at float32 precision</span>
            )}
          </Fact>
        )}
        {channelCount > 0 && (
          <Fact label={channelCount === 1 ? "1 channel" : `${channelCount} channels`}>
            <ol className="lc-info-channels">
              {channels.map((channel, i) => (
                <li key={i}>
                  {channel.name}
                  {channel.swatch && (
                    <span className="lc-info-declared-color">
                      <span
                        className="lc-info-swatch"
                        style={{ backgroundColor: channel.swatch }}
                        aria-hidden="true"
                      />
                      {channel.color}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </Fact>
        )}
        {labels.length > 0 && (
          <Fact label={labels.length === 1 ? "1 label" : `${labels.length} labels`}>
            {labels.map((l) => l.name).join(", ")}
          </Fact>
        )}
      </dl>
    </section>
  );
}

/**
 * Whether the dataset is shown as stored, and each reason it may not be: what
 * the import found, and the server's own trouble serving it.
 */
function HealthFacts({ health }: { health: HealthState | null }) {
  const value = health?.status === "ready" ? health.value : null;
  let status: ReactNode;
  if (!health) status = <span className="lc-info-muted">Looking up…</span>;
  else if (!value) status = <span className="lc-info-muted">Not available</span>;
  else status = <Badge tone={STATUS[value.status].tone}>{STATUS[value.status].label}</Badge>;
  const reasons = value ? healthReasons(value) : [];

  return (
    <section className="lc-info-section">
      <h3 className="lc-rail-panel-section-title">Health</h3>
      <dl className="lc-info-list">
        <Fact label="Status">{status}</Fact>
      </dl>
      {reasons.length > 0 && (
        <ul className="lc-info-health" aria-label="Health details">
          {reasons.map((reason) => (
            <li key={reason.text} data-degrades={reason.degrades || undefined}>
              {reason.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The CSS color for a channel's declared color, or null when it is not the
 * `rrggbb` hex, with or without `#`, that seeds its colormap. A malformed one
 * seeds nothing, so it shows nothing either.
 */
function swatchColor(color: string | null | undefined): string | null {
  const hex = color?.replace(/^#/, "");
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : null;
}

/** A level's spatial extent, Z × Y × X, dropping a single plane. */
function spatialShape(shape: readonly number[]): string {
  const [, , z, y, x] = shape;
  const dims = z > 1 ? [z, y, x] : [y, x];
  return dims.map((n) => n.toLocaleString()).join(" × ");
}

function Fact({
  label,
  children,
  copy,
  mono,
}: {
  label: string;
  children: ReactNode;
  /** The text a copy button puts on the clipboard; no button without it. */
  copy?: string;
  mono?: boolean;
}) {
  return (
    <div className="lc-info-fact">
      <dt className="lc-info-label">{label}</dt>
      <dd className="lc-info-value" data-mono={mono || undefined}>
        <span className="lc-info-text">{children}</span>
        {copy !== undefined && (
          <IconButton
            icon={CopyIcon}
            size="sm"
            label={`Copy ${label.toLowerCase()}`}
            tooltipPlacement="left"
            onPress={() => copyText(label, copy)}
          />
        )}
      </dd>
    </div>
  );
}

function copyText(label: string, text: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast({ title: `${label} copied`, tone: "success" }),
    () => toast({ title: `Couldn't copy the ${label.toLowerCase()}`, description: text, tone: "danger" }),
  );
}
