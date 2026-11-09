/** WebGPU pipeline for volume ray marching. */
import shaderSource from "./volume.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";
import { DESCRIPTOR_ENTRY_SIZE, DESCRIPTOR_MAX_LEVEL_SOURCES } from "./descriptor/layout.ts";
import { serializeTransientDescriptor, type TransientDescriptorParams } from "./descriptor/transient.ts";
import type { PassTiming } from "./passTiming.ts";
import { requireCompiled } from "./pipelineCompile.ts";
import type { PixelRect } from "./layerBatches.ts";

/**
 * Byte offsets of the shader's `Uniforms` fields (volume.wgsl). The
 * writer in {@link VolumeRenderer.renderTo} and descriptor/layout.test.ts
 * both read this table, so a reordered struct fails the test instead of
 * skewing the draw.
 */
export const VOLUME_UNIFORM_OFFSETS = {
  invViewProj: 0,           // mat4x4f (64B)
  cameraPos: 64,            // vec4f (16B)
  stepInfo: 80,             // vec4f (16B) — x=opacityScale, y=renderMode, z=pixelRatio, w=marchStepScale
  levelAtlasSlotDims: 96,   // array<vec4u, 4> (64B) — xyz=slots per axis per level pool binding
  coarseAtlasSlotDims: 160, // vec4u (16B)
  viewProj: 176,            // mat4x4f (64B)
  camForward: 240,          // vec4f (16B)
  clipParams: 256,          // vec4f (16B)
} as const;
export const VOLUME_UNIFORM_SIZE = 272;

/** 16-byte uniform with the entity index for the current draw. */
const ENTITY_REF_SIZE = 16;

/**
 * Bytes between two blocks of a member draw set's uniform buffer, and of its
 * entity-reference buffer. A dynamic offset must be a multiple of the
 * device's `minUniformBufferOffsetAlignment`, which is at most 256 on every
 * device.
 */
const DRAW_UNIFORM_STRIDE = 512;
const DRAW_REF_STRIDE = 256;

/** One chunk pool bound to a volume draw: its atlas texture, indirection buffer, and slot grid. */
export interface VolumePoolBinding {
  texture: GPUTexture;
  indirectionBuf: GPUBuffer;
  slotsX: number;
  slotsY: number;
  slotsZ: number;
}

/** What one draw of {@link VolumeRenderer.renderMembers} binds. */
export interface VolumeMemberDraw {
  levels: ReadonlyArray<VolumePoolBinding | null>;
  coarse: VolumePoolBinding | null;
  colormap: GPUTexture;
  /** `1` for maximum intensity, `0` translucent; the renderer's current mode when absent. */
  renderMode?: number;
  descriptorBuffer: GPUBuffer;
  entityIndex: number;
  /** Where the draw lands; the whole target when absent. */
  scissor?: PixelRect;
}

/** One draw as {@link VolumeRenderer.prepareMembers} left it ready. */
interface PreparedDraw {
  pools: GPUBindGroup;
  uniformOffset: number;
  entity: GPUBindGroup;
  refOffset: number;
  scissor: PixelRect | undefined;
}

/**
 * One caller's buffers and bind groups for member draws, kept from frame to
 * frame so a camera move creates none. Each caller has its own, so the view,
 * the minimap and the thumbnails never write blocks another has yet to draw.
 */
interface MemberDrawSet {
  uniformBuffer: GPUBuffer | null;
  uniformCapacity: number;
  uniformData: Float32Array<ArrayBuffer>;
  refBuffer: GPUBuffer | null;
  refCapacity: number;
  refWords: Uint32Array<ArrayBuffer>;
  /** The entity index each reference block holds, `-1` where none was written. */
  writtenRefs: Int32Array;
  poolGroups: Map<string, GPUBindGroup>;
  entityGroups: Map<GPUBuffer, GPUBindGroup>;
  descriptorTable: GPUBuffer | null;
  descriptorCapacity: number;
  draws: PreparedDraw[];
}

export class VolumeRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  /** Resolves once the pipeline has compiled. See `pipelineCompile.ts`. */
  readonly compiled: Promise<void>;
  private uniformBuffer: GPUBuffer;
  private entityRefBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private descriptorBindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;
  private descriptorBindGroup: GPUBindGroup | null = null;
  private currentDescriptorBuffer: GPUBuffer | null = null;
  private currentLabelColorBuffer: GPUBuffer | null = null;
  private labelColorBuffer: GPUBuffer | null = null;
  private dummyLabelColorBuffer: GPUBuffer;
  private dummyTexture: GPUTexture;
  private dummyIndirectionBuffer: GPUBuffer;
  private renderMode = 0;
  private pixelRatio = 1;
  private marchStepScale = 1;
  private invViewProj: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private eyePos: Float32Array<ArrayBufferLike> = new Float32Array(3);
  private levelBindings: Array<VolumePoolBinding | null> = [];
  private coarseBinding: VolumePoolBinding | null = null;
  private viewProj: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private camForward: Float32Array<ArrayBufferLike> = new Float32Array(3);
  private clipDistance = 0;
  private clipMode = 0; // 0=plane, 1=sphere
  private lutTexture: GPUTexture;
  private lutSampler: GPUSampler;
  private readonly memberDrawSets = new Map<string, MemberDrawSet>();
  /** One view per texture, which lives as long as the texture does. */
  private readonly textureViews = new WeakMap<GPUTexture, GPUTextureView>();
  /** A number per texture or buffer a member bind group names, for its cache key. */
  private readonly resourceIds = new WeakMap<object, number>();
  private nextResourceId = 1;

  get isCompiled(): boolean {
    return this.pipeline !== null;
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
        texture: { sampleType: "uint", viewDimension: "3d" },
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
          texture: { sampleType: "uint", viewDimension: "3d" },
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

    // Per-dataset descriptor table + per-draw entity index.
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
        // for the categorical first-hit label surface. A 1-entry dummy is
        // bound for intensity draws (count 0 → the scan is a no-op).
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout, this.descriptorBindGroupLayout],
    });

    this.compiled = device.createRenderPipelineAsync({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs" },
      fragment: {
        module: shaderModule, entryPoint: "fs",
        targets: [{ format: OFFSCREEN_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "always",
      },
    }).then((pipeline) => {
      this.pipeline = pipeline;
    });

    this.uniformBuffer = device.createBuffer({
      size: VOLUME_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.entityRefBuffer = device.createBuffer({
      size: ENTITY_REF_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 1×1×1 dummy chunk texture + sentinel indirection for unbound pool
    // slots. Same r16uint format as the real atlases so the bind-group
    // layout is satisfied; the shader's slot-dims guard never reads them.
    this.dummyTexture = device.createTexture({
      size: [1, 1, 1],
      format: "r16uint",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.dummyIndirectionBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.dummyIndirectionBuffer, 0, new Uint32Array([0xFFFFFFFF]));

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
    // Bind group will be rebuilt on the next setTierAtlases call
  }

  /**
   * Bind the level pools a member's level sources name, in slot order
   * (index = the descriptor's `poolIndex`), plus the coarse pool. `null`
   * or a missing slot binds the dummy texture and sentinel indirection;
   * the shader's slot-dims guard makes such a slot read as a miss.
   */
  setTierAtlases(
    levels: ReadonlyArray<VolumePoolBinding | null>,
    coarse: VolumePoolBinding | null,
  ) {
    this.levelBindings = levels.slice(0, DESCRIPTOR_MAX_LEVEL_SOURCES);
    this.coarseBinding = coarse;
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.uniformBuffer } },
      { binding: 1, resource: this.lutTexture.createView() },
      { binding: 2, resource: this.lutSampler },
      { binding: 3, resource: (coarse?.texture ?? this.dummyTexture).createView() },
      { binding: 4, resource: { buffer: coarse?.indirectionBuf ?? this.dummyIndirectionBuffer } },
    ];
    for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      const b = this.levelBindings[i] ?? null;
      entries.push({ binding: 5 + i, resource: (b?.texture ?? this.dummyTexture).createView() });
      entries.push({
        binding: 5 + DESCRIPTOR_MAX_LEVEL_SOURCES + i,
        resource: { buffer: b?.indirectionBuf ?? this.dummyIndirectionBuffer },
      });
    }
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries,
    });
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
   * Bind the per-dataset entity descriptor buffer and write the entity
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

  setRenderMode(mode: number) {
    this.renderMode = mode;
  }

  /** Render-target pixels per CSS pixel, from the next draw on. */
  setPixelRatio(ratio: number) {
    this.pixelRatio = ratio;
  }

  /** How many of its sampled level's steps each ray-march step takes, from the next draw on. */
  setMarchStepScale(scale: number) {
    this.marchStepScale = scale;
  }

  /** Per-frame view-projection, eye, and clip params. Model matrices live in the descriptor. */
  setMatrices(
    invViewProj: Float32Array<ArrayBufferLike>,
    eye: Float32Array<ArrayBufferLike>,
    viewProj?: Float32Array<ArrayBufferLike>,
    camForward?: Float32Array<ArrayBufferLike>,
    clipDistance?: number,
    clipMode?: number,
  ) {
    this.invViewProj = invViewProj;
    this.eyePos = eye;
    if (viewProj) this.viewProj = viewProj;
    if (camForward) this.camForward = camForward;
    if (clipDistance !== undefined) this.clipDistance = clipDistance;
    if (clipMode !== undefined) this.clipMode = clipMode;
  }

  getViewProj(): Float32Array<ArrayBufferLike> {
    return this.viewProj;
  }

  private transientDepthTex: GPUTexture | null = null;
  private transientDepthW = 0;
  private transientDepthH = 0;

  /** A depth target for callers that keep no depth of their own: the shader always writes depth. */
  transientDepthView(w: number, h: number): GPUTextureView {
    if (this.transientDepthTex && this.transientDepthW === w && this.transientDepthH === h) {
      return this.transientDepthTex.createView();
    }
    this.transientDepthTex?.destroy();
    this.transientDepthTex = this.device.createTexture({
      size: [w, h], format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.transientDepthW = w;
    this.transientDepthH = h;
    return this.transientDepthTex.createView();
  }

  /** `timing` stamps the pass for the trace's GPU pass time; viewport frames pass it, the minimap does not. */
  renderTo(target: GPUTextureView, encoder: GPUCommandEncoder, depthView?: GPUTextureView, isFirstLayer?: boolean, targetWidth?: number, targetHeight?: number, scissorRect?: [number, number, number, number], timing?: PassTiming) {
    if (!this.bindGroup || !this.descriptorBindGroup) return;
    const pipeline = requireCompiled(this.pipeline, "volume renderer");

    const uniformData = new Float32Array(VOLUME_UNIFORM_SIZE / 4);
    this.writeUniformBlock(uniformData, new Uint32Array(uniformData.buffer), 0, this.renderMode, this.levelBindings, this.coarseBinding);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    const colorAttachment: GPURenderPassColorAttachment = {
      view: target,
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };

    // Shader always writes frag_depth, so a depth attachment is required.
    // Use a transient one for callers (e.g. minimap) that don't provide their own.
    const actualDepth = depthView ?? this.transientDepthView(targetWidth || 256, targetHeight || 256);

    const desc: GPURenderPassDescriptor = {
      colorAttachments: [colorAttachment],
      depthStencilAttachment: {
        view: actualDepth,
        depthLoadOp: isFirstLayer || !depthView ? "clear" : "load",
        depthStoreOp: "store",
        depthClearValue: 1.0,
      },
      timestampWrites: timing?.nextPass(),
    };

    const pass = encoder.beginRenderPass(desc);
    if (scissorRect) {
      pass.setScissorRect(scissorRect[0], scissorRect[1], scissorRect[2], scissorRect[3]);
    }
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindGroup, [0]);
    pass.setBindGroup(1, this.descriptorBindGroup, [0]);
    pass.draw(3); // full-screen triangle
    pass.end();
  }

  /**
   * Write one `Uniforms` block at float index `base` of `f32`, whose `u32`
   * view shares its buffer: the view {@link setMatrices} and
   * {@link setPixelRatio} last set, with a draw's mode and pools.
   */
  private writeUniformBlock(
    f32: Float32Array,
    u32: Uint32Array,
    base: number,
    renderMode: number,
    levels: ReadonlyArray<VolumePoolBinding | null>,
    coarse: VolumePoolBinding | null,
  ): void {
    const O = VOLUME_UNIFORM_OFFSETS;
    f32.fill(0, base, base + VOLUME_UNIFORM_SIZE / 4);
    f32.set(this.invViewProj, base + O.invViewProj / 4);
    f32.set([this.eyePos[0], this.eyePos[1], this.eyePos[2], 0], base + O.cameraPos / 4);
    // stepInfo = (opacityScale, renderMode, pixelRatio, marchStepScale). The
    // march step comes from the sampled level's dims in the descriptor.
    f32.set([0.08, renderMode, this.pixelRatio, this.marchStepScale], base + O.stepInfo / 4);
    for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      const b = levels[i] ?? null;
      u32.set(b ? [b.slotsX, b.slotsY, b.slotsZ, 0] : [0, 0, 0, 0], base + O.levelAtlasSlotDims / 4 + i * 4);
    }
    u32.set(coarse ? [coarse.slotsX, coarse.slotsY, coarse.slotsZ, 0] : [0, 0, 0, 0], base + O.coarseAtlasSlotDims / 4);
    f32.set(this.viewProj, base + O.viewProj / 4);
    f32.set([this.camForward[0], this.camForward[1], this.camForward[2], 0], base + O.camForward / 4);
    f32.set([this.clipDistance, this.clipMode, 0, 0], base + O.clipParams / 4);
  }

  private memberDrawSet(name: string): MemberDrawSet {
    let set = this.memberDrawSets.get(name);
    if (!set) {
      set = {
        uniformBuffer: null,
        uniformCapacity: 0,
        uniformData: new Float32Array(0),
        refBuffer: null,
        refCapacity: 0,
        refWords: new Uint32Array(0),
        writtenRefs: new Int32Array(0),
        poolGroups: new Map(),
        entityGroups: new Map(),
        descriptorTable: null,
        descriptorCapacity: 0,
        draws: [],
      };
      this.memberDrawSets.set(name, set);
    }
    return set;
  }

  /**
   * Write `descriptors` to the member draw set's own descriptor table, one
   * entry each in order, for draws that have no cold-state descriptor buffer.
   * Returns the table, valid until the next call for the same set.
   */
  writeDescriptorTable(setName: string, descriptors: readonly TransientDescriptorParams[]): GPUBuffer {
    const set = this.memberDrawSet(setName);
    const count = Math.max(1, descriptors.length);
    if (!set.descriptorTable || count > set.descriptorCapacity) {
      set.descriptorTable?.destroy();
      set.descriptorCapacity = Math.max(count, set.descriptorCapacity * 2, 64);
      set.descriptorTable = this.device.createBuffer({
        size: set.descriptorCapacity * DESCRIPTOR_ENTRY_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    const bytes = new ArrayBuffer(descriptors.length * DESCRIPTOR_ENTRY_SIZE);
    descriptors.forEach((params, i) => serializeTransientDescriptor(bytes, params, i * DESCRIPTOR_ENTRY_SIZE));
    if (bytes.byteLength > 0) this.device.queue.writeBuffer(set.descriptorTable, 0, bytes);
    return set.descriptorTable;
  }

  /**
   * Write every draw's uniforms and entity reference for the frame, so
   * {@link renderMembers} can draw any of them, in any passes of the same
   * submit. Draws that bind the same pools and mode share a uniform block,
   * and a bind group is made only for pools, colormap or descriptor buffer
   * the last frame did not bind.
   */
  prepareMembers(setName: string, draws: readonly VolumeMemberDraw[]): void {
    const set = this.memberDrawSet(setName);
    this.ensureMemberCapacity(set, draws.length);
    const f32 = set.uniformData;
    const u32 = new Uint32Array(f32.buffer);
    const words = DRAW_UNIFORM_STRIDE / 4;
    const blockByKey = new Map<string, number>();
    const poolGroupsUsed = new Map<string, GPUBindGroup>();
    const entityGroupsUsed = new Map<GPUBuffer, GPUBindGroup>();
    let lowRef = draws.length;
    let highRef = -1;
    set.draws = draws.map((draw, i) => {
      const renderMode = draw.renderMode ?? this.renderMode;
      const slots = (b: VolumePoolBinding | null | undefined) => (b ? `${b.slotsX},${b.slotsY},${b.slotsZ}` : "-");
      let key = `${renderMode}|${slots(draw.coarse)}`;
      for (let l = 0; l < DESCRIPTOR_MAX_LEVEL_SOURCES; l++) key += `|${slots(draw.levels[l])}`;
      let block = blockByKey.get(key);
      if (block === undefined) {
        block = blockByKey.size;
        blockByKey.set(key, block);
        this.writeUniformBlock(f32, u32, block * words, renderMode, draw.levels, draw.coarse);
      }

      set.refWords[i * (DRAW_REF_STRIDE / 4)] = draw.entityIndex >>> 0;
      if (set.writtenRefs[i] !== draw.entityIndex) {
        set.writtenRefs[i] = draw.entityIndex;
        lowRef = Math.min(lowRef, i);
        highRef = i;
      }

      const poolKey = this.poolGroupKey(draw);
      let pools = poolGroupsUsed.get(poolKey) ?? set.poolGroups.get(poolKey);
      if (!pools) {
        pools = this.device.createBindGroup({
          layout: this.bindGroupLayout,
          entries: this.poolEntries(
            { buffer: set.uniformBuffer!, size: VOLUME_UNIFORM_SIZE }, draw.colormap, draw.levels, draw.coarse,
          ),
        });
      }
      poolGroupsUsed.set(poolKey, pools);

      let entity = entityGroupsUsed.get(draw.descriptorBuffer) ?? set.entityGroups.get(draw.descriptorBuffer);
      if (!entity) {
        entity = this.device.createBindGroup({
          layout: this.descriptorBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: draw.descriptorBuffer } },
            { binding: 1, resource: { buffer: set.refBuffer!, size: ENTITY_REF_SIZE } },
            // Intensity draws carry no declared palette: count 0 over the dummy.
            { binding: 2, resource: { buffer: this.dummyLabelColorBuffer } },
          ],
        });
      }
      entityGroupsUsed.set(draw.descriptorBuffer, entity);

      return {
        pools,
        uniformOffset: block * DRAW_UNIFORM_STRIDE,
        entity,
        refOffset: i * DRAW_REF_STRIDE,
        scissor: draw.scissor,
      };
    });
    // A group this frame left out names pools or a descriptor buffer that
    // may since have been replaced, so it is not kept.
    set.poolGroups = poolGroupsUsed;
    set.entityGroups = entityGroupsUsed;
    if (blockByKey.size > 0) {
      this.device.queue.writeBuffer(set.uniformBuffer!, 0, f32.buffer, 0, blockByKey.size * DRAW_UNIFORM_STRIDE);
    }
    if (highRef >= lowRef) {
      this.device.queue.writeBuffer(
        set.refBuffer!, lowRef * DRAW_REF_STRIDE, set.refWords.buffer,
        lowRef * DRAW_REF_STRIDE, (highRef - lowRef + 1) * DRAW_REF_STRIDE,
      );
    }
  }

  /**
   * Draw the prepared draws at `indices` into `target` in one pass, each
   * clipped to its scissor. The target is cleared first, and the depth is
   * cleared or kept.
   */
  renderMembers(
    setName: string,
    indices: readonly number[],
    target: GPUTextureView,
    targetWidth: number,
    targetHeight: number,
    depthView: GPUTextureView,
    clearDepth: boolean,
    encoder: GPUCommandEncoder,
    timing?: PassTiming,
  ): void {
    const set = this.memberDrawSet(setName);
    const pipeline = requireCompiled(this.pipeline, "volume renderer");
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: clearDepth ? "clear" : "load",
        depthStoreOp: "store",
        depthClearValue: 1.0,
      },
      timestampWrites: timing?.nextPass(),
    });
    pass.setPipeline(pipeline);
    for (const index of indices) {
      const draw = set.draws[index];
      const [x, y, w, h] = draw.scissor ?? [0, 0, targetWidth, targetHeight];
      pass.setScissorRect(x, y, w, h);
      pass.setBindGroup(0, draw.pools, [draw.uniformOffset]);
      pass.setBindGroup(1, draw.entity, [draw.refOffset]);
      pass.draw(3); // full-screen triangle
    }
    pass.end();
  }

  /** Grow the set's buffers to hold `count` draws. Bind groups name the old buffers, so they go too. */
  private ensureMemberCapacity(set: MemberDrawSet, count: number): void {
    const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    if (!set.uniformBuffer || count > set.uniformCapacity) {
      set.uniformBuffer?.destroy();
      set.uniformCapacity = Math.max(count, set.uniformCapacity * 2, 64);
      set.uniformBuffer = this.device.createBuffer({ size: set.uniformCapacity * DRAW_UNIFORM_STRIDE, usage });
      set.uniformData = new Float32Array(set.uniformCapacity * DRAW_UNIFORM_STRIDE / 4);
      set.poolGroups.clear();
    }
    if (!set.refBuffer || count > set.refCapacity) {
      set.refBuffer?.destroy();
      set.refCapacity = Math.max(count, set.refCapacity * 2, 64);
      set.refBuffer = this.device.createBuffer({ size: set.refCapacity * DRAW_REF_STRIDE, usage });
      set.refWords = new Uint32Array(set.refCapacity * DRAW_REF_STRIDE / 4);
      set.writtenRefs = new Int32Array(set.refCapacity).fill(-1);
      set.entityGroups.clear();
    }
  }

  private resourceId(resource: object): number {
    let id = this.resourceIds.get(resource);
    if (id === undefined) {
      id = this.nextResourceId++;
      this.resourceIds.set(resource, id);
    }
    return id;
  }

  /** Names every resource a draw's group-0 bind group binds besides the set's uniform buffer. */
  private poolGroupKey(draw: VolumeMemberDraw): string {
    const id = (r: object | null | undefined) => (r ? this.resourceId(r) : 0);
    let key = `${id(draw.colormap)}|${id(draw.coarse?.texture)}|${id(draw.coarse?.indirectionBuf)}`;
    for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      const b = draw.levels[i] ?? null;
      key += `|${id(b?.texture)}|${id(b?.indirectionBuf)}`;
    }
    return key;
  }

  private viewOf(texture: GPUTexture): GPUTextureView {
    let view = this.textureViews.get(texture);
    if (!view) {
      view = texture.createView();
      this.textureViews.set(texture, view);
    }
    return view;
  }

  /** The group-0 entries for one draw's uniform block, colormap and pools. */
  private poolEntries(
    uniform: GPUBufferBinding,
    lut: GPUTexture,
    levels: ReadonlyArray<VolumePoolBinding | null>,
    coarse: VolumePoolBinding | null,
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
}

