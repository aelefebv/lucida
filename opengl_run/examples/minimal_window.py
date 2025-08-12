import glfw
import OpenGL.GL as gl

if not glfw.init():
    raise RuntimeError("Failed to initialize GLFW")

glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)

window = glfw.create_window(800, 600, "PyOpenGL Window", None, None)
if not window:
    glfw.terminate()
    raise RuntimeError("Failed to create GLFW window")

glfw.make_context_current(window)

while not glfw.window_should_close(window):
    glfw.poll_events()
    gl.glClearColor(0.1, 0.12, 0.15, 1.0)
    gl.glClear(gl.GL_COLOR_BUFFER_BIT)
    glfw.swap_buffers(window)

glfw.terminate()
print("Window closed and context released.")
