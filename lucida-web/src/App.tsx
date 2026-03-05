import { useEffect, useRef, useState } from "react";
import init, { WasmScene } from "lucida-core";
import { buildFileIndex } from "./zarr/fileIndex.ts";
import { parseDatasetInfo } from "./zarr/metadata.ts";
import type { DatasetInfo, LevelMeta } from "./zarr/metadata.ts";
import { assembleVolume } from "./zarr/volumeAssembler.ts";
import type { VolumeData } from "./zarr/volumeAssembler.ts";
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
  const [wasmReady, setWasmReady] = useState(false);
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
  const [levelMeta, setLevelMeta] = useState<LevelMeta | null>(null);
  const fileIndexRef = useRef<Map<string, File> | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    init().then(() => setWasmReady(true));
  }, []);

  // Sync Z to WASM scene
  useEffect(() => {
    if (wasmScene) wasmScene.set_z(z);
  }, [z, wasmScene]);

  // Re-assemble volume when C or T changes
  useEffect(() => {
    const fileIndex = fileIndexRef.current;
    if (!fileIndex || !levelMeta) return;

    let cancelled = false;
    setLoading(true);

    assembleVolume(fileIndex, levelMeta.path, t, c, levelMeta)
      .then((vol) => {
        if (cancelled) return;
        setVolume(vol);
        // Clamp z if it exceeds new depth
        setZ((prev) => Math.min(prev, vol.depth - 1));

        // Update WASM scene
        if (wasmScene) {
          wasmScene.set_c(c);
          wasmScene.set_t(t);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("Failed to reassemble volume:", err);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, t, levelMeta]);

  function handleTestChunkPlan() {
    const scene = new WasmScene(800, 600);
    scene.add_layer("test-layer", true, 5, 256, 256, 64);

    console.log("=== Initial State ===");
    console.log("Zoom:", scene.zoom());
    console.log("World bounds:", JSON.parse(scene.world_bounds()));
    console.log("Chunk plan:", JSON.parse(scene.chunk_plan()));

    scene.pan(200, 150);
    scene.zoom_by(0.5);

    console.log("=== After pan(200,150) + zoom_by(0.5) ===");
    console.log("Zoom:", scene.zoom());
    console.log("World bounds:", JSON.parse(scene.world_bounds()));
    console.log("Chunk plan:", JSON.parse(scene.chunk_plan()));

    scene.set_z(3);
    console.log("=== After set_z(3) ===");
    console.log("Chunk plan:", JSON.parse(scene.chunk_plan()));

    scene.free();
    console.log("Scene freed.");
  }

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
    setVolume(null);
    setWasmScene(null);
    setDatasetInfo(null);
    setLevelMeta(null);
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
    setVolume(null);
    setWasmScene(null);
    setDatasetInfo(null);
    setLevelMeta(null);
    setError(null);
    setZ(0);
    setC(0);
    setT(0);

    // Try to load as OME-Zarr
    const fileIndex = buildFileIndex(files);
    if (!fileIndex.has("zarr.json")) return;

    fileIndexRef.current = fileIndex;
    setLoading(true);
    try {
      const info = await parseDatasetInfo(fileIndex);
      console.log("OME-Zarr metadata:", info);
      setDatasetInfo(info);

      // Use coarsest level for fast first load
      const level = info.levels[info.levels.length - 1];
      setLevelMeta(level);

      const vol = await assembleVolume(fileIndex, level.path, 0, 0, level);
      console.log(`Volume loaded: ${vol.width}x${vol.height}x${vol.depth}`);

      // Create WasmScene and set volume scale from metadata
      const scene = new WasmScene(800, 600);
      // shape and scale are in [T, C, Z, Y, X] order; extract Z, Y, X
      const shapeZ = level.shape[2],
        shapeY = level.shape[3],
        shapeX = level.shape[4];
      const scaleZ = level.scale[2],
        scaleY = level.scale[3],
        scaleX = level.scale[4];
      scene.set_volume_scale(shapeZ, shapeY, shapeX, scaleZ, scaleY, scaleX);
      scene.set_mode_2d();
      scene.set_z(0);
      scene.set_c(0);
      scene.set_t(0);

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
      }
    }
  }

  // Dimension extents from the current level
  const dimZ = levelMeta ? levelMeta.shape[2] : 1;
  const dimC = levelMeta ? levelMeta.shape[1] : 1;
  const dimT = levelMeta ? levelMeta.shape[0] : 1;

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
        <button onClick={handleTestChunkPlan} disabled={!wasmReady}>
          Test Chunk Plan
        </button>
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
      {volume && viewMode === "2d" && <SliceViewer volume={volume} z={z} />}
      {volume && viewMode === "3d" && wasmScene && (
          <VolumeViewer volume={volume} scene={wasmScene} />
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
