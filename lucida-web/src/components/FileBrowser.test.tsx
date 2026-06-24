// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { FileBrowser } from "./FileBrowser.tsx";

interface BrowseResponse {
  path: string;
  entries: Array<{ name: string; type: "directory" | "file" }>;
}

interface FetchSpy {
  urls: string[];
  responder: (url: string) => BrowseResponse;
}

let fetchSpy: FetchSpy;
let originalFetch: typeof globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchSpy = {
    urls: [],
    // Default responder: drive-list style root with one drive `c:` so
    // tests exercising the "click into root entry" path have something
    // to click.
    responder: () => ({
      path: "",
      entries: [{ name: "c:", type: "directory" }],
    }),
  };
  globalThis.fetch = (async (url: string) => {
    fetchSpy.urls.push(url);
    return jsonResponse(fetchSpy.responder(url));
  }) as typeof globalThis.fetch;
  // Each test starts with a clean sessionStorage so the initial-path
  // logic isn't biased by a prior test's persisted value.
  window.sessionStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe("FileBrowser — empty-root initial fetch", () => {
  it("issues exactly one fetch on mount with no `path=` query param", async () => {
    await act(async () => {
      render(<FileBrowser onSelect={() => {}} onClose={() => {}} />);
    });
    expect(fetchSpy.urls.length).toBe(1);
    const url = fetchSpy.urls[0];
    // Bare endpoint — no `path=` param of any kind. This is the signal
    // to the server to return its platform-default root.
    expect(url).toBe("http://localhost:9876/api/browse");
    expect(url).not.toContain("path=");
  });

  it("renders the entries returned by the platform-default-root response", async () => {
    fetchSpy.responder = () => ({
      path: "",
      entries: [
        { name: "c:", type: "directory" },
        { name: "d:", type: "directory" },
      ],
    });
    await act(async () => {
      render(<FileBrowser onSelect={() => {}} onClose={() => {}} />);
    });
    expect(screen.getByText("c:")).toBeTruthy();
    expect(screen.getByText("d:")).toBeTruthy();
  });
});

describe("FileBrowser — navigation", () => {
  it(
    "joins the entry name onto the current path with `/` when navigating " +
      "into a non-empty path",
    async () => {
      // First response: a /home/me listing with one subdirectory.
      let callCount = 0;
      fetchSpy.responder = () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            path: "/home/me",
            entries: [{ name: "data", type: "directory" }],
          };
        }
        // Second response: arbitrary — assertion is on the request URL.
        return { path: "/home/me/data", entries: [] };
      };
      // Seed sessionStorage so the initial fetch starts at /home/me
      // (so the subsequent click exercises the non-empty join branch).
      window.sessionStorage.setItem("lucida-browse-path", "/home/me");

      await act(async () => {
        render(<FileBrowser onSelect={() => {}} onClose={() => {}} />);
      });
      // Initial fetch hit the seeded path.
      expect(fetchSpy.urls[0]).toContain(
        `path=${encodeURIComponent("/home/me")}`,
      );

      // Click the `data` entry.
      await act(async () => {
        fireEvent.click(screen.getByText("data"));
      });
      // Second fetch URL must carry the joined path.
      expect(fetchSpy.urls.length).toBe(2);
      expect(fetchSpy.urls[1]).toContain(
        `path=${encodeURIComponent("/home/me/data")}`,
      );
    },
  );

  it(
    "uses the entry name as the new path (no leading `/`) when " +
      "navigating from the empty drives-root",
    async () => {
      // Initial response: Windows-style drives root.
      let callCount = 0;
      fetchSpy.responder = () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            path: "",
            entries: [{ name: "c:", type: "directory" }],
          };
        }
        return { path: "c:", entries: [] };
      };

      await act(async () => {
        render(<FileBrowser onSelect={() => {}} onClose={() => {}} />);
      });
      // Initial fetch: no path param.
      expect(fetchSpy.urls[0]).toBe("http://localhost:9876/api/browse");

      // Click `c:` — the empty-root branch in `navigateTo` must NOT
      // prefix a `/`, otherwise we'd produce `/c:` (a bogus path).
      await act(async () => {
        fireEvent.click(screen.getByText("c:"));
      });
      expect(fetchSpy.urls.length).toBe(2);
      expect(fetchSpy.urls[1]).toBe(
        `http://localhost:9876/api/browse?path=${encodeURIComponent("c:")}`,
      );
      // Triple-check: there's no `/c:` artefact in the URL.
      expect(fetchSpy.urls[1]).not.toContain(encodeURIComponent("/c:"));
    },
  );
});

describe("FileBrowser — create workspace from selection (multi-select)", () => {
  it("shows create-workspace affordances only when onCreateWorkspace is given", async () => {
    // Land on a zarr directory so the dataset is detectable.
    fetchSpy.responder = () => ({
      path: "/data/a.zarr",
      entries: [{ name: "zarr.json", type: "file" }],
    });
    window.sessionStorage.setItem("lucida-browse-path", "/data/a.zarr");

    // Without onCreateWorkspace: classic single Open, no create button.
    await act(async () => {
      render(<FileBrowser onSelect={() => {}} onClose={() => {}} />);
    });
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /create workspace/i }),
    ).toBeNull();
    cleanup();

    // With onCreateWorkspace: create affordance present.
    await act(async () => {
      render(<FileBrowser onCreateWorkspace={() => {}} onClose={() => {}} />);
    });
    expect(
      screen.getByRole("button", { name: /create workspace from selection/i }),
    ).toBeTruthy();
    // No single-Open button when onSelect is absent.
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("creates a workspace from the current zarr dir without an explicit Add", async () => {
    fetchSpy.responder = () => ({
      path: "/data/solo.zarr",
      entries: [{ name: "zarr.json", type: "file" }],
    });
    window.sessionStorage.setItem("lucida-browse-path", "/data/solo.zarr");

    const onCreateWorkspace = vi.fn();
    await act(async () => {
      render(
        <FileBrowser onCreateWorkspace={onCreateWorkspace} onClose={() => {}} />,
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: /create workspace from selection/i }),
    );
    expect(onCreateWorkspace).toHaveBeenCalledWith(["/data/solo.zarr"]);
  });

  it("accumulates MULTIPLE datasets across directories and creates from all", async () => {
    // Two zarr dirs reachable by navigating; each browse returns a zarr dir.
    let call = 0;
    fetchSpy.responder = () => {
      call += 1;
      if (call === 1) {
        return {
          path: "/data/a.zarr",
          entries: [{ name: "zarr.json", type: "file" }],
        };
      }
      return {
        path: "/data/b.zarr",
        entries: [{ name: "zarr.json", type: "file" }],
      };
    };
    window.sessionStorage.setItem("lucida-browse-path", "/data/a.zarr");

    const onCreateWorkspace = vi.fn();
    await act(async () => {
      render(
        <FileBrowser onCreateWorkspace={onCreateWorkspace} onClose={() => {}} />,
      );
    });

    // Add the first dataset to the selection.
    fireEvent.click(screen.getByRole("button", { name: "Add to selection" }));
    expect(screen.getByTestId("file-browser-selection").textContent).toContain(
      "/data/a.zarr",
    );

    // Navigate to the home breadcrumb to trigger a second browse → b.zarr.
    const homeButton = screen.getAllByRole("button", { name: "/" })[0];
    await act(async () => {
      fireEvent.click(homeButton);
    });

    // Add the second dataset, then create.
    fireEvent.click(screen.getByRole("button", { name: "Add to selection" }));
    fireEvent.click(
      screen.getByRole("button", { name: /create workspace \(2\)/i }),
    );
    expect(onCreateWorkspace).toHaveBeenCalledWith([
      "/data/a.zarr",
      "/data/b.zarr",
    ]);
  });

  it("removes a dataset from the selection before creating", async () => {
    fetchSpy.responder = () => ({
      path: "/data/a.zarr",
      entries: [{ name: "zarr.json", type: "file" }],
    });
    window.sessionStorage.setItem("lucida-browse-path", "/data/a.zarr");

    const onCreateWorkspace = vi.fn();
    await act(async () => {
      render(
        <FileBrowser onCreateWorkspace={onCreateWorkspace} onClose={() => {}} />,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Add to selection" }));
    // "Added" reflects the current dir is already collected.
    expect(screen.getByRole("button", { name: "Added" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove /data/a.zarr from selection" }),
    );
    expect(screen.queryByTestId("file-browser-selection")).toBeNull();
  });
});

describe("FileBrowser — root breadcrumb", () => {
  it("clicking the leading `/` breadcrumb issues a fetch with no `path=` param", async () => {
    // Start at a deep Windows-style path so the home breadcrumb is
    // meaningfully different from the current path.
    let callCount = 0;
    fetchSpy.responder = () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          path: "c:/Users/me",
          entries: [{ name: "data", type: "directory" }],
        };
      }
      // Home breadcrumb click → server returns drives root.
      return { path: "", entries: [{ name: "c:", type: "directory" }] };
    };
    window.sessionStorage.setItem("lucida-browse-path", "c:/Users/me");

    await act(async () => {
      render(<FileBrowser onSelect={() => {}} onClose={() => {}} />);
    });
    expect(fetchSpy.urls[0]).toContain(
      `path=${encodeURIComponent("c:/Users/me")}`,
    );

    // The home breadcrumb is the first button rendered, labelled "/".
    // Multiple buttons render "/" as text — use getAllByText and pick
    // the first, which is the home button (the others are interstitial
    // separators that are <span>s, not buttons).
    const homeButton = screen.getAllByRole("button", { name: "/" })[0];
    await act(async () => {
      fireEvent.click(homeButton);
    });
    expect(fetchSpy.urls.length).toBe(2);
    expect(fetchSpy.urls[1]).toBe("http://localhost:9876/api/browse");
    expect(fetchSpy.urls[1]).not.toContain("path=");
  });
});
