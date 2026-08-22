# Plan: hook sparks on impermeable surfaces

A steel hook striking hook-proof steel should say so: sparks fly from the contact point.
Two behaviours, both purely visual:

1. **Impact**: when the hook collides with an impermeable surface, a burst of sparks emits from the contact point, sized by how hard the hit was.
2. **Slide**: while the hook is moving along an impermeable surface, sparks emit continuously from the contact, sized by how fast it is sliding.
   A hook resting stationary against the surface emits nothing.

"The hook" is primarily `BallHook` (the ball & chain controller): it bounces off impermeable surfaces (`BallHook.bounce`, `src/classes/ballHook.ts`), can skip along them mid-flight, and its dangling-tip form can be dragged along them by the swinging chain.
The grapple `Hook` (`src/classes/hook.ts`) is destroyed on impermeable contact, so it gets the impact burst only - it never survives to slide.

## The one rule that shapes everything: sparks never touch the sim

The simulation is deterministic and replayed bit-for-bit (`cli selftest`, `playtests/bundles`).
Sparks therefore live entirely on the render side.
The sim's only contribution is a per-frame list of **events** - plain data derived from state the sim already computes - and nothing in the sim reads, keeps, or is steered by them.
No sim constant changes, no body state changes, no digest field changes.
Every existing bundle must replay bit-identically after this lands; that is the acceptance test for the boundary being clean.

## Design

### Events cross the boundary, particles do not

```ts
// src/level/sparkEvents.ts
import type { Vec2 } from "../engine/vec2";

export interface SparkEvent {
  kind: "impact" | "slide";
  // World metres - the contact point on the surface.
  point: Vec2;
  // Out of the surface.
  normal: Vec2;
  // The hook's velocity at the contact, m/s.
  // Impact: the PRE-bounce velocity (the reflection has not been applied yet).
  // Slide: the hook's current velocity.
  // The spark system derives both the burst size (normal component) and the
  // streak direction/rate (tangential component) from this one vector, so the
  // two kinds share a shape.
  vel: Vec2;
}
```

`BallLevel` gains `sparkEvents: SparkEvent[] = []`, **cleared at the top of every `physicsProcess`**.
Clearing there rather than on render consumption is load-bearing: headless replay (`cli replay`, `cli bundles`, playtests) runs `physicsProcess` with no renderer attached, and an append-only list would grow without bound across a long bundle.
A frame's events exist for exactly one frame; a renderer that wants them drains them after stepping, and a tool that never looks loses nothing.

### Impact events: a callback on `BallHook.bounce`

`bounce()` is the single funnel for every impermeable collision the hook has - the flight sweep's `proof` branch and `probeContact`'s deflection both end there - so one callback covers all of them.

`BallHook` gains a registry in the style of its existing ones (`attachmentCallbacks`, `chainOutCallbacks`):

```ts
private bounceCallbacks: Array<(point: Vec2, normal: Vec2, vel: Vec2) => void> = [];
registerBounceCallback(cb: (point: Vec2, normal: Vec2, vel: Vec2) => void): void { ... }
```

Fired inside `bounce()` only when `vn < 0 && speed > BOUNCE_MIN_SPEED` - the same guard the reflection itself sits behind - with the **pre-reflection** velocity, the surface normal, and `seatPos` as the contact point.
A hook moving away from the surface, or one whose velocity is numerical noise, is not a collision and fires nothing.
The maths of `bounce()` does not change in any way; the callback is a pure read of values the method already has in hand.

Wiring lives in `BallLevel.spawnBody` (src/level/ballLevel.ts:153), which every hook passes through on its way into the world:

```ts
private spawnBody(body: PhysicsBody2D): void {
  if (body instanceof BallHook) {
    body.registerBounceCallback((point, normal, vel) =>
      this.sparkEvents.push({ kind: "impact", point, normal, vel }),
    );
  }
  this.world.add(body);
  this.bodies.push(body);
}
```

`BallPlayer` is untouched - the sim-to-visual plumbing belongs to the level layer, not the controller.

Note the callback also fires on the repeated small `probeContact` bounces a dangling tip makes while pressed against a wall.
That is fine and intentional: the spark system thresholds on the velocity components (below), so a settling tip's near-zero-speed bounces produce nothing, while a tip actively dragged along the wall produces the slide stream from the same events.
This also covers impermeable shapes on `AnchorBody` hook-only scenery, which the solver never touches - the hook's own sweep/probe is the only thing that collides with those, and it ends in `bounce()`.

### Slide events: a `frameContacts` scan after integrate

A hook the solver is holding against an impermeable face (seated within `CONTACT_SLOP`, sliding along it) may not re-enter `bounce()` every frame - the solver's contact does the holding.
`World.frameContacts` exists precisely so a caller can ask what a body touched this frame (see the comment block above `attachToBlockingContact`), so ask it.

In `BallLevel.physicsProcess`, after `this.world.integrate(delta)` and `applyLoopCap` (frameContacts is assigned inside integrate, world.ts:1295):

```ts
for (const c of this.world.frameContacts) {
  // The dynamic side is always `a` (see ContactConstraint, world.ts:165), and
  // impermeable shapes only exist on static bodies (nothing can be `rigid`
  // and `impermeable` at once - levelFormat.ts), so a hook contact has the
  // hook as `a` and the surface velocity is zero.
  if (!(c.a instanceof BallHook) || c.normalImpulse <= 0) continue;
  const s = c.b.getShapes()[c.shapeB];
  if (!s?.impermeable) continue;
  this.sparkEvents.push({ kind: "slide", point: c.point, normal: c.normal, vel: c.a.linearVelocity });
}
```

`normalImpulse > 0` is the same "it really pushed back" filter `attachToBlockingContact` uses: speculative contacts that asked for nothing are skipped, so a hook coasting millimetres clear of a wall does not shed sparks onto it.
The spark system extracts the tangential component of `vel` and thresholds it, which is what makes "moving along" emit and "stationary against" not - the sim does not pre-judge that, it just reports the contact.

A frame where both a probe bounce and a solver contact report the same touch produces two events at nearly the same point.
That is handled by the spark system's global per-frame spawn cap rather than by deduplication logic; the visual difference between one event and two coincident ones is marginal and not worth a matching key.

### Grapple `Hook`: burst on destruction

In `Hook.physicsStep`'s impermeable branch (src/classes/hook.ts:54), the ray result carries the contact.
Extend the destroyed callback path minimally: `Level` gains the same `sparkEvents` field and clear, and the hook's impermeable branch pushes one `impact` event (point from `result.position`, normal from the ray result, `vel` from `this.velocity` scaled to m/s per frame - the hook stores per-frame displacement, so divide by the step).
If `intersectRay`'s result turns out not to carry a normal, derive it from `nearestSurfacePoint` toward the hook; do not add a normal to the ray API for this.
This is a small, self-contained addition - do it last, and if `Level`'s structure makes it awkward it can be dropped from the first cut without weakening the main feature.

### The particle system: `src/render/sparks.ts`

A render-side module owning the pool, the PRNG, and the drawing.

```ts
export class SparkSystem {
  // Drain a frame's sim events into live particles. Called once per sim step.
  ingest(events: SparkEvent[]): void;
  // Advance particle physics by dt seconds of RENDER time (clamped to 0.1 s).
  advance(dt: number): void;
  // Draw into a ctx already in world space (metres). Saves/restores composite state.
  draw(ctx: CanvasRenderingContext2D): void;
  // Kill all particles and reseed the PRNG. Called on level reset.
  reset(): void;
}
```

**Pool, not allocation.**
A fixed cap `MAX_SPARKS = 256` with struct-of-arrays `Float32Array`s (`x, y, vx, vy, age, ttl`) and swap-remove on death.
No per-frame allocation, O(live) update and draw; when the pool is full, new spawns replace the oldest.
The cap doubles as the per-frame spawn ceiling that absorbs coincident duplicate events.

**Seeded PRNG, not `Math.random`.**
A mulberry32 (or equivalent tiny) PRNG inside the module, reseeded to a fixed constant by `reset()`.
`shot.html` and `cli shot` replay a bundle and screenshot frames; with sim-driven events and a reseeded PRNG the sparks in those screenshots are reproducible run to run, which keeps the screenshot tooling usable for before/after comparison.
`advance` takes dt as a parameter for the same reason: the live game passes render-clock dt, the shot path passes the fixed `STEP`, and only the live path is nondeterministic (which is fine - it is the path nobody diffs).

**Spawning.**
Split the event velocity at the surface: `vn = -vel·normal` (approach speed, ≥ 0 when closing), `vt = vel - normal·(vel·normal)` (slide velocity along the face).

- Impact burst: only when `vn ≥ IMPACT_MIN_SPEED`.
  Count `min(round(vn * IMPACT_SPARKS_PER_MPS), IMPACT_BURST_CAP)`.
  Directions fan in a wide cone about the reflection of `vel` off the normal, biased away from the surface; speeds jitter uniformly in `[0.15, 0.5] * vn + a share of |vt|`.
- Slide stream: only when `|vt| ≥ SLIDE_MIN_SPEED`.
  Count per event is distance-based: `|vt| * STEP * SLIDE_SPARKS_PER_METRE`, with the fractional part accumulated across frames so slow slides still spark occasionally rather than never.
  Directions scatter in a shallow cone about `-v̂t` tilted slightly off the surface (sparks trail the motion, the way a grinder throws them behind the contact); speeds jitter in `[0.2, 0.6] * |vt|`.

Both spawn at `point` nudged half a spark-length along the normal so streaks never start embedded in the fill.

**Particle physics (visual, in metres).**
Full gravity `9.8 m/s²` (they read as heavy steel slivers, not smoke), a light exponential drag, lifetime jittered in `[0.15, 0.45] s`.
No collision with anything - a spark passing into geometry dies by age, which at these lifetimes is never visible.

**Drawing.**
Inside the world-space transform, `ctx.globalCompositeOperation = "lighter"` for additive glow, restored after.
Each spark is a short streak: a line from `p` to `p - v * STREAK_TIME` (`STREAK_TIME ≈ 0.02 s`), `lineWidth ≈ 0.6 * PX`.
Colour runs with normalized age, hot to cool: `#fff7d6` (white-yellow) → `#f2a13c` (orange) → `#b3502a` (ember), alpha fading to 0 over the last half of life.
Palette constants at the top of `sparks.ts` in the renderer's style.
Every length and speed constant is in metres per the units rule (`CLAUDE.md` "Units"): fixed on-screen sizes are written as `<px> * PX`, velocities in m/s, and the counts/lifetimes are dimensionless/seconds.

### Wiring

`main.ts` owns one `SparkSystem`:

- After **each** sim step inside the catch-up loop (there can be up to `MAX_STEPS_PER_FRAME` per render frame): `sparks.ingest(level.sparkEvents)`.
  Ingesting inside the loop rather than after it means a stall does not silently drop the events of the caught-up frames.
- Once per render frame: `sparks.advance(renderDt)`.
- `reset()` (the existing level-reset function in main.ts) also calls `sparks.reset()`, so a restart does not carry the dead level's embers.

Drawing goes through the renderer, not around it: `renderBall` (and `render` for the grapple path) takes an optional `sparks?: SparkSystem` and calls `sparks.draw(ctx)` inside the world-space block, after the chain/manacle (and after the player rig on the grapple path), before `ctx.restore()`.
Crucially this is **not** gated on `overlayOnly`: in 3D mode the 2D overlay canvas already draws world-space marks over the WebGL scene (the reticle, the anchor grates), and sparks are exactly that kind of mark - emissive, flat, screen-thin.
One system therefore serves both render modes.

`shotMain.ts` wires the same three calls with `STEP` as the advance dt, so `cli shot` frames show (reproducible) sparks.
`sim/svgFrame.ts` is left alone - it is a diagnostic projection, not a look.

### Rejected alternatives

- **Particles in the 3D scene (`Scene3D`)**: rejected for the first cut.
  It would need a second implementation (points/billboard material, lifecycle in `scene.ts`) to produce the same emissive dots the 2D overlay produces in one, and the overlay already owns the "flat mark over the scene" role.
  Revisit only if sparks should light the scenery, which is a different feature.
- **Simulating sparks in the sim**: violates the determinism boundary, would bloat digests and replays with cosmetic state, and buys nothing - sparks affect nothing.
- **A velocity threshold in the sim before pushing events**: tuning would then live on both sides of the boundary.
  The sim reports contacts; every threshold, count, and colour lives in `sparks.ts` where it is tuned by eye.

### Tuning constants (starting points, tune by eye)

| Constant | Value | Dimension |
|---|---|---|
| `IMPACT_MIN_SPEED` | 1.0 | m/s (below this a touch is a settle, not a hit) |
| `IMPACT_SPARKS_PER_MPS` | 1.5 | count per m/s |
| `IMPACT_BURST_CAP` | 20 | count |
| `SLIDE_MIN_SPEED` | 0.3 | m/s (solver jitter of a seated tip stays below; a real drag is above) |
| `SLIDE_SPARKS_PER_METRE` | 30 | count per metre slid |
| `SPARK_GRAVITY` | 9.8 | m/s² |
| `SPARK_TTL` | 0.15-0.45 | s |
| `STREAK_TIME` | 0.02 | s |
| `MAX_SPARKS` | 256 | count |

`SLIDE_MIN_SPEED` is the constant that implements "not while it's stationary"; verify it against a tip left hanging against a wall (zero sparks) and a tip swung along one (steady stream) before tuning anything else.

## Implementation order

1. `SparkEvent` type; `sparkEvents` field + top-of-frame clear on `BallLevel`.
2. `registerBounceCallback` on `BallHook`; wiring in `BallLevel.spawnBody`; the `frameContacts` slide scan.
3. `render/sparks.ts`: pool, PRNG, spawn rules, advance, draw.
4. `main.ts` wiring (ingest per step, advance per frame, reset) and the `renderBall`/`render` draw hook.
5. `shotMain.ts` wiring with fixed-step advance.
6. Grapple `Hook` destruction burst + `Level.sparkEvents`.
7. Tune by eye in the live browser, then run the checks below.

## Verification

- `bun run replay selftest` and `bun run src/tools/cli.ts bundles`: every existing bundle replays bit-identically.
  The only sim-file diffs are the callback registry, the callback invocation reading already-computed values, and the event list on the level - none of which write sim state - so any divergence here means the boundary leaked.
- Live, ball level (dev server already on 3100 - do not restart it): throw the hook head-on at a hook-proof face (dashed steel edge) → one burst scaled with throw speed; skim a glancing throw along one → trail of sparks along the skip; let the dangling tip rest against one → nothing; swing the tip so it drags across one → continuous stream that stops when the swing does.
- Both render modes: default 3D and `?render=2d` show the same sparks (same overlay path).
- `cli shot` on a bundle that bounces the hook: sparks visible, and two runs of the same shot produce identical frames (seeded PRNG, fixed-step advance).
- Perf sanity with the perf HUD: spark draw is one pass over ≤ 256 streaks and should not move the frame time measurably.
