/** WebGPU pipeline for volume ray marching. */
import shaderSource from "./volume.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";
import { DESCRIPTOR_ENTRY_SIZE, DESCRIPTOR_MAX_LEVEL_SOURCES } from "./descriptor/layout.ts";
import { serializeTransientDescriptor, type TransientDescriptorParams } from "./descriptor/transient.ts";
import type { PassTiming } from "./passTiming.ts";
import { requireCompiled } from "./pipelineCompile.ts";
import type { SampleFormat } from "./dataTypeUtil.ts";

/**
 * Byte offsets of the shader's `Uniforms` fields (volume.wgsl). The
 * writer in {@link VolumeRenderer.renderTo} and descriptor/layout.test.ts
 * both read this table, so a reordered struct fails the test instead of
 * skewing the draw.
 */
export const VOLUME_UNIFORM_OFFSETS = {
  invViewProj: 0,           // mat4x4f (64B)
  cameraPos: 64,            // vec4f (16B)
  stepInfo: 80,             // vec4f (16B) — x=opacityScale, y=renderMode, z=pixelRatio
  levelAtlasSlotDims: 96,   // array<vec4u, 4> (64B) — xyz=slots per axis per level pool binding
  coarseAtlasSlotDims: 160, // vec4u (16B)
  viewProj: 176,            // mat4x4f (64B)
  camForward: 240,          // vec4f (16B)
  clipParams: 256,          // vec4f (16B)
} as const;
export const VOLUME_UNIFORM_SIZE = 272;

/** 16-byte uniform with the entity index for the current draw. */
const ENTITY_REF_SIZE = 16;

/** One chunk pool bound to a volume draw: its atlas texture, indirection buffer, and slot grid. */
export interface VolumePoolBinding {
  texture: GPUTexture;
  indirectionBuf: GPUBuffer;
  slotsX: number;
  slotsY: number;
  slotsZ: number;
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
  /** Single-entity descriptor used by minimap + other call sites that
   *  aren't backed by cold-state. Lazily allocated. */
  private transientDescriptorBuffer: GPUBuffer | null = null;
  private renderMode = 0;
  private pixelRatio = 1;
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
          buffer: { type: "uniform" },
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

  /**
   * Bind a single-entity descriptor for callers with no cold-state
   * descriptor buffer (the minimap). The caller passes display state so
   * the contrast slider still affects the minimap.
   */
  setTransientDescriptor(
    modelMatrix: Float32Array,
    invModelMatrix: Float32Array,
    volumeDims: [number, number, number],
    contrastMin: number,
    contrastMax: number,
    gamma: number,
    opacity: number,
    sampleFormat: SampleFormat,
    chunkGrid?: TransientDescriptorParams["chunkGrid"],
  ) {
    if (!this.transientDescriptorBuffer) {
      this.transientDescriptorBuffer = this.device.createBuffer({
        size: DESCRIPTOR_ENTRY_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    const cpu = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
    serializeTransientDescriptor(cpu, {
      modelMatrix,
      invModelMatrix,
      volumeDims,
      contrastMin,
      contrastMax,
      gamma,
      opacity,
      sampleFormat,
      chunkGrid,
    });
    this.device.queue.writeBuffer(this.transientDescriptorBuffer, 0, cpu);
    // The minimap/thumbnail path is intensity-only; bind the dummy palette
    // so a prior label draw's (possibly freed) palette buffer can't leak in.
    this.setLabelColorBuffer(null);
    this.setDescriptorBinding(this.transientDescriptorBuffer, 0);
  }

  setRenderMode(mode: number) {
    this.renderMode = mode;
  }

  /** Render-target pixels per CSS pixel, from the next draw on. */
  setPixelRatio(ratio: number) {
    this.pixelRatio = ratio;
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

  private getTransientDepth(w: number, h: number): GPUTextureView {
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

    const O = VOLUME_UNIFORM_OFFSETS;
    const uniformData = new Float32Array(VOLUME_UNIFORM_SIZE / 4);
    uniformData.set(this.invViewProj, O.invViewProj / 4);
    uniformData.set([this.eyePos[0], this.eyePos[1], this.eyePos[2], 0], O.cameraPos / 4);
    // stepInfo = (opacityScale, renderMode, pixelRatio, _). The march step
    // comes from the sampled level's dims in the descriptor.
    uniformData.set([0.08, this.renderMode, this.pixelRatio, 0], O.stepInfo / 4);

    const u32View = new Uint32Array(uniformData.buffer);
    for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      const b = this.levelBindings[i] ?? null;
      u32View.set(b ? [b.slotsX, b.slotsY, b.slotsZ, 0] : [0, 0, 0, 0], O.levelAtlasSlotDims / 4 + i * 4);
    }
    const c = this.coarseBinding;
    u32View.set(c ? [c.slotsX, c.slotsY, c.slotsZ, 0] : [0, 0, 0, 0], O.coarseAtlasSlotDims / 4);

    uniformData.set(this.viewProj, O.viewProj / 4);
    uniformData.set([this.camForward[0], this.camForward[1], this.camForward[2], 0], O.camForward / 4);
    uniformData.set([this.clipDistance, this.clipMode, 0, 0], O.clipParams / 4);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    const colorAttachment: GPURenderPassColorAttachment = {
      view: target,
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };

    // Shader always writes frag_depth, so a depth attachment is required.
    // Use a transient one for callers (e.g. minimap) that don't provide their own.
    const actualDepth = depthView ?? this.getTransientDepth(targetWidth || 256, targetHeight || 256);

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
    pass.setBindGroup(0, this.bindGroup);
    pass.setBindGroup(1, this.descriptorBindGroup);
    pass.draw(3); // full-screen triangle
    pass.end();
  }
}
