/** Composites offscreen layer textures onto the canvas with per-layer blend modes. */
import shaderSource from "./compositor.wgsl?raw";
import type { PassTiming } from "./passTiming.ts";
import { requireCompiled } from "./pipelineCompile.ts";
import type { RgbaColor } from "./workerProtocol.ts";

export type BlendMode = "alpha" | "additive" | "max";

/**
 * Each mode's blend of premultiplied color: how a layer lands on the canvas,
 * and how draws sharing a layer's target combine, so they combine as
 * separate layers of that mode would.
 */
export const LAYER_BLENDS: Readonly<Record<BlendMode, GPUBlendState>> = {
  alpha: {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  },
  additive: {
    color: { srcFactor: "one", dstFactor: "one", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
  },
  max: {
    color: { srcFactor: "one", dstFactor: "one", operation: "max" },
    alpha: { srcFactor: "one", dstFactor: "one", operation: "max" },
  },
};

export interface CompositeLayer {
  view: GPUTextureView;
  blendMode: BlendMode;
  /** The canvas pixels the layer may cover, `[x, y, width, height]`; the whole canvas when absent. */
  clip?: readonly [number, number, number, number];
}

const TRANSPARENT: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

/**
 * A frame is `composite` (once, or once per layer with only the first
 * clearing) and then `underlayBackground`. Layers blend with each other over
 * a transparent canvas and the background goes beneath the finished stack, so
 * an additive layer adds to the layers under it and never to the background:
 * on a white background it would otherwise wash out to white.
 */
export class LayerCompositor {
  private device: GPUDevice;
  private pipelines: Record<BlendMode, GPURenderPipeline> | null = null;
  private backgroundPipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout;
  private backgroundBuffer: GPUBuffer;
  private backgroundBindGroup: GPUBindGroup;
  /** Resolves once every pipeline has compiled. See `pipelineCompile.ts`. */
  readonly compiled: Promise<void>;

  get isCompiled(): boolean {
    return this.pipelines !== null && this.backgroundPipeline !== null;
  }

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.device = device;
    const shader = device.createShaderModule({ code: shaderSource });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" },
      }],
    });

    const layout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    const makeTarget = (blend: GPUBlendState): GPUColorTargetState => ({
      format: canvasFormat,
      blend,
    });

    const { alpha: alphaBlend, additive: additiveBlend, max: maxBlend } = LAYER_BLENDS;
    // Destination-over: the background shows only where the layers left the
    // canvas uncovered.
    const underBlend: GPUBlendState = {
      color: { srcFactor: "one-minus-dst-alpha", dstFactor: "one", operation: "add" },
      alpha: { srcFactor: "one-minus-dst-alpha", dstFactor: "one", operation: "add" },
    };

    const makePipeline = (blend: GPUBlendState) => device.createRenderPipelineAsync({
      layout,
      vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [makeTarget(blend)] },
      primitive: { topology: "triangle-list" },
    });

    const backgroundLayout = device.createBindGroupLayout({
      entries: [{ binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    });
    this.backgroundBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.backgroundBindGroup = device.createBindGroup({
      layout: backgroundLayout,
      entries: [{ binding: 1, resource: { buffer: this.backgroundBuffer } }],
    });
    // Opaque black until the page sends the canvas background.
    this.setBackground([0, 0, 0, 1]);

    this.compiled = Promise.all([
      makePipeline(alphaBlend),
      makePipeline(additiveBlend),
      makePipeline(maxBlend),
      device.createRenderPipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [backgroundLayout] }),
        vertex: { module: shader, entryPoint: "vs" },
        fragment: { module: shader, entryPoint: "fsBackground", targets: [makeTarget(underBlend)] },
        primitive: { topology: "triangle-list" },
      }),
    ]).then(([alpha, additive, max, background]) => {
      this.pipelines = { alpha, additive, max };
      this.backgroundPipeline = background;
    });
  }

  /** The canvas background, from the next frame on. */
  setBackground([r, g, b, a]: RgbaColor): void {
    this.device.queue.writeBuffer(this.backgroundBuffer, 0, new Float32Array([r * a, g * a, b * a, a]));
  }

  /**
   * Blend `layers` onto the canvas in order. `clearFirst` starts the frame
   * from transparent. `timing` stamps each pass for the trace's GPU pass
   * time; viewport frames pass it, the minimap does not.
   */
  composite(canvasView: GPUTextureView, layers: CompositeLayer[], encoder: GPUCommandEncoder, clearFirst: boolean = true, timing?: PassTiming): void {
    if (layers.length === 0) {
      if (clearFirst) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: canvasView,
            loadOp: "clear",
            storeOp: "store",
            clearValue: TRANSPARENT,
          }],
          timestampWrites: timing?.nextPass(),
        });
        pass.end();
      }
      return;
    }

    const pipelines = requireCompiled(this.pipelines, "layer compositor");
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: canvasView,
          loadOp: (clearFirst && i === 0) ? "clear" : "load",
          storeOp: "store",
          ...((clearFirst && i === 0) ? { clearValue: TRANSPARENT } : {}),
        }],
        timestampWrites: timing?.nextPass(),
      });

      const bg = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [{ binding: 0, resource: layer.view }],
      });

      pass.setPipeline(pipelines[layer.blendMode]);
      pass.setBindGroup(0, bg);
      if (layer.clip) pass.setScissorRect(layer.clip[0], layer.clip[1], layer.clip[2], layer.clip[3]);
      pass.draw(3);
      pass.end();
    }
  }

  /** Draw the background beneath everything composited this frame. Call once, after the last layer. */
  underlayBackground(canvasView: GPUTextureView, encoder: GPUCommandEncoder, timing?: PassTiming): void {
    const pipeline = requireCompiled(this.backgroundPipeline, "layer compositor");
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: canvasView, loadOp: "load", storeOp: "store" }],
      timestampWrites: timing?.nextPass(),
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.backgroundBindGroup);
    pass.draw(3);
    pass.end();
  }
}
