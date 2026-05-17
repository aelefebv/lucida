/** WebGPU renderer for peer cursor crosshairs and rays. */
import shaderSource from "./cursors.wgsl?raw";

// Uniform layout: view_proj(64) + params(16) + camera_2d(16) + extra(16) = 112 bytes
const UNIFORM_SIZE = 112;
const FLOATS_PER_CURSOR = 16; // 4 × vec4f
const VERTS_PER_CURSOR = 18; // 3 quads × 6 verts
const MAX_CURSORS = 16;

export class CursorRenderer {
  private device: GPUDevice;
  private pipeline2D: GPURenderPipeline;
  private pipeline3D: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private cursorBuffer: GPUBuffer;
  private bindGroupLayout2D: GPUBindGroupLayout;
  private bindGroupLayout3D: GPUBindGroupLayout;
  private bindGroup2D: GPUBindGroup;
  private bindGroup3D: GPUBindGroup | null = null;
  private cursorCount = 0;
  private dummyDepthTex: GPUTexture;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.device = device;

    const shaderModule = device.createShaderModule({ code: shaderSource });

    const blendState: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };

    // 2D bind group: no depth texture needed
    this.bindGroupLayout2D = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      ],
    });

    // 3D uses the same layout (depth texture sampled in fragment shader)
    this.bindGroupLayout3D = this.bindGroupLayout2D;

    this.pipeline2D = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout2D] }),
      vertex: { module: shaderModule, entryPoint: "vs" },
      fragment: {
        module: shaderModule, entryPoint: "fs",
        targets: [{ format: canvasFormat, blend: blendState }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipeline3D = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout3D] }),
      vertex: { module: shaderModule, entryPoint: "vs" },
      fragment: {
        module: shaderModule, entryPoint: "fs",
        targets: [{ format: canvasFormat, blend: blendState }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.cursorBuffer = device.createBuffer({
      size: MAX_CURSORS * FLOATS_PER_CURSOR * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // 1x1 dummy depth texture for 2D mode (depth sampling not used but binding required)
    this.dummyDepthTex = device.createTexture({
      size: [1, 1],
      format: "depth24plus",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.bindGroup2D = device.createBindGroup({
      layout: this.bindGroupLayout2D,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.cursorBuffer } },
        { binding: 2, resource: this.dummyDepthTex.createView() },
      ],
    });
  }

  updateCursors(data: Float32Array, count: number): void {
    this.cursorCount = Math.min(count, MAX_CURSORS);
    if (this.cursorCount > 0) {
      // Cast: typed-array .buffer is ArrayBufferLike under TS5.4+ lib defs;
      // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app).
      this.device.queue.writeBuffer(
        this.cursorBuffer, 0,
        data as Float32Array<ArrayBuffer>, 0, this.cursorCount * FLOATS_PER_CURSOR,
      );
    }
  }

  hasData(): boolean {
    return this.cursorCount > 0;
  }

  /** Render crosshairs for 2D slice mode on top of an existing canvas. */
  renderSlice(
    target: GPUTextureView,
    encoder: GPUCommandEncoder,
    zoom: number, cx: number, cy: number,
    canvasW: number, canvasH: number,
  ): void {
    if (this.cursorCount === 0) return;

    const uniforms = new Float32Array(UNIFORM_SIZE / 4);
    uniforms[0] = 1; uniforms[5] = 1; uniforms[10] = 1; uniforms[15] = 1;
    uniforms[16] = canvasW;
    uniforms[17] = canvasH;
    uniforms[18] = 30.0; // arm length
    uniforms[19] = 4.5;  // line width
    uniforms[20] = zoom;
    uniforms[21] = cx;
    uniforms[22] = cy;
    uniforms[23] = 0; // mode = 2D
    uniforms[24] = 1.0; // opacity_scale
    uniforms[25] = 6.0; // ray_width (unused)
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target,
        loadOp: "load" as const,
        storeOp: "store" as const,
      }],
    });
    pass.setPipeline(this.pipeline2D);
    pass.setBindGroup(0, this.bindGroup2D);
    pass.draw(VERTS_PER_CURSOR, this.cursorCount);
    pass.end();
  }

  /** Render rays for 3D volume mode. Samples depth texture for opacity dimming. */
  renderVolume(
    target: GPUTextureView,
    depthView: GPUTextureView,
    encoder: GPUCommandEncoder,
    viewProj: Float32Array,
    canvasW: number, canvasH: number,
  ): void {
    if (this.cursorCount === 0) return;

    // Rebuild bind group with the current depth texture
    this.bindGroup3D = this.device.createBindGroup({
      layout: this.bindGroupLayout3D,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.cursorBuffer } },
        { binding: 2, resource: depthView },
      ],
    });

    const uniforms = new Float32Array(UNIFORM_SIZE / 4);
    uniforms.set(viewProj, 0);
    uniforms[16] = canvasW;
    uniforms[17] = canvasH;
    uniforms[18] = 18.0; // marker arm length
    uniforms[19] = 4.5;  // line width
    uniforms[23] = 1;    // mode = 3D
    uniforms[24] = 1.0;  // opacity_scale (dimming handled in shader via depth)
    uniforms[25] = 6.0;  // ray width
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target,
        loadOp: "load" as const,
        storeOp: "store" as const,
      }],
    });
    pass.setPipeline(this.pipeline3D);
    pass.setBindGroup(0, this.bindGroup3D);
    pass.draw(VERTS_PER_CURSOR, this.cursorCount);
    pass.end();
  }
}
