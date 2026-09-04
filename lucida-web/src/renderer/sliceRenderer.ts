/** WebGPU pipeline for 2D slice rendering with GPU-side u16 normalization. */
import shaderSource from "./slice.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";
import type { BlendMode } from "./layerCompositor.ts";
import { DESCRIPTOR_MAX_LEVEL_SOURCES } from "./descriptor/layout.ts";

/**
 * Byte offsets of the shader's `Uniforms` fields (slice.wgsl). The
 * writer below and descriptor/layout.test.ts both read this table, so a
 * reordered struct fails the test instead of skewing the draw.
 */
export const SLICE_UNIFORM_OFFSETS = {
  transform: 0,            // mat4x4f (64B)
  levelAtlasSlotDims: 64,  // array<vec4u, 4> (64B) — xy=slots per axis per level pool binding
  coarseAtlasSlotDims: 128, // vec4u (16B)
  memberScreenSize: 144,   // vec4f (16B)
} as const;
export const SLICE_UNIFORM_SIZE = 160;
const ENTITY_REF_SIZE = 16;

/** One chunk pool bound to a slice draw: its atlas texture, indirection buffer, and slot grid. */
export interface SlicePoolBinding {
  texture: GPUTexture;
  indirectionBuf: GPUBuffer;
  slotsX: number;
  slotsY: number;
}

/**
 * One aggregate sub-batch: a contiguous run of quad records that share
 * the same pool bindings (level pools in slot order, coarse pool,
 * tile/group proxy pools), drawn with exactly those resources bound.
 * `firstInstance` / `count` address the run inside the layer's quad
 * storage buffer.
 */
export interface AggregateBatch {
  /** Level pool bindings in slot order (index = the descriptor's `poolIndex`); at most four. */
  levels: Array<SlicePoolBinding | null>;
  coarse: SlicePoolBinding | null;
  tileProxyTexture: GPUTexture | null;
  groupProxyTexture: GPUTexture | null;
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

/** Slot dims of each level pool binding, `[0, 0]` for an unbound slot. */
type LevelSlotDims = Array<[number, number]>;

function levelSlotDimsOf(levels: ReadonlyArray<SlicePoolBinding | null>): LevelSlotDims {
  const out: LevelSlotDims = [];
  for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
    const b = levels[i] ?? null;
    out.push(b ? [b.slotsX, b.slotsY] : [0, 0]);
  }
  return out;
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
  levelSlotDims: LevelSlotDims,
  coarseSlotDims: [number, number],
): Float32Array<ArrayBuffer> {
  const sx = canvasW / (dataW * zoom);
  const sy = canvasH / (dataH * zoom);
  const tx = -0.5 * canvasW / (dataW * zoom) + cx / dataW;
  const ty = -0.5 * canvasH / (dataH * zoom) + cy / dataH;

  // mat4x4 in column-major order
  const uniformData = new Float32Array(SLICE_UNIFORM_SIZE / 4);
  uniformData[0] = sx;  // col0.x
  uniformData[5] = sy;  // col1.y
  uniformData[10] = 1;  // col2.z
  uniformData[12] = tx; // col3.x
  uniformData[13] = ty; // col3.y
  uniformData[15] = 1;  // col3.w

  // Atlas params (u32 written via Uint32Array view)
  const u32View = new Uint32Array(uniformData.buffer);
  for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
    const [sxSlots, sySlots] = levelSlotDims[i] ?? [0, 0];
    u32View.set([sxSlots, sySlots, 0, 0], SLICE_UNIFORM_OFFSETS.levelAtlasSlotDims / 4 + i * 4);
  }
  u32View.set([coarseSlotDims[0], coarseSlotDims[1], 0, 0], SLICE_UNIFORM_OFFSETS.coarseAtlasSlotDims / 4);

  // Layer screen-pixel size for border detection (per-member layers:
  // the member's own size; aggregate layers: the union extent, scaled
  // to each member's fraction in the vertex stage).
  uniformData.set([dataW * zoom, dataH * zoom, 0, 0], SLICE_UNIFORM_OFFSETS.memberScreenSize / 4);
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
  private aggregateQuadCapacity = 0;
  private aggregateUniformBuffers: GPUBuffer[] = [];

  private levelBindings: Array<SlicePoolBinding | null> = [];
  private coarseBinding: SlicePoolBinding | null = null;
  private dummyTexture: GPUTexture;
  private dummyIndirectionBuffer: GPUBuffer;
  private dummyLabelColorBuffer: GPUBuffer;
  private lutTexture: GPUTexture;
  private lutSampler: GPUSampler;

  // Proxy textures still bound CPU-side (slot indices and dims come
  // from the descriptor).
  private tileProxyTexture: GPUTexture | null = null;
  private groupProxyTexture: GPUTexture | null = null;
  private dummyProxyTexture: GPUTexture | null = null;

  constructor(device: GPUDevice) {
    this.device = device;

    const shaderModule = device.createShaderModule({ code: shaderSource });

    const levelTextureEntries: GPUBindGroupLayoutEntry[] = [];
    const levelIndirectionEntries: GPUBindGroupLayoutEntry[] = [];
    for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      levelTextureEntries.push({
        binding: 7 + i,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "uint", viewDimension: "2d" },
      });
      levelIndirectionEntries.push({
        binding: 7 + DESCRIPTOR_MAX_LEVEL_SOURCES + i,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      });
    }
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
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint", viewDimension: "2d" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
        // Proxy textures (tileProxy + groupProxy). 3D r16uint, same as
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
        // One level pool per resident-level slot: textures at 7..10,
        // their indirection buffers at 11..14.
        ...levelTextureEntries,
        ...levelIndirectionEntries,
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

    this.uniformBuffer = device.createBuffer({
      size: SLICE_UNIFORM_SIZE,
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
   * Bind the level pools a member's level sources name, in slot order
   * (index = the descriptor's `poolIndex`), plus the coarse pool. `null`
   * or a missing slot binds the dummy texture and sentinel indirection;
   * the shader's slot-dims guard makes such a slot read as a miss.
   */
  setTierAtlases(
    levels: ReadonlyArray<SlicePoolBinding | null>,
    coarse: SlicePoolBinding | null,
  ) {
    this.levelBindings = levels.slice(0, DESCRIPTOR_MAX_LEVEL_SOURCES);
    this.coarseBinding = coarse;
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
   * live in the per-entity descriptor; the shader consults them only
   * when the entity binds no chunk tier.
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

  /** The group-0 bind group entries for one set of pool bindings. */
  private poolBindGroupEntries(
    uniformBuffer: GPUBuffer,
    levels: ReadonlyArray<SlicePoolBinding | null>,
    coarse: SlicePoolBinding | null,
    tileProxyTexture: GPUTexture | null,
    groupProxyTexture: GPUTexture | null,
  ): GPUBindGroupEntry[] {
    const dummyProxy = this.getDummyProxyTexture();
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: this.lutTexture.createView() },
      { binding: 2, resource: this.lutSampler },
      { binding: 3, resource: (coarse?.texture ?? this.dummyTexture).createView() },
      { binding: 4, resource: { buffer: coarse?.indirectionBuf ?? this.dummyIndirectionBuffer } },
      { binding: 5, resource: (tileProxyTexture ?? dummyProxy).createView() },
      { binding: 6, resource: (groupProxyTexture ?? dummyProxy).createView() },
    ];
    for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      const b = levels[i] ?? null;
      entries.push({ binding: 7 + i, resource: (b?.texture ?? this.dummyTexture).createView() });
      entries.push({
        binding: 7 + DESCRIPTOR_MAX_LEVEL_SOURCES + i,
        resource: { buffer: b?.indirectionBuf ?? this.dummyIndirectionBuffer },
      });
    }
    return entries;
  }

  private rebuildBindGroup() {
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: this.poolBindGroupEntries(
        this.uniformBuffer,
        this.levelBindings,
        this.coarseBinding,
        this.tileProxyTexture,
        this.groupProxyTexture,
      ),
    });
  }

  setTransform(zoom: number, cx: number, cy: number, canvasW: number, canvasH: number, dataW: number, dataH: number) {
    const uniformData = buildSliceUniformData(
      zoom, cx, cy, canvasW, canvasH, dataW, dataH,
      levelSlotDimsOf(this.levelBindings),
      this.coarseBinding ? [this.coarseBinding.slotsX, this.coarseBinding.slotsY] : [0, 0],
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
   * members' OWN level pools, coarse pool, and tile/group proxy pool
   * textures, so every quad samples the same resources the per-member
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
      this.aggregateQuadBuffer?.destroy();
      this.aggregateQuadBuffer = this.device.createBuffer({
        size: quadData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
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
      this.aggregateUniformBuffers.push(this.device.createBuffer({
        size: SLICE_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }));
    }

    const batchBindGroups = batches.map((batch, i) => {
      const uniformData = buildSliceUniformData(
        params.zoom, params.cx, params.cy,
        params.canvasW, params.canvasH,
        params.dataW, params.dataH,
        levelSlotDimsOf(batch.levels),
        batch.coarse ? [batch.coarse.slotsX, batch.coarse.slotsY] : [0, 0],
      );
      this.device.queue.writeBuffer(this.aggregateUniformBuffers[i], 0, uniformData);
      return this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: this.poolBindGroupEntries(
          this.aggregateUniformBuffers[i],
          batch.levels,
          batch.coarse,
          batch.tileProxyTexture,
          batch.groupProxyTexture,
        ),
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
}
