import { useEffect, useRef, useState } from "react";
import init, { WasmScene } from "lucida-core";
import { buildFileIndex } from "./zarr/fileIndex.ts";
import { parseDatasetInfo } from "./zarr/metadata.ts";
import type { DatasetInfo } from "./zarr/metadata.ts";
import { assembleVolume } from "./zarr/volumeAssembler.ts";
import type { VolumeData } from "./zarr/volumeAssembler.ts";
import { ChunkStore } from "./zarr/chunkStore.ts";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
import { SliceViewer } from "./components/SliceViewer.tsx";
import { DimensionControls } from "./components/DimensionControls.tsx";
import "./App.css";

interface OpenedItem {
  name: string;
  size: number;
  kind: "file" | "directory";
  fileCount?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ViewMode = "2d" | "3d";

function App() {
  const [item, setItem] = useState<OpenedItem | null>(null);
  const [, setWasmReady] = useState(false);
  const [volume, setVolume] = useState<VolumeData | null>(null);
  const [wasmScene, setWasmScene] = useState<WasmScene | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("2d");

  // Dimension state
  const [z, setZ] = useState(0);
  const [c, setC] = useState(0);
  const [t, setT] = useState(0);

  // Keep dataset info and file index for re-assembling on C/T change
  const [datasetInfo, setDatasetInfo] = useState<DatasetInfo | null>(null);
  const fileIndexRef = useRef<Map<string, File> | null>(null);
  const storeRef = useRef<ChunkStore | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    init().then(() => setWasmReady(true));
  }, []);

  // Sync Z/T/C to WASM scene and request chunks
  useEffect(() => {
    if (!wasmScene || !storeRef.current) return;
    wasmScene.set_z(z);
    wasmScene.set_t(t);
    wasmScene.set_c(c);
    try {
      const plan = JSON.parse(wasmScene.chunk_plan());
      if (plan.needed.length > 0) {
        storeRef.current.ensureFetched(plan.needed);
      }
    } catch { /* ignore */ }
  }, [z, t, c, wasmScene]);

  function handleOpenFile() {
    fileInputRef.current?.click();
  }

  function handleOpenFolder() {
    dirInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setItem({
      name: selected.name,
      size: selected.size,
      kind: "file",
    });
    cleanupState();
  }

  function cleanupState() {
    storeRef.current?.destroy();
    storeRef.current = null;
    setVolume(null);
    setWasmScene(null);
    setDatasetInfo(null);
    setError(null);
    setZ(0);
    setC(0);
    setT(0);
  }

  async function handleDirChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const dirName = files[0].webkitRelativePath.split("/")[0];
    let totalSize = 0;
    for (let i = 0; i < files.length; i++) {
      totalSize += files[i].size;
    }

    setItem({
      name: dirName,
      size: totalSize,
      kind: "directory",
      fileCount: files.length,
    });
    cleanupState();

    // Try to load as OME-Zarr
    const fileIndex = buildFileIndex(files);
    if (!fileIndex.has("zarr.json")) return;

    fileIndexRef.current = fileIndex;
    setLoading(true);
    try {
      const info = await parseDatasetInfo(fileIndex);
      console.log("OME-Zarr metadata:", info);
      setDatasetInfo(info);

      // Use coarsest level for fast first paint
      const coarsest = info.levels[info.levels.length - 1];
      const vol = await assembleVolume(fileIndex, coarsest.path, 0, 0, coarsest);
      console.log(`Volume loaded: ${vol.width}x${vol.height}x${vol.depth}`);

      // Create WasmScene with full-res level metadata
      const fullRes = info.levels[0];
      const scene = new WasmScene(800, 600);

      // Set volume scale from full-res level
      const shapeZ = fullRes.shape[2],
        shapeY = fullRes.shape[3],
        shapeX = fullRes.shape[4];
      const scaleZ = fullRes.scale[2],
        scaleY = fullRes.scale[3],
        scaleX = fullRes.scale[4];
      scene.set_volume_scale(shapeZ, shapeY, shapeX, scaleZ, scaleY, scaleX);

      // Add layer with real metadata so chunk_plan() can select levels
      const chunkX = fullRes.chunkShape[4];
      const chunkY = fullRes.chunkShape[3];
      const chunkZ = fullRes.chunkShape[2];
      scene.add_layer("main", true, info.levels.length, chunkX, chunkY, chunkZ, shapeX, shapeY, shapeZ);

      // Center the Rust 2D camera on the image so world_bounds matches the TS viewer
      scene.set_center(shapeX / 2, shapeY / 2);

      scene.set_mode_2d();
      scene.set_z(0);
      scene.set_c(0);
      scene.set_t(0);

      // Create ChunkStore
      const store = new ChunkStore(fileIndex, info);
      storeRef.current = store;

      setVolume(vol);
      setWasmScene(scene);
    } catch (err) {
      console.error("Failed to load OME-Zarr:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleViewModeToggle() {
    const next = viewMode === "2d" ? "3d" : "2d";
    setViewMode(next);
    if (wasmScene) {
      if (next === "3d") {
        wasmScene.set_mode_3d();
      } else {
        wasmScene.set_mode_2d();
        // Re-center the Rust 2D camera on the image (set_mode_2d resets center to [0,0])
        if (datasetInfo) {
          const shapeX = datasetInfo.levels[0].shape[4];
          const shapeY = datasetInfo.levels[0].shape[3];
          wasmScene.set_center(shapeX / 2, shapeY / 2);
        }
      }
    }
  }

  // Dimension extents from full-res level (level 0) for accurate slider ranges
  const dimZ = datasetInfo ? datasetInfo.levels[0].shape[2] : 1;
  const dimC = datasetInfo ? datasetInfo.levels[0].shape[1] : 1;
  const dimT = datasetInfo ? datasetInfo.levels[0].shape[0] : 1;

  return (
    <div className="app">
      <h1>Lucida</h1>
      <input
        ref={fileInputRef}
        type="file"
        accept=".tif,.tiff,.ome.tif,.ome.tiff,.nd2,.czi,.lif"
        onChange={handleFileChange}
        hidden
      />
      <input
        ref={dirInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        onChange={handleDirChange}
        hidden
      />
      <div className="button-group">
        <button onClick={handleOpenFile}>Open File</button>
        <button onClick={handleOpenFolder}>Open Folder</button>
        {volume && (
          <button onClick={handleViewModeToggle}>
            {viewMode === "2d" ? "3D View" : "2D View"}
          </button>
        )}
      </div>
      {item && (
        <div className="file-info">
          <p>{item.name}</p>
          <p className="secondary">
            {formatBytes(item.size)}
            {item.kind === "directory" && ` · ${item.fileCount} files`}
          </p>
        </div>
      )}
      {volume && viewMode === "2d" && wasmScene && datasetInfo && storeRef.current && (
        <SliceViewer
          volume={volume}
          z={z}
          t={t}
          c={c}
          scene={wasmScene}
          store={storeRef.current}
          datasetInfo={datasetInfo}
        />
      )}
      {volume && viewMode === "3d" && wasmScene && datasetInfo && storeRef.current && (
        <VolumeViewer
          volume={volume}
          scene={wasmScene}
          store={storeRef.current}
          datasetInfo={datasetInfo}
        />
      )}
      {volume && (
        <div className="dimension-controls">
          <DimensionControls label="Z" value={z} max={dimZ} onChange={setZ} disabled={viewMode === "3d"} />
          <DimensionControls label="C" value={c} max={dimC} onChange={setC} />
          <DimensionControls label="T" value={t} max={dimT} onChange={setT} />
        </div>
      )}
      {loading && <p className="secondary">Loading volume...</p>}
      {error && <p style={{ color: "#f44" }}>{error}</p>}
    </div>
  );
}

export default App;
