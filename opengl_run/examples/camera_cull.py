from opengl_run.camera import Camera
from opengl_run.window import LucidaWindow
from opengl_run.shader import Shader
from opengl_run.render import Renderer, Clearer
from OpenGL import GL as gl
import numpy as np
import glfw
from pathlib import Path
import ctypes
import tifffile
from pyglm import glm
import zarr

window = LucidaWindow(1200, 1200, "Hello OpenGL")
window.renderers.append(Clearer())

# zarr_path = Path("/Users/austin/test_files/test_zarr.zarr"); shader_dir = Path("/Users/austin/GitHub/lucida/opengl_run/shaders")
zarr_path = Path(r"C:\test_files_C\test_zarr.zarr"); shader_dir = Path(r"C:\Users\austin\GitHub\lucida\opengl_run\shaders")
vs_path = shader_dir / 'texture_3d.vs'
fs_path = shader_dir / 'texture_3d_max_intensity.fs'
shader = Shader(vs_path, fs_path)

zarr_store = zarr.open_group(zarr_path, mode='r')
arr = zarr_store["ds_0"][0, 0]

class Block:
    def __init__(self, arr, slices):
        self.arr = arr
        self.slices = slices
        
    def get_block(self):
        return self.arr[*self.slices]
    
    def get_contiguous_array(self):
        im = self.get_block()
        im = np.flip(im, axis=1)
        # normalize to 0-65535 range
        im = (im - np.min(im)) / (np.max(im) - np.min(im)) * 65535
        im = im.astype(np.uint16)
        im = np.ascontiguousarray(im, dtype=np.uint16)  # ensure packed rows
        return im
    
test_block = Block(arr, (slice(0, -1), slice(0, -1), slice(0, -1)))
im = test_block.get_contiguous_array()
d, h, w = im.shape

voxel_sizes = (0.2, 0.2, 1)
phys_size = glm.vec3(float(w), float(h), float(d)) * voxel_sizes

# normalize so longest side is 1.0 in world units
scale = 1
L = max(phys_size.x, phys_size.y, phys_size.z) / scale
model_scale = phys_size / L

# base step in world units (the smallest voxel edge, normalized)
world_step = min(voxel_sizes) / L

pixel_format = gl.GL_RED
gl_type = gl.GL_UNSIGNED_SHORT
internal_format = gl.GL_R16

# Change the near value to clip anything close to the camera.

tex = gl.glGenTextures(1)
gl.glBindTexture(gl.GL_TEXTURE_3D, tex)
gl.glPixelStorei(gl.GL_UNPACK_ALIGNMENT, 1)  # ensure no padding, rows are tightly packed
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_MIN_FILTER, gl.GL_NEAREST)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_MAG_FILTER, gl.GL_NEAREST)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_WRAP_R, gl.GL_CLAMP_TO_EDGE)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_WRAP_S, gl.GL_CLAMP_TO_EDGE)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_WRAP_T, gl.GL_CLAMP_TO_EDGE)

gl.glTexImage3D(
    gl.GL_TEXTURE_3D,  # target texture
    0,  # level of detail (0 is base level, others are mipmaps)
    internal_format,  # dtype, 
    w,  # width of the texture
    h,  # height of the texture
    d, 
    0,  # border (must be 0..)
    pixel_format,  # pixel data format (number of color components), RED is 1 component
    gl_type,   # data type of the pixel data, UNSIGNED_SHORT is 2 bytes per pixel
    im  # the image data in memory
)

gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_R, gl.GL_RED)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_G, gl.GL_RED)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_B, gl.GL_RED)
gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_A, gl.GL_ONE)

gl.glBindTexture(gl.GL_TEXTURE_3D, 0)  # unbind texture

vertices = np.array([
    -1, -1, -1,  0.0, 0.0,
     1, -1, -1,  1.0, 0.0,
     1,  1, -1,  1.0, 1.0,
    -1,  1, -1,  0.0, 1.0,

    -1, -1,  1,  0.0, 0.0,
     1, -1,  1,  1.0, 0.0,
     1,  1,  1,  1.0, 1.0,
    -1,  1,  1,  0.0, 1.0,

    -1,  1,  1,  1.0, 0.0,
    -1,  1, -1,  1.0, 1.0,
    -1, -1, -1,  0.0, 1.0,
    -1, -1,  1,  0.0, 0.0,

     1,  1, -1,  1.0, 1.0,
     1, -1, -1,  0.0, 1.0,
     1, -1,  1,  0.0, 0.0,
     1,  1,  1,  1.0, 0.0,

     1, -1, -1,  1.0, 1.0,
     1, -1,  1,  1.0, 0.0,
    -1, -1,  1,  0.0, 0.0,
    -1, -1, -1,  0.0, 1.0,

     1,  1, -1,  1.0, 1.0,
     1,  1,  1,  1.0, 0.0,
    -1,  1,  1,  0.0, 0.0,
    -1,  1, -1,  0.0, 1.0
], dtype=np.float32)

indices = np.array([
    0, 1, 3,  # First triangle
    1, 2, 3,   # Second triangle

    4, 5, 7,  # Third triangle
    5, 6, 7,   # Fourth triangle
    
    8, 9, 11,  # Fifth triangle
    9, 10, 11,   # Sixth triangle
    
    12, 13, 15,  # Seventh triangle
    13, 14, 15,   # Eighth triangle
    
    16, 17, 19,  # Ninth triangle
    17, 18, 19,   # Tenth triangle
    
    20, 21, 23,  # Eleventh triangle
    21, 22, 23    # Twelfth triangle
], dtype=np.uint32)

vao = gl.glGenVertexArrays(1)
vbo = gl.glGenBuffers(1)
ebo = gl.glGenBuffers(1)

s = (3, 2)  # Sizes of each attribute (3 for vec3)
attributes_per_vertex = sum(s)  # Total size per vertex in floats
types = (gl.GLfloat, gl.GLfloat, gl.GLfloat)  # Type of each attribute
n = len(s)
bits_per_vertex = np.sum([s[i] * gl.sizeof(types[i]) for i in range(n)])  # Total size per vertex in bytes
vn = len(vertices) // attributes_per_vertex  # Number of vertices
offsets = [s[i] * gl.sizeof(types[i]) for i in range(n)]  # Size of each attribute in bytes
offsets_cumul = np.cumsum(offsets)  # Cumulative offsets for each attribute
# VAO
gl.glBindVertexArray(vao)

# VBO
gl.glBindBuffer(gl.GL_ARRAY_BUFFER, vbo)
gl.glBufferData(gl.GL_ARRAY_BUFFER, vertices.nbytes, vertices, gl.GL_STATIC_DRAW)

gl.glBindBuffer(gl.GL_ELEMENT_ARRAY_BUFFER, ebo)
gl.glBufferData(gl.GL_ELEMENT_ARRAY_BUFFER, indices.nbytes, indices, gl.GL_STATIC_DRAW)

gl.glVertexAttribPointer(0, s[0], gl.GL_FLOAT, gl.GL_FALSE, bits_per_vertex, ctypes.c_void_p(0))
gl.glEnableVertexAttribArray(0)

gl.glVertexAttribPointer(1, s[1], gl.GL_FLOAT, gl.GL_FALSE, bits_per_vertex, ctypes.c_void_p(int(offsets_cumul[0])))
gl.glEnableVertexAttribArray(1)


# def build_frustum_planes(camera: Camera, model: glm.mat4) -> list[glm.vec4]:
#     # plane order: left, right, bottom, top, near, far
    
#     # Clip matrix that takes MODEL space → CLIP space
#     C = camera.proj * camera.view * model
#     R = glm.transpose(C)

#     planes = [
#         R[3] + R[0],  # Left
#         R[3] - R[0],  # Right
#         R[3] + R[1],  # Bottom
#         R[3] - R[1],  # Top
#         R[3] + R[2],  # Near
#         R[3] - R[2],  # Far
#     ]
#     # Normalize (so ||n|| = 1)
#     out = []
#     for p in planes:
#         n = glm.vec3(p)
#         inv_len = 1.0 / glm.length(n)
#         out.append(glm.vec4(n * inv_len, p.w * inv_len))
#     return out

def aabb_corners_world(bmin: glm.vec3, bmax: glm.vec3, model: glm.mat4) -> list[glm.vec3]:
    corners = []
    for x in (bmin.x, bmax.x):
        for y in (bmin.y, bmax.y):
            for z in (bmin.z, bmax.z):
                corners.append(glm.vec3(model * glm.vec4(x, y, z, 1.0)))
    return corners

def box_frustum_intersect_world_corners(planes: list[glm.vec4], corners_w: list[glm.vec3]) -> bool:
    for pl_n, pl in enumerate(planes):
        n = glm.vec3(pl.x, pl.y, pl.z)
        d = pl.w
        # if ALL corners are behind the plane, the box is outside
        # if pl_n == 0:
        #     print()
        #     for c in corners_w:
        #         print(glm.dot(n, c) + d)
        if all(glm.dot(n, c) + d < 0.0 for c in corners_w):
            return False
    return True

def candidate_brick_bounds(camera: Camera, model, vol_min: glm.vec3, vol_max: glm.vec3, brick_size: glm.vec3, grid_dims: glm.ivec3):
    fmn, fmx = camera.get_aabb_in_model(model)
    # Initial quick check: if the frustum is completely outside the volume, return None
    mn = glm.max(fmn, vol_min)
    mx = glm.min(fmx, vol_max)
    if (mn.x >= mx.x) or (mn.y >= mx.y) or (mn.z >= mx.z):
        return None, None  # frustum doesn’t touch volume at all

    eps = 1e-6  # small epsilon to avoid numerical issues
    sizef = glm.vec3(brick_size)
    
    # Convert coord to brick index (inclusive)
    start = (mn - vol_min + eps) / sizef  # start in grid coords
    stop  = (mx - vol_min - eps) / sizef  # stop in grid coords
    
    bmin = glm.ivec3(glm.floor(start))
    bmax = glm.ivec3(glm.ivec3(glm.ceil(stop)) - glm.ivec3(1))  # inclusive end
    
    # Clamp to grid bounds
    lo = glm.ivec3(0)
    hi = grid_dims - glm.ivec3(1)  # inclusive end
    bmin = glm.clamp(bmin, lo, hi)
    bmax = glm.clamp(bmax, lo, hi)
    
    # empty?
    if (bmin.x > bmax.x) or (bmin.y > bmax.y) or (bmin.z > bmax.z):
        return None, None
    return bmin, bmax

def aabb_frustum_intersect(planes, bmin, bmax):
    # Center and half-extents
    c = 0.5 * (bmin + bmax)
    e = 0.5 * (bmax - bmin)
    for pl in planes:
        n = glm.vec3(pl)
        d = pl.w
        # distance from center to plane
        s = glm.dot(n, c) + d
        # projected radius of the box on the normal
        r = abs(n.x) * e.x + abs(n.y) * e.y + abs(n.z) * e.z
        if s + r < 0.0:
            return False  # completely outside
    return True

def cull_frustum_bricks(camera: Camera, model, model_scale, brick_size=64, dilation=1):
    planes = camera.frustum_clipping_planes
    
    # TODO: this should be based on all model transforms, not just scale
    vol_min = -glm.vec3(model_scale)
    vol_max = glm.vec3(model_scale)
    # if not aabb_frustum_intersect(planes, vol_min, vol_max):
    #     print("Frustum does not intersect the volume at all.")
    #     return None, None
    
    vol_span = vol_max - vol_min
    
    brick_size_vec = glm.vec3(vol_span.x * brick_size / w, 
                                vol_span.y * brick_size / h, 
                                vol_span.z * brick_size / d)
    
    grid_dims = glm.ivec3(ceil_div(w, brick_size), ceil_div(h, brick_size), ceil_div(d, brick_size))
    
    bmin, bmax = candidate_brick_bounds(window.camera, model, 
                                        vol_min, vol_max, 
                                        brick_size_vec, grid_dims)
    if bmin is None or bmax is None:
        return []
    
    bmin -= glm.ivec3(dilation)
    bmax += glm.ivec3(dilation)
    
    visible = []
    for bz in range(bmin.z, bmax.z + 1):
        for by in range(bmin.y, bmax.y + 1):
            for bx in range(bmin.x, bmax.x + 1):
                a0 = vol_min + glm.vec3(float(bx), float(by), float(bz)) * brick_size_vec
                a1 = a0 + brick_size_vec
                corners_w = aabb_corners_world(a0, a1, model)
                if box_frustum_intersect_world_corners(planes, corners_w):
                    visible.append(glm.ivec3(bx, by, bz))
    print(f"Visible bricks: {len(visible)}")
    return visible

def ceil_div(n, d): return (n + d - 1) // d

class MainRenderer(Renderer):
    def __init__(self):
        super().__init__()
        self.starting_fov = 45
        self.starting_ar = 1
        
        self.world_step = float(world_step) * 0.5
        self.density = 6.0
        self.brightness = 1.2
        
    def update(self, dt: float):
        time = glfw.get_time()
        gl.glUseProgram(shader.program)
        
        # basic GL state for volume compositing
        gl.glEnable(gl.GL_DEPTH_TEST)
        # gl.glDepthMask(gl.GL_TRUE)
        # gl.glEnable(gl.GL_BLEND)
        # gl.glBlendFunc(gl.GL_SRC_ALPHA, gl.GL_ONE_MINUS_SRC_ALPHA)
        
        shader.set_uniform("projection", window.camera.proj)
        shader.set_uniform("view", window.camera.view)
        
        
        gl.glActiveTexture(gl.GL_TEXTURE0)  # Activate texture unit 0
        
        gl.glTexImage3D(
            gl.GL_TEXTURE_3D,  # target texture
            0,  # level of detail (0 is base level, others are mipmaps)
            internal_format,  # dtype, 
            w,  # width of the texture
            h,  # height of the texture
            d, 
            0,  # border (must be 0..)
            pixel_format,  # pixel data format (number of color components), RED is 1 component
            gl_type,   # data type of the pixel data, UNSIGNED_SHORT is 2 bytes per pixel
            im  # the image data in memory
        )

        gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_R, gl.GL_RED)
        gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_G, gl.GL_RED)
        gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_B, gl.GL_RED)
        gl.glTexParameteri(gl.GL_TEXTURE_3D, gl.GL_TEXTURE_SWIZZLE_A, gl.GL_ONE)

        gl.glBindTexture(gl.GL_TEXTURE_3D, 0)  # unbind texture
        
        gl.glBindTexture(gl.GL_TEXTURE_3D, tex)
        shader.set_uniform("ourTexture", 0)
        
        # common ray-march params
        shader.set_uniform("density", float(self.density))
        shader.set_uniform("brightness", float(self.brightness))
        
        # cam_world = glm.inverse(window.camera.view) * glm.vec4(0, 0, 0, 1)
        
        gl.glBindVertexArray(vao)
        model = glm.mat4(1.0)
        # angle = 20 * i
        # model = glm.rotate(model, glm.radians(angle), glm.vec3(1, -0.7, 0.5))
        model = glm.scale(model, model_scale)
        
        visible_bricks = cull_frustum_bricks(window.camera, model, model_scale,
                                             brick_size=64, dilation=1)
        
        shader.set_uniform("model", model)
        shader.set_uniform("worldStep", float(self.world_step))
        
        cam_world_pos = window.camera.position
        cam_world_dir = window.camera.forward  # already normalized in your Camera
        # camera position in object space (you already had this):
        cam_world = glm.vec4(cam_world_pos, 1.0)

        near_pt_world = window.camera.position + window.camera.forward * window.camera.near
        far_pt_world  = window.camera.position + window.camera.forward * window.camera.far
        inv_model = glm.inverse(model)
        
        nearPointObj = glm.vec3(inv_model * glm.vec4(near_pt_world, 1.0))
        farPointObj  = glm.vec3(inv_model * glm.vec4(far_pt_world,  1.0))
        shader.set_uniform("nearPointObj", nearPointObj)
        shader.set_uniform("farPointObj",  farPointObj)
        
        cam_obj   = inv_model * cam_world
        shader.set_uniform("camPosObj", glm.vec3(cam_obj))
        
        # camera forward in object space (treat as direction: w=0)
        # use inverse(model) for world->object; for non-uniform scale, prefer mat3(transpose(inverse(model)))
        cam_plane_nrm_obj = glm.normalize(glm.mat3(glm.transpose(model)) * cam_world_dir)
        shader.set_uniform("camPlaneNrmObj", cam_plane_nrm_obj)
        
        # near distance (the same value your projection uses)
        shader.set_uniform("camNear", float(window.camera.near))
        shader.set_uniform("camFar", float(window.camera.far))
        # camera in OBJECT space for this cube (model^-1 * cam_world)
        # cam_obj = glm.inverse(model) * cam_world
        # shader.set_uniform("camPosObj", glm.vec3(cam_obj))
        
        gl.glDrawElements(gl.GL_TRIANGLES, len(indices), gl.GL_UNSIGNED_INT, None)
        
        gl.glBindVertexArray(0)
        gl.glBindTexture(gl.GL_TEXTURE_3D, 0)

window.renderers.append(MainRenderer())
window.run()
