# Rails

A third kind of surface for the hook, alongside attachable (the hook bites it) and hook-proof (the hook bounces off it).
A rail is a thin bar the manacle clamps AROUND rather than into, and once clamped the cuff can slide along the bar.
Ziplines, pipes, the handles of a hanging lantern.

## What it is

`rail` is a flag on a collision object, exactly as `impermeable` and `wrappable` are - per SHAPE, never per body - because the case it exists for is a body made of both: a lantern whose handles are rails and whose bulb, lid and base are hook-proof.
It is meaningful on one shape kind only, a `curve` (see **The bar**): a rail IS its curve.
The hook clamps the handle, slides along it until the cuff's disc meets the lid, and bounces off the bulb.

The rail is solid for everything else.
The avatar stands on it, bodies collide with it, other chains wrap its corners.
Only the hook treats it differently.

## The bar

A rail is an authored **curve with a width** (`ShapeData`'s `curve`: a cubic Bezier node list, the same node the camera path and a body's travel route have, plus `width`).
That is the whole of where a rail's geometry comes from, and the flag is only meaningful on one: a box or a vertex loop has no line down its middle that the author drew, and the medial axis one used to be asked for was a guess at one.

The engine has no curved primitive and is never getting one - a polygon here is convex without exception - so the curve is **stroked at load** into the convex pieces that tile it (`lib/stroke.ts`), exactly as a concave outline is cut into the pieces that tile it.
One quad per segment of the flattened, simplified centreline, sharing a mitred edge at each joint, with a bevel triangle where the mitre would spike past `STROKE_MITER_LIMIT`.
The tiling is exact - no overlaps, no gaps - so the piece areas sum to the bar's and their masses to its mass, which is what lets the build weigh a curve as it weighs a decomposed polygon.

**One polyline answers everything.** The cuff rides `line`, the pieces are built from `line`, and the drawn outline is offset from `line`, so the bar that is drawn, the bar that is collided and the bar the ring slides along cannot disagree by a pixel.
The flattener samples by control-polygon length and a Douglas-Peucker pass then drops the samples that buy nothing (`STROKE_TOLERANCE`, a centimetre, capped at a fifth of the half-width): a straight bar is ONE piece however many nodes it was drawn with, and a gentle four-metre bow is a handful rather than twenty.

## The centreline

The cuff's centre lives on that curve, as `s` metres of arc length along it, and everything about where the ring is is read off `lib/path.ts`'s own arc-length index - the point at `s`, the tangent at `s`, the projection of the bite onto the line.
`RailCurve` (declared in `engine/shapes.ts`, built by `lib/rail.ts`) is that index in the BODY's local frame plus the half-width and which piece covers each segment; every piece the stroke produced holds the same object, so a hook that strikes any of them finds the whole bar.

The chain's end node is the cuff's centre (as it is for every anchor: the physics end and the middle of the manacle are the same point), which is in the bar's BORE - inside the bar for a push fit and a centimetre under it for a thin one - and that is the one place the rope solver has to be told something: the end's own piece is excluded from the self-intersection resolvers, or a span ending on the bar would be read as the chain having wound around its own anchor.
Sibling pieces are scanned as ordinary scenery, so the chain still wraps the lantern's lid - and still bends round the outside of a curved rail, which is what a chain lying along a bend does.

## The clamp

`RopeClamp` (`lib/rail.ts`) is a `RopeAttachment` whose contact position can move.
It carries the bar's curve, how far along it the cuff stands, and the range of that arc length the cuff may occupy; which PIECE its contact names follows from where it stands, so nothing has to be kept in step with anything.

### The ring on the bar

The cuff is a RING, not a pin, so its centre is not on the bar's centreline: its inside rests on the bar at one point and everything else about it hangs from that point, the way a chain link laid over a rod does.
`RopeClamp.seat` therefore SWINGS the cuff rather than shifting it: the point it rests on is the bar's surface square across from where the ring stands (so `s` is that contact's arc length), and the cuff's centre - the chain's end node, and the centre of the drawn ring - is the bore's radius from it along the hang.
A chain leaning `a` off the bar's normal carries the cuff `R·sin a` along the bar and leaves it `R·cos a` under the contact.
The bar's own thickness is what stops the swing: a ring of inner radius `R` tilted by `a` presents an aperture of `R·cos a` across the bar, so it tilts until that aperture is the bar's half-width - `cos a_max = h/R`, which is all the arithmetic needs and no trig - and then jams, which is the configuration friction holds it in anyway.
A push fit never tilts at all.

Massless to the ball is not the same as stateless.
Three things about the ring are its own, carried from frame to frame rather than re-derived from the chain: which surface of the bar it rests on (`side`, decided when the hook threads on and never changed - the ring does not swap sides of the bar), how far it has tilted on that surface (`tilt`), and how fast it is running along the bar of its own accord (`speed`).
The tilt follows the pull - or gravity, when nothing pulled last frame - at no more than `RAIL_TILT_RATE` and never past the jam, nor into a closed end; a pull from the far side of the bar leans the ring as far as the jam allows toward the pull's run along the bar, and the chain bends.
Re-deriving the hang from the pull every frame gave a facing that flipped end for end as the pull crossed the bar, a ring that lay flat along a bar it should have jammed on, and no answer when the chain was slack; making the manacle a real rigid body threaded on the bar instead put a light body in series between the ball and the lantern under three solvers a frame, and juggled both (`session-225f`).

While nothing is pulling, the ring is a bead on a wire (`RopeClamp.coast`): it accelerates at gravity's component along the bar, held by Coulomb friction on gravity's component across it, so a ring threaded onto a vertical bar falls at `g` from the frame it is threaded and a ring on a horizontal bar lies where it was put.
While the chain is pulling, the solve says where the ring stands and `coast` only observes the speed that came to, so a ring on a zipline keeps coasting after the chain goes slack.

Both are settled once a frame in `Rope.settleClamp`, before the path is regenerated and outside the length solve, because a ring hangs and falls whether or not the chain is taut and the solve returns before it looks at a clamp with no error to correct.
The ring follows the pull unless the chain is slack by more than a bore's radius - the amount the ring's own tilt can make - and the span ending on the ring does not wrap any piece of the bar's body inside the cuff's disc, since the chain leaves the ring at its rim (`session-189f`: a wrap on the lid 12 mm from the ring's centre had the ring hunting every frame).

This is what makes the drawn cuff read as hanging on the bar rather than pinned through it: the ring's inside edge lands exactly on the bar's surface and pivots there, because that is where the sim put it.

The anchored regime is unchanged.
The chain end is a contact on the rail body, so the rope solver already treats a rail on a static as a fixed point and a rail on a rigid body (a hanging lantern) as a lever on that body, with every credit, refusal and lease the anchored chain has.
Sliding is one extra term inside the length solve.

The chain hangs from the ring's RIM, not its centre: the clamp keeps which end of the ring the chain leaves over (`rimSign`, the end toward the pull), the slack drape is pinned at that point (`rimPoint`), and the renderers draw the path as it comes.

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
5. capped at the range the bar allows;
6. and re-solved against the direction the bar runs where the ring has got to, up to `SLIDE_STEPS` times, so a ring running round a bend is held by the cone the bar has THERE rather than by the one where it set off.
   There is no hop and no joint: a bend is one curve, and the pieces under it are collision geometry the ring never has to know about.

The ring reaching the cone's edge does NOT lock it again within the frame.
The friction state is decided once a frame, on the solve's first look at the clamp: a running ring whose pull has come back inside the kinetic cone since the last frame has come to rest and is stuck from there; one still outside it runs to the edge again.
The first version re-stuck the ring the moment it reached the edge, and that was a stick-slip judder at frame rate - the lean sawtoothed 16.9° to 19.3° under a ball driving it steadily, breaking away at the static cone every frame - where a steady slide at the kinetic angle is the physics.
What the settled version produces for a ball hanging under a horizontal rail is exactly Coulomb: on a frictionless rail the chain hangs vertical to 0.00° and the ball coasts at constant speed (a zipline), and with friction `mu` the chain trails at `atan(mu)` to a tenth of a degree and the ball stops within `v²/(2·mu·g)`.

How far the ring may run in a frame is bounded by what is driving it: the speed it already had along the bar, the speed of the node pulling it measured along the bar, and one frame of gravity on top, capped by `RAIL_MAX_SLIDE_SPEED`.
A ring under a ball falling down a vertical bar falls with the ball at `g`, a ring under a coasting zipline ball keeps pace with it exactly, and a ring a ball has swung past the static cone slips away at the ball's own speed rather than leaping to the cone's edge in a frame.

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

The range runs from a half-width in from each end of the curve that ends in something, and to the very end of one that ends in the air, and is clipped at clamp time by sweeping the manacle's disc along the curve, segment by segment, against every piece of the body that is NOT part of this bar.
The cuff stops where its disc meets the lantern's lid, which is what a ring on a handle does.
Pieces of the same curve do not clip (they are the bar), and other BODIES do not clip either: the hook body is removed when it clamps, as it is when it bites, so a rail that passes through some other body's wall is a level-design mistake rather than a collision.
Whether an end is OPEN is asked of every body (`railEndIsOpen`): a bail ends inside its lid, a zipline between two posts ends inside the posts, and a bar that ends in the air is open there.

A ring that reaches an open end runs off it.
`coast` reports it and `BallPlayer.dropFromRail` turns the ring back into the dangling chain tip: spawned just clear of the bar's end face, at the speed it was being driven at, and disarmed until it is thrown again.
A bar shorter than it is thick has no room for the cuff to stand anywhere but its middle, and that is what a PEG is now: the range collapses to a point and the ring hangs there and pivots without sliding.

## Attach

The flight sweep already sorts surfaces into attachable and hook-proof; a rail is attachable.
What changes is that the attach callback is now told the PIECE that was struck (the sweep, the blocking contact and the rest probe all know it), rather than re-deriving it from the anchor point, which at the junction of a handle and a lid could name the wrong one.
On a rail piece the callback builds a `RopeClamp` at the nearest centreline point to the bite instead of a `RopeAttachment` at the bite.
The chain length grows to the path reached, as every anchor's does.

## Drawing

The manacle on a rail is drawn as a ring with the bar through it: foreshortened in 2D the way a ring seen nearly edge-on is, turned a quarter turn in 3D, and never clipped as buried.
The axis it is turned about is SQUARE TO THE WAY IT HANGS, not along the bar (`railCuffAxis` on `RopeClamp.hang`).
A cuff that bit a face is bolted to it and keeps the facing it bit with; one on a rail is bolted to nothing, and a ring resting on a bar hangs in the plane of whatever is pulling it - a curtain ring on its rail - so it pivots on the bar as the ball swings and stands plumb under a sloped bar rather than square to it.
The rail's tangent picks which of the two square directions to use (the one that runs with the bar), so the cuff never flips end for end as the pull crosses the plumb.
`BallPlayer.manacleFacing` reads it live off the clamp for a rail (the frozen facing is the tangent where the hook STRUCK, which on a curved handle is not the tangent under the ring any more) and `manacleOnRail` says which drawing to use; there is nothing left for either renderer to work out.

A rail wears a centreline glyph in the game's 2D renderer and the editor - a light stroke down the bar's middle, which is the authored curve itself - so an author can see where the cuff will sit.
It is drawn once per CURVE rather than once per piece.
The 3D renderer draws the authored form and needs no change; a round bar is an authoring choice for the geometry object.

## Editor

`+ Curve` on the scene layer is the camera path's own tool and gestures - a run of clicks, nodes dragged, tangent grips bowed, a midpoint clicked to insert, Alt+click to remove - with the bar's `width` in the inspector beside them and a live piece count.
A freshly drawn curve is a rail, that being what the tool is for; the `rail` checkbox beside hook-proof unticks it into a plain curved wall, and it is offered on a curve alone, mutually exclusive with hook-proof (a hook-proof rail is a contradiction: the loader lets hook-proof win).
`EdItem.rail`, loaded and saved like `wrappable`; the curve itself is an `EdShape` of kind `path` with a `width`, which is the camera path's shape with the one field it has no use for.

## Cases

`cli rails` (`src/sim/railCases.ts`), pure physics with bounds:

- a curve's stroke tiles the bar exactly (piece areas against the outline's), every piece convex, the line within tolerance of the cubic, a right angle mitred and a hairpin bevelled;
- a hook thrown at a horizontal rail clamps, and the anchor lies on the centreline;
- one thrown at the lantern's lid bounces;
- a ball hung under a horizontal rail with the pull inside the static cone does not slide;
- on a frictionless rail a ball given horizontal speed keeps it, and the chain hangs vertical;
- on a rail with friction the ball decelerates at about `mu_k·g`;
- the cuff stops where its disc meets the lid, never past the range;
- a ring threaded onto a vertical bar falls at `g` from the first frame and lands on the block at the bar's foot;
- a ring driven off a bar's open end comes back as the dangling tip, clear of the bar and at the speed it left with;
- pulled along the bar the tilt stops at the jam, a reversed pull turns it by one frame's rate, a pull from above rolls it onto the underside, and a pull along the bar flips nothing;
- a cuff runs round a bend in one curve, crossing from one of its pieces onto the next;
- the chain-tunnel and energy invariants hold throughout.

## Level

`levels/rail-test.json` as `RAIL_TEST`: a hanging-lantern silhouette (lid, bulb and base hook-proof; two curved handles as rails), a long low-friction zipline, a peg and a sloped bar.
`levels/ball.json` is the author's; its two handles were authored as polygons before rails were curves and have stopped being rails until they are redrawn.
