# Running

```sh
cd rope
bun install
bun run dev        # http://localhost:3100
```

Controls (match the Godot input map): **R/T** move · **Space** jump · **left-click** fire
hook · **right-click** retract-tug · **C** retract · **S** extend · **1/2** spawn circles ·
**P** download a replayable session bundle (stamped with the TREE it was
recorded on - see below) ·
Gamepad (standard mapping, merged with keyboard/mouse): **left stick/dpad** move ·
**A** jump · **right stick** aim (rendered crosshair) · **RT** fire · **LT** retract-tug ·
**RB/LB** retract/extend · **X/Y** spawn circles ·
**L** toggle the debug overlay (render-only). It shows ledge-grab markers (green marker +
dashed grab-radius circle = grabbable now, hollow red = candidate rotated out of reach,
grey X = seam-occluded, face ticks colored by floor/wall/ceiling classification) and an
arrow for the surface normal the player is currently touching (grounded/wall surface, or
both ledge faces while hanging/climbing), colored by the same classification.

A downloaded bundle carries the identity of the **source that was served**, not
the last commit before the dev server started: `git` (short commit), `dirty`, and
`srcHash`, a hash over the contents of every file under `src/` and `levels/`
(`src/sim/treeStamp.ts`, served to the page as `virtual:tree-stamp` and
recomputed whenever the watcher sees a change).
`__GIT_COMMIT__` was `git rev-parse` evaluated once at Vite config load, which is
a statement about when the server was *started*: on 2026-09-04 seven bundles all
said `f0ed27a` while the served tree changed hourly, and two "still broken"
recordings turned out to be of code that had already been reverted - found by
rebuilding variants in a worktree, which is an afternoon spent learning what the
bundle should have said itself.
Every replaying CLI command prints `tree: match`, `tree: MISMATCH (bundle …,
here …)` or `tree: unknown` (a bundle from before the stamp) on its header.
The committed corpus is *expected* to read MISMATCH: those bundles are
deliberately historical, and `cli bundles` therefore does not repeat it per row.

`?render=2d` / `?render=3d` picks the renderer (see [**3D rendering**](render3d.md)): the ball
level plays in 3D by default and the grapple levels stay 2D, and `?render=2d` is
the escape hatch anywhere. `?probe3d=1` draws the alignment probe.

Pick a level with `?level=NAME` (see `src/level/registry.ts`); `TEST_MOVERS` /
`TEST_WINDMILL` are hand-written mover test levels (sliding platform, windmill),
`TEST_SWING`, `TEST_SPIN` and `TEST_LIFT` are the AUTHORED ones (two pendulums to
time a crossing against; two counter-turning crosses and a sail on an authored
bearing; and a lift, a looping trolley and an eased shuttle - see
[**Scripted movers**](movers.md)),
and `TEST_SPRING` is the spring-body one (a leaf over a chasm to hang off - see
[**Spring bodies**](pivot-and-spring-bodies.md#spring-bodies)); `TEST_VINES` hangs three vines over a chasm to swing across
(see [**Vines**](vines.md)).
`LEVEL_2` is the grapple arena (the Godot-extracted scene).

## Ball controls and aim

The chain deploys
through the **loop** — a fixed
material point on the rim (top of the ball at rotation 0). Aiming rotates the
ball so the loop faces the aim direction (proportional steering — also while
the chain is out, which winds it around the ball); the shot always leaves
through the loop. A stick-released frame encodes its aim point as the ball's
own position ("not aiming"). Controls (mouse + gamepad + touch, most-recent aim device
wins): mouse move aim / click deploy chain (**any** mouse button - left, middle
or right; the chain is the only thing the mouse does here, so there is nothing
for a second button to mean, and the right button's context menu and the middle
button's `auxclick` are both suppressed on the canvas); left
stick aim, RB deploy chain, top face button (X on a Pro Controller)
restart; on touch, the bottom-left on-screen joystick aims (deflect past the
deadzone to steer the loop, like the left stick) and the bottom-right circular
DEPLOY button deploys (no touch restart - reload the page).
Deploy is hold-to-keep: releasing it drops the chain. The touch controls only
appear on a coarse primary pointer (`(pointer: coarse)`), so desktop and
mouse-primary touchscreen laptops get none.
The OS cursor is hidden on the ball controller; a black **aim reticle** stands in
for it, drawn by `renderBall` from `BallInputSource.aimPoint()` (the same aim the
FrameInput carries, null when nothing aims).
Every device writes one piece of state, `aimLocal` - the aim point as an offset
from the ball, in metres. A deflected left stick or on-screen joystick writes it
at exactly the chain's reach (`CHAIN_MAX_LENGTH`).
The mouse has three aim modes behind `AIM_MODE` in `input/aimPointer.ts`, shared
by both controllers (default **cursor**, overridable per session with
`?aim=position` / `?aim=cursor` / `?aim=motion` so the three can be compared by
feel without a rebuild):
- **cursor** (default): the aim point is `AimPointer`'s **virtual** cursor's
  screen position, un-projected through the *current* camera every time it is
  read (`currentAimLocal`).
  Clicking the canvas takes **pointer lock in fullscreen only** (Esc releases it,
  the next click takes it back; entering fullscreen through the Fullscreen API
  takes it without a click, that being a user gesture of its own, and leaving
  fullscreen by either route gives the pointer back), and while locked the
  virtual cursor is integrated from `movementX/Y` and held inside the 1920x1080
  play frame, so aim carries on past the edge of the screen.
  Unlocked the virtual cursor *is* the real one, so windowed this mode and
  `position` are the same picture.

  Fullscreen is detected two ways, because there are two ways in.
  The Fullscreen API sets `document.fullscreenElement`, which must contain the
  canvas for the *game* to be what fills the screen.
  F11 and the installed PWA's `display: fullscreen` set no element at all and
  fire no `fullscreenchange`; they show up only as `(display-mode: fullscreen)`,
  which Chromium 142 does match for a plain F11 (verified through CDP
  `Browser.setWindowBounds` with `windowState: "fullscreen"`, no fullscreen
  element, media query true).
  Entering that way carries no user gesture, so the lock cannot be requested at
  the media query's `change` and the first click takes it instead; the `change`
  going the other way is what releases it, since no `fullscreenchange` will.

  Windowed the pointer is left alone, for two reasons pointing the same way.
  The window edge is a boundary the player can see and walk back from, and other
  windows are a mouse-move away, so capturing the cursor to fix an edge nobody
  was pushing against costs an Esc for nothing.
  And windowed is where the lock is unsafe on this machine: Chromium's Wayland
  pointer location drifts out of the page under lock and presses that hit-test
  onto the caption or a resize border are eaten (see [**Dropped clicks**](input-latch.md),
  where playing fullscreen is one of the two workarounds).
  This gating is that workaround, made the default.
- **position**: the aim point is the **real** cursor's screen position,
  un-projected through the *current* camera every time it is read
  (`currentAimLocal`), unbounded - the reticle is exactly where the pointer is, a
  drawn stand-in for the hidden OS cursor and nothing more.
  Re-deriving it per read rather than freezing it at mousemove time is what keeps
  it there: held as an offset from the ball, a camera pan, ease or zoom slid the
  reticle across the screen with no hand on the mouse - the cursor visibly
  drifting on its own. Motion aim is exempt (the offset *is* the state, and under
  pointer lock there may be no cursor on screen), as are stick and joystick aim,
  which are ball-relative directions by definition.
  This is the mode with the **edges** in it, and the reason the other two exist:
  aim stops at the edge of the window, and at the edge of the screen in
  fullscreen, because that is where the real cursor stops.
  Only the second of those is fixed now that the lock is fullscreen-only, which
  is the one that was worth fixing: past the screen edge there is nowhere else
  for the hand to be going.
  It is the only mode that never touches the pointer, kept so the lock modes can
  still be compared against the behaviour they replaced.
- **motion**: `aimLocal` accumulates each mousemove's delta (metres at the
  current zoom) and is held within the reach.
  It takes the same lock as `cursor`; the difference is only where the bound
  lives, in the world at the reach rather than on screen at the frame.
  The first move (and the first after another device owned aim) seeds `aimLocal`
  from the real cursor position.

Pointer lock is the only fix for the edges, and only the *first* edge is a
listener problem: past the screen edge the cursor genuinely stopped moving, so no
listener anywhere could have seen more.
Bounding a **virtual** cursor is free, which is the thing worth knowing.
Clamping a *real* cursor's projection is what motion aim was originally written
to avoid: past the boundary the drawn dot stops while the real cursor keeps
travelling outward, so coming back inward does nothing until it re-enters, dead
travel the player cannot see since the cursor is hidden.
A virtual cursor never accumulates past its bound, so it moves inward on the
first pixel back - which is why `cursor` can bound a position mapping and keep
the feel motion aim gave up.
The lock is requested **without** `unadjustedMovement`: the virtual cursor is
meant to feel like the desktop cursor it replaces, and that one has the OS
pointer acceleration curve on it.
On the grapple controller the OS cursor *is* the aim indicator, so under lock
`LiveInputSource.crosshairAim()` hands the renderer a crosshair to draw in its
place (the same one the right stick gets); the ball controller already hides the
cursor and draws its reticle either way.
`BALL_ZOOM` is a plain constant: the view is a fixed 16:9 frame scaled to fit the
window (see [**The view**](camera.md#the-view)), so a landscape phone gets the same framing as a
desktop at a smaller size rather than a smaller slice of the level.
It used to be height-driven, capped at the desktop zoom, which is what let a
short viewport still frame the ball and its chain arc.
The page is an installable full-screen web app (`public/manifest.webmanifest`
with `display: fullscreen`, plus `apple-mobile-web-app-*` metas for iOS and
`viewport-fit=cover`): added to a phone's home screen it launches without
browser chrome. Restart routes
through the `jump`
FrameInput field so it stays in the recorded input stream (BallLevel calls
onReset). Ball inputs map onto the existing FrameInput fields
(aim→mouseWorldPosition, shoot→fire, restart→jump), so
recordings serialize and every headless tool works unchanged - `cli continue`
(`--hold deploy`, `--aim X,Y`) and playtest scripts drive the ball through those
same fields under its own action names.
