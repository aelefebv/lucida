/** WebGPU pipeline for 2D slice rendering with GPU-side u16 normalization. */
import { isAxisAlignedQuad, quadEdgeLengths, type SliceQuad } from "./sliceQuad.ts";
import shaderSource from "./slice.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";
import { LAYER_BLENDS, type BlendMode } from "./layerCompositor.ts";
import type { PassTiming } from "./passTiming.ts";
import { DESCRIPTOR_MAX_LEVEL_SOURCES } from "./descriptor/layout.ts";
import { requireCompiled } from "./pipelineCompile.ts";
import type { RgbaColor } from "./workerProtocol.ts";

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
  borderColor: 160,        // vec4f (16B) — premultiplied
} as const;
export const SLICE_UNIFORM_SIZE = 176;
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
 * the same pool bindings (level pools in slot order, coarse pool), drawn
 * with exactly those resources bound.
 * `firstInstance` / `count` address the run inside the layer's quad
 * storage buffer.
 */
export interface AggregateBatch {
  /** Level pool bindings in slot order (index = the descriptor's `poolIndex`); at most four. */
  levels: Array<SlicePoolBinding | null>;
  coarse: SlicePoolBinding | null;
  firstInstance: number;
  count: number;
}

/** An aggregate layer's draw within a {@link LayerGroupDraw}. */
export interface AggregateDrawParams {
  /** Per-dataset descriptor buffer, bound fresh every draw. */
  descriptorBuffer: GPUBuffer;
  /** Batch-ordered quad records (32 bytes each, shader `MemberQuad`). */
  quadData: ArrayBuffer;
  batches: AggregateBatch[];
  colormap: GPUTexture;
  /** Where the layer lies on screen, as in {@link SliceRenderer.setTransform}. */
  placement: SliceLayerPlacement;
}

/** One member's draw within a {@link LayerGroupDraw}: what the per-member setters would have bound. */
export interface MemberDraw {
  /** Level pool bindings in slot order (index = the descriptor's `poolIndex`); at most four. */
  levels: Array<SlicePoolBinding | null>;
  coarse: SlicePoolBinding | null;
  colormap: GPUTexture;
  descriptorBuffer: GPUBuffer;
  entityIndex: number;
  /** Where the member lies on screen, as in {@link SliceRenderer.setTransform}. */
  placement: SliceLayerPlacement;
  /** The target pixels the member covers, `[x, y, width, height]`; the draw touches nothing else. */
  scissor: [number, number, number, number];
}

/**
 * Every layer of one (dataset, channel), drawn into one target in one render
 * pass: the aggregate beneath, then the members in order. Draws blend with
 * the layers' own mode, which is associative, so compositing the target once
 * matches compositing each layer in turn.
 */
export interface LayerGroupDraw {
  blendMode: BlendMode;
  canvasW: number;
  canvasH: number;
  aggregate: AggregateDrawParams | null;
  members: MemberDraw[];
}

/**
 * Where a layer lies on screen: the slice camera, device pixels per scene
 * unit and the scene point at the target's center, and the layer's quad in
 * the scene frame.
 */
export interface SliceLayerPlacement {
  zoom: number;
  cx: number;
  cy: number;
  quad: SliceQuad;
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
  placement: SliceLayerPlacement,
  canvasW: number,
  canvasH: number,
  levelSlotDims: LevelSlotDims,
  coarseSlotDims: [number, number],
  borderColor: RgbaColor,
  pixelRatio: number,
): Float32Array<ArrayBuffer> {
  const uniformData = new Float32Array(SLICE_UNIFORM_SIZE / 4);
  writeSliceUniformData(
    uniformData, new Uint32Array(uniformData.buffer), 0,
    placement, canvasW, canvasH, levelSlotDims, coarseSlotDims, borderColor, pixelRatio,
  );
  return uniformData;
}

/** Write one `Uniforms` block at float index `base` of `f32`, whose `u32` view shares its buffer. */
function writeSliceUniformData(
  f32: Float32Array,
  u32: Uint32Array,
  base: number,
  placement: SliceLayerPlacement,
  canvasW: number,
  canvasH: number,
  levelSlotDims: LevelSlotDims,
  coarseSlotDims: [number, number],
  borderColor: RgbaColor,
  pixelRatio: number,
): void {
  f32.fill(0, base, base + SLICE_UNIFORM_SIZE / 4);

  // mat4x4 in column-major order: screen UV to the layer's UV.
  const { zoom, quad } = placement;
  const cx = placement.cx - quad.origin[0];
  const cy = placement.cy - quad.origin[1];
  if (isAxisAlignedQuad(quad)) {
    const dataW = quad.across[0];
    const dataH = quad.down[1];
    f32[base + 0] = canvasW / (dataW * zoom);  // col0.x
    f32[base + 5] = canvasH / (dataH * zoom);  // col1.y
    f32[base + 12] = -0.5 * canvasW / (dataW * zoom) + cx / dataW; // col3.x
    f32[base + 13] = -0.5 * canvasH / (dataH * zoom) + cy / dataH; // col3.y
  } else {
    // The scene point a screen UV lands on, read back into the quad's
    // unit square through the inverse of its edges.
    const [a, c] = quad.across;
    const [b, d] = quad.down;
    const det = a * d - b * c;
    const [i00, i01, i10, i11] = [d / det, -b / det, -c / det, a / det];
    const sx = canvasW / zoom;
    const sy = canvasH / zoom;
    const tx = cx - 0.5 * sx;
    const ty = cy - 0.5 * sy;
    f32[base + 0] = i00 * sx;  // col0.x
    f32[base + 1] = i10 * sx;  // col0.y
    f32[base + 4] = i01 * sy;  // col1.x
    f32[base + 5] = i11 * sy;  // col1.y
    f32[base + 12] = i00 * tx + i01 * ty; // col3.x
    f32[base + 13] = i10 * tx + i11 * ty; // col3.y
  }
  f32[base + 10] = 1;  // col2.z
  f32[base + 15] = 1;  // col3.w

  for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
    const [sxSlots, sySlots] = levelSlotDims[i] ?? [0, 0];
    const at = base + SLICE_UNIFORM_OFFSETS.levelAtlasSlotDims / 4 + i * 4;
    u32[at] = sxSlots;
    u32[at + 1] = sySlots;
  }
  const coarseAt = base + SLICE_UNIFORM_OFFSETS.coarseAtlasSlotDims / 4;
  u32[coarseAt] = coarseSlotDims[0];
  u32[coarseAt + 1] = coarseSlotDims[1];

  // Layer screen-pixel size for border detection (per-member layers:
  // the member's own size; aggregate layers: the union extent, scaled
  // to each member's fraction in the vertex stage), and the pixel ratio
  // that sizes the failed hatch.
  const sizeAt = base + SLICE_UNIFORM_OFFSETS.memberScreenSize / 4;
  const [edgeW, edgeH] = quadEdgeLengths(quad);
  f32[sizeAt] = edgeW * zoom;
  f32[sizeAt + 1] = edgeH * zoom;
  f32[sizeAt + 2] = pixelRatio;
  const [r, g, b, a] = borderColor;
  const borderAt = base + SLICE_UNIFORM_OFFSETS.borderColor / 4;
  f32[borderAt] = r * a;
  f32[borderAt + 1] = g * a;
  f32[borderAt + 2] = b * a;
  f32[borderAt + 3] = a;
}

/**
 * Bytes between two members' blocks in the shared member buffers. A dynamic
 * offset must be a multiple of the device's `minUniformBufferOffsetAlignment`,
 * which is at most 256 on every device.
 */
const MEMBER_BLOCK_STRIDE = 256;

/**
 * The member bind groups one group pass bound, which the same pass reuses in
 * the view's next frame. Each pass replaces them with the ones it used, so a
 * group that names pools or a descriptor buffer replaced since goes with the
 * next pass. Each group pass of a view keeps its own (`worker/viewResources.ts`):
 * the passes of one frame bind other colormaps and pools, and one set shared
 * between them would keep only the last pass's.
 */
export class MemberBindGroups {
  /**
   * The shared member uniform buffer the groups name. The entity reference
   * buffer grows with it, and the groups go when they do.
   */
  buffer: GPUBuffer | null = null;
  pools = new Map<string, GPUBindGroup>();
  entities = new Map<GPUBuffer, GPUBindGroup>();
}

/** What one member draw of a group pass binds. */
interface PreparedMember {
  pools: GPUBindGroup;
  entity: GPUBindGroup;
  /** The dynamic offset of the draw's block in both shared member buffers. */
  offset: number;
}

export class SliceRenderer {
  private device: GPUDevice;
  private memberPipelines: Record<BlendMode, GPURenderPipeline> | null = null;
  private aggregatePipelines: Record<BlendMode, GPURenderPipeline> | null = null;
  /** Faint white until the page sends the theme's color. */
  private tileBorderColor: RgbaColor = [1, 1, 1, 0.3];
  private pixelRatio = 1;
  /** Resolves once the three per-member and the three aggregate pipelines have compiled. See `pipelineCompile.ts`. */
  readonly compiled: Promise<void>;
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
  // Aggregate draw resources: grow-only pools rewritten every draw. No
  // bind-group caching, because descriptor buffers are rebuilt whenever
  // display settings or residency change and the draw must bind whatever
  // is current.
  private aggregateQuadBuffer: GPUBuffer | null = null;
  private aggregateQuadCapacity = 0;
  private aggregateUniformBuffers: GPUBuffer[] = [];
  // Per-draw member resources for a group pass: one block per draw index in
  // two shared buffers, each filled by one write per pass and picked by a
  // dynamic offset. The bind groups name only the buffers and the pools,
  // colormap or descriptor buffer, so every draw that binds the same ones
  // shares a group, and each group pass keeps its groups for its next frame
  // (`MemberBindGroups`): neither a pan nor a zoom that changes which members
  // draw creates any.
  private memberUniformBuffer: GPUBuffer | null = null;
  private memberEntityRefBuffer: GPUBuffer | null = null;
  private memberCapacity = 0;
  private memberUniformData = new Float32Array(0);
  private memberUniformWords = new Uint32Array(0);
  private memberRefWords = new Uint32Array(0);
  /** A number per texture or buffer a member bind group names, for its cache key. */
  private readonly resourceIds = new WeakMap<object, number>();
  private nextResourceId = 1;
  /** One view per texture, which lives as long as the texture does. */
  private textureViews = new WeakMap<GPUTexture, GPUTextureView>();

  private levelBindings: Array<SlicePoolBinding | null> = [];
  private coarseBinding: SlicePoolBinding | null = null;
  private dummyTexture: GPUTexture;
  private dummyIndirectionBuffer: GPUBuffer;
  private dummyLabelColorBuffer: GPUBuffer;
  private lutTexture: GPUTexture;
  private lutSampler: GPUSampler;

  get isCompiled(): boolean {
    return this.memberPipelines !== null && this.aggregatePipelines !== null;
  }

  constructor(device: GPUDevice) {
    this.device = device;

    const shaderModule = device.createShaderModule({ code: shaderSource });

    const levelTextureEntries: GPUBindGroupLayoutEntry[] = [];
    const levelIndirectionEntries: GPUBindGroupLayoutEntry[] = [];
    for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      levelTextureEntries.push({
        binding: 5 + i,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "uint", viewDimension: "2d" },
      });
      levelIndirectionEntries.push({
        binding: 5 + DESCRIPTOR_MAX_LEVEL_SOURCES + i,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      });
    }
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        // Dynamic, so member draws pick their block of one shared buffer.
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform", hasDynamicOffset: true },
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
        // One level pool per resident-level slot: textures at 5..8,
        // their indirection buffers at 9..12.
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
          buffer: { type: "uniform", hasDynamicOffset: true },
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

    // One pipeline per blend mode for each entry point, with the compositor's
    // exact blend states (premultiplied output), so draws sharing a target
    // combine like separate layers of that mode. Outside its footprint a
    // member writes transparent, which every mode leaves unchanged.
    const blends = LAYER_BLENDS;
    const makePipelines = (layout: GPUPipelineLayout, vertex: string, fragment: string) =>
      Promise.all((["alpha", "additive", "max"] as const).map((mode) => device.createRenderPipelineAsync({
        layout,
        vertex: { module: shaderModule, entryPoint: vertex },
        fragment: { module: shaderModule, entryPoint: fragment, targets: [{ format: OFFSCREEN_FORMAT, blend: blends[mode] }] },
        primitive: { topology: "triangle-list" },
      }))).then(([alpha, additive, max]) => ({ alpha, additive, max }));

    const memberPipelines = makePipelines(
      device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout, this.descriptorBindGroupLayout] }),
      "vs",
      "fs",
    ).then((pipelines) => {
      this.memberPipelines = pipelines;
    });
    // Overlapping members in different aggregate batches blend in batch order
    // rather than roster order, and the aggregate sits beneath the members.
    const aggregatePipelines = makePipelines(
      device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout, this.aggregateBindGroupLayout] }),
      "vsAggregate",
      "fsAggregate",
    ).then((pipelines) => {
      this.aggregatePipelines = pipelines;
    });
    this.compiled = Promise.all([memberPipelines, aggregatePipelines]).then(() => undefined);

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

  /**
   * Set the declared-label-palette storage buffer for the next categorical
   * draw ([id, packedRgba] pairs). Pass `null` for intensity draws; a
   * dummy keeps the layout satisfied.
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

  private viewOf(texture: GPUTexture): GPUTextureView {
    let view = this.textureViews.get(texture);
    if (!view) {
      view = texture.createView();
      this.textureViews.set(texture, view);
    }
    return view;
  }

  /** The group-0 bind group entries for one set of pool bindings. */
  private poolBindGroupEntries(
    uniform: GPUBufferBinding,
    levels: ReadonlyArray<SlicePoolBinding | null>,
    coarse: SlicePoolBinding | null,
    lut: GPUTexture = this.lutTexture,
  ): GPUBindGroupEntry[] {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: uniform },
      { binding: 1, resource: this.viewOf(lut) },
      { binding: 2, resource: this.lutSampler },
      { binding: 3, resource: this.viewOf(coarse?.texture ?? this.dummyTexture) },
      { binding: 4, resource: { buffer: coarse?.indirectionBuf ?? this.dummyIndirectionBuffer } },
    ];
    for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      const b = levels[i] ?? null;
      entries.push({ binding: 5 + i, resource: this.viewOf(b?.texture ?? this.dummyTexture) });
      entries.push({
        binding: 5 + DESCRIPTOR_MAX_LEVEL_SOURCES + i,
        resource: { buffer: b?.indirectionBuf ?? this.dummyIndirectionBuffer },
      });
    }
    return entries;
  }

  private rebuildBindGroup() {
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: this.poolBindGroupEntries(
        { buffer: this.uniformBuffer },
        this.levelBindings,
        this.coarseBinding,
      ),
    });
  }

  /** Place the next per-member draw: `placement` on a target `canvasW × canvasH`. */
  setTransform(placement: SliceLayerPlacement, canvasW: number, canvasH: number) {
    const uniformData = buildSliceUniformData(
      placement, canvasW, canvasH,
      levelSlotDimsOf(this.levelBindings),
      this.coarseBinding ? [this.coarseBinding.slotsX, this.coarseBinding.slotsY] : [0, 0],
      this.tileBorderColor,
      this.pixelRatio,
    );
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  /** Render-target pixels per CSS pixel, from the next draw on. */
  setPixelRatio(ratio: number) {
    this.pixelRatio = ratio;
  }

  /** The member footprint border, from the next draw on. */
  setTileBorderColor(color: RgbaColor) {
    this.tileBorderColor = color;
  }

  /**
   * Draw the one member the setters bound into a cleared target. `timing`
   * stamps the pass for the trace's GPU pass time; viewport frames pass it,
   * the minimap does not.
   */
  renderTo(target: GPUTextureView, encoder: GPUCommandEncoder, timing?: PassTiming) {
    if (!this.bindGroup || !this.descriptorBindGroup) return;
    // Over a cleared target, alpha blending writes the draw unchanged.
    const pipeline = requireCompiled(this.memberPipelines, "slice renderer").alpha;

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      timestampWrites: timing?.nextPass(),
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindGroup, [0]);
    pass.setBindGroup(1, this.descriptorBindGroup, [0]);
    pass.draw(3);
    pass.end();
  }

  /**
   * Draw one (dataset, channel)'s layers into a cleared target in one render
   * pass: the aggregate's quads first, one instanced draw per pool-binding
   * batch, then each member clipped to its footprint. Every draw binds its
   * own pools, colormap, and entity, so each samples what a pass of its own
   * would have. `kept` holds the member bind groups this pass bound in the
   * view's last frame, and takes the ones it binds now.
   */
  renderLayerGroup(
    target: GPUTextureView,
    encoder: GPUCommandEncoder,
    group: LayerGroupDraw,
    kept: MemberBindGroups,
    timing?: PassTiming,
  ) {
    const aggregate = group.aggregate && group.aggregate.batches.length > 0 && group.aggregate.quadData.byteLength > 0
      ? this.prepareAggregate(group.aggregate, group.canvasW, group.canvasH)
      : null;
    const members = this.prepareMembers(group.members, group.canvasW, group.canvasH, kept);
    if (!aggregate && members.length === 0) return;
    const memberPipeline = requireCompiled(this.memberPipelines, "slice renderer")[group.blendMode];
    const aggregatePipeline = requireCompiled(this.aggregatePipelines, "slice renderer")[group.blendMode];

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      timestampWrites: timing?.nextPass(),
    });
    if (aggregate) {
      pass.setPipeline(aggregatePipeline);
      pass.setBindGroup(1, aggregate.quadBindGroup);
      aggregate.batches.forEach((batch, i) => {
        if (batch.count <= 0) return;
        pass.setBindGroup(0, aggregate.batchBindGroups[i], [0]);
        // `firstInstance` addresses the batch's contiguous run inside the
        // shared quad buffer (instance_index includes the offset).
        pass.draw(6, batch.count, 0, batch.firstInstance);
      });
    }
    if (members.length > 0) pass.setPipeline(memberPipeline);
    group.members.forEach((draw, i) => {
      const [x, y, w, h] = draw.scissor;
      pass.setScissorRect(x, y, w, h);
      pass.setBindGroup(0, members[i].pools, [members[i].offset]);
      pass.setBindGroup(1, members[i].entity, [members[i].offset]);
      pass.draw(3);
    });
    pass.end();
  }

  /**
   * The bind groups and block offset each member draw of a group pass binds,
   * with every member's uniforms and entity reference written to its block of
   * the shared buffers. A group `kept` holds is reused, and `kept` is left
   * holding the groups this pass binds.
   */
  private prepareMembers(
    draws: readonly MemberDraw[],
    canvasW: number,
    canvasH: number,
    kept: MemberBindGroups,
  ): PreparedMember[] {
    if (draws.length === 0) return [];
    this.ensureMemberCapacity(draws.length);
    if (kept.buffer !== this.memberUniformBuffer) {
      kept.pools.clear();
      kept.entities.clear();
      kept.buffer = this.memberUniformBuffer;
    }
    const f32 = this.memberUniformData;
    const u32 = this.memberUniformWords;
    const refs = this.memberRefWords;
    const words = MEMBER_BLOCK_STRIDE / 4;
    draws.forEach((draw, i) => {
      writeSliceUniformData(
        f32, u32, i * words,
        draw.placement, canvasW, canvasH,
        levelSlotDimsOf(draw.levels),
        draw.coarse ? [draw.coarse.slotsX, draw.coarse.slotsY] : [0, 0],
        this.tileBorderColor,
        this.pixelRatio,
      );
      // Intensity draws carry no declared palette: count 0 over the dummy.
      refs[i * words] = draw.entityIndex >>> 0;
      refs[i * words + 1] = 0;
    });
    const bytes = draws.length * MEMBER_BLOCK_STRIDE;
    this.device.queue.writeBuffer(this.memberUniformBuffer!, 0, f32.buffer, 0, bytes);
    this.device.queue.writeBuffer(this.memberEntityRefBuffer!, 0, refs.buffer, 0, bytes);

    const poolGroupsUsed = new Map<string, GPUBindGroup>();
    const entityGroupsUsed = new Map<GPUBuffer, GPUBindGroup>();
    const prepared = draws.map((draw, i) => {
      const poolKey = this.poolGroupKey(draw);
      let pools = poolGroupsUsed.get(poolKey) ?? kept.pools.get(poolKey);
      if (!pools) {
        pools = this.device.createBindGroup({
          layout: this.bindGroupLayout,
          entries: this.poolBindGroupEntries(
            { buffer: this.memberUniformBuffer!, size: SLICE_UNIFORM_SIZE },
            draw.levels, draw.coarse, draw.colormap,
          ),
        });
      }
      poolGroupsUsed.set(poolKey, pools);

      let entity = entityGroupsUsed.get(draw.descriptorBuffer) ?? kept.entities.get(draw.descriptorBuffer);
      if (!entity) {
        entity = this.device.createBindGroup({
          layout: this.descriptorBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: draw.descriptorBuffer } },
            { binding: 1, resource: { buffer: this.memberEntityRefBuffer!, size: ENTITY_REF_SIZE } },
            { binding: 2, resource: { buffer: this.dummyLabelColorBuffer } },
          ],
        });
      }
      entityGroupsUsed.set(draw.descriptorBuffer, entity);
      return { pools, entity, offset: i * MEMBER_BLOCK_STRIDE };
    });
    // A group this pass left out names pools or a descriptor buffer that
    // may since have been replaced, so it is not kept.
    kept.pools = poolGroupsUsed;
    kept.entities = entityGroupsUsed;
    return prepared;
  }

  /**
   * Grow the shared member buffers to hold `count` blocks. The bind groups
   * each pass kept name the old buffers, and a pass drops them when it sees
   * the new ones.
   */
  private ensureMemberCapacity(count: number): void {
    if (count <= this.memberCapacity) return;
    const capacity = Math.max(count, this.memberCapacity * 2, 64);
    this.memberUniformBuffer?.destroy();
    this.memberEntityRefBuffer?.destroy();
    const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.memberUniformBuffer = this.device.createBuffer({ size: capacity * MEMBER_BLOCK_STRIDE, usage });
    this.memberEntityRefBuffer = this.device.createBuffer({ size: capacity * MEMBER_BLOCK_STRIDE, usage });
    this.memberUniformData = new Float32Array(capacity * MEMBER_BLOCK_STRIDE / 4);
    this.memberUniformWords = new Uint32Array(this.memberUniformData.buffer);
    this.memberRefWords = new Uint32Array(capacity * MEMBER_BLOCK_STRIDE / 4);
    this.memberCapacity = capacity;
  }

  private resourceId(resource: object): number {
    let id = this.resourceIds.get(resource);
    if (id === undefined) {
      id = this.nextResourceId++;
      this.resourceIds.set(resource, id);
    }
    return id;
  }

  /** Names every resource a member draw's group-0 bind group binds besides the shared uniform buffer. */
  private poolGroupKey(draw: MemberDraw): string {
    const id = (r: object | null | undefined) => (r ? this.resourceId(r) : 0);
    let key = `${id(draw.colormap)}|${id(draw.coarse?.texture)}|${id(draw.coarse?.indirectionBuf)}`;
    for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      const b = draw.levels[i] ?? null;
      key += `|${id(b?.texture)}|${id(b?.indirectionBuf)}`;
    }
    return key;
  }

  /**
   * The bind groups an aggregate's batches bind. Each batch binds its
   * members' own pools, so every quad samples what the per-member draw would
   * have bound for it.
   */
  private prepareAggregate(
    params: AggregateDrawParams,
    canvasW: number,
    canvasH: number,
  ): { quadBindGroup: GPUBindGroup; batchBindGroups: GPUBindGroup[]; batches: AggregateBatch[] } {
    const { batches, quadData } = params;
    if (!this.aggregateQuadBuffer || this.aggregateQuadCapacity < quadData.byteLength) {
      this.aggregateQuadBuffer?.destroy();
      this.aggregateQuadBuffer = this.device.createBuffer({
        size: quadData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.aggregateQuadCapacity = quadData.byteLength;
    }
    this.device.queue.writeBuffer(this.aggregateQuadBuffer, 0, quadData);

    // Built fresh so the current descriptor buffer is bound even when a
    // cold-state rebuild replaced the buffer object since the last frame.
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
        params.placement, canvasW, canvasH,
        levelSlotDimsOf(batch.levels),
        batch.coarse ? [batch.coarse.slotsX, batch.coarse.slotsY] : [0, 0],
        this.tileBorderColor,
        this.pixelRatio,
      );
      this.device.queue.writeBuffer(this.aggregateUniformBuffers[i], 0, uniformData);
      return this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: this.poolBindGroupEntries(
          { buffer: this.aggregateUniformBuffers[i] },
          batch.levels,
          batch.coarse,
          params.colormap,
        ),
      });
    });
    return { quadBindGroup, batchBindGroups, batches };
  }
}
