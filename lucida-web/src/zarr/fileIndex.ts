/** Build a path-keyed lookup from a FileList, stripping the root folder prefix. */
export function buildFileIndex(files: FileList): Map<string, File> {
  const index = new Map<string, File>();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const path = file.webkitRelativePath;
    // Strip root folder: "yeast.zarr/0/zarr.json" → "0/zarr.json"
    const slash = path.indexOf("/");
    if (slash >= 0) {
      index.set(path.slice(slash + 1), file);
    }
  }
  return index;
}
