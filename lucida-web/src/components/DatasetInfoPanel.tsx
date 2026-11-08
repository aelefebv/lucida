/**
 * The Info rail panel: what the active dataset is and where it came from, and
 * the workspace's id, each copyable where someone would paste it elsewhere.
 */
import { CopyIcon } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { positionLabel } from "../axes.ts";
import type { DatasetManifest, MultiscaleInfo } from "../manifestTypes.ts";
import { channelDisplayName } from "./channels.ts";
import { drawnAtFloat32Precision } from "../renderer/dataTypeUtil.ts";
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
  /** The dataset's source path or URL; null when the server has none. */
  getSource?: (datasetId: string) => Promise<string | null>;
}

/** Level-0 shape order, as every manifest stores it. */
const AXES = ["T", "C", "Z", "Y", "X"] as const;

type SourceState =
  | { datasetId: string; status: "ready"; value: string | null }
  | { datasetId: string; status: "failed" };

export function DatasetInfoPanel({ visible, workspaceId, dataset, getSource }: DatasetInfoPanelProps) {
  const datasetId = dataset?.id ?? null;
  const [source, setSource] = useState<SourceState | null>(null);

  // Asked once per dataset, and only once someone looks.
  const needsSource = visible && datasetId !== null && !!getSource && source?.datasetId !== datasetId;
  useEffect(() => {
    if (!needsSource || !datasetId || !getSource) return;
    let cancelled = false;
    getSource(datasetId).then(
      (value) => {
        if (!cancelled) setSource({ datasetId, status: "ready", value });
      },
      () => {
        if (!cancelled) setSource({ datasetId, status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needsSource, datasetId, getSource]);

  if (!visible) return null;

  const current = source?.datasetId === datasetId ? source : null;

  return (
    <section className="lc-rail-panel" aria-label="Info" data-testid="info-panel">
      <PanelHeader className="lc-rail-panel-header" title="Info" />
      <div className="lc-rail-panel-body lc-info">
        {dataset ? (
          <DatasetFacts dataset={dataset} source={current} />
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

function DatasetFacts({ dataset, source }: { dataset: InfoDataset; source: SourceState | null }) {
  const { manifest } = dataset;
  const images = manifest.images;
  const multiscale: MultiscaleInfo | undefined = images[0]?.multiscale;
  const levels = multiscale?.levels ?? [];
  const shape = levels[0]?.shape;
  const collection = typeof manifest.kind === "object" ? manifest.kind.Collection : null;
  const generated = new Set((multiscale?.generated_levels ?? []).map((g) => g.level_index));
  const channelCount = shape?.[1] ?? 0;
  const channelNames = Array.from({ length: channelCount }, (_, i) => {
    return channelDisplayName(i, null, multiscale?.channel_infos?.[i]?.label);
  });
  const labels = manifest.labels ?? [];

  let sourceText: ReactNode;
  let sourceCopy: string | undefined;
  if (!source) {
    sourceText = <span className="lc-info-muted">Looking up…</span>;
  } else if (source.status === "failed" || !source.value) {
    sourceText = <span className="lc-info-muted">Not available</span>;
  } else {
    sourceText = source.value;
    sourceCopy = source.value;
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
            {channelNames.join(", ")}
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
