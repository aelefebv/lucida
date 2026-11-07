// @vitest-environment happy-dom
//
// Every URL handed to `sendOpenRemoteDataset` is normalized first,
// so spelling variants of one Windows or UNC path produce one `DatasetId`.
// The `lucida-core` mock reproduces only the rules under test; it locks the
// property "what we send is what `normalize_dataset_url` returned."

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock before importing the hook so the import-time
// `normalize_dataset_url` reference picks up the stub.
vi.mock("lucida-core", () => ({
  // The full matrix is tested in `lucida-content/src/url.rs`; wiring drift
  // in `savedView/urlHelpers.test.ts`.
  normalize_dataset_url: (raw: string): string => {
    if (raw === "") return "";
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
