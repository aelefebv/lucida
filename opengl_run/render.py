from OpenGL import GL as gl

class Renderer:
    def __init__(self):
        pass
    
    def update(self, dt: float):
        raise NotImplementedError("RenderSystem.update() must be implemented by subclasses.")
    
class Clearer(Renderer):
    def update(self, dt: float):
        gl.glClearColor(0.0, 0.0, 0.0, 1.0)
        gl.glClear(gl.GL_COLOR_BUFFER_BIT)
    