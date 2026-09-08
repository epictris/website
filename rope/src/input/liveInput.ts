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
//
// Mouse aim reads AimPointer rather than the raw event, so under the `cursor`
// (default) and `motion` aim modes (input/aimPointer.ts) it takes pointer lock on
// click IN FULLSCREEN and keeps aiming past the edge of the screen. The lock
// hides the OS cursor, which on this controller IS the aim indicator, so
// `crosshairAim` hands the renderer a crosshair to draw in its place. Windowed,
// and under `?aim=position` always, the pointer is left alone and aim behaves
// exactly as it always did.

import { Vec2 } from "../engine/vec2";
import {
  button,
  emptyFrameInput,
  type ButtonInput,
  type FrameInput,
  type IInputSource,
} from "./frameInput";
import {
  PAD_A,
  PAD_DPAD_LEFT,
  PAD_DPAD_RIGHT,
  PAD_LB,
  PAD_LT,
  PAD_RB,
  PAD_RT,
  PAD_X,
  PAD_Y,
  readGamepad,
} from "./gamepad";
import { screenToWorld, type Camera } from "../render/camera";
import { AIM_WANTS_LOCK, AimPointer } from "./aimPointer";
import { ButtonLatch } from "./latch";

const MOVE_DEADZONE = 0.35; // left-stick X → digital move threshold
const AIM_DEADZONE = 0.3; // right-stick deflection before it takes over aim
const AIM_DISTANCE = 1.5; // world metres from the player to the stick aim point

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
  const pad = readGamepad();
  if (!pad) return NO_PAD;
  const lx = pad.axis(0);
  const aimVec = new Vec2(pad.axis(2), pad.axis(3));
  return {
    moveLeft: lx < -MOVE_DEADZONE || pad.pressed(PAD_DPAD_LEFT),
    moveRight: lx > MOVE_DEADZONE || pad.pressed(PAD_DPAD_RIGHT),
    jump: pad.pressed(PAD_A),
    retract: pad.pressed(PAD_RB),
    extend: pad.pressed(PAD_LB),
    fire: pad.pressed(PAD_RT),
    retractTug: pad.pressed(PAD_LT),
    spawnSmall: pad.pressed(PAD_X),
    spawnLarge: pad.pressed(PAD_Y),
    aim: aimVec.length() > AIM_DEADZONE ? aimVec.normalized() : null,
  };
}

export class LiveInputSource implements IInputSource {
  // One latch per key code and mouse button rather than a flag, so a tap or a
  // click shorter than a sim step still reaches the next sample (see
  // input/latch.ts). Keys are latched on first sight; a code never pressed has
  // no latch and reads as released.
  private keys = new Map<string, ButtonLatch>();
  private mouseLeft = new ButtonLatch();
  private mouseRight = new ButtonLatch();
  // The cursor mouse aim reads: the real one in `position` mode, the virtual one
  // the pointer lock feeds in the other two (see input/aimPointer.ts).
  private pointer: AimPointer;
  private prev: FrameInput = emptyFrameInput();
  private aimSource: "mouse" | "pad" = "mouse";
  private padAimDir = new Vec2(1, 0); // last stick aim, kept while stick is released
  private padAimWorld: Vec2 | null = null;

  // `active` is whether this source is the one driving the game right now. It is
  // true forever in the game itself; the editor passes "a test is running", so a
  // click meant for the toolbar between tests does not capture the cursor (see
  // input/aimPointer.ts).
  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private aimOrigin: () => Vec2,
    private active: () => boolean = () => true,
  ) {
    window.addEventListener("keydown", (e) => {
      this.press(this.key(e.code), true);
      // Space is the jump key, so the page must not scroll on it - but only
      // while this source is the one being played. In the editor these
      // listeners outlive the test, and swallowing Space there kills the space
      // bar on a focused inspector checkbox for the rest of the session.
      if (e.code === "Space" && this.active()) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      const latch = this.keys.get(e.code);
      if (latch) this.press(latch, false);
    });
    this.pointer = new AimPointer(canvas, AIM_WANTS_LOCK, active);
    canvas.addEventListener("mousemove", (e) => {
      this.pointer.update(e);
      this.aimSource = "mouse";
      // The move carries the button state the browser believes in, so a press
      // or release it never announced is picked up here (see ballInput.ts).
      this.press(this.mouseLeft, (e.buttons & 1) !== 0);
      this.press(this.mouseRight, (e.buttons & 2) !== 0);
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.press(this.mouseLeft, true);
      if (e.button === 2) this.press(this.mouseRight, true);
      this.aimSource = "mouse";
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.press(this.mouseLeft, false);
      if (e.button === 2) this.press(this.mouseRight, false);
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // A button edge is queued for the next sample only while this source is the
  // one driving the game; otherwise it is the level and nothing more, so a
  // click or a keystroke made between the editor's tests is not replayed into
  // the first frames of the next one.
  private press(latch: ButtonLatch, level: boolean): void {
    if (this.active()) latch.set(level);
    else latch.reset(level);
  }

  private key(code: string): ButtonLatch {
    let latch = this.keys.get(code);
    if (!latch) {
      latch = new ButtonLatch();
      this.keys.set(code, latch);
    }
    return latch;
  }

  // Sampled once per step for every code given - no short-circuit, or a code
  // behind a held one would keep its queued edge for a later frame.
  private held(...codes: string[]): boolean {
    return codes.map((c) => this.keys.get(c)?.sample() ?? false).some(Boolean);
  }

  // World-space aim point the renderer should draw a crosshair at, or null when
  // something else on screen already shows aim. That is the gamepad while the
  // right stick owns aim - and the mouse too under pointer lock, where the
  // browser has hidden the OS cursor and the crosshair is the only stand-in left.
  crosshairAim(): Vec2 | null {
    if (this.padAimWorld) return this.padAimWorld;
    return this.pointer.locked() ? this.mouseAim() : null;
  }

  // The world point the mouse is aiming at. Before the first mousemove there is
  // no pointer to read, and the view's top-left corner is the answer the raw
  // client coordinates would have given anyway.
  private mouseAim(): Vec2 {
    const screen = this.pointer.position() ?? Vec2.ZERO;
    return screenToWorld(this.camera, screen.x, screen.y);
  }

  // Refresh the stick-driven aim (and the crosshair point) from the live gamepad
  // state. The mouse moves aim from its own events; a gamepad has no events, so
  // this poll is the only thing that moves the crosshair. It must run once per
  // *rendered* frame rather than only inside sample(): sample() runs on the fixed
  // 1/60 step, so on a display faster than the sim (144 Hz) most frames would
  // redraw the crosshair at an unchanged aim, and unevenly — it visibly stutters
  // while mouse aim stays smooth. Render-rate polling can't affect the sim: it
  // only moves the stored aim forward in time, and sample() still encodes
  // whatever it holds at the physics frame.
  pollAim(): void {
    const pad = pollGamepad();
    if (pad.aim) {
      this.padAimDir = pad.aim;
      this.aimSource = "pad";
    }
    this.padAimWorld =
      this.aimSource === "pad"
        ? this.aimOrigin().add(this.padAimDir.mul(AIM_DISTANCE))
        : null;
  }

  sample(): FrameInput {
    const pad = pollGamepad();
    this.pollAim();

    const aim = this.padAimWorld ?? this.mouseAim();

    const b = (held: boolean, prev: ButtonInput) => button(held, prev);
    const p = this.prev;
    const input: FrameInput = {
      moveLeft: b(this.held("KeyR") || pad.moveLeft, p.moveLeft),
      moveRight: b(this.held("KeyT") || pad.moveRight, p.moveRight),
      jump: b(this.held("Space") || pad.jump, p.jump),
      retract: b(this.held("KeyC") || pad.retract, p.retract),
      extend: b(this.held("KeyS") || pad.extend, p.extend),
      fire: b([this.mouseLeft.sample(), pad.fire].some(Boolean), p.fire),
      retractClick: b([this.mouseRight.sample(), pad.retractTug].some(Boolean), p.retractClick),
      spawnSmallCircle: b(this.held("Digit1") || pad.spawnSmall, p.spawnSmallCircle),
      spawnLargeCircle: b(this.held("Digit2") || pad.spawnLarge, p.spawnLargeCircle),
      mouseWorldPosition: aim,
    };
    this.prev = input;
    return input;
  }
}
