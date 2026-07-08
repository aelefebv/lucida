/** WebGPU pipeline for 2D slice rendering with GPU-side u16 normalization. */
import shaderSource from "./slice.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";

// Uniform buffer layout (128 bytes):
//   offset 0:   transform           mat4x4f (64B)
//   offset 64:  detailAtlasSlotDims vec4u   (16B)
//   offset 80:  coarseAtlasSlotDims vec4u   (16B)
//   offset 96:  memberScreenSize    vec4f   (16B)
//   offset 112: lodParams           vec4u   (16B) — x=targetLodIdx
const UNIFORM_SIZE = 128;
const ENTITY_REF_SIZE = 16;

export class SliceRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private aggregatePipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private entityRefBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private descriptorBindGroupLayout: GPUBindGroupLayout;
  private aggregateBindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;
  private descriptorBindGroup: GPUBindGroup | null = null;
  private currentDescriptorBuffer: GPUBuffer | null = null;
  private currentLabelColorBuffer: GPUBuffer | null = null;
  private labelColorBuffer: GPUBuffer | null = null;
  // Aggregate (batched member) draw state: grown-as-needed quad storage
  // + a bind group cached on the (descriptor buffer, quad buffer) pair.
  private aggregateQuadBuffer: GPUBuffer | null = null;
  private aggregateQuadCapacity = 0;
  private aggregateBindGroup: GPUBindGroup | null = null;
  private aggregateBoundDescriptorBuffer: GPUBuffer | null = null;

  private detailAtlasTexture: GPUTexture | null = null;
  private detailIndirectionBuffer: GPUBuffer | null = null;
  private coarseAtlasTexture: GPUTexture | null = null;
  private coarseIndirectionBuffer: GPUBuffer | null = null;
  private dummyTexture: GPUTexture;
  private dummyIndirectionBuffer: GPUBuffer;
  private dummyLabelColorBuffer: GPUBuffer;
  private lutTexture: GPUTexture;
  private lutSampler: GPUSampler;

  private detailAtlasSlotDims: [number, number] = [0, 0];
  private coarseAtlasSlotDims: [number, number] = [0, 0];
  // Proxy textures still bound CPU-side (slot indices and dims come
  // from the descriptor).
  private tileProxyTexture: GPUTexture | null = null;
  private groupProxyTexture: GPUTexture | null = null;
  private dummyProxyTexture: GPUTexture | null = null;

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
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint", viewDimension: "2d" },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
        // Proxy textures (tileProxy + groupProxy). 3D r16uint, same as
        // volume.wgsl — slice mode reads at the slot's Z midpoint.
        {
          binding: 7,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint", viewDimension: "3d" },
        },
        {
          binding: 8,
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
        // Declared label palette: [id, packedRgba] pairs scanned in-shader
        // for categorical draws. A 1-entry dummy is bound for intensity.
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    // Aggregate pass: the descriptor array plus the per-member quad
    // storage the instanced vertex stage reads. Binding numbers match
    // the WGSL declarations (0 = entityDescriptors, 3 = memberQuads);
    // the per-member layout's entity-ref/palette bindings are absent
    // because the aggregate entry points never reference them.
    this.aggregateBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
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

    // Shares group(0) with the per-member pipeline (same layout object,
    // so the same bind group binds to both).
    this.aggregatePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout, this.aggregateBindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: "vsAggregate",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fsAggregate",
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

    // Dummy declared-palette buffer (one u32) for non-categorical draws;
    // the shader scans 0 pairs (count comes from the entity ref).
    this.dummyLabelColorBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.dummyLabelColorBuffer, 0, new Uint32Array([0]));

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
   * Per-entity chunkDims/gridDims/levelDims live in the descriptor.
   * atlasSlotDims still per-frame for the shader's slot-coord
   * computation in the chunk path.
   */
  setAtlas(
    texture: GPUTexture,
    indirectionBuf: GPUBuffer,
    atlasSlotDims: [number, number],
  ) {
    this.setTierAtlases(texture, indirectionBuf, atlasSlotDims, null, null, [0, 0]);
  }

  setTierAtlases(
    detailTexture: GPUTexture | null,
    detailIndirectionBuf: GPUBuffer | null,
    detailAtlasSlotDims: [number, number],
    coarseTexture: GPUTexture | null,
    coarseIndirectionBuf: GPUBuffer | null,
    coarseAtlasSlotDims: [number, number],
  ) {
    this.detailAtlasTexture = detailTexture;
    this.detailIndirectionBuffer = detailIndirectionBuf;
    this.detailAtlasSlotDims = detailTexture && detailIndirectionBuf ? detailAtlasSlotDims : [0, 0];
    this.coarseAtlasTexture = coarseTexture;
    this.coarseIndirectionBuffer = coarseIndirectionBuf;
    this.coarseAtlasSlotDims = coarseTexture && coarseIndirectionBuf ? coarseAtlasSlotDims : [0, 0];
    this.rebuildBindGroup();
  }

  /** Lazily allocate the 1×1×1 dummy proxy texture. */
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
   * Configure proxy textures for the next draw. Slot indices and dims
   * live in the per-entity descriptor; the shader's unified fallback
   * chain decides per-fragment whether to consult them.
   */
  setProxyTextures(
    tileTexture: GPUTexture | null,
    groupTexture: GPUTexture | null,
  ) {
    this.tileProxyTexture = tileTexture;
    this.groupProxyTexture = groupTexture;
    this.rebuildBindGroup();
  }

  /**
   * Set the declared-label-palette storage buffer for the next categorical
   * draw ([id, packedRgba] pairs). Pass `null` (or omit) for intensity
   * draws — a dummy is bound so the layout stays satisfied.
   */
  setLabelColorBuffer(buffer: GPUBuffer | null) {
    this.labelColorBuffer = buffer;
  }

  /**
   * Bind the per-dataset entity descriptor buffer + write the entity
   * index (and, for categorical label draws, the declared-palette count)
   * for the next draw.
   */
  setDescriptorBinding(descriptorBuffer: GPUBuffer, entityIndex: number, labelColorCount = 0) {
    const labelColors = this.labelColorBuffer ?? this.dummyLabelColorBuffer;
    if (
      this.currentDescriptorBuffer !== descriptorBuffer ||
      this.currentLabelColorBuffer !== labelColors ||
      !this.descriptorBindGroup
    ) {
      this.currentDescriptorBuffer = descriptorBuffer;
      this.currentLabelColorBuffer = labelColors;
      this.descriptorBindGroup = this.device.createBindGroup({
        layout: this.descriptorBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: descriptorBuffer } },
          { binding: 1, resource: { buffer: this.entityRefBuffer } },
          { binding: 2, resource: { buffer: labelColors } },
        ],
      });
    }
    const refData = new Uint32Array([entityIndex >>> 0, labelColorCount >>> 0, 0, 0]);
    this.device.queue.writeBuffer(this.entityRefBuffer, 0, refData);
  }

  private rebuildBindGroup() {
    const detailAtlas = this.detailAtlasTexture ?? this.dummyTexture;
    const detailIndirection = this.detailIndirectionBuffer ?? this.dummyIndirectionBuffer;
    const coarseAtlas = this.coarseAtlasTexture ?? this.dummyTexture;
    const coarseIndirection = this.coarseIndirectionBuffer ?? this.dummyIndirectionBuffer;
    const dummyProxy = this.getDummyProxyTexture();
    const tileProxyView = (this.tileProxyTexture ?? dummyProxy).createView();
    const groupProxyView = (this.groupProxyTexture ?? dummyProxy).createView();
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: detailAtlas.createView() },
        { binding: 2, resource: { buffer: detailIndirection } },
        { binding: 3, resource: this.lutTexture.createView() },
        { binding: 4, resource: this.lutSampler },
        { binding: 5, resource: coarseAtlas.createView() },
        { binding: 6, resource: { buffer: coarseIndirection } },
        { binding: 7, resource: tileProxyView },
        { binding: 8, resource: groupProxyView },
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
    u32View.set([this.detailAtlasSlotDims[0], this.detailAtlasSlotDims[1], 0, 0], 16);
    u32View.set([this.coarseAtlasSlotDims[0], this.coarseAtlasSlotDims[1], 0, 0], 20);

    // Member screen-pixel size for border detection
    const memberScreenW = dataW * zoom;
    const memberScreenH = dataH * zoom;
    uniformData.set([memberScreenW, memberScreenH, 0, 0], 24);

    // lodParams.x = targetLodIdx (always 0 — descriptor lods start at
    // finest LOD).
    u32View.set([0, 0, 0, 0], 28);

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

  /**
   * Draw an aggregate layer's member quads in ONE pass: a single
   * instanced draw where instance `i` covers `quads` record `i` and
   * samples that record's entity descriptor. Callers configure atlases,
   * colormap, and the layer transform through the same setters as
   * {@link renderTo}; `quads` uses the `SliceAggregateParams` record
   * layout (rect f32×4 + entityIndex u32 + padding, 32 bytes/record).
   */
  renderAggregateTo(
    target: GPUTextureView,
    encoder: GPUCommandEncoder,
    descriptorBuffer: GPUBuffer,
    quads: ArrayBuffer,
    count: number,
  ) {
    if (!this.bindGroup || count <= 0) return;

    if (!this.aggregateQuadBuffer || this.aggregateQuadCapacity < quads.byteLength) {
      this.aggregateQuadBuffer?.destroy();
      this.aggregateQuadBuffer = this.device.createBuffer({
        size: quads.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.aggregateQuadCapacity = quads.byteLength;
      this.aggregateBindGroup = null;
    }
    this.device.queue.writeBuffer(this.aggregateQuadBuffer, 0, quads);

    if (!this.aggregateBindGroup || this.aggregateBoundDescriptorBuffer !== descriptorBuffer) {
      this.aggregateBoundDescriptorBuffer = descriptorBuffer;
      this.aggregateBindGroup = this.device.createBindGroup({
        layout: this.aggregateBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: descriptorBuffer } },
          { binding: 3, resource: { buffer: this.aggregateQuadBuffer } },
        ],
      });
    }

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
    pass.setPipeline(this.aggregatePipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setBindGroup(1, this.aggregateBindGroup);
    pass.draw(6, count);
    pass.end();
  }
}
