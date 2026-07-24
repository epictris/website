// BallInputSource — mouse + gamepad + touch → FrameInput for the ball & chain
// controller. Keyboard has no bindings here; the aim devices merge, most
// recent wins:
//
//   Mouse:   move to aim (cursor) · left-click deploy chain
//   Gamepad: left stick aim · RB deploy chain (hold-to-keep) ·
//            top face button (X on a Pro Controller) restart level
//   Touch:   drag on canvas to aim · on-screen DEPLOY button (hold-to-keep)
//
// The ball controller reuses the FrameInput shape so recordings serialize with
// the existing tooling: aim → mouseWorldPosition, deploy → fire,
// restart → jump. Everything else stays NO_BUTTON.
//
// Aim encoding differs by device. The mouse always aims: its cursor projects
// straight to world space. The stick aims only while deflected; a released
// stick sends the ball's own position, which BallPlayer reads as "not aiming"
// (rotation left to the physics). Touch matches the stick: an active drag aims
// at the finger, a lifted finger sends the ball's own position.

import { Vec2 } from "../engine/vec2";
import {
  button,
  emptyFrameInput,
  type FrameInput,
  type IInputSource,
} from "./frameInput";
import { PAD_RB, PAD_Y, readGamepad } from "./gamepad";
import { screenToWorld, type Camera } from "../render/camera";
import { BallPlayer } from "../classes/ballPlayer";

const AIM_DEADZONE = 0.3; // left-stick deflection before it counts as aiming
const AIM_DISTANCE = BallPlayer.CHAIN_MAX_LENGTH;

// Coarse primary pointer = a real touch device (phone/tablet), not a desktop.
// `'ontouchstart' in window` is unreliable — Chromium reports it true on plain
// desktops — and maxTouchPoints trips on touchscreen laptops that also have a
// mouse; the media query keys off the *primary* pointer, so a laptop with a
// mouse stays desktop and gets no on-screen button.
const TOUCH_CAPABLE =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

export class BallInputSource implements IInputSource {
  private prev: FrameInput = emptyFrameInput();
  private mouseLeft = false;
  private mouseScreen = new Vec2(0, 0);
  // No input yet: don't aim (avoids the ball snapping toward screen origin
  // before the first move). Any device sets this true.
  private hasAimed = false;
  private aimSource: "mouse" | "pad" | "touch" = "mouse";

  // Touch aim: the id of the finger currently steering, and its screen point.
  private aimTouchId: number | null = null;
  private touchScreen = new Vec2(0, 0);
  // On-screen DEPLOY button (touch only), hold-to-keep.
  private touchFire = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private aimOrigin: () => Vec2,
  ) {
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseScreen = new Vec2(e.clientX - rect.left, e.clientY - rect.top);
      this.aimSource = "mouse";
      this.hasAimed = true;
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouseLeft = true;
      this.aimSource = "mouse";
      this.hasAimed = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseLeft = false;
    });

    if (TOUCH_CAPABLE) this.setupTouch();
  }

  // A finger on the canvas steers the aim (same role as the mouse cursor); the
  // DEPLOY/RESTART buttons are DOM overlays with their own handlers, so a
  // canvas touch never doubles as a button press. touch-action:none + a
  // non-passive preventDefault keep the browser from scrolling/zooming.
  private setupTouch(): void {
    const track = (t: Touch): void => {
      const rect = this.canvas.getBoundingClientRect();
      this.touchScreen = new Vec2(t.clientX - rect.left, t.clientY - rect.top);
      this.aimSource = "touch";
      this.hasAimed = true;
    };
    this.canvas.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        if (this.aimTouchId === null && e.changedTouches.length > 0) {
          const t = e.changedTouches[0]!;
          this.aimTouchId = t.identifier;
          track(t);
        }
      },
      { passive: false },
    );
    this.canvas.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) {
          if (t.identifier === this.aimTouchId) track(t);
        }
      },
      { passive: false },
    );
    const end = (e: TouchEvent): void => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.aimTouchId) this.aimTouchId = null;
      }
    };
    this.canvas.addEventListener("touchend", end, { passive: false });
    this.canvas.addEventListener("touchcancel", end, { passive: false });

    this.buildButtons();
  }

  private buildButtons(): void {
    const deploy = document.createElement("button");
    deploy.textContent = "DEPLOY";
    Object.assign(deploy.style, {
      position: "fixed",
      bottom: "max(16px, env(safe-area-inset-bottom))",
      left: "16px",
      zIndex: "10",
      width: "12ch",
      height: "12ch",
      padding: "0",
      background: "#1f2430",
      color: "#cbccc6",
      border: "2px solid #313244",
      borderRadius: "50%",
      font: "inherit",
      textAlign: "center",
      userSelect: "none",
      webkitUserSelect: "none",
      touchAction: "none",
      opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);

    const press = (held: boolean) => (e: Event) => {
      e.preventDefault();
      this.touchFire = held;
      deploy.style.background = held ? "#313244" : "#1f2430";
    };
    deploy.addEventListener("touchstart", press(true), { passive: false });
    deploy.addEventListener("touchend", press(false), { passive: false });
    deploy.addEventListener("touchcancel", press(false), { passive: false });

    document.body.append(deploy);
  }

  sample(): FrameInput {
    const pad = readGamepad();
    let padFire = false;
    let restart = false;
    let padAim: Vec2 | null = null;
    if (pad) {
      const stick = new Vec2(pad.axis(0), pad.axis(1));
      if (stick.length() > AIM_DEADZONE) {
        padAim = stick.normalized();
        this.aimSource = "pad";
        this.hasAimed = true;
      }
      padFire = pad.pressed(PAD_RB);
      restart = pad.pressed(PAD_Y);
    }

    // "Not aiming" sentinel: the ball's own position (BallPlayer treats a
    // zero-length aim vector as physics-driven rotation).
    const origin = this.aimOrigin();
    let aimWorld = origin;
    if (this.hasAimed) {
      if (this.aimSource === "pad") {
        aimWorld = padAim ? origin.add(padAim.mul(AIM_DISTANCE)) : origin;
      } else if (this.aimSource === "touch") {
        aimWorld =
          this.aimTouchId !== null
            ? screenToWorld(this.camera, this.touchScreen.x, this.touchScreen.y)
            : origin;
      } else {
        aimWorld = screenToWorld(this.camera, this.mouseScreen.x, this.mouseScreen.y);
      }
    }

    const p = this.prev;
    const input: FrameInput = {
      ...emptyFrameInput(),
      fire: button(this.mouseLeft || padFire || this.touchFire, p.fire),
      jump: button(restart, p.jump), // restart routed through jump (stays in the recorded stream)
      mouseWorldPosition: aimWorld,
    };
    this.prev = input;
    return input;
  }
}
