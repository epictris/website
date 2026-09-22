# Plan: camera progress, framing, motion

The camera exists to show the player where to go next and to give them time to react to what they are about to hit, and it must do that as smoothly and predictably as possible.
This plan replaces the inside of `CameraController` (`src/render/cameraController.ts`) with three layers that are each smooth by construction, so that no rule upstream can ever jerk the screen.
It keeps the authored vocabulary: camera paths with keys, regions, priorities, the falloff blend, the corridor, the editor and the debug overlay all stay.

The verdict up front: **the camera aims at a function of the closest-point projection, and the closest point is not a smooth function of where the avatar is.**
Every other mechanism in the controller is downstream of that and was built to patch one consequence of it at a time.
The fix is not another patch but a different shape: a smooth progress measure, a target built from it, and one motion controller with bounded acceleration that is the only thing ever allowed to move the camera.

Everything below is specified so that it can be implemented without re-deriving it.
Where a number is given it is a default to be played, not a conclusion.

## The diagnosis, with the numbers that back it

Two bundles from 2026-09-22 on the river level (`levels/ball.json`, one path at priority 1, view x0.8, lookahead 2.0/1.2 m, lead band 0.5/0.7 m), replayed headlessly with the real `CameraController.update` driven at 60 Hz and alpha 1.

**`session-268f`, small forward jumps while rounding the OUTSIDE of a bend.**
The route is a Bézier flattened at `PATH_FLATTEN_STEP` (25 cm) into segments of 12 to 25 cm, turning 5 to 9 degrees at each vertex through the bend.
The avatar is about 1 m off the route on the outer side.
From out there the closest point sits on a vertex for the whole wedge of that vertex's normal cone, then slides 1:1 along the next segment.
The tracked `s` plateaus at exactly the vertex arc lengths (21.65, 21.82, 21.94, 22.07, 22.22, 22.38) for about 15 cm of avatar travel each (offset x turn angle), and the per-frame change of `s` alternates 0 / 2.3 cm.
The lead target inherits that staircase, and the 0.15 s first-order ease cannot hide a 0.2 s duty cycle: the camera's speed pulses 0.2, 1.4, 0.7, 1.4 m/s.
Sampling the true curve at 1 cm removes it entirely (mean |d²s/dt²| 21.8 to 8.5 m/s²).

**`session-336f`, one big jerk while rounding the INSIDE of a bend.**
The avatar is 0.9 m inside a bend of radius about 0.8 m, past its centre of curvature, where a whole arc of the route is equidistant.
As they drift left the global closest point flips from the vertical leg to the horizontal leg, 0.5 m of arc away.
The tracking window (`PATH_TRACK_SLACK_SPEED` 5 m/s plus the avatar's step) refuses the teleport and instead rides its own edge, so `s` sprints at about 6 m/s of arc for eight frames while the avatar moves at 1 to 2.6 m/s.
The camera goes from rest to 5.3 m/s in seven frames (54 m/s², jerk 2152 m/s³).
Finer sampling does nothing here because the discontinuity is intrinsic to closest-point projection.

| tail of session | current projection | 1 cm curve, hard window | soft projection, σ 0.5 m |
|---|---|---|---|
| 268f max ds/dt, m/s | 2.94 | 2.62 | 2.27 |
| 268f mean d²s/dt², m/s² | 21.8 | 8.5 | 5.4 |
| 336f max ds/dt, m/s | 7.35 | 6.95 | 3.80 |
| 336f max d²s/dt², m/s² | 345 | 288 | 68 |

**The architectural fault behind both.**
The controller computes a memoryless, piecewise target every frame and puts one first-order ease between it and the screen.
Every piecewise rule is a step in the target's velocity: the vertex projection, the window edge, both edges of the lead deadband, the ratchet engaging, the pin opening and dropping, the branch challenge, the frozen-delta hand-off.
`docs/camera.md` already concedes that its remaining 1462 and 972 m/s³ jerks are "steps in the target's velocity rather than in the camera's answer to it".
A first-order ease at 0.15 s attenuates a 3 Hz disturbance by only about a third, so every one of those rules leaks to the screen.
The 1976-line controller is mostly machinery trying to keep each rule individually continuous, which is the wrong place for that guarantee.

On the exact aim signal the current ease was chasing, a critically damped spring with an acceleration cap gives:

| tail of session | first-order 0.15 s (current) | spring 1.2 Hz, a ≤ 8 m/s² |
|---|---|---|
| 268f peak accel / jerk | 16 / 1533 | 8 / 156 |
| 336f peak accel / jerk | 55 / 2152 | 8 / 314 |
| 336f worst lag behind aim | | 1.4 m |

The measurement scripts are in the session scratchpad (`ride.ts`, `an.py`, `proj.py`, `motion.py`); phase 1 below makes the ride a permanent `cli` command so those numbers can be re-run on any bundle.

## The design

Three layers, in order, each smooth in its inputs.

### Layer 1: progress

`s` is the avatar's progress along the held path, and it is computed by a **soft projection** rather than a closest point.

Sample the route finely and take, over the samples within a smooth window around last frame's `s`, the arc-length-weighted mean of `s` under a Gaussian in distance:

```
w_i  = exp(-(d_i² - d_min²) / (2σ²)) · bump(|s_i - s_prev| / W) · Δs_i
s*   = Σ w_i s_i / Σ w_i
bump(u) = 1 - u²(3 - 2u) for u < 1, else 0      (smoothstep, falling)
```

- `d_i` is the distance from the avatar to sample `i`, `d_min` the smallest of them inside the window (subtracted only so the exponent is well conditioned).
- `Δs_i` is the arc length the sample stands for (half the sum of its two neighbouring segments), so the sum is an integral over arc length rather than a count of samples, and sample density cannot bias it.
- `σ` is the path's **softness**, a new authored field (`softness`, metres, default 0.5 m, not keyable).
- `W` is `CAMERA_TRACK_WINDOW` (2.5 m), a global.

Properties, each of which the current projection lacks:

- `s*` is a C∞ function of the avatar position for any `σ > 0`, so there are no vertex plateaus (the Gaussian spans many samples) and no medial-axis teleport (both sides of a corner are averaged, and the average moves smoothly as the weights shift).
- It collapses to the closest point wherever one candidate dominates, so on a straight or gently bent route it is the projection it replaces.
- A switchback branch further than `W` in arc length has zero weight, which is what the hard window was for, and a candidate entering the window fades in from zero instead of snapping, which the hard window could not do.
- The cost is a bias toward `s_prev` when the avatar is far along the window, which reads as a smooth lag at very high speed and corrects itself; and `s*` inside a tight corner advances faster than the avatar moves, because cutting the corner IS advancing past the bend, and the motion layer is what makes that a swell rather than a jerk.

The projection returns three things: `s` (soft, feeds the lead origin and the keyed target fields), `sNear` (the closest sample inside the window), and `off` (the avatar minus the route point at `sNear`).
**Grip keeps its old meaning**: the range, the falloff weight and the release are all measured with `off` at `sNear`, exactly as the windowed projection's offset was, so the corridor an author draws is still the zone tested.
Only what the camera LOOKS AT moves to the soft answer.

Sampling: `buildCameraRules` flattens the camera route at its own step, `CAMERA_SAMPLE_STEP` = 2 cm, not at `PATH_FLATTEN_STEP`.
`PATH_FLATTEN_STEP` is shared with movers (`PACE_STEP` in `src/level/movers.ts`) and is sim-side there, so changing it would diverge every recorded mover replay; the camera route is render-side and free to sample as finely as it likes.
`flattenPathNodes` takes the step as a parameter; `MAX_SAMPLES_PER_EDGE` rises to match (a 5 m edge at 2 cm is 250 samples).
`pointAtArcLength` becomes a binary search over `cum`, since the river route is about 6000 samples and it is called several times a frame.
The corridor sweep (`pathCorridorSweepInto`) and the editor draw from the same index and are cached, so they simply get smoother.

Acquisition stays as it is: global closest point, history-free, and the lead band re-centred.
The **branch challenge** stays, minus its hand-off half: a held path whose global closest point is outside the window, inside the core range there and outside the core range plus buffer at `sNear`, re-acquires at the global answer.
The step that puts into the target is the motion layer's problem now.

The **lead deadband and its ratchet** (`committedLeadS`) stay exactly as they are, including the gate on being anchored: a swing still oscillates `s` along the route and the band still absorbs it, and the ratchet is still the right one-sided answer to a swing.
Their edges are velocity steps in the target, which is fine now.

### Layer 2: framing

The target is the authored idea, unchanged in kind: for a path, the route point at `leadS + lead + speedLead` at the zoom keyed there; for a region, the lock, offset and scale it authors; blended by weight through `blendCameraTarget` with the plain follow taking the unclaimed share.
Every existing function here (`cameraRuleTarget`, `pathLeadAlong`, `pathLookahead`, `pathParamsAt`, `cameraInfluences`, `blendCameraTarget`, `activeCameraRules`) is kept.

One addition, **the speed lead**, which is the "time to react" requirement made explicit:

```
progressRate = first-order filter of d(leadS)/dt, τ = CAMERA_RATE_TAU (0.3 s)
speedLead    = min(lead, max(0, progressRate) · reactionTime)
```

- `reactionTime` is a new authored path field (seconds, default 0.3 s, keyable, read at the lead origin like the other target fields).
- It is taken from the rate of the COMMITTED lead origin, not of `s`, because `leadS` is deadbanded and ratcheted: a swing moves it only when the swing extends, so a hang does not pump the lead, while genuine travel down the route reads as its true rate.
- It is capped at the authored lead per axis, through `axisBlend` like the lead itself, so a fast player sees at most twice as far ahead and a shaft with a short vertical lead stays a shaft.
- The screen-edge window bounds it beyond that: an authored framing past the inner margin is trimmed to it, as today.
- A player who stops sees the lead come back over `CAMERA_RATE_TAU`, through the motion layer.

Today the lead is speed-independent, so a fast player sees exactly as far ahead as a slow one, which is the opposite of what was asked for.

### Layer 3: motion

The camera position and zoom are owned by one **critically damped spring with an acceleration cap and a speed cap**, and nothing else ever writes them.

```
CAMERA_FREQ       = 1.2 Hz     ω = 2π · CAMERA_FREQ
CAMERA_MAX_ACCEL  = 8  m/s²
CAMERA_MAX_SPEED  = 12 m/s
```

Per frame, per axis, with `e = aim - pos`:

1. Take the exact closed-form step of the critically damped spring over `dt` (the standard SmoothDamp solution: with `x = -e`, `x(dt) = (x + (v + ωx)·dt)·e^(-ω·dt)`, and `v(dt)` its derivative), so the result is frame-rate independent for any `dt`, which is the property `1 - exp(-dt/τ)` had.
2. Clamp the resulting velocity change to `CAMERA_MAX_ACCEL · dt` and the resulting speed to `CAMERA_MAX_SPEED`, as vector lengths over both axes so a diagonal move is not faster than an axial one.
3. Integrate the clamped velocity.

Zoom goes through the same spring in `log(zoom)`, which is the geometric blend every zoom transition here already uses.
`snap()` sets the position to the aim and the velocity to zero.
`dt` is clamped to 0.1 s before use so a hitched frame cannot fling the camera.

What this buys is a **global** guarantee: whatever any rule upstream does, the camera's acceleration is bounded and its velocity is continuous.
That guarantee is what the following mechanisms were each trying to provide locally, and they go:

- The **frozen-delta hand-off** (`offset`, `zoomRatio`, `s`, `dur`, `setBlend`, `ruleBlend`, `CAMERA_BLEND_TIME`, the region `blend` field). A rule change is a step in the aim, and a step in the aim is a bounded swell.
- The **branch challenge's hand-off half** (above).
- The **first-order ease** and `CAMERA_FOLLOW_TAU`.

The hard **floor** of the screen-edge guarantee stays, applied last to the position (`holdEdge`, with the `edgeTakeUp` rate law unchanged): a spring can be outrun and the guarantee may not be.
When the floor moves the position, the spring's velocity is set to what the frame actually moved, so the next frame carries on from where the camera really is instead of fighting it.

### The screen-edge guarantee without the latch

The **soft half** (`softEdge`, the window on the aim) stays, and the pin, its buffer, its opening clock and the wind release are replaced by one **sticky pull** per axis:

```
pull_axis(t) = the window's demand on this axis this frame
stick_axis   = pull_axis > 0 ? pull_axis : stick_axis · exp(-dt / CAMERA_STICK_TAU)
aim_axis     = window(target_axis) if pulling, else target_axis - stick_axis
CAMERA_STICK_TAU = 1.5 s
```

That is: the window shapes the aim outright while it is asking, exactly as today, and when it stops asking the aim returns to the rule's target on a slow clock instead of instantly.

Why this is the right replacement for the whole anchored latch:

- A swing at the edge of the frame asks the window roughly once a period (about 1.5 s), so a pull decays only partly before the next one raises it again, and the camera stays close to where the guarantee left it: the rocking the latch existed to stop is a few centimetres of slow drift, through a spring, rather than a pin.
- There is no episode, so nothing has to be handed back when the anchor releases (the pin's drop and its frozen delta go), nothing creeps (the pin's `CAMERA_LATCH_BUFFER` was a deadband against a pin that only ever moved in; a decaying stick moves out on its own), and nothing has to open on a clock (`LATCH_OPEN_TAU`).
- **Winding up the line toward an anchor ahead** is handled with no special case: the player is moving toward the middle of the frame, the window stops asking, and the stick decays over 1.5 s while the spring glides the camera forward to its lead. `windProgress`, `hangLength`, `windArmed`, `sinceWind`, `WIND_REARM_DELAY`, `WIND_REST_RATE` and the `windBuffer` field all go, and `CameraHang` reduces to a boolean.
- It is not gated on being anchored. The guarantee is inert in ordinary play (it binds only on a locked room the avatar has left or a path leading well off them), and there a slow return is at worst a calmer camera.

The lead ratchet stays gated on anchored, as above; it is about backtracking along the route, not about the frame edge.

## What changes, file by file

`src/lib/path.ts`

- `flattenPathNodes(nodes, step = PATH_FLATTEN_STEP)`; `MAX_SAMPLES_PER_EDGE` raised (or derived from the step).
- `pointAtArcLength` by binary search on `cum` (same answers, `flatten-*` and `point-at-arc-length` cases prove it).
- `projectOntoPolylineWindow` is kept for the acquisition and the challenge.

`src/render/pathProgress.ts` (new)

- `softProjectOntoPolyline(ix, p, sPrev, window, sigma): { s, sNear, dist }`, with the `Δs_i` weighting as specified.
- It lives under `render`, not `lib`, because `cli dmath` scans the whole of `src/lib` for platform transcendentals (`SIM_DIRS` in `src/sim/dmathCases.ts`) and this function uses `Math.exp` legitimately: it is render-side and reaches the sim through nothing.

`src/render/cameraController.ts`

- Constants: add `CAMERA_SAMPLE_STEP`, `CAMERA_TRACK_WINDOW`, `CAMERA_FREQ`, `CAMERA_MAX_ACCEL`, `CAMERA_MAX_SPEED`, `CAMERA_RATE_TAU`, `CAMERA_STICK_TAU`, `DEFAULT_PATH_SOFTNESS`, `DEFAULT_PATH_REACTION`. Remove `CAMERA_FOLLOW_TAU`, `CAMERA_BLEND_TIME`, `PATH_TRACK_SLACK_SPEED`, `CAMERA_LATCH_BUFFER`, `WIND_REARM_DELAY`, `WIND_REST_RATE`, `LATCH_OPEN_TAU`, `latchBuffer`.
- `PATH_KEY_FIELDS`: drop `windBuffer`, add `reactionTime`. `PathParams`/`pathParamsOf`/`pathKeyTracks`/`pathParamsAt` follow. `softness` is a plain path field on the rule, not a key.
- `buildCameraRules` flattens at `CAMERA_SAMPLE_STEP`.
- `CameraController` state becomes: `pos`, `vel`, `logZoom`, `zoomVel`, `started`, `members`, `seat`, `pathS`, `pathLeadS`, `progressRate`, `lastLeadS`, `stickX`, `stickY`, `aimPullX/Y` (still recorded for the overlay), `edge`, `wasAnchored`, `edgeClamp`.
- `update(camera, dt, follow, rules, baseZoom, anchored: boolean)`; the `hang` object goes.
- `HeldCamera` drops `latch` and `wind`, gains `stick: { x, y }` and `rate` (the progress rate, for the overlay and the ride).
- `trackPath`, `latched`, `pinnedAsk`, the hand-off block, the wind block and the latch block are deleted; `softEdge` loses the pinned arm; `holdEdge` loses the buffer arm and writes back the velocity.

`src/level/levelFormat.ts`

- `CameraPathData`: add `softness?: number` (px on disk, metres in play, scaled at the one gate like `range`), `reactionTime?: number` (seconds, NOT scaled); remove `windBuffer` and the region `blend` from the live types, and fold both away in `normalizeLevelData` so every level on disk still loads.
- `CameraPathVert`: add `reactionTime?`, remove `windBuffer?`.

`src/level/level.ts`, `src/level/ballLevel.ts`, `src/main.ts`, `src/editor/editor.ts`

- `cameraHang` becomes `cameraAnchored: boolean` (the ball's `chainAnchored`, the grapple's equivalent); both `update` call sites pass it.

`src/editor/editor.ts`, `src/editor/model.ts`

- Path panel: `softness` and `reaction` fields; `wind buf` removed; region panel loses `blend`. The node sub-panel keys `reactionTime` instead of `windBuffer`. `modelFromDisk`/`modelToDisk` carry the new fields and drop the old, and the round-trip case says so.

`src/render/debugOverlay.ts`

- The amber latch lines become the stick: drawn through the aim coordinate on each axis whose `|stick|` is over 1 cm, same colour, same reason (a camera off its target needs its cause on screen).

`src/tools/cli.ts`, `src/sim/cameraCases.ts`

- New `cli camera --ride <bundle.json> [--table]`: replays the bundle through `levelFromRecording` and `recordingDeserializer`, drives the controller at 1/60 with alpha 1 and the level's own rules, and prints peak camera speed, acceleration and jerk over the run, the worst single-frame step, plus (with `--table`) the per-frame table of camera, avatar, `s`, `leadS`, members, stick and floor.
- It prints `tree: match` or `tree: MISMATCH` like every replaying command.

`docs/camera.md`, `docs/camera-paths.md`, `CLAUDE.md`

- Rewritten where they describe the deleted mechanisms; the measured tables above move into the docs as the record of why. The map's two camera lines are updated.

## Order of work

Each phase ends green on `bun run test` and with the ride numbers for both bundles recorded in the commit message, so the effect of every phase is a number rather than a claim.
Work on a branch; A/B against `main` at `9a866f4` through a `git worktree`, never a stash.

1. **The ride.** Add `cli camera --ride` and run it on `session-268f (1)` and `session-336f` at HEAD. Expected: 268f peak accel 16, jerk 1533; 336f peak accel 55, jerk 2152; the 268f table shows `s` plateaus at the vertex arc lengths. Commit. Everything after is measured with this.
2. **Fine sampling.** `CAMERA_SAMPLE_STEP`, the binary search, the sweep and editor checked for cost (the river level's corridor sweep must still build in tens of ms; report the number). Expected: 268f mean |d²s| roughly 2.5x lower, 336f unchanged. `flatten-samples-finely-enough` keeps its meaning against the camera step.
3. **Soft projection.** `softProjectOntoPolyline`, the split of `s` from `sNear`, the challenge without its hand-off. Expected: 336f max ds/dt about 3.8 m/s. `switchback-window` and `switchback-branch-reacquire` are rewritten against the soft window (zero weight beyond `W`, fade-in inside it) and the challenge; both must be red against a windowless soft projection.
4. **Motion layer.** The spring, the caps, `log(zoom)`, the floor writing back velocity; the hand-off machinery deleted; `blend` folded away. Expected: both bundles' peak acceleration at or under `CAMERA_MAX_ACCEL`. `rule-handoff-does-not-snap` becomes "a hand-off is bounded by the acceleration cap"; the `edge-*` window and floor cases stay and must still pass.
5. **Sticky pull.** The latch and the wind release deleted, `CameraHang` reduced, the fields folded away, the editor and overlay updated. The `edge-latch-*` and wind cases go; new cases for the stick's two facts only (it holds through a swing period to within a stated fraction, and it decays to zero when nothing asks).
6. **Speed lead.** `reactionTime` end to end (format, keys, editor, controller). One mechanism case: the lead grows by rate x reaction and is capped at the authored lead per axis.
7. **Docs.** `camera.md` and `camera-paths.md` rewritten for the three layers; the deleted sections replaced by a short "what was here and why it went" so the measured reasons are not lost.
8. **Play.** River level and `CAMERA_TEST`, against the `main` worktree side by side, with the two original bundles replayed in the browser (`?replay=`) as the direct before/after. Record fresh bundles with P for the same two corners and a fast run down the river. The feel constants (`CAMERA_FREQ`, `CAMERA_MAX_ACCEL`, `CAMERA_STICK_TAU`, `softness`, `reactionTime`) are tuned here and nowhere else.
9. **Feel cases**, only after 8 confirms the shape, per the project rule: the two bundles as ride cases with thresholds taken from the played tuning (peak acceleration, peak jerk, no single-frame step over a stated size).

## Cases: what is written when

Written with the phase, because they are facts about the mechanism and not about feel:

- Soft projection is continuous: sweep an avatar in 1 mm steps around the outside and the inside of a 0.8 m bend at 1 m offset; the largest change in `s` per step is bounded by a small multiple of the step, and there is no plateau longer than one sample. Red against the closest point on both counts.
- Soft projection agrees with the closest point on a straight route to within a millimetre.
- The window: a sample `W` away has zero weight; one at `0.9 W` has nonzero weight; the switchback rig ends on the branch it started on.
- The spring: a unit step in the aim produces a trajectory whose acceleration never exceeds the cap and whose velocity has no discontinuity; two rides of the same aim at 60 Hz and 144 Hz agree at every common instant to within the integration's own error; a zoom step blends geometrically.
- The floor is never violated on a one-frame teleport and on a launch, as today.
- The stick: holds and decays, as above.
- The speed lead: grows and caps, as above.
- Editor round trip with the new fields and without the old.

Deferred to phase 9: anything that says how the river level feels.

## Cases that go, and why

- `edge-latch-*` (four), `anchored-lead-unratchets-on-release`'s hand-off half, and the wind cases: the mechanisms are gone; their facts are covered by the stick's two cases and the acceleration cap.
- `rule-handoff-does-not-snap`, `switchback-branch-reacquire`'s "no frame over 15 cm" half: rewritten against the cap.
- `lead-buffer-*`, `anchored-lead-ratchets-forward`, `keys-*`, `falloff-*`, `range-*`, `rule-path-*`, `flatten-*`, `format-*`: unchanged in intent, re-run against the new controller.

## Risks and what to watch

- **Lag at speed.** The spring at 1.2 Hz trails a fast target by up to about 1.4 m on `336f`; the floor catches the avatar if that ever reaches the frame edge. If the play shows the floor binding on ordinary runs, raise `CAMERA_FREQ` before touching the cap: the cap is the guarantee, the frequency is the feel.
- **Softness versus corridor width.** `σ` is a distance off the route; a path whose corridor is much wider than `σ` behaves like the closest point at the corridor's edge and only softens near the route. The default 0.5 m was measured on a 0.8 m bend; a level with tighter bends wants more.
- **Zero-weight windows.** If every sample in the window has negligible weight (the avatar far outside the corridor), `s*` must fall back to `sNear` rather than divide by zero; the release will fire on `off` anyway.
- **The sim never sees any of this.** The camera stays render-side; the grapple controller still un-projects the cursor through it, but the trace records the resulting world point, so `replay selftest` and every regression bundle stay bit-identical. Run `cli bundles` at the end of every phase regardless.
- **`cli dmath`** scans the whole of `src/lib`, which is why the soft projection lives in `src/render/pathProgress.ts`; do not move it into `lib/path.ts` beside the functions it replaces.
