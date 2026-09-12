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

`render/cameraController.ts` owns the view: an **eased follow** of the avatar, reshaped by the level's **camera regions**.
It is deliberately render-side, driven by the wall-clock frame `dt` rather than the fixed timestep, so easing it can never change a recorded run.
(The grapple controller un-projects the cursor through the camera, so the camera does reach the sim as *input* — but the trace records the resulting world point, so replays stay bit-identical.)
`camera.zoom` is the controller's **output**; the base framing scale lives in the caller (`GRAPPLE_ZOOM`, or `BALL_ZOOM` for the ball).
The default framing puts the avatar **dead centre** for both controllers — the ball's old 3/5-down shift is gone — so shifting the view is a camera region's `offsetX`/`offsetY` and nothing else, one authored mechanism rather than a per-controller rule.

Two smoothings run at deliberately different timescales:

- **Follow lag** (`CAMERA_FOLLOW_TAU`, 0.15 s) — an exponential ease of the camera toward its target, `1 - exp(-dt/tau)` so a 60 Hz and a 144 Hz display behave identically. This is the "not rigidly locked to the player" part.
- **Region hand-off** (`CAMERA_BLEND_TIME`, 0.7 s, per-region `blend` override) - when the governing region changes, the gap between what the outgoing region wanted and what the incoming one wants is **frozen** at that instant and smoothstepped to zero on top of the incoming target, which goes on being evaluated live.

Freezing that delta is the point of the mechanism.
The camera aims at the *correct* position for the region it is now in, displaced by a decaying constant, so two very different configurations that happen to agree at the crossing hand over invisibly - the delta is simply zero.
Cross-fading the two *live* targets instead, as this used to, keeps the outgoing region tracking the avatar for the whole blend, so its decaying share hauls the camera off the correct position and then lets it snap back: rubber banding whose size has nothing to do with how far apart the two cameras actually are.
The delta is measured between the two targets rather than against where the camera *is*: aiming the camera at its own position would drop its velocity to nothing for a frame, which reads as a hitch.
Taken this way the aim point is unchanged on the crossing frame, so the camera carries its follow lag straight through and only the delta decays; a hand-off interrupted part-way folds its remainder into the new delta, so that case is continuous too.
One mechanism therefore covers default→region, region→region and region→default: "no region" is just the null region, whose target is the plain follow point.
`CameraController.snap()` drops the easing for one frame (level start and reset), where easing in from the last frame's position would be a swoop across the level.

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
The containing region with the highest `priority` wins (later in the list breaks a tie), and the region in force keeps its grip until the avatar leaves it by its **`buffer`** - `REGION_EXIT_MARGIN` (15 cm) when it authors none, which is sized for jitter alone: without that much hysteresis, hovering on a boundary re-triggers the cross-fade every frame and the camera stutters.
Regions are invisible in play, so the **debug overlay** (L) draws every volume and fills the active one: a camera that offsets, zooms or pins otherwise has no on-screen cause.
It takes that region from the controller rather than recomputing it, because the grip depends on which region held the camera last frame - a recomputed answer disagrees with the camera across the whole width of the buffer, which is exactly what the overlay is opened to see.
The active region's buffer draws with it, as a finely dotted outline: the region holds the camera out to there, so without it a region that refuses to let go looks like a bug.

## Buffer

`buffer` is how far outside its own volume a region will follow the avatar before giving the camera up, and it is the answer to swinging.
A player on one attachment point crosses a boundary twice a swing and hands the camera over each time; a buffer wide enough to cover the far side of the arc keeps one camera for the whole thing.
It is pure geometry - no easing, no filtering, no rope state - so it behaves identically at any swing speed and any frame rate, and an author sets it by looking at how far out of the room the arc actually reaches.

Only *leaving* is buffered.
A region takes the camera the moment the avatar is inside it, so the buffer reads as "how far out of this room I may stray without the camera changing its mind" rather than as a second, larger volume that grabs the camera early from outside.
That asymmetry is also what keeps a buffer from fighting its neighbour: two adjoining regions with wide buffers hand over on whichever one the avatar is actually standing in, since only the current one's buffer is ever consulted.

A **rect** region may state one buffer per side instead - `bufferLeft`, `bufferRight`, `bufferTop`, `bufferBottom` - because a room is rarely symmetrical and the arc out of one usually reaches far past one wall and barely past the other, which a single number can only cover by being that wide in all four directions (and a buffer that wide is a region that will not let go).
Sides are the region's **own**, in its local frame - left/right are ∓x and top/bottom are ∓y, so a rotated region's "top" turns with it - and each falls back to `buffer`, which falls back to `REGION_EXIT_MARGIN`, so authoring one side leaves the other three exactly as they were and every level authored before the fields loads unchanged.
A circle has no sides and a polygon's growth is a signed-distance offset with no axis to hang them on (see `pathOutlineGrown`), so both ignore the fields and take `buffer` alone; the editor offers them to rects only rather than showing four controls that do nothing.
`pathOutlineGrown` grows a rect per side for the same reason it grew it per axis before - that is literally what `pointInRegion` tests - so the dotted outline in the editor and the overlay is exactly the volume the region holds by, which is the whole point of drawing it while it is being authored by eye.

`priority` still overrides the grip, and is the escape hatch a wide buffer needs: a small, deliberately-framed volume sitting inside a big buffered one has no other way to take the camera, and saying so explicitly beats shrinking the buffer until the overlap happens to work out.
The consequence to author around is that leaving that priority island drops to whatever contains the avatar *then* - the buffer belongs to the region currently in force, and the island became that region on entry, so the enclosing region's buffer is no longer what is holding.

## The screen-edge guarantee

Whatever rule is in force, the avatar may never enter the outer **`CAMERA_EDGE_MARGIN`** (8%) of the frame, on either axis.
It is the one camera rule with no authored override, and deliberately: a level may frame the avatar however it likes, and none of those framings is allowed to be "off the bottom of the screen".

It is a clamp on **where the camera IS**, applied last in `update` and to the controller's own `pos` rather than to the target.
A target the avatar can outrun is not a guarantee, and outrunning the ease is exactly what a launch does; clamping `this.pos` rather than only what is handed to the `Camera` is also what keeps the next frame continuous, since the camera really is where the constraint put it and carries on easing from there.

**It is eased in over a band rather than applied as a step**, and that is what its parameters are - three for the band, and a fourth that belongs to the anchored latch below:

| parameter | what it sets |
|---|---|
| `CAMERA_EDGE_MARGIN` (0.05) | where the avatar may never go, as a fraction of the frame |
| `CAMERA_EDGE_EASE` (0.15) | how much further in from there the override starts, same units |
| `CAMERA_EDGE_SMOOTHING` (0.15) | how long a correction takes when the band has room for it, in seconds |
| `CAMERA_LATCH_BUFFER` (0.02) | how much of what the band asks a *pinned* axis simply ignores, as a fraction of the frame's height (see **The latch**) |

All of them are **global** and deliberately not authorable, for the reason the margin always was: what the guarantee does is a property of the game rather than of a room in it.
`edgeReach` turns the two fractions into the distances a given camera allows - the override starts at `edgeReach(margin + ease)` and the avatar may never pass `edgeReach(margin)` - and `softEdgeOffset` is the curve between them.

A bare clamp is a discontinuity in the camera's **velocity**, which is the one thing a camera may not have.
Up to the line the camera is easing toward whatever the level asked for; one frame later it is rigidly locked to the avatar, travelling at exactly their speed.
Nothing about the position jumps, which is what makes it hard to see coming, and it is felt as the camera being caught and dragged - again every time a swing crosses back out, which on the anchored latch below is twice an arc.

The curve is a plain exponential whose length scale is the band:

```
a(d) = soft + (hard - soft) * (1 - exp(-(d - soft) / (hard - soft)))
```

Its two **end conditions** are what make it a ramp and both matter: the slope at `soft` is exactly 1, so the override costs nothing at the moment it engages, and the slope decays to 0, so the camera arrives at being carried by the avatar rather than being caught by them.
A smoothstep across the band satisfies the second and not the first - it is flat where it starts, so it takes the whole of the first millimetre's excess and the step is back, moved inward.

**It runs in two places, and that is what makes it smooth.**
The band shapes what the camera is **AIMING** at, so the camera answers it through the same exponential ease it answers everything else with; the same band plus the hard floor is then applied to where the camera actually **IS**, because an aim can be outrun and the guarantee may not be.
Applied to the position alone - which is where it started - the override can only ever be a correction, so the camera's velocity is whatever the correction happens to need that frame.
On a backswing that is a **reversal**: the lead is ratcheted forward, so the camera is still advancing into a lead the avatar has already left, and the override is not slowing it down, it is turning it round.

And the pull is **given at a rate set by how much of it is owed**, not on a fixed delay - `CAMERA_EDGE_SMOOTHING` is the seconds a correction takes when the band has room for it.
Twice as far past the boundary is corrected more than twice as fast, nothing at all happens at the boundary itself (the demand there is zero, so the correction grows out of nothing rather than starting), and the correction fades out as it finishes rather than ending, the thing driving it being the thing being consumed.

The rate is divided by how much of the band's remaining **headroom** the demand has eaten, so it diverges as the last of it goes and **the floor is never reached at all**.
The floor is a rigid clamp - a camera held on it moves at exactly the avatar's speed and stops dead the frame they come back inside - so a rate that can be outrun is one that guarantees the harshest thing the guarantee can do.
A fixed delay always can be, at any length, and a longer one makes it more certain.
It also makes where the avatar ends up a property of the band rather than of how fast they were going: walked out of a locked room at 3, 4.8, 9 and 18 m/s, the camera settles between 0.916 and 0.930 of the floor.

**The override holds NO STATE**, and that is the part to not undo.
The obvious shape for a delayed correction is to remember how much of the pull has been given and take up the rest on a clock, and the flaw is that a pull is a *displacement* held against a geometry that moves.
A swing turns and the band stops asking within a handful of frames while the held pull is still most of its old size, so the camera goes on being dragged for a third of a second after the reason for it has gone - and then whatever bounds the pull cuts the remainder off in one frame, which is felt as the camera jerking to a stop at the end of a correction.
Nothing is lost by dropping it, because **the camera position is already the integrator**: a fraction of the demand applied to `this.pos` every frame *is* a first-order approach to the band's curve, accumulating in the thing being corrected, where it cannot go stale.
An aim is rebuilt from the rule every frame and holds nothing, so there the band is given outright or it would be permanently weakened rather than delayed - with the anchored pin as the one exception, being state and accumulating exactly as the position does.

What the arrangement is worth, as worst camera **acceleration and JERK** - which is what "harsh" is - over two recorded swings and a walk out of a locked room, in m/s² and m/s³:

| | `session-118f` | `session-137f` | walking out |
|---|---|---|---|
| bare clamp (`CAMERA_EDGE_EASE = 0`) | 127 / 8044 | 103 / 6148 | 288 / 17280 |
| the band, given outright | 65 / 4412 | 25 / 972 | 36 / 886 |
| the band, on a held pull | 141 / 8479 | 26 / 972 | 30 / 278 |
| **the band, at this rate, 0.15 s** | **19 / 1462** | **17 / 972** | **14 / 179** |

The held-pull row is the design this replaced and the `118f` column is why: stale, it made the override **harsher than the bare clamp it exists to soften**.
What is left in the last row is not the override at all - 1462 is the lead ratchet engaging on the frame the chain goes taut and 972 is the lookahead deadband letting go, both of them steps in the *target's* velocity rather than in the camera's answer to it.

It is bounded ABOVE by the band and the speeds in play: past what the band can absorb the rate rides the barrier and the camera is turned over hard rather than carried, so much longer than a fifth of a second is the sign the **band** is too narrow for the speeds rather than that the rate is too slow.

A **shape** knob was tried here first and removed, and it is worth not re-inventing.
The family `1 - (1+uk)**(-1/k)` holds both end conditions for every `k` and looks like a free choice of tail, but its curvature at the join is `-(1+k)`: a longer tail is a *sharper* bend exactly where the override engages, so the knob ran the wrong way (23, 29, 44, 77 m/s² of peak acceleration for `k` = 0.01, 1, 4, 20 on `session-137f`) and every value of it was worse than `k = 0`.
What it was reaching for is a rate, and a rate is a clock.

It is **asymptotic** for the same reason it is C1 at the join: a curve that met the line at a finite distance having started at slope 1 would have to make the ground up in between, which means giving way faster than the avatar moves.
That is the stronger guarantee anyway - across everything a swing reaches the avatar is strictly *inside* the keep-out band rather than sitting exactly on its line, which is where the bare clamp used to hold them.

Three things fall out that are worth knowing before tuning it.
An **authored framing that puts the avatar inside the soft band is trimmed** - the override is engaged, so it is doing its job - which is why `rule-path-lookahead-is-per-axis` and the lead-band cases run with the clamp off: those are about what the lead ASKS for, and at this band a 2.5 m lead on a 9.6 m frame is already inside it.
The **anchored latch pins on a softer trigger** than the bare clamp's line, and its pin is now the point the override pulled the AIM to rather than where the camera was - which is what stops the pin itself being a step in the aim, worth ~500 m/s³ of the old jerk on its own.
And the two halves are not separable in the cases: taking the soft half off the aim also takes the pin with it, so that ablation reddens the latch cases as well.

An axis the override is not touching is returned **as it came in** rather than rebuilt from the follow point: `follow + (pos - follow)` is not `pos` in floats, so rebuilding it moves the camera by an ULP on every frame of ordinary play and reports the override as engaged on all of them - which is what the overlay draws and what the latch pins on.

`cli camera` asserts the curve (identity below the band, slope exactly 1 where it engages, monotone, never past the line and the line as its limit) and then what it does to a camera: a locked room walked steadily out of has no step in the camera's speed at the crossing and ends up carried at exactly the avatar's speed; an anchored swing on a ratcheted lead - `session-137f`'s own shape - is turned over rather than reversed, at under a third of the bare clamp's peak acceleration and without the floor ever being reached; the rate shows as the avatar being allowed further toward the line while the correction comes on, but never as far as it; a deeper incursion is corrected more than proportionally faster and the boundary itself corrects nothing; and a stroll, a hard run and a launch all stay strictly inside the floor **and stop in very nearly the same place**, which is the claim the rate law exists to make.
Every part of it is load-bearing under ablation: `CAMERA_EDGE_EASE = 0` reddens five cases, `CAMERA_EDGE_SMOOTHING = 0` two, dropping the headroom out of the rate five, giving the band outright on a latched axis reddens three latch cases, and giving it outright on the position reddens the floor case and two latch ones.

The margin is a **fraction of the frame** rather than a distance, because what is being constrained is where the avatar is ON SCREEN: a region that zooms out shows more world, and a margin in metres would shrink to a sliver of the frame exactly where the frame got roomier.
It is measured to the follow POINT, so it has to clear the avatar's own radius and leave something worth seeing - 77 cm either side and 43 cm above and below on the 9.6 x 5.4 m a 1080p frame shows at `GRAPPLE_ZOOM`.

It is **inert in ordinary play**, which is what makes it safe to apply globally.
The default camera centres the avatar, so the only thing that can put it near the edge under the plain follow is outrunning the ease - which settles at a lag of `speed x CAMERA_FOLLOW_TAU`, needing a sustained ~27 m/s before it binds against a hard swing's ~10.
What it does bite on is a locked region the avatar has left, and a path whose lookahead aims the camera well off them.
`cli camera` asserts both of those, plus a one-frame teleport, plus that it never binds at ordinary speed - and each of the three holding cases is red without the clamp.

### The latch

**While the avatar is anchored the shove is KEPT rather than eased back out of** (`CameraController.latchX`/`latchY`, per axis).

A swing that carries the avatar out of the frame carries them out twice an arc, so the clamp binds, releases and binds again for as long as they hang there - and unlatched, each release lets the camera ease straight back toward the target it was being held off.
The result is a camera that rocks for the whole swing, with an amplitude set by how far the frame guarantee had to move it, which is the wobble this exists to remove.
Latched, the point the clamp forced becomes a **pin**: the aim is that point for the rest of the anchored episode, and it moves only when the clamp forces it further.
So the camera moves on the frames the guarantee is actually moving it and on no others, which is the least motion a swing at the edge of the frame can be answered with.

It is per **axis** because the clamp is: a swing that drops the avatar out of the bottom of the frame has said nothing about the horizontal lead, and pinning x for it would freeze the route the camera is narrating.

The pin is recorded **after** the clamp has run, from what it actually moved, rather than predicted from the target before it - so next frame's aim is that position exactly and the ease has nothing left to do, which is what makes "the camera does not move" exact rather than nearly so.

**The pin ignores what it is asked for by less than `CAMERA_LATCH_BUFFER`**, and without that it creeps.
The pin is re-pulled every frame, so it holds only for as long as the guarantee asks nothing of it - and every arc of a long swing asks for a little: the avatar reaches a centimetre or two past where the last arc left the pin, the pin is dragged that far in, and it never comes back out, the override only ever pulling toward the avatar.
Over `session-546f`'s ten arcs on one anchor that is 9 cm of horizontal and 11 cm of vertical creep after the first swing has done the real work - every shift too small to see happen and the sum large enough to see, which is the worst shape a camera motion can have.

A plain deadband on the demand answers it and needs no state: what the band asks of a pinned axis is a function of how far past the line the avatar has got, so an arc that never reaches the buffer moves the pin by nothing and one that does drags it by the excess, continuously.

It has to reach **both halves** of the guarantee, which is the part that is easy to get wrong.
Buffered on the aim alone the pin holds and the camera does not: the position half goes on answering the band from where the camera is, pulling in over each arc and easing back out after it, so the creep becomes a *wobble* and the camera's travel over the same ten arcs goes from 21 cm to **91**.
Buffered on both it is **0**.

And it **opens on a clock rather than with the pin** (`latchOpenX`, half a second).
A pin is born wherever the override happened to be when the anchor was taken, which on a swing already at the edge of the frame is deep in the band, so switching a tenth of a metre of demand off in one frame is a step in the camera's velocity: 112 m/s² on the frame after the anchor, against 26 without the buffer at all and 28 with it ramped.

The buffer is spent as headroom against the floor, and that is the trade to read before turning it up - at the shipped 0.02 the avatar reaches 0.925 of the floor on `session-118f` rather than 0.916, and the first swing still does its work (22 cm of vertical pin travel against 37 unbuffered).

It **outranks the lead ratchet** and is outranked by nothing.
With the lead ratcheted (see [**The anchored episode**](camera-paths.md#the-anchored-episode)) the target stays forward while the avatar swings back, so far enough back and the guarantee hauls the camera after them - down the track, against the ratchet's whole bias, because the frame guarantee is the one camera rule a level may never opt out of and this one is not an exception to that.
Where it leaves the camera becomes the pin, so the forward half of the next swing does not spring the camera back off it.

The episode ends with the anchor: the pin is dropped and the gap it leaves is frozen into the **hand-off delta** and blended out over `CAMERA_BLEND_TIME`, rather than eased across at the follow lag - a pinned camera is at rest and metres from its target, so 0.15 s of ease across that is a lurch.
Aiming the blend at the camera's own position is the one thing the hand-off machinery warns against, and it is right here for the reason it is wrong there: there is no velocity to preserve.

`cli camera` asserts it as four cases, each red without it: the swing that holds (metres of unshoved drift, 0 latched against >5 rolling, with the guarantee itself still never violated), the per-axis half (y pinned while x goes on tracking the avatar at the plain follow lag), the release (the pin dropped, the camera back at the lock, and no single frame moving it more than the blend's own rate), and the meeting with the ratchet.

The debug overlay draws the keep-out box **only on the frames it is binding** (amber, not the camera layer's violet): a camera that has stopped following has no on-screen cause otherwise, and drawing it every frame would make it furniture rather than a diagnosis.
It draws **two** boxes, because the constraint has two boundaries: the inner one finely, where the override starts easing in, and the outer one as the line the avatar may never cross.
The avatar between them is the override working; the avatar hard against the outer one is the framing being asked for having run out of room, which is the thing to re-tune.
It draws the **pin** in the same amber, as a dashed line right across the frame through each latched axis - the pin is a coordinate rather than a point, and a camera that has stopped following because it is pinned needs its own answer on screen, the keep-out box being absent on exactly those frames.

`CameraController.edgeClamp` turns it off, and the **editor's `edge clamp` checkbox is the only thing that ever does** - for ▶ Test alone.
An author tuning a lock or a lookahead has to be able to see the framing that rule is actually ASKING for, and that question is unanswerable while the answer is being silently corrected.
It is an instrument rather than a level property, so it lives on the controller and is written to no file; the game constructs its controller and never touches the switch.
`cli camera` asserts both halves of it - the same walk held on screen with it on and not held with it off - since a toggle connected to nothing passes any test that only checks one side.
