/** OME-Zarr v0.5 (Zarr v3) metadata parsing. */

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

export async function parseDatasetInfo(
  fileIndex: Map<string, File>,
): Promise<DatasetInfo> {
  // Read root zarr.json
  const rootFile = fileIndex.get("zarr.json");
  if (!rootFile) throw new Error("Missing root zarr.json");
  const rootJson = JSON.parse(await rootFile.text());

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
