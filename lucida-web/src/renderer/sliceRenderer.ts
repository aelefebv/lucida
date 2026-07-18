/** WebGPU pipeline for 2D slice rendering with GPU-side u16 normalization. */
import shaderSource from "./slice.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";
import type { BlendMode } from "./layerCompositor.ts";
import type { GpuResourceBudget, TrackedGpuResource } from "./gpuResourceBudget.ts";

// Uniform buffer layout (128 bytes):
//   offset 0:   transform           mat4x4f (64B)
//   offset 64:  detailAtlasSlotDims vec4u   (16B)
//   offset 80:  coarseAtlasSlotDims vec4u   (16B)
//   offset 96:  memberScreenSize    vec4f   (16B)
//   offset 112: lodParams           vec4u   (16B) — x=targetLodIdx
const UNIFORM_SIZE = 128;
const ENTITY_REF_SIZE = 16;

/** One chunk-tier atlas binding for an aggregate sub-batch draw. */
export interface AggregateTierBinding {
  texture: GPUTexture;
  indirectionBuf: GPUBuffer;
  slotsX: number;
  slotsY: number;
}

/**
 * One aggregate sub-batch: a contiguous run of quad records that share
 * the same detail and coarse atlas bindings, drawn with exactly those
 * resources bound. `firstInstance` /
 * `count` address the run inside the layer's quad storage buffer.
 */
export interface AggregateBatch {
  detail: AggregateTierBinding | null;
  coarse: AggregateTierBinding | null;
  firstInstance: number;
  count: number;
}

/** Inputs for {@link SliceRenderer.renderAggregateBatches}. */
export interface AggregateDrawParams {
  /** CURRENT per-dataset descriptor buffer — bound fresh every draw. */
  descriptorBuffer: GPUBuffer;
  /** Batch-ordered quad records (32 bytes each, shader `MemberQuad`). */
  quadData: ArrayBuffer;
  batches: AggregateBatch[];
  blendMode: BlendMode;
  /** Layer transform inputs — same meaning as {@link SliceRenderer.setTransform}. */
  zoom: number;
  cx: number;
  cy: number;
  canvasW: number;
  canvasH: number;
  dataW: number;
  dataH: number;
}

/**
 * Serialize the shader's `Uniforms` block. Shared by the per-member
 * `setTransform` path and the aggregate per-batch uniforms so the two
 * can never drift.
 */
function buildSliceUniformData(
  zoom: number,
  cx: number,
  cy: number,
  canvasW: number,
  canvasH: number,
  dataW: number,
  dataH: number,
  detailSlotDims: [number, number],
  coarseSlotDims: [number, number],
): Float32Array<ArrayBuffer> {
  const sx = canvasW / (dataW * zoom);
  const sy = canvasH / (dataH * zoom);
  const tx = -0.5 * canvasW / (dataW * zoom) + cx / dataW;
  const ty = -0.5 * canvasH / (dataH * zoom) + cy / dataH;

  // mat4x4 in column-major order
  const uniformData = new Float32Array(UNIFORM_SIZE / 4);
  uniformData[0] = sx;  // col0.x
  uniformData[5] = sy;  // col1.y
  uniformData[10] = 1;  // col2.z
  uniformData[12] = tx; // col3.x
  uniformData[13] = ty; // col3.y
  uniformData[15] = 1;  // col3.w

  // Atlas params (u32 written via Uint32Array view)
  const u32View = new Uint32Array(uniformData.buffer);
  u32View.set([detailSlotDims[0], detailSlotDims[1], 0, 0], 16);
  u32View.set([coarseSlotDims[0], coarseSlotDims[1], 0, 0], 20);

  // Layer screen-pixel size for border detection (per-member layers:
  // the member's own size; aggregate layers: the union extent, scaled
  // to each member's fraction in the vertex stage).
  uniformData.set([dataW * zoom, dataH * zoom, 0, 0], 24);

  // lodParams.x = targetLodIdx (always 0 — descriptor lods start at
  // finest LOD).
  u32View.set([0, 0, 0, 0], 28);
  return uniformData;
}

export class SliceRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private aggregatePipelines: Record<BlendMode, GPURenderPipeline>;
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
  // Aggregate draw RESOURCES: grow-only pools whose contents are
  // rewritten on every draw. Deliberately no bind-group or
  // descriptor-identity caching here — descriptor buffers are rebuilt
  // whenever display settings or residency change, and the aggregate
  // must bind whatever is current at draw time, exactly like the
  // per-member path.
  private aggregateQuadBuffer: GPUBuffer | null = null;
  private aggregateQuadAllocation: TrackedGpuResource<GPUBuffer> | null = null;
  private aggregateQuadCapacity = 0;
  private aggregateUniformBuffers: GPUBuffer[] = [];
  private aggregateUniformAllocations: TrackedGpuResource<GPUBuffer>[] = [];

  private detailAtlasTexture: GPUTexture | null = null;
  private detailIndirectionBuffer: GPUBuffer | null = null;
  private coarseAtlasTexture: GPUTexture | null = null;
  private coarseIndirectionBuffer: GPUBuffer | null = null;
  private dummyTexture: GPUTexture;
  private dummyIndirectionBuffer: GPUBuffer;
  private dummyLabelColorBuffer: GPUBuffer;
  private lutTexture: GPUTexture;
  private lutSampler: GPUSampler;
  private uniformAllocation!: TrackedGpuResource<GPUBuffer>;
  private entityRefAllocation!: TrackedGpuResource<GPUBuffer>;
  private dummyTextureAllocation!: TrackedGpuResource<GPUTexture>;
  private dummyIndirectionAllocation!: TrackedGpuResource<GPUBuffer>;
  private dummyLabelColorAllocation!: TrackedGpuResource<GPUBuffer>;
  private lutAllocation!: TrackedGpuResource<GPUTexture>;
  private readonly resources: GpuResourceBudget;

  private detailAtlasSlotDims: [number, number] = [0, 0];
  private coarseAtlasSlotDims: [number, number] = [0, 0];

  constructor(device: GPUDevice, resources: GpuResourceBudget) {
    this.device = device;
    this.resources = resources;

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

    // Aggregate pipelines: one per blend mode, mirroring the compositor's
    // blend states EXACTLY (the fragment stage outputs premultiplied
    // color, same as the offscreen layers the compositor consumes), so
    // members that overlap WITHIN a batch combine the way two individual
    // layers of that mode would. Draw order in the pass is quad (roster)
    // order within a batch, batches in first-seen roster order. Residual
    // vs. true per-member layering: two overlapping members that landed
    // in DIFFERENT pool-binding batches blend in batch order rather than
    // global roster order (only visible for alpha-mode overlap across
    // heterogeneous pools), and a batched member overlapping an
    // INDIVIDUAL layer composites beneath it (the aggregate layer is
    // emitted below the individual layers).
    const aggregateLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout, this.aggregateBindGroupLayout],
    });
    const makeAggregatePipeline = (blend: GPUBlendState) => device.createRenderPipeline({
      layout: aggregateLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vsAggregate",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fsAggregate",
        targets: [{ format: OFFSCREEN_FORMAT, blend }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.aggregatePipelines = {
      alpha: makeAggregatePipeline({
        color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      }),
      additive: makeAggregatePipeline({
        color: { srcFactor: "one", dstFactor: "one", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
      }),
      max: makeAggregatePipeline({
        color: { srcFactor: "one", dstFactor: "one", operation: "max" },
        alpha: { srcFactor: "one", dstFactor: "one", operation: "max" },
      }),
    };

    try {
      this.uniformAllocation = resources.createBuffer(
        device,
        { key: "renderer:slice:uniform", kind: "buffer" },
        { size: UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST },
      );
      this.uniformBuffer = this.uniformAllocation.resource;
      this.entityRefAllocation = resources.createBuffer(
        device,
        { key: "renderer:slice:entity-ref", kind: "buffer" },
        { size: ENTITY_REF_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST },
      );
      this.entityRefBuffer = this.entityRefAllocation.resource;

      // 1x1 dummy texture for unset bindings
      this.dummyTextureAllocation = resources.createTexture(
        device,
        { key: "renderer:slice:dummy-texture", kind: "lookup" },
        { size: [1, 1], format: "r16uint", usage: GPUTextureUsage.TEXTURE_BINDING },
      );
      this.dummyTexture = this.dummyTextureAllocation.resource;

      // Dummy indirection buffer (single sentinel entry)
      const dummyData = new Uint32Array([0xFFFFFFFF]);
      this.dummyIndirectionAllocation = resources.createBuffer(
        device,
        { key: "renderer:slice:dummy-indirection", kind: "buffer" },
        { size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST },
      );
      this.dummyIndirectionBuffer = this.dummyIndirectionAllocation.resource;
      device.queue.writeBuffer(this.dummyIndirectionBuffer, 0, dummyData);

      this.dummyLabelColorAllocation = resources.createBuffer(
        device,
        { key: "renderer:slice:dummy-label-color", kind: "buffer" },
        { size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST },
      );
      this.dummyLabelColorBuffer = this.dummyLabelColorAllocation.resource;
      device.queue.writeBuffer(this.dummyLabelColorBuffer, 0, new Uint32Array([0]));

      // Default 1x1 white LUT (renders grayscale when no colormap is set)
      this.lutAllocation = resources.createTexture(
        device,
        { key: "renderer:slice:default-lut", kind: "lookup" },
        {
          size: [1, 1],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        },
      );
      this.lutTexture = this.lutAllocation.resource;
    } catch (error) {
      resources.destroyOwnerPrefix("renderer:slice:");
      throw error;
    }
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
      ],
    });
  }

  setTransform(zoom: number, cx: number, cy: number, canvasW: number, canvasH: number, dataW: number, dataH: number) {
    const uniformData = buildSliceUniformData(
      zoom, cx, cy, canvasW, canvasH, dataW, dataH,
      this.detailAtlasSlotDims, this.coarseAtlasSlotDims,
    );
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
   * Draw an aggregate layer's member quads in ONE render pass, one
   * instanced draw per pool-binding sub-batch. Each batch binds its
   * members' OWN detail/coarse atlases, so every quad samples the same
   * resources the per-member
   * pass would have bound for it; slot indices, dims, and display state
   * (contrast/gamma/opacity) come from `descriptorBuffer`, which is
   * re-bound fresh on every call so the draw always reflects the
   * current descriptor contents.
   *
   * `quadData` holds the batch-ordered 32-byte quad records
   * (`SliceAggregateParams` layout == shader `MemberQuad`); the layer's
   * colormap LUT is configured via {@link setColormapTexture} before
   * the call. Blending per {@link AggregateDrawParams.blendMode} — see
   * the pipeline construction note for the exact states + the ordering
   * residual.
   */
  renderAggregateBatches(
    target: GPUTextureView,
    encoder: GPUCommandEncoder,
    params: AggregateDrawParams,
  ) {
    const { batches, quadData } = params;
    if (batches.length === 0 || quadData.byteLength === 0) return;

    if (!this.aggregateQuadBuffer || this.aggregateQuadCapacity < quadData.byteLength) {
      this.aggregateQuadAllocation?.destroy();
      this.aggregateQuadAllocation = this.resources.createBuffer(
        this.device,
        { key: "renderer:slice:aggregate-quads", kind: "buffer" },
        { size: quadData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST },
      );
      this.aggregateQuadBuffer = this.aggregateQuadAllocation.resource;
      this.aggregateQuadCapacity = quadData.byteLength;
    }
    this.device.queue.writeBuffer(this.aggregateQuadBuffer, 0, quadData);

    // Descriptor + quad storage (group 1) — built fresh so the CURRENT
    // descriptor buffer is bound even when it was rebuilt since the
    // last frame (cold-state rebuilds replace the buffer object).
    const quadBindGroup = this.device.createBindGroup({
      layout: this.aggregateBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: params.descriptorBuffer } },
        { binding: 3, resource: { buffer: this.aggregateQuadBuffer } },
      ],
    });

    // Per-batch uniforms: same transform, but each batch carries its own
    // atlas slot dims. Buffers are pooled by index across frames; the
    // contents are rewritten before every submit.
    while (this.aggregateUniformBuffers.length < batches.length) {
      const index = this.aggregateUniformBuffers.length;
      const allocation = this.resources.createBuffer(
        this.device,
        { key: `renderer:slice:aggregate-uniform:${index}`, kind: "buffer" },
        { size: UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST },
      );
      this.aggregateUniformAllocations.push(allocation);
      this.aggregateUniformBuffers.push(allocation.resource);
    }

    const batchBindGroups = batches.map((batch, i) => {
      const uniformData = buildSliceUniformData(
        params.zoom, params.cx, params.cy,
        params.canvasW, params.canvasH,
        params.dataW, params.dataH,
        batch.detail ? [batch.detail.slotsX, batch.detail.slotsY] : [0, 0],
        batch.coarse ? [batch.coarse.slotsX, batch.coarse.slotsY] : [0, 0],
      );
      this.device.queue.writeBuffer(this.aggregateUniformBuffers[i], 0, uniformData);
      return this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.aggregateUniformBuffers[i] } },
          { binding: 1, resource: (batch.detail?.texture ?? this.dummyTexture).createView() },
          { binding: 2, resource: { buffer: batch.detail?.indirectionBuf ?? this.dummyIndirectionBuffer } },
          { binding: 3, resource: this.lutTexture.createView() },
          { binding: 4, resource: this.lutSampler },
          { binding: 5, resource: (batch.coarse?.texture ?? this.dummyTexture).createView() },
          { binding: 6, resource: { buffer: batch.coarse?.indirectionBuf ?? this.dummyIndirectionBuffer } },
        ],
      });
    });

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
    pass.setPipeline(this.aggregatePipelines[params.blendMode]);
    pass.setBindGroup(1, quadBindGroup);
    batches.forEach((batch, i) => {
      if (batch.count <= 0) return;
      pass.setBindGroup(0, batchBindGroups[i]);
      // `firstInstance` addresses the batch's contiguous run inside the
      // shared quad buffer (instance_index includes the offset).
      pass.draw(6, batch.count, 0, batch.firstInstance);
    });
    pass.end();
  }

  /** Release every renderer-owned destroyable handle exactly once. */
  destroy(): void {
    this.resources.destroyOwnerPrefix("renderer:slice:");
    this.aggregateQuadAllocation = null;
    this.aggregateQuadBuffer = null;
    this.aggregateUniformAllocations = [];
    this.aggregateUniformBuffers = [];
  }
}
