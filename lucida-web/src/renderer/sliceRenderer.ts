/** WebGPU pipeline for 2D slice rendering with GPU-side u16 normalization. */
import shaderSource from "./slice.wgsl?raw";

// Uniform buffer layout (80 bytes, padded to 96 for alignment):
//   offset 0:   transform      mat4x4f   (64B) — screen UV → texture UV
//   offset 64:  intensityRange vec4f     (16B) — x=min, y=max
const UNIFORM_SIZE = 96;

export class SliceRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;

  private fallbackTexture: GPUTexture | null = null;
  private tileTexture: GPUTexture | null = null;
  private dummyTexture: GPUTexture;

  private intensityMin = 0;
  private intensityMax = 65535;

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat) {
    this.device = device;
    this.context = context;

    const shaderModule = device.createShaderModule({ code: shaderSource });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint", viewDimension: "2d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint", viewDimension: "2d" },
        },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 1x1 dummy texture for unset bindings
    this.dummyTexture = device.createTexture({
      size: [1, 1],
      format: "r16uint",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  setFallback(texture: GPUTexture) {
    this.fallbackTexture = texture;
    this.rebuildBindGroup();
  }

  setTileTexture(texture: GPUTexture) {
    this.tileTexture = texture;
    this.rebuildBindGroup();
  }

  setIntensityRange(min: number, max: number) {
    this.intensityMin = min;
    this.intensityMax = max;
  }

  private rebuildBindGroup() {
    const fallback = this.fallbackTexture ?? this.dummyTexture;
    const tile = this.tileTexture ?? this.dummyTexture;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: fallback.createView() },
        { binding: 2, resource: tile.createView() },
      ],
    });
  }

  render(zoom: number, cx: number, cy: number, canvasW: number, canvasH: number, dataW: number, dataH: number) {
    if (!this.bindGroup) return;

    // Build inverse transform matrix (screen UV → texture UV)
    // Forward: screenX = canvasW/2 - cx*zoom + texU*dataW*zoom
    //          screenU = screenX / canvasW
    // So:      screenU = 0.5 - cx*zoom/canvasW + texU * dataW*zoom/canvasW
    // Inverse: texU = (screenU - 0.5 + cx*zoom/canvasW) / (dataW*zoom/canvasW)
    //        = screenU * canvasW/(dataW*zoom) - 0.5*canvasW/(dataW*zoom) + cx/dataW
    //
    // Same logic for Y axis.

    const sx = canvasW / (dataW * zoom);
    const sy = canvasH / (dataH * zoom);
    const tx = -0.5 * canvasW / (dataW * zoom) + cx / dataW;
    const ty = -0.5 * canvasH / (dataH * zoom) + cy / dataH;

    // mat4x4 in column-major order
    const transform = new Float32Array(16);
    transform[0] = sx;  // col0.x
    transform[5] = sy;  // col1.y
    transform[10] = 1;  // col2.z
    transform[12] = tx; // col3.x
    transform[13] = ty; // col3.y
    transform[15] = 1;  // col3.w

    const uniformData = new Float32Array(UNIFORM_SIZE / 4);
    uniformData.set(transform, 0);
    uniformData.set([this.intensityMin, this.intensityMax, 0, 0], 16);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }
}
