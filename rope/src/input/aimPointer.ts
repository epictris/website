// AimPointer - the mouse position an aim mode reads, kept alive past the edge of
// the window.
//
// `clientX/clientY` is only reported while the pointer is over the page, and the
// OS cursor itself cannot leave the display: aiming from the cursor's own
// position therefore stops dead at the window edge, and stops again at the
// screen edge in fullscreen, where there is no window edge left to blame. Only
// the first of those is a listener problem. Past the screen edge the cursor
// genuinely stopped moving, so no listener anywhere could have seen more.
//
// Pointer lock is the way out: it detaches the cursor from the screen and
// reports motion as `movementX/Y` deltas that keep coming however far the hand
// travels. What it takes away is the position, so the position is kept here - a
// VIRTUAL cursor, integrated from those deltas and bounded by the play frame
// rather than by whatever the window happens to be.
//
// Bounding a *virtual* cursor is free, which is the thing worth knowing. Clamping
// a real cursor's projection is what motion aim (see ballInput.ts) was written to
// avoid: past the boundary the drawn reticle stops while the real cursor keeps
// travelling outward, so coming back inward does nothing until it re-enters -
// dead travel the player cannot see. A virtual cursor never accumulates past its
// bound, so it moves inward on the very first pixel back.
//
// Unlocked, the virtual cursor IS the real one, so an aim mode reading
// `position()` behaves exactly as it did before any of this existed. That is
// what lets the lock be opt-in per session rather than a rewrite of aim.
//
// The lock is taken in FULLSCREEN ONLY, for two reasons that point the same way.
// Windowed, the cursor is the player's: the window edge is a boundary they can
// see and walk back from, other windows are a mouse-move away, and capturing the
// pointer to fix an edge nobody was pushing against costs an Esc to get out of.
// Fullscreen is the case the virtual cursor was written for - the screen edge is
// the last boundary and there is nothing past it to reach for. It is also, on
// this machine, the only place the lock is SAFE: locked in a window, Chromium's
// Wayland pointer location drifts out of the page with the hand's net travel and
// presses that hit-test onto the caption or a resize border are eaten and
// delivered as a lone release (CLAUDE.md, "Answered: it is Chromium"). A
// fullscreen window has no caption and no borders to drift onto.

import { Vec2 } from "../engine/vec2";
import {
  VIEW_HEIGHT,
  VIEW_WIDTH,
  clientToView,
  viewPerClientPx,
} from "../render/viewport";

// How the mouse aims. Both controllers read the same setting, overridable per
// session with `?aim=position` / `?aim=cursor` / `?aim=motion` so the three can
// be compared by feel without a rebuild.
//
//   cursor (default) - the aim point is the VIRTUAL cursor's screen position,
//     un-projected through the current camera. In fullscreen, where the lock is
//     taken, that cursor is integrated from the mouse's own deltas and bounded
//     by the play frame, so aim carries on past the edge of the screen. In a
//     window it is the real cursor, and identical to `position`.
//   position - the same mapping reading the REAL cursor, and the only mode that
//     leaves the pointer alone. No lock, and no fix: this is the mode with the
//     edges in it, kept so the two can still be compared by feel.
//   motion   - aim is integrated from the mouse's own travel and bounded in
//     WORLD space by the chain's reach (ball controller only; the grapple
//     controller treats it as `cursor`).
const AIM_MODES = ["position", "cursor", "motion"] as const;
export type AimMode = (typeof AIM_MODES)[number];
const AIM_MODE_DEFAULT: AimMode = "cursor";
export const AIM_MODE: AimMode = ((): AimMode => {
  if (typeof location === "undefined") return AIM_MODE_DEFAULT;
  const q = new URLSearchParams(location.search).get("aim");
  return AIM_MODES.includes(q as AimMode) ? (q as AimMode) : AIM_MODE_DEFAULT;
})();

// Every mode but `position` wants the lock (in fullscreen: see AimPointer);
// `position` exists to be compared against, so it must keep behaving exactly as
// it always did, windowed or not.
export const AIM_WANTS_LOCK = AIM_MODE !== "position";

// Is the game showing fullscreen? There are two ways in and they report
// themselves differently. The Fullscreen API sets a fullscreen ELEMENT, which
// has to be an ancestor of the canvas (or the canvas itself) for the game to be
// the thing filling the screen. F11 and an installed PWA launched with
// `display: fullscreen` set no element at all and show up only as the display
// mode, which both of them share with the API's fullscreen - so the mode alone
// would very nearly do, and the element check is what keeps some OTHER element
// being fullscreened from counting as the game being.
const FULLSCREEN_MODE =
  typeof matchMedia === "function" ? matchMedia("(display-mode: fullscreen)") : null;

function fullscreen(canvas: HTMLCanvasElement): boolean {
  if (typeof document === "undefined") return false;
  if (document.fullscreenElement) return document.fullscreenElement.contains(canvas);
  return FULLSCREEN_MODE?.matches ?? false;
}

// Hold a view-space point inside the play frame. The frame is the visible
// picture (see render/viewport.ts), so this is the largest bound that keeps the
// virtual cursor somewhere the player can actually see it.
function clampToFrame(v: Vec2): Vec2 {
  return new Vec2(
    Math.min(Math.max(v.x, 0), VIEW_WIDTH),
    Math.min(Math.max(v.y, 0), VIEW_HEIGHT),
  );
}

export class AimPointer {
  // The virtual cursor, in view pixels. Null until the first mousemove: no
  // pointer has been seen, which is not the same as one at the top-left corner.
  private view: Vec2 | null = null;
  // How far it moved on the last mousemove, in view pixels.
  private lastMotion: Vec2 | null = null;

  // `takeLock` false leaves the pointer entirely alone (position mode): no lock
  // request, so no capture the player did not ask for, and the virtual cursor
  // just tracks the real one.
  //
  // `active` is whether the source owning this pointer is driving the game right
  // now. It is true forever in the game itself, and it is the editor that needs
  // it: a test there keeps its input source alive after the test stops (see
  // editor/editor.ts), so these listeners outlive the run and a click meant for
  // the toolbar would otherwise capture the cursor into a level nobody is
  // playing.
  constructor(
    private canvas: HTMLCanvasElement,
    private takeLock: boolean,
    private active: () => boolean = () => true,
  ) {
    if (!takeLock) return;
    // Fullscreen or not, a click is the gesture the lock needs; `requestLock`
    // is what refuses it outside fullscreen. This is the ONLY path into the
    // lock under F11 and under the installed PWA, neither of which announces
    // itself with an event the moment it happens.
    canvas.addEventListener("mousedown", () => this.requestLock());
    // Entering fullscreen through the Fullscreen API is a user gesture of its
    // own, so the lock can be taken there rather than waiting for a click the
    // player has no reason to make. Leaving it gives the pointer back: the
    // browser usually does that itself, but a lock that outlived fullscreen
    // would be exactly the windowed capture this gating exists to prevent.
    document.addEventListener("fullscreenchange", () => {
      if (fullscreen(canvas)) this.requestLock();
      else this.releaseLock();
    });
    // F11 fires no `fullscreenchange`; the display mode changing is the only
    // word of it either way. Coming out, that word is what gives the pointer
    // back. Going in, there is no user gesture attached to it - the browser
    // would refuse a lock requested here - so the first click takes it instead.
    FULLSCREEN_MODE?.addEventListener("change", (e) => {
      if (!e.matches) this.releaseLock();
    });
  }

  locked(): boolean {
    return typeof document !== "undefined" && document.pointerLockElement === this.canvas;
  }

  // Take the lock if it is wanted, allowed and not already held. Deliberately
  // WITHOUT `unadjustedMovement`: the point of the virtual cursor is to feel
  // like the desktop cursor it replaces, and the desktop cursor has the OS
  // pointer acceleration curve applied to it.
  requestLock(): void {
    if (!this.takeLock || !this.active() || typeof document === "undefined") return;
    if (!fullscreen(this.canvas)) return;
    if (document.pointerLockElement === this.canvas) return;
    // Rejects harmlessly when the browser refuses - most often a re-lock too soon
    // after an Esc exit, which Chrome rate-limits.
    void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
  }

  // Give the pointer back. Held only while fullscreen, so this runs on the way
  // out of it; unlocked, `update` follows the real cursor again from its next
  // move, which is where the OS put the pointer when it reappeared.
  private releaseLock(): void {
    if (typeof document === "undefined") return;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  // Fold one mousemove into the virtual cursor; read `position()`/`motion()` after.
  update(e: MouseEvent): void {
    // View pixels, not client pixels: the frame is a fixed 16:9 scaled to fit the
    // window, so the pointer has to be un-projected through that fit before a
    // camera can un-project it into the world.
    const real = clientToView(this.canvas, e.clientX, e.clientY);
    if (!this.locked()) {
      // Unlocked, `clientX/clientY` is the truth. Following it rather than
      // integrating is what stops a pointer that left the page and came back
      // somewhere else from leaving the virtual cursor behind.
      this.lastMotion = this.view ? real.sub(this.view) : null;
      this.view = real;
      return;
    }
    // Locked, `clientX/clientY` is frozen at wherever the lock was taken, so the
    // deltas are the only motion there is. They are CLIENT pixels where the view
    // is the fitted frame, so they are scaled by that fit - otherwise the cursor
    // moved at the window's scale rather than the view's, by a different amount
    // on every display.
    const motion = new Vec2(e.movementX, e.movementY).mul(viewPerClientPx(this.canvas));
    this.lastMotion = motion;
    this.view = clampToFrame((this.view ?? real).add(motion));
  }

  // The virtual cursor in view pixels, or null before the first mousemove.
  position(): Vec2 | null {
    return this.view;
  }

  // The last mousemove's travel in view pixels, or null when there was nothing to
  // measure from (the first move). Unlocked this is cursor travel, which is what
  // synthetic events from the headless tooling produce, since they carry no
  // `movementX/Y` and never hold the lock.
  motion(): Vec2 | null {
    return this.lastMotion;
  }
}
