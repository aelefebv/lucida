/** WebGPU pipeline for 2D slice rendering with GPU-side u16 normalization. */
import shaderSource from "./slice.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";

// Uniform buffer layout (128 bytes):
//   offset 0:   transform      mat4x4f   (64B) — screen UV → texture UV
//   offset 64:  intensityRange vec4f     (16B) — x=min, y=max, z=gamma, w=opacity
//   offset 80:  chunkDims      vec4u     (16B) — x=chunkX, y=chunkY, z=levelWidth, w=levelHeight
//   offset 96:  gridDims       vec4u     (16B) — x=gridX, y=gridY
//   offset 112: atlasSlotDims  vec4u     (16B) — x=slotsX, y=slotsY
const UNIFORM_SIZE = 144;

export class SliceRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;

  private fallbackTexture: GPUTexture | null = null;
  private atlasTexture: GPUTexture | null = null;
  private indirectionBuffer: GPUBuffer | null = null;
  private dummyTexture: GPUTexture;
  private dummyIndirectionBuffer: GPUBuffer;

  private intensityMin = 0;
  private intensityMax = 65535;
  private gamma = 1.0;
  private opacity = 1.0;
  private chunkDims = [1, 1];
  private gridDims = [1, 1];
  private atlasSlotDims = [1, 1];
  private levelDims = [1, 1];

  constructor(device: GPUDevice) {
    this.device = device;

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
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
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
        targets: [{ format: OFFSCREEN_FORMAT }],
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

    // Dummy indirection buffer (single sentinel entry)
    const dummyData = new Uint32Array([0xFFFFFFFF]);
    this.dummyIndirectionBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.dummyIndirectionBuffer, 0, dummyData);
  }

  setFallback(texture: GPUTexture) {
    this.fallbackTexture = texture;
    this.rebuildBindGroup();
  }

  setAtlas(
    texture: GPUTexture,
    indirectionBuf: GPUBuffer,
    chunkDims: [number, number],
    gridDims: [number, number],
    atlasSlotDims: [number, number],
    levelDims: [number, number],
  ) {
    this.atlasTexture = texture;
    this.indirectionBuffer = indirectionBuf;
    this.chunkDims = chunkDims;
    this.gridDims = gridDims;
    this.atlasSlotDims = atlasSlotDims;
    this.levelDims = levelDims;
    this.rebuildBindGroup();
  }

  setIntensityRange(min: number, max: number) {
    this.intensityMin = min;
    this.intensityMax = max;
  }

  setDisplayParams(min: number, max: number, gamma: number) {
    this.intensityMin = min;
    this.intensityMax = max;
    this.gamma = gamma;
  }

  setOpacity(v: number) {
    this.opacity = v;
  }

  private rebuildBindGroup() {
    const fallback = this.fallbackTexture ?? this.dummyTexture;
    const atlas = this.atlasTexture ?? this.dummyTexture;
    const indirection = this.indirectionBuffer ?? this.dummyIndirectionBuffer;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: fallback.createView() },
        { binding: 2, resource: atlas.createView() },
        { binding: 3, resource: { buffer: indirection } },
      ],
    });
  }

  setTransform(zoom: number, cx: number, cy: number, canvasW: number, canvasH: number, dataW: number, dataH: number) {
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
    uniformData.set([this.intensityMin, this.intensityMax, this.gamma, this.opacity], 16);

    // Atlas params (u32 written via Uint32Array view)
    const u32View = new Uint32Array(uniformData.buffer);
    u32View.set([this.chunkDims[0], this.chunkDims[1], this.levelDims[0], this.levelDims[1]], 20); // chunkDims at 80B = 20 u32s
    u32View.set([this.gridDims[0], this.gridDims[1], 0, 0], 24);      // gridDims at 96B = 24 u32s
    u32View.set([this.atlasSlotDims[0], this.atlasSlotDims[1], 0, 0], 28); // atlasSlotDims at 112B = 28 u32s

    // Member screen-pixel size for border detection
    const memberScreenW = dataW * zoom;
    const memberScreenH = dataH * zoom;
    uniformData.set([memberScreenW, memberScreenH, 0, 0], 32); // memberScreenSize at 128B = 32 f32s

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  renderTo(target: GPUTextureView, encoder: GPUCommandEncoder) {
    if (!this.bindGroup) return;

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
  }
}
