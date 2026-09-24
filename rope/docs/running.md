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
`?retract=1` turns on the released chain reeling back in ([chain-retract](chain-retract.md)); off, a let-go chain vanishes as it always did. `cli shot --retract` is the same switch for a filmstrip.
`?paint=0` turns off the painted light ([lighting-and-surfaces](lighting-and-surfaces.md#painted-light)) for the session, which is how a change to it is judged: the same frame painted and not. `cli shot --query paint=0` is the same switch headless.
**F4** captures the camera as JSON for `cli shot --view`, so a report about a spot in the level is a replayable grab.
The frame is drawn at 1920x1080 device pixels at most, whatever the display: past that a player is paying for fragments rather than seeing more, and the browser scales the result up to the window. `?dpr=N` overrides that (clamped to 4) and is how the renderer's FILL cost is measured from a 1080p desk - the picture is identical and only the fragment count behind it changes, so `?dpr=2` on 1080p pays what an uncapped 4K player used to. Debug only - see [**Testing a weaker GPU**](debugging-rendering.md#testing-a-weaker-gpu).

Pick a level with `?level=NAME` (see `src/level/registry.ts`); `TEST_MOVERS` /
`TEST_WINDMILL` are hand-written mover test levels (sliding platform, windmill),
`TEST_SWING`, `TEST_SPIN` and `TEST_LIFT` are the AUTHORED ones (two pendulums to
time a crossing against; two counter-turning crosses and a sail on an authored
bearing; and a lift, a looping trolley and an eased shuttle - see
[**Scripted movers**](movers.md)),
and `TEST_SPRING` is the spring-body one (a leaf over a chasm to hang off - see
[**Spring bodies**](pivot-and-spring-bodies.md#spring-bodies)); `TEST_VINES` hangs three vines over a chasm to swing across
(see [**Vines**](vines.md)).
`CAMERA_TEST` is the camera sandbox: two rooms overlapping by exactly the width of their `falloff` band, so the hand-over is an exact cross-fade, and a priority island past them that takes the camera outright (see [**Camera**](camera.md#blending)).
`BREAK_TEST` is the breakable sandbox: a stair up to a ceiling to swing from, and under it a row of ledges at a few thresholds and durabilities over a drop to the stone floor (see [**Breakable geometry**](breakable.md)).
`LEVEL_2` is the grapple arena (the Godot-extracted scene).

## Starting a run

`/` with nothing asked for is the **level select** (see [**Levels**](levels.md)): a list of the listed levels, the introduction first, with what this browser has finished and last rated beside each.
Picking one puts the game fullscreen, takes the pointer, pushes `/?level=ID` and starts the level in that same page - one page load is still one session and one level.
That page never loads the game until a level is picked, so a bare `/` costs a list of words rather than a megabyte of three.js; a `?level=` nobody has shows the same list with a line saying so.

A level page opens on the loading screen and **starts when the level is ready** - the bar fills, the scene is warmed and prewarmed behind it, and the frame loop begins (see [**The loading screen**](loading-screen.md)).
There is no second press between choosing a level and playing it.

**The press that picks the level takes fullscreen and the pointer lock**, in that order - the lock first, while the gesture is unspent, then fullscreen - so a run started from the menu opens filling the screen with the virtual cursor already live (see [**The level select**](levels.md#the-level-select) for why that press cannot also be a navigation).
A level reached any other way - its own URL, a new tab, a reload - opens **windowed**, aiming with the real pointer, and the **first click in the level** takes both instead: it is the click that throws the first hook, so nothing is asked of the player they were not about to do.
A refused fullscreen gives the lock straight back and plays windowed, which is what the whole gate exists to guarantee: the lock is never held outside fullscreen.

A test run from the editor has no loading screen and no gate - it is the editor's canvas and the editor's cursor, and starts the moment ▶ Test is pressed.

## Ending one

A listed level ends at a **finish line** (see [**The finish line**](levels.md#the-finish-line)): a chequered gantry across the way out, which finishes the level the moment you touch it, swinging through or rolling into it.
The sim then runs half a second more so the ball carries out the far side and **freezes** - nothing reaches into the level, so a **P** download taken afterwards still replays and finishes on the same frame - the pointer comes back, and a panel appears over the frozen scene with what the run took and three ways on: **Retry**, **Next Level** and **Menu** (see [**The completion panel**](levels.md#the-completion-panel)).
Retry rebuilds the level in the page, so the screen and the run are not spent on a reload.
The level is marked as finished on this browser whichever way it is left, and a finished row can be re-rated from its `rate` link on the level select.
The panel also asks for **feedback** - five stars for fun, a five-point bipolar difficulty scale and a comment, all optional - on the first crossing and on any later one where nothing has been sent yet; sending does not close the panel.
The run is sealed with the end reason `complete`, which is its own reason because it is neither a failure nor an interruption.

In the editor's ▶ Test a crossing raises a toast and the test carries on: what is being judged there is where the line is.

## Watching a replay

`?replay=NAME` plays a recorded session's input stream through the real frame loop instead of live input: same fixed step, same renderer, same digests.
It is how a recorded complaint is reproduced on the live page - with `?hud=1` reading where the frames go - and how a production run is watched (`?replay=prod/<id>` for a pulled one, `?replay=run:<id>` straight from the store, which is what `/admin`'s **Watch** button opens; see [**Production recording**](production-recording.md)).
Any bundle works, including every one recorded before the transport existed: a recording is a flat list of frames, and that is all the transport reads.

The page is a transport, drawn along the bottom of the frame (`render/replayHud.ts`):

| | |
|---|---|
| **space** | play / pause |
| **←** / **→** | seek a second back or forward (**shift**: ten seconds) |
| **,** / **.** | step one frame back or forward, pausing |
| **[** / **]** | slower / faster, through 0.1x 0.25x 0.5x 1x 2x 4x 8x 16x |
| **home** / **end** | the first frame / the last |
| click or drag the bar | seek to the frame under the pointer |

Under 1x the renderer interpolates between steps rather than showing each one several times; over it the loop takes several steps per rendered frame, up to five more than the speed itself asks for, past which a machine that cannot keep up plays slower than it was asked to rather than banking the debt (the same trade the live loop makes).
The bar also carries the frame under the pointer, and a tick for every **run boundary** it has passed through (see below).

**Seeking is re-simulation, not rewinding** (`sim/replayTransport.ts`).
The sim has no reverse step and no state snapshot, so the only way to be at frame N is to have stepped N times from a build - exactly what `cli render --frame N` does headlessly, which is why a seek lands bit-identically on the frame the recording played and on the frame the tools describe.
Forward is therefore free and backward costs the frames between a build and the target, paid off across rendered frames under a budget (24 ms each) so the page keeps answering the pointer while it rewinds; a 2500-frame bundle re-simulates in well under a second.
A run that ended in a reset is a fresh build, so the transport remembers where each run began and a seek inside the current run never pays for the runs before it.
Nothing about this reaches the sim: the recorded inputs are fed in the recorded order whatever the transport is doing, and speed, pausing and seeking only decide *when* a step runs.

While a seek passes through frames, the sparks, the debris and the reeling chain are not fed, and the scene is not rebuilt: they are of the frames being skipped, not of the frame being landed on, and they are put back where the seek lands.

A replay keeps the OS cursor and takes no pointer lock - the reticle on screen is the *recorded* player's aim, and the pointer is the hand on the bar.
`window.__replay` is a live handle on the transport, the way `window.__perf` is one on the perf probe, so a script can pause, seek and read where it landed without going through the keyboard.

Every build during a replay is the **recording's**, including the one a reset makes: a bundle that carries its own geometry (an editor export) or started from a checkpoint would otherwise carry on against whatever level the URL named, and the frames after the reset would be evidence about nothing.

`cli transport` is the transport's case suite (which frame a seek lands on, and how much it had to re-simulate to get there).

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
- **cursor** (default): the aim point is `AimPointer`'s cursor's screen position,
  un-projected through the *current* camera every time it is read
  (`currentAimLocal`) - the **virtual** cursor in fullscreen, where the lock is
  held, and the real pointer in a window, where it is not.
  The **press that picks the level takes the pointer lock** along with fullscreen, and the first click in the level does it for a run that started any other way (see [**Starting a run**](#starting-a-run)); clicking the canvas takes it in **fullscreen only** thereafter - Esc releases it and the next click takes it back, and leaving fullscreen by either route gives the pointer back.
  That click asks for the lock *itself*, first, before requesting fullscreen: asked from the `fullscreenchange` that follows instead - which reads as though it should work, entering fullscreen being a user gesture of its own - Chrome refuses it every time (`The root document of this element is not valid for pointer lock`, measured in a real browser on first loads and refreshes alike), and the game opened fullscreen with the desktop pointer loose in it until the player happened to click the canvas.
  A refused fullscreen gives the lock straight back, since a lock in a *window* is the one thing it is never allowed to be.
  While locked the
  virtual cursor is integrated from `movementX/Y` and held inside the 1920x1080
  play frame, so aim carries on past the edge of the screen.

  **Unlocked there is no virtual cursor at all**: the aim is the real pointer's own position, unseeded and unbounded, which is the picture `position` draws.
  A window is therefore `position` with the reticle drawn on it, and the modes come apart only in fullscreen.
  It was briefly the other way - with a seed the cursor travelled by the mouse's steps whether or not the lock was held, so that a window would feel like fullscreen - and what that produced was a windowed game with two pointers and no way to see the one that mattered.
  Measured on this machine (a probe page driving the real `AimPointer` through CDP): eleven 20 px steps from an unlocked start left the reticle at view (1452, 700) with the real pointer at (985, 738).
  The press the player aims with lands 467 px from the mark they aimed it by, every step widens the gap, and the pointer they cannot see is the one deciding whether the click reaches the canvas at all - it can be out over the letterbox bars, or off the window, while the reticle sits mid-frame.
  Bounding the drawn cursor to the frame is what *guarantees* the gap: the real one keeps going where the drawn one may not.

  **The desktop cursor stays hidden either way**, windowed included: the reticle is the ball controller's only pointer, and windowed it is now drawn *on* the real one, so there is a single mark on screen and the clicks land under it.
  It is hidden rather than shown as a crosshair beneath the ring because two marks for one pointer is what the reticle exists to avoid - and the crosshair the canvas carries in CSS is the grapple controller's, which has no reticle of its own.

  **The run opens with a reticle, never without one - and with the ball already facing it.**
  A cursor has no position until an event carries one, and a ball with no aim is a ball whose rotation belongs to the physics, so a run used to open unaimed and stay that way until the player's first mouse move.
  Measured on `BALL`, whose ball opens on a ledge: 0 to 14.5 radians over the first 100 frames, `kinematicRotation` false throughout - two and a third revolutions of tumbling loop, ending in a snap to face whatever the first move said.
  So the cursor is PARKED when the run opens (`BallInputSource.openRun`, called from `boot` and from a Retry), and drawn from the first frame.

  **A level starting never moves the cursor and never hides it** (2026-09-23, asked for by Tris).
  It used to: the lock re-seeded the virtual cursor `AIM_SEED_ABOVE` (0.5 m) above the ball, a level's opening hid the reticle until it handed the ball over, and the hand-over parked it above the ball again and showed it as the announcement that the ball was the player's.
  All of that is gone.
  The reticle stands in for the hidden OS pointer, and a pointer that jumps somewhere of the game's choosing, or vanishes while the ball rolls in, is a pointer the player has lost.
  The reticle is drawn through an opening too, even though the sim drops the aim until the hand-over.

  **Where the cursor is born is where the desktop pointer last was** (`AimPointer.birthplace`), locked or not.
  Unlocked the cursor IS the desktop pointer, and where that is is a fact about the desktop rather than ours to choose: born anywhere else, a reticle standing in for a hidden OS pointer would be lying about where the player's clicks will land.
  Locked, `clientX/Y` froze at the capture point, which is the same place: where the desktop pointer was when the lock took it.
  A park under the lock with a virtual cursor already in hand keeps that cursor, since the capture point is where the lock was taken and not where the hand has steered since.
  The page has been noting that position since it parsed (`watchPointer` in `render3d/store.ts`), because nothing in the app is listening early enough - the press that picks a level is the last event before the run opens, and the app is booted from inside its handler - so what the birth reads is the pointer crossing the menu and the press that started the level.
  A page nobody has touched - one loaded straight at `?level=`, with the mouse outside the window - has no position to offer, and the seed (`AIM_SEED_ABOVE` straight above the ball) stands in.
  That note keeps the same warp rule the pointer does (below), and for a measured reason: a press on a menu row at (640, 412) is followed one event later by `move 0,0 m=(-650,-509)`, and taken at face value it opens the level aiming at the top-left corner of the page.

  **An aim is also a grip**, so a run that opens aiming opens braked: the ball holds where the level put it instead of rolling off under its own weight (`BALL` again - 1.6 m of roll and 1.3 m of drop unaimed, nothing at all with the cursor above it; measured before the cursor stopped being placed there).
  It is the game's own rule seen at frame 1 rather than a new one: a cursor held over the ball is how a player stops it rolling at any other moment of a run.
  A level that wants an opening the ball rolls through wants an opening the player's hands are OFF (see [**The rolling entry**](ball-rolling.md#the-rolling-entry)).

  **A press is itself a position** - `clientX/Y` is live on it, and the hand that made it is pointing at something - so a press is an aim wherever on the page it lands (`AimPointer.reveal`, called from the document-level press listener so a press on a letterbox bar counts too).
  It is what brings a cursor into being on a page whose pointer has never been seen, and what ends a park: the aim has been used, so it is the player's from there.
  The `pointerlockchange` that confirms a capture re-seeds the cursor at its birthplace (the capture point) for the lock that lands AFTER a level has opened, and only while the aim is still the game's own: once the player has moved the mouse, the reticle is theirs, and a re-lock after an Esc leaves it where they put it.
  (Up to the press that picks a level the desktop cursor is untouched: the menu is a list of links, and a link is aimed at with the pointer the player can see.)

  **A level's opening hands the ball over with the cursor where it is.**
  Nothing is re-parked at the hand-over: wherever the player's hand rested through the opening is where the aim is when the ball becomes theirs.
  While the cursor is parked it is re-taken every poll (`BallInputSource.rideParked`); windowed that is what keeps the mark under a hand crossing the letterbox bars, whose moves reach the page and not the canvas, and under the lock the birthplace does not move so the ride holds it still.

  **A mousemove carrying *no movement* is a position, not a move** - the one a browser sends when the page shifts under a stationary pointer (the loading screen coming off, the fullscreen transition).
  Unlocked it is answered, because unlocked the reticle stands on the real pointer and where that pointer is sitting is exactly what the event says.
  Locked it is refused, because there `clientX/Y` is frozen at the point the capture was made from: answering it would drag the virtual cursor - and the steering under it - off to wherever the desktop pointer happened to be when the lock was taken.

  **A warp is not a move, and nothing on the event says which it is.**
  Taking the lock, going fullscreen and releasing a click all teleport the cursor, and Chromium reports the teleport as `movementX/Y`.
  Traced with every field an event carries, on a real mouse: a release at `t=3480` was followed one millisecond later by `(1174,98)` and, on the player's next movement 518 ms after that, by `(-1173,-98)`; the press that took the lock gave `(1280,30)` between its lock change and its fullscreen change, and `(-1279,-30)` on the move after.
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

  Windowed the pointer is left alone - and so, therefore, is the aim, which is
  read straight off it - for two reasons pointing the same way.
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
  The first is what `cursor` and `motion` now do *too* in a window, on purpose:
  the fix for a window edge is to stop pushing against it, and the alternative -
  a drawn cursor that carries on while the real one does not - is two pointers
  disagreeing.
  It is the only mode that never touches the pointer even in fullscreen, kept so
  the lock modes can still be compared against the behaviour they replaced.
- **motion**: `aimLocal` accumulates each mousemove's delta (metres at the
  current zoom) and is held within the reach.
  It takes the same lock as `cursor`; the difference is only where the bound
  lives, in the world at the reach rather than on screen at the frame.
  The first move (and the first after another device owned aim) seeds `aimLocal`
  from the real cursor position.
  It is the one mode that still travels in a **window**, where the desktop
  pointer is visible and can therefore be somewhere else: that is the mode's own
  definition rather than an oversight, and it is the reason it is opt-in.
  Compare it fullscreen, where the pointer it would disagree with is gone.

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
