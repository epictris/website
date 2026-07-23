// LiveInputSource — keyboard + mouse + gamepad → FrameInput, ported from
// classes/Input/LiveInputSource.cs. Keybinds match the Godot project's input map
// (physical keys, US-QWERTY positions):
//
//   move_left R · move_right T · jump Space · retract C · extend S
//   fire left-click · retract-tug right-click · spawn 1 small / 2 large circle
//
// Gamepad (standard mapping, merged with keyboard/mouse — whichever is active wins):
//
//   left stick / dpad move · A jump · RT fire · LT retract-tug
//   RB retract · LB extend · right stick aim · X small / Y large circle
//
// Aim source follows the most recent device: moving the mouse aims with the
// cursor; deflecting the right stick aims from the player along the stick.

import { Vec2 } from "../engine/vec2";
import {
  button,
  emptyFrameInput,
  type ButtonInput,
  type FrameInput,
  type IInputSource,
} from "./frameInput";
import { screenToWorld, type Camera } from "../render/camera";

// Standard-mapping button indices (https://w3c.github.io/gamepad/#remapping).
const PAD_A = 0;
const PAD_X = 2;
const PAD_Y = 3;
const PAD_LB = 4;
const PAD_RB = 5;
const PAD_LT = 6;
const PAD_RT = 7;
const PAD_DPAD_LEFT = 14;
const PAD_DPAD_RIGHT = 15;

const MOVE_DEADZONE = 0.35; // left-stick X → digital move threshold
const AIM_DEADZONE = 0.3; // right-stick deflection before it takes over aim
const TRIGGER_THRESHOLD = 0.5; // analog trigger → digital press
const AIM_DISTANCE = 150; // world px from the player to the stick aim point

interface PadState {
  moveLeft: boolean;
  moveRight: boolean;
  jump: boolean;
  retract: boolean;
  extend: boolean;
  fire: boolean;
  retractTug: boolean;
  spawnSmall: boolean;
  spawnLarge: boolean;
  aim: Vec2 | null; // right-stick direction (normalized), null inside deadzone
}

const NO_PAD: PadState = {
  moveLeft: false,
  moveRight: false,
  jump: false,
  retract: false,
  extend: false,
  fire: false,
  retractTug: false,
  spawnSmall: false,
  spawnLarge: false,
  aim: null,
};

function pollGamepad(): PadState {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return NO_PAD;
  for (const pad of navigator.getGamepads()) {
    if (!pad || !pad.connected) continue;
    const pressed = (i: number): boolean => {
      const b = pad.buttons[i];
      return b ? b.value > TRIGGER_THRESHOLD || b.pressed : false;
    };
    const lx = pad.axes[0] ?? 0;
    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;
    const aimVec = new Vec2(rx, ry);
    return {
      moveLeft: lx < -MOVE_DEADZONE || pressed(PAD_DPAD_LEFT),
      moveRight: lx > MOVE_DEADZONE || pressed(PAD_DPAD_RIGHT),
      jump: pressed(PAD_A),
      retract: pressed(PAD_RB),
      extend: pressed(PAD_LB),
      fire: pressed(PAD_RT),
      retractTug: pressed(PAD_LT),
      spawnSmall: pressed(PAD_X),
      spawnLarge: pressed(PAD_Y),
      aim: aimVec.length() > AIM_DEADZONE ? aimVec.normalized() : null,
    };
  }
  return NO_PAD;
}

export class LiveInputSource implements IInputSource {
  private keys = new Set<string>();
  private mouseLeft = false;
  private mouseRight = false;
  private mouseScreen = new Vec2(0, 0);
  private prev: FrameInput = emptyFrameInput();
  private aimSource: "mouse" | "pad" = "mouse";
  private padAimDir = new Vec2(1, 0); // last stick aim, kept while stick is released
  private padAimWorld: Vec2 | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private aimOrigin: () => Vec2,
  ) {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseScreen = new Vec2(e.clientX - rect.left, e.clientY - rect.top);
      this.aimSource = "mouse";
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouseLeft = true;
      if (e.button === 2) this.mouseRight = true;
      this.aimSource = "mouse";
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseLeft = false;
      if (e.button === 2) this.mouseRight = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private held(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  // World-space aim point while the gamepad owns aim, for crosshair rendering.
  // Null when the mouse is the active aim source (the OS cursor shows aim).
  gamepadAim(): Vec2 | null {
    return this.padAimWorld;
  }

  sample(): FrameInput {
    const pad = pollGamepad();
    if (pad.aim) {
      this.padAimDir = pad.aim;
      this.aimSource = "pad";
    }

    const aim =
      this.aimSource === "pad"
        ? this.aimOrigin().add(this.padAimDir.mul(AIM_DISTANCE))
        : screenToWorld(this.camera, this.mouseScreen.x, this.mouseScreen.y);
    this.padAimWorld = this.aimSource === "pad" ? aim : null;

    const b = (held: boolean, prev: ButtonInput) => button(held, prev);
    const p = this.prev;
    const input: FrameInput = {
      moveLeft: b(this.held("KeyR") || pad.moveLeft, p.moveLeft),
      moveRight: b(this.held("KeyT") || pad.moveRight, p.moveRight),
      jump: b(this.held("Space") || pad.jump, p.jump),
      retract: b(this.held("KeyC") || pad.retract, p.retract),
      extend: b(this.held("KeyS") || pad.extend, p.extend),
      fire: b(this.mouseLeft || pad.fire, p.fire),
      retractClick: b(this.mouseRight || pad.retractTug, p.retractClick),
      spawnSmallCircle: b(this.held("Digit1") || pad.spawnSmall, p.spawnSmallCircle),
      spawnLargeCircle: b(this.held("Digit2") || pad.spawnLarge, p.spawnLargeCircle),
      mouseWorldPosition: aim,
    };
    this.prev = input;
    return input;
  }
}
