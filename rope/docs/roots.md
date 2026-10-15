# Roots

A **root** is a tree of tapered curves the author draws in the editor, and the game grows a root from it.
Background scenery the hook can catch and nothing else touches, like a vine; and, ticked to spring, a root that bends under the ball and comes back.

There is no new physics in it, and that is the design.
Every piece of what a root needs already existed, each with its own suite, and a root is those pieces wired together:

- a branch is an authored **curve** (`ShapeData`'s `curve`), stroked at load into the convex pieces that tile it ([rails](rails.md)), with one new field, `tip`, that **tapers** it;
- a root is a **body** of those curves, so the tree is one rigid thing ("the root structure resolves to a standard rigidbody");
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

A tapered curve is **never a rail**: the cuff rides a constant half-width (`RailCurve`), so the build ignores `rail` on one and the editor does not offer it.
The hook **bites** a root like any other face.

## The taper

`strokeLine` takes an optional half-width per point of the line, and every offset it makes reads its own point's half-width, so a joint is mitred at the width the bar has there and the quads have two different ends.
The tiling stays exact (neighbours share the edge between them); with no per-point widths every point reads the one `halfWidth` by the arithmetic it always did.
A tapered curve is sampled every 5 cm (`TAPER_FLATTEN_STEP`) rather than the default 25 cm before the Douglas-Peucker pass, so a root that bends tighter than a rail keeps its centreline within a centimetre of the cubic (`cli roots` measures 2.3 mm on its bent case) and the drawn mesh, which follows the cubic itself, agrees with what is collided.
The simplification tolerance is taken against the narrow end, and a tip under `MIN_TAPER_TIP` (5 mm) ends at it, because a tip of nothing is a degenerate last piece.

## The look

The game draws a root itself (`render3d/rootMesh.ts`, mounted by `BodyVisual.mountRoots`), the one piece of level geometry besides a belt's band whose look is not the Blender scene's: it is generated from the curves the author draws, and a sprung root moves with the sim, so a mesh modelled by hand would have to be remodelled for every curve pulled about.
This was asked for explicitly (2026-10-13), over the "Blender owns every rendered mesh" default.

Per branch, in the branch's own frame:

- the authored cubic sampled every 2 cm of arc length, a ring of 14 points about it in the plane across the curve that holds the depth axis (a curve in the gameplay plane never twists, so there is no frame to transport);
- the collision's own linear taper for the radius, with three things over it collision does not care about: a FLARE where a trunk leaves the ground (45% over a base width) or a branch leaves its parent (25%), a slow swelling along it (8%), and a three-lobed cross-section (7%), all seeded by the piece's index so a branch keeps its look across edits;
- rounded caps at both ends, so the tip ends in a point and a branch's base, buried in its parent's centreline, never shows an open tube;
- a generated bark (`rootBarkMaterial`): ridged value noise stretched along the root, so the fissures run lengthwise, as an albedo and a normal map, tinted by the body's colour (`DEFAULT_ROOT_COLOR` for a new one).

It stands at `ANCHOR_Z` (25 cm behind the plane) like every hook-only body, the setback being what says the ball passes through it.
A branch has no base flare and only a shallow dome for a base cap (a quarter of its radius deep): its base is on its parent's centreline, and a full hemisphere or a collar wider than the parent broke out through the parent's far side as a knob.

**The cuff bitten into a root is drawn in the root** (`ChainLayer.sync`): at the depth the body it bit is drawn at (`BodyVisual.depth`, which Scene3D hands the chain layer as `depthOf`), so it sits half-buried in the root's centre rather than floating 25 cm in front of it.
The chain then runs STRAIGHT from that depth to the plane over the anchor's span - to the first corner it wraps, which is on the plane, or to the ball - each link on that run leaning out of the plane by the run's angle.
It is any set-back body, not only a root: a grate or a hook-only leaf bitten the same way is drawn the same way; a vine's ring stays on the plane, where the vine is drawn.
Render-side only: the sim's chain and cuff are in the plane, and the 2D renderer is unchanged.
That is also why the editor's overlay outline of a root sits a little off its mesh in the perspective lens: the outline is the gameplay plane.
In the editor a root's mesh is rebuilt **in place** as it is drawn and reshaped (`BodyVisual.restyleDebug`, keyed by `rootSignatureOf`), not by rebuilding the scene, for the reason debug pieces are.
The 2D renderer draws a root's pieces as the grate lattice every hook-only body wears there.

## The editor: `+ Root`

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
  That is what makes Ctrl+G a gesture rather than an error: moving a branch into a body of its own is how ONE branch of a static root is made to spring.
  Duplicating or copying a branch alone does the same, since the copy is in a new body; copied with its parent, it grows out of the copy.

The item panel of a root piece has `start width` (the base), `tip width`, a `grows from` readout (`the ground (a trunk)` or `N% along its root`) and the piece count; the outliner names them `root` and `branch`.

### Springing

The body panel of a root has a **Root** section with one checkbox, **springs** (`setRootSprings`): it makes the body rigid, mounts it on a pivot whose bearing is the trunk's first node, and gives it a torsion return spring of `ROOT_SPRING_FREQ` (2 Hz) unless one is already set; unticked, the root is static again.
That is three edits it would otherwise take (kind, pivot, bearing), and the Pivot section below it tunes the spring like any other (`return (Hz)`, `damping`).
A sprung root spawns at its rest pose and the editor draws its dashed settled ghost, like every sprung body; a 1.5 m wooden root held out level droops about 3.5° at 2 Hz.
The 2 Hz default is a guess until it is played, and nothing pins it.

## Verification

`cli roots` (`sim/rootCases.ts`, in `bun run test`):

- `root-stroke`: a straight root is one trapezoid of the right area and the authored widths at both ends; a bent one is all convex pieces that tile the bar, narrowing monotonically, its centreline within a centimetre of the cubic.
- `root-format`: `tip` scales and `root` survives the scale; the editor writes a three-level tree into one body with every parent renumbered (the fixture lists a light first, which the editor writes last), and a second round trip writes the same level.
- `root-hook-only`: the body is passable and not in the wrap list, no piece is a rail, a solid ray passes through while the hook's finds it, the ball's hook thrown at it bites, and a rock dropped on it falls through.
- `root-spring`: springs gives a rigid pivot with a return spring, hinged exactly at the trunk's base, at rest on spawn (no turn and no axle drift over 2 s).
- `root-tree`: reshaping a trunk carries both junctions of a two-level tree, sliding moves `at` to the projection, and moving a branch to another body makes it (and the branch growing out of it) a trunk where it stood.
- `root-lint`: `rootProblems` reports a junction drifted 5 cm, a parent that is not a root, and a loop.
- `root-mesh`: finite, outward-facing, as deep through z as the bar is wide, flare included, centred on its plane within its lobes; a curve of no length grows nothing.
- `root-cuff`: the ball, driven by `ball-root-swing.json`'s own inputs to frame 200, has bitten the root; the chain layer draws the cuff at the root's drawn depth and the chain rising from beside it to the ball's plane; the control (every body on the plane) leaves both on the plane.

`playtests/ball-root-swing.json` is the mechanic end to end through the real ball controller: thrown at a root above it, the hook bites and the ball swings (red with the same root made hook-proof).
`cli levels` checks every level's roots with `rootProblems` (in metres, the units the junction is measured on).

What the suite cannot see: how a sprung root feels to swing on, and whether the generated bark reads as a root in a lit level; both need playing.
