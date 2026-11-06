export const keyBindings = {
  // Fly camera movement
  "fly.forward": "w",
  "fly.left": "a",
  "fly.backward": "s",
  "fly.right": "d",
  "fly.up": "e",
  "fly.down": "q",

  // Fly camera rotation
  "fly.pitchUp": "i",
  "fly.pitchDown": "k",
  "fly.yawLeft": "j",
  "fly.yawRight": "l",
  "fly.rollLeft": "o",
  "fly.rollRight": "u",

  // Camera mode
  "camera.toggleFly": "f",

  // Clip distance
  "clip.decrease": "[",
  "clip.increase": "]",
} as const;

export type ActionName = keyof typeof keyBindings;

export function getBoundKeys(): Set<string> {
  return new Set(Object.values(keyBindings));
}

export function isActionPressed(pressedKeys: Set<string>, action: ActionName): boolean {
  return pressedKeys.has(keyBindings[action]);
}
