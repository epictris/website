# Spring bodies

A new body behaviour: a body anchored to its authored position through a two-axis spring-damper.
It sags under its own weight, sags further under a load (a hanging player, a resting rock, rope tension), and on release springs back with a visible underdamped overshoot before settling.
First use: a plant whose leaf the player grabs, the spring standing in for the stem bending.

## Design decision: a flag-set on `rigid`, not a new kind

Mirror the `pivot` precedent exactly (`LevelBodyData.pivot`, `RigidBody2D.pivot`).
A spring body IS a rigid body: it has mass, material, friction, and every load path in the engine already speaks to a `RigidBody2D` through impulses - contacts (player standing on it, debris resting on it), the rope and chain solvers, the character push, explosions, water.
Making it a `RigidBody2D` with one extra force means all of those couple to it with zero new plumbing.
The alternative (an `AnimatableBody2D` with an internal spring sim) collides as infinite mass, so it would feel none of those loads without bespoke force-sensing at every interaction site.

The spring removes one degree of freedom: rotation.
A leaf on a stem translates on its spring; it does not spin.
This mirrors how `pivot` removes translation, and the implementation copies its mechanics (see below).
`spring` and `pivot` are therefore mutually exclusive - together they would describe a body that cannot move at all.

## Physics model

Per axis, a damped harmonic oscillator around the anchor point `A` (the body's built position):

```
offset = position - A
accel.x = -ωx² · offset.x - 2ζ·ωx · velocity.x
accel.y = -ωy² · offset.y - 2ζ·ωy · velocity.y
```

with `ω = 2π·f` for an authored frequency `f` in Hz per axis, and one shared damping ratio `ζ`.

Why frequency rather than stiffness `k`:

- `f` is dimensionless per `scaleLevelData` rules (a 1/s rate, like `drag`), so it passes through pixel/metre conversion untouched. A stiffness in N/m would too, but only by accident of the offset already being in metres; a frequency cannot be mis-scaled because there is nothing to scale.
- The free oscillation is mass-independent: `k = m·ω²` is implied, so a leaf re-authored in a heavier material bounces at the same rate and droops the same amount under its own weight.
- Self-weight droop has a closed form the author can reason about: `droop = g/ωy²`. `fy = 1 Hz` droops 24.8 cm; `fy = 1.5 Hz` droops 11 cm; `fy = 2 Hz` droops 6.2 cm.

Load response is NOT mass-independent, deliberately: an external load `F` (a 70 kg player is `686 N`) adds `F/(m·ωy²)` of droop, so a heavy stiff plant barely notices the player and a light whippy one plunges.
The editor's existing live mass readout is what the author tunes against.
Document this formula in the `levelFormat.ts` field comment.

Damping: default `ζ = 0.15` (visible overshoot, settles in a few swings).
Authorable as an optional `springDamping` field, 0..1, where 1 is critically damped (no overshoot).
One shared ζ; per-axis damping is a follow-up if ever wanted (the damping term uses each axis's own ω, so the feel already differs per axis).

Locked axis: an absent or 0 frequency on an axis means that axis is rigidly pinned to the anchor - `offset` forced to 0 and that velocity component zeroed in the integrate step.
This is the useful degenerate case (a leaf that only bobs vertically), and it falls out of the same code path.
At least one axis must have `f > 0`, else the author wanted `static`.

Integration: semi-implicit Euler in `World.integrate`, exactly where gravity is applied (`world.ts:596-600`):

```
v += (GRAVITY·gravityScale + springAccel) · dt
position += v · dt
```

Semi-implicit Euler is stable for `ω·dt < 2`, i.e. `f < ~19 Hz` at the fixed 1/60 step.
Clamp authored frequency to `0..8 Hz` in the editor inspector and again in `buildBodies` (belt and braces; 8 Hz is already visually rigid).

## Engine changes

### `src/engine/body.ts` - `RigidBody2D`

Add, following the `pivot` field's comment style:

```ts
// Null for every ordinary body; recorded replays predate the field.
spring: { anchor: Vec2; omegaX: number; omegaY: number; zeta: number } | null = null;
```

Rotation lock: extend `inverseInertia` the way `pivot` extends `inverseMass`:

```ts
get inverseInertia(): number {
  if (this.spring) return 0;
  return this.inertia > 0 ? 1 / this.inertia : 0;
}
```

This single getter covers every impulse path at once - contacts, the rope's torque arm, explosions - because they all write angular velocity through `inverseInertia`.
Do NOT model the lock as `inertia = Infinity`: `kineticEnergy` computes `0.5·inertia·ω²` and `Infinity·0` is NaN.
Do not reuse `kinematicRotation` either; that flag means "rotation is externally driven this frame" and the ball controller owns it.

### `src/engine/world.ts` - `integrate`

In the rigid-body branch (`world.ts:588`), add a spring arm alongside the pivot arm:

- Zero `angularVelocity` before the rotation step, with the same justification as the pivot's linear zero (area passes write velocity directly; inverse inertia 0 does not cover a direct write).
- Compute `springAccel` from the formulas above and fold it into the same `linearVelocity` update as gravity.
- Locked axis (`omega === 0`): snap that component of position to the anchor and zero that velocity component.
- The spring body takes the ordinary discrete position step (`continuous` stays false; a leaf is neither small nor fast).

Placement matters for the audit: `auditImpulses` snapshots velocities around `solveContacts` only, so a force applied in the gravity phase is outside the audited window and needs no bookkeeping, exactly like gravity itself.
Verify no audit violations appear in the new CLI cases.

The depenetration sweep and position pin need no exemption (unlike `pivot` at `world.ts:842-847`): a spring body may be pushed positionally, the spring recovers it.

## Level format changes

### `src/level/levelFormat.ts`

On `LevelBodyData`, next to `pivot`:

```ts
// Rigid bodies only: anchor the body to its authored position through a
// two-axis spring-damper. Frequencies in Hz per axis (0 or absent = that
// axis rigidly pinned); springDamping is the damping ratio, 0..1, default 0.15.
// Self-weight droop is g/(2π·fy)²; an external load F adds F/(m·(2π·fy)²).
// Mutually exclusive with pivot.
springFreqX?: number;
springFreqY?: number;
springDamping?: number;
```

- All three pass through `scaleLevelData` untouched (rates and ratios, not lengths); add them to the pass-through comment near `drag` (`levelFormat.ts:955-957`).
- `normalizeLevelData`: carry the fields through; if both `pivot` and a spring frequency are present, drop the spring fields and keep `pivot` (documented, deterministic).
- Absent fields = no spring, so every existing level and every recorded replay is bit-identical. This is the hard requirement; the replay corpus is the test.

### `src/level/buildBodies.ts` - rigid branch (`buildBodies.ts:400`)

After `rb.pivot = ...`:

```ts
if (!rb.pivot && (b.springFreqX || b.springFreqY)) {
  rb.spring = {
    anchor: rb.globalPosition,   // post-mountPieces: the centre of mass as built
    omegaX: 2 * Math.PI * clamp(b.springFreqX ?? 0, 0, 8),
    omegaY: 2 * Math.PI * clamp(b.springFreqY ?? 0, 0, 8),
    zeta: b.springDamping ?? 0.15,
  };
}
```

The anchor is captured after `mountPieces` so it is the body's centre of mass, which is the point every impulse and the position step already act through.

## Loading the spring: the player's weight

Contacts, rope tension and debris already load a `RigidBody2D`.
The one missing path is the ledge hang: `LedgeHangState` pins the player kinematically to the corner and applies no force to the body it hangs from.
For statics and movers that is correct (infinite mass); for a spring body it means a hanging player weighs nothing.

In `LedgeHangState.update` (and `LedgeClimbState` for the climb's duration), each frame while the grabbed body is a `RigidBody2D`:

```ts
if (this.body instanceof RigidBody2D) {
  const r = cornerWorld.sub(this.body.globalPosition);
  this.body.applyImpulse(GRAVITY.mul(Player.MASS * delta), r);
}
```

`GRAVITY` is exported from `world.ts:64`; `Player.MASS` is 70 kg (`player.ts:114`).
The lever arm `r` is moot while rotation is locked but correct if a free rigid body is ever hung from.
Frame order already works: the hang runs inside `player.resolveInput`, before `world.integrate` applies the spring, so the load and the response land in the same frame.

The coupling is deliberately one-way and stable: the player is positionally pinned to the corner (the hang re-derives the corner's world position every frame, so the player rides the droop down - the mover code path already does this), while the body feels a constant `m·g` load.
No force feedback loop, no oscillator driven by its own constraint.

Verify (do not assume) that `findGrab` offers a rigid body's corners: it filters only on `isSolid` and circle shapes (`ledgeDetection.ts:162-180`), and `wrapBodies` includes rigid bodies (`buildBodies.ts:344`), so grabbing should already work.
`isSeamOccluded` skipping `RigidBody2D` occluders (`ledgeDetection.ts:147`) is fine as-is.

Standing on the leaf: the character push (`world.ts:529`, `CHARACTER_PUSH_FACTOR`) transfers approach velocity, not standing weight, so a stood-on spring body will depress somewhat (repeated per-frame gravity catches) but not by a principled `m·g/k`.
Accept that for now; note it in the plan's follow-ups rather than widening this change.
Hanging is the mechanic being built.

## Invariants and tooling

### `src/sim/trace.ts` - `mechanicalEnergy` (`trace.ts:688`)

A spring stores elastic potential energy; the leaf springing back converts it to kinetic plus gravitational, which the `EnergyMonitor` would read as an unforced gain and flag.
Add the elastic term for spring bodies:

```ts
if (body.spring) {
  const d = body.globalPosition.sub(body.spring.anchor);
  total += 0.5 * body.mass * (body.spring.omegaX ** 2 * d.x * d.x
                            + body.spring.omegaY ** 2 * d.y * d.y);
}
```

Damping only removes energy, so the monitor's one-sided bound stays valid.
For every existing level `spring` is null and the sum is bit-identical.

### New CLI case set: `cli spring` (`src/sim/springCases.ts`, wired in `tools/cli.ts`)

Deterministic scripted-world assertions in the style of `cli contacts`:

1. **Droop**: a spring body settles at `offset.y = g/ωy²` within tolerance, `offset.x = 0`.
2. **Load and release**: apply a constant downward force for N frames (simulating the hang), assert the deeper equilibrium `g/ωy² + F/(m·ωy²)`; release, assert the recovery overshoots above the self-weight equilibrium (underdamped, ζ = 0.15) and then settles back within it.
3. **Axis independence**: a horizontal impulse oscillates x at `fx` while y stays at its droop; distinct `fx`/`fy` produce distinct periods (measure zero crossings).
4. **Locked axis**: `fx = 0` holds `offset.x` at exactly 0 under a horizontal impulse.
5. **Rotation lock**: an off-centre impulse leaves `globalRotation` at exactly 0.
6. **Audit clean**: run a case with contacts against the spring body and assert no `ContactAudit.violations`.

### Replay corpus

Run the full recorded-bundle corpus (`cli compare` / selftest) and require bit-identical results.
Every new field defaults to absent/null and every new code path is behind `body.spring !== null`, so this must pass with zero diffs.

## Editor

Follow the `pivot` pattern end to end:

- `src/editor/model.ts`: add `springFreqX`, `springFreqY`, `springDamping` to the body member model (`model.ts:316` area), default absent; carry through load (`model.ts:826`), the body-creation defaults, and serialization back to `LevelBodyData` (`model.ts:1413` pattern: emit only when set, only on `rigid`).
- `src/editor/editor.ts`: inspector controls next to the pivot checkbox (`editor.ts:2355`) - two numeric inputs (Hz, clamped 0..8, step 0.1) and a damping input (0..1), shown only for `rigid` bodies; disable the pivot checkbox while a spring frequency is set and vice versa. Show a computed droop readout (`g/ωy²` in cm) beside the y frequency, the same live-feedback idea as the mass readout.
- `src/editor/render.ts`: a spring badge at the body origin (mirror the pivot axle ring at `render.ts:1081`) - a small coil/zigzag glyph, because being spring-mounted is invisible on the geometry itself.

## Rendering

Nothing new.
A spring body is a `RigidBody2D`: both renderers already draw it at its interpolated transform, and the plant's visuals are ordinary geometry/mesh objects on the same body, riding its transform.
A bending-stem visual (skewing the stem mesh toward the leaf's offset) is a follow-up, not part of this change.

## Test level and E2E verification

- Author a small test addition (or a hand-written level entry alongside `TEST_MOVERS`) with one spring leaf: a thin oak rect, `fx = 1.5`, `fy = 1.0`, reachable by jump.
- E2E in the browser (dev server on 3100, do not restart it): grab the leaf, watch it droop under the hang; release, watch the overshoot and settle; fire the hook into it on the ball level and let the chain load it.
- Record a bundle of that session and keep it replaying bit-for-bit as the regression artifact.

## Ordering for implementation

1. Engine: `RigidBody2D.spring`, `inverseInertia`, `World.integrate` arm.
2. `mechanicalEnergy` elastic term.
3. `cli spring` cases (they test the engine alone, no level format needed - build the world in code).
4. Level format + `buildBodies` + normalization.
5. Ledge hang/climb weight transfer.
6. Editor model, inspector, badge.
7. Test level, replay corpus run, E2E pass.

Each step leaves the corpus bit-identical; run it after steps 1, 4 and 5 at minimum.

## Explicit non-goals (follow-ups)

- Rotational spring (leaf pitching under load).
- Principled standing-weight transfer from the character controller to rigid bodies.
- Per-axis damping ratios.
- Maximum-extension clamp (a stem that can only bend so far).
- Bending-stem visuals driven by the offset.
