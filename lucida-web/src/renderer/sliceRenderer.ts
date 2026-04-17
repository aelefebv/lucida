/** WebGPU pipeline for 2D slice rendering with GPU-side u16 normalization. */
import shaderSource from "./slice.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";

// Uniform buffer layout (128 bytes — M2 strips per-entity contrast/gamma/
// opacity that moved into the descriptor buffer):
//   offset 0:   transform        mat4x4f   (64B)
//   offset 64:  atlasSlotDims    vec4u     (16B)
//   offset 80:  memberScreenSize vec4f     (16B)
//   offset 96:  lodParams        vec4u     (16B) — x=targetLodIdx
//   offset 112: proxyParams      vec4u     (16B) — x=renderMode
const UNIFORM_SIZE = 128;
const ENTITY_REF_SIZE = 16;

export class SliceRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private entityRefBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private descriptorBindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;
  private descriptorBindGroup: GPUBindGroup | null = null;
  private currentDescriptorBuffer: GPUBuffer | null = null;

  private atlasTexture: GPUTexture | null = null;
  private indirectionBuffer: GPUBuffer | null = null;
  private dummyTexture: GPUTexture;
  private dummyIndirectionBuffer: GPUBuffer;
  private lutTexture: GPUTexture;
  private lutSampler: GPUSampler;

  private atlasSlotDims = [1, 1];
  // S8 / M1: proxy textures still bound CPU-side (slot indices and dims
  // come from the descriptor).
  private fieldProxyTexture: GPUTexture | null = null;
  private wellProxyTexture: GPUTexture | null = null;
  private dummyProxyTexture: GPUTexture | null = null;
  private renderModeProxy = 0;

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

    this.descriptorBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout, this.descriptorBindGroupLayout],
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
    this.entityRefBuffer = device.createBuffer({
      size: ENTITY_REF_SIZE,
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

  /**
   * M1: setAtlas no longer takes per-entity chunkDims/gridDims/levelDims
   * — those live in the descriptor. atlasSlotDims still per-frame for
   * the shader's slot-coord computation in the chunk path.
   */
  setAtlas(
    texture: GPUTexture,
    indirectionBuf: GPUBuffer,
    atlasSlotDims: [number, number],
  ) {
    this.atlasTexture = texture;
    this.indirectionBuffer = indirectionBuf;
    this.atlasSlotDims = atlasSlotDims;
    this.rebuildBindGroup();
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
   * M1: configure proxy textures + renderMode for the next draw. Slot
   * indices and dims live in the per-entity descriptor; the texture
   * binding stays CPU-side.
   */
  setProxyParams(
    mode: number,
    fieldTexture: GPUTexture | null,
    wellTexture: GPUTexture | null,
  ) {
    this.renderModeProxy = mode;
    this.fieldProxyTexture = fieldTexture;
    this.wellProxyTexture = wellTexture;
    this.rebuildBindGroup();
  }

  /**
   * M1: bind the per-dataset entity descriptor buffer + write the
   * entity index for the next draw.
   */
  setDescriptorBinding(descriptorBuffer: GPUBuffer, entityIndex: number) {
    if (this.currentDescriptorBuffer !== descriptorBuffer || !this.descriptorBindGroup) {
      this.currentDescriptorBuffer = descriptorBuffer;
      this.descriptorBindGroup = this.device.createBindGroup({
        layout: this.descriptorBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: descriptorBuffer } },
          { binding: 1, resource: { buffer: this.entityRefBuffer } },
        ],
      });
    }
    const refData = new Uint32Array([entityIndex >>> 0, 0, 0, 0]);
    this.device.queue.writeBuffer(this.entityRefBuffer, 0, refData);
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

    // Atlas params (u32 written via Uint32Array view)
    const u32View = new Uint32Array(uniformData.buffer);
    u32View.set([this.atlasSlotDims[0], this.atlasSlotDims[1], 0, 0], 16); // atlasSlotDims at 64B = 16 u32s

    // Member screen-pixel size for border detection
    const memberScreenW = dataW * zoom;
    const memberScreenH = dataH * zoom;
    uniformData.set([memberScreenW, memberScreenH, 0, 0], 20); // memberScreenSize at 80B = 20 f32s

    // M1: lodParams.x = targetLodIdx (always 0 — descriptor lods start
    // at finest LOD).
    u32View.set([0, 0, 0, 0], 24); // lodParams at 96B = 24 u32s

    // M1: proxyParams.x = renderMode; rest reserved.
    u32View.set([this.renderModeProxy, 0, 0, 0], 28); // proxyParams at 112B = 28 u32s

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  renderTo(target: GPUTextureView, encoder: GPUCommandEncoder) {
    if (!this.bindGroup || !this.descriptorBindGroup) return;

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
    pass.setBindGroup(1, this.descriptorBindGroup);
    pass.draw(3);
    pass.end();
  }
}
