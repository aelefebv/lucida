import { useEffect, useRef, useState } from "react";
import init, { WasmScene } from "lucida-core";
import { buildFileIndex } from "./zarr/fileIndex.ts";
import { parseDatasetInfo } from "./zarr/metadata.ts";
import { assembleVolume } from "./zarr/volumeAssembler.ts";
import type { VolumeData } from "./zarr/volumeAssembler.ts";
import { VolumeViewer } from "./components/VolumeViewer.tsx";
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

function App() {
  const [item, setItem] = useState<OpenedItem | null>(null);
  const [wasmReady, setWasmReady] = useState(false);
  const [volume, setVolume] = useState<VolumeData | null>(null);
  const [wasmScene, setWasmScene] = useState<WasmScene | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    init().then(() => setWasmReady(true));
  }, []);

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
    setError(null);
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
    setError(null);

    // Try to load as OME-Zarr
    const fileIndex = buildFileIndex(files);
    if (!fileIndex.has("zarr.json")) return;

    setLoading(true);
    try {
      const info = await parseDatasetInfo(fileIndex);
      console.log("OME-Zarr metadata:", info);

      // Use coarsest level for fast first load
      const level = info.levels[info.levels.length - 1];
      const vol = await assembleVolume(fileIndex, level.path, 0, 0, level);
      console.log(`Volume loaded: ${vol.width}x${vol.height}x${vol.depth}`);

      // Create WasmScene and set volume scale from metadata
      const scene = new WasmScene(800, 600);
      // shape and scale are in [T, C, Z, Y, X] order; extract Z, Y, X
      const shapeZ = level.shape[2], shapeY = level.shape[3], shapeX = level.shape[4];
      const scaleZ = level.scale[2], scaleY = level.scale[3], scaleX = level.scale[4];
      scene.set_volume_scale(shapeZ, shapeY, shapeX, scaleZ, scaleY, scaleX);

      setVolume(vol);
      setWasmScene(scene);
    } catch (err) {
      console.error("Failed to load OME-Zarr:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

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
      {loading && <p className="secondary">Loading volume...</p>}
      {error && <p style={{ color: "#f44" }}>{error}</p>}
      {volume && wasmScene && <VolumeViewer volume={volume} scene={wasmScene} />}
    </div>
  );
}

export default App;
