# Methodology

1. Introduce mechanic
  - provide a scenario where the player would naturally encounter the mechanic required for the skill
2. Encourage experimentation
  - provide an environment where the player can test out the mechanic without the risk of losing progress
3. Low-consequence skill check
  - to progress, a specific skill must be performed
  - failing to perform the skill should not cause the player to lose progress (or only lose a small amount of progress)
4. Encourage mastery
  - provide an environment where the player can refine the skill in a variety of contexts
5. High-consequence skill check
  - to progress, the skill must be performed
  - failing to perform the skill should cause the player to lose a significant amount of progress (taking them to the beginning of the skill introduction area)


# Levels

Dungeon (start in cell with skeleton friend)
Sewers
Medieval Village

Clock Tower
Clouds
Wizard's Castle
- Physics-altering environments (no/low/reversed gravity)
- retrieve cell key & fall back to original dungeon cell - release skeleton friend


# Camera

The camera is an eased follow of the avatar, reshaped by two kinds of authored thing.
Both are drawn on the editor's **camera** layer, both are invisible in play, and both are governed by one rule: whichever contains the player wins, ties go to the later one in the file, and the one in force keeps its grip until the player leaves it by its `buffer`.
Every hand-off between them is blended, so nothing ever snaps.

## Regions

A **camera region** is a volume that reshapes the camera while the player is inside it.
Per axis, it either pins the camera at a world coordinate (`lock x` / `lock y`) or keeps following with an offset (`off x` / `off y`), and `view ×` says how much world is on screen - 2 is twice as much, zoomed out.
Both axes locked is a fixed camera, one axis locked is a shaft or a corridor, neither locked is an offset follow.

`buffer` is how far out of the region the player may stray before it gives the camera up.
Only *leaving* is buffered: a region takes the camera the moment the player is inside it.
That asymmetry is what makes the field authorable as "how far out of this room I may go without the camera changing its mind" - a swing that leaves through one wall and comes straight back keeps one camera for the whole arc.
Set it by looking at how far out of the room the arc actually reaches; the editor draws it as a finely dotted outline for exactly that reason.

A region frames a **place**.
It cannot say anything about where the player is going next, which in a traversal level is the more common thing to want.

## Paths

A **camera path** is an authored curve the camera rides: the route.
The player is projected onto it, and the camera targets a point further **along** it - so the screen leads them toward where the level expects them to go.

It is drawn with `+ Path` as a run of clicks, finished with Enter or a double-click.
Every node starts as a **corner**, and each carries two Bézier tangent grips: drag one and the corner rounds off, with the opposite handle mirrored so the route stays smooth through the node (hold Alt while dragging to break the pair into a deliberate cusp).
`Smooth` rounds every corner at once and `Sharpen` drops every tangent again, so the shape of a long route is a couple of clicks rather than a node-by-node job.
Dragging an edge's round midpoint inserts a node without changing the curve at all.

**Direction is the design.**
A path runs in the order its verts were clicked, and the lookahead never flips: even when the player backtracks, the screen keeps arguing for the authored direction.
Drawing one backwards is fixed with the panel's `Reverse` button, not by the camera being clever.

`lead x` and `lead y` are how far ahead the camera looks, per axis.
Two numbers because the frame is 16:9: there is far less screen above and below the player than there is either side of them, so one lead that reads well along a corridor throws the player off the bottom of a shaft.
They are the semi-axes of an ellipse the lead is taken along, so a horizontal route leads by `lead x`, a vertical one by `lead y`, and anything diagonal by what fits between them.
Tune `lead x` first - it is what most routes are mostly made of - and pull `lead y` down until a drop reads.

`lead buf x` and `lead buf y` are slack in where that lead is measured **from**, and they are what stops a swing sloshing the camera.
A swing is an oscillation *along* the route - the player runs forward and back several times a second - so a camera that tracks their position exactly rocks with them.
The point the lead is taken from is held in a band this wide instead: it does not move at all until the player leaves the band, so a swing whose travel along the path is narrower than the band is absorbed completely rather than merely damped.
The pair is read as an ellipse exactly as the lead is, and for the same reason: a band that reads well along a corridor is most of the vertical screen in a shaft.
Past the band the point is dragged by its edge, which is continuous - nothing jumps - and the price is that on genuine forward travel the camera trails by up to the band's width.
That is the trade to tune: widen it until swinging stops moving the camera, and no further.
Setting both to 0 tracks the player exactly.

`range x` and `range y` are the corridor: how far off the route the player may be while the camera still narrates it.
Two numbers for the same 16:9 reason the lead is two: the pair is read as an ellipse around the route, resolved along the direction the player actually left in, so the corridor is screen-shaped.
That matters because a circular corridor wide enough to mean anything horizontally is taller than the screen: half a frame is 4.8 m across and only 2.7 m down, so with one round `range` of 4 a player could sit fully inside the corridor and past the bottom edge of the frame at the same time - which is exactly when the ball used to vanish with the edge clamp off.
Tune `range x` to the route and pull `range y` down until leaving vertically starts handing the camera over while the player is still on screen.

`falloff x` and `falloff y` are the band **outside** the range that the path lets go over - the same ellipse again, so the band is screen-shaped too - and they are what stops the camera changing its mind the instant you step off the route.
Through it the path's hold on the camera fades: the target slides smoothly from the path's - the lookahead point, at the path's zoom - to the plain follow, so the lead, the zoom and everything else the path asks for all relax together as the player walks away.
Leaving the route reads as the camera loosening its grip rather than swapping what it is framing, and by the band's outer edge the path is asking for exactly what the plain follow would - so the moment it lets go, nothing on screen changes at all.
The fade is eased at both edges, so there is no line in the world where the camera's behaviour audibly changes gear.
Both falloffs at 0 turn the band off: the path holds at full strength out to the release and the hand-off blend covers the swap.

Past the band's outer edge plus `buffer` (the same jitter hysteresis a region has, grown onto both axes) the path **lets go**, handing the camera to whatever governs where the player actually is - a region if one contains them, the plain follow otherwise.
Coming back within the range takes the path again - the band is a graceful exit, not a wider entrance, so drifting in from the side does not grab the camera early.
Both hand-offs are blended on top of all that.

Where a path passes near itself - a switchback, a spiral, a route that doubles back over a lower ledge - the camera tracks the branch the player is actually **on**, not whichever branch happens to be nearest.
That is what makes the range mean what an author set it to: the release distance is measured against the branch being ridden.
The other direction holds too: a player who genuinely leaves the branch they were riding and lands inside the corridor of a **different** branch of the same path hands the camera to that branch, with a blend - the ridden branch's falloff zone never outranks the corridor under the player's feet.

A curve is flattened into a fine polyline before anything rides it, so the smoothness costs nothing anywhere else - and a path of plain corners is exactly the polyline it always was.

Clamping at the ends is deliberate: near the goal the lookahead runs out of path and the camera comes to rest on the end rather than staring past it.
Author the last few metres of a path with that in mind.

## Which one wins

Paths are listed after regions, and ties go to the later one, so **a path beats a region at equal priority**.
That is the right default: the path is the level's primary guide and a region is the local exception.
A region that must win anyway - a room you want framed a particular way even though the route runs through it - says so by raising its `priority` above the path's.

The consequence to author around is the same one regions already have: leaving a higher-priority region drops to whatever contains the player *then*, and if that is the path, the path re-acquires with a fresh projection.

## The screen edge

One rule overrides every region and every path, and it cannot be authored away: **the player may never be in the outer 8% of the frame**.
If a lock, an offset or a lookahead would put them there, the camera moves to keep them out of it.

It is measured as a fraction of the frame, so it means the same thing at any `view ×`, and it is measured to the player's centre - so it clears the avatar and leaves a little room besides.
In ordinary play it never fires: the default camera centres the player, and outrunning the follow lag far enough to reach the band takes a sustained ~27 m/s against a hard swing's ~10.
Where it does fire is a locked region the player has left and a path leading hard in one direction while they move the other way, and it fires as a limit rather than a snap - the camera is simply not allowed past it.

The debug overlay draws the keep-out box in amber on the frames it is holding the camera, so "why has the camera stopped following" has an answer on screen.
Seeing that box is a sign to re-tune whatever was asking for the framing it is overriding: the constraint is a backstop, not a framing tool.

The toolbar's **`edge clamp`** checkbox turns it off for ▶ Test, and for nothing else - the game always applies it.
Untick it when you want to see the framing a lock or a lookahead is really asking for rather than the one the backstop allowed; tick it back to see what the player will get.

## Authoring both

Turn the debug overlay on (**L**) while playing.
It draws every region and path, marks the one in force, and for a held path shows the point the lead is measured from, the lookahead target the camera is aimed at, and the release boundary.
A hollow mark appears at the player's own projection whenever `lead buf` is holding it away from the committed point - so the mark appearing is the buffer doing its job.
A camera that offsets, zooms, pins or leads has no on-screen cause otherwise, so authoring either of these by feel alone is authoring blind.
