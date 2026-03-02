// @vitest-environment jsdom

import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import type { ViewerRoute } from "../src/viewer-route";
import { ViewerRuntime } from "../src/viewer-runtime";

type InteractiveFixture = {
  url: string;
  close: () => Promise<void>;
  closeClient: (clientId: string) => void;
};

type InteractiveFixtureOptions = {
  rejectFirstSetTCommand?: boolean;
};

const fixtures: InteractiveFixture[] = [];
const runtimes: ViewerRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose();
  }
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

describe("viewer runtime interaction + reconnect", () => {
  it("keeps interactions scoped to the initiating client", async () => {
    const fixture = await startInteractiveFixture();
    fixtures.push(fixture);

    const routeA: ViewerRoute = {
      kind: "viewer",
      sessionId: "sess_runtime",
      clientLabel: "client-a",
      mode: "open_view",
      token: undefined,
      wsBase: fixture.url,
      dataBase: "http://127.0.0.1:9",
    };
    const routeB: ViewerRoute = {
      kind: "viewer",
      sessionId: "sess_runtime",
      clientLabel: "client-b",
      mode: "open_view",
      token: undefined,
      wsBase: fixture.url,
      dataBase: "http://127.0.0.1:9",
    };

    const runtimeA = new ViewerRuntime(routeA, () => {});
    const runtimeB = new ViewerRuntime(routeB, () => {});
    runtimes.push(runtimeA, runtimeB);
    runtimeA.start();
    runtimeB.start();

    await waitFor(() => runtimeA.state().connection.phase === "attached", 2000);
    await waitFor(() => runtimeB.state().connection.phase === "attached", 2000);

    runtimeA.pan(25, -10);
    runtimeA.setChannels([1, 2]);

    await waitFor(() => {
      return runtimeA.state().clientState?.centerX === 25;
    }, 2000);

    expect(runtimeA.state().clientState?.centerX).toBe(25);
    expect(runtimeA.state().clientState?.centerY).toBe(-10);
    expect(runtimeA.state().clientState?.selectedChannels).toEqual([1, 2]);

    expect(runtimeB.state().clientState?.centerX).toBe(0);
    expect(runtimeB.state().clientState?.centerY).toBe(0);
    expect(runtimeB.state().clientState?.selectedChannels).toEqual([0]);
  });

  it("reconnects and rehydrates authoritative state after transport drop", async () => {
    const fixture = await startInteractiveFixture();
    fixtures.push(fixture);

    const route: ViewerRoute = {
      kind: "viewer",
      sessionId: "sess_runtime",
      clientLabel: "client-reconnect",
      mode: "open_view",
      token: undefined,
      wsBase: fixture.url,
      dataBase: "http://127.0.0.1:9",
    };
    const runtime = new ViewerRuntime(route, () => {});
    runtimes.push(runtime);
    runtime.start();

    await waitFor(() => runtime.state().connection.phase === "attached", 2000);

    runtime.setZ(5);
    runtime.setT(7);
    await waitFor(() => runtime.state().clientState?.zIndex === 5, 2000);
    await waitFor(() => runtime.state().clientState?.tIndex === 7, 2000);

    const firstClientId = runtime.state().clientState?.clientId;
    expect(firstClientId).toBeDefined();
    fixture.closeClient(firstClientId as string);

    await waitFor(() => {
      return (runtime.state().clientState?.reconnectCount ?? 0) > 0;
    }, 4000);
    const reconnectedClientId = runtime.state().clientState?.clientId;
    expect(reconnectedClientId).toBeDefined();
    expect(reconnectedClientId).not.toBe(firstClientId);

    expect(runtime.state().clientState?.zIndex).toBe(5);
    expect(runtime.state().clientState?.tIndex).toBe(7);
  });

  it("keeps attach phase stable when a command returns an error envelope", async () => {
    const fixture = await startInteractiveFixture({
      rejectFirstSetTCommand: true,
    });
    fixtures.push(fixture);

    const route: ViewerRoute = {
      kind: "viewer",
      sessionId: "sess_runtime",
      clientLabel: "client-command-error",
      mode: "open_view",
      token: undefined,
      wsBase: fixture.url,
      dataBase: "http://127.0.0.1:9",
    };
    const runtime = new ViewerRuntime(route, () => {});
    runtimes.push(runtime);
    runtime.start();

    await waitFor(() => runtime.state().connection.phase === "attached", 2000);

    runtime.setT(3);
    await waitFor(() => runtime.state().clientState?.tIndex === 0, 2000);
    expect(runtime.state().connection.phase).toBe("attached");

    runtime.setZ(4);
    await waitFor(() => runtime.state().clientState?.zIndex === 4, 2000);
    expect(runtime.state().connection.phase).toBe("attached");
  });
});

async function startInteractiveFixture(
  options: InteractiveFixtureOptions = {},
): Promise<InteractiveFixture> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sessionId = "sess_runtime";
  let sessionRev = 1;
  let nextClientCounter = 1;
  let setTCommandRejectsRemaining = options.rejectFirstSetTCommand ? 1 : 0;
  const viewByClientId = new Map<string, ClientViewState>();
  const socketByClientId = new Map<string, WebSocket>();
  const clientIdBySocket = new Map<WebSocket, string>();

  server.on("connection", (socket) => {
    socket.on("close", () => {
      const currentClientId = clientIdBySocket.get(socket);
      if (currentClientId !== undefined) {
        clientIdBySocket.delete(socket);
        socketByClientId.delete(currentClientId);
      }
    });

    socket.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
      const messageType = parsed.message_type;

      if (messageType === "attach") {
        const clientId = `cli_${nextClientCounter.toString()}`;
        nextClientCounter += 1;
        const viewState = defaultViewState(clientId);
        viewByClientId.set(clientId, viewState);
        clientIdBySocket.set(socket, clientId);
        socketByClientId.set(clientId, socket);
        socket.send(
          JSON.stringify(
            snapshotEnvelope(sessionId, sessionRev, "view", false, viewState),
          ),
        );
        return;
      }

      if (messageType === "reconnect") {
        const previous = parsed.previous_client_id;
        const previousClientId =
          typeof previous === "string" ? previous : undefined;
        const restored =
          previousClientId === undefined
            ? undefined
            : viewByClientId.get(previousClientId);
        if (previousClientId !== undefined) {
          viewByClientId.delete(previousClientId);
          socketByClientId.delete(previousClientId);
        }

        const clientId = `cli_${nextClientCounter.toString()}`;
        nextClientCounter += 1;
        const viewState = {
          ...(restored ?? defaultViewState(clientId)),
          client_id: clientId,
        };
        viewByClientId.set(clientId, viewState);
        clientIdBySocket.set(socket, clientId);
        socketByClientId.set(clientId, socket);
        sessionRev += 1;
        socket.send(
          JSON.stringify(
            snapshotEnvelope(sessionId, sessionRev, "view", false, viewState),
          ),
        );
        return;
      }

      if (messageType !== "command") {
        return;
      }

      const commandClientId = parsed.client_id;
      if (typeof commandClientId !== "string") {
        return;
      }
      const view = viewByClientId.get(commandClientId);
      if (view === undefined) {
        return;
      }

      if (parsed.op === "view.set_t" && setTCommandRejectsRemaining > 0) {
        setTCommandRejectsRemaining -= 1;
        socket.send(
          JSON.stringify({
            message_type: "error",
            schema_version: "lucida-proto-0.1",
            session_id: sessionId,
            request_id: String(parsed.request_id ?? "req"),
            client_id: commandClientId,
            client_seq: Number(parsed.client_seq ?? 1),
            op: "view.set_t",
            code: "source_unavailable",
            message: "source has no working generation yet",
            retryable: false,
            details: {
              detail_type: "source_unavailable",
              detail: {
                source_uri: "/tmp/pending",
              },
            },
            sent_at: new Date().toISOString(),
          }),
        );
        return;
      }

      applyViewCommand(view, parsed);
      sessionRev += 1;
      view.view_rev += 1;

      const ackTarget = socketByClientId.get(commandClientId);
      if (ackTarget !== undefined) {
        ackTarget.send(
          JSON.stringify({
            message_type: "command_ack",
            schema_version: "lucida-proto-0.1",
            session_id: sessionId,
            request_id: parsed.request_id ?? "req",
            client_id: commandClientId,
            client_seq: parsed.client_seq ?? 1,
            accepted: true,
            resulting_session_rev: sessionRev,
            resulting_view_rev: view.view_rev,
          }),
        );
      }

      const event = {
        message_type: "event",
        schema_version: "lucida-proto-0.1",
        session_id: sessionId,
        session_rev: sessionRev,
        event_type: "view_updated",
        payload: {
          client_id: commandClientId,
          view_rev: view.view_rev,
          active_layer_id: view.active_layer_id,
          center_x: view.center_x,
          center_y: view.center_y,
          zoom: view.zoom,
          z_index: view.z_index,
          t_index: view.t_index,
          selected_channels: view.selected_channels,
        },
      };
      for (const peer of socketByClientId.values()) {
        peer.send(JSON.stringify(event));
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.on("listening", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port.toString()}`;

  return {
    url,
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
    closeClient: (clientId: string) => {
      const socket = socketByClientId.get(clientId);
      if (socket !== undefined) {
        socket.close();
      }
    },
  };
}

type ClientViewState = {
  client_id: string;
  view_rev: number;
  active_layer_id: string | null;
  center_x: number;
  center_y: number;
  zoom: number;
  z_index: number;
  t_index: number;
  selected_channels: number[];
};

function defaultViewState(clientId: string): ClientViewState {
  return {
    client_id: clientId,
    view_rev: 1,
    active_layer_id: null,
    center_x: 0,
    center_y: 0,
    zoom: 1,
    z_index: 0,
    t_index: 0,
    selected_channels: [0],
  };
}

function applyViewCommand(
  view: ClientViewState,
  command: Record<string, unknown>,
): void {
  const op = command.op;
  if (typeof op !== "string") {
    return;
  }
  const args = command.args;
  if (!isRecord(args)) {
    return;
  }

  if (op === "view.pan") {
    const dx = Number(args.dx ?? 0);
    const dy = Number(args.dy ?? 0);
    view.center_x += dx;
    view.center_y += dy;
    return;
  }
  if (op === "view.zoom") {
    view.zoom = Number(args.zoom ?? view.zoom);
    return;
  }
  if (op === "view.set_z") {
    view.z_index = Number(args.z_index ?? view.z_index);
    return;
  }
  if (op === "view.set_t") {
    view.t_index = Number(args.t_index ?? view.t_index);
    return;
  }
  if (op === "view.set_channels") {
    const channels = args.channels;
    if (Array.isArray(channels)) {
      view.selected_channels = channels.map((value) => Number(value));
    }
  }
}

function snapshotEnvelope(
  sessionId: string,
  sessionRev: number,
  permissionClass: "view" | "control" | "admin",
  isLeaseHolder: boolean,
  viewState: ClientViewState,
): Record<string, unknown> {
  return {
    message_type: "session.snapshot",
    session_id: sessionId,
    permission_class: permissionClass,
    is_lease_holder: isLeaseHolder,
    snapshot: {
      session: {
        session_id: sessionId,
        session_rev: sessionRev,
      },
      shared_scene: {
        scene_rev: 0,
        sources: {},
        datasets: {},
        layers: {},
        warnings: [],
      },
      client_view: {
        ...viewState,
        warnings: [],
      },
      warnings: [],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
