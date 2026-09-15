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
// Where the reticle IS the page's cursor - the game hides the OS pointer for
// the ball controller and draws this in its place - the virtual cursor moves by
// the mouse's TRAVEL whether or not the lock is held, and is born where the
// caller says (`seed`) rather than under the desktop pointer. Windowed then
// feels like fullscreen, both bounded by the play frame. What a travelling
// cursor gives up is the guarantee that a pointer which left the page and came
// back somewhere else lands the reticle under itself; it lands a jump of the
// same size away instead, which is the trade the locked path has always made.
//
// Everywhere the desktop cursor is still VISIBLE - `position` mode, the grapple
// controller, a test run from the editor - unlocked reading stays exactly what
// it was: the real cursor, followed outright, unseeded and unbounded. Two
// pointers that disagree is worse than any edge behaviour, and `position` is
// kept precisely so the others have something to be compared against.
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
// delivered as a lone release (docs/input-latch.md, "Answered: it is Chromium"). A
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
//     un-projected through the current camera. That cursor is integrated from
//     the mouse's own travel and bounded by the play frame, windowed or
//     fullscreen, so aim carries on past the edge of the screen wherever the
//     lock is held; and it is born above the avatar rather than under the
//     desktop pointer (see `AimPointer`'s `seed`).
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

// CURSOR WARPS, and why nothing about the event itself can spot one.
//
// Taking the pointer lock, entering fullscreen and releasing a click all
// TELEPORT the cursor, and Chromium reports the teleport as `movementX/Y`,
// indistinguishable from a hand. Traced with every field an event carries, in a
// real browser, on the machine that shows it:
//
//   up   t=3480              m=(    0,   0)
//   move t=3481  dt=   1 ms  m=( 1174,  98)   <- the release's warp
//   move t=3999  dt= 518 ms  m=(-1173, -98)   <- its inverse, on the next move
//
//   up   t=2187   LOCK
//   move t=2195  dt=   8 ms  m=( 1280,  30)
//                 FULL
//   move t=2633  dt= 438 ms  m=(-1279, -30)
//
// Three things that trace settles, each of which had been a guess:
//
//   `clientX/Y` and `screenX/Y` are FROZEN on every locked event - hand moves
//   and warps alike - so the position fields carry no signal at all.
//   `unadjustedMovement: true`, which would give raw device deltas that cannot
//   contain a teleport, is refused on this platform ("The options asked for in
//   this request are not supported"), and `pointerrawupdate` reports deltas
//   byte-identical to `mousemove`, warps included.
//   A warp's SIZE is meaningless: it is however far the cursor happened to be
//   parked from the lock's origin, so the same click delivered 1048 px in one
//   window and 310 px in another - under the fastest hand measured in a third.
//   Any bar drawn through those numbers is a bar the bug walks around, which is
//   what every threshold written here before did.
//
// What the trace DOES settle is a cause and a consequence. Every warp arrives on
// the first `mousemove` after a NON-MOVE event - a button, a lock change, a
// fullscreen change - because those are the moments Chromium re-bases the cursor
// position it subtracts. And every warp is eventually UNDONE, to within a pixel,
// by a later event carrying its inverse.
//
// So the rule below is causal and has no constants in it: a non-move event makes
// the next movement suspect, suspect movement is withheld instead of applied,
// and withheld movement is only ever released by an event that cancels it. Its
// worst case is losing one event of real hand travel - a few pixels, at the 7 ms
// spacing these arrive - where a size bar's worst case was the whole warp.

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
  // The virtual cursor, in view pixels. Null until the first mousemove that
  // actually MOVED: no pointer has been seen, which is not the same as one at
  // the top-left corner - and not the same as one the browser mentioned. A page
  // whose content moves under a stationary pointer (the loading screen coming
  // off, a resize) is told so with a mousemove carrying no movement at all, and
  // taking that for the player's first aim put a reticle on screen, and a
  // steering command under it, with nobody's hand on the mouse.
  private view: Vec2 | null = null;
  // How far it moved on the last mousemove, in view pixels.
  private lastMotion: Vec2 | null = null;
  // The real cursor as of the last mousemove, in view pixels. Unlocked, the
  // travel between two of them IS the mouse's motion - `movementX/Y` is the
  // browser's own answer to the same question, but the headless tooling's
  // synthetic events carry none, so the difference is what makes those events
  // moves.
  private lastReal: Vec2 | null = null;
  // How many movement events are SUSPECT: one per non-move event seen since the
  // last move, because each of those re-bases the position Chromium subtracts
  // (see the warp note above). Counted rather than flagged - a press, a lock
  // change and a fullscreen change can all land between two moves, and that is
  // three events of nonsense, not one.
  private suspect = 0;
  // The lock and fullscreen state as of the last event, compared on the next one
  // so each change is counted exactly once whichever order it is delivered in.
  private wasLocked = false;
  private wasFullscreen = false;
  // Movement withheld and not yet released, in view pixels. Null when there is
  // nothing outstanding.
  //
  // It is never applied on its own, only ever subtracted from a later event that
  // cancels it, which is what makes a stale one harmless: a withheld 1174 px can
  // only come back if a single event arrives within a pixel of -1174, and no hand
  // does that. A withheld 3 px can come back, and costs 3 px when it does.
  private withheld: Vec2 | null = null;

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
  // `seed` is where the virtual cursor is BORN, in view pixels, and passing one
  // is the statement that THIS RETICLE IS THE PAGE'S CURSOR: the game hides the
  // OS pointer for the ball controller and draws the reticle in its place, so
  // the reticle may start above the avatar (see `BallInputSource`) and travel by
  // the mouse's own steps from there, rather than appearing wherever the desktop
  // pointer had been left with the ball snapping to face it.
  //
  // Null - the default - is a page that still shows the desktop cursor, where
  // the aim has to stay UNDER it: no seed, and unlocked the virtual cursor
  // simply follows the real one, exactly as it always did. That is the grapple
  // controller (its canvas keeps a crosshair) and every test run from the editor
  // (its canvas keeps the arrow, and the cursor belongs to the editor around
  // it). A cursor of our own in either would be a second pointer disagreeing
  // with the one the player can see.
  constructor(
    private canvas: HTMLCanvasElement,
    private takeLock: boolean,
    private active: () => boolean = () => true,
    private seed: (() => Vec2 | null) | null = null,
  ) {
    // A button event re-bases the cursor position Chromium reports movement
    // against, so the movement event after one is not to be trusted (see the
    // warp note above): the release measured delivered 1174 px one millisecond
    // after its `mouseup`. Listened for in the CAPTURE phase so the count is
    // already right by the time that movement arrives, and registered whether or
    // not the lock is ever taken, because the press is a press either way. Lock
    // and fullscreen changes are NOT listened for - they are compared as state
    // in `update`, where the ordering cannot double-count them.
    const suspicious = (): void => {
      this.suspect++;
    };
    document.addEventListener("mousedown", suspicious, true);
    document.addEventListener("mouseup", suspicious, true);
    if (!takeLock) return;
    // Fullscreen or not, a click is the gesture the lock needs; `requestLock`
    // is what refuses it outside fullscreen. This is the ONLY path into the
    // lock under F11 and under the installed PWA, neither of which announces
    // itself with an event the moment it happens.
    canvas.addEventListener("mousedown", () => this.requestLock());
    // Leaving fullscreen gives the pointer back: the browser usually does that
    // itself, but a lock that outlived fullscreen would be exactly the windowed
    // capture this gating exists to prevent.
    //
    // ENTERING it asks for the lock too, and that is a backstop rather than the
    // way in. It reads as though it should be the way in - entering fullscreen
    // is a user gesture of its own - and measured in a real browser Chrome
    // refuses a lock requested from this handler every time (`The root document
    // of this element is not valid for pointer lock`), which is why the PLAY
    // press asks for itself instead (`requestLock(entering)`). Kept because it
    // costs nothing when the press has already succeeded (the identity test in
    // `requestLock` returns before asking) and because some way in has to exist
    // for a fullscreen this page did not start.
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
    // `clientX/clientY` means two different things either side of the lock -
    // the live cursor while unlocked, frozen at wherever the lock was taken
    // while locked - so the last real position is nonsense the moment the lock
    // changes, and the travel measured against it is a jump the width of the
    // screen. Dropped in both directions; the first event after a change
    // carries `movementX/Y` and nothing is lost.
    document.addEventListener("pointerlockchange", () => {
      this.lastReal = null;
    });
  }

  locked(): boolean {
    return typeof document !== "undefined" && document.pointerLockElement === this.canvas;
  }

  // Take the lock if it is wanted, allowed and not already held. Deliberately
  // WITHOUT `unadjustedMovement`: the point of the virtual cursor is to feel
  // like the desktop cursor it replaces, and the desktop cursor has the OS
  // pointer acceleration curve applied to it.
  // `entering` is "this call is part of the gesture that is taking the page
  // fullscreen": the request is made BEFORE the transition lands, so the
  // fullscreen test below cannot pass yet and must be skipped.
  //
  // It exists because the transition is the wrong moment to ask. Chrome refuses
  // a lock requested from the `fullscreenchange` handler outright - measured, in
  // a real browser, on every load: `The root document of this element is not
  // valid for pointer lock` - so the game opened fullscreen with the desktop
  // pointer loose in it and took the lock only when the player happened to click
  // the canvas. The press itself is the gesture a lock is granted to, and it is
  // the same press that is asking for fullscreen, so the two go together and the
  // policy is unchanged: the lock is still only ever taken for a fullscreen
  // page, and a fullscreen request that then fails gives it back (see
  // `main.ts`).
  requestLock(entering = false): void {
    if (!this.takeLock || !this.active() || typeof document === "undefined") return;
    if (!entering && !fullscreen(this.canvas)) return;
    if (document.pointerLockElement === this.canvas) return;
    // A refusal is SAID rather than swallowed. It is not fatal - the aim works
    // unlocked, and the next click on the canvas asks again - but it is the
    // difference between a game that opens with the pointer in hand and one
    // that opens with a desktop cursor loose in it, and a silent catch is why
    // that went unattributed (the browser's own reason is the whole message:
    // "a user gesture is required", a re-lock rate-limited after an Esc exit,
    // and a refusal from the platform read identically from here).
    void Promise.resolve(this.canvas.requestPointerLock()).catch((e: unknown) => {
      console.warn(`[lock] pointer lock refused: ${e instanceof Error ? e.message : String(e)}`);
    });
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
    // The mouse's own travel. Locked, `clientX/clientY` is frozen at wherever
    // the lock was taken and the deltas are the only motion there is; unlocked,
    // the step between two real positions is the same statement and survives an
    // event that carries no deltas. Both are CLIENT pixels where the view is the
    // fitted frame, so they are scaled by that fit - otherwise the cursor moved
    // at the window's scale rather than the view's, by a different amount on
    // every display.
    const perPx = viewPerClientPx(this.canvas);
    const deltas = new Vec2(e.movementX, e.movementY).mul(perPx);
    const locked = this.locked();
    let motion = !locked && this.lastReal ? real.sub(this.lastReal) : deltas;
    // Lock and fullscreen are read as STATE rather than listened for, and that is
    // what makes the count right. The move carrying a lock's own warp is
    // sometimes delivered before `pointerlockchange` (measured at t=2791 against
    // t=2796) and sometimes after it (t=2187 against t=2195), so a listener
    // counts one change twice in the second case and a comparison here counts it
    // once either way. Two changes with no move between them - the Play press,
    // which takes the lock and goes fullscreen together - are two events of
    // nonsense and count as two.
    const full = fullscreen(this.canvas);
    if (locked !== this.wasLocked) this.suspect++;
    if (full !== this.wasFullscreen) this.suspect++;
    this.wasLocked = locked;
    this.wasFullscreen = full;
    if (this.suspect > 0) {
      // Withheld rather than dropped, which is the whole of the rule. A warp and
      // the event that undoes it both land inside the withheld span and cancel
      // there, so neither is ever drawn; real hand travel that lands in the same
      // span is not thrown away, only deferred to the next event.
      this.suspect--;
      this.withheld = (this.withheld ?? Vec2.ZERO).add(motion);
      motion = Vec2.ZERO;
    } else if (this.withheld !== null) {
      // The first trustworthy event pays back whatever is left over. In a pair
      // that cancelled this is a pixel or two; nothing is invented and nothing is
      // lost.
      motion = motion.add(this.withheld);
      this.withheld = null;
    }
    // Only ever remembered while UNLOCKED, where it means something: locked,
    // `real` is the frozen point the lock was taken at, and keeping it would
    // leave a stale position for the first event after the lock ends to measure
    // a jump against (the `pointerlockchange` reset above is the other half of
    // this, for the transition the events do not announce).
    this.lastReal = this.locked() ? null : real;
    // A mousemove that did not move. The browser sends one whenever the page
    // moves under a stationary pointer, and before the first real move there is
    // no cursor yet - so this one is not the player aiming, and answering it
    // would put the reticle (and the steering under it) wherever the desktop
    // pointer happened to be sitting when the level loaded.
    if (this.view === null && motion.x === 0 && motion.y === 0) return;
    // A cursor of our own is one the page has hidden the desktop pointer for
    // (see `seed`). Without that the aim must stay under the pointer the player
    // can still see - `position` mode, which is kept for exactly this
    // comparison, the grapple controller, and a test run from the editor - so
    // the real cursor is followed outright, unseeded and unbounded.
    if (!this.takeLock || this.seed === null) {
      if (!this.locked()) {
        this.lastMotion = this.view ? real.sub(this.view) : null;
        this.view = real;
        return;
      }
      // Locked, `clientX/clientY` is frozen wherever the lock was taken, so the
      // deltas are the only motion there is and the frame is the only bound.
      this.lastMotion = motion;
      this.view = clampToFrame((this.view ?? real).add(motion));
      return;
    }
    // The virtual cursor moves by the mouse's travel from where it already is -
    // locked or not, so the windowed feel is the fullscreen one and both are
    // bounded by the play frame rather than by a window edge. Its FIRST position
    // is the seed's (the avatar's own head for the ball controller), which is
    // what makes the first move of a fresh page start from the player rather
    // than from wherever the pointer had been left.
    this.lastMotion = motion;
    this.view = clampToFrame((this.view ?? this.seed() ?? real).add(motion));
  }

  // The virtual cursor in view pixels, or null before the first mousemove.
  position(): Vec2 | null {
    return this.view;
  }

  // Bring the cursor into being where it would have been born, without a move.
  // A CLICK is a player saying something about where they are aiming, so it has
  // to leave an aim behind: pressing with nothing on screen and having nothing
  // appear reads as a dead button, and the press deploys the chain, so the one
  // thing the player cannot be left without is a mark saying where it went.
  //
  // Nothing for a pointer with no seed (the grapple controller, a test in the
  // editor): there the desktop cursor is the one on screen and it never went
  // anywhere.
  reveal(): void {
    if (this.view !== null || this.seed === null) return;
    const at = this.seed();
    if (at !== null) this.view = clampToFrame(at);
  }

  // The last mousemove's travel in view pixels, or null when there was nothing to
  // measure from (the first move). Unlocked this is cursor travel, which is what
  // synthetic events from the headless tooling produce, since they carry no
  // `movementX/Y` and never hold the lock.
  motion(): Vec2 | null {
    return this.lastMotion;
  }
}
