# Camera

## The view

The game is drawn into a **fixed 1920 × 1080 frame** scaled to fit the window (`render/viewport.ts`), not into the window itself.
Every layer above the canvas - the camera, the renderer, pointer un-projection - works in those **view pixels** and never sees the window's real size; the window decides one thing, how large the frame is drawn.
It is centred, scaled by the tighter axis, and what is left over on the other axis is background: letterbox bars on a 4:3 display, pillarbox bars on a phone.

Framing is the reason, and it is not cosmetic.
A camera region's `viewportScale` says *how much world is on screen*, and that can only mean something if "the screen" is a fixed shape - sized off the window, a tall monitor saw further up and down than a laptop and a phone in landscape saw a different level again, so a room framed by eye in the editor was framed differently for everyone who played it.
1920 × 1080 because that is what the zoom constants are read on: at that size the frame is 1:1, and it is why `BALL_ZOOM` could stop being height-driven.

`ViewTransform` (a scale plus the frame's origin, in the target's pixels) is the whole interface, and it carries the display's DPR folded into its scale, so the renderer takes one argument for where the frame is and how big.
The same value describes the frame in **client** pixels, which is what `clientToView` un-projects a pointer through: one arithmetic for drawing the frame and for reading a click on it, rather than two that can disagree by a letterbox bar.
It also means the frame does not have to *be* the canvas - the editor's ▶ Test fits it into the whole editor canvas and paints the bars itself (`LETTERBOX_COLOR`), so a level is tested in the frame it will be played in.
The touch controls are positioned inside the frame rather than the window for the same reason.

`cli shot` asks headless chromium for a window 87px taller than the frame, since that is what the browser keeps for itself, so a grab is exactly the frame with no bars.

`render/cameraController.ts` owns the view: a **sprung follow** of the avatar, reshaped by the level's **camera regions** and **camera paths**.
It is deliberately render-side, driven by the wall-clock frame `dt` rather than the fixed timestep, so moving it can never change a recorded run.
(The grapple controller un-projects the cursor through the camera, so the camera does reach the sim as *input* — but the trace records the resulting world point, so replays stay bit-identical.)
`camera.zoom` is the controller's **output**; the base framing scale lives in the caller (`GRAPPLE_ZOOM`, or `BALL_ZOOM` for the ball).
The default framing puts the avatar **dead centre** for both controllers — the ball's old 3/5-down shift is gone — so shifting the view is a camera region's `offsetX`/`offsetY` and nothing else, one authored mechanism rather than a per-controller rule.

## Three layers

The controller is three layers, each smooth in its inputs, so that no rule upstream can jerk the screen:

1. **Progress** (`render/pathProgress.ts`) - where along its route the camera thinks the player is, as a soft projection rather than a nearest point. See [camera-paths](camera-paths.md#the-soft-projection).
2. **Framing** (`cameraRuleTarget`, `blendCameraTarget`) - the authored idea: a path's lead at the zoom keyed there, a region's lock, offset and scale, blended by weight with the plain follow taking the unclaimed share. Piecewise, and allowed to be.
3. **Motion** - one critically damped spring with an acceleration cap, and the only thing that ever writes the camera's position and zoom.

The third is load-bearing, and it is what a pile of local smoothing rules was replaced by on 2026-09-22.
The old controller computed a memoryless piecewise target every frame and put one first-order ease (`CAMERA_FOLLOW_TAU`, 0.15 s) between it and the screen.
Every piecewise rule is a **step in the target's velocity** - the vertex projection, the window edge, both edges of the lead deadband, the ratchet engaging, the pin opening and dropping, the branch challenge, the frozen-delta hand-off - and a first-order ease at 0.15 s attenuates a 3 Hz disturbance by about a third, so every one of them leaked to the screen.
Most of the 1976-line file was machinery trying to keep each rule individually continuous, which is the wrong place for that guarantee; what is left is 1961 lines of controller and 204 of progress, the deletions having been spent again on writing down why each of them went.

```
CAMERA_FREQ       = 1.2 Hz     omega = 2*pi*CAMERA_FREQ
CAMERA_MAX_ACCEL  = 8  m/s²
CAMERA_MAX_SPEED  = 12 m/s
```

Per frame, per axis, with `e = aim - pos`: the exact closed-form step of the critically damped spring over `dt` (`x(dt) = (x + (v + omega*x)*dt) * exp(-omega*dt)`, with `x = -e`), then the resulting velocity CHANGE clamped **per axis** to `CAMERA_MAX_ACCEL * dt`, the speed clamped to `CAMERA_MAX_SPEED` as a vector length, then the position integrated from the clamped velocity.

The acceleration clamp is per axis and the speed clamp is not, which is worth the asymmetry it looks like.
A cap taken as a vector length rations both axes by one factor `k`, so **an axis that needs to stop is rationed by an axis that wants to pull**, and that is a real defect rather than a tidy invariant: landing a 12 m/s fling in `session-726f` ran at `k ~ 0.12` for sixty unbroken frames with the x axis asking to brake at 32 m/s² and being handed 6.
Both axes overshot, a quarter cycle apart, so the camera looped over the avatar and came back down - reported as "it does a weird counterclockwise loop".
Scaling is also what makes a capped spring bouncy rather than slow: `x'' = k(-omega²x - 2*omega*v)` is a spring of frequency `omega*sqrt(k)` and damping ratio **`sqrt(k)`**, so at `k = 0.12` the one property the layer is built on is down to 0.35 whatever else is going on.
Per axis, each axis is the one-dimensional capped spring, which closes an error of up to `8a/omega²` - 2.25 m, more than the framing ever asks for - without overshooting at all.
The price is honest and small: on a perfect diagonal the magnitude can reach `sqrt(2)` times the cap, so what the layer promises is 11.3 m/s² rather than 8.
`no-axis-is-rationed-by-the-other` is the case, and it is red under the vector clamp.
Closed form because it is exact for every `dt`, which is the frame-rate independence `1 - exp(-dt/tau)` had; `dt` is clamped to 0.1 s first, because a hitched frame is a frame the wall clock spent elsewhere and not one the camera may fly across the level in.
Zoom goes through the same spring in `log(zoom)`, the geometric blend every zoom transition here already uses.
`snap()` places the spring at its aim **at rest** (level start and reset), where carrying a velocity over would be a swoop across the level.

What this buys is a **global** guarantee: whatever any rule upstream does, the camera's acceleration is bounded and its velocity is continuous.
Measured on the exact aim signal the old ease was chasing, over the two 2026-09-22 river bundles:

| tail of session | first-order 0.15 s (the old) | this |
|---|---|---|
| 268f peak accel / jerk | 16 / 1533 | **7.6 / 102** |
| 336f peak accel / jerk | 55 / 2152 | **8.4 / 204** |

(Anything over 8 is the hard floor, which is not capped and may not be - see [the screen-edge guarantee](#the-screen-edge-guarantee).)

Two things are **outside** the cap, and both are worth knowing before reading a ride's peak.

The floor is one, by design. The other is the window's own pull in `holdEdge`, which is given at `edgeTakeUp`'s rate law and is not bounded by anything: on a landing it hands the avatar's own impact straight to the camera, since the demand is a function of where the avatar IS and their velocity steps to zero in a frame. `session-222f` reads 34 m/s² and 2162 m/s³ on the frame the ball hits the water. That is not new - the same landing on the camera this replaced reads 48 m/s² - and it is the largest hole left in the bounded-acceleration claim.

A THIRD was found by play and fixed: the guarantee used to write its correction back into the spring's velocity ("the camera really is where the constraint put it"), and since the window's half of it pulls a fraction of its demand every frame, that turned a position correction into a speed and accumulated it. Over the eleven frames of one fall the camera's acceleration ran 18, 35, 50, 62, 67 m/s² and it arrived at the landing carrying 6.8 m/s; the cap is symmetric, so shedding that took 0.85 s and the camera sailed nearly three metres **below the ground** before coming back (`session-222f`, reported from a play). The guarantee is positional recovery and does not feed the velocity - the same rule the contact solver follows, for the same reason.

That guarantee is what the following mechanisms were each trying to provide locally, and they are **gone**:

- the **frozen-delta hand-off** (`offset`, `zoomRatio`, `setBlend`, `CAMERA_BLEND_TIME`, and the region and path `blend` fields). When the rule set changed, the gap between what the outgoing set wanted and what the incoming one wants was frozen and smoothstepped to zero on top of the incoming target. A rule change is a step in the aim, and a step in the aim is a bounded swell. What is lost is real and worth naming: the blend was tunable per rule and the swell is not, so a room that wanted a slow deliberate crossing can no longer buy one. What is gained is one timescale in the camera's motion rather than two fighting over the same frames - which is what made the old one unpredictable, since which of the two you got depended on whether a rule identity happened to change.
- the **branch challenge's hand-off half** (see [camera-paths](camera-paths.md#the-soft-projection)).
- the **first-order ease** itself, and `CAMERA_FOLLOW_TAU`.

The one number worth carrying over: a critically damped spring trails a target moving at a steady speed by `2 * v / omega`, which is 0.80 m at 3 m/s where the old ease's `v * tau` was 0.45 m.
The camera is a little further behind at speed and cannot turn faster than 8 m/s² at all, which is what the floor below is for.

The **cap binds in real play**, and that is stated here rather than discovered: a hard swing on a short line is 30 m/s² of centripetal acceleration, which the camera cannot hold, so the guarantee below does bind on hard swings.
It bound on a third of the frames of `session-336f` before this change too, for a different reason (the path's lead), so what changed is the cause and not the frequency.
`edge-binds-only-when-the-camera-is-outrun` asserts both halves: inert inside the cap, and the avatar still never in the edge band past it.

What the camera follows is the level's `cameraRenderPosition`, which is the avatar on every frame but one kind: while a ball is **rolling in** at the opening of a level it is the SPAWN, the point the ball is rolling to (see [ball-rolling](ball-rolling.md#the-rolling-entry)).
The camera therefore stands still while the ball comes into the frame, and takes the ball over a couple of centimetres from where it was already looking.
It is this machinery reading a different anchor rather than a rule of its own: regions, paths, priorities and the blend all see that point and are none the wiser.

## Render interpolation

The sim is a fixed 60 Hz, so drawing its raw state on a 120/144 Hz display repeats and skips frames, which reads as jitter - most visible on the ball at the end of a fast swing.
Every rendered frame therefore draws **between** two sim states: `World.captureRenderTransforms()` runs at the top of each level's `physicsProcess` (before anything moves), and the renderer takes an `alpha` = leftover accumulator ÷ step, clamped to 1 so a frame that hit `MAX_STEPS_PER_FRAME` never extrapolates past the current state.
`CollisionObject2D.renderPosition/renderRotation/renderShape(alpha)` are the whole interface; rotation interpolates the short way round (`wrapAngle`) so a body crossing ±π does not unwind a full turn.
The captured transform is **render-only state the sim never reads**, which is what makes this safe: `replay selftest` stays bit-identical.

Derived geometry follows the same rule rather than being lerped as a shape:

- The rope/chain is drawn from its wrap **nodes**, not the resolved spans. A node is a point in its body's local frame (`RopeContact.renderGlobalPosition`), so re-resolving it against the render transform keeps the chain welded to the drawn ball and the drawn hook — resolved spans would leave it visibly detached between steps.
- The player rig stores its limbs as offsets from the player, so interpolating the whole rig is interpolating one anchor point (`lastP`).
- The ball's loop (and the chain leaving it) comes from `renderLoopCenter/renderLoopDirection`, the same derivation against the interpolated pose.
- The camera follows `cameraRenderPosition(alpha)`, not the raw sim position: tracking the 60 Hz position while the avatar draws interpolated would put the jitter straight back, on screen.

The debug overlay (L) deliberately keeps drawing the **exact** sim state — it exists to show what the simulation believes, so a frame of render smoothing has no business in it.

A **camera region** (`CameraRegionData` in `levelFormat.ts`, its own `cameraRegions` list rather than a `BodyKind`, since it has no collision and nothing may wrap it) computes the target per axis:

```
target.x = lockX ?? (avatar.x + offsetX)
target.y = lockY ?? (avatar.y + offsetY)
zoom     = baseZoom / viewportScale
```

Per-axis locking is what makes one primitive cover all three asks: both axes locked is a fixed camera, one axis locked is a shaft or corridor that pins one and follows the other, neither locked is an offset follow.
`offsetX/offsetY` only apply to the axes that still follow, and `viewportScale` is *how much world is on screen* (2 = twice as much, zoomed out), so it divides the zoom and blends geometrically — 1→4 passes through 2, not 2.5.
Which regions are in force is `priority` and the buffer (below); the region in force keeps its grip until the avatar leaves it by its **`buffer`** - `REGION_EXIT_MARGIN` (15 cm) when it authors none, which is sized for jitter alone: without that much hysteresis, hovering on a boundary re-triggers the cross-fade every frame and the camera stutters.
Regions are invisible in play, so the **debug overlay** (L) draws every volume and fills the ones in force: a camera that offsets, zooms or pins otherwise has no on-screen cause.
The fill is by **weight**, so what a region is tinted is the share of the framing on screen that belongs to it, and two regions blending look like it.
It takes the set from the controller rather than recomputing it, because the grip depends on which regions held the camera last frame - a recomputed answer disagrees with the camera across the whole width of the buffer, which is exactly what the overlay is opened to see.
Each active region's buffer draws with it, as a finely dotted outline: the region holds the camera out to there, so without it a region that refuses to let go looks like a bug.
Nothing is drawn at the inner edge of a `falloff` band, deliberately: the weight is a ramp rather than a boundary, and a line across it would suggest a place the camera changes character, which is the one thing the smoothstep exists to avoid.

## Blending

Several rules can govern the camera at once, and the camera is the **weighted blend** of what each of them asks for (`activeCameraRules`, `ruleWeight`, `blendCameraTarget`).

**Priority decides who is even in the conversation.** The lowest `priority` in force wins and everything ranked worse is silenced outright; rules tied at that number blend with each other.
Lowest-wins reads as ranking rather than as a score, and 0 being the default means authoring a priority is always a statement about beating something rather than about joining it.
The silencing is deliberately absolute - a priority is the escape hatch for a framing that must not be diluted (a boss arena inside a region that covers the whole level), and a priority that only *weighted* a rule would be a second, weaker kind of blend with nothing to distinguish it from the first.

**Weight decides how much of the camera each of them gets.** A region's weight is 1 wherever it applies, unless it authors a **`falloff`** band: then it ramps from 1 at `falloff` metres inside its boundary down to 0 at the boundary itself, smoothstepped.
The band is measured **inward** because the volume an author draws is the extent of the region's claim - a band outside it would be a second, larger volume that starts framing the room before the player is in it, which is exactly what the buffer is careful not to be.
A path's `falloffX/falloffY` is the same idea pointing the other way, and has to: a path's authored geometry is the line at the middle of its claim rather than the edge of it.

Whatever share the rules do not claim goes to the **plain follow** - the avatar at the base zoom - which is what makes a lone room with a band fade out to the default camera rather than to nothing, and is the mechanism a path's falloff band already was.
Weights summing past 1 (two bandless regions overlapping) are **normalised**, so that case is an even average rather than an arbitrary winner; under 1 they are not, because the difference is the plain follow's share and normalising it away is what would make a band mean nothing.
Positions blend linearly and zooms geometrically, as every zoom blend here does.

The authoring rule that falls out of it: **overlap two rooms by the width of their band and the hand-over is an exact cross-fade.**
`smoothstep(t) + smoothstep(1-t) = 1`, so across an overlap exactly as wide as the band the two weights sum to 1 everywhere - no share leaks back to the plain follow on the way across, and the camera sweeps from one room's framing to the other's without stopping or reversing.
A room that must frame right out to its own walls authors no band, and the crossing is then a step in the aim, which the motion layer answers at a bounded acceleration - smooth, but not authorable.

Only **one path** can be in the set: the projection, the lead deadband and the branch window are all state about one polyline, so among tied paths the seat goes to the one already being ridden, and to the last in the list otherwise.
That is the only thing authoring order still decides; regions tied at the winning rank all blend, however they are ordered.

## Buffer

`buffer` is how far outside its own volume a region will follow the avatar before giving the camera up, and it is the answer to swinging.
A player on one attachment point crosses a boundary twice a swing and hands the camera over each time; a buffer wide enough to cover the far side of the arc keeps one camera for the whole thing.
It is pure geometry - no easing, no filtering, no rope state - so it behaves identically at any swing speed and any frame rate, and an author sets it by looking at how far out of the room the arc actually reaches.

Only *leaving* is buffered.
A region joins the set the moment the avatar is inside it, so the buffer reads as "how far out of this room I may stray without the camera changing its mind" rather than as a second, larger volume that grabs the camera early from outside.

A buffer holds a region **in the set**, which at equal priority means it blends with whatever the avatar has actually crossed into rather than shutting it out.
Swinging out of room A into room B, the camera is both of them for as long as the arc stays inside A's buffer, and the blend is a constant while it does - the weights do not depend on which way the swing is going, so there is nothing to flip twice a swing, which is the thing the buffer exists to prevent.
What it no longer does is keep the camera *purely* A's out there; an author who wants that says so with `priority`, and one who wants the crossing itself to be gradual says so with `falloff`.

A **rect** region may state one buffer per side instead - `bufferLeft`, `bufferRight`, `bufferTop`, `bufferBottom` - because a room is rarely symmetrical and the arc out of one usually reaches far past one wall and barely past the other, which a single number can only cover by being that wide in all four directions (and a buffer that wide is a region that will not let go).
Sides are the region's **own**, in its local frame - left/right are ∓x and top/bottom are ∓y, so a rotated region's "top" turns with it - and each falls back to `buffer`, which falls back to `REGION_EXIT_MARGIN`, so authoring one side leaves the other three exactly as they were and every level authored before the fields loads unchanged.
A circle has no sides and a polygon's growth is a signed-distance offset with no axis to hang them on (see `pathOutlineGrown`), so both ignore the fields and take `buffer` alone; the editor offers them to rects only rather than showing four controls that do nothing.
`pathOutlineGrown` grows a rect per side for the same reason it grew it per axis before - that is literally what `pointInRegion` tests - so the dotted outline in the editor and the overlay is exactly the volume the region holds by, which is the whole point of drawing it while it is being authored by eye.

`priority` still overrides the grip, and is the escape hatch a wide buffer needs: a small, deliberately-framed volume sitting inside a big buffered one has no other way to take the camera *alone*, and saying so explicitly beats shrinking the buffer until the overlap happens to work out.
The consequence to author around is that leaving that priority island drops to whatever contains the avatar *then* - a buffer belongs to the rules in force, and the island silenced the enclosing region on entry, so the enclosing region's buffer is not what is holding on the way out.

## The screen-edge guarantee

Whatever rule is in force, the avatar may never enter the outer **`CAMERA_EDGE_MARGIN`** of the frame, on either axis.
It is the one camera rule with no authored override, and deliberately: a level may frame the avatar however it likes, and none of those framings is allowed to be "off the bottom of the screen".
At 0 the floor is the frame's own edge, so what it guarantees is that the avatar's *centre* is on screen.

It is a clamp on **where the camera IS**, applied last in `update` and to the controller's own `pos` rather than to the target.
A target the avatar can outrun is not a guarantee, and outrunning the camera is exactly what a launch does - and what any turn past `CAMERA_MAX_ACCEL` does.
Clamping `this.pos` rather than only what is handed to the `Camera` is also what keeps the next frame continuous, since the camera really is where the constraint put it and carries on from there; when the floor moves the camera the spring's velocity is set to what the frame **actually** moved, so the next frame is not spent pressing against a constraint that has already won.

**The law is a window, a rate, and a floor**, and that is what its parameters are - three for the guarantee, and two for how its pull is given back once it stops being asked for:

| parameter | what it sets |
|---|---|
| `CAMERA_EDGE_MARGIN` (0) | where the avatar may never go, as a fraction of the frame |
| `CAMERA_EDGE_INNER_X` (0.1125), `CAMERA_EDGE_INNER_Y` (0.2) | the target minimum distance from the edge, as a fraction of that axis's own extent |
| `CAMERA_EDGE_SMOOTHING` (0.3) | how fast the camera corrects toward that margin when there is room, in seconds |
| `CAMERA_STICK_TAU` (1.5 s) | how long its pull lasts once it stops being asked for (see **The stick**) |
| `CAMERA_STICK_RELEASE` (0.4 m/s) | the rate on top of that, which is what makes the pull **end** - before the camera does, so it is not a second motion |

All of them are **global** and deliberately not authorable, for the reason the margin always was: what the guarantee does is a property of the game rather than of a room in it.
`edgeReach` turns the fractions into the distances a given camera allows - the avatar may never pass `edgeReach(margin)`, and `innerReach` is the margin they are held to - `edgeOffset` is the window, and `edgeTakeUp` is the clock.

The whole of the window is one line:

```
allowed(d) = min(d, inner)
```

Inside the inner margin the guarantee is not there at all and the level's framing is honoured exactly.
Outside it the camera is moved until the avatar is **at** the margin - not near it - and the only question the parameters answer is how fast.
There is no third regime in between, and that is the property everything else is built to protect: the inner margin is where the avatar **rests** during every excursion, in every room, under every rule.

The distance between the inner margin and the floor is **transient headroom**, not a second framing.
It is the room a correction is allowed to still be running in, and `edgeTakeUp` spends it faster the less of it is left.

An asymptotic give-way used to live in that gap: the override engaged at the inner line and handed the ground over on an exponential, so the avatar settled *somewhere* between the two lines depending on how much the rule in force was asking for.
It is gone because that is exactly what a minimum distance from the edge may not do.
Measured on `session-368f`, the same parameter read as a different margin in every room - 19.7% of the frame from the edge under a path asking for 1.68 m of offset, 26.7% under a region asking for 0.88 m - and no value of it could fix that, because the variation *was* the mechanism.
What the give-way was there for is smoothness, and smoothness belongs to the clock below, which delivers it without the window having to be soft.

A bare clamp **given outright** is a discontinuity in the camera's **velocity**, which is the one thing a camera may not have.
Up to the line the camera is easing toward whatever the level asked for; one frame later it is rigidly locked to the avatar, travelling at exactly their speed.
Nothing about the position jumps, which is what makes it hard to see coming, and it is felt as the camera being caught and dragged - again every time a swing crosses back out, which is twice an arc.

**Given over the clock it is not**, and that is why the window is allowed to be a hard clamp.
The demand at the margin is zero and grows from there, so the correction grows out of nothing rather than starting; the camera's velocity is continuous across the crossing; and the camera position is a first-order approach to the margin, which is what the player sees - eased back to the inner margin over about a fifth of a second, and resting exactly on it when they stop.

**It runs in two places, and that is what makes it smooth.**
The window shapes what the camera is **AIMING** at, so the camera answers it through the same exponential ease it answers everything else with; the same window plus the hard floor is then applied to where the camera actually **IS**, because an aim can be outrun and the guarantee may not be.
Applied to the position alone - which is where it started - the override can only ever be a correction, so the camera's velocity is whatever the correction happens to need that frame.
On a backswing that is a **reversal**: the lead is ratcheted forward, so the camera is still advancing into a lead the avatar has already left, and the override is not slowing it down, it is turning it round.

And the pull is **given at a rate set by how much of it is owed**, not on a fixed delay - `CAMERA_EDGE_SMOOTHING` is the seconds a correction takes when there is headroom for it.
The demand is the excess over the inner margin exactly, so twice as far past it is twice the demand - and more than twice the correction, because the rate itself rises with how much of the headroom that demand has eaten.
Nothing at all happens at the margin itself, and the correction fades out as it finishes rather than ending, the thing driving it being the thing being consumed.

The rate is divided by how much of the **headroom** the demand has eaten, so it diverges as the last of it goes and **the floor is never reached at all**.
The floor is a rigid clamp - a camera held on it moves at exactly the avatar's speed and stops dead the frame they come back inside - so a rate that can be outrun is one that guarantees the harshest thing the guarantee can do.
A fixed delay always can be, at any length, and a longer one makes it more certain.

The correction is therefore **flat in time**: the time constant shrinks in proportion to the gap left to the floor, and so does the distance to close, so a correction takes about as long whatever provoked it - an avatar a centimetre from the floor is answered at 29 m/s and still takes 0.87 s, the same as one a tenth of the way in.

An **exponent** on the headroom term was tried and rejected by play, and is worth not re-inventing.
Squared, the rate outruns the distance, so the camera gives way softly while there is room and closes outright when there is not - 1.06 m/s against 1.02 a tenth of the way into the headroom, 22.6 against 11.9 at three quarters, and 63.4 against 28.9 at the last hundredth, closing there in 0.52 s rather than 0.87 s.
What it buys is all in the last quarter of the headroom, which ordinary play never reaches - `session-368f` spends a quarter of it at its worst - and what it costs is paid everywhere, because the correction's character then changes with depth: the same excursion is answered differently depending on how far the framing in force had already pushed the avatar, which is the complaint the window itself exists to fix.

What the rate does *not* do is decide where the avatar rests, which is the window's job alone.
What it decides is how far past the margin a **sustained** excursion rides while it is still running: the correction settles where its rate matches the speed it is answering, so walked out of a locked room at 3, 4.8, 9 and 18 m/s the camera spends 23%, 34%, 51% and 61% of the headroom, and a quarter of it is still unspent at a launch.
Stop moving at any of those speeds and all four close onto the margin itself.

**The override holds NO STATE**, and that is the part to not undo.
The obvious shape for a delayed correction is to remember how much of the pull has been given and take up the rest on a clock, and the flaw is that a pull is a *displacement* held against a geometry that moves.
A swing turns and the window stops asking within a handful of frames while the held pull is still most of its old size, so the camera goes on being dragged for a third of a second after the reason for it has gone - and then whatever bounds the pull cuts the remainder off in one frame, which is felt as the camera jerking to a stop at the end of a correction.
Nothing is lost by dropping it, because **the camera position is already the integrator**: a fraction of the demand applied to `this.pos` every frame *is* a first-order approach to the inner margin, accumulating in the thing being corrected, where it cannot go stale.
An aim is rebuilt from the rule every frame and holds nothing, so there the window is given outright or it would be permanently weakened rather than delayed - with the anchored pin as the one exception, being state and accumulating exactly as the position does.

How the pull is **delivered** was chosen by measurement, as worst camera **acceleration and JERK** - which is what "harsh" is - over two recorded swings and a walk out of a locked room, in m/s² and m/s³.
These four were measured with the give-way still in place, and what they establish is the delivery, which the window did not change:

| | `session-118f` | `session-137f` | walking out |
|---|---|---|---|
| bare clamp, given outright | 127 / 8044 | 103 / 6148 | 288 / 17280 |
| the pull, given outright | 65 / 4412 | 25 / 972 | 36 / 886 |
| the pull, on a held pull | 141 / 8479 | 26 / 972 | 30 / 278 |
| **the pull, at this rate, 0.15 s** | **19 / 1462** | **17 / 972** | **14 / 179** |

The held-pull row is the design the rate replaced and the `118f` column is why: stale, it made the override **harsher than the bare clamp it exists to soften**.
What is left in the last row is not the override at all - 1462 is the lead ratchet engaging on the frame the chain goes taut and 972 is the lookahead deadband letting go, both of them steps in the *target's* velocity rather than in the camera's answer to it.

Removing the give-way was measured the same way, on `session-368f`, against the give-way at the tuning it was last played at:

| | worst accel | worst jerk | where the avatar sat |
|---|---|---|---|
| the give-way (ease 0.4 on y) | 33 | 1823 | 11.3% .. 28.5% from the edge |
| **the window (inner 0.2 on y)** | **43** | **2347** | **14.5% .. 24.2%** |

That is the trade, and it is the one worth making: the spread in where the avatar sits nearly halves, and what is left of it is a correction still running rather than a different framing per room, while the correction gets about a third firmer because the demand is now the whole excess rather than a fraction of it.
`CAMERA_EDGE_SMOOTHING` is the knob for that firmness, and it is monotone in both directions on the same session: 0.10 s reads 50 / 2735 and rides to 15.6%, 0.15 s reads 43 / 2347 and 14.5%, 0.20 s reads 39 / 2126 and 13.8%, 0.30 s reads 34 / 1873 and 12.8%.
Softer is calmer and rides deeper; the floor is what bounds how deep, and at these numbers nothing is close to it.

It is bounded ABOVE by the headroom and the speeds in play: past what the headroom can absorb the rate rides the barrier and the camera is turned over hard rather than carried, so much longer than a fifth of a second is the sign the **inner margin** is too close to the floor for the speeds rather than that the rate is too slow.

A **shape** knob was tried on the give-way first and removed, and it is worth not re-inventing even though the curve it shaped is gone.
The family `1 - (1+uk)**(-1/k)` holds both end conditions for every `k` and looks like a free choice of tail, but its curvature at the join is `-(1+k)`: a longer tail is a *sharper* bend exactly where the override engages, so the knob ran the wrong way (23, 29, 44, 77 m/s² of peak acceleration for `k` = 0.01, 1, 4, 20 on `session-137f`) and every value of it was worse than `k = 0`.
What it was reaching for is a rate, and a rate is a clock - which is the same conclusion the give-way itself reached in the end.

Two things fall out that are worth knowing before tuning it.
An **authored framing that puts the avatar past the inner margin is trimmed to it** - the override is engaged, so it is doing its job - which is why `rule-path-lookahead-is-per-axis` and the lead-band cases run with the clamp off: those are about what the lead ASKS for, and a 2.5 m lead on a 9.6 m frame is already outside the margin.
And the **stick holds the inner margin** rather than the floor, since what it holds is the pull the window asked for and the window only ever asks the avatar back to the inner line.

An axis the override is not touching is returned **as it came in** rather than rebuilt from the follow point: `follow + (pos - follow)` is not `pos` in floats, so rebuilding it moves the camera by an ULP on every frame of ordinary play and reports the override as engaged on all of them - which is what the overlay draws and what the stick holds.

`cli camera` asserts the window (untouched inside the margin, held exactly on it at every depth outside, monotone, never past the floor) and then what it does to a camera: a locked room walked steadily out of has no step in the camera's speed at the crossing and ends up carried at exactly the avatar's speed; an anchored swing on a ratcheted lead - `session-137f`'s own shape - is turned over rather than reversed, at under a third of the bare clamp's peak acceleration and without the floor ever being reached; the rate shows as the avatar being allowed further toward the line while the correction comes on, but never as far as it; a deeper incursion is corrected more than proportionally faster and the margin itself corrects nothing; a stroll, a hard run and a launch all ride deeper the faster they go and all stay inside half the headroom; and each of the three, stood still, **comes to rest exactly on the inner margin**, which is the claim the whole law exists to make.
Every part of it is load-bearing under ablation: `CAMERA_EDGE_SMOOTHING = 0` reddens two cases, dropping the headroom out of the rate five, and giving the window outright on the position reddens the floor case.

The margin is a **fraction of the frame** rather than a distance, because what is being constrained is where the avatar is ON SCREEN: a region that zooms out shows more world, and a margin in metres would shrink to a sliver of the frame exactly where the frame got roomier.
It is measured to the follow POINT, so it has to clear the avatar's own radius and leave something worth seeing - 77 cm either side and 43 cm above and below on the 9.6 x 5.4 m a 1080p frame shows at `GRAPPLE_ZOOM`.

It is **inert while the camera can keep up**, which is what makes it safe to apply globally.
The default camera centres the avatar, so the only thing that can put it near the edge under the plain follow is outrunning the camera - which now means two things rather than one: the spring's steady-state lag of `2 * speed / omega`, which takes a sustained ~18 m/s to bind, and CAMERA_MAX_ACCEL, past which the camera cannot turn with the avatar at all.
A hard swing on a short line is around 30 m/s² of centripetal acceleration, so it does bind there - and that is the guarantee doing its job rather than failing at it: the avatar is held at the inner margin instead of leaving the frame.
What it also bites on is a locked region the avatar has left, and a path whose lookahead aims the camera well off them.
`cli camera` asserts all of it - the two holding cases, a one-frame teleport, and `edge-binds-only-when-the-camera-is-outrun`'s two halves - and each of the holding cases is red without the clamp.

### The stick

**The window's pull decays rather than stopping** (`CAMERA_STICK_TAU`, 1.5 s, per axis).

A swing that carries the avatar out of the frame carries them out twice an arc, so the clamp binds, releases and binds again for as long as they hang there - and if each release let the aim snap home, the camera would rock for the whole swing with an amplitude set by how far the guarantee had to move it.
So the aim is the window's answer **outright while it is asking**, exactly as it always was, and when the window stops asking the aim returns to the rule's target over a second and a half instead of on the next frame.

It is per **axis** because the window is: a swing that drops the avatar out of the bottom of the frame has said nothing about the horizontal lead, and holding x for it would freeze the route the camera is narrating.

**It holds the largest recent demand on that side**, and that is the part measurement moved.
The obvious form - the stick IS the demand while there is one, and decays once there is not - buys nothing at all, because the demand is itself continuous: it falls smoothly to zero as the avatar comes back inside the inner margin, so by the frame it stops being asked there is nothing left to decay, and the camera returns at exactly the pace the avatar does.
Holding the extreme of the arc instead is what decays under the avatar as they swing back.
A demand on the **other** side replaces the hold outright rather than blending with it - the window has just said the camera is wrong the other way, and continuing to hold it the old way is the one thing the guarantee may not do - and that step is the motion layer's to absorb.

**It is a release, not a decay**: on top of the fraction per second, `CAMERA_STICK_RELEASE` (0.4 m/s) is subtracted, so the hold reaches zero rather than approaching it, in `TAU * ln(1 + s / (RELEASE * TAU))` seconds - 0.9 s for half a metre.
An exponential never arrives, and the last centimetres of one are the worst motion a camera can be making: a slow, steady, unmotivated drift of the whole screen at a moment when the player has stopped and everything else on it is still.
Half a metre of stick left at the end of a fling is 8 cm/s two seconds later and 2 cm/s five seconds later, which is what `session-726f` reported as the camera taking about five seconds to settle after hitting the ground.
It was still giving the stick back.

The rate is set so the hold is gone **before the camera comes to rest**, which is what stops it being a *second* motion.
That is what `session-538f` reported on the same landing: the camera spent 0.7 s settling onto the aim the stick was still displacing - a point 0.17 m past where it was going to end up - and then another second and a half creeping back off it.
"It would make more sense for the initial up motion to just move towards the final resting place."
At 0.4 m/s the half-metre hold is gone in the same 0.9 s the camera spends arriving, so there is one motion and it lands on its mark.

Nothing was traded for it, which is worth recording because the long tail was supposed to be what bought the swing its steadiness.
Over the five bundles the stick shapes - including `session-702f`, which charges it 107 times and peaks at 2.05 m - the avatar's total variation in the frame gets slightly **better** at every rate from 0.1 to 1.6 m/s, and the cost is a few per cent of camera acceleration (`session-821f`, the calmest of them, is the worst at 1.41 to 1.66 m/s²).
What the swing wants is the **hold**, which is unchanged; the tail after it was doing nothing but drifting.

#### What it replaced, and why

The **anchored latch** (`latchX`/`latchY`): while the avatar was anchored, the point the clamp forced became a pin, kept for the rest of the episode and moved only when the clamp forced it further.
It worked, and it cost four mechanisms to keep working:

- a **deadband** (`CAMERA_LATCH_BUFFER`), because a pin re-pulled every frame walked in a centimetre an arc and never came back out - 9 cm of horizontal and 11 cm of vertical creep over `session-546f`'s ten arcs, and 91 cm of *wobble* if the deadband was applied to only one half of the guarantee;
- an **opening clock** (`LATCH_OPEN_TAU`), because a pin born deep past the margin switched a tenth of a metre of demand off in one frame: 112 m/s² against 26;
- an **episode** to belong to, and a frozen-delta hand-off to give the pin back with when the anchor released;
- a **wind release** (`windProgress` against the path's `windBuffer`, plus `windArmed`, `sinceWind`, `WIND_REARM_DELAY` and `WIND_REST_RATE`), because a player winding themselves up the line toward an anchor ahead is going the level's way and a camera pinned to the backswing trails them up the climb.

Every one of those is a patch for the pin being a **latch** - a state with an edge, which has to be entered, held and handed back.
A decaying pull has no edge, so all four go:

- nothing has to be handed back when the anchor releases;
- nothing creeps, because a decaying stick moves outward on its own and there is nothing for a deadband to stop;
- nothing has to open on a clock;
- **winding up the line needs no special case at all**: the player moves toward the middle of the frame, the window stops asking, and the stick decays while the spring glides the camera forward to its lead.

It is also **not gated on being anchored**, and does not need to be: the guarantee is inert in ordinary play, and where it does bind a slow return is at worst a calmer camera.
The lead **ratchet** stays gated on anchored (see [**The anchored episode**](camera-paths.md#the-anchored-episode)), because that one is about backtracking along the route rather than about the edge of the frame.

The guarantee still **outranks the ratchet** and is outranked by nothing: with the lead ratcheted the target stays forward while the avatar swings back, so far enough back and the guarantee hauls the camera after them, down the track and against the ratchet's whole bias.

`cli camera` asserts the stick's two facts, and each is red both ways under ablation (no clock, and no hold): `stick-holds-after-the-ask-stops` measures the release law itself half a tau and one tau after the window goes quiet, that the hold and the camera both outlast the spring's own 0.3 s settle, and that it is finished by the time the law says where a bare exponential would still be giving back; `stick-decays-when-nothing-asks` measures that it reaches zero and the camera is back on the room's lock.
No bar is put on how much of the return happens by a given second, because that is the release rate and the release rate is a feel constant.

Played through four rounds as of 2026-09-22 (`session-222f`, `session-684f`, `session-726f`, `session-538f`); the feel constants (`CAMERA_FREQ`, `CAMERA_MAX_ACCEL`, `CAMERA_STICK_TAU`, `CAMERA_STICK_RELEASE`) are tuned in the play and nowhere else.

The debug overlay draws the keep-out box **only on the frames it is binding** (amber, not the camera layer's violet): a camera that has stopped following has no on-screen cause otherwise, and drawing it every frame would make it furniture rather than a diagnosis.
It draws **two** boxes, because the constraint has two boundaries: the inner one finely, where the override starts easing in, and the outer one as the line the avatar may never cross.
The avatar between them is the override working; the avatar hard against the outer one is the framing being asked for having run out of room, which is the thing to re-tune.
It draws the **stick** in the same amber, as a dashed line right across the frame through the aim coordinate on each axis it is holding by more than a centimetre - the stick is a displacement on one axis rather than a point, and a camera that has stopped following because it is being held needs its own answer on screen, the keep-out box being absent on exactly those frames. It fades out with the stick rather than being dropped, so the line simply stops being there once the camera has returned.

`CameraController.edgeClamp` turns it off, and the **editor's `edge clamp` checkbox is the only thing that ever does** - for ▶ Test alone.
An author tuning a lock or a lookahead has to be able to see the framing that rule is actually ASKING for, and that question is unanswerable while the answer is being silently corrected.
It is an instrument rather than a level property, so it lives on the controller and is written to no file; the game constructs its controller and never touches the switch.
`cli camera` asserts both halves of it - the same walk held on screen with it on and not held with it off - since a toggle connected to nothing passes any test that only checks one side.

## What green cannot see here

**`cli shot` cannot see the camera at all.** `shot.html` pins the view on the avatar (`camera.position = level.cameraRenderPosition(1)`, `zoom` from `?zoom=` or `BALL_ZOOM`) and never constructs a `CameraController`, because it exists to inspect the SIM and a camera that framed the avatar would put a body 20 m away off the side of every grab.
So a filmstrip of a hand-off shows the avatar dead centre with the world scrolling past whatever the rules do, and its motion profile reads zero changed pixels for a camera move over a resting avatar.

What covers it instead: `cli camera` for the rules, the weights and a controller ride; **`cli camera --ride <bundle>`** for what the screen actually did on a recorded run, which is the sim stepped as `cli replay` steps it with the real controller driven beside it at a fixed 1/60 (it prints peak camera speed, acceleration and jerk, the worst single-frame step, and the progress `s` behind them, and `--from N` measures only the tail of a session so a bundle recorded for one corner is not averaged with its own spawn settle); a bun script driving `CameraController.update` over a real level file (`scaleLevelData` + `buildCameraRules`) when the question is about an authored level rather than about the mechanism; and a person in a browser for the rest, which is where a camera is judged anyway.
`?level=CAMERA_TEST` exists for exactly that, and the editor's ▶ Test runs the real controller on the level being authored.
