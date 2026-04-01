import { useCallback, useState } from "react";
import type { WasmScene } from "lucida-core";
import { buildFileIndex } from "../zarr/fileIndex.ts";
import { parseDatasetInfo } from "../zarr/metadata.ts";
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

  const handleDirChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const dirName = files[0].webkitRelativePath.split("/")[0];

    const fileIndex = buildFileIndex(files);
    if (!fileIndex.has("zarr.json")) return;

    setLoading(true);
    setLoadError(null);
    try {
      const info = await parseDatasetInfo(fileIndex);
      console.log("OME-Zarr metadata:", info);

      const coarsest = info.levels[info.levels.length - 1];
      const vol = await assembleVolume(fileIndex, coarsest.path, 0, 0, coarsest, info.axes);
      console.log(`Volume loaded: ${vol.width}x${vol.height}x${vol.depth}`);

      let scene = wasmSceneRef.current;
      const isFirstDataset = !scene;
      if (!scene) {
        scene = ensureScene();
      }

      const datasetId = crypto.randomUUID();

      const fullRes = info.levels[0];
      const shapeZ = fullRes.shape[2],
        shapeY = fullRes.shape[3],
        shapeX = fullRes.shape[4];
      const scaleZ = fullRes.scale[2],
        scaleY = fullRes.scale[3],
        scaleX = fullRes.scale[4];

      const chunkX = fullRes.chunkShape[4];
      const chunkY = fullRes.chunkShape[3];
      const chunkZ = fullRes.chunkShape[2];

      // All spatial arrays use [Z, Y, X] ordering
      const levelInfoArray: { shape: [number, number, number]; chunk_size: [number, number, number] }[] = [];
      for (const lvl of info.levels) {
        levelInfoArray.push({
          shape: [lvl.shape[2], lvl.shape[3], lvl.shape[4]],
          chunk_size: [lvl.chunkShape[2], lvl.chunkShape[3], lvl.chunkShape[4]],
        });
      }

      const addDatasetCmd = {
        type: "add_dataset",
        id: datasetId,
        name: dirName,
        layers: [{
          name: "main",
          visible: true,
          num_levels: info.levels.length,
          chunk_size: [chunkZ, chunkY, chunkX],
          data_shape: [shapeZ, shapeY, shapeX],
          level_info: levelInfoArray,
        }],
        volume_shape: [shapeZ, shapeY, shapeX] as [number, number, number],
        volume_scale: [scaleZ, scaleY, scaleX] as [number, number, number],
        client_metadata: info,
      };

      applyDocumentCommand(scene, addDatasetCmd, sendCommand);

      if (isFirstDataset) {
        applyViewportCommand(scene, { type: "set_center", x: shapeX / 2, y: shapeY / 2 });
        applyViewportCommand(scene, { type: "set_mode_slice" });
        applyViewportCommand(scene, { type: "set_z", z: 0 });
        applyViewportCommand(scene, { type: "set_c", c: 0 });
        applyViewportCommand(scene, { type: "set_t", t: 0 });
      }

      const localFetcher: ChunkFetcher = (coord, signal) => {
        const levelMeta = info.levels[coord.level];
        if (!levelMeta) return Promise.reject(new Error(`No level ${coord.level}`));
        return loadChunk(
          fileIndex,
          levelMeta.path,
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
      const store = new ChunkStore(localFetcher);

      datasetsRef.current.set(datasetId, {
        id: datasetId,
        name: dirName,
        info,
        store,
        fileIndex,
      });

      initLayerMaps(datasetId);
      loopRef.current?.addDataset(datasetId, store, info);

      setSelectedDatasetId(datasetId);
      bumpDatasetsVersion();

      setVolumeMap(prev => { const next = new Map(prev); next.set(datasetId, vol); return next; });
      setWasmScene(scene);

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
