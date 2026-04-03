import { useCallback } from "react";

interface Params {
  sendOpenRemoteDataset: (url: string) => void;
}

export function useDatasets({ sendOpenRemoteDataset }: Params) {
  const handleUrlSubmit = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    sendOpenRemoteDataset(trimmed);
  }, [sendOpenRemoteDataset]);

  return { handleUrlSubmit };
}
