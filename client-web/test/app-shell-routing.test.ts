// @vitest-environment jsdom

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { bootstrapApp, type AppController } from "../src/app-shell";

type SocketFixture = {
  server: WebSocketServer;
  httpServer: ReturnType<typeof createServer> | null;
  url: string;
  dataBaseUrl: string | null;
  received: unknown[];
  openSourceRequests: Array<{ name: string; uri: string }>;
  close: () => Promise<void>;
};

type SourceOpenActionFixtureOptions = {
  emitSceneUpsertEvents?: boolean;
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
    const viewportCanvas = queryCanvas("viewport-canvas");
    expect(viewportCanvas.width).toBe(2);
    expect(viewportCanvas.height).toBe(1);
  });

  it("opens a source from the viewer shell and drives first render", async () => {
    const fixture = await startSourceOpenActionFixture();
    fixtures.push(fixture);

    mountApp(
      `/viewer?session=sess_open_ui&client=browser-open-ui&wsBase=${encodeURIComponent(
        fixture.url,
      )}&dataBase=${encodeURIComponent(fixture.dataBaseUrl ?? "")}`,
    );
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    await waitFor(() => {
      const status = queryText("attach-status");
      return status.includes("Attached");
    });

    queryInput("input-source-name").value = "my-ome-source";
    queryInput("input-source-uri").value = "/tmp/demo.ome.zarr";
    queryButton("btn-open-source").click();

    await waitFor(() => {
      return queryText("open-source-status").includes("Opened source");
    }, 3000);

    expect(fixture.openSourceRequests).toEqual([
      { name: "my-ome-source", uri: "/tmp/demo.ome.zarr" },
    ]);

    await waitFor(() => queryText("frame-state").includes("(preview)"), 3000);
    await waitFor(() => queryText("frame-state").includes("(tile)"), 3000);
  });

  it("switches to a newly opened source even when scene upsert events are absent", async () => {
    const fixture = await startSourceOpenActionFixture({
      emitSceneUpsertEvents: false,
    });
    fixtures.push(fixture);

    mountApp(
      `/viewer?session=sess_open_ui&client=browser-open-ui&wsBase=${encodeURIComponent(
        fixture.url,
      )}&dataBase=${encodeURIComponent(fixture.dataBaseUrl ?? "")}`,
    );
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    await waitFor(() => {
      const status = queryText("attach-status");
      return status.includes("Attached");
    });

    queryInput("input-source-name").value = "my-ome-source";
    queryInput("input-source-uri").value = "/tmp/demo.ome.zarr";
    queryButton("btn-open-source").click();

    await waitFor(() => {
      return queryText("open-source-status").includes("Opened source");
    }, 3000);

    expect(fixture.openSourceRequests).toEqual([
      { name: "my-ome-source", uri: "/tmp/demo.ome.zarr" },
    ]);

    await waitFor(() => queryText("frame-state").includes("(preview)"), 3000);
    await waitFor(() => queryText("frame-state").includes("(tile)"), 3000);
  });

  it("sends pan/zoom and z/t/channel commands from viewer controls", async () => {
    const fixture = await startFixtureServer({
      permissionClass: "view",
      isLeaseHolder: false,
    });
    fixtures.push(fixture);

    mountApp(
      `/viewer?session=sess_demo&client=browser-controls&wsBase=${encodeURIComponent(
        fixture.url,
      )}`,
    );
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    await waitFor(() => queryText("attach-status").includes("Attached"));

    queryButton("btn-pan-left").click();
    queryButton("btn-zoom-in").click();

    queryInput("input-z-index").value = "3";
    queryInput("input-z-index").dispatchEvent(new Event("input", { bubbles: true }));
    queryInput("input-t-index").value = "2";
    queryInput("input-t-index").dispatchEvent(new Event("input", { bubbles: true }));
    queryInput("input-channel-list").value = "1, 4";
    queryButton("btn-channels-apply").click();

    await waitFor(() => {
      const commandCount = fixture.received.filter((value) => {
        return isRecord(value) && value.message_type === "command";
      }).length;
      return commandCount >= 5;
    }, 2000);

    const commands = fixture.received.filter((value): value is Record<string, unknown> => {
      return isRecord(value) && value.message_type === "command";
    });
    const ops = commands
      .map((command) => command.op)
      .filter((value): value is string => typeof value === "string");
    expect(ops).toContain("view.pan");
    expect(ops).toContain("view.zoom");
    expect(ops).toContain("view.set_z");
    expect(ops).toContain("view.set_t");
    expect(ops).toContain("view.set_channels");

    const setZ = commands.find((command) => command.op === "view.set_z");
    expect(setZ).toBeDefined();
    expect((setZ?.args as { z_index?: unknown })?.z_index).toBe(3);

    const setT = commands.find((command) => command.op === "view.set_t");
    expect(setT).toBeDefined();
    expect((setT?.args as { t_index?: unknown })?.t_index).toBe(2);

    const setChannels = commands.find((command) => command.op === "view.set_channels");
    expect(setChannels).toBeDefined();
    expect((setChannels?.args as { channels?: unknown })?.channels).toEqual([1, 4]);
  });

  it("clamps z/t/channel controls to dataset bounds", async () => {
    const fixture = await startFixtureServer({
      permissionClass: "view",
      isLeaseHolder: false,
      datasetShape: {
        sizeT: 30,
        sizeC: 2,
        sizeZ: 17,
        sizeY: 192,
        sizeX: 279,
      },
    });
    fixtures.push(fixture);

    mountApp(
      `/viewer?session=sess_demo&client=browser-controls&wsBase=${encodeURIComponent(
        fixture.url,
      )}`,
    );
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    await waitFor(() => queryText("attach-status").includes("Attached"));

    expect(queryInput("input-z-index").max).toBe("16");
    expect(queryInput("input-t-index").max).toBe("29");

    queryInput("input-z-index").value = "99";
    queryInput("input-z-index").dispatchEvent(new Event("input", { bubbles: true }));
    queryInput("input-t-index").value = "44";
    queryInput("input-t-index").dispatchEvent(new Event("input", { bubbles: true }));
    queryInput("input-channel-list").value = "7, 3";
    queryButton("btn-channels-apply").click();

    await waitFor(() => {
      const commandCount = fixture.received.filter((value) => {
        return isRecord(value) && value.message_type === "command";
      }).length;
      return commandCount >= 3;
    }, 2000);

    const commands = fixture.received.filter((value): value is Record<string, unknown> => {
      return isRecord(value) && value.message_type === "command";
    });
    const setZ = commands.find((command) => command.op === "view.set_z");
    expect((setZ?.args as { z_index?: unknown })?.z_index).toBe(16);

    const setT = commands.find((command) => command.op === "view.set_t");
    expect((setT?.args as { t_index?: unknown })?.t_index).toBe(29);

    const setChannels = commands.find((command) => command.op === "view.set_channels");
    expect((setChannels?.args as { channels?: unknown })?.channels).toEqual([1]);
  });

  it("updates contrast limits from sliders and supports auto reset", async () => {
    const fixture = await startIntegratedRenderFixture();
    fixtures.push(fixture);

    mountApp(
      `/viewer?session=sess_demo&client=browser-a&wsBase=${encodeURIComponent(
        fixture.url,
      )}&dataBase=${encodeURIComponent(fixture.dataBaseUrl ?? "")}`,
    );
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    await waitFor(() => queryText("frame-state").includes("(tile)"), 3000);
    expect(queryElement("contrast-dual-slider")).toBeInstanceOf(HTMLElement);

    const minSlider = queryInput("slider-contrast-min");
    const maxSlider = queryInput("slider-contrast-max");

    minSlider.value = "100";
    minSlider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(queryText("contrast-values")).toContain("100-255");
    expect(queryText("contrast-state")).toContain("100-255");

    maxSlider.value = "180";
    maxSlider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(queryText("contrast-values")).toContain("100-180");
    expect(queryText("contrast-state")).toContain("100-180");

    queryButton("btn-contrast-auto").click();
    expect(queryText("contrast-values")).toContain("0-255");
    expect(queryText("contrast-state")).toContain("0-255");
  });

  it("adapts contrast slider range to 16-bit frame payloads", async () => {
    const fixture = await startIntegratedRenderFixture16Bit();
    fixtures.push(fixture);

    mountApp(
      `/viewer?session=sess_demo&client=browser-a&wsBase=${encodeURIComponent(
        fixture.url,
      )}&dataBase=${encodeURIComponent(fixture.dataBaseUrl ?? "")}`,
    );
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    await waitFor(() => queryText("frame-state").includes("(tile)"), 3000);

    const minSlider = queryInput("slider-contrast-min");
    const maxSlider = queryInput("slider-contrast-max");
    expect(minSlider.max).toBe("65535");
    expect(maxSlider.max).toBe("65535");
    expect(queryText("contrast-values")).toContain("/ 65535");
    expect(queryText("contrast-state")).toContain("/ 65535");

    minSlider.value = "100";
    minSlider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(queryText("contrast-values")).toContain("100-121 / 65535");
  });
});

async function startFixtureServer(config: {
  permissionClass: "view" | "control" | "admin";
  isLeaseHolder: boolean;
  datasetShape?: {
    sizeT: number;
    sizeC: number;
    sizeZ: number;
    sizeY?: number;
    sizeX?: number;
  };
}): Promise<SocketFixture> {
  const received: unknown[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  const sources =
    config.datasetShape === undefined
      ? {}
      : {
          src_fixture: {
            sourceId: "src_fixture",
            name: "fixture",
            status: "watching",
            latestWorkingGenerationSeq: 1,
          },
        };
  const datasets =
    config.datasetShape === undefined
      ? {}
      : {
          ds_fixture: {
            datasetId: "ds_fixture",
            sourceId: "src_fixture",
            resolvedGenerationSeq: 1,
            dtype: "uint16",
            sizeT: config.datasetShape.sizeT,
            sizeC: config.datasetShape.sizeC,
            sizeZ: config.datasetShape.sizeZ,
            sizeY: config.datasetShape.sizeY ?? 1,
            sizeX: config.datasetShape.sizeX ?? 1,
          },
        };

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
                sources,
                datasets,
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
    openSourceRequests: [],
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
  const tileBody = channelBlockRawPayload(pgmBody(2, 1, [220, 220]));

  const httpServer = createServer((request, response) => {
    if (request.url?.includes("/v1/preview2d/")) {
      setTimeout(() => {
        respondPgm(response, previewBody);
      }, 20);
      return;
    }
    if (request.url?.includes("/v1/tile2d/")) {
      setTimeout(() => {
        respondBinary(response, tileBody);
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
                    dtype: "uint8",
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
    openSourceRequests: [],
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

async function startIntegratedRenderFixture16Bit(): Promise<SocketFixture> {
  const received: unknown[] = [];
  const previewBody = pgm16Body(2, 1, [87, 121]);
  const tileBody = channelBlockRawPayload(pgm16Body(2, 1, [87, 121]));

  const httpServer = createServer((request, response) => {
    if (request.url?.includes("/v1/preview2d/")) {
      setTimeout(() => {
        respondPgm(response, previewBody);
      }, 20);
      return;
    }
    if (request.url?.includes("/v1/tile2d/")) {
      setTimeout(() => {
        respondBinary(response, tileBody);
      }, 80);
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
                    dtype: "uint16",
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
  const wsAddress = server.address() as AddressInfo;
  const wsUrl = `ws://127.0.0.1:${wsAddress.port.toString()}`;

  return {
    server,
    httpServer,
    url: wsUrl,
    dataBaseUrl,
    received,
    openSourceRequests: [],
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

async function startSourceOpenActionFixture(
  options: SourceOpenActionFixtureOptions = {},
): Promise<SocketFixture> {
  const received: unknown[] = [];
  const openSourceRequests: Array<{ name: string; uri: string }> = [];
  const previewBody = pgmBody(2, 1, [12, 34]);
  const tileBody = channelBlockRawPayload(pgmBody(2, 1, [200, 210]));
  let sessionRev = 1;
  const connectedSockets = new Set<WebSocket>();
  const sessionId = "sess_open_ui";
  const emitSceneUpsertEvents = options.emitSceneUpsertEvents ?? true;
  let openedSource:
    | {
        sourceId: string;
        datasetId: string;
        sourceName: string;
        generationSeq: number;
        dtype: string;
      }
    | null = null;

  const httpServer = createServer((request, response) => {
    if (request.method === "POST" && request.url === `/v1/sessions/${sessionId}/sources`) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      request.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(bodyText) as { name?: unknown; uri?: unknown };
        const name = typeof parsed.name === "string" ? parsed.name : "";
        const uri = typeof parsed.uri === "string" ? parsed.uri : "";
        openSourceRequests.push({ name, uri });
        openedSource = {
          sourceId: "src_open",
          datasetId: "ds_open",
          sourceName: name,
          generationSeq: 1,
          dtype: "uint8",
        };
        sessionRev += 1;

        response.statusCode = 201;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            source_id: openedSource.sourceId,
            dataset_id: openedSource.datasetId,
            generation_id: "gen_open_1",
            generation_seq: openedSource.generationSeq,
            source_status: "watching",
          }),
        );

        if (emitSceneUpsertEvents) {
          sessionRev += 1;
          broadcastEvent(connectedSockets, {
            message_type: "event",
            schema_version: "lucida-proto-0.1",
            session_id: sessionId,
            session_rev: sessionRev,
            event_type: "scene_source_upsert",
            payload: {
              sourceId: openedSource.sourceId,
              name,
              status: "watching",
              latestWorkingGenerationSeq: openedSource.generationSeq,
            },
          });
          sessionRev += 1;
          broadcastEvent(connectedSockets, {
            message_type: "event",
            schema_version: "lucida-proto-0.1",
            session_id: sessionId,
            session_rev: sessionRev,
            event_type: "scene_dataset_upsert",
            payload: {
              datasetId: openedSource.datasetId,
              sourceId: openedSource.sourceId,
              resolvedGenerationSeq: openedSource.generationSeq,
              dtype: openedSource.dtype,
            },
          });
        }
      });
      return;
    }
    if (request.method === "GET" && request.url === `/v1/sessions/${sessionId}/snapshot`) {
      const sources =
        openedSource === null
          ? {}
          : {
              [openedSource.sourceId]: {
                sourceId: openedSource.sourceId,
                name: openedSource.sourceName,
                status: "watching",
                latestWorkingGenerationSeq: openedSource.generationSeq,
              },
            };
      const datasets =
        openedSource === null
          ? {}
          : {
              [openedSource.datasetId]: {
                datasetId: openedSource.datasetId,
                sourceId: openedSource.sourceId,
                resolvedGenerationSeq: openedSource.generationSeq,
                dtype: openedSource.dtype,
              },
            };
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          message_type: "session.snapshot",
          schema_version: "lucida-proto-0.1",
          session_id: sessionId,
          session_rev: sessionRev,
          permission_class: "view",
          is_lease_holder: false,
          snapshot: {
            session: {
              session_id: sessionId,
              session_rev: sessionRev,
            },
            shared_scene: {
              scene_rev: 1,
              sources,
              datasets,
              layers: {},
              warnings: [],
            },
            client_view: {
              client_id: "cli_open_ui",
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
      return;
    }

    if (request.url?.includes("/v1/preview2d/")) {
      setTimeout(() => {
        respondPgm(response, previewBody);
      }, 10);
      return;
    }
    if (request.url?.includes("/v1/tile2d/")) {
      setTimeout(() => {
        respondBinary(response, tileBody);
      }, 100);
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
    connectedSockets.add(socket);
    socket.on("close", () => {
      connectedSockets.delete(socket);
    });
    socket.on("message", (raw) => {
      const text = raw.toString("utf-8");
      const parsed = JSON.parse(text) as unknown;
      received.push(parsed);
      if (isRecord(parsed) && parsed.message_type === "attach") {
        socket.send(
          JSON.stringify({
            message_type: "session.snapshot",
            session_id: sessionId,
            permission_class: "view",
            is_lease_holder: false,
            snapshot: {
              session: {
                session_id: sessionId,
                session_rev: sessionRev,
              },
              shared_scene: {
                scene_rev: 1,
                sources: {},
                datasets: {},
                layers: {},
                warnings: [],
              },
              client_view: {
                client_id: "cli_open_ui",
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
  const wsAddress = server.address() as AddressInfo;
  const wsUrl = `ws://127.0.0.1:${wsAddress.port.toString()}`;

  return {
    server,
    httpServer,
    url: wsUrl,
    dataBaseUrl,
    received,
    openSourceRequests,
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

function queryCanvas(testId: string): HTMLCanvasElement {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLCanvasElement)) {
    throw new Error(`missing canvas data-testid node ${testId}`);
  }
  return node;
}

function queryInput(testId: string): HTMLInputElement {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLInputElement)) {
    throw new Error(`missing input data-testid node ${testId}`);
  }
  return node;
}

function queryButton(testId: string): HTMLButtonElement {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error(`missing button data-testid node ${testId}`);
  }
  return node;
}

function queryElement(testId: string): HTMLElement {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`missing element data-testid node ${testId}`);
  }
  return node;
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

function broadcastEvent(
  sockets: Set<WebSocket>,
  payload: Record<string, unknown>,
): void {
  const message = JSON.stringify(payload);
  for (const socket of sockets) {
    socket.send(message);
  }
}

function respondPgm(
  response: ServerResponse<IncomingMessage>,
  body: Buffer,
): void {
  response.statusCode = 200;
  response.setHeader("content-type", "image/x-portable-graymap");
  response.setHeader("content-encoding", "identity");
  response.end(body);
}

function respondBinary(
  response: ServerResponse<IncomingMessage>,
  body: Buffer,
): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/octet-stream");
  response.setHeader("content-encoding", "identity");
  response.end(body);
}

function pgmBody(width: number, height: number, values: number[]): Buffer {
  const header = Buffer.from(`P5\n${width.toString()} ${height.toString()}\n255\n`, "ascii");
  return Buffer.concat([header, Buffer.from(values)]);
}

function pgm16Body(width: number, height: number, values: number[]): Buffer {
  const header = Buffer.from(
    `P5\n${width.toString()} ${height.toString()}\n65535\n`,
    "ascii",
  );
  const pixels = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] ?? 0;
    const clamped = Math.max(0, Math.min(65535, value));
    pixels.writeUInt16BE(clamped, i * 2);
  }
  return Buffer.concat([header, pixels]);
}

function channelBlockRawPayload(payload: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.write("LCBK", 0, "ascii");
  header[4] = 1; // format version
  header[5] = 0; // payload kind image
  header[6] = 0; // codec raw
  header[7] = 0; // reserved
  header.writeUInt16LE(1, 8); // channel count
  header.writeUInt16LE(1, 10); // channel block size
  header.writeUInt32LE(payload.length, 12); // encoded length
  header.writeUInt32LE(payload.length, 16); // decoded length
  return Buffer.concat([header, payload]);
}
