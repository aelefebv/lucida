// @vitest-environment jsdom

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { bootstrapApp, type AppController } from "../src/app-shell";

type SocketFixture = {
  server: WebSocketServer;
  httpServer: ReturnType<typeof createServer> | null;
  url: string;
  dataBaseUrl: string | null;
  received: unknown[];
  close: () => Promise<void>;
};

const controllers: AppController[] = [];
const fixtures: SocketFixture[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.dispose();
  }
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

describe("app shell routing", () => {
  it("boots /viewer and attaches over websocket", async () => {
    const fixture = await startFixtureServer({
      permissionClass: "view",
      isLeaseHolder: false,
    });
    fixtures.push(fixture);

    mountApp(
      `/viewer?session=sess_demo&client=browser-a&wsBase=${encodeURIComponent(fixture.url)}`,
    );
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    await waitFor(() => {
      const status = queryText("attach-status");
      return status.includes("Attached");
    });

    expect(queryText("capability-state")).toContain("View only");
    expect(queryText("route-kind")).toContain("viewer");

    const attachMessage = fixture.received.find((value) => {
      return isRecord(value) && value.message_type === "attach";
    }) as Record<string, unknown> | undefined;
    expect(attachMessage).toBeDefined();
    expect(attachMessage?.client_label).toBe("browser-a");
    expect(attachMessage?.requested_permission).toBe("view");
  });

  it("boots /jupyter/viewer and exposes iframe target marker", async () => {
    const fixture = await startFixtureServer({
      permissionClass: "control",
      isLeaseHolder: true,
    });
    fixtures.push(fixture);

    mountApp(
      `/jupyter/viewer?session=sess_jupyter&client=notebook-a&mode=control&token=tok&wsBase=${encodeURIComponent(
        fixture.url,
      )}`,
    );
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    await waitFor(() => {
      const status = queryText("attach-status");
      return status.includes("Attached");
    });

    expect(queryText("route-kind")).toContain("jupyter-viewer");
    expect(queryText("capability-state")).toContain("Control (lease holder)");
    expect(queryText("jupyter-target")).toContain("Jupyter iframe target route ready");
  });

  it("boots /viewer without session in demo mode and renders a frame", async () => {
    mountApp("/viewer");
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    await waitFor(() => {
      return queryText("frame-state").includes("(tile)");
    }, 3000);

    expect(queryText("route-kind")).toContain("viewer-demo");
    expect(queryText("capability-state")).toContain("View only (demo)");
    expect(queryText("viewport-meta")).toContain("384x256");

    const canvas = document.querySelector('[data-testid="viewport-canvas"]');
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect((canvas as HTMLCanvasElement).getAttribute("data-frame-kind")).toBe("tile");
  });

  it("shows route guidance for unsupported paths", () => {
    mountApp("/unknown");
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    const errorText = queryText("route-error");
    expect(errorText).toContain("Unknown route");
    expect(errorText).toContain("/viewer");
  });

  it("renders preview-first then tile refinement with coherent minimap and warnings", async () => {
    const fixture = await startIntegratedRenderFixture();
    fixtures.push(fixture);

    mountApp(
      `/viewer?session=sess_demo&client=browser-a&wsBase=${encodeURIComponent(
        fixture.url,
      )}&dataBase=${encodeURIComponent(fixture.dataBaseUrl ?? "")}`,
    );
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    await waitFor(() => queryText("frame-state").includes("(preview)"), 3000);
    await waitFor(() => queryText("frame-state").includes("(tile)"), 3000);

    expect(queryText("minimap-state")).toContain("z 0 / 0");
    expect(queryText("warning-state")).toContain("Generation 1 still refining.");
  });
});

async function startFixtureServer(config: {
  permissionClass: "view" | "control" | "admin";
  isLeaseHolder: boolean;
}): Promise<SocketFixture> {
  const received: unknown[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const text = raw.toString("utf-8");
      const parsed = JSON.parse(text) as unknown;
      received.push(parsed);
      if (isRecord(parsed) && parsed.message_type === "attach") {
        socket.send(
          JSON.stringify({
            message_type: "session.snapshot",
            session_id: "sess_fixture",
            permission_class: config.permissionClass,
            is_lease_holder: config.isLeaseHolder,
            snapshot: {
              session: {
                session_id: "sess_fixture",
                session_rev: 1,
              },
              shared_scene: {
                scene_rev: 0,
                sources: {},
                datasets: {},
                layers: {},
                warnings: [],
              },
              client_view: {
                client_id: "cli_fixture",
                view_rev: 1,
                active_layer_id: null,
                center_x: 0,
                center_y: 0,
                zoom: 1,
                z_index: 0,
                t_index: 0,
                selected_channels: [0],
                warnings: [],
              },
              warnings: [],
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.on("listening", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port.toString()}`;

  return {
    server,
    httpServer: null,
    url,
    dataBaseUrl: null,
    received,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function startIntegratedRenderFixture(): Promise<SocketFixture> {
  const received: unknown[] = [];
  const previewBody = pgmBody(2, 1, [20, 20]);
  const tileBody = pgmBody(2, 1, [220, 220]);

  const httpServer = createServer((request, response) => {
    if (request.url?.includes("/v1/preview2d/")) {
      setTimeout(() => {
        respondPgm(response, previewBody);
      }, 20);
      return;
    }
    if (request.url?.includes("/v1/tile2d/")) {
      setTimeout(() => {
        respondPgm(response, tileBody);
      }, 140);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const httpAddress = httpServer.address() as AddressInfo;
  const dataBaseUrl = `http://127.0.0.1:${httpAddress.port.toString()}`;

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const text = raw.toString("utf-8");
      const parsed = JSON.parse(text) as unknown;
      received.push(parsed);
      if (isRecord(parsed) && parsed.message_type === "attach") {
        socket.send(
          JSON.stringify({
            message_type: "session.snapshot",
            session_id: "sess_fixture",
            permission_class: "view",
            is_lease_holder: false,
            snapshot: {
              session: {
                session_id: "sess_fixture",
                session_rev: 2,
              },
              shared_scene: {
                scene_rev: 1,
                sources: {
                  src_fixture: {
                    sourceId: "src_fixture",
                    name: "fixture",
                    status: "watching",
                    latestWorkingGenerationSeq: 1,
                  },
                },
                datasets: {
                  ds_fixture: {
                    datasetId: "ds_fixture",
                    sourceId: "src_fixture",
                    resolvedGenerationSeq: 1,
                  },
                },
                layers: {
                  lay_fixture: {
                    layerId: "lay_fixture",
                    name: "raw",
                    layerRev: 1,
                    metadataRev: 0,
                    writeRev: 0,
                  },
                },
                warnings: [],
              },
              client_view: {
                client_id: "cli_fixture",
                view_rev: 1,
                active_layer_id: "lay_fixture",
                center_x: 0,
                center_y: 0,
                zoom: 1,
                z_index: 0,
                t_index: 0,
                selected_channels: [0],
                warnings: [],
              },
              warnings: [
                {
                  warningCode: "generation_build_incomplete",
                  severity: "warning",
                  message: "Generation 1 still refining.",
                },
              ],
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.on("listening", () => resolve());
  });
  const wsAddress = server.address() as AddressInfo;
  const wsUrl = `ws://127.0.0.1:${wsAddress.port.toString()}`;

  return {
    server,
    httpServer,
    url: wsUrl,
    dataBaseUrl,
    received,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function mountApp(pathAndQuery: string): void {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState({}, "", pathAndQuery);
}

function queryText(testId: string): string {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`missing data-testid node ${testId}`);
  }
  return node.textContent ?? "";
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 1200,
  intervalMs = 20,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error("condition not satisfied before timeout");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function respondPgm(
  response: ServerResponse<IncomingMessage>,
  body: Buffer,
): void {
  response.statusCode = 200;
  response.setHeader("content-type", "image/x-portable-graymap");
  response.end(body);
}

function pgmBody(width: number, height: number, values: number[]): Buffer {
  const header = Buffer.from(`P5\n${width.toString()} ${height.toString()}\n255\n`, "ascii");
  return Buffer.concat([header, Buffer.from(values)]);
}
