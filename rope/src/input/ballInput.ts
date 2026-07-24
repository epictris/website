// BallInputSource — mouse + gamepad + touch → FrameInput for the ball & chain
// controller. Keyboard has no bindings here; the aim devices merge, most
// recent wins:
//
//   Mouse:   move to aim (cursor) · left-click deploy chain
//   Gamepad: left stick aim · RB deploy chain (hold-to-keep) ·
//            top face button (X on a Pro Controller) restart level
//   Touch:   on-screen joystick (bottom-left) aim ·
//            on-screen DEPLOY button (bottom-right, hold-to-keep)
//
// The ball controller reuses the FrameInput shape so recordings serialize with
// the existing tooling: aim → mouseWorldPosition, deploy → fire,
// restart → jump. Everything else stays NO_BUTTON.
//
// Aim encoding differs by device. The mouse always aims: its cursor projects
// straight to world space. The stick and the on-screen joystick aim only while
// deflected past a deadzone, sending a direction; a released stick/joystick
// sends the ball's own position, which BallPlayer reads as "not aiming"
// (rotation left to the physics). The joystick's screen vector maps straight to
// a world direction — screen +y (down) is world +y (down) — so up on the stick
// aims the loop up, matching the mouse.

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

const JOYSTICK_RADIUS_PX = 56; // knob travel from the base centre
const JOYSTICK_DEADZONE = 0.25; // fraction of travel before it counts as aiming

// Coarse primary pointer = a real touch device (phone/tablet), not a desktop.
// `'ontouchstart' in window` is unreliable — Chromium reports it true on plain
// desktops — and maxTouchPoints trips on touchscreen laptops that also have a
// mouse; the media query keys off the *primary* pointer, so a laptop with a
// mouse stays desktop and gets no on-screen controls.
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

  // On-screen joystick aim (touch only): a normalized direction while deflected
  // past the deadzone, else null ("not aiming").
  private joyAim: Vec2 | null = null;
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

    if (TOUCH_CAPABLE) {
      this.buildJoystick();
      this.buildDeploy();
    }
  }

  // Bottom-left virtual joystick: a fixed base ring with a draggable knob. The
  // knob follows the finger clamped to JOYSTICK_RADIUS_PX; deflection past the
  // deadzone sets joyAim to its normalized direction. touch-action:none + a
  // non-passive preventDefault keep the browser from scrolling/zooming.
  private buildJoystick(): void {
    const base = document.createElement("div");
    Object.assign(base.style, {
      position: "fixed",
      bottom: "max(24px, env(safe-area-inset-bottom))",
      left: "24px",
      zIndex: "10",
      width: `${JOYSTICK_RADIUS_PX * 2}px`,
      height: `${JOYSTICK_RADIUS_PX * 2}px`,
      borderRadius: "50%",
      background: "#1f2430",
      border: "2px solid #313244",
      touchAction: "none",
      userSelect: "none",
      webkitUserSelect: "none",
      opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);

    const knob = document.createElement("div");
    Object.assign(knob.style, {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: "50%",
      height: "50%",
      borderRadius: "50%",
      background: "#313244",
      border: "2px solid #565869",
      transform: "translate(-50%, -50%)",
    } as Partial<CSSStyleDeclaration>);
    base.append(knob);

    let joyId: number | null = null;
    const update = (t: Touch): void => {
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let v = new Vec2(t.clientX - cx, t.clientY - cy);
      const len = v.length();
      if (len > JOYSTICK_RADIUS_PX) v = v.mul(JOYSTICK_RADIUS_PX / len);
      knob.style.transform = `translate(calc(-50% + ${v.x}px), calc(-50% + ${v.y}px))`;
      const frac = Math.min(len, JOYSTICK_RADIUS_PX) / JOYSTICK_RADIUS_PX;
      this.joyAim = frac > JOYSTICK_DEADZONE ? v.normalized() : null;
      this.aimSource = "touch";
      this.hasAimed = true;
    };
    const release = (): void => {
      joyId = null;
      this.joyAim = null;
      knob.style.transform = "translate(-50%, -50%)";
    };

    base.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        if (joyId === null && e.changedTouches.length > 0) {
          const t = e.changedTouches[0]!;
          joyId = t.identifier;
          update(t);
        }
      },
      { passive: false },
    );
    base.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) {
          if (t.identifier === joyId) update(t);
        }
      },
      { passive: false },
    );
    const end = (e: TouchEvent): void => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === joyId) release();
      }
    };
    base.addEventListener("touchend", end, { passive: false });
    base.addEventListener("touchcancel", end, { passive: false });

    document.body.append(base);
  }

  private buildDeploy(): void {
    const deploy = document.createElement("button");
    deploy.setAttribute("aria-label", "deploy chain");
    // Anchor glyph: the chain deploys and anchors to a surface. Line-art in the
    // foreground colour to match the terminal palette (no emoji).
    deploy.innerHTML =
      '<svg viewBox="0 0 44 44" width="55%" height="55%" fill="none" ' +
      'stroke="#cbccc6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="22" cy="7" r="3.2"/>' +
      '<line x1="22" y1="10.2" x2="22" y2="37"/>' +
      '<line x1="14" y1="16" x2="30" y2="16"/>' +
      '<path d="M7 26 Q7 37 22 37 Q37 37 37 26"/>' +
      '<polyline points="7 30 7 26 11 27"/>' +
      '<polyline points="37 30 37 26 33 27"/>' +
      "</svg>";
    Object.assign(deploy.style, {
      position: "fixed",
      bottom: "max(24px, env(safe-area-inset-bottom))",
      right: "24px",
      zIndex: "10",
      width: "12ch",
      height: "12ch",
      padding: "0",
      background: "#1f2430",
      color: "#cbccc6",
      border: "2px solid #313244",
      borderRadius: "50%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
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
        aimWorld = this.joyAim ? origin.add(this.joyAim.mul(AIM_DISTANCE)) : origin;
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
