/** Composites offscreen layer textures onto the canvas with per-layer blend modes. */
import shaderSource from "./compositor.wgsl?raw";
import type { PassTiming } from "./passTiming.ts";
import { requireCompiled } from "./pipelineCompile.ts";

export type BlendMode = "alpha" | "additive" | "max";

export interface CompositeLayer {
  view: GPUTextureView;
  blendMode: BlendMode;
}

const BG = { r: 0.05, g: 0.05, b: 0.08, a: 1 };

export class LayerCompositor {
  private device: GPUDevice;
  private pipelines: Record<BlendMode, GPURenderPipeline> | null = null;
  private bindGroupLayout: GPUBindGroupLayout;
  /** Resolves once the three blend pipelines have compiled. See `pipelineCompile.ts`. */
  readonly compiled: Promise<void>;

  get isCompiled(): boolean {
    return this.pipelines !== null;
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

    const alphaBlend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const additiveBlend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
    };
    const maxBlend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one", operation: "max" },
      alpha: { srcFactor: "one", dstFactor: "one", operation: "max" },
    };

    const makePipeline = (blend: GPUBlendState) => device.createRenderPipelineAsync({
      layout,
      vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [makeTarget(blend)] },
      primitive: { topology: "triangle-list" },
    });

    this.compiled = Promise.all([
      makePipeline(alphaBlend),
      makePipeline(additiveBlend),
      makePipeline(maxBlend),
    ]).then(([alpha, additive, max]) => {
      this.pipelines = { alpha, additive, max };
    });
  }

  /** `timing` stamps each pass for the trace's GPU pass time; viewport frames pass it, the minimap does not. */
  composite(canvasView: GPUTextureView, layers: CompositeLayer[], encoder: GPUCommandEncoder, clearFirst: boolean = true, timing?: PassTiming): void {
    if (layers.length === 0) {
      if (clearFirst) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: canvasView,
            loadOp: "clear",
            storeOp: "store",
            clearValue: BG,
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
          ...((clearFirst && i === 0) ? { clearValue: BG } : {}),
        }],
        timestampWrites: timing?.nextPass(),
      });

      const bg = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [{ binding: 0, resource: layer.view }],
      });

      pass.setPipeline(pipelines[layer.blendMode]);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }
  }
}
