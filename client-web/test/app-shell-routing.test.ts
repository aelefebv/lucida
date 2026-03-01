// @vitest-environment jsdom

import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { bootstrapApp, type AppController } from "../src/app-shell";

type SocketFixture = {
  server: WebSocketServer;
  url: string;
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

  it("shows route guidance for unsupported paths", () => {
    mountApp("/unknown");
    const controller = bootstrapApp(document, window.location);
    controllers.push(controller);

    const errorText = queryText("route-error");
    expect(errorText).toContain("Unknown route");
    expect(errorText).toContain("/viewer");
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
    url,
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
