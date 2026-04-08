/** WebGPU pipeline for volume ray marching. */
import shaderSource from "./volume.wgsl?raw";
import { OFFSCREEN_FORMAT } from "./gpuContext.ts";

// Uniform buffer layout (416 bytes):
//   offset 0:   invViewProj     mat4x4f   (64B)
//   offset 64:  modelMatrix     mat4x4f   (64B)
//   offset 128: invModelMatrix  mat4x4f   (64B)
//   offset 192: cameraPos       vec4f     (16B)
//   offset 208: volumeDims      vec4f     (16B)
//   offset 224: intensityRange  vec4f     (16B)
//   offset 240: displayParams   vec4f     (16B)
//   offset 256: fallbackDims    vec4f     (16B)
//   offset 272: chunkDims       vec4u     (16B)
//   offset 288: gridDims        vec4u     (16B)
//   offset 304: atlasSlotDims   vec4u     (16B)
//   offset 320: viewProj        mat4x4f   (64B)
//   offset 384: camForward      vec4f     (16B)
//   offset 400: clipParams      vec4f     (16B) = 416 total
const UNIFORM_SIZE = 416;

export class VolumeRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;
  private volumeDims = [1, 1, 1];
  private intensityMin = 0;
  private intensityMax = 65535;
  private gamma = 1.0;
  private opacity = 1.0;
  private renderMode = 0;
  private fallbackTexture: GPUTexture | null = null;
  private fallbackDims = [1, 1, 1];
  private hasFallback = false;
  private dummyFallbackTexture: GPUTexture | null = null;
  private invViewProj: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private modelMatrix: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private invModelMatrix: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private eyePos: Float32Array<ArrayBufferLike> = new Float32Array(3);
  private chunkDims = [1, 1, 1];
  private gridDims = [1, 1, 1];
  private atlasSlotDims = [1, 1, 1];
  private viewProj: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private camForward: Float32Array<ArrayBufferLike> = new Float32Array(3);
  private clipDistance = 0;
  private clipMode = 0; // 0=plane, 1=sphere
  private singleSlotIndirectionBuf: GPUBuffer | null = null;
  private lutTexture: GPUTexture;
  private lutSampler: GPUSampler;

  constructor(device: GPUDevice, dummyFallbackTexture: GPUTexture) {
    this.device = device;
    this.dummyFallbackTexture = dummyFallbackTexture;

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
          texture: { sampleType: "uint", viewDimension: "3d" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
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

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Default to identity
    this.modelMatrix[0] = this.modelMatrix[5] = this.modelMatrix[10] = this.modelMatrix[15] = 1;
    this.invModelMatrix[0] = this.invModelMatrix[5] = this.invModelMatrix[10] = this.invModelMatrix[15] = 1;

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
    // Bind group will be rebuilt on the next setAtlas call
  }

  setAtlas(
    texture: GPUTexture,
    indirectionBuf: GPUBuffer,
    chunkDims: [number, number, number],
    gridDims: [number, number, number],
    atlasSlotDims: [number, number, number],
    volumeDims: [number, number, number],
  ) {
    this.volumeDims = volumeDims;
    this.chunkDims = chunkDims;
    this.gridDims = gridDims;
    this.atlasSlotDims = atlasSlotDims;
    const fbTex = this.fallbackTexture ?? this.dummyFallbackTexture!;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: fbTex.createView() },
        { binding: 3, resource: { buffer: indirectionBuf } },
        { binding: 4, resource: this.lutTexture.createView() },
        { binding: 5, resource: this.lutSampler },
      ],
    });
  }

  /** Wrap a monolithic texture as a single-slot atlas (used by minimap). */
  setVolume(texture: GPUTexture, width: number, height: number, depth: number) {
    if (!this.singleSlotIndirectionBuf) {
      const data = new Uint32Array([0]);
      this.singleSlotIndirectionBuf = this.device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.singleSlotIndirectionBuf, 0, data);
    }
    this.setAtlas(texture, this.singleSlotIndirectionBuf,
      [width, height, depth], [1, 1, 1], [1, 1, 1], [width, height, depth]);
  }

  setFallbackVolume(texture: GPUTexture, w: number, h: number, d: number) {
    this.fallbackTexture = texture;
    this.fallbackDims = [w, h, d];
    this.hasFallback = true;
  }

  clearFallback() {
    this.fallbackTexture = null;
    this.hasFallback = false;
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

  setRenderMode(mode: number) {
    this.renderMode = mode;
  }

  setMatrices(
    invViewProj: Float32Array<ArrayBufferLike>,
    model: Float32Array<ArrayBufferLike>,
    invModel: Float32Array<ArrayBufferLike>,
    eye: Float32Array<ArrayBufferLike>,
    viewProj?: Float32Array<ArrayBufferLike>,
    camForward?: Float32Array<ArrayBufferLike>,
    clipDistance?: number,
    clipMode?: number,
  ) {
    this.invViewProj = invViewProj;
    this.modelMatrix = model;
    this.invModelMatrix = invModel;
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

  renderTo(target: GPUTextureView, encoder: GPUCommandEncoder, depthView?: GPUTextureView, isFirstLayer?: boolean, targetWidth?: number, targetHeight?: number) {
    if (!this.bindGroup) return;

    // Compute step size based on volume dimensions
    const maxDim = Math.max(...this.volumeDims);
    const stepSize = 1.0 / (maxDim * 1.5);

    const uniformData = new Float32Array(UNIFORM_SIZE / 4);
    uniformData.set(this.invViewProj, 0);                       // mat4 at offset 0
    uniformData.set(this.modelMatrix, 16);                      // mat4 at offset 64B = 16 floats
    uniformData.set(this.invModelMatrix, 32);                   // mat4 at offset 128B = 32 floats
    uniformData.set([this.eyePos[0], this.eyePos[1], this.eyePos[2], 0], 48); // cameraPos at 192B = 48 floats
    uniformData.set([this.volumeDims[0], this.volumeDims[1], this.volumeDims[2], 0], 52); // volumeDims at 208B = 52 floats
    uniformData.set([this.intensityMin, this.intensityMax, 0.08, stepSize], 56); // intensityRange at 224B = 56 floats
    uniformData.set([this.gamma, this.opacity, this.renderMode, 0], 60); // displayParams at 240B = 60 floats
    uniformData.set([this.fallbackDims[0], this.fallbackDims[1], this.fallbackDims[2],
                     this.hasFallback ? 1.0 : 0.0], 64); // fallbackDims at 256B = 64 floats

    // Atlas params (u32 written via Uint32Array view)
    const u32View = new Uint32Array(uniformData.buffer);
    u32View.set([this.chunkDims[0], this.chunkDims[1], this.chunkDims[2], 0], 68);   // chunkDims at 272B = 68 u32s
    u32View.set([this.gridDims[0], this.gridDims[1], this.gridDims[2], 0], 72);      // gridDims at 288B = 72 u32s
    u32View.set([this.atlasSlotDims[0], this.atlasSlotDims[1], this.atlasSlotDims[2], 0], 76); // atlasSlotDims at 304B = 76 u32s

    // viewProj at 320B = 80 floats
    uniformData.set(this.viewProj, 80);

    // camForward at 384B = 96 floats
    uniformData.set([this.camForward[0], this.camForward[1], this.camForward[2], 0], 96);

    // clipParams at 400B = 100 floats (x=clipDist, y=clipMode, z=0, w=0)
    uniformData.set([this.clipDistance, this.clipMode, 0, 0], 100);

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
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3); // full-screen triangle
    pass.end();
  }
}
