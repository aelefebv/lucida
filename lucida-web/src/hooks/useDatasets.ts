import { useCallback } from "react";
import { normalize_dataset_url } from "lucida-core";

interface Params {
  sendOpenRemoteDataset: (url: string) => void;
}

export function useDatasets({ sendOpenRemoteDataset }: Params) {
  // The canonical form is what gets hashed into the `DatasetId`, so
  // `C:\Users\me\foo.zarr` and `c:/Users/me/foo.zarr` dedupe to one dataset.
  const handleUrlSubmit = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    sendOpenRemoteDataset(normalize_dataset_url(trimmed));
  }, [sendOpenRemoteDataset]);

  return { handleUrlSubmit };
}
