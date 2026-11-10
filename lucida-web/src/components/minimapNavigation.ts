/**
 * Moving the main view from the minimap. The minimap draws each member
 * through its model matrix and the minimap camera; input runs that mapping
 * backwards to the point under the pointer, and moves the main camera with
 * the viewport commands main-canvas input uses. A minimap gesture is then an
 * input like any other: it opens a run, records its lag, and is broadcast.
 */
import type { WasmScene } from "lucida-core";
import { applyViewportCommand } from "../applyAndSend.ts";
import type { ArcballCenterOnVoxelCommand } from "../commands.ts";
import { sliceViewSceneBounds, type SliceViewBounds, type SliceViewportMemberInput } from "../minimapPath.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { MinimapOverlayData } from "../renderLoopTypes.ts";
import type { InputKind } from "../trace/types.ts";
import { exceedsPressSlop } from "./annotationInteraction.ts";
import { SLICE_ZOOM_IN_PER_NOTCH, SLICE_ZOOM_OUT_PER_NOTCH, VOLUME_ZOOM_PER_WHEEL_DELTA } from "./inputScale.ts";
import {
  canvasRay,
  projectToCanvas,
  sliceLocalToUnit,
  sliceUnitDepth,
  transformPoint,
  unitToSliceLocal,
  type Vec3,
} from "./minimapMath.ts";
import {
  FULL_RENDER_SCALE,
  GESTURE_RESTORE_DELAY_MS,
  INTERACTION_RENDER_SCALE,
  SCALE_RESTORE_DELAY_MS,
} from "./volumeRenderScale.ts";

/** What minimap input reads of the overlay frame the minimap last drew. */
export type MinimapFrame = Pick<
  MinimapOverlayData,
  "mode" | "viewProj" | "invViewProj" | "canvasW" | "canvasH" | "currentZ" | "members"
>;

type Member = SliceViewportMemberInput;

/** An arrow key moves the view rectangle this many CSS pixels of the minimap. */
const KEY_STEP_PX = 10;

/** An arrow key pans the volume view as far as a shift drag of this many pixels on the main canvas. */
const VOLUME_KEY_PAN = 50;

/** Which way each arrow moves the view, in screen axes (Y down). */
const ARROW_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** What a press on the minimap would do, as a CSS cursor. */
export type MinimapCursor = "default" | "crosshair" | "move" | "grab" | "grabbing";

/**
 * Where a scene XY point falls on the minimap, in backing pixels, through
 * `member`'s plane at the current Z: the mapping the view rectangle is drawn
 * with.
 */
export function sceneToMinimap(frame: MinimapFrame, member: Member, sx: number, sy: number): [number, number] | null {
  const nz = sliceUnitDepth(frame.currentZ, member.depth);
  const unit = sliceLocalToUnit(sx - member.position[0], sy - member.position[1], member.width, member.height, nz);
  const [wx, wy, wz] = transformPoint(member.modelMatrix, unit[0], unit[1], unit[2]);
  return projectToCanvas(frame.viewProj, wx, wy, wz, frame.canvasW, frame.canvasH);
}

/** The ray through a backing pixel in `member`'s unit space, as its points at the near and far clip depths. */
function unitRay(frame: MinimapFrame, member: Member, px: number, py: number): { a: Vec3; b: Vec3 } | null {
  const ray = canvasRay(frame.invViewProj, px, py, frame.canvasW, frame.canvasH);
  if (!ray) return null;
  const m = member.invModelMatrix;
  return { a: transformPoint(m, ...ray.near), b: transformPoint(m, ...ray.far) };
}

/**
 * The inverse of {@link sceneToMinimap}: the scene XY under a backing pixel,
 * on `member`'s plane at the current Z, carried past the member's edges
 * where the pixel lies off it. Null when the ray runs along the plane or
 * meets it behind the camera.
 */
export function minimapToScene(frame: MinimapFrame, member: Member, px: number, py: number): [number, number] | null {
  const ray = unitRay(frame, member, px, py);
  if (!ray) return null;
  const { a, b } = ray;
  const dz = b[2] - a[2];
  if (Math.abs(dz) < 1e-9) return null;
  const t = (sliceUnitDepth(frame.currentZ, member.depth) - a[2]) / dz;
  if (t < 0) return null;
  const [lx, ly] = unitToSliceLocal(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, member.width, member.height);
  return [lx + member.position[0], ly + member.position[1]];
}

/** Squared distance from a scene point to a member's footprint, 0 inside it. */
function distanceToMember(member: Member, sx: number, sy: number): number {
  const dx = Math.max(member.position[0] - sx, 0, sx - (member.position[0] + member.width));
  const dy = Math.max(member.position[1] - sy, 0, sy - (member.position[1] + member.height));
  return dx * dx + dy * dy;
}

/** The member a scene point lies on, or the nearest one. */
function memberNear(members: readonly Member[], sx: number, sy: number): Member | null {
  let best: Member | null = null;
  let bestDistance = Infinity;
  for (const member of members) {
    const distance = distanceToMember(member, sx, sy);
    if (distance < bestDistance) {
      best = member;
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return best;
}

/**
 * The scene XY under a backing pixel and the member it lies on, or the
 * nearest member when it lies on none, whose plane a drag then follows.
 * `hint` is tried first, so a pointer that stays over one member costs one
 * ray rather than one per member.
 */
export function pickSceneAt(
  frame: MinimapFrame,
  px: number,
  py: number,
  hint: Member | null = null,
): { member: Member; scene: [number, number] } | null {
  if (hint) {
    const scene = minimapToScene(frame, hint, px, py);
    if (scene && distanceToMember(hint, scene[0], scene[1]) === 0) return { member: hint, scene };
  }
  let best: { member: Member; scene: [number, number] } | null = null;
  let bestDistance = Infinity;
  for (const member of frame.members) {
    const scene = minimapToScene(frame, member, px, py);
    if (!scene) continue;
    const distance = distanceToMember(member, scene[0], scene[1]);
    if (distance < bestDistance) {
      best = { member, scene };
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return best;
}

/** The stretch of a unit-space line from `a` (t = 0) to `b` (t = 1) inside the unit cube, from t = 0 on. */
function unitCubeSpan(a: Vec3, b: Vec3): [number, number] | null {
  let enter = 0;
  let exit = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i];
    if (Math.abs(d) < 1e-12) {
      if (a[i] < 0 || a[i] > 1) return null;
      continue;
    }
    const t0 = -a[i] / d;
    const t1 = (1 - a[i]) / d;
    enter = Math.max(enter, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
    if (enter > exit) return null;
  }
  return [enter, exit];
}

/**
 * The world point a click on the orbit minimap picks: the middle of the
 * ray's path through the first member box it enters, so the orbit turns
 * about the data under the click. Null when the ray meets no member.
 */
export function pickVolumeAt(frame: MinimapFrame, px: number, py: number): { member: Member; world: Vec3 } | null {
  const ray = canvasRay(frame.invViewProj, px, py, frame.canvasW, frame.canvasH);
  if (!ray) return null;
  let best: { member: Member; span: [number, number] } | null = null;
  for (const member of frame.members) {
    const m = member.invModelMatrix;
    const span = unitCubeSpan(transformPoint(m, ...ray.near), transformPoint(m, ...ray.far));
    if (span && (!best || span[0] < best.span[0])) best = { member, span };
  }
  if (!best) return null;
  // An affine map keeps a line's parameter, so the unit-space span is the world one.
  const t = (best.span[0] + best.span[1]) / 2;
  const { near, far } = ray;
  return {
    member: best.member,
    world: [near[0] + (far[0] - near[0]) * t, near[1] + (far[1] - near[1]) * t, near[2] + (far[2] - near[2]) * t],
  };
}

/**
 * The command that makes `world` the orbit's target. The command reads its
 * point in the voxel frame of the dataset's first member, Y down, so the
 * point is carried into that frame.
 */
export function centerOnWorldPoint(
  frame: MinimapFrame,
  datasetId: string,
  world: Vec3,
): ArcballCenterOnVoxelCommand | null {
  const first = frame.members.find((member) => member.datasetId === datasetId);
  if (!first) return null;
  const [ux, uy, uz] = transformPoint(first.invModelMatrix, ...world);
  const [x, y] = unitToSliceLocal(ux, uy, first.width, first.height);
  return { type: "arcball_center_on_voxel", dataset_id: datasetId, x, y, z: uz * first.depth };
}

function contains(bounds: SliceViewBounds, [x, y]: [number, number]): boolean {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

export interface MinimapNavigatorDeps {
  scene(): WasmScene | null;
  /** The main canvas, whose size sets how much of the scene the slice view shows. */
  canvas(): HTMLCanvasElement | null;
  loop(): Pick<RenderLoop, "markInput" | "setRenderScale"> | null;
  /** The overlay frame the minimap last drew, or null before its first. */
  frame(): MinimapFrame | null;
  emitPresence(): void;
  breakFollow(): void;
}

interface Press {
  /** Where it pressed, in minimap CSS pixels. */
  x: number;
  y: number;
  pointerType: string;
  /** The frame at the press. A drag maps through it, since a slice view's pan leaves the minimap camera alone. */
  frame: MinimapFrame;
  /** The slice member whose plane the drag follows; null in the volume view. */
  member: Member | null;
  /** The view's center less the point under the pointer, held through a drag of the view rectangle. */
  offset: [number, number];
  /** Pressed inside the view rectangle. */
  grabbed: boolean;
  /** Travelled past the click slop. */
  moved: boolean;
  last: { x: number; y: number };
}

/**
 * Turns presses, drags, wheel events and arrow keys on the minimap, in
 * minimap CSS pixels, into moves of the main view.
 *
 * In the slice view a press inside the view rectangle grabs it and a press
 * elsewhere centres the view there first, then a drag carries the
 * rectangle; the wheel zooms about the point under the pointer. In the
 * volume view a drag orbits and a click makes the picked point the orbit's
 * target.
 */
export class MinimapNavigator {
  private press: Press | null = null;
  /** The member the pointer was last over, tried first by the next pick. */
  private hint: { members: readonly Member[]; member: Member } | null = null;
  private scaleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deps: MinimapNavigatorDeps;
  /** The minimap's CSS size; the frame's canvas is the same square in backing pixels. */
  private readonly cssSize: number;

  constructor(deps: MinimapNavigatorDeps, cssSize: number) {
    this.deps = deps;
    this.cssSize = cssSize;
  }

  /** What a press at this point would do. One ray at most, so it can run on every hover move. */
  cursorAt(x: number, y: number): MinimapCursor {
    if (this.press) return this.press.member ? "move" : "grabbing";
    const target = this.target();
    if (!target) return "default";
    const { scene, frame } = target;
    if (frame.mode === "volume") return "grab";
    const member = this.hintFor(frame) ?? frame.members[0];
    const point = minimapToScene(frame, member, ...this.backing(frame, x, y));
    return point && contains(this.viewBounds(scene), point) ? "move" : "crosshair";
  }

  /** A press at a point, by a pointer of `pointerType`. Returns whether the minimap took it. */
  pressAt(x: number, y: number, pointerType: string, atMs?: number): boolean {
    this.press = null;
    const target = this.target();
    if (!target) return false;
    const { scene, frame } = target;
    const base = { x, y, pointerType, frame, offset: [0, 0] as [number, number], grabbed: false, moved: false, last: { x, y } };
    if (frame.mode === "volume") {
      this.press = { ...base, member: null };
      this.lowerScale();
      return true;
    }
    const pick = this.pick(frame, x, y);
    if (!pick) return false;
    const center = scene.center();
    const grabbed = contains(this.viewBounds(scene), pick.scene);
    this.press = {
      ...base,
      member: pick.member,
      grabbed,
      offset: grabbed ? [center[0] - pick.scene[0], center[1] - pick.scene[1]] : [0, 0],
    };
    // Elsewhere, the view goes there first and the drag carries it on.
    if (!grabbed) this.centerAt(scene, pick.scene, atMs);
    return true;
  }

  moveTo(x: number, y: number, atMs?: number): void {
    const press = this.press;
    const scene = this.deps.scene();
    if (!press || !scene) return;
    if (!press.moved) {
      if (!exceedsPressSlop(press.pointerType, press.x, press.y, x, y)) return;
      press.moved = true;
    }
    if (!press.member) {
      const dx = x - press.last.x;
      const dy = y - press.last.y;
      press.last = { x, y };
      // The same sense as a drag on the main canvas, faster for the smaller
      // surface: across the minimap is half a turn.
      const radiansPerPixel = Math.PI / this.cssSize;
      this.steer(
        () => applyViewportCommand(scene, { type: "arcball_rotate", d_theta: -dx * radiansPerPixel, d_phi: -dy * radiansPerPixel }),
        "orbit",
        atMs,
      );
      return;
    }
    const point = minimapToScene(press.frame, press.member, ...this.backing(press.frame, x, y));
    if (point) this.centerAt(scene, [point[0] + press.offset[0], point[1] + press.offset[1]], atMs);
  }

  releaseAt(x: number, y: number, atMs?: number): void {
    const press = this.press;
    this.press = null;
    const scene = this.deps.scene();
    if (!press || !scene) return;
    if (!press.member) {
      this.restoreScale(SCALE_RESTORE_DELAY_MS);
      if (press.moved) return;
      const pick = pickVolumeAt(press.frame, ...this.backing(press.frame, x, y));
      const command = pick && centerOnWorldPoint(press.frame, pick.member.datasetId, pick.world);
      if (command) this.steer(() => applyViewportCommand(scene, command), "pan", atMs);
      return;
    }
    // A click inside the view rectangle centres there too.
    if (press.moved || !press.grabbed) return;
    const point = minimapToScene(press.frame, press.member, ...this.backing(press.frame, x, y));
    if (point) this.centerAt(scene, point, atMs);
  }

  cancel(): void {
    const press = this.press;
    this.press = null;
    if (press && !press.member) this.restoreScale(SCALE_RESTORE_DELAY_MS);
  }

  /** A wheel event over a point. Returns whether it moved the view. */
  wheelAt(x: number, y: number, deltaY: number, atMs?: number): boolean {
    const target = this.target();
    if (!target || deltaY === 0) return false;
    const { scene, frame } = target;
    if (frame.mode === "volume") {
      this.lowerScale();
      this.steer(() => applyViewportCommand(scene, { type: "arcball_zoom", delta: deltaY * VOLUME_ZOOM_PER_WHEEL_DELTA }), "zoom", atMs);
      this.restoreScale(GESTURE_RESTORE_DELAY_MS);
      return true;
    }
    const pick = this.pick(frame, x, y);
    if (!pick) return false;
    const [px, py] = pick.scene;
    const factor = deltaY > 0 ? SLICE_ZOOM_OUT_PER_NOTCH : SLICE_ZOOM_IN_PER_NOTCH;
    this.steer(() => {
      const before = scene.zoom();
      const [cx, cy] = scene.center();
      applyViewportCommand(scene, { type: "zoom_by", factor });
      // The point keeps its place in the view, wherever that is.
      const k = before / scene.zoom();
      applyViewportCommand(scene, { type: "set_center", x: px + (cx - px) * k, y: py + (cy - py) * k });
    }, "zoom", atMs);
    return true;
  }

  /** A key pressed on the focused minimap. Returns whether it moved the view. */
  key(key: string, atMs?: number): boolean {
    const direction = ARROW_DIRECTIONS[key];
    const target = direction ? this.target() : null;
    if (!direction || !target) return false;
    const { scene, frame } = target;
    const [dx, dy] = direction;
    if (frame.mode === "volume") {
      // The pan's screen axes run the other way to a camera move.
      this.steer(() => applyViewportCommand(scene, { type: "arcball_pan", dx: -dx * VOLUME_KEY_PAN, dy: -dy * VOLUME_KEY_PAN }), "pan", atMs);
      return true;
    }
    const center = scene.center();
    const member = memberNear(frame.members, center[0], center[1]);
    const at = member && sceneToMinimap(frame, member, center[0], center[1]);
    if (!member || !at) return false;
    const step = (KEY_STEP_PX * frame.canvasW) / this.cssSize;
    const to = minimapToScene(frame, member, at[0] + dx * step, at[1] + dy * step);
    if (!to) return false;
    this.centerAt(scene, to, atMs);
    return true;
  }

  /**
   * The scene and the frame to map through, or null when there is nothing to
   * steer: no data, the fly camera, or a side view, whose plane the minimap
   * neither outlines nor maps.
   */
  private target(): { scene: WasmScene; frame: MinimapFrame } | null {
    const scene = this.deps.scene();
    const frame = this.deps.frame();
    if (!scene || !frame || frame.members.length === 0 || scene.camera_mode() === "fly") return null;
    if (frame.mode === "slice" && scene.slice_plane() !== "xy") return null;
    return { scene, frame };
  }

  private backing(frame: MinimapFrame, x: number, y: number): [number, number] {
    return [(x * frame.canvasW) / this.cssSize, (y * frame.canvasH) / this.cssSize];
  }

  private hintFor(frame: MinimapFrame): Member | null {
    return this.hint && this.hint.members === frame.members ? this.hint.member : null;
  }

  private pick(frame: MinimapFrame, x: number, y: number): { member: Member; scene: [number, number] } | null {
    const pick = pickSceneAt(frame, ...this.backing(frame, x, y), this.hintFor(frame));
    if (pick) this.hint = { members: frame.members, member: pick.member };
    return pick;
  }

  private viewBounds(scene: WasmScene): SliceViewBounds {
    const canvas = this.deps.canvas();
    const ratio = devicePixelRatio;
    const width = Math.round((canvas?.clientWidth ?? 0) * ratio);
    const height = Math.round((canvas?.clientHeight ?? 0) * ratio);
    return sliceViewSceneBounds(scene.center(), scene.zoom(), width, height);
  }

  private centerAt(scene: WasmScene, [x, y]: [number, number], atMs?: number): void {
    this.steer(() => applyViewportCommand(scene, { type: "set_center", x, y }), "pan", atMs);
  }

  /** Move the camera as main-canvas input does: follow breaks, peers hear of it, and the loop takes it as an input. */
  private steer(move: () => void, input: InputKind, atMs?: number): void {
    this.deps.breakFollow();
    move();
    this.deps.emitPresence();
    this.deps.loop()?.markInput(input, atMs);
  }

  private lowerScale(): void {
    if (this.scaleTimer !== null) clearTimeout(this.scaleTimer);
    this.scaleTimer = null;
    this.deps.loop()?.setRenderScale(INTERACTION_RENDER_SCALE);
  }

  private restoreScale(delayMs: number): void {
    if (this.scaleTimer !== null) clearTimeout(this.scaleTimer);
    this.scaleTimer = setTimeout(() => {
      this.scaleTimer = null;
      this.deps.loop()?.setRenderScale(FULL_RENDER_SCALE);
    }, delayMs);
  }
}
