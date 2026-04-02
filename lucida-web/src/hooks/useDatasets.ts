import { useCallback, useState } from "react";
import type { WasmScene } from "lucida-core";
import { buildFileIndex } from "../zarr/fileIndex.ts";
import { parseSourceInfo } from "../zarr/metadata.ts";
import { assembleVolume } from "../zarr/volumeAssembler.ts";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import { ChunkStore, type ChunkFetcher } from "../zarr/chunkStore.ts";
import { loadChunk } from "../zarr/chunkLoader.ts";
import { applyDocumentCommand, applyViewportCommand } from "../applyAndSend.ts";
import type { DatasetState } from "../types.ts";
import type { RenderLoop } from "../renderLoop.ts";

interface Params {
  wasmSceneRef: React.RefObject<WasmScene | null>;
  ensureScene: () => WasmScene;
  setWasmScene: React.Dispatch<React.SetStateAction<WasmScene | null>>;
  loopRef: React.RefObject<RenderLoop | null>;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  sendCommand: (json: string) => void;
  emitPresence: () => void;
  emitDatasetPresence: () => void;
  initLayerMaps: (id: string) => void;
  sendOpenRemoteDataset: (url: string) => void;
  // Lifted state setters
  setSelectedDatasetId: React.Dispatch<React.SetStateAction<string | null>>;
  setVolumeMap: React.Dispatch<React.SetStateAction<Map<string, VolumeData>>>;
  bumpDatasetsVersion: () => void;
}

export function useDatasets({
  wasmSceneRef,
  ensureScene,
  setWasmScene,
  loopRef,
  datasetsRef,
  sendCommand,
  emitPresence,
  emitDatasetPresence,
  initLayerMaps,
  sendOpenRemoteDataset,
  setSelectedDatasetId,
  setVolumeMap,
  bumpDatasetsVersion,
}: Params) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function handleLocalSource(fileIndex: Map<string, File>, dirName: string) {
    const source = await parseSourceInfo(fileIndex, dirName);
    console.log("OME-Zarr source:", source);

    const { info } = source;
    const [shapeZ, shapeY, shapeX] = source.volumeShape;
    const [scaleZ, scaleY, scaleX] = source.volumeScale;

    let scene = wasmSceneRef.current;
    const isFirstDataset = !scene;
    if (!scene) {
      scene = ensureScene();
    }

    const datasetId = crypto.randomUUID();

    // Assign member IDs now that we have the datasetId
    const members = source.members.map((m) => ({
      ...m,
      id: m.storePrefix ? `${datasetId}:${m.storePrefix}` : datasetId,
    }));

    const fullRes = info.levels[0];
    const chunkX = fullRes.chunkShape[4];
    const chunkY = fullRes.chunkShape[3];
    const chunkZ = fullRes.chunkShape[2];

    const levelInfoArray: { shape: [number, number, number]; chunk_size: [number, number, number] }[] = [];
    for (const lvl of info.levels) {
      levelInfoArray.push({
        shape: [lvl.shape[2], lvl.shape[3], lvl.shape[4]],
        chunk_size: [lvl.chunkShape[2], lvl.chunkShape[3], lvl.chunkShape[4]],
      });
    }

    const addDatasetCmd: Record<string, unknown> = {
      type: "add_dataset",
      id: datasetId,
      name: source.name,
      layers: [{
        name: "main",
        visible: true,
        num_levels: info.levels.length,
        chunk_size: [chunkZ, chunkY, chunkX],
        data_shape: [fullRes.shape[2], fullRes.shape[3], fullRes.shape[4]],
        level_info: levelInfoArray,
      }],
      volume_shape: [shapeZ, shapeY, shapeX] as [number, number, number],
      volume_scale: [scaleZ, scaleY, scaleX] as [number, number, number],
      client_metadata: info,
    };

    if (source.kind.type === "plate") {
      addDatasetCmd.kind = {
        type: "plate",
        rows: source.kind.rows,
        columns: source.kind.columns,
        wells: source.kind.wells.map(w => ({
          path: w.path,
          row_index: w.rowIndex,
          column_index: w.columnIndex,
        })),
        positioning_mode: source.kind.positioning_mode,
        has_stage_positions: source.kind.has_stage_positions,
      };
    }
    addDatasetCmd.members = members.map(m => ({
      id: m.id,
      position: m.position,
      store_prefix: m.storePrefix,
    }));

    applyDocumentCommand(scene, addDatasetCmd, sendCommand);

    if (isFirstDataset) {
      applyViewportCommand(scene, { type: "set_center", x: shapeX / 2, y: shapeY / 2 });
      applyViewportCommand(scene, { type: "set_mode_slice" });
      applyViewportCommand(scene, { type: "set_z", z: 0 });
      applyViewportCommand(scene, { type: "set_c", c: 0 });
      applyViewportCommand(scene, { type: "set_t", t: 0 });
    }

    const memberStores = new Map<string, ChunkStore>();
    for (const member of members) {
      const fetcher: ChunkFetcher = (coord, signal) => {
        const levelMeta = info.levels[coord.level];
        if (!levelMeta) return Promise.reject(new Error(`No level ${coord.level}`));
        const path = member.storePrefix
          ? `${member.storePrefix}/${levelMeta.path}`
          : levelMeta.path;
        return loadChunk(
          fileIndex,
          path,
          coord.t,
          coord.c,
          coord.z,
          coord.y,
          coord.x,
          levelMeta.codecs,
          info.axes,
          signal,
        );
      };
      memberStores.set(member.id, new ChunkStore(fetcher));
    }

    datasetsRef.current.set(datasetId, {
      id: datasetId,
      name: source.name,
      info,
      memberStores,
      fileIndex,
      members,
    });

    initLayerMaps(datasetId);
    loopRef.current?.addDataset(datasetId, memberStores, info);

    setSelectedDatasetId(datasetId);
    bumpDatasetsVersion();

    // Assemble coarse volume only for single-member datasets
    if (members.length === 1) {
      const coarsest = info.levels[info.levels.length - 1];
      const vol = await assembleVolume(fileIndex, coarsest.path, 0, 0, coarsest, info.axes);
      console.log(`Volume loaded: ${vol.width}x${vol.height}x${vol.depth}`);
      setVolumeMap(prev => { const next = new Map(prev); next.set(datasetId, vol); return next; });
    }

    setWasmScene(scene);
  }

  const handleDirChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const dirName = files[0].webkitRelativePath.split("/")[0];

    const fileIndex = buildFileIndex(files);
    if (!fileIndex.has("zarr.json")) return;

    setLoading(true);
    setLoadError(null);
    try {
      await handleLocalSource(fileIndex, dirName);

      setTimeout(() => emitPresence(), 0);
      setTimeout(() => emitDatasetPresence(), 0);
    } catch (err) {
      console.error("Failed to load OME-Zarr:", err);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      e.target.value = "";
    }
  }, [wasmSceneRef, ensureScene, setWasmScene, loopRef, datasetsRef, sendCommand, emitPresence, emitDatasetPresence, initLayerMaps, setSelectedDatasetId, setVolumeMap, bumpDatasetsVersion]);

  const handleUrlSubmit = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    sendOpenRemoteDataset(trimmed);
  }, [sendOpenRemoteDataset]);

  return {
    loading,
    loadError,
    handleDirChange,
    handleUrlSubmit,
  };
}
