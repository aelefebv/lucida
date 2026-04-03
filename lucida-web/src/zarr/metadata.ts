/** OME-Zarr v0.5 (Zarr v3) metadata types. */

export interface AxisInfo {
  name: string;
  type: string;
  unit?: string;
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
