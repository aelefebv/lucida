import glfw
import OpenGL.GL as gl
import numpy as np
from pathlib import Path
import ctypes

#################
# Initialize GLFW

if not glfw.init():
    raise RuntimeError("Failed to initialize GLFW")

glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)

window = glfw.create_window(800, 600, "ModernGL Window", None, None)
if not window:
    glfw.terminate()
    raise RuntimeError("Failed to create GLFW window")

glfw.make_context_current(window)

##########################
# Compile and link shaders

def compile_shader(src, shader_type):
    shader = gl.glCreateShader(shader_type)
    gl.glShaderSource(shader, src)
    gl.glCompileShader(shader)
    
    success = gl.glGetShaderiv(shader, gl.GL_COMPILE_STATUS)
    if not success:
        info_log = gl.glGetShaderInfoLog(shader)
        gl.glDeleteShader(shader)
        raise RuntimeError(f"Shader compilation failed: {info_log.decode()}")

    return shader

def link_program(vs, fs):
    shader_program = gl.glCreateProgram()
    gl.glAttachShader(shader_program, vs)
    gl.glAttachShader(shader_program, fs)
    gl.glLinkProgram(shader_program)
    
    success = gl.glGetProgramiv(shader_program, gl.GL_LINK_STATUS)
    if not success:
        info_log = gl.glGetProgramInfoLog(shader_program)
        gl.glDeleteProgram(shader_program)
        raise RuntimeError(f"Program linking failed: {info_log.decode()}")
    
    gl.glDetachShader(shader_program, vs)
    gl.glDetachShader(shader_program, fs)
    gl.glDeleteShader(vs)
    gl.glDeleteShader(fs)
    return shader_program

shader_dir = Path(r"C:\Users\austin\GitHub\lucida\opengl_run\shaders")
vert_shader_path = shader_dir / 'vert_minimal.glsl'
vert_shader_file = open(vert_shader_path, 'r').read()
vert_shader = compile_shader(vert_shader_file, gl.GL_VERTEX_SHADER)

frag_shader_path = shader_dir / 'frag_minimal.glsl'
frag_shader_file = open(frag_shader_path, 'r').read()
frag_shader = compile_shader(frag_shader_file, gl.GL_FRAGMENT_SHADER)

shader_program_1 = link_program(vert_shader, frag_shader)


vert_shader = compile_shader(vert_shader_file, gl.GL_VERTEX_SHADER)
frag_shader_yellow_path = shader_dir / 'frag_minimal_yellow.glsl'
frag_shader_yellow_file = open(frag_shader_yellow_path, 'r').read()
frag_shader_yellow = compile_shader(frag_shader_yellow_file, gl.GL_FRAGMENT_SHADER)

shader_program_2 = link_program(vert_shader, frag_shader_yellow)

####################################
# Define vertices and create VBO/VAO

vertex1 = np.array([
    -0.5, 0.5, 0.0,
    -0.5, -0.5, 0.0, 
    -0.25, -0.5, 0.0,
], dtype=np.float32)

vertex2 = np.array([
    0.5, 0.5, 0.0,
    0.5, -0.5, 0.0,
    0.25, 0.5, 0.0,
], dtype=np.float32)

vao = gl.glGenVertexArrays(2)
vbo = gl.glGenBuffers(2)
attr_size = 3

gl.glBindVertexArray(vao[0])
gl.glBindBuffer(gl.GL_ARRAY_BUFFER, vbo[0])
gl.glBufferData(gl.GL_ARRAY_BUFFER, vertex1.nbytes, vertex1, gl.GL_STATIC_DRAW)
gl.glVertexAttribPointer(
    0,  # which attribute to modify (in this case, 'in_pos' in the shader)
    attr_size,  # size of the attribute (3 for vec3)
    gl.GL_FLOAT,  # type of the attribute
    gl.GL_FALSE,  # whether to normalize between -1 and 1
    attr_size * gl.sizeof(gl.GLfloat),  # stride. Next set of pos data is 3 floats away (since we have 3 floats per vertex)
    None,  # offset in the buffer (None means start at the beginning)
    )
gl.glEnableVertexAttribArray(0)

gl.glBindVertexArray(vao[1])
gl.glBindBuffer(gl.GL_ARRAY_BUFFER, vbo[1])
gl.glBufferData(gl.GL_ARRAY_BUFFER, vertex2.nbytes, vertex2, gl.GL_STATIC_DRAW)
gl.glVertexAttribPointer(0, attr_size, gl.GL_FLOAT, gl.GL_FALSE, attr_size * gl.sizeof(gl.GLfloat), None)
gl.glEnableVertexAttribArray(0)

# gl.glPolygonMode(gl.GL_FRONT_AND_BACK, gl.GL_LINE)

while not glfw.window_should_close(window):
    # Clear the screen
    gl.glClearColor(0.1, 0.12, 0.15, 1.0)
    gl.glClear(gl.GL_COLOR_BUFFER_BIT)
    
    # Draw the triangle
    gl.glUseProgram(shader_program_1)
    gl.glBindVertexArray(vao[0])
    gl.glDrawArrays(gl.GL_TRIANGLES, 0, len(vertex1) // attr_size)
    gl.glUseProgram(shader_program_2)
    gl.glBindVertexArray(vao[1])
    gl.glDrawArrays(gl.GL_TRIANGLES, 0, len(vertex2) // attr_size)
    
    # Swap buffers
    glfw.poll_events()
    glfw.swap_buffers(window)

glfw.terminate()
print("Window closed and context released.")
