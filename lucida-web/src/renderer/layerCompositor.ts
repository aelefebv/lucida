/** Composites offscreen layer textures onto the canvas with per-layer blend modes. */
import shaderSource from "./compositor.wgsl?raw";

export type BlendMode = "alpha" | "additive" | "max";

export interface CompositeLayer {
  view: GPUTextureView;
  blendMode: BlendMode;
}

const BG = { r: 0.05, g: 0.05, b: 0.08, a: 1 };

export class LayerCompositor {
  private device: GPUDevice;
  private pipelines: Record<BlendMode, GPURenderPipeline>;
  private bindGroupLayout: GPUBindGroupLayout;

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

    const makePipeline = (blend: GPUBlendState) => device.createRenderPipeline({
      layout,
      vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [makeTarget(blend)] },
      primitive: { topology: "triangle-list" },
    });

    this.pipelines = {
      alpha: makePipeline(alphaBlend),
      additive: makePipeline(additiveBlend),
      max: makePipeline(maxBlend),
    };
  }

  composite(canvasView: GPUTextureView, layers: CompositeLayer[], encoder: GPUCommandEncoder): void {
    if (layers.length === 0) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: canvasView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: BG,
        }],
      });
      pass.end();
      return;
    }

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: canvasView,
          loadOp: i === 0 ? "clear" : "load",
          storeOp: "store",
          ...(i === 0 ? { clearValue: BG } : {}),
        }],
      });

      const bg = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [{ binding: 0, resource: layer.view }],
      });

      pass.setPipeline(this.pipelines[layer.blendMode]);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }
  }
}
