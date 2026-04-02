/** OME-Zarr v0.5 (Zarr v3) metadata parsing. */

import type { DatasetMember } from "../types.ts";

export interface AxisInfo {
  name: string;
  type: string;
  unit?: string;
}

/** Map axis names to canonical 5D positions: [T, C, Z, Y, X]. */
const CANONICAL: Record<string, number> = { t: 0, c: 1, z: 2, y: 3, x: 4 };

/** Pad an N-dimensional array to canonical 5D based on axis names. */
function normalizeTo5D(values: number[], axes: AxisInfo[], fill: number): number[] {
  const result = [fill, fill, fill, fill, fill];
  for (let i = 0; i < axes.length; i++) {
    const pos = CANONICAL[axes[i].name];
    if (pos !== undefined && i < values.length) result[pos] = values[i];
  }
  return result;
}

export interface CodecMeta {
  name: string;
  configuration?: Record<string, unknown>;
}

export interface LevelMeta {
  path: string;
  shape: number[]; // [T, C, Z, Y, X]
  chunkShape: number[]; // [T, C, Z, Y, X]
  dataType: string;
  scale: number[]; // [T, C, Z, Y, X] physical spacing per voxel
  codecs: CodecMeta[];
}

export interface DatasetInfo {
  axes: AxisInfo[];
  levels: LevelMeta[];
}

/** Check whether root zarr.json represents a plate. */
function isPlate(rootJson: Record<string, unknown>): boolean {
  return !!(rootJson as any).attributes?.ome?.plate;
}

export interface PlateWellInfo {
  path: string;
  rowIndex: number;
  columnIndex: number;
}

export interface PlateInfo {
  name: string;
  rows: string[];
  columns: string[];
  wells: PlateWellInfo[];
  fovMetadata: DatasetInfo; // uniform metadata from representative FOV
  /** Per-well array of per-FOV optional translation vectors. */
  fovTranslations: (number[] | null)[][];
  /** FOV paths per well. */
  fovPaths: string[][];
  hasStagePositions: boolean;
}

/** Parse plate info from a local file index. */
async function parsePlateInfo(
  fileIndex: Map<string, File>,
): Promise<PlateInfo> {
  const rootFile = fileIndex.get("zarr.json");
  if (!rootFile) throw new Error("Missing root zarr.json");
  const rootJson = JSON.parse(await rootFile.text());

  const plate = (rootJson as any).attributes?.ome?.plate;
  if (!plate) throw new Error("Not a plate");

  const name: string = plate.name ?? "plate";
  const rows: string[] = (plate.rows ?? []).map((r: any) => r.name);
  const columns: string[] = (plate.columns ?? []).map((c: any) => c.name);
  const wells: PlateWellInfo[] = (plate.wells ?? []).map((w: any) => ({
    path: w.path,
    rowIndex: w.rowIndex ?? 0,
    columnIndex: w.columnIndex ?? 0,
  }));

  // Read FOV paths from each well's zarr.json
  const fovPaths: string[][] = [];
  const fovTranslations: (number[] | null)[][] = [];
  let hasStagePositions = false;

  for (const well of wells) {
    const wellFile = fileIndex.get(`${well.path}/zarr.json`);
    if (!wellFile) { fovPaths.push([]); fovTranslations.push([]); continue; }
    const wellJson = JSON.parse(await wellFile.text());
    const images: { path: string }[] = (wellJson as any).attributes?.ome?.well?.images ?? [];
    const paths = images.map((img) => img.path);
    fovPaths.push(paths);

    // Read translations from each FOV's multiscales coordinateTransformations
    const translations: (number[] | null)[] = [];
    for (const fovPath of paths) {
      const fovFile = fileIndex.get(`${well.path}/${fovPath}/zarr.json`);
      if (!fovFile) { translations.push(null); continue; }
      const fovJson = JSON.parse(await fovFile.text());
      const ms = (fovJson as any).attributes?.ome?.multiscales?.[0];
      if (!ms) { translations.push(null); continue; }
      const ds0 = ms.datasets?.[0];
      const transforms: any[] = ds0?.coordinateTransformations ?? [];
      const transTransform = transforms.find((t: any) => t.type === "translation");
      if (transTransform?.translation) {
        translations.push(transTransform.translation);
        hasStagePositions = true;
      } else {
        translations.push(null);
      }
    }
    fovTranslations.push(translations);
  }

  // Read representative FOV metadata
  const repWell = wells[0];
  const repFov = fovPaths[0]?.[0];
  if (!repWell || repFov === undefined) throw new Error("No FOVs found in plate");
  const repPrefix = `${repWell.path}/${repFov}`;
  const repInfo = await parseDatasetInfoFromJson(fileIndex, repPrefix);

  return { name, rows, columns, wells, fovMetadata: repInfo, fovTranslations, fovPaths, hasStagePositions };
}

/** Parse dataset info from a specific prefix within the file index. */
async function parseDatasetInfoFromJson(
  fileIndex: Map<string, File>,
  prefix: string,
): Promise<DatasetInfo> {
  const rootFile = fileIndex.get(`${prefix}/zarr.json`);
  if (!rootFile) throw new Error(`Missing ${prefix}/zarr.json`);
  const rootJson = JSON.parse(await rootFile.text());

  const multiscales = (rootJson as any).attributes?.ome?.multiscales;
  if (!multiscales || multiscales.length === 0) {
    throw new Error(`No multiscales found in ${prefix}`);
  }

  const ms = multiscales[0];
  const axes: AxisInfo[] = ms.axes;
  const datasets: { path: string; coordinateTransformations?: { type: string; scale?: number[] }[] }[] = ms.datasets;

  const levels: LevelMeta[] = await Promise.all(
    datasets.map(async (ds) => {
      const levelFile = fileIndex.get(`${prefix}/${ds.path}/zarr.json`);
      if (!levelFile) throw new Error(`Missing ${prefix}/${ds.path}/zarr.json`);
      const levelJson = JSON.parse(await levelFile.text());

      let scale = axes.map(() => 1);
      if (ds.coordinateTransformations) {
        const scaleTransform = ds.coordinateTransformations.find(
          (ct) => ct.type === "scale" && ct.scale,
        );
        if (scaleTransform?.scale) {
          scale = scaleTransform.scale;
        }
      }

      return {
        path: ds.path,
        shape: normalizeTo5D(levelJson.shape, axes, 1),
        chunkShape: normalizeTo5D(levelJson.chunk_grid.configuration.chunk_shape, axes, 1),
        dataType: levelJson.data_type,
        scale: normalizeTo5D(scale, axes, 1),
        codecs: levelJson.codecs ?? [],
      };
    }),
  );

  return { axes, levels };
}

async function parseDatasetInfo(
  fileIndex: Map<string, File>,
): Promise<DatasetInfo> {
  // Read root zarr.json
  const rootFile = fileIndex.get("zarr.json");
  if (!rootFile) throw new Error("Missing root zarr.json");
  const rootJson = JSON.parse(await rootFile.text());

  if (isPlate(rootJson)) {
    throw new Error("This is a plate — use parsePlateInfo() instead");
  }

  const multiscales = rootJson.attributes?.ome?.multiscales;
  if (!multiscales || multiscales.length === 0) {
    throw new Error("No multiscales found in OME metadata");
  }

  const ms = multiscales[0];
  const axes: AxisInfo[] = ms.axes;
  const datasets: { path: string; coordinateTransformations?: { type: string; scale?: number[] }[] }[] = ms.datasets;

  // Read each level's zarr.json for array metadata
  const levels: LevelMeta[] = await Promise.all(
    datasets.map(async (ds) => {
      const levelFile = fileIndex.get(`${ds.path}/zarr.json`);
      if (!levelFile) throw new Error(`Missing ${ds.path}/zarr.json`);
      const levelJson = JSON.parse(await levelFile.text());

      // Parse coordinateTransformations for scale
      let scale = axes.map(() => 1);
      if (ds.coordinateTransformations) {
        const scaleTransform = ds.coordinateTransformations.find(
          (ct) => ct.type === "scale" && ct.scale,
        );
        if (scaleTransform?.scale) {
          scale = scaleTransform.scale;
        }
      }

      return {
        path: ds.path,
        shape: normalizeTo5D(levelJson.shape, axes, 1),
        chunkShape: normalizeTo5D(levelJson.chunk_grid.configuration.chunk_shape, axes, 1),
        dataType: levelJson.data_type,
        scale: normalizeTo5D(scale, axes, 1),
        codecs: levelJson.codecs ?? [],
      };
    }),
  );

  return { axes, levels };
}

export interface SourceInfo {
  info: DatasetInfo;
  kind: { type: "single" } | {
    type: "plate";
    rows: string[];
    columns: string[];
    wells: PlateWellInfo[];
    positioning_mode: string;
    has_stage_positions: boolean;
  };
  members: DatasetMember[];
  volumeShape: [number, number, number]; // [Z, Y, X]
  volumeScale: [number, number, number]; // [Z, Y, X]
  name: string;
}

/** Unified entry point: detect plate vs single dataset and return a SourceInfo. */
export async function parseSourceInfo(
  fileIndex: Map<string, File>,
  dirName: string,
): Promise<SourceInfo> {
  const rootFile = fileIndex.get("zarr.json");
  if (!rootFile) throw new Error("Missing root zarr.json");
  const rootJson = JSON.parse(await rootFile.text());

  if (isPlate(rootJson)) {
    return parsePlateSourceInfo(fileIndex, dirName);
  }
  return parseSingleSourceInfo(fileIndex, rootJson, dirName);
}

async function parseSingleSourceInfo(
  fileIndex: Map<string, File>,
  rootJson: Record<string, unknown>,
  dirName: string,
): Promise<SourceInfo> {
  const multiscales = (rootJson as any).attributes?.ome?.multiscales;
  if (!multiscales || multiscales.length === 0) {
    throw new Error("No multiscales found in OME metadata");
  }

  const ms = multiscales[0];
  const axes: AxisInfo[] = ms.axes;
  const datasets: { path: string; coordinateTransformations?: { type: string; scale?: number[] }[] }[] = ms.datasets;

  const levels: LevelMeta[] = await Promise.all(
    datasets.map(async (ds) => {
      const levelFile = fileIndex.get(`${ds.path}/zarr.json`);
      if (!levelFile) throw new Error(`Missing ${ds.path}/zarr.json`);
      const levelJson = JSON.parse(await levelFile.text());

      let scale = axes.map(() => 1);
      if (ds.coordinateTransformations) {
        const scaleTransform = ds.coordinateTransformations.find(
          (ct) => ct.type === "scale" && ct.scale,
        );
        if (scaleTransform?.scale) {
          scale = scaleTransform.scale;
        }
      }

      return {
        path: ds.path,
        shape: normalizeTo5D(levelJson.shape, axes, 1),
        chunkShape: normalizeTo5D(levelJson.chunk_grid.configuration.chunk_shape, axes, 1),
        dataType: levelJson.data_type,
        scale: normalizeTo5D(scale, axes, 1),
        codecs: levelJson.codecs ?? [],
      };
    }),
  );

  const info: DatasetInfo = { axes, levels };
  const fullRes = levels[0];

  return {
    info,
    kind: { type: "single" },
    members: [{ id: "", position: [0, 0], storePrefix: null }],
    volumeShape: [fullRes.shape[2], fullRes.shape[3], fullRes.shape[4]],
    volumeScale: [fullRes.scale[2], fullRes.scale[3], fullRes.scale[4]],
    name: dirName,
  };
}

async function parsePlateSourceInfo(
  fileIndex: Map<string, File>,
  dirName: string,
): Promise<SourceInfo> {
  const plateInfo = await parsePlateInfo(fileIndex);
  const info = plateInfo.fovMetadata;
  const fullRes = info.levels[0];
  const fovShapeX = fullRes.shape[4];
  const fovShapeY = fullRes.shape[3];
  const fovShapeZ = fullRes.shape[2];

  // Compute FOV positions using grid layout
  const fieldGap = 0.08;
  const wellGap = 0.20;
  const members: DatasetMember[] = [];
  let maxX = 0, maxY = 0;

  for (let wi = 0; wi < plateInfo.wells.length; wi++) {
    const well = plateInfo.wells[wi];
    const fovCount = plateInfo.fovPaths[wi]?.length ?? 0;
    if (fovCount === 0) continue;

    const cols = Math.ceil(Math.sqrt(fovCount));
    const fovStepX = fovShapeX * (1 + fieldGap);
    const fovStepY = fovShapeY * (1 + fieldGap);
    const wellStepX = cols * fovStepX + fovShapeX * wellGap;
    const wellStepY = cols * fovStepY + fovShapeY * wellGap;
    const wellOriginX = well.columnIndex * wellStepX;
    const wellOriginY = well.rowIndex * wellStepY;

    for (let fi = 0; fi < fovCount; fi++) {
      const col = fi % cols;
      const row = Math.floor(fi / cols);
      const x = wellOriginX + col * fovStepX;
      const y = wellOriginY + row * fovStepY;
      maxX = Math.max(maxX, x + fovShapeX);
      maxY = Math.max(maxY, y + fovShapeY);

      members.push({
        id: "",  // assigned by caller after generating datasetId
        position: [x, y],
        storePrefix: `${well.path}/${plateInfo.fovPaths[wi][fi]}`,
      });
    }
  }

  return {
    info,
    kind: {
      type: "plate",
      rows: plateInfo.rows,
      columns: plateInfo.columns,
      wells: plateInfo.wells,
      positioning_mode: plateInfo.hasStagePositions ? "stage" : "grid",
      has_stage_positions: plateInfo.hasStagePositions,
    },
    members,
    volumeShape: [fovShapeZ, Math.ceil(maxY), Math.ceil(maxX)],
    volumeScale: [fullRes.scale[2], fullRes.scale[3], fullRes.scale[4]],
    name: plateInfo.name ?? dirName,
  };
}
