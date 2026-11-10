import shaderSource from "./viewLanding.wgsl?raw";
import { requireCompiled } from "./pipelineCompile.ts";

/** One view's frame and the rectangle of the canvas it lands on, `[x, y, width, height]`. */
export interface LandedView {
  frame: GPUTexture;
  rect: readonly [number, number, number, number];
}

/**
 * Puts each view's kept frame on its rectangle of the canvas in one pass. A
 * frame drawn at another scale than the canvas, as a volume view's is while
 * it moves, is filtered to fit.
 */
export class ViewLander {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout;
  private sampler: GPUSampler;
  /** Resolves once the pipeline has compiled. See `pipelineCompile.ts`. */
  readonly compiled: Promise<void>;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.device = device;
    const shader = device.createShaderModule({ code: shaderSource });
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.compiled = device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format: canvasFormat }] },
      primitive: { topology: "triangle-list" },
    }).then((pipeline) => {
      this.pipeline = pipeline;
    });
  }

  /** Clear `canvas` and draw every view's frame on its rectangle. */
  land(canvas: GPUTextureView, views: readonly LandedView[], encoder: GPUCommandEncoder): void {
    const pipeline = requireCompiled(this.pipeline, "ViewLander");
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: canvas, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(pipeline);
    for (const { frame, rect } of views) {
      const [x, y, w, h] = rect;
      if (w <= 0 || h <= 0) continue;
      pass.setViewport(x, y, w, h, 0, 1);
      pass.setScissorRect(x, y, w, h);
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: frame.createView() },
          { binding: 1, resource: this.sampler },
        ],
      }));
      pass.draw(3);
    }
    pass.end();
  }
}
