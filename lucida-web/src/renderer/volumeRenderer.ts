/** WebGPU pipeline for volume ray marching. */
import shaderSource from "./volume.wgsl?raw";

// Uniform buffer layout (240 bytes used, padded to 256):
//   offset 0:   invViewProj     mat4x4f   (64B)
//   offset 64:  modelMatrix     mat4x4f   (64B)
//   offset 128: invModelMatrix  mat4x4f   (64B)
//   offset 192: cameraPos       vec4f     (16B)
//   offset 208: volumeDims      vec4f     (16B)
//   offset 224: intensityRange  vec4f     (16B)
//   offset 240: displayParams  vec4f     (16B) = 256 total
const UNIFORM_SIZE = 256;

export class VolumeRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;
  private volumeDims = [1, 1, 1];
  private intensityMin = 0;
  private intensityMax = 65535;
  private gamma = 1.0;
  private invViewProj: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private modelMatrix: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private invModelMatrix: Float32Array<ArrayBufferLike> = new Float32Array(16);
  private eyePos: Float32Array<ArrayBufferLike> = new Float32Array(3);

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat) {
    this.device = device;
    this.context = context;

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
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Default to identity
    this.modelMatrix[0] = this.modelMatrix[5] = this.modelMatrix[10] = this.modelMatrix[15] = 1;
    this.invModelMatrix[0] = this.invModelMatrix[5] = this.invModelMatrix[10] = this.invModelMatrix[15] = 1;
  }

  setVolume(texture: GPUTexture, width: number, height: number, depth: number) {
    this.volumeDims = [width, height, depth];
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: texture.createView() },
      ],
    });
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

  setMatrices(
    invViewProj: Float32Array<ArrayBufferLike>,
    model: Float32Array<ArrayBufferLike>,
    invModel: Float32Array<ArrayBufferLike>,
    eye: Float32Array<ArrayBufferLike>,
  ) {
    this.invViewProj = invViewProj;
    this.modelMatrix = model;
    this.invModelMatrix = invModel;
    this.eyePos = eye;
  }

  render() {
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
    uniformData.set([this.gamma, 0, 0, 0], 60); // displayParams at 240B = 60 floats

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
        },
      ],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3); // full-screen triangle
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }
}
