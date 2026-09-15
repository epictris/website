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

## Starting a run

A page opens on the loading screen, and the level starts on a **PLAY** press: when the assets are in the bar is replaced by a button, and the frame loop begins on the click (see [**The loading screen**](loading-screen.md)).
The press is what buys fullscreen and, through it, the pointer lock - both are gestures a browser grants only to a click - so the game opens filling the screen with the cursor in hand.
The button is focused, so Enter or Space works; a refused fullscreen still plays windowed.
Nothing is waiting on the press but the press: the level is downloaded, warmed and prewarmed behind the screen before the button appears.

A test run from the editor has no loading screen and no gate - it is the editor's canvas and the editor's cursor, and starts the moment ▶ Test is pressed.

## Checkpoints

`?checkpoint=NAME` starts the run at a **named spawn** in the level instead of at its own spawn (`CheckpointData` in `levelFormat.ts`), which is how an area halfway through a level is playtested without swinging out to it first.
A killzone reset comes back to the same place: the name is resolved once, in `main.ts`, and the level every reset rebuilds is built from the moved `player` - so the whole session is a session of a level whose spawn is somewhere else.
That is the whole of what a checkpoint is. It carries no pose, no velocity and no chain state, because "start here" is what a spawn already means, and a run from one is an ordinary run of a moved level rather than a second kind of run.
It moves the point and nothing else, so a level whose spawn starts on its anchor (`hang`, see [**The spawn anchor**](ball-coil-and-hook.md#the-spawn-anchor)) still throws the chain up from wherever the checkpoint put it - and starts on the ground where there is nothing overhead within reach, which is the same answer the level's own spawn would get there.

The name is matched **trimmed and ignoring case**, since it is typed into an address bar from memory; one that matches nothing leaves the spawn alone and says so in the console, with the names that would have worked.
A blank name and a repeat of an earlier one are dropped at load with a warning - neither can be asked for.

Checkpoints are authored in the editor, on the notes layer (see [**Notes and checkpoints**](editor-model.md#notes-and-checkpoints)), and selecting one and pressing **▶ Test** runs the test from it.

A recorded run says which checkpoint it started from: a bundle names its level rather than embedding it, so `Recording.checkpoint` is what keeps a replay from starting at the level's own spawn and diverging on its first frame.
Production runs carry it in their session metadata (see [**Production recording**](production-recording.md)) and the sealed bundle gets it from there.

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
Deploy is hold-to-keep: releasing it drops the chain.
A press with a chain **already out re-throws it** at wherever the aim is now, which is the toggle grip's meaning under this one too.
Under hold-to-keep the only chain that can be out when a press arrives is one the player never threw - the chain a `hang` spawn opens the level on (see [**The spawn anchor**](ball-coil-and-hook.md#the-spawn-anchor)) - and without the re-throw the press said nothing and only the release spoke, so the first click read as detaching the chain the player was hanging from.

`?toggle_click=true` swaps the mouse's half of that for a two-button toggle, so the two grips can be compared by feel without a rebuild (`TOGGLE_CLICK` in `input/ballInput.ts`).
A left or middle press attaches the chain and it stays attached with the hand off the button; a right press detaches it.
Pressing again with the chain already out redeploys it at the current aim, so a re-throw is the same button and not a detach first.
Only the mouse changes: the pad's RB and the on-screen DEPLOY button stay hold-to-keep, and they merge with the toggle exactly as they always did (the chain is out while any of them says so), so a toggled-on chain is not dropped by a pad button nobody is holding.
Nothing downstream of the input source knows about the flag - the sim still sees the same `fire` level it would have seen from a held button, so recordings and replays are unaffected.

The touch controls only
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
  The **PLAY press takes the pointer lock** along with fullscreen (see [**Starting a run**](#starting-a-run)), and clicking the canvas takes it in **fullscreen only** thereafter - Esc releases it and the next click takes it back, and leaving fullscreen by either route gives the pointer back.
  The press asks for the lock *itself*, first, before requesting fullscreen: asked from the `fullscreenchange` that follows instead - which reads as though it should work, entering fullscreen being a user gesture of its own - Chrome refuses it every time (`The root document of this element is not valid for pointer lock`, measured in a real browser on first loads and refreshes alike), and the game opened fullscreen with the desktop pointer loose in it until the player happened to click the canvas.
  A refused fullscreen gives the lock straight back, since a lock in a *window* is the one thing it is never allowed to be.
  While locked the
  virtual cursor is integrated from `movementX/Y` and held inside the 1920x1080
  play frame, so aim carries on past the edge of the screen.
  Unlocked it moves by the same travel, read off the real cursor's own steps, and is held inside the same frame - so a window plays like fullscreen and the two differ only in how far the hand can go before the desktop pointer runs out of screen.
  (It used to *be* the real cursor while unlocked, which made windowed `cursor` and `position` the same picture and left the reticle no way to start anywhere but under the desktop pointer.)

  **The cursor is born above the avatar, on the first mouse move of the page.**
  Nothing is drawn before that: the PLAY press takes the desktop cursor off the page, and the reticle appears only once the mouse has actually moved - so a run that has just started shows no cursor at all until the player touches the mouse.
  (Up to the press the desktop cursor is untouched: the gate is a button, and a button is aimed at with the pointer the player can see.)
  A mousemove carrying *no movement* does not count, which is the one a browser sends when the page shifts under a stationary pointer (the loading screen coming off): answering it put a reticle on screen, and a steering command under it, with nobody's hand on the mouse.
  The first real move seeds the virtual cursor `AIM_SEED_ABOVE` (0.5 m) straight above the ball and travels from there - and so does a **click**, because a press throws the chain and a throw with no mark saying where it went reads as a dead button (`AimPointer.reveal`).

  **A warp is not a move, and nothing on the event says which it is.**
  Taking the lock, going fullscreen and releasing a click all teleport the cursor, and Chromium reports the teleport as `movementX/Y`.
  Traced with every field an event carries, on a real mouse: a release at `t=3480` was followed one millisecond later by `(1174,98)` and, on the player's next movement 518 ms after that, by `(-1173,-98)`; the Play press gave `(1280,30)` between its lock change and its fullscreen change, and `(-1279,-30)` on the move after.
  Integrated, that is a reticle that jumps a screen-width and snaps back when the player moves again.

  Three things that trace settles, each of which had been guessed at before it was measured.
  `clientX/Y` and `screenX/Y` are **frozen** on every locked event, hand moves and warps alike, so the position fields carry no signal.
  `unadjustedMovement: true` - raw device deltas, which cannot contain a teleport - is refused on this platform, and `pointerrawupdate` reports deltas byte-identical to `mousemove`.
  And a warp's **size means nothing**: it is however far the cursor was parked from the lock's origin, so the same click delivered 1048 px in one window and 310 px in another, under the fastest hand measured in a third.
  Every threshold written here before was a bar the bug walked around at a different window size.

  So the rule is causal and has no constants in it (`AimPointer.update`).
  A non-move event - a button, a lock change, a fullscreen change - re-bases the position Chromium subtracts, so it makes one movement event **suspect**; suspect movement is *withheld* rather than applied, and the first trustworthy event pays back whatever is left over.
  A warp and the event undoing it both land inside the withheld span and cancel there, so neither is ever drawn, while real hand travel in the same span is deferred by an event or two rather than lost.
  Lock and fullscreen are compared as **state** inside `update` rather than listened for, because the move carrying a lock's warp is sometimes delivered before `pointerlockchange` and sometimes after it, and a listener counts one change twice in the second case.
  Above, because the offset is a direction before it is a distance: the loop faces the aim, so a cursor born anywhere else turns the ball to face it the moment it appears - and up is where the loop already points, and where a `hang` spawn's chain still runs.

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
