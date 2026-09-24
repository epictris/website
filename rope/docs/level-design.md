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
Both are drawn on the editor's **camera** layer, both are invisible in play, and both are governed by one rule: the lowest `priority` containing the player wins, everything tied at it shares the camera between them, and whatever is in force keeps its grip until the player leaves it by its `buffer`.
Every hand-off between them is blended, so nothing ever snaps.

## Regions

A **camera region** is a volume that reshapes the camera while the player is inside it.
Per axis, it either pins the camera at a world coordinate (`lock x` / `lock y`) or keeps following with an offset (`off x` / `off y`), and `view ×` says how much world is on screen - 2 is twice as much, zoomed out.
Both axes locked is a fixed camera, one axis locked is a shaft or a corridor, neither locked is an offset follow.

`buffer` is how far out of the region the player may stray before it gives the camera up.
Only *leaving* is buffered: a region takes the camera the moment the player is inside it.
That asymmetry is what makes the field authorable as "how far out of this room I may go without the camera changing its mind" - a swing that leaves through one wall and comes straight back keeps one camera for the whole arc.
Set it by looking at how far out of the room the arc actually reaches; the editor draws it as a finely dotted outline for exactly that reason.

`falloff` is the band **inside** the region over which its share of the camera ramps away to nothing at its own wall - how it hands over to a room it overlaps, rather than how far it holds on (see [Which one wins](#which-one-wins)).
The editor draws its inner edge dashed: inside that line the region has the camera to itself, and between there and its wall it is sharing.

`keep in frame` (on by default) is whether [the screen edge](#the-screen-edge) holds the player on screen while this region is framing the camera.
Untick it for a level's opening shot, so the player falls into a locked frame instead of the camera dragging up to meet them.
Draw the region to cover the whole fall and the landing: once the player leaves it the guarantee is back, and a player still off screen at that moment has the camera jump to them.

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

**While the player is hanging on a line the band is one-sided**, and that is worth knowing before tuning it against a swing.
A swing's forward half says something about where the player is going and its return half says nothing, so on those frames only the band's rear edge moves the point the lead is taken from: it walks forward with the swing and is never hauled back by the return.
So a swing wider than the band no longer rocks the camera either - it ratchets it a little further down the route each arc and holds there - and what the band is really tuning is how much of a *roll* it absorbs.
Letting go hands the point back to the middle of the band, and the camera glides to the lead it would have had all along.

If a swing carries the player right off the edge of the frame, the screen-edge guarantee (below) takes over, and it too lets go of where it put the camera slowly rather than at once.
Neither hold is authorable, and neither needs to be: they are about the difference between swinging and travelling rather than about this route.
A player who climbs toward an anchor ahead on the route needs no special case either - they are moving toward the middle of the frame, so the guarantee stops asking and the camera comes with them.

`reaction s` is how many **seconds** of warning the lead is stretched by at the speed the player is travelling, and it is **off unless you type one**.
The lead you type is a distance, so on its own a player at 8 m/s sees exactly as far ahead as one strolling at 1; this is what makes it a number of seconds instead, capped at the lead itself so a fast player sees at most twice as far.
The reason it is off by default is that it makes the framing depend on speed, and a player on a chain changes speed twice an arc - so on an ordinary stretch it slides them around the frame rather than giving them warning.
Type 0.3 (about human reaction time) on a route where the warning is worth that - a long fast descent with one safe landing - and leave it blank everywhere else.

`softness` is the one thing about the ROUTE'S SHAPE an author can tune here: how far off the route two places on it count as the same place to the camera's progress (0.5 m unless the path says otherwise).
It is what makes a bend read as one smooth advance rather than as a corner the camera catches on, and the number to raise on a route with tighter bends than the river's 0.8 m - at the cost of the camera cutting a corner a little before the player does.

`range x` and `range y` are the corridor: how far off the route the player may be while the camera still narrates it.
Two numbers for the same 16:9 reason the lead is two: the pair is read as an ellipse around the route, resolved along the direction the player actually left in, so the corridor is screen-shaped.
That matters because a circular corridor wide enough to mean anything horizontally is taller than the screen: half a frame is 4.8 m across and only 2.7 m down, so with one round `range` of 4 a player could sit fully inside the corridor and past the bottom edge of the frame at the same time - which is exactly when the ball used to vanish with the edge clamp off.
Tune `range x` to the route and pull `range y` down until leaving vertically starts handing the camera over while the player is still on screen.

`falloff x` and `falloff y` are the band **outside** the range that the path lets go over - the same ellipse again, so the band is screen-shaped too - and they are what stops the camera changing its mind the instant you step off the route.
Through it the path's hold on the camera fades: the target slides smoothly from the path's - the lookahead point, at the path's zoom - to the plain follow, so the lead, the zoom and everything else the path asks for all relax together as the player walks away.
Leaving the route reads as the camera loosening its grip rather than swapping what it is framing, and by the band's outer edge the path is asking for exactly what the plain follow would - so the moment it lets go, nothing on screen changes at all.
The fade is eased at both edges, so there is no line in the world where the camera's behaviour audibly changes gear.
Both falloffs at 0 turn the band off: the path holds at full strength out to the release and the camera swells across the swap at its own bounded acceleration.

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

**The lowest `priority` wins, and everything tied at it blends.**
Nothing authors a priority by default, so by default every rule the player is inside shares the camera, weighted by `falloff`; a rule that must govern a place *outright* - a room you want framed a particular way even though the route runs through it - says so by dropping its `priority` below the others', and everything ranked worse goes silent while it holds.

`falloff` is how a region gives the camera up gracefully: measured **inward** from its own wall, it is the band over which the region's share of the framing ramps from all of it to none.
Overlap two rooms by exactly the width of their band and the hand-over is an exact cross-fade - the camera sweeps from one framing to the other across the overlap and is never anything else.
Leave `falloff` at nothing and the room frames right out to its own walls, handing over on the 0.7 s blend instead, which is what every region did before the field existed.
A room with a band and nothing to overlap fades to the **default camera** on its way out, so a band is something to author where rooms meet rather than on every room.

The consequence to author around is the same one regions already have: leaving a lower-`priority` region drops to whatever contains the player *then*, and if that is the path, the path re-acquires with a fresh projection.
Two paths never blend with each other - the camera rides one route at a time - so where two tie, the later one in the file takes it.

`?level=CAMERA_TEST` is the sandbox for all of this: two rooms overlapping by their band width, and a priority island past them.

## The screen edge

One rule overrides every region and every path: **the player is held at least a fifth of the frame's height from the top and bottom, and about a ninth of its width from the sides, and their centre never leaves the screen**.
The only way to author it away is a region with `keep in frame` unticked, and only while that region is framing the camera.
If a lock, an offset or a lookahead would put them closer to the edge than that, the camera moves until they are exactly there.

It is measured as a fraction of the frame, so it means the same thing at any `view ×`, and it is measured to the player's centre - so it clears the avatar and leaves a little room besides.
In ordinary play it never fires: the default camera centres the player, and outrunning the follow lag far enough to reach the band takes a sustained ~27 m/s against a hard swing's ~10.
Where it does fire is a locked region the player has left and a path leading hard in one direction while they move the other way, and it fires as a limit rather than a snap - the camera is simply not allowed past it.

**It eases itself in rather than arriving all at once.**
There are two boundaries: the override starts a little further in from the edge, gives way gently at first, and takes over completely only as the player keeps pushing - so the camera is never *caught* at a line, it is gradually carried.
It works by moving what the camera is **aiming** at rather than shoving the camera itself, which is what lets the camera turn over on its own follow lag instead of being reversed; the shove on the camera is still there underneath as the thing the player can never outrun.
And it comes on over a fraction of a second rather than instantly, so a swing that reaches the edge is answered by the camera gradually giving ground rather than by a yank.

The three numbers behind it (how close to the edge the player may ever get, how far in from there the override starts, and how long it takes to come on) are global game settings rather than level fields, for the same reason the guarantee itself is: what it does is a property of the game, not of a room in it.

What an author sees of it is that **a framing which puts the player inside that outer band is trimmed a little** - a very long lead down a corridor, or a lock the player has walked well away from.
At the shipped settings the band starts 20% in from the edge, and it is wide on purpose: the wider it is, the more room the override has to come on gently, and a narrow one is answered by the hard floor instead, which is the one place a jolt is left.
The ball level's own path is comfortably clear of it standing still, so what the band catches is a swing carrying the player toward the edge, which is what it is for.

**The shove it gives is let go of slowly.**
A swing that reaches the edge of the frame reaches it twice an arc, so a camera that is shoved and then snapped back rocks for as long as the player hangs there.
Instead the shove decays over about a second and a half: the next arc raises it again long before it has gone, so a long hang reads as still rather than as rocking, and a player who comes back inside and stays there gets the framing the level asked for a couple of seconds later.
Per axis, so a swing that drops the player out of the bottom of the frame holds nothing horizontally and the route goes on being narrated.

It is not gated on hanging, and it costs nothing when nothing is asking: what it does is make the guarantee's own corrections read as one slow movement rather than as a series of catches.
Like the band, it is a global setting rather than a level field.

The debug overlay draws the keep-out boxes in amber on the frames it is holding the camera - the inner one finely, where the override starts easing in, and the outer one as the line the player may never cross - and a dashed amber line across the frame through each pinned axis, so "why has the camera stopped following" has an answer on screen either way.
The player between the two boxes is the override working; the player hard against the outer one is the framing you asked for having run out of room.
Seeing that box is a sign to re-tune whatever was asking for the framing it is overriding: the constraint is a backstop, not a framing tool.
A pin that shows up on an ordinary swing means the same thing - the framing being asked for does not fit the arc the player actually takes.

The toolbar's **`edge clamp`** checkbox turns it off for ▶ Test, and for nothing else - the game always applies it, outside a region with `keep in frame` unticked.
Untick it when you want to see the framing a lock or a lookahead is really asking for rather than the one the backstop allowed; tick it back to see what the player will get.

## Authoring both

Turn the debug overlay on (**L**) while playing.
It draws every region and path, marks the one in force, and for a held path shows the point the lead is measured from, the lookahead target the camera is aimed at, and the release boundary.
A hollow mark appears at the player's own projection whenever `lead buf` is holding it away from the committed point - so the mark appearing is the buffer doing its job.
A camera that offsets, zooms, pins or leads has no on-screen cause otherwise, so authoring either of these by feel alone is authoring blind.

## A rolling entry

A spawn may open the level on the ball **rolling in** from off to one side (`roll` in the editor's Player spawn group - see [ball-rolling](ball-rolling.md#the-rolling-entry)).
The ball is placed that far along x from the spawn, rolls to it at 1.5 m/s, and the player takes over when it arrives.

**The camera stands at the spawn for the whole entry**, so the framing the player watches the ball roll into is the framing that spawn already has - whatever region, path or plain follow governs the point the ball is arriving at.
Nothing extra has to be drawn for it, and a region drawn over the entry run does nothing: the camera is not reading the ball while it rolls, so the rules are asked about the spawn from the first frame.

What the offset is, then, is how far off the standing frame the ball begins.
The frame shows 9.6 m of world at the base zoom, so the ball is out of shot past about 4.8 m either side of a centred spawn, and 2 to 4 m rolls it in from the edge - a second and a third at 2 m, a little under three at 4.
A region that zooms out shows more of it, and one that offsets the spawn on screen moves the edge the ball has to come from: measure the entry against the framing the spawn actually gets, not against the middle of the screen.
The editor draws the entry as a second spawn ring on a dashed run into the marker, which is what that is judged by eye against.

## A recorded arrival

The other opening a spawn may author is a **recorded run**: the level plays somebody's session back from the point it started and hands the ball over when the recording runs out (`arrival` - see [ball-rolling](ball-rolling.md#the-recorded-arrival)).
`CAVE` opened on one until 2026-09-23 (no level does now), and what it buys over a roll is everything a roll cannot say: the ball arrives by swinging, through the level's own geometry, from somewhere the player will later be.

It is **authored by playing it**, which is the whole method and the whole constraint.
Play the opening you want, press **P**, run `bun run scripts/make-arrival.ts <bundle> <level>`, keep the bundle in `playtests/arrivals/` and name the stream on the spawn - and expect to record it several times, because what you are judging is a performance rather than a number.
What to play FOR is the ENDING: somewhere the player can be handed the ball - near the spawn, at rest, off the chain (`arrival-lands` holds it to within a metre of the spawn).
How long you take pressing P afterwards does not matter, because the generator cuts the stream where the ball stops moving; what it cannot cut is an opening that ends with the ball somewhere awkward.

The camera is the level's own, following the ball as it does in play, so an arrival is also a **tour of the framing**: every region and path it passes through is one the player sees working before they touch anything, and a camera rule that is wrong on the way in is wrong on the opening of the level.

Editing the level under a recording that was made on it does not break the stream, it changes what the stream does - the throws go where they went and the geometry they went around is somewhere else.
Re-record the arrival whenever the room it moves through changes, and read `cli entry`'s `arrival-lands` as the alarm rather than as the check.
