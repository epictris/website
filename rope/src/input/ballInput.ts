// BallInputSource — mouse + gamepad + touch → FrameInput for the ball & chain
// controller. Keyboard has no bindings here; the aim devices merge, most
// recent wins:
//
//   Mouse:   move to aim (cursor) · click deploy chain (any button)
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
// The mouse has three aim modes, chosen by AIM_MODE (input/aimPointer.ts):
//
//   cursor (default) — the aim point is AimPointer's VIRTUAL cursor's screen
//     position, un-projected through the *current* camera every time it is read
//     (see `currentAimLocal`): the reticle is exactly where the pointer is, a
//     drawn stand-in for the hidden OS cursor and nothing more, and a camera pan
//     or ease never moves it. Under pointer lock that cursor is integrated from
//     the mouse's own deltas and bounded by the play frame, so aim carries on
//     past the edge of the window and of the screen.
//   position — the same mapping reading the REAL cursor, unbounded. Identical to
//     `cursor` until the lock is taken, and thereafter the mode that stops
//     aiming at the edge of the window, and at the edge of the screen in
//     fullscreen, because that is where the real cursor stops.
//   motion — `aimLocal` accumulates each mousemove's delta (metres at the
//     current zoom) and is held within the chain's reach. The difference from
//     `cursor` is only where the bound lives: in the world, at the reach, rather
//     than on screen, at the frame. The first move (and the first after another
//     device owned aim) seeds it from the cursor.
//
// `cursor` and `motion` take pointer lock on click IN FULLSCREEN (Esc releases
// it, the next click takes it back); windowed, and in `position` always, the
// pointer is left alone. See aimPointer.ts for why the lock is the only thing
// that fixes the boundary, why bounding a virtual cursor costs none of what
// bounding a real one would, and why the lock is worth having only where the
// screen edge is the boundary.
//
// Every mouse button deploys - left, middle, right - rather than the left alone.
// The chain is the only thing the mouse does here, so there is nothing for a
// second button to mean, and a hand that has learned to reach for a side button
// should not find it dead.
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
import { AIM_MODE, AIM_WANTS_LOCK, AimPointer } from "./aimPointer";
import { PIXELS_PER_METER } from "../engine/units";
import { BallPlayer } from "../classes/ballPlayer";
import { ButtonLatch } from "./latch";

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
  // Latched rather than a plain flag, so a click shorter than a sim step still
  // reaches the next sample (see input/latch.ts).
  // One latch for the whole mouse, not one per button: every button deploys
  // (see the header), so what matters is whether ANY of them is down.
  private mouseButton = new ButtonLatch();
  // The cursor mouse aim reads: the real one in `position` mode, the virtual one
  // the pointer lock feeds in the other two (see input/aimPointer.ts).
  private pointer: AimPointer;
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
  private touchFire = new ButtonLatch();

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
    this.pointer = new AimPointer(canvas, AIM_WANTS_LOCK, active);
    canvas.addEventListener("mousemove", (e) => {
      this.pointer.update(e);
      // The move carries the button state the browser believes in, so a press
      // or release it never announced as an event is picked up at the next
      // move rather than never.
      this.press(this.mouseButton, e.buttons !== 0);
      // `position` and `cursor` differ only in WHICH cursor this is; both are
      // re-derived per read in `currentAimLocal`, so this write is the seed the
      // other devices hand back to.
      this.aimLocal = AIM_MODE === "motion" ? this.motionAim() : this.cursorAim();
      this.aimSource = "mouse";
    });
    // A down of any button is a deploy. A release reads `e.buttons`, the mask AS
    // OF the event and so already without the button just released: the deploy
    // is held while another button is still down, and dropped when the last one
    // comes up.
    canvas.addEventListener("mousedown", () => this.press(this.mouseButton, true));
    window.addEventListener("mouseup", (e) => this.press(this.mouseButton, e.buttons !== 0));
    // The right button deploys now, so the context menu it would otherwise open
    // is a menu over the game; `auxclick` carries the middle button's own
    // defaults, which are no more wanted here.
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("auxclick", (e) => e.preventDefault());

    if (TOUCH_CAPABLE) {
      this.buildJoystick();
      this.buildDeploy();
    }
  }

  // A button edge is queued for the next sample only while this source is the
  // one driving the game; otherwise it is the level and nothing more, so a
  // click made between the editor's tests is not replayed into the next one.
  private press(latch: ButtonLatch, level: boolean): void {
    if (this.active()) latch.set(level);
    else latch.reset(level);
  }

  // Position/cursor aim: the aim offset for wherever the pointer now is. Left
  // unbounded — in `position` the cursor is the reticle and cannot be moved to
  // suit us, and in `cursor` the virtual cursor is already held inside the play
  // frame, which is a tighter bound than the reach in every direction the player
  // can see.
  private cursorAim(): Vec2 {
    const screen = this.pointer.position() ?? Vec2.ZERO;
    return screenToWorld(this.camera, screen.x, screen.y).sub(this.aimOrigin());
  }

  // Motion aim: the new aim offset after this mousemove, moved by the mouse's own
  // travel rather than set from the cursor's position.
  private motionAim(): Vec2 {
    const motion = this.pointer.motion();
    // Taking over from another device (or aiming for the first time) puts the
    // reticle under the real cursor; from there it travels by motion alone.
    if (!motion || !this.aimLocal || this.aimSource !== "mouse") {
      // Locked there is no cursor on screen to seed from, so a held aim stays put.
      if (this.pointer.locked() && this.aimLocal) return this.aimLocal;
      return clampReach(this.cursorAim());
    }
    // Metres per screen pixel at the current zoom, so a given hand movement
    // covers the same on-screen distance whatever the zoom is.
    const metresPerPx = 1 / (this.camera.zoom * PIXELS_PER_METER);
    return clampReach(this.aimLocal.add(motion.mul(metresPerPx)));
  }

  // The on-screen controls hang inside the play frame rather than off the
  // window, so they follow the letterboxed 16:9 view instead of floating in a
  // bar beside it (hence `position: absolute` on both, against the frame's
  // `position: relative`).
  private controlsHost(): HTMLElement {
    return this.canvas.parentElement ?? document.body;
  }

  // Bottom-left virtual joystick: a fixed base ring with a draggable knob. The
  // knob follows the finger clamped to JOYSTICK_RADIUS_PX; deflection past the
  // deadzone sets joyAim to its normalized direction. touch-action:none + a
  // non-passive preventDefault keep the browser from scrolling/zooming.
  private buildJoystick(): void {
    const base = document.createElement("div");
    Object.assign(base.style, {
      position: "absolute",
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

    this.controlsHost().append(base);
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
      position: "absolute",
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
      this.press(this.touchFire, held);
      deploy.style.background = held ? "#313244" : "#1f2430";
    };
    deploy.addEventListener("touchstart", press(true), { passive: false });
    deploy.addEventListener("touchend", press(false), { passive: false });
    deploy.addEventListener("touchcancel", press(false), { passive: false });

    this.controlsHost().append(deploy);
  }

  // The world point currently aimed at, or null when nothing aims (no input
  // yet, or a released stick/joystick — those hold their last aimLocal, but a
  // released stick means "physics owns rotation"). The renderer draws the aim
  // reticle here; sample() encodes null as the ball's own position.
  aimPoint(): Vec2 | null {
    const local = this.currentAimLocal();
    if (!local) return null;
    if (this.aimSource === "pad" && !this.padAim) return null;
    if (this.aimSource === "touch" && !this.joyAim) return null;
    return this.aimOrigin().add(local);
  }

  // The aim offset as it stands *now*. Position- and cursor-mode mouse aim is
  // re-derived from the pointer's screen position through the CURRENT camera each
  // time it is read, instead of being frozen at mousemove time: the reticle
  // stands in for the hidden OS cursor, so it has to stay under the pointer when
  // the camera pans, eases or changes zoom while the mouse holds still. Frozen as
  // an offset from the ball, it slid across the screen on its own every time the
  // camera moved — the cursor appearing to drift with no hand on the mouse.
  // Motion aim is deliberately exempt: there the offset IS the state, integrated
  // from the mouse's own travel, and the cursor may not even be on screen
  // (pointer lock). Stick and joystick aim are ball-relative directions by
  // definition, so they are exempt too.
  private currentAimLocal(): Vec2 | null {
    if (this.aimSource === "mouse" && AIM_MODE !== "motion" && this.pointer.position()) {
      return this.cursorAim();
    }
    return this.aimLocal;
  }

  // Refresh the stick-driven aim from the live gamepad state. The mouse and the
  // on-screen joystick write `aimLocal` from their own events, so they move the
  // reticle the moment the device does; a gamepad has no events, so this poll is
  // the only thing that moves it. It must run once per *rendered* frame rather
  // than only inside sample(): sample() runs on the fixed 1/60 step, so on a
  // display faster than the sim (144 Hz) most frames would redraw the reticle at
  // an unchanged aim, and unevenly — the stick aim visibly stutters while mouse
  // aim stays smooth. Render-rate polling can't affect the sim: it only moves
  // `aimLocal` forward in time, and sample() still encodes whatever it holds at
  // the physics frame.
  pollAim(): void {
    const pad = readGamepad();
    this.padAim = null;
    if (!pad) return;
    const stick = new Vec2(pad.axis(0), pad.axis(1));
    if (stick.length() > AIM_DEADZONE) {
      this.padAim = stick.normalized();
      this.aimLocal = this.padAim.mul(AIM_DISTANCE);
      this.aimSource = "pad";
    }
  }

  sample(): FrameInput {
    this.pollAim();
    const pad = readGamepad();
    const padFire = pad ? pad.pressed(PAD_RB) : false;
    const restart = pad ? pad.pressed(PAD_Y) : false;

    // "Not aiming" sentinel: the ball's own position (BallPlayer treats a
    // zero-length aim vector as physics-driven rotation).
    const aimWorld = this.aimPoint() ?? this.aimOrigin();

    const p = this.prev;
    const input: FrameInput = {
      ...emptyFrameInput(),
      // Every latch is sampled, whatever the others said: a short-circuit would
      // leave the unread one's queued edge for a later frame.
      fire: button([this.mouseButton.sample(), padFire, this.touchFire.sample()].some(Boolean), p.fire),
      jump: button(restart, p.jump), // restart routed through jump (stays in the recorded stream)
      mouseWorldPosition: aimWorld,
    };
    this.prev = input;
    return input;
  }
}
