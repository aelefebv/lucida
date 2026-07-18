/** WebGPU pipeline for volume ray marching. */
import shaderSource from "./volume.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";
import { DESCRIPTOR_ENTRY_SIZE } from "./descriptorBuffer.ts";
import { serializeTransientDescriptor } from "./descriptor/transient.ts";
import type { GpuResourceBudget, TrackedGpuResource } from "./gpuResourceBudget.ts";

import type { LodIndirectionMeta } from "./volume/atlas.ts";

// Uniform buffer layout (256 bytes):
//   offset 0:   invViewProj     mat4x4f   (64B)
//   offset 64:  cameraPos       vec4f     (16B)
//   offset 80:  volumeDims      vec4f     (16B)
//   offset 96:  stepInfo        vec4f     (16B) — x=opacityScale, y=stepSize, z=renderMode
//   offset 112: detailAtlasSlotDims vec4u (16B)
//   offset 128: coarseAtlasSlotDims vec4u (16B)
//   offset 144: viewProj        mat4x4f   (64B)
//   offset 208: camForward      vec4f     (16B)
//   offset 224: clipParams      vec4f     (16B)
//   offset 240: lodParams       vec4u     (16B) — x=targetLodIdx
const UNIFORM_SIZE = 256;

/** 16-byte uniform with the entity index for the current draw. */
const ENTITY_REF_SIZE = 16;

export class VolumeRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
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
  /** Single-entity descriptor used by minimap + other call sites that
   *  aren't backed by cold-state. Lazily allocated. */
  private transientDescriptorBuffer: GPUBuffer | null = null;
  private transientDescriptorAllocation: TrackedGpuResource<GPUBuffer> | null = null;
  private volumeDims = [1, 1, 1];
  private renderMode = 0;
  private invViewProj: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private eyePos: Float32Array<ArrayBufferLike> = new Float32Array(3);
  private detailAtlasSlotDims: [number, number, number] = [0, 0, 0];
  private coarseAtlasSlotDims: [number, number, number] = [0, 0, 0];
  private viewProj: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private camForward: Float32Array<ArrayBufferLike> = new Float32Array(3);
  private clipDistance = 0;
  private clipMode = 0; // 0=plane, 1=sphere
  private singleSlotIndirectionBuf: GPUBuffer | null = null;
  private singleSlotIndirectionAllocation: TrackedGpuResource<GPUBuffer> | null = null;
  private lutTexture: GPUTexture;
  private lutSampler: GPUSampler;
  private uniformAllocation!: TrackedGpuResource<GPUBuffer>;
  private entityRefAllocation!: TrackedGpuResource<GPUBuffer>;
  private dummyLabelColorAllocation!: TrackedGpuResource<GPUBuffer>;
  private lutAllocation!: TrackedGpuResource<GPUTexture>;
  private readonly resources: GpuResourceBudget;

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
          texture: { sampleType: "uint", viewDimension: "3d" },
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
          texture: { sampleType: "uint", viewDimension: "3d" },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
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

    this.pipeline = device.createRenderPipeline({
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
    });

    try {
      this.uniformAllocation = resources.createBuffer(
        device,
        { key: "renderer:volume:uniform", kind: "buffer" },
        { size: UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST },
      );
      this.uniformBuffer = this.uniformAllocation.resource;

      this.entityRefAllocation = resources.createBuffer(
        device,
        { key: "renderer:volume:entity-ref", kind: "buffer" },
        { size: ENTITY_REF_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST },
      );
      this.entityRefBuffer = this.entityRefAllocation.resource;

      this.dummyLabelColorAllocation = resources.createBuffer(
        device,
        { key: "renderer:volume:dummy-label-color", kind: "buffer" },
        { size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST },
      );
      this.dummyLabelColorBuffer = this.dummyLabelColorAllocation.resource;
      device.queue.writeBuffer(this.dummyLabelColorBuffer, 0, new Uint32Array([0]));

      this.lutAllocation = resources.createTexture(
        device,
        { key: "renderer:volume:default-lut", kind: "lookup" },
        {
          size: [1, 1],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        },
      );
      this.lutTexture = this.lutAllocation.resource;
    } catch (error) {
      resources.destroyOwnerPrefix("renderer:volume:");
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
    // Bind group will be rebuilt on the next setAtlas call
  }

  setAtlas(
    texture: GPUTexture,
    indirectionBuf: GPUBuffer,
    atlasSlotDims: [number, number, number],
    volumeDims: [number, number, number],
    _lodMetas?: LodIndirectionMeta[],
  ) {
    this.setTierAtlases(
      texture,
      indirectionBuf,
      atlasSlotDims,
      null,
      null,
      [0, 0, 0],
      volumeDims,
    );
  }

  setTierAtlases(
    detailTexture: GPUTexture,
    detailIndirectionBuf: GPUBuffer,
    detailAtlasSlotDims: [number, number, number],
    coarseTexture: GPUTexture | null,
    coarseIndirectionBuf: GPUBuffer | null,
    coarseAtlasSlotDims: [number, number, number],
    volumeDims: [number, number, number],
  ) {
    this.volumeDims = volumeDims;
    this.detailAtlasSlotDims = detailAtlasSlotDims;
    this.coarseAtlasSlotDims = coarseTexture && coarseIndirectionBuf ? coarseAtlasSlotDims : [0, 0, 0];
    const coarseBindingTexture = coarseTexture ?? detailTexture;
    const coarseBindingIndirection = coarseIndirectionBuf ?? detailIndirectionBuf;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: detailTexture.createView() },
        { binding: 2, resource: { buffer: detailIndirectionBuf } },
        { binding: 3, resource: this.lutTexture.createView() },
        { binding: 4, resource: this.lutSampler },
        { binding: 5, resource: coarseBindingTexture.createView() },
        { binding: 6, resource: { buffer: coarseBindingIndirection } },
      ],
    });
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
   * Bind the per-dataset entity descriptor buffer and write the entity
   * index (and, for categorical label draws, the declared-palette count)
   * for the next draw. Rebuilds the descriptor bind group if the descriptor
   * or label-palette buffer pointer changed (cold-state churn → buffer
   * recreated; label vs. intensity draw → palette swapped).
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
   * Bind a single-entity transient descriptor for callers that don't
   * have a cold-state-backed descriptor buffer (minimap path). Writes
   * `modelMatrix` + `invModelMatrix` and one LOD slot covering the
   * full volume.
   *
   * Callers also pass display state (contrast/gamma/opacity) since the
   * shader reads it from the descriptor. Minimap supplies its own
   * values so the contrast slider still affects the minimap.
   */
  setTransientDescriptor(
    modelMatrix: Float32Array,
    invModelMatrix: Float32Array,
    volumeDims: [number, number, number],
    contrastMin: number,
    contrastMax: number,
    gamma: number,
    opacity: number,
  ) {
    if (!this.transientDescriptorBuffer) {
      this.transientDescriptorAllocation = this.resources.createBuffer(
        this.device,
        { key: "renderer:volume:transient-descriptor", kind: "descriptor" },
        { size: DESCRIPTOR_ENTRY_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST },
      );
      this.transientDescriptorBuffer = this.transientDescriptorAllocation.resource;
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
    });
    this.device.queue.writeBuffer(this.transientDescriptorBuffer, 0, cpu);
    // The minimap/thumbnail path is intensity-only; bind the dummy palette
    // so a prior label draw's (possibly freed) palette buffer can't leak in.
    this.setLabelColorBuffer(null);
    this.setDescriptorBinding(this.transientDescriptorBuffer, 0);
  }

  /** Wrap a monolithic texture as a single-slot atlas (used by minimap). */
  setVolume(texture: GPUTexture, width: number, height: number, depth: number) {
    if (!this.singleSlotIndirectionBuf) {
      const data = new Uint32Array([0]);
      this.singleSlotIndirectionAllocation = this.resources.createBuffer(
        this.device,
        { key: "renderer:volume:single-slot-indirection", kind: "buffer" },
        { size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST },
      );
      this.singleSlotIndirectionBuf = this.singleSlotIndirectionAllocation.resource;
      this.device.queue.writeBuffer(this.singleSlotIndirectionBuf, 0, data);
    }
    this.setAtlas(texture, this.singleSlotIndirectionBuf,
      [1, 1, 1], [width, height, depth]);
  }

  setRenderMode(mode: number) {
    this.renderMode = mode;
  }

  /**
   * Per-frame matrices. Model + invModel moved into the descriptor
   * buffer; this only carries view-projection / eye / clip params.
   */
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
  private transientDepthAllocation: TrackedGpuResource<GPUTexture> | null = null;
  private transientDepthW = 0;
  private transientDepthH = 0;

  private getTransientDepth(w: number, h: number): GPUTextureView {
    if (this.transientDepthTex && this.transientDepthW === w && this.transientDepthH === h) {
      return this.transientDepthTex.createView();
    }
    this.transientDepthAllocation?.destroy();
    this.transientDepthAllocation = this.resources.createTexture(
      this.device,
      { key: "renderer:volume:transient-depth", kind: "depth" },
      {
        size: [w, h], format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      },
    );
    this.transientDepthTex = this.transientDepthAllocation.resource;
    this.transientDepthW = w;
    this.transientDepthH = h;
    return this.transientDepthTex.createView();
  }

  renderTo(target: GPUTextureView, encoder: GPUCommandEncoder, depthView?: GPUTextureView, isFirstLayer?: boolean, targetWidth?: number, targetHeight?: number, scissorRect?: [number, number, number, number]) {
    if (!this.bindGroup || !this.descriptorBindGroup) return;

    // Compute step size based on volume dimensions
    const maxDim = Math.max(...this.volumeDims);
    const stepSize = 1.0 / (maxDim * 1.5);

    const uniformData = new Float32Array(UNIFORM_SIZE / 4);
    uniformData.set(this.invViewProj, 0);                       // mat4 at offset 0
    uniformData.set([this.eyePos[0], this.eyePos[1], this.eyePos[2], 0], 16); // cameraPos at 64B = 16 floats
    uniformData.set([this.volumeDims[0], this.volumeDims[1], this.volumeDims[2], 0], 20); // volumeDims at 80B = 20 floats
    // stepInfo = (opacityScale, stepSize, renderMode, _). Per-entity
    // contrast/gamma/opacity moved into the descriptor buffer.
    uniformData.set([0.08, stepSize, this.renderMode, 0], 24); // stepInfo at 96B = 24 floats

    // Atlas slot dims (u32 written via Uint32Array view)
    const u32View = new Uint32Array(uniformData.buffer);
    u32View.set([this.detailAtlasSlotDims[0], this.detailAtlasSlotDims[1], this.detailAtlasSlotDims[2], 0], 28);
    u32View.set([this.coarseAtlasSlotDims[0], this.coarseAtlasSlotDims[1], this.coarseAtlasSlotDims[2], 0], 32);

    // viewProj at 144B = 36 floats
    uniformData.set(this.viewProj, 36);

    // camForward at 208B = 52 floats
    uniformData.set([this.camForward[0], this.camForward[1], this.camForward[2], 0], 52);

    // clipParams at 224B = 56 floats
    uniformData.set([this.clipDistance, this.clipMode, 0, 0], 56);

    // lodParams.x = targetLodIdx (always 0 — descriptor lods are
    // already trimmed to start at finest LOD). lodCount comes from
    // descriptor.
    u32View.set([0, 0, 0, 0], 60); // lodParams at 240B = 60 u32s

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
    };

    const pass = encoder.beginRenderPass(desc);
    if (scissorRect) {
      pass.setScissorRect(scissorRect[0], scissorRect[1], scissorRect[2], scissorRect[3]);
    }
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setBindGroup(1, this.descriptorBindGroup);
    pass.draw(3); // full-screen triangle
    pass.end();
  }

  destroy(): void {
    this.resources.destroyOwnerPrefix("renderer:volume:");
    this.transientDescriptorAllocation = null;
    this.transientDescriptorBuffer = null;
    this.singleSlotIndirectionAllocation = null;
    this.singleSlotIndirectionBuf = null;
    this.transientDepthAllocation = null;
    this.transientDepthTex = null;
  }
}
