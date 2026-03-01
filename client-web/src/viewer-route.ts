import type { AttachMode } from "./connection-bootstrap";

export type ViewerRouteKind = "viewer" | "jupyter-viewer" | "viewer-demo";

export type ViewerRoute = {
  kind: "viewer" | "jupyter-viewer";
  sessionId: string;
  clientLabel: string;
  mode: AttachMode;
  token: string | undefined;
  wsBase: string;
  dataBase: string;
};

export type DemoViewerRoute = {
  kind: "viewer-demo";
  demoId: string;
};

export type RouteResolution =
  | {
      ok: true;
      route: ViewerRoute | DemoViewerRoute;
    }
  | {
      ok: false;
      message: string;
    };

const VALID_ATTACH_MODES: readonly AttachMode[] = [
  "open_view",
  "token_view",
  "control",
] as const;

export function resolveRoute(location: Location): RouteResolution {
  const path = normalizePath(location.pathname);
  if (path !== "/viewer" && path !== "/jupyter/viewer" && path !== "/viewer/demo") {
    return {
      ok: false,
      message:
        "Unknown route. Use /viewer?session=<session_id>, /jupyter/viewer?session=<session_id>, or /viewer for demo mode.",
    };
  }

  const params = new URLSearchParams(location.search);
  if (path === "/viewer/demo") {
    return {
      ok: true,
      route: {
        kind: "viewer-demo",
        demoId: parseDemoId(params),
      },
    };
  }

  const sessionId = params.get("session");
  if ((sessionId === null || sessionId.trim().length === 0) && path === "/viewer") {
    return {
      ok: true,
      route: {
        kind: "viewer-demo",
        demoId: parseDemoId(params),
      },
    };
  }
  if (sessionId === null || sessionId.trim().length === 0) {
    return {
      ok: false,
      message: "Missing required query param `session`.",
    };
  }

  const clientLabel = params.get("client")?.trim() || "browser-client";
  const modeParam = params.get("mode");
  const mode = parseAttachMode(modeParam);
  if (mode === null) {
    return {
      ok: false,
      message: "Invalid `mode`; expected open_view, token_view, or control.",
    };
  }

  const tokenValue = params.get("token");
  const token =
    tokenValue === null || tokenValue.trim().length === 0
      ? undefined
      : tokenValue;

  const wsBaseParam = params.get("wsBase");
  const wsBase =
    wsBaseParam === null || wsBaseParam.trim().length === 0
      ? defaultWsBase(location)
      : wsBaseParam.trim();
  const dataBaseParam = params.get("dataBase");
  const dataBase =
    dataBaseParam === null || dataBaseParam.trim().length === 0
      ? defaultDataBase(location)
      : dataBaseParam.trim();

  return {
    ok: true,
    route: {
      kind: path === "/viewer" ? "viewer" : "jupyter-viewer",
      sessionId: sessionId.trim(),
      clientLabel,
      mode,
      token,
      wsBase,
      dataBase,
    },
  };
}

function defaultWsBase(location: Location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}

function defaultDataBase(location: Location): string {
  const protocol = location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${location.host}`;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return "/";
  }
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

function parseAttachMode(value: string | null): AttachMode | null {
  if (value === null || value.length === 0) {
    return "open_view";
  }
  if (VALID_ATTACH_MODES.includes(value as AttachMode)) {
    return value as AttachMode;
  }
  return null;
}

function parseDemoId(params: URLSearchParams): string {
  const demoId = params.get("demo");
  if (demoId === null || demoId.trim().length === 0) {
    return "default";
  }
  return demoId.trim();
}
