# Minecarts

Powered carts that ride an authored track, are slowed or stopped by whatever holds them (the ball in the way, the chain hooked to them) with their wheels spinning and sparking, go out from a spawner on a fixed beat, and leave the play plane round a bend at the end of the line.
Built 2026-11-27; the physics is covered by `cli tracks`, and the feel (speed, pull, grip, sparks, the bend) is unplayed.

## The track mounting (`engine/track.ts`)

A cart is a `RigidBody2D` with a `track` (`TrackMount`): a rigid body with ONE freedom, its arc length `s` along the line.
It is the bead on a wire in reduced coordinates, the statement `pivot` (no translation) and `spring` (no rotation) already make.

The pose is a function of `s`.
The two wheelsets stand on the line half a wheelbase either side of `s`, the body turns with the chord between them (plus the angle it was built at against that chord), and its origin is carried in the chord's frame.
So a cart cannot tip, lift or leave the rails: there is no coordinate in which it could.
The chord is what pitches the cart over a crest, so its angle stays continuous across the flattened polyline's kinks.

The dynamics are reduced the same way.
A point `r` from the origin moves at `u(r) v` for track speed `v`, with `u(r) = T + kappa perp(r)` (`T` the origin's derivative along the line, `kappa` the angle's), and the generalised mass is `M = m |T|^2 + I kappa^2`.
An impulse `J` at `r` changes `v` by `(u(r) . J) / M` and nothing else; the rail takes the rest.
Every solver site that sizes or applies an impulse asks `trackResponse` / `applyTrackImpulse` for a track body and keeps its own arithmetic for every other pair, so no recorded replay moves:

- `World.solveContacts` (`sideResponse`) and `applyPairImpulse`;
- `World.separatePairs` (a positional push along the line, `trackShift`);
- the island's contact rows, tie segments and `applyAt` (`hasTrack`, `rowSide`);
- the ball's chain row (`BallChainRow`, `trackTermResponse`, `applyTerm`);
- the loop cap (`BallPlayer.applyLoopCap`);
- `RigidBody2D.applyImpulse`.

The rope's positional solve treats a cart as immovable, as it treats a tied body: the chain's pull reaches a cart at velocity level through its row, along the line.
The chain's pin friction (`PinRow`) skips a cart, and an authored chain may not be tied to one.
`World.depenetrateRigid*` skip a cart; it meets no scenery.

Whatever else writes a cart's velocity or pose (an area, the island's damping, a push-out) is folded back onto the line by `TrackMount.absorb`, which projects the change onto `s` by kinetic-energy weight and writes the pose again.
It runs inside every step of the cart (`integrate`, `accelerate`, `advance`), at the close of `World.integrate` (`absorbTracks`), and after the chain phase.
The contact audit checks a cart in its one freedom: `M dv` against `T . P + kappa L`.

A cart never sleeps (`canSleep` is false for a track body).

## Collision layers

A cart's pieces are on `LAYER_SCENERY | LAYER_CART`, with the mask `MASK_CART` (player, hook, rope, cart).
Everything that meets scenery meets a cart, while the cart's own half of the test refuses the scenery, rails included: the track holds a cart up and nothing else does.
Carts meet each other, which is how a queue forms behind a blocked one.
Another dynamic body on the scenery layer (a crate) passes through a cart; nothing in a level needs that yet.

## The drive (`level/tracks.ts`)

A motor turns the wheels, and the wheels meet the rail through friction: two bounded rows per step, solved inside the cart's own step after gravity and before the position (`TrackMount.drive`), so semi-implicit Euler holds with the grip a force of the step.

- The motor drives the wheels toward `speed / r`, within `pull * r * dt`.
- The grip passes the rim speed into the cart within `mu N dt`, where `N` is the cart's weight into the line.
  The static coefficient is the track's `grip` (default `WHEEL_STATIC_FRICTION`, 0.35, steel on steel) and the sliding one keeps steel's ratio to it (0.25 / 0.35).
  Which applies is the state the wheels ENDED the last step in: read from this step's slip, gravity's own `g sin(a) dt` crossed `WHEEL_ROLL_SLIP` on any slope over 17 degrees and handed a rolling cart the sliding coefficient every step.

The two rows are solved together, EXACTLY, in closed form: both free (cart and rim at the cruise speed), else the grip at its limit with the motor holding the wheels at the cruise speed against it, else the motor at its limit with the grip moving cart and rim as one, or slipping at its own limit.
Solved one after the other once each (the first version), the motor topped the wheels up, the grip drew them down speeding the cart, and the motor never answered: a cart with ten times the pull a 30 degree climb needs held 1.16 m/s of its 1.5.
Iterated as sequential impulses it closes only the wheels' share of the pair's inertia (a fifth) per pass, so 12 passes still left it at 1.493.
And the grip-limited case has to be tried before the motor-limited one: the free solution asks the motor for whatever brings a HELD cart to speed, and clamping the motor to its full torque against that spun the held cart's wheels up without end.

`grip` is a track's own because adhesion is the climbing limit: a cart climbs no slope steeper than `atan(grip)` whatever its pull (the editor shows the angle beside the field), and once its wheels have slipped on a climb it recovers only where `0.71 grip > tan(slope)`.
A cart's weight changes neither: the grip and gravity's pull down the slope both scale with it.

A free cart rolls at its cruise speed.
A held cart is held by the contact or the chain row, which take back the speed the grip gave it, and once the motor out-pulls `mu_k N` the wheels spin up past the cart.
The cart then pushes on whatever holds it with `mu_k m g` and no more.
The steepest slope a cart can climb is `atan(grip)` (19 degrees on steel), when its pull is at least that; past it the cart slides back with its wheels spinning.
The wheels' inertia is four solid 12 kg discs at the track's wheel radius; only the spin the motor has to win against the grip reads it.

A wheel slipping faster than `WHEEL_ROLL_SLIP` reports a `SparkEvent` at both wheelsets each frame, on the frame's final pose (`MineTrack.report`), with its velocity `-slip` along the line: the rim's slide over the rail, which is the way the sparks are thrown ([sparks](sparks.md)).

## The spawner

Slot `k` opens at `(k + phase) * interval`.
On the frame a slot opens, one cart goes out with its rear wheelset at the start of the line, at its cruise speed, unless the cap is reached, another cart is within a cart's length of the start, or the ball is in the way.
A refused slot is SKIPPED, never delayed, so a player holding carts up delays those carts and no others, and the spacing recovers as the held ones leave.
The level opens with the carts the clock has already sent out (`prewarm`): each past slot's cart as far down the line as the cruise speed has taken it, up to the cap, short of the end and clear of the ball.

## The exit

A cart whose wheelset reaches either end of the line leaves the simulation on that frame.
The ball's chain is let go first if it is anchored to the cart, the body is removed from the world and from the wrap list, and a `TrackExit` event is written (`BallLevel.trackExits`, cleared every frame like the sparks).
Nothing the cart was pushing or holding is carried past the end.

What the player sees is render-side (`render3d/minecarts.ts`, `CartLooks`).
The drawn cart is carried through two corners in the rock, timed by the sim clock (the host drains the exits per step, as it does the sparks):

- a quarter bend of `exitRadius` out of the play plane, from the line's direction to straight away from the camera (`-z`);
- `exitDepth` straight on into the depth (default 0);
- a second quarter bend of the same radius back to running sideways, toward screen `exitTurn` ("left" / "right", by default back the way the cart was travelling, so the path zig-zags);
- a 6 m run out sideways, behind the scenery, and it is dropped.

A cart only turned away from the camera shrank into the background in plain view, which read as it vanishing (2026-11-27); the second corner takes it out sideways behind the rock instead.
Each turn is a yaw about the screen's vertical, the pitch the cart had on the line levels out over the first bend, and its wheels turn on at the rate they left with.
A cart leaving slower than 1 m/s is drawn leaving at 1 m/s.
Place the end of a track where the bend is plausible: at a tunnel mouth, or behind scenery that occludes the turn.

## Drawing a cart

A live cart is drawn as an authored body is: a `BodyVisual` built from the cart's `BuiltBody` (its debug geometry follows the template's flags), with the template body node's look (its `Model3D`) built by a `TreeLook` of its own into that visual's authored frame.
The level's own `TreeLook` does not descend into a `Track2D`, so the template is never drawn standing where it was authored.
The model's wheels are the objects whose names contain "wheel" (`build_minecart.py` names them and puts each origin on its axle); they turn about the model's sideways axis by the sim's `wheelAngle`.

## Authoring

A `Track2D` node: `verts` (the camera path's node shape, in the track's frame, in the direction carts travel), `speed` (px/s), `pull` (N), `interval` (s), `max`, `phase` (cycles), `wheelBase`, `wheelRadius`, `exitRadius` and `exitDepth` (px), and `exitTurn` ("left" / "right").
Its one body child is the cart template, placed on the line where it sits on the rails; that placement is what says how high a cart rides and which way up it is.
`compileLevel` takes the template out of the level's bodies into `TrackData.cart`, as a rigid body whatever class the node is.
Defaults: 2 m/s, a pull of half the cart's weight, a slot every 6 s, 3 carts, the `minecart` model's 1.0 m wheelbase and 0.2 m wheels at half scale, a 1.5 m bend.

### In the editor

The **Track** tool (the cart on rails, last block of the 2D toolbar) clicks out a line in the direction carts travel; Enter or a double-click finishes it.
It writes a `Track2D` at the first node and places a `minecart` instance on the first stretch, turned with the line's SLOPE and never its direction (a line drawn right to left keeps the cart upright; it then drives toward its own -x, and `CartLooks` turns its wheels the other way by `facing`), its model's wheels on it (the prefab's `Model3D` offset is the ride height), so a fresh track runs carts with no further step.
A track is an `EdObject` "track" with a `path` shape: its nodes and Bézier handles are edited with the camera path's gestures, and its panel holds Reverse / Smooth / Sharpen, the spawner (speed, interval, max, phase) and the drive (pull, wheel base, wheel radius, exit bend), each blank at the format's default with the default as placeholder.
The line is drawn on the overlay with its direction in arrows, a bar at the start and a dashed hook at the end (`drawTrack` in `editor/render.ts`).

The cart under it is an ordinary body in the editor: `compileLevel(..., { keepTrackCarts: true })` keeps the template in the level's bodies as well as in `TrackData.cart`, so the editor draws, picks and edits it, and `TreeLook` draws a track's cart only where it was built as a body.
The game's compile, ▶ Test's and the flat disk form (`modelToFlatDisk`) leave it out.

## Verification

Detectors:

- `WorldDigest.carts`: each cart's `s`, wheel spin and slip, written only on a level with tracks, so `cli diverge` names a cart (`cart#0.s`) and every bundle from before the field digests as it did.
- `checkBallInvariants`: `cart-off-line` (any cart more than 1e-9 off the pose its `s` gives, or with a velocity off its line) and `cart-nan`.

`cli tracks` (in `bun run test`):

- `cruise`: rolls at the cruise speed with no slip, on its line every frame.
- `slope-roll`: unpowered from rest down a slope, exactly the closed form `a = m g sin(a) / (m + I_w / r^2)` under semi-implicit Euler.
- `grip-climb`: a 30 degree climb with pull to spare: steel slips back down; grip 0.8 climbs at exactly the cruise speed without slipping.
- `blocked`: driven into a wall, stopped, wheels held at exactly the cruise speed, sparks at both wheelsets, pushing with exactly `mu_k m g`.
- `right-to-left`: a line drawn the other way keeps an upright cart upright and leaves at its left end.
- `spawn-clock` and `spawn-blocked`: the cap, every spawn on a slot, slot spacing on the line, and the beat surviving a blocked start.
- `exit`: removed from the world and the wrap list with an exit event.
- `curved-line`: over a hump, on its line and pitched with its chord.
- `hung-from-cart`: the ball hung from a cart by its chain, carried on, and let go of on the exit frame and not before.
- `editor-round-trip`: a track loaded into the editor's model (an item and a body) and written back compiles to the same track and cart.
- `deterministic`: two runs agree to the bit.

What green cannot see: the feel of every number above, the sparks' look, the bend (a render-side path no case drives), and the wheel spin's direction on the model.
Those need a playtest.
