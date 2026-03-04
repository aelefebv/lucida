import { useEffect, useRef, useState } from "react";
import init, { WasmScene } from "lucida-core";
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
  }

  function handleDirChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // The first file's webkitRelativePath gives us the directory name
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
    </div>
  );
}

export default App;
