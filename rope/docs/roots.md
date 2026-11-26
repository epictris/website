# Roots

A **root** is a tree of tapered curves the author draws in the editor, and the game grows a root from it.
Background scenery the hook can catch and nothing else touches, like a vine; and, ticked to spring, a root that bends under the ball and comes back.

There is no new physics in it, and that is the design.
Every piece of what a root needs already existed, each with its own suite, and a root is those pieces wired together:

- a branch is an authored **curve** (`ShapeData`'s `curve`), stroked at load into the convex pieces that tile it ([rails](rails.md)), with one new field, `tip`, that **tapers** it;
- a root is a **body** of those curves, so the tree is one rigid thing ("the root structure resolves to a standard rigidbody");
- the cuff **threads onto** a branch as a ring, square to it, and holds there, because each branch is ridden as a rail ([below](#the-ring-on-a-root));
- it is **hook-only** because its body is `passable` ([hook-surfaces](hook-surfaces.md#hook-only-bodies));
- it **springs** because its body is a rigid `pivot` with a torsion return spring, its bearing at the base of its trunk ([pivot-and-spring-bodies](pivot-and-spring-bodies.md#an-authored-bearing-and-the-torsion-spring)).

What is new is the tree (which branch grows out of which), the editor tool that draws one, and the mesh the game generates for it.

## The format

A root branch is a collision object whose shape is a `curve` and which carries `root` (`RootBranchData`, `levelFormat.ts`):

```json
{ "type": "collision",
  "shape": { "kind": "curve", "width": 16, "tip": 2.5, "verts": [ { "x": 0, "y": 0, "outX": 60 }, { "x": 150, "y": 80 } ] },
  "root": {} }
{ "type": "collision",
  "shape": { "kind": "curve", "width": 9.6, "tip": 2.5, "verts": [ ... ] },
  "root": { "parent": 0, "at": 0.5 } }
```

- `tip` is the bar's width at its LAST node; `width` is its width at its first.
  The taper is linear in arc length along the collision centreline (`taperedHalfWidths`, `lib/stroke.ts`).
  It is a length and scales like `width`; absent is the constant bar every curve authored before it is, built bit-identically.
- `root: {}` is a **trunk**: it grows from its own first node.
- `root: { parent, at }` is a **branch**: `parent` is the index in the same body's `objects` of the root piece it grows out of, and `at` is how far along that piece's centreline, as a fraction of its arc length.
  A fraction rather than a length, so it scales by nothing and a parent reshaped by hand keeps its branches at the same place along it.
- A branch's own **first node IS the junction**.
  The file states the junction twice (the node, and `parent`+`at`), and the node is what everything downstream reads: the build never looks at `parent` at all.
  `parent` and `at` are authoring data, which the editor keeps the node in step with (below), and which `cli levels` checks.

A root piece is passed over by the format-1 grey-box migration (`withDebugFromGreybox`), as a belt is: it draws its own mesh, and roots postdate the grey box, so a root in an unstamped file (a playtest's hand-written level) never gets debug geometry switched on over it.

An authored tapered curve is **never a rail**: a rail's cuff tilts in its bore across a constant half-width (`RailCurve`), so the build ignores `rail` on one and the editor does not offer it.
A root's branch is a rail of its own kind instead ([below](#the-ring-on-a-root)).

## The ring on a root

Since 2026-11-01 the hook does not bite a root: the cuff **threads onto the branch it strikes as a ring**, square to it, and is **held where it threads on**.
It was a bite until then, the cuff bolted at whatever angle it arrived at.
The ring is a rail's clamp (`RopeClamp`, [rails](rails.md)) on a curve the build makes for every root branch (`attachRails`, `RailCurve.root`), so the anchor regime is a rail's: a lever on a sprung root's body or a bending root's segment, a row of the island solve.
Three things differ from a rail's ring:

- **It stands square.** The ring is a push fit on the branch's centreline, its axis along the branch, whatever the branch's width (`tiltMax` is 0), the way it stands on a vine; it never tilts in a bore as a rail's ring does. Which end of the ring the chain leaves over still follows the pull with the rail's hysteresis (`RIM_FLIP_LEAN`), so a ball swung over the branch to its far side re-hooks the chain over the far end; on an authored push-fit rail it never did, and still does not.
- **It never slips.** The row holds it rigidly (`BallChainRow.setupRing` sets no cone up for it, `Rope.rowCreepLaw` gives it no creep). A friction cone was tried first and read as "holding fast until suddenly it slips a long way"; a viscous creep behind a static cone, with both coefficients per branch, came next; and then Tris preferred no slip at all (all 2026-11-01). Both were removed with their fields, as was the ring's hand-over across a bend, which only a slipping ring needed.
- **It threads on clear of forks and walls.** Where the ring would stand inside ANOTHER branch of the same root is a stop (`RootRail.blocked`, measured at build by `rootBlocked`: the ring's square silhouette, `MANACLE_THICKNESS` along the branch by `MANACLE_LENGTH` across it, walked along the centreline at 5 mm against the other branches' pieces of every body of the root, each stretch's edges bisected to 0.1 mm), and so is where it would stand inside a SOLID STATIC body, the rock wall a root grows out of (`rootWalls`, measured when the hook threads on). A hook that strikes inside one threads on at its nearer edge (`clearOf`), so the ring is never drawn inside the branch beside it or the rock. The geometry decides, not `parent`.

**The walk asks only the pieces near the ring.** Each step tests only the pieces whose bounding box comes within the ring's half-diagonal (plus a millimetre) of where it stands; a piece clear of that box cannot touch the ring, and `shapeContacts` at no slop reports nothing for a pair with a gap between them, so the stops are bit for bit the ones asking every piece finds.
Until 2026-11-06 every step asked every piece in the whole branch's box, and the walls are measured on the frame the hook strikes: `session-235f`'s 17.3 m branch beside a 13-piece rock was 3460 steps and 44,625 manifolds, 15-22 ms of that frame in bun and 25-41 ms in V8, on every attach (Tris: "why does my screen jitter every time i connect to the root"). Culled it is 312 manifolds and under 2 ms.
`cli perf` prints the count per frame (`ring`, `SolverStats.ringTests`), and `root-walls-culled` holds the culled walk to the every-piece walk's stops and to a twentieth of its manifolds.

A ring on a root never runs off it: it never moves. The 2D renderer draws no rail line down a root.

**On a root thicker than its bore the cuff opens** (Tris, 2026-11-01: "the manacles open slightly to accommodate the root's girth"). The ring knows the branch's half-width where it stands (`RopeClamp.girth`, from the stroke's taper, `RootRail.halfWidths`); past the bore's radius (`MANACLE_BORE / 2`, 3.65 cm) its jaws swing open about the hinge pin until their tips rest on the branch, and the cuff stands out from the centreline along its hang until its bore at the hinge rests on the bark (`RopeClamp.cuffOpening`: in the cuff's frame, the pin at `R`, the root centred at `b - rho`, a jaw tip `R + b` from the pin on its surface when `cos a = (A² + L² - rho²)/(2AL)`, `A = R + rho - b`, `L = R + b`; at most 75°). A 14 cm root opens each jaw 52° and stands the cuff 34 mm out. Render-side only: the sim's anchor is the centreline either way. The drawn cuff carries it (`ManaclePose.open`, and the offset in its centre), the chain's end and the slack drape are pinned to the moved hinge (`rimPoint`), and the 3D cuff is built as the hinge's knuckles and two jaws on the pin (`buildManacle`, `setManacleOpen`), each jaw half the band with its cut face capped, half the lock plate and its rivets, so shut it is the one band it always was. The jaws open in depth, round the branch, so face-on the cuff changes little; it shows from the side.

## Moving roots hit the scenery

A sprung root (and every moving root) is still hook-only to the ball, the chain and every rigid body, but the STATIC scenery stops it (`RigidBody2D.hitsStatics`, set by `stopRootsAtStatics` in the build): it bends against the rock wall or the ledge under it rather than through them.
Until 2026-11-01 a `passable` body collided with nothing at all, and a sprung root swung straight through the rock it grew out of; the flag keeps a passable body's pairs with solid statics in the world's contact gather and depenetration, and only those, which is the rule a non-solid body already had (`VineLink`).
The rock a root is ROOTED in is a collision exception: any solid static holding the first node of one of the body's branches.
The body and not the piece, because a straight root is one piece from inside the rock to its tip; and the first node rather than whatever the root overlaps, because a sprung root spawns at its settled pose (`applyRestPose`), which knows nothing of contacts, so a soft one drooped onto a ledge would otherwise except the ledge.
That settled pose is also an authoring trap: a root soft enough to settle INTO a ledge spawns through it, and is then under it rather than on it (a 0.5 Hz root in the `root-collide` scene settles at 30°, past its ledge). Stiffen it, or move the ledge.
None of `ball.json`'s ten sprung roots spawns overlapping a static; two have their first node in rock and except it.


## Bending roots

A root bends at points along its branches (`RootBranchData.bends`, since 2026-11-01): each bend is a place along the branch, a fraction of its arc length as a branch's `at` is, with a return spring (`freq`, hertz, `ROOT_BEND_FREQ` 2 absent; `damping`, the ratio, `ROOT_BEND_DAMPING` 0.2 absent).
It is one authored root in one body, so the tree, its forks and its mesh stay one thing; until then a root that bent was a second root body on a pivot beside a static one, which the forks could not see across and the mesh drew as two roots.
A bend at 0 on a branch hinges the whole branch where it grows out of its parent; at 0 on a trunk, or at 1, it bends nothing (the trunk's base is the body's own `springs`).
Several bends on one branch make a chain of segments, so a branch bends in more than one place.

**The build** (`planBentRoot` / `buildBentRoot`, `level/buildBodies.ts`) keeps the body's own engine body for everything before the first bend of each branch and every branch growing out of that, and makes every stretch past a bend a SEGMENT: a hook-only rigid body the statics stop ([below](#moving-roots-hit-the-scenery)), weighed from its own pieces.
A branch growing out of a stretch moves with that stretch; one with a bend at 0 is a segment of its own from its first node.
The branch is stroked once with a vertex standing on every bend (`strokeCurveCut`, `lib/stroke.ts`): the cuts go in after the fold merge, as collinear vertices, so the pieces either side of a bend are the halves of the one they replace, the taper reads the same everywhere, and a branch that bends nowhere is stroked exactly as it always was (a cut that would fold the stroke takes the nearer vertex instead).
The pieces are dealt to the stretches, each stretch has its own rail curve, and the forks are measured across EVERY body of the root (`attachRails`' `outside`), never between two stretches of the same branch.
A sprung root's own body spawns at its settled angle as before, and its segments are carried by the same rigid motion (`carrySegments`); the hinges are then settled at build (`settleRootBendsAtBuild`), so a bending root spawns sagged onto its springs as a sprung root spawns at its rest angle. Not by `settleTiesAtBuild`'s clearance rule, which settles only a unit clear of anything that can move: a root's segments meet only statics, and asked that rule, `session-79f`'s branch next to the ball's spawn and a sprung root was left unsettled and fell 38° under its own weight before the ball reached it.
`BuiltBody.segments` holds the segments and `BuiltBody.bending` how the branches were dealt; the level file and the editor know nothing of them.
A root whose every branch is hinged away (nothing left on its own body) is built rigid, as authored.

**A hinge** (`RootHinge`, `level/rootBends.ts`) is Box2D v3's revolute joint, a row of the island solver: a 2x2 point constraint holding the two bodies' anchors together, soft at the island's joint softness in the biased pass and rigid in the relax.
Its spring is Box2D v2's soft spring (`gamma = 1/(h(c + hk))`, `bias = C·h·k·gamma`, biased pass only), from a stiffness and a damping coefficient taken ABOUT THE HINGE: `k = I·ω²`, `c = 2·I·ζ·ω`, `I` the inertia about the hinge point of everything OUTBOARD of it (the segment past it and every segment hinged on beyond that), a constant of the build.
Box2D v3's own spring rates its frequency against the constraint's effective mass, which for a long segment is its inertia about its centre of mass (a twelfth of `mL²` against a third about its end): authored at 1.2 Hz, a 2 m root hung 73° under its own weight and rang there undamped. Rated on the one segment past the hinge instead, a bend near a branch's base held a 4.7 kg stub's 5 Hz, 371 N·m/rad, under the 12.5 kg segment beyond it and then the ball, and folded 89° (`session-79f`, BALL's body 23, Tris: "why does it bend so much"); over everything outboard the same bend is 14,221 N·m/rad and the ball hanging from the outer segment bends the two 2.5° and 3° (5.3° and 7.1° at worst). So `freq` is what the part that swings on the bend swings at, the other bends held: 5 Hz is stiff, 1-2 Hz visibly gives under the ball.
A root's hinges are one island unit (`RootBendUnit`), left undamped by the island since every bend has its own damping; the ball's chain on a segment joins that island through the segment, as it joins a plant's.
The spring's energy is counted by the energy invariant beside the bodies' (`RootHinge.energy`, `mechanicalEnergy`): left out, the first recording of a bending root read a bend unloading as 109 J appearing from nothing (`energy-gained`, f238), and counted, the same recording is clean. `root-hinge-open` fires on a hinge whose anchors end a frame more than a centimetre apart; under the hanging ball they stand 1-2 mm apart.

**A bend has no stop**: its spring is linear however far it turns, so a hard enough swing still folds a bend hinged at the fork past the 50-60° where the drawn fork shows an elbow (`session-55f`, Tris: "at a high bend angle there's a knub at the bottom - looks like an elbow"; the crease is grown at the drawn angle into the parent's own mesh, and skinning the branch cannot move it).
Three ways of stopping it were built on 2026-11-01 and all taken out again (Tris), each with the reason:
- a HARD stop at a limit angle (`limit`, Box2D's revolute limit: one-sided, speculative short of it, soft past it) did not feel right ("the hard stop doesn't feel right"; hung from, a soft bend sat on it and the ball's acceleration peaked near 100 m/s²);
- a CUSHIONED stop (a stiff spring only past the limit) does not hold: its softness is rated on the segment's own inertia, not the ball hanging from it, and a 12° stop sagged to 25°;
- a spring STIFFENING toward the limit (`k / (1 - x²)`) held a bend short of it with the ball peaking at 26 m/s², and was removed as not physical: wood does not stiffen as it bends, it softens past its elastic range and then yields or breaks.
A stop also needed the hinge's point constraint stiffer than the island's other joints (120 Hz against 60): a bend that cannot give to the ball's whip passes it into the point, and at 60 Hz `session-82f`'s fork hinge opened 12.7 mm where its swing met a 30° stop. Without a stop the point is the island's own again, and `session-82f` (in the committed corpus, `playtests/regressions/session-82f-root-fork.json.gz`) replays bit-exact with its hinges closed.
A bend that still carries a `limit` on disk ignores it, and the editor drops it on the next save (`bendFields`, `root-format`).
Open: a short segment between two hinges under the ball still opens 12-38 mm (`session-55f` with bends at 0 and 10%), so a run of close bends along a branch, flexing over a length rather than at a point, waits on that.

**The look** (`render3d/rootSkin.ts`): the root's meshes are grown exactly as before, in the authored pose (so the bake is unchanged and still holds), and then each branch is SKINNED to the bodies holding its stretches: one bone per body, a vertex weighted by where it projects along its branch's centreline, eased from one body to the next across `ROOT_BEND_BLEND` (8 cm) either side of a bend so the bend draws as a curve. The meshes stay under the root's own body, so a segment's bone is its motion relative to the root's (`rest_root ∘ now_root⁻¹ ∘ now_seg ∘ rest_seg⁻¹`). Scene3D keys every segment to its root's visual (`LevelScene.segments`), so the reconciliation does not build an extruded visual for one and a cuff on one is drawn at the root's depth. The 8 cm blend is a guess to be looked at. Where a branch grows out of its parent the two meshes are FUSED and share the crease's vertices, and the parent's side never bends with the branch, so the branch's vertices that are also its parent's (found by position, to 0.2 mm, since each bake node is quantized over its own bounds: `sharedVertices`) stay with the body the branch grows from, and every other vertex eases into the branch's bend over two base half-widths from the nearest of them (`ROOT_CREASE_EASE`, `RootBending.branches.baseHalfWidth`); one drew a notch under the fork at 30°, and a wider ease is the stub that never bends by degrees.
Each bend's own ease is `ROOT_BEND_BLEND` either side, or half the way to the next bend if that is nearer: two windows that overlapped would hand a vertex from one bend's pair of bodies to the next's mid-ease and crack the bark between them.
Without it a bend 5% along a branch, inside the crease, turned the branch's side of the crease with it and tore the fork open (`session-82f`, Tris: "the bending joint rips the geometry apart").
The first rule held a girth-wide band instead (everything nearer the parent's centreline than the parent's half-width plus the branch's), which left a stub of branch standing straight out of the parent past a hinge at the fork while the rest swung (`session-52f`, Tris: "it's like there's a 'knub' that never gets bent").
A branch hinged where it grows (`hingedAtBase`) is the outboard segment's from its first node on, with no blend window across the hinge: the crease is its whole easing. A baked mesh is quantized (16-bit positions, the node matrix their dequantization), so the copy that is skinned is expanded to floats before the matrix goes in (`floatCopy`): written straight back, the first skinned bark read from the bake stood up to 22 m from where it was baked, and the branch's collision outline was drawn bending with nothing visible around it (`session-79f`, Tris); `root-bake` pins it. A bending branch's DEBUG geometry is drawn stretch by stretch instead (`RootBending.stretches`, `BodyVisual.mountDebug`): each stretch's own outline, cut from the same stroke its pieces were, the root's own stretches as before and a segment's skinned wholly to that segment's bone (`skinToBone`), with no blend, so it turns at each hinge exactly as the collision does. Until 2026-11-01 it was the whole branch's outline as one solid on the root's own body, and stood still while the branch bent (Tris).

**The editor** lists a branch's bends in its panel (one branch selected): `bend N at %`, `bend N Hz`, `bend N damp`, a remove button each and `+ bend`, which adds one halfway along the longest stretch still unbent; the canvas marks every bend with a bar across the branch and a dot on its centreline. A branch's bends ride its arc length, so reshaping it keeps them where they are along it.

What is not done: bends cannot be dragged on the canvas yet, `rootProblems` does not lint a bend inside a fork's stretch (a fork that close to a hinge is measured in the unbent pose), and none of `ball.json`'s separate pivot roots has been folded into the root it grows from.

## The taper

`strokeLine` takes an optional half-width per point of the line, and every offset it makes reads its own point's half-width, so a joint is mitred at the width the bar has there and the quads have two different ends.
The tiling stays exact (neighbours share the edge between them); with no per-point widths every point reads the one `halfWidth` by the arithmetic it always did.
A tapered curve is sampled every 5 cm (`TAPER_FLATTEN_STEP`) rather than the default 25 cm before the Douglas-Peucker pass, so a root that bends tighter than a rail keeps its centreline within a centimetre of the cubic (`cli roots` measures 2.3 mm on its bent case) and the drawn mesh, which follows the cubic itself, agrees with what is collided.
The simplification tolerance is taken against the narrow end, and a tip under `MIN_TAPER_TIP` (5 mm) ends at it, because a tip of nothing is a degenerate last piece.
The finer sampling is also what reaches a bend tighter than the bar's half-width, which folds the stroke; `strokeCurve` merges the folded segment away ([rails](rails.md)).

## The look

The game draws a root itself (`render3d/rootMesh.ts`, mounted by `BodyVisual.mountRoots`), the one piece of level geometry besides a belt's band whose look is not the Blender scene's: it is generated from the curves the author draws, and a sprung root moves with the sim, so a mesh modelled by hand would have to be remodelled for every curve pulled about.
This was asked for explicitly (2026-10-13), over the "Blender owns every rendered mesh" default.

Per branch, in the branch's own frame:

- the authored curve sampled every 1.2 cm, ROUNDED only where it bends tighter than the wood can follow (`roundTightBends`: a bend under 1.5 local radii, `LEAST_BEND`, is opened out by diffusing its samples toward their neighbours until none is, and every other sample stays where it was). The visual spine then wanders by at most 48% of the local radius; endpoints remain fixed. These are render-only offsets, so the collision and spring simulation stay unchanged. Until 2026-11-01 the rounding was a girth-wide moving average (six radii either side), which carried every stretch near a corner up to three quarters of a half-width off the collision a ring threads on (Tris: "the rendered root geometry doesn't align well with the collision geometry");
- rings of 40 points, linear taper, a slight trunk flare (15% over a base width), irregular swelling (24%), and an uneven section (flutes up to 18%) that meanders and turns slowly along the wood (a turn every three metres: the cords of a bundle, never a rope's spiral). Thin ends become rounder. Surface normals include the angular derivative of those flutes;
- **the bark's veins, in the ring itself** (`render3d/rootBarkField.ts`, 2026-10-18): each ring is displaced by the one relief field the bark's maps are baked from, 20% of the radius peak to peak and smooth on the thin growing end, so the silhouette is ridged where the shading is. The field is twelve veins around the root, each wandering a little, varying in width (never thin: the least is above a side's width), present in stretches of 10-20 cm and subsiding into the wood between them, width and height drawing down together so a vein ends as a long low spindle and never a wall, and merging with a neighbour it has drifted against (a smooth maximum). The mesh samples a rounder section than the maps carry (`GEOMETRY_CREST`), since a steep flank sampled every ring and side comes out as a scalloped silhouette;
- a slight collar past a branch's base, and the branch itself **emerging from a point**: narrow at its base on the parent's centreline, full within a girth and a half, so a lateral as thick as its parent (or thicker, past the parent's taper) never pokes out of the far side. For a branched body, `rootFork.ts` samples the sweeps as distance fields and unions them into one surface that meets in a **crease**, a fold a fraction of the girth wide (0.4-1.0 radii, more wood under the lateral than in the inner crotch) rather than the smooth collar it was until 2026-10-18. A sparse marching-cubes grid (6–11 mm cells) follows the wood rather than filling the empty body bounds. Triangles retain their nearest authored branch identity for editor picking; individual branch meshes share matching boundary positions and normals. Every mesh is then simplified, and in the game read from a bake ([below](#simplified-and-baked-roots));
- lateral roots initially follow the parent's tangent, then ease into their own direction over several base radii, with a subtle uneven ridge through the saddle. This uses the authored parent links, processed parent-first, including branches growing back along a parent. Endpoints and all collision data stay unchanged;
- bark phase is inherited at each junction, with direction reversed for a backward-growing lateral. Circular wrap coordinates and longitudinal coordinates blend through the fold, bending the grain rather than switching between independently wrapped tubes; the two branches' grain meets in the crease itself, as two roots' bark does. The `rootJoin` attribute is **how much the other branch closes over a point** (full where its surface is at hand, gone a girth and a half away): the bark shader draws it as the shade in the crotch, on the painted key and on the scene's light, and lowers the normal map's strength through it;
- caps at both ends: a branch's base a shallow dome, narrower than its tube, buried in its parent's centreline, and the tip a dome drawn out to a point over 2.2 radii, the wood itself drawing down to nothing over the last few tip widths, since the authored tip width is the collision's and a hemisphere of it was a ball on a stick;
- **woody bark** (`rootBark.ts`, the `woody` variant, the default since 2026-10-18): one bark colour, drifting a few percent lighter or darker and warmer or cooler in patches of 13-22 cm, laid in broad strokes along the root that stay on one vein; and the relief's own normal and occlusion maps, baked by `scripts/bake-root-bark.ts` (`bun run roots:bark`) from the same field the mesh is displaced by, at the tile's physical aspect on a root (a texel is 2.6× longer along the root than around it). Every dark on it is shadow: the valleys are the same colour as the veins. Normal strength 1, matte roughness 0.88, no roughness map (one baked from the relief, crests smoother than valleys, changed a tenth of a percent of the frame, and the sheen that would show it made the veins glossy). The tile wraps once around and repeats every 65 cm along. See [generation record](root-bark-generation.md) for this and the three earlier paintings;
- **a painter's light of its own** on the woody bark: a warm key from the viewer's upper left with a cool shade side (`PAINTED_LIGHT`, 0.75 linear radiance per unit albedo, 10% on the shade side), added to whatever the cave's light gives and shaded by the relief, the baked occlusion and the crotch. Measured why: in BALL's rock shadow the cave's fill alone renders a warm bark at about a third of its albedo, so the pale gouache went grey-tan and a paint at the reference's own value went to mud. The backdrop's painted roots, which are the reference, are unlit pictures;
- the body's colour remains a tint, expressed relative to `DEFAULT_ROOT_COLOR`. The three earlier paintings are multiplied by 0.58 in linear space to fit the game's earthy palette; the woody bark is painted at the value it is meant to show. Thin roots blend toward smoother young skin. Maps and materials are cached, and springing carries the surface with its body. There is no per-frame mesh or texture generation.

The visual direction is exposed woody roots: thick established axes giving way to finer lateral roots, with uneven branching chosen by the author. It draws on [US Forest Service root architecture observations](https://research.fs.usda.gov/treesearch/59121); it does not invent extra branches outside the authored hook geometry.
`/scripts/root-study.html` is a development-only, orbitable close-up using the live root renderer, with warm/cool lighting to inspect the grain and branch shoulders.

It stands at `ANCHOR_Z` (25 cm behind the plane) like every hook-only body, the setback being what says the ball passes through it.
A branch's input sweep has a shallow base dome rather than a full hemisphere, narrower than its tube, and the branch grows out of its parent from a point; in a fork the union removes the buried interface entirely, and the two meet in a crease.
The fuse brings a branch's base onto its parent's axis and nothing more: it leaves at the angle it was drawn at, as its collision does.
Until 2026-11-01 it was also SWEPT, its centreline pulled toward the parent's tangent over most of its length so it left at a shallower angle than drawn; `ball.json`'s body 22 drew a branch 4 cm (85% of its half-width) off its collision at the base, the drawn wood above the outline and its own collision visible under it (Tris).

**The cuff on a root is drawn in the root** (`ChainLayer.sync`): at the depth the body it bit is drawn at (`BodyVisual.depth`, which Scene3D hands the chain layer as `depthOf`), so it sits half-buried in the root's centre rather than floating 25 cm in front of it.
The chain then runs STRAIGHT from that depth to the plane over the anchor's span - to the first corner it wraps, which is on the plane, or to the ball - each link on that run leaning out of the plane by the run's angle.
It is any set-back body, not only a root: a grate or a hook-only leaf bitten the same way is drawn the same way; a vine's ring stays on the plane, where the vine is drawn.
Render-side only: the sim's chain and cuff are in the plane, and the 2D renderer is unchanged.
That is also why the editor's overlay outline of a root sits a little off its mesh in the perspective lens: the outline is the gameplay plane.
In the editor a root's mesh is rebuilt **in place** as it is drawn and reshaped (`BodyVisual.restyleDebug`, keyed by `rootSignatureOf`), not by rebuilding the scene, for the reason debug pieces are.
The 2D renderer draws a root's pieces as the grate lattice every hook-only body wears there.

## Simplified and baked roots

What is drawn is not the grown mesh itself but that mesh **simplified** (`render3d/rootBuild.ts`), and in the game it is not grown at all but read from the level's **bake**.

**Why** (measured 2026-10-16 on `ball.json`, 12 root pieces in 8 bodies): growing them cost 5.2 s of main thread at every load, almost all of it the fork fuse (1.0-1.8 s per branched body: ~370k distance-field samples per body, each testing ~28 segments with an `atan2`), and the editor paid the same per edit of a branched root.
They drew 142k triangles, the fused ones unindexed (77k vertices for a 26k-triangle body), with shadows on.

- **The fuse is ~5x faster with the same output** (`rootFork.ts`, bit-identical on every `ball.json` body when it was changed): each segment is bounded by its least and greatest radius before its angle is paid for, the grid's signs are decided a cube at a time where the bound settles them (only the corners of edges the surface crosses are evaluated), and the grid is typed arrays rather than hashes. The fused meshes are indexed.
- **Simplified** with meshoptimizer (`simplifyWithAttributes`, `ROOT_SIMPLIFY_ERROR` = 0.5 mm absolute), normals and bark coordinates weighted so shading and grain hold. Only a choice of which vertices to keep, so every kept vertex is exactly as grown. Fused branches keep their cut edges locked, so neighbours still meet: `root-simplify` checks the fork stays one closed surface. On `ball.json` 142k triangles become 30k. 2 mm visibly blunted the thin tips and polygonised bends at zoom 5; 1 mm was indistinguishable at 4x magnification; 0.5 mm leaves headroom for the editor's close views.
- **Grown in the world frame** from the level data alone, so the same body grows the same meshes in the game, the editor and the bake. The body's built frame is applied as the mesh's placement (`BodyVisual.placeRoots`), never baked into vertices.
- **Known by a key** (`rootKey.ts`, `rootMeshKey`): a hash of each piece's curve, world placement, parent and index (its seed), with `ROOT_MESH_VERSION`. Not colour or bark, which are the material's. **Bump `ROOT_MESH_VERSION` in any change that alters what is built from the same data** (the generator, the fuse, the simplifier's settings): nothing else notices, and a stale bake goes on drawing the old look.
- **Cached and shared** by key (`render3d/rootBake.ts`, `acquireRootMeshes`): a whole-scene rebuild in the editor gets every unedited body's meshes back rather than growing them again, and recolouring or re-barking a root only swaps its material.
- **Baked**: `bun run roots:bake` (`just roots`, and the first step of `just publish`) grows every registered level's roots into `public/roots/<level>.glb` (one node per body named by its key, one mesh per piece named by its object index; positions 16-bit and normals 12-bit under `KHR_mesh_quantization`, meshopt-compressed) and pins it in `render3d/rootBakes.json` with its keys. `ball.json`'s was 380 KB (decoding in 3 ms) before the veins were displaced into the rings and about 0.9 MB since. It is a stored asset like a scene (`roots:<level>`, released as `roots-<level>.glb`), fetched by `assets:fetch` and uploaded by `assets:publish-stored`, and the level preloads it (`rootBakeOfLevel`). The same level baked twice on one machine is the same bytes, and a level whose keys match its pin is left alone.
- **A body the bake does not hold is grown** where it is drawn, and the page logs `[roots] grew a body ... (not baked)`. That is the editor's normal case for the root being edited, and in the game it is the stall the bake exists to remove: `cli assets` fails "every level's roots are baked as they are" until the level is re-baked.
- Meshes arrive **late** when they are not to hand (the bake still decoding, the simplifier's WebAssembly still starting): the body draws no roots until then, as a dressed body draws no dressing until its scene lands, and both are tracked so a frame grab waits for them.

What this leaves: editing a branched root in the editor still regrows that one body per edit (~250 ms on `ball.json`'s), which would want a worker to make interactive.
Until then the editor's **roots** box ([editor](editor.md)) turns root meshes off altogether: hidden, `BodyVisual.mountRoots` acquires nothing, so an edit grows nothing, and ticking it again grows each body as it now is (`root-hidden`).

## The editor: `+ Root`

Select a root curve and use **bark texture** in its shape inspector:
**Woody painted** is the relief bark described above (the default for roots
without an explicit choice since 2026-10-18),
**Original detailed** is the texture committed on the roots branch,
**Broad grain** is the supplied lower-detail painting with broad grooves,
and **Soft selective** is the reference-based painting with selectively
darkened grooves and approximately 20% less brush detail (the default before).

Changing bark applies to all root branches in the selected body's tree so fused
joins keep one surface. It supports undo/redo, save/load and copying; a new
branch inherits its parent's choice. The saved `root.bark` is `woody`,
`original`, `broad` or `soft`. Root shape, collision and colour tint are unchanged.
Maps and materials are cached by variant and tint, and the preloader includes
only variants used by the level. Original detailed retains its stronger normal
relief and procedural roughness; both simpler choices use strength 0.45 and
matte roughness 0.91. All share the same grain coordinates through joins.
The editor's selection highlight refreshes when an asynchronously loaded source
material changes, so a newly selected variant is visible without deselecting.

`+ Root` (Level workspace, scene layer) draws a root as a run of presses, the pen tool's way: each **press places a node**, and **dragging before releasing pulls out that node's Bézier handles** (mirrored, so the curve runs smoothly through it; a drag inside the click slop leaves a corner).
**Enter** or a double-click grows it, **Esc** drops it.
The draft previews the tapered bar it will become, with the pointer as its next node and every node's handles drawn.

The **first press decides what is drawn**.
On a root (on its bar, or within 6 px of it, so a thin tip can be started from) it grows a **branch** out of that root, its first node on the root's centreline under the pointer, at 60% of the parent's width there (`ROOT_BRANCH_SHARE`) tapering to the parent's tip, in the parent's body.
Anywhere else it starts a new **trunk**: a body of its own whatever is selected, static, hook-only, in the bark colour, at the toolbar's widths.
Branches of branches are the same gesture, at any depth.

While `+ Root` is armed the toolbar shows **`start width`** and **`tip`** (px, in place of `kind`, which says nothing about a root).
They are the widths a new trunk is drawn at - 16 and 2.5 until changed - and this browser remembers them (`readRootWidths`, `editor/prefs.ts`), since they are how the author draws rather than anything about a level.
While a root or branch is being drawn they show and set THAT one's widths: a branch's start from its parent's girth, so typing a width before pressing Enter makes it thicker or thinner, and changing a branch's leaves the trunk widths as they were.
Once grown, each piece keeps its own `start width` and `tip width` in its panel.
While `+ Root` is armed the selection keeps its inspector but loses its handles and its gizmo, because a press anywhere on a root has to start a branch rather than grab a corner of it.

With the select tool, a branch is an ordinary scene curve: its nodes, handles and midpoints are dragged, inserted and removed exactly as a rail's are.
What the tree adds (`editor/rootEditing.ts`):

- **`syncRoots` runs on every edit** (`markDirty`): parents first, each branch's first node is put back on its parent at its `at`.
  Only that node moves; the branch's other nodes stay where they were drawn, so reshaping a trunk bends its branches toward their new bases rather than sweeping their tips through the rock they were drawn into.
- **Dragging a branch's first node slides it along its parent** (`slideRootJunction`: `at` becomes the projection of the pointer).
  That node cannot be deleted or Alt-clicked away.
- **Delete takes a branch and everything growing out of it.**
- **A branch whose parent is no longer a root in its own body becomes a trunk where it stands** (the one place the rule is stated, in `syncRoots`).
  That is what makes moving a branch into a body of its own (**New body**, or a drag in the scene tree) a gesture rather than an error: it is how ONE branch of a static root is made to spring.
  Duplicating or copying a branch alone does the same, since the copy is in a new body; copied with its parent, it grows out of the copy.

The item panel of a root piece has `start width` (the base), `tip width`, a `grows from` readout (`the ground (a trunk)` or `N% along its root`) and the piece count; in the scene tree each piece is a `CollisionShape2D` node of its body, a branch naming its parent piece by node id.

### Springing

The body panel of a root has a **Root** section with one checkbox, **springs** (`setRootSprings`): it makes the body rigid, mounts it on a pivot whose bearing is the trunk's first node, and gives it a torsion return spring of `ROOT_SPRING_FREQ` (2 Hz) unless one is already set; unticked, the root is static again.
That is three edits it would otherwise take (kind, pivot, bearing), and the Pivot section below it tunes the spring like any other (`return (Hz)`, `damping`).
A sprung root spawns at its rest pose and the editor draws its dashed settled ghost, like every sprung body; a 1.5 m wooden root held out level droops about 3.5° at 2 Hz.
The 2 Hz default is a guess until it is played, and nothing pins it.

## Verification

`cli roots` (`sim/rootCases.ts`, in `bun run test`):

- `root-stroke`: a straight root is one trapezoid of the right area and the authored widths at both ends; a bent one is all convex pieces that tile the bar, narrowing monotonically, its centreline within a centimetre of the cubic.
- `root-fold`: the root that stopped `ball.json` building (a 33° turn inside a few centimetres of an 8 cm bar) builds, every piece one `polyShapeCentred` accepts, tiling the bar, `curveLine` the stroke's own line, within a centimetre of the cubic.
- `root-format`: `tip` scales and `root` survives the scale; the editor writes a three-level tree into one body with every parent renumbered (the fixture lists a light first, which the editor writes last), and a second round trip writes the same level.
- `root-hook-only`: the body is passable and not in the wrap list, every piece names its branch's root curve (one per branch), a solid ray passes through while the hook's finds it, the ball's hook thrown at it catches, and a rock dropped on it falls through.
- `root-walls-culled`: a 17 m branch walked past a 12-piece rock, a boulder, a diagonal bar and a wedge 2 mm clear of the ring finds exactly the stops asking every piece finds, asking a twentieth of the manifolds or fewer (441 against 58,571); the wedge is asked and found clear. Red with the culling removed.
- `root-ring`: through the real controller, the hook threads a ring onto a 49° trunk that stays square on the centreline every frame and is held where it threaded on for 7 s under a hang 49° off square (0 mm); struck inside the fork it threads on at the fork's edge, and struck beside the rock the base is buried in it threads on clear of the rock.
- `root-bend`: a trunk bending at 40% and 70% builds its own body and two hook-only segments with two hinges standing on one point; a root that bends nowhere builds none; hung from and resting on a ledge it runs clean through the real runner's invariants (the hinge's and the energy's included), its tip rests on the ledge (the outer bend turned back) where in the air it droops, never more than a centimetre in.
- `root-bend-crease`: a branch bending 5% along, and one hinged at the fork, each turned 35° by hand: every vertex it shares with its parent at the crease (51) stays exactly where the parent draws it (67 mm apart without the rule) while its tip moves 71-75 cm; hinged at the fork, every vertex two base half-widths or more clear of the crease turns wholly with the segment (105 mm off with the girth-wide band that left the stub).
- `root-on-collision`: the drawn wood keeps to its collision: round a right-angle corner the centreline stays within 0.7 of the half-width for seeds 0-3 (0.64; 0.93 with the moving average), and through a fork at 75° the trunk's and branch's silhouettes are centred within 0.7 of theirs, a tenth in from either end (0.29 and 0.42; the swept branch 0.97).
- `root-bend-draw`: a bending trunk's debug geometry, forced on, is three solids, the two on segments skinned; with the segments turned by hand every vertex of those two lands where its segment's motion puts it (to a micron).
- `root-cuff-open`: through the real controller, a cuff hung on a 5 cm root is shut and centred; on a 14 cm one its jaws open (52°) with their tips exactly on the root's surface and its bore at the hinge exactly on the bark, and the drawn pose carries the angle and the offset.
- `root-collide`: a sprung root, its first node buried in a rock wall, is stopped by statics while staying hook-only, excepts only that rock, and bent down by the hanging ball comes to rest on a ledge below it (13.5° against 21.6° with no ledge) never more than a centimetre into it.
- `root-spring`: springs gives a rigid pivot with a return spring, hinged exactly at the trunk's base, at rest on spawn (no turn and no axle drift over 2 s).
- `root-tree`: reshaping a trunk carries both junctions of a two-level tree, sliding moves `at` to the projection, and moving a branch to another body makes it (and the branch growing out of it) a trunk where it stood.
- `root-lint`: `rootProblems` reports a junction drifted 5 cm, a parent that is not a root, and a loop.
- `root-mesh`: finite, outward-facing unit normals, as deep through z as the bar is wide, flare included, centred on its plane within its lobes; a curve of no length grows nothing. The UV seam closes in position and normal, and thin tips carry younger skin.
- `root-bark`: maps are shared across body tints without mutating the default material, colour and data maps use the correct colour spaces, both tile boundaries are continuous at texel scale, and minification uses mipmaps.
- `root-simplify`: a fork simplified to under half its grown triangles, every grown vertex within the error of the simplified surface, still one closed surface across both branches' meshes, every bark attribute kept.
- `root-key`: the key ignores colour and bark, and changes with a moved node, a moved body, and a branch made a trunk.
- `root-bake`: a bake encoded and read back through three's loader holds the body under its key with every branch, the same triangles, positions within a twentieth of a millimetre, normals within a degree, exact bark coordinates, and the bark's own attributes under the names its shader reads.
- `root-restyle`: a root's mesh is placed where its curve is; the editor's in-place rebuild keeps the geometry on a recolour (only the material changes), grows new geometry on a reshape, and gets the first back from the cache when the shape returns.
- `root-hidden`: the editor's **roots** box off draws no root, through a reshape too, and ticked again draws the shape as last reshaped.
- `cli assets` holds every registered level's bake to its current roots.
- `root-cuff`: the ball, driven by `ball-root-swing.json`'s own inputs to frame 200, has bitten the root; the chain layer draws the cuff at the root's drawn depth and the chain rising from beside it to the ball's plane; the control (every body on the plane) leaves both on the plane.

`playtests/ball-root-swing.json` is the mechanic end to end through the real ball controller: thrown at a root above it, the hook bites and the ball swings (red with the same root made hook-proof).
`cli levels` checks every level's roots with `rootProblems` (in metres, the units the junction is measured on).

What the suite cannot see: how a sprung root feels to swing on, and whether the generated bark reads as a root in a lit level; both need playing.
