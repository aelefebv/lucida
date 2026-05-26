import { useCallback } from "react";
import { normalize_dataset_url } from "lucida-core";

interface Params {
  sendOpenRemoteDataset: (url: string) => void;
}

export function useDatasets({ sendOpenRemoteDataset }: Params) {
  // Normalize the user-typed URL before submitting. The canonical form is
  // what gets hashed into the `DatasetId`, broadcast on the wire, and
  // shown back in the URL bar — so canonicalizing here means the
  // sequence "type `C:\Users\me\foo.zarr`, hit enter" deduplicates with
  // a later `c:/Users/me/foo.zarr` and resolves to the same
  // `DatasetId`. See `wiki/decisions/0042-canonical-dataset-url-form.md`.
  const handleUrlSubmit = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    sendOpenRemoteDataset(normalize_dataset_url(trimmed));
  }, [sendOpenRemoteDataset]);

  return { handleUrlSubmit };
}
