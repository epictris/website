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
// Every device writes one piece of state, `aimLocal`: the aim point as an
// offset from the ball, in world metres, never longer than the chain's reach.
// `aimPoint()` turns it into a world point for both the FrameInput and the
// renderer, which draws the aim reticle there — the OS cursor is hidden on the
// ball controller, so that reticle *is* the cursor, and every device gets it.
//
// The mouse has two aim modes, chosen by the MOTION_AIM setting below:
//
//   position (default) — `aimLocal` is the cursor's own position relative to the
//     ball, unbounded: the reticle is exactly where the pointer is, a drawn
//     stand-in for the hidden OS cursor and nothing more.
//   motion — `aimLocal` accumulates each mousemove's delta (metres at the
//     current zoom) and is held within the chain's reach, and the canvas takes
//     pointer lock so the cursor stays in the window. Clamping a *position*
//     mapping is what motion aim avoids: past the boundary the drawn dot would
//     stop while the real cursor kept travelling outward, so moving back inward
//     would do nothing until the real cursor re-entered the reach circle — dead
//     travel the player can't see, since the cursor is hidden. Integrating
//     motion keeps reticle and pointer one thing: it moves inward the instant
//     the mouse does, and the reticle can be bounded without that cost. The
//     first move (and the first after another device owned aim) seeds it from
//     the cursor.
//
// The stick and the on-screen joystick aim only while deflected past a
// deadzone, writing a direction at exactly the reach distance; a released
// stick/joystick sends the ball's own position, which BallPlayer reads as "not
// aiming" (rotation left to the physics). Their screen vector maps straight to a
// world direction — screen +y (down) is world +y (down) — so up on the stick
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
import { PIXELS_PER_METER } from "../engine/units";
import { BallPlayer } from "../classes/ballPlayer";

// Motion-driven mouse aim + pointer lock (see the header). Off: the reticle
// follows the cursor's position, clamped to the reach. Override per session with
// `?motionAim=1` / `?motionAim=0` to compare the two by feel without a rebuild.
const MOTION_AIM_DEFAULT = false;
const MOTION_AIM = ((): boolean => {
  if (typeof location === "undefined") return MOTION_AIM_DEFAULT;
  const q = new URLSearchParams(location.search).get("motionAim");
  return q === null ? MOTION_AIM_DEFAULT : q !== "0";
})();

const AIM_DEADZONE = 0.3; // left-stick deflection before it counts as aiming
// The chain's reach. The stick and joystick aim at exactly this distance; motion
// aim keeps its reticle within it (position aim is unbounded — it is the cursor).
const AIM_DISTANCE = BallPlayer.CHAIN_MAX_LENGTH;

// Clamp an aim offset to the reach, keeping its direction.
function clampReach(v: Vec2): Vec2 {
  const len = v.length();
  return len > AIM_DISTANCE ? v.mul(AIM_DISTANCE / len) : v;
}

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
  // Last cursor position in canvas space — the delta source for mouse aim, and
  // the seed for the first move. Null until the first mousemove.
  private mouseScreen: Vec2 | null = null;
  // The aim point as an offset from the ball, in metres, clamped to the reach.
  // Null = nothing has aimed yet (don't aim, rather than snap the ball toward
  // some default direction before the first input).
  private aimLocal: Vec2 | null = null;
  private aimSource: "mouse" | "pad" | "touch" = "mouse";

  // Left-stick aim: a normalized direction while deflected past the deadzone,
  // else null ("not aiming"). Refreshed every sample(); kept as a field so the
  // reticle can be placed between samples.
  private padAim: Vec2 | null = null;
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
      const screen = new Vec2(e.clientX - rect.left, e.clientY - rect.top);
      const prev = this.mouseScreen;
      this.mouseScreen = screen;
      this.aimLocal = MOTION_AIM
        ? this.motionAim(e, screen, prev)
        : screenToWorld(this.camera, screen.x, screen.y).sub(this.aimOrigin());
      this.aimSource = "mouse";
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouseLeft = true;
      // Motion aim only: keep the pointer in the window, since the cursor has no
      // business leaving (or reaching a screen edge and quietly capping the
      // motion). Needs a user gesture, hence here; Esc releases it and the next
      // click takes it back. Rejects harmlessly if the browser refuses (e.g. a
      // lock request too soon after an Esc exit).
      if (MOTION_AIM && document.pointerLockElement !== canvas) {
        void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseLeft = false;
    });

    if (TOUCH_CAPABLE) {
      this.buildJoystick();
      this.buildDeploy();
    }
  }

  // Motion aim (MOTION_AIM): the new aim offset after this mousemove, moved by
  // the mouse's own travel rather than set from the cursor's position.
  private motionAim(e: MouseEvent, screen: Vec2, prev: Vec2 | null): Vec2 {
    const locked = document.pointerLockElement === this.canvas;
    const travel = prev ? screen.sub(prev) : null;
    const device = new Vec2(e.movementX, e.movementY);
    // Locked, the device delta is the only motion there is (the cursor holds
    // still); it falls back to cursor travel for events that carry no
    // movementX/Y, which is what synthetic events (headless tooling) dispatch.
    const motion = locked && device.lengthSquared() > 0 ? device : travel;
    // Taking over from another device (or aiming for the first time) puts the
    // reticle under the real cursor; from there it travels by motion alone.
    if (!motion || !this.aimLocal || this.aimSource !== "mouse") {
      if (locked && this.aimLocal) return this.aimLocal; // locked: no cursor to seed from
      return clampReach(screenToWorld(this.camera, screen.x, screen.y).sub(this.aimOrigin()));
    }
    // Metres per screen pixel at the current zoom, so a given hand movement
    // covers the same on-screen distance whatever the zoom is.
    const metresPerPx = 1 / (this.camera.zoom * PIXELS_PER_METER);
    return clampReach(this.aimLocal.add(motion.mul(metresPerPx)));
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
      if (this.joyAim) this.aimLocal = this.joyAim.mul(AIM_DISTANCE);
      this.aimSource = "touch";
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

  // The world point currently aimed at, or null when nothing aims (no input
  // yet, or a released stick/joystick — those hold their last aimLocal, but a
  // released stick means "physics owns rotation"). The renderer draws the aim
  // reticle here; sample() encodes null as the ball's own position.
  aimPoint(): Vec2 | null {
    if (!this.aimLocal) return null;
    if (this.aimSource === "pad" && !this.padAim) return null;
    if (this.aimSource === "touch" && !this.joyAim) return null;
    return this.aimOrigin().add(this.aimLocal);
  }

  sample(): FrameInput {
    const pad = readGamepad();
    let padFire = false;
    let restart = false;
    this.padAim = null;
    if (pad) {
      const stick = new Vec2(pad.axis(0), pad.axis(1));
      if (stick.length() > AIM_DEADZONE) {
        this.padAim = stick.normalized();
        this.aimLocal = this.padAim.mul(AIM_DISTANCE);
        this.aimSource = "pad";
      }
      padFire = pad.pressed(PAD_RB);
      restart = pad.pressed(PAD_Y);
    }

    // "Not aiming" sentinel: the ball's own position (BallPlayer treats a
    // zero-length aim vector as physics-driven rotation).
    const aimWorld = this.aimPoint() ?? this.aimOrigin();

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
