# Camera paths

A **camera path** (`CameraPathData`, its own `cameraPaths` list beside `cameraRegions`) is an authored curve the camera rides.
The avatar is projected onto it and the camera targets a point further ALONG the route, so the screen leads the player toward where the level expects them to go.
A region frames a *place* and cannot say anything about where the player is going next, which in a traversal level is the more common thing to want; that is the whole of why this exists.

It is deliberately **not** a region with a funny shape.
A region is a closed volume tested by containment and a path is an open directed polyline tested by distance, so forcing one to impersonate the other would leave every shape helper (`pointInRegion`, `pathOutlineGrown`, the convexity rule) half-lying.
The two are instead generalised into one **rule set** (`CameraRule`, built once per level by `buildCameraRules`), because `activeCameraRegion`'s priority/buffer logic - highest priority wins, later author order breaks a tie, the incumbent keeps its grip inside a grown margin unless strictly outranked, entering is never buffered - is exactly what a path needs too.
`activeCameraRule` is that same function with two kinds of containment in it; `cameraRuleTarget` is `cameraRegionTarget` with a path arm.
Paths are listed **after** regions so a path beats a region at equal priority: the path is the level's primary guide and a region is the local exception, which says so with `priority`.

**Direction is the design**, and the lookahead never flips.
The path is directed by its vert order and always leads toward increasing arc length, so even when the player backtracks the screen keeps arguing for the authored way.
Smart direction inference was rejected rather than deferred - the whole point is that the camera argues.
Clamping at the ends is the correct degenerate behaviour: near the goal the camera comes to rest centred on the path's end rather than staring past it.

## The lead is an ellipse

`lookaheadX` and `lookaheadY` are how far ahead the camera looks per axis, and they are two numbers because the frame is **16:9**: there is far less screen above and below the avatar than either side of them, so one lead that frames a corridor well throws the player off the bottom of a shaft.
`pathLookahead` reads the pair through `ellipseReach` - as the semi-axes of an ellipse - and answers the arc length whose displacement lands on it - `lookaheadX` along a horizontal route, `lookaheadY` along a vertical one, and what fits between for anything diagonal.
It is resolved against the direction the route actually goes over that lead: the local tangent first, then one refinement against the chord to the point it lands on, since on a bend those are different answers and the ellipse is a statement about the DISPLACEMENT.
One refinement rather than iterating to a tolerance, because the correction is second order in the curvature and a fixed step is deterministic.

## The lookahead buffer

`lookaheadBufferX` / `lookaheadBufferY` are a **deadband on the arc length the lead is measured from**, and they are the answer to swinging.
A swing is an oscillation ALONG the route - the projection runs forward and back several times a second - so a lead taken from it exactly sloshes the camera with it, which no amount of `CAMERA_FOLLOW_TAU` fixes because the target itself is rocking.
`committedLeadS` clamps the committed point into a band of this width around the projection, so it does not move at all while the avatar stays inside: on the first half-swing the band is dragged to one edge, and every swing after that moves it by nothing.
Absorbed rather than damped, which is the difference from easing harder.

Clamping rather than "hold, then jump to the avatar" is what keeps it CONTINUOUS - the committed point is only ever dragged by the edge of the band, so there is no step in the target for the hand-off machinery to have to blend.
The price is that on genuine forward travel the lead is short by the band, which is what the buffer MEANS and what an author is choosing when they widen it.
It is centred on the avatar on acquisition, like the projection itself: entering is history-free, so the band never carries an offset earned somewhere else on the route.

The pair is resolved through `ellipseReach` - the same helper `pathLookahead` uses, and for the same 16:9 reason - against the direction the route runs where the BAND currently sits, which on a bend is not where the avatar is.

`cli camera` asserts the pair that makes the claim: the same swing with the band absorbs it (the committed point's range is exactly 0 and the camera's travel over the last second is 0) and without it does not (the camera keeps moving), plus that a swing WIDER than the band is dragged by exactly its excursion less the band on each side, and that the same swing is absorbed along a horizontal route and not along a vertical one when the two axes differ.

## The anchored episode

While the avatar is **anchored** - hanging on a taut line rather than moving under their own feet (`Level.cameraAnchored`, `BallLevel.cameraAnchored`) - the camera does not walk back down the track.

The reason is that a swing is an oscillation, so half of it is travel the level did not mean: the forward half says something about where the player is going and the return half says nothing, and a camera that answers both equally spends the whole arc rocking.
The band above absorbs an oscillation narrower than itself and can do nothing about a wider one - past the band the committed point is dragged by whichever edge it reaches, and a swing reaches both.

So while anchored the band is a **RATCHET**: `committedLeadS` keeps its rear edge and drops its front one, so the committed lead origin only ever moves further along the route.
A wide swing then walks it forward an arc at a time and holds it at the furthest it reached, rather than sawing it back and forth by the excursion less the band.
It stays one-sided rather than becoming a freeze because the forward drag is what keeps it continuous: the origin is still only ever moved by an edge of the band, so there is still no step in the target for the hand-off machinery to blend.

That leaves the case the ratchet cannot answer on its own, which is a backswing wide enough to put the avatar off the screen: the target is forward, they are behind it, and the **frame-edge guarantee** takes over and hauls the camera after them (see [**The latch**](camera.md#the-latch), which is what stops the forward half springing the camera straight back off where it left it).
The two are the same one-sided statement made at the two levels it happens on, and the guarantee wins where they disagree.

The episode ends when the anchor is released.
The lead origin is handed back to the band in one frame - a step of everything the ratchet had earned - and that step goes through the frozen-delta hand-off, exactly as a branch jump does and for the same reason.

It is gated on the anchor rather than applied always because that is the distinction it is about: a player rolling along the route does not oscillate, so there is nothing one-sided to say about them, and a ratchet with no episode boundary would have no moment at which it could ever be given back.

`cli camera` asserts the ratchet as its own pair - the same swing walks the origin forward and never back while anchored (holding at the furthest projection less the band) and is dragged both ways while rolling - plus the release (back in the band on the release frame, with no single frame of camera travel anywhere near the follow lag's own pace, and the camera arriving at the unratcheted lead).
The retired approach here was a SECOND authored band width for the anchored regime (`anchoredBufferX`/`anchoredBufferY`, eased between over a time constant of its own); it is gone, because a wider band is still two-sided and still rocks - it only rocks slower - and it charged an author two more fields for it.

## Curves

A path's nodes carry cubic **Bézier tangent handles** (`CameraPathVert`'s `inX/inY/outX/outY`, offsets from the node in the path's own frame), and the whole of what they cost is `flattenPath` (`lib/path.ts`, shared with a body's travel route - see [**Scripted movers**](movers.md), which is the other thing in this project that is an authored curve with a direction, an arc length and per-node keys): everything downstream rides a polyline, and a flattened cubic IS one.
An edge whose two facing handles are both absent contributes nothing but its endpoint, so a path of corners flattens to exactly its own nodes and every polyline path is bit-identical to what it was before handles existed - which is also why a corner writes four keys and no more.
Sampling is `PATH_FLATTEN_STEP` (25 cm) of control polygon per point, capped per edge; `cli camera` asserts the worst chordal error against the true cubic, which is what `range` is ultimately measured against.

In the editor a node's two grips are drawn at their own offsets, or as a **stub** a fixed screen distance along the edge when unset - a grip sitting exactly on the vertex it belongs to is unpickable, and a stub makes every corner one drag from smooth.
Dragging mirrors the opposite handle in direction and length (a smooth node); Alt at the press breaks the pair into a cusp.
Inserting on an edge is a **de Casteljau split at t = 1/2**, so a bowed edge gains a grip and changes shape by nothing; splitting the chord would straighten it the moment it was subdivided.
`Smooth` writes the Catmull-Rom tangent at every node (a third of the chord between its neighbours) and `Sharpen` zeroes them all.

## Keys

A node may **key** any of the path's tuning fields - `viewportScale`, `lookaheadX/Y`, `lookaheadBufferX/Y`, `rangeX/Y`, `falloffX/Y` and `buffer`, as optionals on `CameraPathVert` - so the framing and the grip change along the route: a tighter view through a corridor, a longer lead down a drop, a wider corridor where the level opens out.
A node that carries a value is a keyframe for THAT field only, and a node that carries none is transparent to it.
Per field, `pathParamsAt` holds the first key's value before it and the last key's after it, smoothsteps between two by arc length (flat at each key, for the same reason the falloff band is smoothstepped: a kink in the target is a step in the camera's velocity), and interpolates the view scale geometrically like every other zoom blend here.
That rule is `lib/keyframes.ts` (`buildKeyTrack`, `keyValueAt`) rather than the controller's own, since a mover's route keys its pose and its pace along exactly the same lines; `pathParamsAt` is the camera's ten fields run through it.
A field no node keys at all is the path-level field, exactly as before keys existed, so every level on disk is unchanged and `keys-without-keys-are-the-path` says so.

Keys live **on the nodes, not at authored arc lengths**, because a node is what the editor picks, drags, inserts, deletes and reverses, and a key that rides its node survives every one of those - a key at `s = 12.3` would name a different place the moment any node before it moved.
Putting a key mid-edge is one gesture, since inserting a node is a de Casteljau split that changes the curve by nothing and the new node keys nothing.
A node's arc length is only known once the curve into it is flattened, so `flattenPathNodes` reports where each node landed and the `PolylineIndex` carries `nodeS`; `buildCameraRules` lays each field's keys out along it once, as the rule's `keys` tracks.

The **target** fields (view, lead, lead buffer) are read at the **committed lead origin** (`pathLeadS`), not at the raw projection.
The lead origin sits still inside the lookahead deadband while a swing runs back and forth under it, so a swing across a zoom gradient moves the zoom by nothing - read at the projection it would pump every half-swing, which no easing fixes because the target itself is rocking.
`keys-are-read-at-the-lead-origin` asserts the pair: the same swing across a keyed gradient with the band leaves the zoom at rest, and without it does not.
Nothing new is needed for hand-offs: a rule change or a branch jump already runs the target through the frozen-delta blend, zoom ratio included.

The **grip** fields (range, falloff, buffer) are read at the **projection** - the global one on acquisition, the windowed one while held, the same standing (`PathStanding`) the grip was always measured against - because the range is a statement about the point on the route the player is nearest, and it is the quantity the offset is measured from.
`grip-keys-are-read-at-the-projection` asserts the smoothstepped corridor width against acquisition, and `grip-keys-hold-by-the-keyed-buffer` that a held path lets go by the buffer where the player is projected.
The one authoring consequence: acquisition uses the global projection, so a stretch keyed with a wide range grabs the camera from further away than the rest of the path, which is the intended meaning and the thing to watch where a wide section runs near another branch.

The corridor drawing is therefore a **sweep** (`pathCorridorSweepInto`) rather than a Minkowski sum.
The old construction ran the circular fillet walk in a space with y scaled by the axis ratio and let the canvas transform carry it back, which only works while one ratio holds for the whole path; the sweep offsets the route along its edge normals by the ellipse reach at each sample, fans each convex joint with the joint's own ellipse, and resamples straight edges at `PATH_FLATTEN_STEP` since the axes may change along one authored edge.
Every sample is then **held to the predicate itself**: an offset curve grows a swallowtail on the inside of a bend tighter than its offset, and where a circle's loop lies inside the zone an ellipse's need not - the point's nearest route point is elsewhere on the bend and sees it along a shorter reach, so the loop poked 19 cm outside what is tested.
A sample that tests outside is bisected back along its own offset ray onto the boundary, which is exactly the radial cusp the tested zone has there.
`corridor-sweep-is-the-zone-tested` holds every drawn point of a straight keyed route on the range ellipse of its own projection to a micron, and `corridor-sweep-never-leaves-the-zone` holds a bent one to none outside and none more than the bisection's millimetre inside, and is red without the pull-in - which is the test the fixed-ratio construction never had, and the one that keeps "exactly the zone tested" a claim rather than a hope.

In the editor a keyed node wears a **diamond** on the route, selected or not, so where the framing changes can be seen without clicking through every node; the debug overlay draws the same mark.
Picking nodes on a selected path opens a **node sub-panel** under the path's own fields, carrying the ten keyable fields for the picked nodes: blank is no key, and the placeholder is the value the node has anyway - the path's own when nothing keys the field, the interpolation's when other nodes do, computed through the same rule the game builds (`pathDataOf`) - so typing a key starts from what it is replacing.
Once a field is keyed anywhere on the path its path-level field is shown inert, reading `keyed`, with the keyed nodes in its tooltip, since its value is read nowhere and a live dial there would be connected to nothing.
Keys are a third per-node array on the editor's path shape (`keys`, beside `handles`), kept one per vert by `setPathVerts` and carried through deletion, insertion and `Reverse` by the same indices as the tangents; parallel rather than folded into the handle record so `Smooth` and `Sharpen`, which rebuild every handle, cannot drop a key by rebuilding it.
The editor draws every corridor through the rule the game builds (`pathDataOf` -> `buildCameraRules`), so the polyline, the keys along it and the sweep are the controller's own.
`cli camera` asserts the key at a curved node's arc length, the interpolation shape, the zoom riding a keyed route end to end, the format scaling the length keys and not the view key, and the editor round trip with a reversal.

## The corridor is an ellipse too

`rangeX` / `rangeY` are how far off the route the player may be while the path still narrates it, and `falloffX` / `falloffY` grow it into the band below - each pair the semi-axes of an ellipse around the route, so the corridor, the band and the release are all **screen-shaped**.
The frame is 16:9 - half of it is 4.8 m across and only 2.7 m down at `view × 1` - so with the old single circular `range` of 4 a player could be fully inside the corridor, the camera still centred on the route, and the ball past the bottom edge of the frame with the falloff not even started: the edge clamp was load-bearing for ordinary vertical excursions, and it is meant to be a backstop.
The defaults are the frame's own ratio (`DEFAULT_PATH_RANGE_Y` = 4 × 9/16 = 2.25), which puts the worst-case vertical offset the band ever asks for (~2.3 m) inside the 2.7 m half-height.

Unlike the lookahead's ellipse - resolved against the direction the ROUTE runs - these are resolved against the direction the player actually left the route in (`pathOffset`, the displacement from their projection), because that is the displacement the screen has to hold.
`pathRange`, `pathBand` and `pathRelease` answer the reach along that direction; `pathReleaseAxes` grows both semi-axes by `buffer`, so the release boundary stays an ellipse and the editor and overlay draw EXACTLY the zone tested - through `pathCorridorSweepInto`, which sweeps the route with the ellipse it carries at each sample (see [**Keys**](movers.md#keys) below for why it is a sweep and how it is held to the predicate).
The retired scalar `range` / `falloff` are folded into both axes by `scaleLevelData` at the one gate, so a level that authored a circle keeps exactly that circle; `cli camera` asserts the fold, the per-axis reaches, and - on the rule set - that acquisition is screen-shaped: 2 m below a 1 m vertical range does not take the path while 3 m past its end inside the horizontal range does, which a circular implementation cannot split.

## The falloff band

The falloff is the band OUTSIDE the range the path lets go over, and it exists because crossing the range used to swap the rule outright - the camera aiming down the route one frame and at the avatar the next, with the hand-off blend able to smooth that over but never make it small.

Through the band `pathFalloffWeight` interpolates the path's target toward the **null rule's** - the plain follow at the base zoom - smoothstepped from 0 at the range ellipse to 1 at the band's outer ellipse (both resolved along the player's own offset direction, above), so lookahead, viewport scale and everything else the path asks for fade together and by the band's outer edge the two targets are **identical**: the release delta is exactly zero and the boundary stops existing perceptually.
Smoothstep rather than linear so the weight is C1 at both edges - a kink in the target is a step in the camera's velocity, which reads as the camera catching on an invisible line.
A zero falloff (both axes) means no band at all: the path keeps its full grip out to the release and the hand-off blend covers the swap, which is the pre-band behaviour.

This replaced a positional drift that froze the avatar's screen position across the band, and the drift's three seams are why: the camera's behaviour flipped character at the range (riding the route one frame, tracking the avatar 1:1 the next), the drift capped at the falloff while the grip held all the way to the release (so the avatar slid again in the gap), and the lookahead never faded - so the release still swapped a full-lead target for the plain follow, a ~2.7 m delta the blend could smooth but never make small.
The trade accepted with the weight: the avatar's screen position is no longer perfectly frozen inside the band - frozen-screen-position was the drift's mechanism, not the goal, and the goal was no jump.

The weight is measured against the avatar's offset from their TRUE projection rather than from the deadbanded point the lead is taken from: this is about where they actually are relative to the route, which is the quantity the range is measured in - and while held it is the WINDOWED projection's offset, so at a switchback the fade is about the branch being ridden, exactly as the grip is.
The band extends the grip (`pathRelease` is the band's ellipse grown by `buffer` on both axes) but NOT the acquisition, which stays the core range - a graceful exit rather than a wider entrance, the same asymmetry the buffer already has.
Widening the acquisition to the band looks free (the weight is ~1 out there, so grabbing changes nothing on screen) and is not: a path acquired at zero influence still WINS the rule tie-break, so it would silently override a region the player is standing in with what amounts to the plain follow.

`cli camera` asserts the claim the whole thing is for, and all three cases are red without the weight: the weight's shape (0 inside, 1 outside, flat at both edges), the target interpolation with the null rule's target reached identically at the band's edge, and a controller ride in which the camera travels essentially nothing after the release fires.

Straying past the release ellipse **releases** the path, and the camera falls back to whatever rule governs where the player actually is - a region if one contains them, the plain follow otherwise.
Coming back re-acquires it.
Every one of those transitions is a rule change, so the controller's existing frozen-delta hand-off blends all of them for free; the one addition is that an outgoing path is evaluated at its tracked projection rather than at a fresh global one, since both targets have to be measured at the same instant and on the same branch or the frozen delta is a gap that never existed.

## The windowed projection

The load-bearing piece, and the reason `lib/path.ts` is more than a distance function.
A **global** closest-point query is discontinuous wherever the path passes near itself: on a switchback one frame's projection can teleport many metres of arc length, taking the lookahead target with it, and the hand-off blend cannot help because the rule identity has not changed.

So the controller tracks the projection statefully.
On **acquisition** it is a global `projectOntoPolyline` - entering is unbuffered and history-free, exactly like a region.
While **held** it is `projectOntoPolylineWindow` around last frame's `s`, with the window sized to what the player could plausibly have moved:

```
maxStep = |follow - lastFollow| + PATH_TRACK_SLACK_SPEED * dt
window  = [s - maxStep, s + maxStep]
```

The `followDelta` term means no legitimate move can outrun the window however fast the avatar is flung; the `dt` term keeps it frame-rate independent.
The path's **grip** is then measured to that windowed projection rather than to the global closest point, which is what makes the range mean what the author set it to: a player who drops off an upper branch toward a lower one has the release distance measured against the branch they were actually riding, so the path lets go, the fallback rule takes over with a blend, and the lower branch re-acquires with a fresh global projection and another blend.
`switchback-window` in `cli camera` is the case, and it is red against a window-ignoring implementation while every other case in the file is green.

The window has a failure mode of its own, and the **branch challenge** is its other half.
The grip is per-PATH while the geometry is per-branch, so a player who genuinely leaves the ridden branch and lands inside the corridor of a DIFFERENT branch of the same path was held by the ridden branch's falloff zone in preference to the branch under their feet - the incumbent and the containing rule are the same object, so "keep the incumbent" won, and the window then guaranteed the projection could never walk there.
`session-285f` is the shape of it: the ball fell off the upper branch clean through the lower branch's corridor at 0.05 m while the grip clung to the upper one at 5.4 m, the release finally fired at 1.06 m off the lower branch - 6 cm outside its range, so nothing ever re-acquired - and the ball settled inside the drawn falloff band with the camera plain-following, which reads as the camera being in the wrong place.
So a held path is challenged every frame by its own GLOBAL projection (`branchJump` in the controller): outside the ridden corridor (plus the jitter buffer) and inside the core range at the global answer, it re-acquires there exactly as it would after a release - a fresh projection, a re-centred lead, and the jump run through the frozen-delta hand-off so the arc gap between the branches blends instead of snapping.
The challenge cannot fire on the ridden branch itself, by construction rather than by threshold: a global answer inside the window IS the windowed answer, so the two distances agree and cannot sit on opposite sides of the range - which is what keeps the switchback protection whole.
`switchback-branch-reacquire` asserts both halves (the camera ends held on the branch the ball is on, and no single frame moves it more than 15 cm), and each is red alone: the challenge disabled ends held on the wrong branch, and the challenge without the hand-off snaps 0.29 m in one frame.

The whole thing stays **render-side and wall-clock driven**, so recorded replays and `cli selftest` are bit-identical: nothing here touches the sim.
A level with no `cameraPaths` reduces to a regions-only rule set and every code path is what it was.

`cli camera` (`src/sim/cameraCases.ts`) is the suite: the pure geometry (projection, arc length, the switchback), the controller (leading, backtracking, release, re-acquire, no snap at a hand-off, the path-beats-region tie-break), and the editor's `modelFromDisk`/`modelToDisk` round trip, which is the half nothing else can see - the editor rewrites the whole file every 750 ms, so a dropped field is gone from disk before anyone notices it was read.

In the **editor** a path is a camera-layer item whose `EdShape` is `{ kind: "path" }` - an open curve carrying its points and one handle pair each, `setPathVerts` its one writer (drops consecutive duplicates, requires two verts, re-centres `pos` on the point AVERAGE, a curve having no area centroid; handles are offsets from their own point, so the re-centring leaves them alone).
It is drawn with `+ Path`, a run of clicks finished with Enter or a double-click, and edited by exactly the vertex handles a polygon has minus the wrap.
It is excluded from the pass that fills and strokes closed outlines, because it has none: `outlineOf` can only answer its bounding box, and a box is not the thing.
Its bounds, its pick band and its rubber-band test all read the FLATTENED curve rather than the node points - a bowed edge leaves the node hull, and a box that does not contain what is on screen is a box the pick rejects before it ever tests the shape.
There is no convexity or simplicity rule: a path may cross itself, that being what a switchback is.
Its panel is its own rather than a variant of the region one - a path has no offset, no lock and no per-side buffer, and showing them greyed out would say it might - and it carries a `Reverse` action, direction being meaning.
