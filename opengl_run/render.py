class Renderer:
    def __init__(self):
        pass
    
    def update(self, dt: float):
        raise NotImplementedError("RenderSystem.update() must be implemented by subclasses.")