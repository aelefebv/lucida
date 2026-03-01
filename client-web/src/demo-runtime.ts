import type { ClientState } from "./client-store";
import { deriveCapabilities } from "./connection-bootstrap";
import { buildMinimapState } from "./minimap";
import type { RenderFrameState } from "./live-render-loop";
import type { ViewerRuntimeState } from "./viewer-runtime";

const DEMO_WIDTH = 384;
const DEMO_HEIGHT = 256;

type DemoViewportState = {
  centerX: number;
  centerY: number;
  zoom: number;
  zIndex: number;
  tIndex: number;
  selectedChannels: number[];
};

export class DemoViewerRuntime {
  private readonly onUpdate: (state: ViewerRuntimeState) => void;
  private readonly demoId: string;
  private readonly demoClientId: string;
  private stateValue: ViewerRuntimeState;
  private viewport: DemoViewportState;
  private refinementTimer: ReturnType<typeof setTimeout> | null;
  private disposed: boolean;
  private viewRev: number;

  public constructor(
    demoId: string,
    onUpdate: (state: ViewerRuntimeState) => void,
  ) {
    this.onUpdate = onUpdate;
    this.demoId = demoId;
    this.demoClientId = `demo-client-${normalizeId(demoId)}`;
    this.viewport = {
      centerX: 0,
      centerY: 0,
      zoom: 1,
      zIndex: 0,
      tIndex: 0,
      selectedChannels: [0],
    };
    this.viewRev = 1;
    this.refinementTimer = null;
    this.disposed = false;

    this.stateValue = {
      routeKind: "viewer-demo",
      connection: {
        phase: "attached",
        mode: "open_view",
        tokenPresent: false,
        capabilities: deriveCapabilities("view", false),
        message: null,
      },
      connectionSummary: "View only (demo)",
      snapshot: null,
      clientState: this.buildClientState(),
      renderFrame: null,
    };
  }

  public start(): void {
    this.publish("preview");
    this.refinementTimer = setTimeout(() => {
      if (!this.disposed) {
        this.publish("tile");
      }
    }, 120);
  }

  public pan(dx: number, dy: number): void {
    this.viewport.centerX += dx;
    this.viewport.centerY += dy;
    this.bumpAndPublish();
  }

  public zoom(scale: number, _anchorX: number, _anchorY: number): void {
    this.viewport.zoom = clamp(this.viewport.zoom * scale, 0.2, 8);
    this.bumpAndPublish();
  }

  public setZ(zIndex: number): void {
    this.viewport.zIndex = Math.max(0, Math.floor(zIndex));
    this.bumpAndPublish();
  }

  public setT(tIndex: number): void {
    this.viewport.tIndex = Math.max(0, Math.floor(tIndex));
    this.bumpAndPublish();
  }

  public setChannels(channels: number[]): void {
    const normalized = channels
      .map((channel) => Math.max(0, Math.floor(channel)))
      .slice(0, 3);
    this.viewport.selectedChannels = normalized.length > 0 ? normalized : [0];
    this.bumpAndPublish();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.refinementTimer !== null) {
      clearTimeout(this.refinementTimer);
      this.refinementTimer = null;
    }
  }

  public state(): ViewerRuntimeState {
    return this.stateValue;
  }

  private bumpAndPublish(): void {
    this.viewRev += 1;
    this.publish("tile");
  }

  private publish(frameKind: "preview" | "tile"): void {
    if (this.disposed) {
      return;
    }

    const clientState = this.buildClientState();
    const renderFrame = this.buildFrame(frameKind);
    this.stateValue = {
      ...this.stateValue,
      clientState,
      renderFrame,
    };
    this.onUpdate(this.stateValue);
  }

  private buildClientState(): ClientState {
    return {
      sessionId: `demo-session-${normalizeId(this.demoId)}`,
      sessionRev: 1,
      sceneRev: 1,
      clientId: this.demoClientId,
      viewRev: this.viewRev,
      activeLayerId: "demo-layer",
      centerX: this.viewport.centerX,
      centerY: this.viewport.centerY,
      zoom: this.viewport.zoom,
      zIndex: this.viewport.zIndex,
      tIndex: this.viewport.tIndex,
      selectedChannels: [...this.viewport.selectedChannels],
      sources: {
        "demo-source": {
          sourceId: "demo-source",
          name: `demo:${this.demoId}`,
          status: "ready",
          latestWorkingGenerationSeq: 1,
        },
      },
      datasets: {
        "demo-dataset": {
          datasetId: "demo-dataset",
          sourceId: "demo-source",
          resolvedGenerationSeq: 1,
        },
      },
      layers: {
        "demo-layer": {
          layerId: "demo-layer",
          name: "procedural",
          layerRev: 1,
          metadataRev: 1,
          writeRev: 1,
        },
      },
      generations: {},
      warnings: [],
      reconnectCount: 0,
    };
  }

  private buildFrame(frameKind: "preview" | "tile"): RenderFrameState {
    const rgba = new Uint8ClampedArray(DEMO_WIDTH * DEMO_HEIGHT * 4);
    const previewStride = frameKind === "preview" ? 3 : 1;

    for (let y = 0; y < DEMO_HEIGHT; y += 1) {
      for (let x = 0; x < DEMO_WIDTH; x += 1) {
        const sampleX = frameKind === "preview" ? x - (x % previewStride) : x;
        const sampleY = frameKind === "preview" ? y - (y % previewStride) : y;
        const worldX =
          (sampleX - DEMO_WIDTH / 2) / this.viewport.zoom + this.viewport.centerX;
        const worldY =
          (sampleY - DEMO_HEIGHT / 2) / this.viewport.zoom + this.viewport.centerY;

        const wave =
          (Math.sin(worldX * 0.06) + Math.cos(worldY * 0.05) + 2) * 0.25;
        const checker =
          (Math.floor(worldX / 24) +
            Math.floor(worldY / 24) +
            this.viewport.zIndex +
            this.viewport.tIndex) %
            2 ===
          0
            ? 0.2
            : -0.2;

        const base = clamp255(Math.round((wave + checker) * 255));
        const red = clamp255(base + (this.viewport.selectedChannels.includes(0) ? 32 : 0));
        const green = clamp255(base + (this.viewport.selectedChannels.includes(1) ? 36 : 0));
        const blue = clamp255(base + (this.viewport.selectedChannels.includes(2) ? 40 : 0));

        const offset = (y * DEMO_WIDTH + x) * 4;
        rgba[offset] = red;
        rgba[offset + 1] = green;
        rgba[offset + 2] = blue;
        rgba[offset + 3] = 255;
      }
    }

    drawCrosshair(rgba, DEMO_WIDTH, DEMO_HEIGHT);

    return {
      generationSeq: 1,
      frameKind,
      width: DEMO_WIDTH,
      height: DEMO_HEIGHT,
      rgba,
      minimap: buildMinimapState(
        [
          {
            layerId: "demo-layer",
            name: "procedural",
            sourceId: "demo-source",
          },
        ],
        null,
        "demo-layer",
        DEMO_WIDTH,
        DEMO_HEIGHT,
        {
          centerX: DEMO_WIDTH / 2 + this.viewport.centerX,
          centerY: DEMO_HEIGHT / 2 + this.viewport.centerY,
          zoom: this.viewport.zoom,
        },
        this.viewport.zIndex,
        8,
      ),
      warningNotice:
        frameKind === "preview" ? "Demo frame loaded. Refining detail." : null,
    };
  }
}

function drawCrosshair(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);

  for (let x = 0; x < width; x += 1) {
    const offset = (midY * width + x) * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = 255;
    rgba[offset + 2] = 255;
    rgba[offset + 3] = 255;
  }

  for (let y = 0; y < height; y += 1) {
    const offset = (y * width + midX) * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = 255;
    rgba[offset + 2] = 255;
    rgba[offset + 3] = 255;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function normalizeId(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}
