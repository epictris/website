# Rails

A third kind of surface for the hook, alongside attachable (the hook bites it) and hook-proof (the hook bounces off it).
A rail is a thin bar the manacle clamps AROUND rather than into, and once clamped the cuff can slide along the bar.
Ziplines, pipes, the handles of a hanging lantern.

## What it is

`rail` is a flag on a collision object, exactly as `impermeable` and `wrappable` are - per SHAPE, never per body - because the case it exists for is a body made of both: a lantern whose handles are rails and whose bulb, lid and base are hook-proof.
The hook clamps the handle, slides along it until the cuff's disc meets the lid, and bounces off the bulb.

The rail is solid for everything else.
The avatar stands on it, bodies collide with it, other chains wrap its corners.
Only the hook treats it differently.

## The centreline

A rail has a centreline in the shape's own frame (`lib/rail.ts`, `railCentreline`):

- a rect's is its medial axis - along the longer side, shortened by the half-thickness at each end so the cuff's centre never leaves the bar;
- a polygon's is the principal axis of its area through its centroid, clipped to the outline and shortened by the half-width across the axis, so a bar with mitred ends is a rail along its length;
- a circle's is a point at its centre - a peg the ring hangs on and pivots about without sliding.

The cuff's centre lives on the centreline.
The chain's end node is that centre (as it is for every anchor: the physics end and the middle of the manacle are the same point), which is INSIDE the bar, and that is the one place the rope solver has to be told something: the end's own piece is excluded from the self-intersection resolvers, or the span ending inside the bar would be read as the chain having wound around its own anchor.
Sibling pieces of the same body are scanned as ordinary scenery, so the chain still wraps the lantern's lid.

## The clamp

`RopeClamp` (`lib/rail.ts`) is a `RopeAttachment` whose contact position can move.
It carries the piece it is on, a parameter along that piece's centreline, and the range of that parameter the cuff may occupy.

The anchored regime is unchanged.
The chain end is a contact on the rail body, so the rope solver already treats a rail on a static as a fixed point and a rail on a rigid body (a hanging lantern) as a lever on that body, with every credit, refusal and lease the anchored chain has.
Sliding is one extra term inside the length solve.

### Sliding

In each iteration of `Rope.resolveLengthConstraint`, before the correction is split among the path bodies, a clamped end is offered the length error to remove by sliding.
The cuff is quasi-massless: a quarter-kilo ring under a fifty-kilo ball's pull accelerates at thousands of m/s², so within a frame it is wherever force balance puts it.
Force balance on a ring on a bar is the friction cone: the pull stays inside the cone and the ring is stuck, the pull leaves it and the ring slides until the pull is back on the cone's edge.

So the slide is exact and geometric rather than integrated:

1. The pull direction `d` is from the cuff toward the previous node.
   Decompose it against the rail tangent `t`: `p·t` along the bar, `p·n` across it.
2. Stuck if `|p·t| <= mu_s·|p·n|`.
   The static coefficient while the ring is stuck, the kinetic one while it slides (hysteresis, as the hook's own contact friction has).
3. Sliding, the ring moves along `t` toward the ball's plumb by exactly the amount that removes the error from the last span, `ds = p·t - sqrt((L - e)² - (p·n)²)`, or to the foot of the perpendicular if the ball is closer than that;
4. capped at the point where the pull meets the kinetic cone, `s_cone = p·t - mu_k·|p·n|`, past which the ring would be pushing the ball rather than following it;
5. capped at the range the piece allows;
6. and if the range's end is a JOIN to a sibling rail piece (their centrelines within a bar's thickness of each other), the clamp hops onto that piece and continues with what is left.

The ring reaching the cone's edge does NOT lock it again within the frame.
The friction state is decided once a frame, on the solve's first look at the clamp: a running ring whose pull has come back inside the kinetic cone since the last frame has come to rest and is stuck from there; one still outside it runs to the edge again.
The first version re-stuck the ring the moment it reached the edge, and that was a stick-slip judder at frame rate - the lean sawtoothed 16.9° to 19.3° under a ball driving it steadily, breaking away at the static cone every frame - where a steady slide at the kinetic angle is the physics.
What the settled version produces for a ball hanging under a horizontal rail is exactly Coulomb: on a frictionless rail the chain hangs vertical to 0.00° and the ball coasts at constant speed (a zipline), and with friction `mu` the chain trails at `atan(mu)` to a tenth of a degree and the ball stops within `v²/(2·mu·g)`.

The slide removes length, so it lands inside the solve's monotone guard like everything else: the snapshot the guard restores includes the clamp's parameter.
Moving the contact bumps the transform epoch, so the memoized span list is rebuilt.

### Friction

`RAIL_STATIC_FRICTION` and `RAIL_KINETIC_FRICTION` in `lib/rail.ts`, scaled by the body's authored `friction` exactly as a rigid body's contact friction is - so a zipline authored at `friction: 0.1` is slick and a rusty handle at `friction: 1` grips.
Both are guesses to be played; nothing here should be encoded in a case until they have been.

First play (`session-526f`, a friction-1 bar): 0.35 / 0.3 read as no grip.
The cone test is a pure direction, so the pair sets the swing angle a hanging ball reaches before the cuff gives way, and 19° is passed on every ordinary swing of a 0.6 m chain - the cuff crept 15-20 cm at each extreme.
Raised to 0.8 / 0.6 (39° / 31°): the same inputs re-simulated hold the cuff through swings to 38° and still shift it 10-20 cm on the pumped swings past 42°.

Second play (`session-212f`, a friction-1 bar sloped 30°): a ball hanging still rode the cuff down the whole bar at 1 m/s.
The cone is measured from the rail's NORMAL, and gravity alone is already 30° off it on that slope, so 31° of kinetic cone was the balance point.
The ask is that friction 1 feels like rubber, which is what it means for every other surface, so the pair is 1.5 / 1.4 (56° / 54.5°) with the gap kept small: a breakaway frees `across·(1/cos a_s − 1/cos a_k)` of chain, 8% of the span at this pair.

### Range

The range is clipped at clamp time by sweeping the manacle's disc along the centreline against the body's OTHER non-rail pieces (`bodySweepCircle`).
The cuff stops where its disc meets the lantern's lid, which is what a ring on a handle does.
Sibling rail pieces do not clip (the ring passes a joint), and other BODIES do not clip either: the hook body is removed when it clamps, as it is when it bites, so a rail that passes through some other body's wall is a level-design mistake rather than a collision.

An open rail end stops the cuff.
Sliding off the end is a possible later flag, not the default.

## Attach

The flight sweep already sorts surfaces into attachable and hook-proof; a rail is attachable.
What changes is that the attach callback is now told the PIECE that was struck (the sweep, the blocking contact and the rest probe all know it), rather than re-deriving it from the anchor point, which at the junction of a handle and a lid could name the wrong one.
On a rail piece the callback builds a `RopeClamp` at the nearest centreline point to the bite instead of a `RopeAttachment` at the bite.
The chain length grows to the path reached, as every anchor's does.

## Drawing

The manacle on a rail is drawn with its axis ALONG the bar, which is what "clamped around" looks like.
In 3D the torus is turned so its axis is the rail tangent.
In 2D the cuff is foreshortened along the tangent, the way a ring seen nearly edge-on is, and is not clipped as buried: the bar passes through the ring rather than the ring being half in the bar.
`BallPlayer.manacleFacing` is the tangent for a clamp, and `manacleOnRail` says which drawing to use.

A rail piece wears a centreline glyph in the game's 2D renderer and the editor - a light stroke down the bar's middle - so an author can see where the cuff will sit.
The 3D renderer draws the authored form and needs no change; a round bar is an authoring choice for the geometry object.

## Editor

A `rail` checkbox in the inspector beside hook-proof, per shape, mutually exclusive with hook-proof (a hook-proof rail is a contradiction: the loader lets hook-proof win).
`EdItem.rail`, loaded and saved like `wrappable`.

## Cases

`cli rails` (`src/sim/railCases.ts`), pure physics with bounds:

- a hook thrown at a horizontal rail clamps, and the anchor lies on the centreline;
- one thrown at the lantern's lid bounces;
- a ball hung under a horizontal rail with the pull inside the static cone does not slide;
- on a frictionless rail a ball given horizontal speed keeps it, and the chain hangs vertical;
- on a rail with friction the ball decelerates at about `mu_k·g`;
- the cuff stops where its disc meets the lid, never past the range;
- a cuff crosses the joint between two rail pieces;
- the chain-tunnel and energy invariants hold throughout.

## Level

`levels/rail-test.json` as `RAIL_TEST`: a hanging-lantern silhouette (lid, bulb and base hook-proof; two three-piece handles as rails), a long low-friction zipline, and a peg.
`levels/ball.json` is the author's and is left alone.
