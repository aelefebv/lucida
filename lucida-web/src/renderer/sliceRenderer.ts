/** WebGPU pipeline for 2D slice rendering with GPU-side u16 normalization. */
import shaderSource from "./slice.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";
import type { LodIndirectionMeta } from "./volumeHandlers.ts";

// Uniform buffer layout (400 bytes):
//   offset 0:   transform      mat4x4f   (64B) — screen UV → texture UV
//   offset 64:  intensityRange vec4f     (16B) — x=min, y=max, z=gamma, w=opacity
//   offset 80:  chunkDims      vec4u     (16B) — x=chunkX, y=chunkY, z=levelWidth, w=levelHeight
//   offset 96:  gridDims       vec4u     (16B) — x=gridX, y=gridY
//   offset 112: atlasSlotDims  vec4u     (16B) — x=slotsX, y=slotsY
//   offset 128: memberScreenSize vec4f  (16B) — xy=member pixel size
//   offset 144: lodParams      vec4u     (16B) — x=numLods, y=targetLodIdx
//   offset 160: lodGridDims    vec4u[4]  (64B) — xy=gridDims, w=offset
//   offset 224: lodChunkDims   vec4u[4]  (64B) — xy=chunkDims
//   offset 288: lodLevelDims   vec4f[4]  (64B) — xy=levelDims
//   offset 352: proxyParams    vec4u     (16B) — x=renderMode, y=fieldSlot, z=wellSlot
//   offset 368: fieldProxyDims vec4u     (16B) — xyz=(Z,Y,X)
//   offset 384: wellProxyDims  vec4u     (16B) — xyz=(Z,Y,X)
const UNIFORM_SIZE = 400;

export class SliceRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;

  private atlasTexture: GPUTexture | null = null;
  private indirectionBuffer: GPUBuffer | null = null;
  private dummyTexture: GPUTexture;
  private dummyIndirectionBuffer: GPUBuffer;
  private lutTexture: GPUTexture;
  private lutSampler: GPUSampler;

  private intensityMin = 0;
  private intensityMax = 65535;
  private gamma = 1.0;
  private opacity = 1.0;
  private chunkDims = [1, 1];
  private gridDims = [1, 1];
  private atlasSlotDims = [1, 1];
  private levelDims = [1, 1];
  private lodMetas: LodIndirectionMeta[] = [];
  // S8: proxy fallback bindings + uniform values. Slice mode reads a
  // single Z plane within the proxy slot — see slice.wgsl notes for the
  // current MVP semantics. Defaults match "no proxy".
  private fieldProxyTexture: GPUTexture | null = null;
  private wellProxyTexture: GPUTexture | null = null;
  private dummyProxyTexture: GPUTexture | null = null;
  private renderModeProxy = 0;
  private fieldProxySlotIndex = 0xFFFFFFFF;
  private wellProxySlotIndex = 0xFFFFFFFF;
  private fieldProxyDims: [number, number, number] = [1, 1, 1]; // [Z, Y, X]
  private wellProxyDims: [number, number, number] = [1, 1, 1];  // [Z, Y, X]

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
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        // S8: proxy textures (fieldProxy + wellProxy). 3D r16uint, same as
        // volume.wgsl — slice mode reads at the slot's Z midpoint.
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint", viewDimension: "3d" },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint", viewDimension: "3d" },
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

    // Default 1x1 white LUT (renders grayscale when no colormap is set)
    this.lutTexture = device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.lutTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );

    this.lutSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
  }

  setColormapTexture(texture: GPUTexture) {
    this.lutTexture = texture;
    this.rebuildBindGroup();
  }

  setAtlas(
    texture: GPUTexture,
    indirectionBuf: GPUBuffer,
    chunkDims: [number, number],
    gridDims: [number, number],
    atlasSlotDims: [number, number],
    levelDims: [number, number],
    lodMetas?: LodIndirectionMeta[],
  ) {
    this.atlasTexture = texture;
    this.indirectionBuffer = indirectionBuf;
    this.chunkDims = chunkDims;
    this.gridDims = gridDims;
    this.atlasSlotDims = atlasSlotDims;
    this.levelDims = levelDims;
    this.lodMetas = lodMetas ?? [];
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

  /** S8: lazily allocate the 1×1×1 dummy proxy texture. */
  private getDummyProxyTexture(): GPUTexture {
    if (!this.dummyProxyTexture) {
      this.dummyProxyTexture = this.device.createTexture({
        size: [1, 1, 1],
        format: "r16uint",
        dimension: "3d",
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
    }
    return this.dummyProxyTexture;
  }

  /**
   * S8: configure proxy textures + per-entity descriptor for the next
   * draw. Must be called before `setAtlas()` (which rebuilds the bind
   * group), or pass `null` textures to fall back to the dummy.
   */
  setProxyParams(
    mode: number,
    fieldTexture: GPUTexture | null,
    fieldSlotIndex: number,
    fieldDims: [number, number, number],
    wellTexture: GPUTexture | null,
    wellSlotIndex: number,
    wellDims: [number, number, number],
  ) {
    this.renderModeProxy = mode;
    this.fieldProxyTexture = fieldTexture;
    this.fieldProxySlotIndex = fieldSlotIndex;
    this.fieldProxyDims = fieldDims;
    this.wellProxyTexture = wellTexture;
    this.wellProxySlotIndex = wellSlotIndex;
    this.wellProxyDims = wellDims;
    this.rebuildBindGroup();
  }

  private rebuildBindGroup() {
    const atlas = this.atlasTexture ?? this.dummyTexture;
    const indirection = this.indirectionBuffer ?? this.dummyIndirectionBuffer;
    const dummyProxy = this.getDummyProxyTexture();
    const fieldProxyView = (this.fieldProxyTexture ?? dummyProxy).createView();
    const wellProxyView = (this.wellProxyTexture ?? dummyProxy).createView();
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: atlas.createView() },
        { binding: 2, resource: { buffer: indirection } },
        { binding: 3, resource: this.lutTexture.createView() },
        { binding: 4, resource: this.lutSampler },
        { binding: 5, resource: fieldProxyView },
        { binding: 6, resource: wellProxyView },
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

    // Multi-LOD per-LOD metadata
    const numLods = Math.min(this.lodMetas.length, 4);
    u32View.set([numLods > 0 ? numLods : 1, 0, 0, 0], 36); // lodParams at 144B = 36 u32s
    for (let i = 0; i < 4; i++) {
      const m = i < numLods ? this.lodMetas[i] : null;
      const base40 = 40 + i * 4; // lodGridDims at 160B = 40 u32s, stride 4
      u32View.set(m ? [m.gridDims[2], m.gridDims[1], 0, m.offset] : [0, 0, 0, 0], base40);
      const base56 = 56 + i * 4; // lodChunkDims at 224B = 56 u32s
      u32View.set(m ? [m.chunkDims[2], m.chunkDims[1], 0, 0] : [0, 0, 0, 0], base56);
      const base72 = 72 + i * 4; // lodLevelDims at 288B = 72 f32s
      uniformData.set(m ? [m.levelDims[2], m.levelDims[1], 0, 0] : [0, 0, 0, 0], base72);
    }
    // If no lodMetas, use single-LOD fallback from atlas params
    if (numLods === 0) {
      u32View.set([this.gridDims[0], this.gridDims[1], 0, 0], 40);
      u32View.set([this.chunkDims[0], this.chunkDims[1], 0, 0], 56);
      uniformData.set([this.levelDims[0], this.levelDims[1], 0, 0], 72);
    }

    // S8: proxy params at offset 352B (= 88 u32s).
    u32View.set(
      [this.renderModeProxy, this.fieldProxySlotIndex >>> 0, this.wellProxySlotIndex >>> 0, 0],
      88,
    );
    u32View.set(
      [this.fieldProxyDims[0], this.fieldProxyDims[1], this.fieldProxyDims[2], 0],
      92,
    );
    u32View.set(
      [this.wellProxyDims[0], this.wellProxyDims[1], this.wellProxyDims[2], 0],
      96,
    );

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
