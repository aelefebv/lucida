// @vitest-environment happy-dom
//
// Hook-level tests for `useDatasets.handleUrlSubmit`. Verifies the
// canonical-URL contract from ADR-0042: every URL the SPA hands to
// `sendOpenRemoteDataset` has been normalized via the wasm shim, so
// spelling variants of the same Windows / UNC path produce one
// `DatasetId` and one `ServerBinding` on the server side.
//
// Mocks `lucida-core` so the hook constructs without a real wasm init
// (mirrors `useSavedViewSync.test.tsx`'s mock of `dataset_id_for_url`).
// The mock reproduces the canonical-form rules under test — it isn't a
// replacement for the wasm helper, but it locks the property the hook
// guarantees: "what we send is what `normalize_dataset_url` returned."

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock BEFORE importing the hook so the import-time
// `normalize_dataset_url` reference picks up the stub.
vi.mock("lucida-core", () => ({
  // Minimal mock covering the cases this test exercises. The Rust
  // implementation handles the full matrix (see
  // `lucida-content/src/url.rs` tests); the wasm-shim smoke test in
  // `savedView/urlHelpers.test.ts` covers wiring drift.
  normalize_dataset_url: (raw: string): string => {
    if (raw === "") return "";
    // Drive-letter: lowercase + forward-slashify.
    const drive = raw.match(/^([A-Za-z]):[\\/]?(.*)$/);
    if (drive) {
      const letter = drive[1].toLowerCase();
      const rest = drive[2].replace(/\\/g, "/");
      return rest.length > 0 ? `${letter}:/${rest}` : `${letter}:`;
    }
    // file:///C:/... — strip prefix then recurse.
    if (raw.startsWith("file:///")) {
      return (
        // call self via the module-local binding
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        moduleStub.normalize_dataset_url(raw.slice("file:///".length))
      );
    }
    // UNC backslash form.
    if (raw.startsWith("\\\\")) {
      return raw.replace(/\\/g, "/");
    }
    // Unix and remote schemes: passthrough.
    return raw;
  },
}));

// Re-import for the self-call above (file:// branch).
import * as moduleStub from "lucida-core";
import { useDatasets } from "./useDatasets.ts";

describe("useDatasets.handleUrlSubmit", () => {
  it("normalizes a Windows drive-letter path before sending", () => {
    const send = vi.fn();
    const { result } = renderHook(() =>
      useDatasets({ sendOpenRemoteDataset: send }),
    );

    act(() => {
      result.current.handleUrlSubmit("C:\\Users\\me\\foo.zarr");
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("c:/Users/me/foo.zarr");
  });

  it("normalizes a file:// drive-letter path before sending", () => {
    const send = vi.fn();
    const { result } = renderHook(() =>
      useDatasets({ sendOpenRemoteDataset: send }),
    );

    act(() => {
      result.current.handleUrlSubmit("file:///C:/Users/me/foo.zarr");
    });

    expect(send).toHaveBeenCalledWith("c:/Users/me/foo.zarr");
  });

  it("normalizes a UNC path before sending", () => {
    const send = vi.fn();
    const { result } = renderHook(() =>
      useDatasets({ sendOpenRemoteDataset: send }),
    );

    act(() => {
      result.current.handleUrlSubmit("\\\\server\\share\\foo.zarr");
    });

    expect(send).toHaveBeenCalledWith("//server/share/foo.zarr");
  });

  it("trims whitespace before normalizing", () => {
    const send = vi.fn();
    const { result } = renderHook(() =>
      useDatasets({ sendOpenRemoteDataset: send }),
    );

    act(() => {
      result.current.handleUrlSubmit("  C:\\foo  ");
    });

    expect(send).toHaveBeenCalledWith("c:/foo");
  });

  it("passes Unix paths through unchanged", () => {
    const send = vi.fn();
    const { result } = renderHook(() =>
      useDatasets({ sendOpenRemoteDataset: send }),
    );

    act(() => {
      result.current.handleUrlSubmit("/data/scans/foo.zarr");
    });

    expect(send).toHaveBeenCalledWith("/data/scans/foo.zarr");
  });

  it("passes remote-scheme URLs through unchanged", () => {
    const send = vi.fn();
    const { result } = renderHook(() =>
      useDatasets({ sendOpenRemoteDataset: send }),
    );

    act(() => {
      result.current.handleUrlSubmit("gs://bucket/path/to/foo.zarr");
    });

    expect(send).toHaveBeenCalledWith("gs://bucket/path/to/foo.zarr");
  });

  it("ignores empty / whitespace-only input", () => {
    const send = vi.fn();
    const { result } = renderHook(() =>
      useDatasets({ sendOpenRemoteDataset: send }),
    );

    act(() => {
      result.current.handleUrlSubmit("");
      result.current.handleUrlSubmit("   ");
    });

    expect(send).not.toHaveBeenCalled();
  });
});
