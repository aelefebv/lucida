import { useRef, useState } from "react";
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

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
