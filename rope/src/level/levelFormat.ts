// Canonical, hand-editable level format — the single source of truth for the
// level schema, shared by the runtime loaders (`Level`, `BallLevel`) and the
// level editor. `levelData.ts` is auto-generated from a Godot scene and stays
// untouched; it is written in the RETIRED flat form below, which
// `normalizeLevelData` folds into this one at load.
//
// Geometry is authored in Godot/scene pixels (as in the generated data); the
// simulation runs in metres. `scaleLevelData(data, PX)` converts on load and
// `scaleLevelData(data, PIXELS_PER_METER)` converts back for saving to disk.
//
// THE SHAPE OF A LEVEL. A level is a list of BODIES, and a body is a list of
// SCENE OBJECTS: a collision shape, a light source, or a piece of 3D geometry.
// Everything a body has that is one-per-body — what it collides as, what colour
// it is, how much a current in it pushes — lives on the body; everything a body
// may have several of lives on its objects.
//
// That is a change of shape rather than of vocabulary, and it is worth saying
// what it replaced, because three separate mechanisms collapse into it:
//
// - A compound body was a `group` STRING TAG on several flat entries, matched by
//   name at load. Now it is what it always meant: one body with several
//   collision objects. Nothing has to agree about a tag, and the properties a
//   body has exactly one of cannot be authored several times and then quietly
//   collapsed onto the first member's (`syncGroupProps` is gone with it).
// - DECORATION was `collision: false` on a body-shaped entry - a shape that had
//   to carry, and then ignore, every physics field. Now it is a body with a
//   geometry object and no collision object, so there is nothing to ignore.
// - A LIGHT was its own top-level list with no parent, so it could not ride
//   anything, and a lamp was TWO authored objects at the same point that nothing
//   kept in step. That gap was patched by deriving a light from a glowing shape,
//   with seven fields on the visual describing a light in disguise. All of it is
//   gone: a light is an object, it sits in the body its fitting is in, and it
//   rides that body's pose because it is inside it.
//
// UNITS. Lengths are scene pixels on disk and metres in the sim, and
// `scaleLevelData` converts them. Angles, the uniform `scale`, `tileScale` and
// a light's `intensity` are NOT lengths and pass through untouched. Getting that
// wrong is silent: the scalers rebuild objects field by field, so a field they
// do not enumerate is dropped on the next save rather than reported — hence the
// round-trip cases in `cli render3d`, which are what actually hold them to their
// lists.

// Body kinds a level can contain:
// - static:      immovable geometry the rope wraps and bodies collide with.
// - killzone:    an Area2D that resets the level when the avatar enters it.
// - rigid:       a dynamic RigidBody2D (gravity + collisions), authored in place.
// - force:       an Area2D that accelerates every body inside it along the
//                area's own rotation (a river current, wind, an updraft).
// - water:       an Area2D that DRAGS every body inside it toward a current
//                running along the area's own rotation (a sewer channel, a
//                sluice, a falling stream). A force area pushes and has no
//                terminal speed; water has a speed it carries things at, and
//                being slowed to it and being pushed by it are the same act.
//                See `WaterArea`.
//
// Hook-only scenery is not among them, and used to be (`anchor`): a body
// nothing but the hook can find is now the `passable` flag below, for the reason
// that retired the `impermeable` kind and one more. A kind is what a body IS, so
// hook-only could only ever be immovable scenery - and the thing levels want it
// for is a background leaf on a sprung stem, which is a `rigid` body. A flag
// composes with every kind; a kind excludes every other.
//
// A TRAMPOLINE is not among them either, for the same reason and with the same
// answer: it is the `bounce`/`launch` pair below, so a pad can be static scenery,
// a bouncy crate that still falls, or a paddle on a bearing that swats what it
// hits, rather than one of the three at the cost of the other two.
//
// Hook-proof (`impermeable`) is deliberately NOT among them - it is a per-object
// flag below. It was a kind while it could only ever be static scene geometry,
// and that cost the two things a level actually wants: a hook-proof crate that
// still falls and is hauled about (nothing can be `rigid` and `impermeable` at
// once when both are kinds), and a compound wall with one attachable ledge and
// hook-proof faces everywhere else.
//
// A body with NO collision object has no physics at all, so its kind is not
// consulted. It is still written (and defaults to `static`), because a shape may
// be switched back and forth while a level is authored and silently losing the
// kind on the way through would be a field that forgets.
export type BodyKind = "static" | "killzone" | "rigid" | "force" | "water";

// How a moving body spends a traverse of an OPEN route (see
// `LevelBodyData.moveEase`). The trip takes the same time under all of them -
// an ease redistributes it - so `moveSpeed` stays the average whichever is
// picked.
//
// What separates them is what happens AT THE ENDS, where the body turns round.
// A traverse's return leg is the outward one mirrored in time, so the speed the
// body arrives at an end with is the speed it leaves at: an ease whose rate
// falls to zero there turns round smoothly and one that does not reverses
// outright, which is a step in velocity and reads as a jolt (and is thrown at
// whatever is riding it, contact velocities being real here).
//
//   linear   constant speed, a hard reversal at both ends - a machine
//   sine     eases out of both ends and turns round smoothly - a lift, a swing
//   easeIn   leaves gently and hits the far end at full speed - a lunge out
//   easeOut  leaves at full speed and settles into the far end - an arrival
//
// `easeIn` and `easeOut` are the same curve mirrored, and the pair is offered
// rather than one of them because the ROUTE has a near end and a far end: which
// of the two turns hard is the thing being chosen.
export type MoveEase = "linear" | "sine" | "easeIn" | "easeOut";

// The same four as a list, for the editor's picker - so a new one is offered by
// existing rather than by being added to a second place.
export const MOVE_EASES: readonly MoveEase[] = ["linear", "sine", "easeIn", "easeOut"];

// The fastest a body travelling at an average `moveSpeed` actually goes, as a
// multiple of it. It is what a `linear` route runs at flat, and an ease trades
// the middle of the trip against the ends: `sine` peaks in the middle at π/2,
// and either one-sided ease spends the whole trip accelerating or decelerating
// and so peaks at twice the average. The number the editor's surface-speed
// readout is built on, and the reason it is here rather than in that readout.
export function movePeakFactor(ease: MoveEase, closed: boolean): number {
  if (closed) return 1;
  if (ease === "sine") return Math.PI / 2;
  if (ease === "easeIn" || ease === "easeOut") return 2;
  return 1;
}

// The retired kind, as levels on disk (and the generated `levelData.ts`) still
// carry it. `normalizeLevelData` folds it into `static` + `impermeable: true`
// at load, so nothing past that line ever sees it.
export const LEGACY_IMPERMEABLE = "impermeable";

// A shape as authored on disk. `poly` is a **simple** vertex loop in the
// object's own local frame, centred on its area centroid (the loader re-centres
// one that is not, shifting the object's position to compensate, since a body's
// origin is its centre of mass everywhere in the engine). A rect stays its own
// kind rather than being written as a four-vertex poly: every recorded replay
// was simulated through the rect-specific collision routines.
//
// Simple and not convex, which is the one place the two halves of the project
// disagree about what a polygon is, and deliberately: the ENGINE's polygon is
// convex without exception (a reflex vertex is unwrappable, see "Convex-only
// polygons; compound bodies" in docs/game-design.md), while a LEVEL authors the
// outline the geometry actually has - an L-shaped ledge, a notched pillar, a
// cave mouth. `makeShapes` cuts a concave outline into the convex pieces that
// tile it as the object is built, so the file keeps the author's shape and the
// solver still only ever sees convex ones. A loop that crosses itself is not a
// shape either way and fails the build.
//
// The exception is a CAMERA REGION, whose polygon must stay convex: a region is
// tested by its face half-planes and grown into a buffer zone by offsetting
// them (`pointInRegion`, `pathOutlineGrown`), neither of which has a concave
// answer, and a region is not built into pieces that could carry one. The editor
// holds a camera-layer polygon convex for that reason.
export type ShapeData =
  | { kind: "rect"; w: number; h: number }
  | { kind: "circle"; r: number }
  | { kind: "poly"; verts: { x: number; y: number }[] };

// Default shape appearance: dark grey fill at 0.5 opacity (borders always draw
// fully opaque in the same colour). Applied when a body omits color/opacity.
export const DEFAULT_BODY_COLOR = "#555555";
export const DEFAULT_BODY_OPACITY = 0.5;

// Surface friction of authored geometry: 0 = ice, 1 = rubber. 1 is the default
// and MUST stay so — it scales the contact-friction terms by exactly 1, which
// reproduces the historical constants bit-for-bit (recorded replays predate
// this field). Only authored ice changes behaviour.
export const DEFAULT_SURFACE_FRICTION = 1;

// How bouncy authored geometry is, and how hard it throws. Both are 0 by
// default and MUST stay so - a surface that cancels an approach outright is
// what every level authored before these fields has, and what the contact solve
// did before it could be told otherwise.
//
// `bounce` is the coefficient of restitution: 0 is a dead floor, 1 a perfect
// bounce, and what a body leaves with is proportional to what it arrived with.
// `launch` is the trampoline half - a floor under the outgoing speed, in scene
// pixels/s, that the surface pays whatever the arrival was worth. 900 px/s
// (→ 9 m/s) throws the ball a little over four metres up.
//
// See `CollisionObject2D.restitution` for how the two combine.
export const DEFAULT_BOUNCE = 0;
export const DEFAULT_LAUNCH = 0;
// Default strength of a new force area, in scene pixels/s² (→ 3 m/s², roughly a
// third of gravity: a current that carries but does not fling).
export const DEFAULT_FORCE_MAGNITUDE = 300;

// A new water area's current, in scene pixels/s (→ 2 m/s: a brisk walk, fast
// enough to be fought and slow enough to be swum against), and how hard it takes
// hold, in 1/s (a fifth of a second to two thirds of the current).
//
// The pair is deliberately one speed and one rate rather than two forces: the
// speed is the thing an author is choosing (how fast the water runs) and the
// rate only says how quickly it wins.
export const DEFAULT_WATER_FLOW = 200;
export const DEFAULT_WATER_DRAG = 5;

// ---------------------------------------------------------------------------
// Scene objects
// ---------------------------------------------------------------------------

// Where an object sits IN ITS BODY'S FRAME: a local offset and a local angle,
// both absent meaning the body's own origin and rotation.
//
// Local rather than world, which is the whole point of the body existing: a lamp
// authored at an offset from the crate it is bolted to swings with the crate,
// and there is no second placement anywhere that could disagree about where it
// is. It is what the retired mechanisms could not say — decoration and chain
// anchors both had to be authored in WORLD coordinates and converted at load,
// precisely because a `group` tag gave them no frame to be authored in.
//
// The body's ENGINE origin is still its combined centre of mass, which is what
// every rigid-body lever arm in this engine is measured from, and it moves as
// collision objects are added. That is exactly why the AUTHORED origin is a
// separate, authored thing: the file's frame stays put while the physics frame
// finds its own, and `buildLevelBodies` carries the difference. Authoring
// against the centre of mass directly is what would move every offset in a body
// whenever a piece was added to it.
//
// Lengths, so `x`/`y` convert between the file's pixels and the sim's metres;
// `rot` is radians and does not.
export interface ObjectPlacement {
  x?: number;
  y?: number;
  rot?: number;
}

// A collision shape: what the body is made of, physically. It is the only object
// kind the simulation sees at all — a body with none of them never enters the
// `World`, carries no mass, and no physics path has to know it exists.
//
// That last clause is the design rather than a consequence. Decoration used to
// be kept out of the sim by a flag every physics query would have had to honour;
// an object that is never BUILT is excluded from everything by construction, and
// there is no call site left to remember.
export interface CollisionObjectData extends ObjectPlacement {
  type: "collision";
  shape: ShapeData;
  // Hook-proof: the grapple hook is destroyed on this surface and the ball's is
  // deflected, instead of either anchoring. It is solid either way - being
  // hook-proof is about the rope and nothing else - so the avatar stands on it,
  // bodies collide with it and the rope still wraps its corners.
  //
  // Per OBJECT, and unlike the body-level properties it deliberately does not
  // collapse: a compound wall whose one attachable ledge is a piece among
  // hook-proof faces is precisely what it is for, and which surface the hook
  // reached is a question about a shape rather than about a body.
  impermeable?: boolean;
  // What this piece is made of and how thick it is through z - the dimension the
  // 2D view cannot show. Together they are the piece's mass: its area times
  // `thickness` times the material's density (`MATERIALS` in
  // `lib/shapeGeometry.ts`), so a 2 m × 0.4 m stone slab 20 cm thick weighs
  // 384 kg and a level author can check that against the real thing.
  //
  // A material NAME rather than a raw density, because naming the stuff is the
  // decision an author is making; the density is a fact about the material that
  // the level should not restate. An unknown name (a hand-edited file, or one
  // written by a build that had a material this one does not) loads as the
  // default rather than as a body of no mass.
  //
  // Absent = wood, 0.2 m: what every body authored before these fields is made
  // of, so an old level loads with exactly the masses it always had.
  //
  // Both are per OBJECT and not per body, which is the one property of a
  // compound body that deliberately does NOT collapse onto its first piece's: a
  // body made of a stone head on a wooden shaft is exactly the case, and its
  // mass, centre of mass and moment of inertia are all sums over the pieces
  // (`buildBodies.ts`), so each piece bringing its own material is what those
  // sums are for.
  material?: string;
  // Metres in the sim, scene pixels on disk like every other length.
  thickness?: number;
}

// A piece of 3D GEOMETRY: what the body looks like, as opposed to what it
// collides as. Render-only throughout — `sim/*`, the mass computation in
// `buildBodies.ts` and `contactCases.ts` all ignore it, and a level with none of
// it plays identically.
//
// NOTHING ELSE DRAWS. A collision object is what a body is made of and a
// geometry object is what it looks like, and a body with no geometry object is
// drawn by nothing at all - an invisible wall, which is a thing a level may
// perfectly well want. The two used to be one authored thing (a collision shape
// drew itself whenever nobody said otherwise), which meant there was no way to
// say "this collides differently from how it looks" without also saying how it
// looks. Levels written in the LEGACY form are given the geometry object that
// states it, once, at load (`withGeometryTwin` in this file), so nothing on disk
// changed appearance when the default went away. A body in the current form is
// left exactly as authored, however bare: an editor draw makes a collision object
// and nothing else, and a loader that invented a look for it would make "drawn"
// and "simulated" one decision again by the back door.
//
// A GEOMETRY OBJECT CARRIES ITS OWN FORM, always. Its `shape` and its placement
// are what is drawn and where, and no part of them is read off a collision
// object: a primitive nudged 10 cm left, turned 5° and made twice as wide moves,
// turns and grows on screen while the body goes on colliding exactly as it did.
//
// It used to be able to have NO shape, and then it drew the body's collision
// outlines - which is how a wall wore brick without restating its outline, and
// what every migrated body was given. The saving was real and the cost was that
// the two were not actually separate things: the geometry object's own `x`, `y`,
// `rot`, `w` and `h` were dead fields on the commonest object in every level,
// silently overridden by the shape it was standing in for. Levels are migrated
// to primitives that state the outline they were drawing (see
// `scripts/migrate-primitives.ts`), so nothing changed appearance and every one
// of those fields now means what it says.
export interface GeometryObjectData extends ObjectPlacement {
  type: "geometry";
  // How this is turned into something the GPU draws. The two answers are the two
  // ways a thing gets a look in this game, and they are a choice:
  //
  // "primitive" (and an absent `kind`): this object's own `shape`, given depth -
  //         a rect is a rectangular prism, a circle a cylinder, a polygon that
  //         outline extruded - wearing a tileable PBR surface (`texture` +
  //         `tileScale`). No file, no download.
  // "mesh": a named GLTF asset from the manifest (`render3d/assets.ts`) instead,
  //         which may bring its own materials or wear the same surface set.
  //
  // There is deliberately no "drawn by nothing": a body draws what its geometry
  // objects say and nothing else, so an invisible wall is a body with collision
  // objects and NO geometry object - which needs no field to say it, and is what
  // an editor draw produces before anything is dressed.
  kind?: "primitive" | "mesh";
  // Manifest key. `kind: "mesh"` only; an unknown key draws the placeholder
  // rather than nothing, so a missing asset is visible instead of silent.
  mesh?: string;
  // The form this is drawn as, in this object's own frame. A primitive without
  // one draws the unit placeholder, exactly as a prop with no file does - a
  // geometry object that draws nothing at all would be indistinguishable from a
  // body that authors no look, which is a different statement with its own
  // spelling (no geometry object).
  shape?: ShapeData;
  // This primitive MIRRORS a collision object in its own body: the editor keeps
  // its `shape`, placement and `rot` equal to that piece's, in both directions,
  // so resizing either resizes both. It is the standing form of the "match the
  // collision shape" edit the decoupling priced in ("a wall widened after it is
  // dressed is widened twice") - a LINK, not a fallback: the outline is still
  // stated here in full, and the game and every loader read it exactly as they
  // read an unlinked one. The partner is not named - the editor re-finds the
  // collision object with the identical outline at load, which the link's own
  // invariant guarantees exists - so there is no index to go stale when a
  // body's objects are reordered.
  matchCollision?: boolean;
  // Depth placement, as an OFFSET from the body's own `z` (which is 0 unless
  // the body says otherwise). Positive is toward the camera. Absent = the
  // body's own plane for a body with collision, and a little behind it for
  // decoration (`DECOR_Z`), which is what a flat fill drawn before every body
  // already was.
  z?: number;
  // Rotation about the two axes the body's own `rot` cannot express. (Rotation
  // in the gameplay plane is `ObjectPlacement.rot`, shared with every other
  // object kind, so a prop and the light beside it are turned by the same field.)
  rotX?: number;
  rotY?: number;
  // Uniform mesh scale, dimensionless: it multiplies a model's own size and is
  // not a length, so it does NOT scale on the way in or out.
  scale?: number;
  // Depth through z. Absent = `DEFAULT_THICKNESS` on a body that collides and
  // `DECOR_DEPTH` on one that does not, which is what a flat fill drawn before
  // every body already was. It is NOT the collision object's `thickness`: that
  // is the number a piece's MASS is computed from and this is how thick the
  // thing looks, and a migrated body states its own so the two start out
  // agreeing (see `scripts/migrate-primitives.ts`).
  depth?: number;
  // Edge break, metres. Absent = none: a level is boxes meeting boxes, and a
  // chamfer on every one of them softens the corners its silhouette is made
  // of, so this is authored where a solid actually wants one.
  bevel?: number;
  // Which surface to wear. A key of `TEXTURE_ASSETS` (an authored PBR set:
  // albedo, normal, roughness, metallic, ambient-occlusion and emission maps) or
  // of `TEXTURE_SETS` (the generated surfaces, keyed by material name) - one
  // namespace, looked up in that order by `render3d/assets.ts`.
  //
  // The reserved key `"color"` is the one entry that names no surface at all: it
  // draws a FLAT FILL of this object's own `color` (or the body's), with no
  // pattern and nothing to tile, and it wears that colour EXACTLY rather than as
  // a tint over noise. It is what a block of solid colour is authored as - a
  // backdrop, a UI-ish panel, a shape being blocked out before it is dressed -
  // and it is spelled as a texture key so that swapping a wall between brick and
  // flat paint is one string and not a different kind of object.
  //
  // Absent = the generated surface `DEFAULT_MATERIAL` names. A collision
  // object's `material` is NOT consulted: what a piece is made of is a fact
  // about its mass, and reading it as a statement about the look is the coupling
  // this object was separated out to remove. A migrated body carries the
  // material name here explicitly, so nothing on disk changed appearance.
  //
  // It applies to BOTH visual kinds: an extrusion is textured with it, and a
  // `mesh` wears it instead of the materials its own file carries. A mesh that
  // authors none keeps its own, which is what lets a fully-textured prop drop in
  // untouched and a bare one (geometry only, ~20 KB) be dressed as level stuff.
  texture?: string;
  // Tiling scale: how large this wears the texture, as a MULTIPLE of the size
  // the texture itself was authored at. 1 is life size - one repeat covers
  // exactly the world distance the surface was captured over - 2 is twice as
  // large, 0.5 is half. Absent is 1.
  //
  // DIMENSIONLESS, like `scale` and unlike every other number in this block, so
  // it does NOT convert between pixels and metres. That is the whole point of
  // expressing it this way: the absolute size lives once in the manifest, where
  // it is a fact about the texture (`TextureAsset.tile`, in metres - Poly Haven
  // publishes the capture size of every set), and a level says only whether this
  // wall wants it bigger or smaller than intended. A level authoring absolute
  // metres would restate that fact everywhere, and get it wrong wherever the
  // texture was later swapped for one captured at a different size.
  //
  // It works because the extruder writes UVs in METRES (extrude.ts): a repeat is
  // a world distance rather than a fraction of a face, so a 0.4 m plank and a
  // 40 m wall of the same stuff show the same brick, and only the count differs.
  tileScale?: number;
  // Where the texture STARTS, as a shift in world space: +x moves it right, +y
  // moves it down (level coordinates, the same sense as an object's own `x`/`y`).
  // Absent is 0.
  //
  // It is what aligns a pattern to the thing it is on rather than to the world
  // origin: brick courses meeting a window head, a tiled floor whose grout lines
  // land on the edges of the floor. Without it the only lever is the shape's own
  // position, which moves the collision geometry too.
  //
  // A LENGTH, so it is scene pixels on disk and metres in the sim like every
  // other - and since a scene pixel IS a centimetre here (PIXELS_PER_METER is
  // 100), authoring it in centimetres and authoring it in the file's own units
  // are the same act: `25` is 25 cm.
  //
  // The shift is applied in the SURFACE's frame after tiling, so it moves the
  // pattern and never the geometry, and it is measured in world distance rather
  // than in repeats: 25 cm is 25 cm whatever `tileScale` is set to, which is what
  // makes the two fields independently adjustable instead of one undoing the
  // other.
  tileOffsetX?: number;
  tileOffsetY?: number;
  // Fill colour and 0..1 opacity for THIS geometry, overriding the body's.
  // Decoration is what wants it: a backdrop is authored to sit behind the
  // geometry, so painting it the body's colour is exactly wrong.
  color?: string;
  opacity?: number;
  // What this GIVES OFF, as opposed to what it reflects: a hex colour added to
  // the surface after all lighting, so it reads as bright whatever is (or is
  // not) shining on it. Absent = it emits nothing, which is almost everything.
  //
  // It is APPEARANCE and nothing more. Three.js has no global illumination, so
  // an emissive material reaches nothing at all - it is a bright pixel and no
  // more - and a lamp that lights the room is this plus a LIGHT OBJECT beside it
  // in the same body.
  //
  // That pairing used to be the problem this field solved badly. A lamp was an
  // emissive shape and a light in the top-level light list at the same point,
  // nothing kept the two in step, and moving the sconce left the light behind -
  // so a glowing shape was made to DERIVE a light, with seven more fields here
  // describing its reach, its cone, its aim, its shadow and its flicker. Those
  // are gone. A light in the same body cannot drift from the thing that looks
  // lit, because it is inside it; and a light says what a light says, in a light's
  // own fields, rather than in a second vocabulary spelled `emissive*`.
  //
  // Dimensionless and unscaled, both of them.
  emissive?: string;
  // Multiplier on `emissive`. Above 1 pushes the colour past white into the
  // range ACES tone mapping still has headroom in, which is what makes a small
  // flame read as a SOURCE rather than as a pale patch of paint. Absent = 1.
  emissiveIntensity?: number;
  // WHERE this glows: a `TEXTURE_ASSETS` key whose EMISSION MAP is worn over
  // whatever surface this already has, multiplied by `emissive` as a tint.
  // Absent = the surface itself decides - a set carrying an emission map glows by
  // being worn, and one that does not glows over its whole face if `emissive`
  // says so.
  //
  // It is what makes emission a pattern rather than a paint: lit windows in a
  // dark wall, cracks in cooling slag, a strip of instrument lights. The base
  // surface stays whatever it was, so the wall is still brick.
  //
  // A key naming a set with no emission map leaves this unmapped rather than
  // blank, which is the same rule an unknown `texture` follows: a level authored
  // against a manifest this build does not have looks ordinary.
  //
  // Tiled like everything else - the set's own `tile`, scaled by `tileScale` and
  // shifted by `tileOffset` - so the glow lands on the same grid as the surface
  // under it.
  emissiveTexture?: string;
}

// A LIGHT: a torch on a wall, a shaft coming down through a grate, the glow off
// a pool of something. It is what an interior is lit by, and the reason it
// exists as an authored object at all is that one directional sun cannot be one:
// a sun is a light at infinity, so it reaches everything in the frame equally
// and a room lit by it is a room with no inside. The reference look is the
// opposite - a warm pool of light on the gameplay plane, and the geometry
// framing it falling away to black - and every part of that is a light with a
// POSITION and a REACH.
//
// It is an object IN A BODY rather than a top-level list, which is the whole of
// what changed about it: a light in the body its fitting is in rides that body's
// pose, so a lantern welded into a swinging crate swings with its light. A light
// with no visible source - a shaft down a grate, a fill - is a body containing
// nothing but this, which builds no engine body and simply sits where it was
// authored. Both are the same construction; one of them happens to have a lamp
// in it.
//
// Render-only, like the environment block: it has no collision, nothing wraps
// it, the sim never sees it, so a level plays identically with the 2D renderer
// or with no lights at all.
//
// UNITS. `z` and `range` are lengths and convert on load like the placement's
// `x`/`y`. `intensity` is NOT, and that is the one trap here: a point light's
// brightness is candela, which is an irradiance times a distance squared, so a
// field that converted with the rest would have to convert as the SQUARE of the
// factor. Rather than carry the one field in the file that scales differently
// from every other, `intensity` is defined against the SIM's metres and passes
// through untouched - the same treatment `viewportScale` and `tileScale` get for
// being dimensionless, for a different reason worth stating.
export interface LightObjectData extends ObjectPlacement {
  type: "light";
  // "point" throws in every direction - a torch, a brazier, a glowing pipe.
  // "spot" is a cone, which is what a shaft of daylight through a grate is, and
  // what puts a defined pool on the floor rather than a wash. Absent = point.
  //
  // A spot is also what a fitting on a wall wants, and for two reasons nothing
  // else here gives: it has a real DISTANCE, so `range` is a hard edge and the
  // light ends where the author says the room does, rather than a sphere
  // reaching back through the wall the lamp is bolted to; and its shadow is ONE
  // render of the scene where a point light's is a CUBE of six.
  kind?: "point" | "spot";
  // How far off the BODY's plane it sits, positive toward the camera - an offset
  // from the body's own `z`, exactly as `x` is an offset from the body's `x`.
  // Absent = a little in front of it (DEFAULT_LIGHT_Z), which is where a lamp on
  // a wall the player runs along actually is: at 0 it sits inside the wall's own
  // extrusion and lights the level from within its geometry.
  z?: number;
  // Absent = DEFAULT_LIGHT_COLOR, a warm flame.
  color?: string;
  // Candela, against the sim's metres. Absent = DEFAULT_LIGHT_INTENSITY.
  intensity?: number;
  // How far it reaches before it is cut to nothing. Absent =
  // DEFAULT_LIGHT_RANGE.
  //
  // This is the field that authors the LOOK, rather than `intensity`: falloff
  // is inverse-square, so past a couple of metres a brighter lamp is barely a
  // wider pool and the reach is what says where the lit part of the level ends.
  // It is also what makes the depth fade free - decoration 20 m behind the
  // plane and framing geometry in front of it are both outside a 6 m lamp, so
  // they go black without a single authored gradient.
  range?: number;
  // Spot only. `angle` is the cone's HALF-angle in degrees (dimensionless, so
  // unscaled); `penumbra` is how soft its edge is, 0 (hard) .. 1 (all falloff).
  angle?: number;
  penumbra?: number;
  // Spot only: the direction it points, in THIS OBJECT's own frame - x right, y
  // DOWN as everywhere else in this file, plus a z toward the camera. Not
  // normalised. Absent = straight down the level, which is what a grate overhead
  // does.
  //
  // The object's frame and not the world's, for the same reason the placement is
  // local: a lamp turned with the crate it is bolted to has to aim with it too,
  // and a direction authored in world space is a beam that swings off its own
  // fitting the moment the body turns. It composes through the object's own
  // `rot` as well, so aiming a lamp and turning it are the same act.
  dirX?: number;
  dirY?: number;
  dirZ?: number;
  // Whether the geometry between this light and a surface stops it. Absent =
  // false, and that default is a budget rather than a taste: a point light's
  // shadow is a CUBE map, six renders of the scene, where a spot's and the sun's
  // are one - so a corridor of eight shadow-casting torches costs forty-eight
  // shadow passes a frame. `LIGHT_SHADOW_BUDGET` caps how many are honoured (see
  // `render3d/lights.ts`); the rest still light the scene and simply do not
  // occlude, which is what a bounce off a wall does anyway.
  castShadow?: boolean;
  // Shadow-casting only: how close to the light a caster must be COUNTED FROM -
  // the shadow camera's near plane, a length like `range`, converted on load
  // the same way. Geometry nearer than this never enters the shadow map at all.
  //
  // It exists for the lamp whose fitting surrounds its own light: a lantern
  // with a point light inside it renders its OWN mesh into all six faces of the
  // shadow cube, which reads as acne on the fitting and the whole room dimmed
  // by the lantern's silhouette. Setting this just past the fitting's radius
  // takes the fitting out of the map - it casts nothing from ITS OWN light
  // while still casting from the sun and every other light, which
  // `castShadow: false` on the mesh could not say. Absent = the default near
  // plane (`LIGHT_SHADOW_NEAR`), sized for a lamp mounted clear of its fitting.
  shadowNear?: number;
  // Flicker depth, 0 (steady) .. 1 (guttering), as a fraction of `intensity`.
  // Absent = 0.
  //
  // RENDER-ONLY and driven by the WALL CLOCK, exactly like the force areas'
  // drifting arrows: the sim is a fixed 60 Hz and deterministic, and a light
  // that read the frame counter would be a rendering detail with a path into a
  // replay. Nothing here can reach the simulation, which is what makes it safe
  // to make it as pretty as it wants to be.
  //
  // The LIGHT flickers and the emission does not: a material is shared and
  // cached between every geometry that asked for the same surface (`assets.ts`),
  // so what can move per lamp is the light.
  flicker?: number;
}

// A named point ON a body, and the only thing a chain end ties to.
//
// It exists because a chain is the one thing in a level that is a RELATION
// rather than a part: it belongs to no single body, so it cannot nest, and it
// used to say which bodies it held by INDEX into `LevelData.bodies` plus a pair
// of world coordinates. Both halves were the odd ones out - every other
// reference in this file is body-relative, and an index means reordering the
// body list silently re-ties every chain in the level.
//
// Splitting it puts each half where it belongs. The PLACEMENT nests: an anchor
// is a scene object in its body's own frame, so it rides that body the way a
// light or a mesh does, and moving or turning the body moves its anchors with it
// rather than needing them re-derived. The RELATION stays top-level, where a
// relation belongs, and names anchors by an id that nothing about list order can
// disturb.
//
// It also makes a chain end VISIBLE: an anchor is a row in the outliner and an
// object that can be selected and dragged like any other, where before it was a
// pair of numbers reachable only by grabbing the rope that ran to it.
export interface AnchorObjectData extends ObjectPlacement {
  type: "anchor";
  // Unique across the LEVEL rather than the body - a chain names its two ends
  // with nothing else to disambiguate them. `rot` comes with the placement and
  // is carried for uniformity; an anchor is a point and nothing reads it.
  id: number;
}

export type SceneObjectData =
  | CollisionObjectData
  | GeometryObjectData
  | LightObjectData
  | AnchorObjectData;

export interface LevelBodyData {
  // What this body IS, physically. Consulted only when the body has at least one
  // collision object; a body of pure decoration or a lone light has no physics
  // for a kind to describe.
  kind: BodyKind;
  // The body's own frame: where its objects are placed from. This is the
  // AUTHORED origin and is deliberately not the engine's - see `ObjectPlacement`.
  x: number;
  y: number;
  rot: number;
  // ...and NO z. A body is a thing in the gameplay plane: where it is, what it
  // collides as and what the rope can wrap are all questions about x and y, and
  // the sim has no third axis to answer in. Depth is a fact about how something
  // is DRAWN, so it lives on the geometry objects and the lights that draw
  // (`GeometryObjectData.z`, `LightObjectData.z`) and on nothing else. A body
  // briefly carried one as "the third axis of its frame", which put a render-only
  // number on the one object in the file the renderer is not what defines.
  //
  // Collision objects are the same statement one level down: `CollisionObjectData`
  // is a placement in the plane and a shape, and has never had a z to lose.
  // Everything a body has exactly one of. They were per-entry and collapsed onto
  // a group's first member, which is a rule an author had to know and a file
  // could disagree with; here there is one of each because there is one body.
  //
  // Optional appearance (hex colour + 0..1 fill opacity). Absent = the defaults.
  color?: string;
  opacity?: number;
  // Surface friction, 0 (ice) .. 1 (rubber). Absent = DEFAULT_SURFACE_FRICTION.
  friction?: number;
  // How this surface throws back whatever lands on it: a TRAMPOLINE, authored
  // as a property of the surface rather than as a kind of body.
  //
  // `bounce` is the coefficient of restitution, 0 (dead) .. 1 (perfect), and it
  // is proportional - a body that arrives gently leaves gently. `launch` is a
  // FLOOR under the outgoing speed in pixels/s, which is what makes a pad a
  // launcher: the spring is stored in the pad, so a ball that has dropped 20 cm
  // onto it leaves as fast as one that fell the height of the level. Both are
  // read off both sides of a contact and the larger wins, so a pad states its
  // throw once and everything that meets it is thrown.
  //
  // A pair of properties rather than a `trampoline` kind, for the reason the
  // note at the top of this file gives: a kind is what a body IS and excludes
  // every other, while this composes with all of them. A static pad is the
  // ordinary case; a `rigid` one is a bouncy crate that is also shoved about and
  // falls; a `pivot` one is a paddle that swats the player away as it turns.
  // None of those is expressible as a kind, and every one of them is the same
  // two numbers on the surface.
  //
  // Absent = DEFAULT_BOUNCE / DEFAULT_LAUNCH, which is the dead surface every
  // level authored before these fields has.
  bounce?: number;
  launch?: number;
  // Force areas only: acceleration magnitude in pixels/s² (metres/s² once
  // scaled), applied along the body's own rotation — rot 0 flows right, so
  // rotating the area steers the current. Negative reverses it.
  force?: number;
  // Water areas only. `flow` is the current's SPEED in pixels/s (metres/s once
  // scaled) along the body's own rotation, aimed exactly as `force` is and
  // signed the same way; `drag` is how hard the water couples a body to it, in
  // 1/s.
  //
  // A speed and a rate, and only one of them is a length: `flow` converts
  // between the file's pixels and the sim's metres, `drag` is a reciprocal time
  // and passes through `scaleLevelData` untouched. Getting that wrong is the
  // silent kind of wrong - a rate scaled by 1/100 is water that takes twenty
  // seconds to notice a body is in it.
  flow?: number;
  drag?: number;
  // Hook-only: the hook attaches to this body and everything else passes
  // straight through it. The avatar walks and swings through it, loose debris
  // falls through it, the rope never wraps it - a background leaf the hook can
  // catch, a grate, a girder, a chandelier hung behind the level.
  //
  // Any kind may carry it, which is the whole reason it is a flag and not the
  // `anchor` kind it replaces: a static one is that retired kind exactly, and a
  // `rigid` one is the case the kind could not express - a leaf on a sprung stem
  // that still falls, still sags when the player hangs off it, and still stops
  // nothing. Absent = a body that collides, which is every body authored before
  // the field.
  passable?: boolean;
  // Rigid bodies only: mounted on a fixed frictionless bearing at the body's
  // centre of mass. The body cannot translate at all - gravity, contacts, the
  // rope and currents move it nothing - but torque spins it freely: a windmill
  // fin the player lands on or hooks onto to swing around. A flag on `rigid`
  // rather than a kind of its own for the same reason `impermeable` is a flag:
  // a pivot body IS a rigid body (mass, inertia, friction, the rope's torque
  // arm) with one degree of freedom removed, and a kind would restate all of
  // that to say one thing. Absent = an ordinary free rigid body, which is what
  // every level authored before the field contains.
  pivot?: boolean;
  // THE BEARING: where the body turns about, in the body's own authored frame -
  // the frame its objects are placed in. Absent = the centre of mass, which is
  // what every pivot authored before the fields means and the one point gravity
  // is torque-free about. Authored, the body swings about that point the way a
  // branch swings about the trunk it grows from. Both are lengths, so both
  // scale.
  //
  // Read by the two mountings that HAVE a bearing, and it is deliberately the
  // one pair of fields rather than a pair each: a pivot body's bearing and a
  // swinging body's are the same statement about the same geometry, and the
  // only difference is what turns the body about it. On a `pivot` rigid the
  // torque is real - gravity's about the bearing is what makes an unbalanced
  // body fall to hang from it, unless the torsion spring below holds it up. On
  // a `swing` static nothing has a torque at all; the sine below is the whole
  // of the motion (see `swingAmp`).
  pivotX?: number;
  pivotY?: number;
  // Pivot bodies only: a torsion return spring about the bearing, so the body
  // bends away under a load - a player hanging off it, a crate dropped on it -
  // and returns to its authored angle when the load leaves: a tree branch, a
  // springboard, a swing gate. The frequency is in Hz for the reasons
  // `springFreqX` gives: a 1/s RATE crosses `scaleLevelData` untouched, and
  // the free oscillation is mass-independent (`k = I·w²` is implied), so the
  // same figure means the same bounce whatever the branch is made of. What IS
  // mass-dependent is the response to a load, which is the half an author
  // tunes: a torque T bends it T/(I·w²) radians, so a heavy branch barely
  // notices the player and a light one plunges. 0 or absent = the bearing is
  // frictionless and free-spinning, which is every pivot authored before the
  // field. Clamped to 0..8 Hz at build like the linear spring.
  //
  // `pivotDamping` is the damping ratio, 0..1, where 1 is critically damped
  // and no overshoot survives; absent = 0.15, a few visible swings, the linear
  // spring's own default.
  pivotFreq?: number;
  pivotDamping?: number;
  // Rigid bodies only: anchor the body to its authored position through a
  // two-axis spring-damper. It sags under its own weight, sags further under a
  // load - a hanging player, a resting rock, rope tension - and springs back
  // with a visible overshoot when the load leaves: a plant whose leaf the
  // player grabs, the spring standing in for the stem bending.
  //
  // The frequencies are in Hz per axis, and a frequency rather than a stiffness
  // for two reasons. It is a 1/s RATE, so like `drag` it passes through
  // `scaleLevelData` untouched and there is nothing here that can be
  // mis-scaled. And the free oscillation is mass-INDEPENDENT (`k = m·w²` is
  // implied), so a leaf re-authored in a heavier material bounces at the same
  // rate and droops the same amount under its own weight.
  //
  // What is deliberately NOT mass-independent is the response to a load, and it
  // is the half an author tunes against the inspector's live mass readout:
  //
  //   self-weight droop = g / (2π·fy)²   - 24.8 cm at 1 Hz, 11 cm at 1.5, 6.2 cm at 2
  //   an external load F adds F / (m·(2π·fy)²)   - a 70 kg player is 686 N
  //
  // so a heavy stiff plant barely notices the player and a light whippy one
  // plunges. 0 or absent on an axis means that axis is rigidly PINNED to the
  // anchor rather than sprung to it, which is the useful degenerate case (a
  // leaf that only bobs vertically); at least one axis must carry a frequency,
  // or the author wanted `static`. Clamped to 0..8 Hz at build (8 Hz is already
  // visually rigid, and semi-implicit Euler wants w·dt < 2).
  //
  // `springDamping` is the shared damping ratio, 0..1, where 1 is critically
  // damped and no overshoot survives; absent = 0.15, a few visible swings.
  //
  // A spring body loses ROTATION, the way a pivot body loses translation - a
  // leaf on a stem translates, it does not spin - so the two are mutually
  // exclusive; a body authoring both keeps `pivot` and drops these.
  springFreqX?: number;
  springFreqY?: number;
  springDamping?: number;
  // Static bodies only: a KINEMATIC PENDULUM. The body turns about its bearing
  // (`pivotX`/`pivotY`) on a fixed sine and does so for ever - a swinging log
  // over a chasm, a censer, a wrecking ball, a blade the level times a crossing
  // against.
  //
  //   rot(t) = rot + swingAmp · sin(2π · (t / swingPeriod + swingPhase))
  //
  // Not a physical pendulum, and that is the point of it being a separate
  // mechanic rather than a preset for `pivot`. A `pivot` rigid IS the physical
  // one: gravity swings it, the player's weight on the end of it changes the
  // swing, a chain hauls it round and it eventually comes to hang. This one is
  // driven, so nothing in the level can disturb it - the player rides it, hooks
  // it, is swatted by it and shoves it in vain. It is a moving piece of the
  // LEVEL rather than a body under the level's physics, which is exactly what
  // `AnimatableBody2D` is, and what a rhythm the author is timing a jump
  // against has to be.
  //
  // `swingAmp` is the half-amplitude in RADIANS, like `rot` which it is measured
  // from: the body sweeps rot ± swingAmp, so π/6 is a 60° arc. Signed only in
  // the sense that a negative one starts the sweep the other way, which
  // `swingPhase` says better. `swingPeriod` is the seconds of one full there-
  // and-back cycle. `swingPhase` is the offset into that cycle in CYCLES rather
  // than radians, 0..1: a row of pendulums authored at 0, 0.25, 0.5, 0.75 is
  // the interleaved rhythm an author wants a quarter turn of the phrase to
  // mean, without anybody dividing by 2π. Absent or a zero amplitude or period
  // = a plain static body, which is every static authored before these fields.
  //
  // None of the three is a length. The amplitude and the phase are angles (one
  // in radians, one in cycles) and the period is a time, so all three cross
  // `scaleLevelData` untouched - the split `pivotFreq` and `drag` already make.
  //
  // Time is the sim's own (`frame · dt`), so the motion is a pure function of
  // the frame number: a replay lands the body in the same place on the same
  // frame, which is the rule every mover script keeps (see `MoverScript`).
  //
  // What BOUNDS the pair is the contact speed rather than taste: a mover's
  // surface has to cross well under about 2 cm a frame or the character sweep
  // resolves against a surface that has already crossed the avatar, and a
  // pendulum's fastest point is `swingAmp · 2π/swingPeriod · radius` - so a
  // rideable swing is a slow, heavy one, and shortening the beat or lengthening
  // the arm buys travel at exactly that number's expense. The editor's mover
  // panel reads it out live and `cli movers` `levels` measures it on every mover
  // the registry ships.
  swingAmp?: number;
  swingPeriod?: number;
  swingPhase?: number;
  // Static bodies only: a body that TRAVELS AN AUTHORED PATH - a lift, a
  // shuttling platform, a trolley going round and round a loop. The same kind
  // of mover the pendulum is and driven the same way: nothing in the level can
  // disturb it, it carries whatever rides it, and where it is on a given frame
  // is a pure function of the frame number.
  //
  // `movePath` is the route as a polyline in the body's own authored frame, and
  // THE AUTHORED POSITION IS THE FIRST WAYPOINT - so this list is the rest of
  // them, a plain shuttle is one entry, and a body with an empty or absent list
  // is a body that stands where it was drawn. Measured from the authored origin
  // rather than in world coordinates so the route rides its body: turning the
  // body turns the path, and moving it in the editor carries the path along
  // with no gesture knowing the field exists. They are lengths and scale.
  //
  // `moveClosed` says the route is connected at both ends: the last waypoint
  // runs back to the first and the body goes ROUND it in one direction for
  // ever, where an open path is travelled THERE AND BACK. A flag rather than a
  // repeated final waypoint, because the two would then have to agree to the
  // float - and it is the same statement a collision polygon makes by being a
  // loop rather than by restating its first vertex at the end.
  //
  // `moveSpeed` is how fast the body travels, in pixels/s on disk and metres/s
  // once scaled - a SPEED and not a duration, so that lengthening a route makes
  // the trip longer rather than the platform faster, which is what an author
  // means by "this lift moves at half a metre a second". Under an ease it is
  // the AVERAGE over a traverse (the ease redistributes the same trip time, so
  // `sine` peaks at π/2 of it); under `linear` it is simply the speed. 0 or
  // absent = a body that does not move, which is every static authored before
  // these fields.
  //
  // `movePhase` is where in the trip the body starts, in CYCLES like the
  // pendulum's and for the same reason - a row of lifts at 0, 0.25, 0.5, 0.75
  // is the interleaving an author means. A cycle is one lap of a closed route
  // and one THERE-AND-BACK of an open one, so 0.5 on an open path is the far
  // end, which is the useful half to be able to name.
  //
  // `moveEase` shapes the speed within a traverse and is for the OPEN path (see
  // `MoveEase`): a closed route has no ends to ease at, and easing round a lap
  // would be a body that slows down at an arbitrary point of a loop with
  // nothing there. Absent = `linear`.
  //
  // A body may swing AND move, and the two compose exactly: the path writes
  // where the body is and the pendulum writes which way it is turned, so a
  // bearing on a moving body is a pendulum hung from a travelling cart.
  movePath?: { x: number; y: number }[];
  moveClosed?: boolean;
  moveSpeed?: number;
  movePhase?: number;
  moveEase?: MoveEase;
  // What this body is made of, looks like and lights with. Order is authored
  // order, and it is what the build and both renderers walk: a body's collision
  // objects become its shapes in this order (which is what `setCompoundInertia`
  // relies on to weigh each piece by its own material), and the light budgets are
  // spent in it.
  objects: SceneObjectData[];
}

export function isCollisionObject(o: SceneObjectData): o is CollisionObjectData {
  return o.type === "collision";
}

export function isGeometryObject(o: SceneObjectData): o is GeometryObjectData {
  return o.type === "geometry";
}

export function isLightObject(o: SceneObjectData): o is LightObjectData {
  return o.type === "light";
}

export function isAnchorObject(o: SceneObjectData): o is AnchorObjectData {
  return o.type === "anchor";
}

// Does this body take part in the simulation at all? One predicate, so "is this
// drawn only" is asked the same way by the builder, both renderers and the
// editor rather than being spelled out per call site.
export function collides(b: LevelBodyData): boolean {
  return b.objects.some(isCollisionObject);
}

// ...and does it swing (see `LevelBodyData.swingAmp`)? The same sort of
// predicate and here for the same reason: the builder, the editor's inspector,
// its canvas and its outliner all have to agree about which bodies are
// pendulums, and a body that is one is built as a different ENGINE class - so a
// second opinion is a level that plays as something other than what it is drawn
// as.
//
// Static only, because a pendulum is driven rather than simulated and `rigid` is
// the kind that says the opposite. A rigid body wanting to swing about a bearing
// has `pivot`, which is the physical version of this and composes with nothing
// here. Areas are excluded by the same clause: the mover list holds bodies, and
// a `ForceArea` is not one.
//
// An amplitude or a period of zero is a body that would stand exactly still,
// which is the plain static it is easier to build - so "swinging" means both are
// authored and neither is zero, and every static authored before these fields
// answers false with nothing to read.
export function swings(b: LevelBodyData): boolean {
  return b.kind === "static" && (b.swingAmp ?? 0) !== 0 && (b.swingPeriod ?? 0) > 0;
}

// ...and does it travel a route (see `LevelBodyData.movePath`)? A waypoint and a
// speed are both needed for there to be a journey: a route with no speed is a
// body standing at its first waypoint, and a speed with no route is a body with
// nowhere to take it, and either alone is the plain static that is cheaper to
// build.
export function moves(b: LevelBodyData): boolean {
  return b.kind === "static" && (b.movePath?.length ?? 0) > 0 && (b.moveSpeed ?? 0) > 0;
}

// Is this body a scripted mover at all - either of the two ways a level can
// author one? The predicate the BUILD branches on, since both kinds are the same
// engine class and compose on one body.
export function isMover(b: LevelBodyData): boolean {
  return swings(b) || moves(b);
}

// Does this body turn about a bearing at all - `pivotX`/`pivotY`? The two
// mountings that have one are the rigid `pivot` and the swinging static, and
// they share the one pair of fields because it is the one point (see
// `LevelBodyData.pivotX`). Asked here so the loader, the save and the editor's
// canvas cannot each decide for themselves which bodies have a bearing to read.
export function hasBearing(b: LevelBodyData): boolean {
  return (b.kind === "rigid" && b.pivot === true) || swings(b);
}

// A chain strung between two bodies: the same wrap-point rope the grapple and
// the ball & chain use, authored into the level and solved every frame.
//
// It constrains the pair - a rigid body on either end hangs, swings and is
// hauled by it, while a static is infinite mass and simply holds. A foreground chain's span additionally wraps scene geometry through the
// ordinary solver, so a chain laid over a corner catches on it.
//
// Each end names an ANCHOR OBJECT (`AnchorObjectData`) by id, and that is the
// whole of the reference: which body an end is tied to is a question about where
// that anchor lives, which the body containing it already answers. A chain is
// therefore the only thing in a level that is a relation and nothing else - no
// placement of its own, because both of its points belong to bodies.
//
// It used to name a body by INDEX and carry a pair of WORLD coordinates, which
// went wrong in both halves: reordering the body list re-tied every chain, and a
// world anchor had to be re-derived against the body's surface at load rather
// than simply riding it. See `AnchorObjectData` for the split.
export interface ChainData {
  // Anchor ids. A chain whose two anchors are in the same body has nothing to
  // constrain, so the editor refuses it and the loader drops it - as it does one
  // naming an anchor that is not there, or one in a body that builds nothing.
  a: number;
  b: number;
  // Chain length. Absent = the distance between the two anchor points as
  // authored, i.e. a chain that starts exactly taut.
  length?: number;
  // Optional appearance. Absent = the renderer's own chain colours (the same
  // forged-iron links the ball & chain hangs on).
  color?: string;
}

// The retired form, as every level on disk still carries it: a body INDEX and a
// WORLD point per end. `normalizeLevelData` turns each end into an anchor object
// on the body it named, placed in that body's frame, and rewrites the chain to
// name the two anchors.
export interface LegacyChainAnchorData {
  body: number;
  x: number;
  y: number;
}

export interface LegacyChainData {
  a: LegacyChainAnchorData;
  b: LegacyChainAnchorData;
  length?: number;
  color?: string;
}

export function isLegacyChain(c: ChainData | LegacyChainData): c is LegacyChainData {
  return typeof c.a === "object";
}

// A vine: a chain of small pass-through links hanging from ONE anchor - free at
// the bottom - or spanning between TWO, that the player passes through and the
// hook grabs anywhere along (see `level/vines.ts`).
//
// It names its anchors exactly as `ChainData` names its two, and for the same
// reason - which body an end hangs from is a question about where the anchor
// lives, and the body holding that anchor already answers it. There is no world
// point anywhere: a hanging vine's free end is wherever the simulation leaves
// it, and a spanning vine's rest pose is the catenary its length and its two
// anchors imply (`level/catenary.ts`).
export interface VineData {
  // Anchor id. A vine naming an anchor that is not in the level, or one on a
  // body that builds nothing, is dropped at load - the same tolerance a chain
  // end gets.
  anchor: number;
  // Optional SECOND anchor id, making the vine a span attached at both ends
  // rather than a hanging one. The length below is still the whole arc, so a
  // span longer than the distance between its anchors sags into a catenary -
  // length and separation are deliberately decoupled. One authored SHORTER
  // than that distance is built taut at the separation itself: shorter is a
  // constraint set that cannot be satisfied at all, which never converges and
  // never sleeps (see `buildVines`).
  //
  // A vine naming a second anchor the level does not have falls back to
  // hanging rather than being dropped: unlike a chain end, one anchor is still
  // a complete vine, and losing slack beats losing the whole thing.
  anchor2?: number;
  // Metres of vine below the anchor - or, with `anchor2`, along the whole
  // span. The arc length of the whole thing, and exactly what it measures: the
  // link spacing is fitted to it rather than the other way round (see
  // `buildVines`).
  length: number;
  // Target metres between links. Absent = `DEFAULT_VINE_SPACING`. A target and
  // not a divisor - the built spacing is `length` divided by the whole number of
  // links that target implies, so the vine is exactly as long as it says.
  spacing?: number;
  // Kilograms per METRE of vine, so the same vine weighs the same whatever
  // spacing it is built at. Absent = `DEFAULT_VINE_DENSITY` (25), and anything
  // below `MIN_VINE_DENSITY` is built at that floor.
  //
  // Not a length, so `scaleLevelData` leaves it alone: it is already written per
  // metre, while everything beside it here is written in the file's pixels.
  density?: number;
  // How hard the vine is to BEND, 0..1. Absent or 0 = a rope, which is what
  // every vine was before this existed and what one still is unless it says
  // otherwise; 1 = a pole, which holds itself straight against a hooked player
  // and springs back to hanging when let go (see `level/vineBend.ts`).
  //
  // A fraction rather than a stiffness in newton-metres, for the reason the
  // environment block's own fractions are: what an author is choosing is where
  // this vine sits between the two ends they can see, and a bending modulus is a
  // number nobody can picture. Out-of-range values are clamped at load.
  //
  // Not a length, so `scaleLevelData` leaves it alone.
  //
  // On a vine with `anchor2` the ends are PINNED rather than clamped - a vine
  // lashed at both ends is hinged there, so there is no anchor clamp and the
  // stiffness lives in the joints. What it reads as is how hard the drape is
  // pressed toward straight: 0 rests in the catenary, 1 bows into the
  // flattened arc a stiff rod with excess length takes between two pins, and
  // either way the span resists kinking where it is grabbed (see
  // `level/vineBend.ts`).
  stiffness?: number;
  // Optional appearance. Absent = the renderer's own vine colours.
  color?: string;
}

// Default framing of a camera region: no offset, unchanged viewport, no lock.
// A region with all of these is a no-op, so a freshly drawn one changes nothing
// until a field is authored.
export const DEFAULT_VIEWPORT_SCALE = 1;

// Metres a player may stray from a camera path before the path lets the camera
// go, PER AXIS - the semi-axes of an ellipse around the route, read against the
// direction the player actually left in (see `pathRange`).
//
// Per axis for the same reason the lookahead is: the frame is 16:9. At
// GRAPPLE_ZOOM = 2 and PIXELS_PER_METER = 100 a 1080p frame shows 9.6 x 5.4 m
// of world - half a frame is 4.8 m across and only 2.7 m down - so a CIRCULAR
// corridor wide enough to mean anything horizontally is off the bottom of the
// screen vertically: with the old single range of 4, a player 3 m below the
// route was fully inside the corridor, the camera still centred on the route,
// and the ball 30 cm past the edge of the frame with the falloff not even
// started. The edge clamp caught it, and the clamp is a backstop rather than
// the mechanism.
//
// The pair is the frame's own 16:9 (2.25 = 4 * 9/16), so the corridor is
// screen-shaped: with the default falloff below, the worst-case vertical
// offset the band ever asks for (~2.3 m) fits the 2.7 m half-height, and
// containment stops depending on the clamp.
export const DEFAULT_PATH_RANGE_X = 4;
export const DEFAULT_PATH_RANGE_Y = 2.25;

// Metres OUTSIDE the range over which the path lets go gradually rather than
// at once - the band the path's target fades toward the plain follow through.
// Per axis and read through the same ellipse as the range, so the band is
// screen-shaped too; the outer edge of the band is the ellipse with semi-axes
// (rangeX + falloffX, rangeY + falloffY).
//
// Without it, crossing the range swaps the rule outright: the camera stops
// aiming down the route and starts aiming at the player, and the hand-off
// blend can only smooth that over, not make it small. Through this band the
// camera's target is instead interpolated from the path's (the lookahead
// point, at the path's zoom) to the plain follow (the player, at the base
// zoom), so by the band's outer edge the two targets are IDENTICAL and the
// release moves the camera by nothing - leaving the route reads as the camera
// loosening rather than changing its mind.
//
// Half the default range on each axis: enough transition to be felt, and still
// inside the screen the range is sized against.
export const DEFAULT_PATH_FALLOFF_X = 2;
export const DEFAULT_PATH_FALLOFF_Y = 1.125;

// How far ahead of the player the camera looks, PER AXIS - a quarter of the
// frame in each direction, at the 9.6 x 5.4 m the numbers above are measured on.
//
// Two numbers and not one because the frame is 16:9: there is far less screen
// above and below the player than there is either side of them, so a lead that
// is right along a corridor throws the player off the bottom of a shaft. The
// two are read as the semi-axes of an ELLIPSE the lead is taken along (see
// `pathLookahead`), so a horizontal route leads by the first, a vertical one by
// the second, and a diagonal by what fits between them.
export const DEFAULT_PATH_LOOKAHEAD_X = 2.5;
export const DEFAULT_PATH_LOOKAHEAD_Y = 1.4;

// Metres of SLACK in where the lookahead is measured from - a deadband on the
// avatar's arc length along the path, not on the camera.
//
// It exists because a swing is an oscillation along the route: the projection
// runs forward and back several times a second, and a camera that tracks it
// exactly sloshes with it. Held in a band this wide, the point the lead is
// taken from does not move at all until the avatar leaves the band, so a swing
// whose travel along the path is under this is absorbed completely.
//
// A tenth of the frame in each direction, which is a swing's worth of
// back-and-forth without eating much of the lead - and the first number to
// raise if the camera still sloshes. It costs at most this much of the
// lookahead on genuine forward travel, which is the trade: the band is what the
// camera trails by once it is being dragged.
//
// Per axis for the same reason the lookahead is (see above): the frame is 16:9,
// so a band that reads well along a corridor is most of the vertical screen in
// a shaft. The pair is resolved through the same ellipse, against the direction
// the route runs where the band currently sits.
export const DEFAULT_PATH_LOOKAHEAD_BUFFER_X = 1;
export const DEFAULT_PATH_LOOKAHEAD_BUFFER_Y = 0.55;

// A camera region: a volume that reshapes the camera while the avatar is inside
// it. Deliberately NOT a body — it has no collision, nothing wraps it and the
// sim never sees it, so it lives in its own list rather than gaining a
// pass-through `BodyKind` that every physics path would have to exclude.
//
// (A light was once argued into its own list on exactly this reasoning, and it
// was the wrong half of the argument: a light has no collision either, but it
// does have a THING IT IS ON, and that is what a body gives it. A camera region
// has nothing it is on - it is a region of space - so it stays where it is.)
//
// The camera's target point is computed per axis, so a region can pin one axis
// and keep following on the other (a vertical shaft that locks x, a side-on
// corridor that locks y):
//
//   target.x = lockX ?? (avatar.x + offsetX)
//   target.y = lockY ?? (avatar.y + offsetY)
//
// `offsetX/offsetY` therefore only apply to the axes that still follow.
export interface CameraRegionData {
  x: number;
  y: number;
  rot: number;
  shape: ShapeData;
  // Metres (pixels on disk) added to the avatar position on the axes that follow.
  offsetX?: number;
  offsetY?: number;
  // How much world the viewport shows, as a multiple of the controller's base
  // framing: 2 = twice as much world (zoomed out), 0.5 = half (zoomed in).
  // Absent = DEFAULT_VIEWPORT_SCALE.
  viewportScale?: number;
  // World coordinate to pin the camera to on that axis; absent = follow.
  lockX?: number;
  lockY?: number;
  // Seconds to hand the camera in and out of this region; absent = the
  // controller's CAMERA_BLEND_TIME.
  blend?: number;
  // Metres (pixels on disk) the avatar must travel *outside* this region before
  // it will let the camera go: the region keeps its grip anywhere within its
  // own volume grown by this much. Absent = the controller's
  // REGION_EXIT_MARGIN, which is only wide enough to stop boundary jitter.
  // Authored wider, it is what lets a swing that leaves the region and comes
  // straight back keep one camera the whole time.
  buffer?: number;
  // Per-side overrides of `buffer`, for a **rect** region only: a room is
  // rarely symmetrical, and the arc a swing takes out of one usually reaches far
  // past one wall and barely past the other, which a single number can only
  // cover by being that wide on all four sides.
  //
  // Sides are the region's own, in its local frame - left/right are ∓x and
  // top/bottom are ∓y, so a rotated region's "top" turns with it. Each falls
  // back to `buffer`, which falls back to REGION_EXIT_MARGIN, so authoring one
  // side leaves the other three exactly as they were.
  //
  // A circle has no sides and a polygon's growth is a signed-distance offset
  // with no axis to hang them on (see `pathOutlineGrown`), so both ignore these
  // and take `buffer` alone; the editor offers the fields to rects only.
  bufferLeft?: number;
  bufferRight?: number;
  bufferTop?: number;
  bufferBottom?: number;
  // Overlap tie-break: the containing region with the highest priority wins
  // (later in the list wins a tie). Absent = 0.
  priority?: number;
}

// A camera path: an authored polyline the camera rides. The player's position
// is projected onto it, the camera targets a point FURTHER ALONG it - by
// `lookaheadX` / `lookaheadY`, read as the semi-axes of an ellipse - and so the
// screen leads the player toward where they are expected to go.
//
// Deliberately NOT a region with a funny shape. A region is a closed volume
// tested by containment and a path is an open directed polyline tested by
// distance, so forcing one to impersonate the other would leave every shape
// helper (`pointInRegion`, `pathOutlineGrown`, the convexity rule) half-lying.
//
// DIRECTION IS THE DESIGN. The lookahead is always toward increasing arc
// length, so even when the player backtracks the screen keeps favouring the way
// the level wants them to go; reversing a path means reversing `verts`.
//
// If the player strays more than `range` from the polyline the path lets go and
// the camera falls back to whatever rule governs where the player actually is -
// a camera region if one contains them, the plain follow otherwise - and coming
// back within range re-acquires it. Every one of those transitions is a rule
// change, so the controller's frozen-delta hand-off blends them all for free.
// One node of a camera path: a point the route passes through, plus the cubic
// Bézier tangent handles that shape the two edges meeting at it.
//
// The handles are OFFSETS from (x, y), in the path's local frame, and both are
// optional. An edge whose two facing handles are both absent is a straight
// segment, so a path authored as a plain polyline stores nothing extra and
// flattens to exactly its own verts - which is what every path drawn before
// handles existed is, and why adding them changed no level on disk.
//
// `in` points back toward the previous node and `out` toward the next, the way
// every pen tool states them, so a smooth node is one whose two handles are
// opposite: `in = -out`.
export interface CameraPathVert {
  x: number;
  y: number;
  inX?: number;
  inY?: number;
  outX?: number;
  outY?: number;
}

export interface CameraPathData {
  x: number;
  y: number;
  rot: number;
  // Local-frame node list, >= 2 nodes, in order = direction of travel.
  // Same storage convention as ShapeData's poly: local to (x, y, rot).
  verts: CameraPathVert[];
  // Metres (pixels on disk) the player may stray from the polyline before the
  // path lets the camera go, per axis - the semi-axes of an ellipse around the
  // route, so the corridor is screen-shaped (see DEFAULT_PATH_RANGE_X/_Y,
  // which are what each falls back to).
  rangeX?: number;
  rangeY?: number;
  // How far past the range the path lets go GRADUALLY, per axis through the
  // same ellipse (see DEFAULT_PATH_FALLOFF_X/_Y). Both 0 = it lets go at the
  // range exactly, which is what it used to do.
  falloffX?: number;
  falloffY?: number;
  // The RETIRED scalar forms: one circular radius each. Folded into both axes
  // of the fields above by `scaleLevelData` (the one gate every level passes
  // through) and absent everywhere downstream of it - a level that authored a
  // circle keeps exactly the circle it authored.
  range?: number;
  falloff?: number;
  // How far ahead of the player the camera looks, per axis (see
  // DEFAULT_PATH_LOOKAHEAD_X/_Y, which are what each falls back to).
  lookaheadX?: number;
  lookaheadY?: number;
  // Slack in where that lead is measured from, so a swing does not slosh the
  // camera (see DEFAULT_PATH_LOOKAHEAD_BUFFER_X/_Y). Both 0 = track the
  // projection exactly.
  lookaheadBufferX?: number;
  lookaheadBufferY?: number;
  // Same semantics as the region fields of the same names.
  viewportScale?: number;
  blend?: number;
  // Extra release hysteresis outside `range`; absent = REGION_EXIT_MARGIN.
  buffer?: number;
  // Overlap tie-break against regions and other paths; absent = 0. Paths are
  // listed after regions in the rule set, so a path beats a region at equal
  // priority: the path is the level's primary guide and a region is the local
  // exception, which says so by outranking it.
  priority?: number;
}

// Default glyph height of a text note, in scene pixels.
export const DEFAULT_NOTE_TEXT_SIZE = 12;

// Thickness of an arrow note's pick band, in scene pixels. An arrow is a
// segment, but it is stored as a box (length × this) so it moves, rotates,
// rubber-bands and hit-tests through exactly the same code as every other item.
export const NOTE_ARROW_THICKNESS = 20;

// An authoring note: a text box or an arrow, drawn only in the level editor.
// Notes exist to record *why* a piece of geometry is placed the way it is, so
// that it is not later removed as arbitrary. Nothing in the simulation or the
// game renderer reads this list — it is the one part of a level file that is
// deliberately invisible in play.
//
// A note is always a rectangle (a circular note has no meaning), so it carries
// `w`/`h` directly rather than a ShapeData. For an arrow those are the segment's
// length and its pick band: the arrow runs along the item's local +X, from
// (-w/2, 0) to (+w/2, 0), with the head at the +X end, so `rot` aims it.
export interface NoteData {
  kind: "text" | "arrow";
  x: number;
  y: number;
  rot: number;
  w: number;
  h: number;
  // Text notes: the note body (may contain newlines). Absent on an arrow.
  text?: string;
  // Text notes: glyph height in pixels. Absent = DEFAULT_NOTE_TEXT_SIZE.
  size?: number;
}

// The light and air a level is played in (`render3d/environment.ts`). Every
// field is OPTIONAL and every default is the mood the game already had, so a
// level authored before this block looks exactly as it did.
//
// Nothing in it is a length, which is deliberate rather than lucky. A sun
// direction is a direction and the colours are colours, so the whole block passes
// through `scaleLevelData` untouched. Anything added here should keep that
// property: a fog density in 1/metres, say, is an inverse length and would have
// to be scaled the OTHER way, which is a trap worth designing out rather than
// commenting on.
export interface EnvironmentData {
  // Direction the sunlight TRAVELS, in the sim's own frame (x right, y down),
  // plus a z toward the camera. Not normalised; absent = a warm sun from the
  // upper left and slightly in front, which is the reference look's key light.
  sunX?: number;
  sunY?: number;
  sunZ?: number;
  sunColor?: string;
  // Multiplier on the sun's default strength. 0 is an overcast level lit by the
  // sky alone, which is a legitimate thing to author - and it is how a level
  // that is UNDERGROUND says so: at 0 no `DirectionalLight` is created at all,
  // so there is no shadow map to render and no sun lobe in the generated
  // environment, and what lights the level is whatever its own light objects put
  // in it. See `render3d/environment.ts`.
  sunIntensity?: number;
  // Hemisphere fill: the sky above and the bounce off whatever is below.
  skyColor?: string;
  groundColor?: string;
  fillIntensity?: number;
  // How much of the generated environment is let in. It is what gives a surface
  // something to REFLECT, so a roughness map means anything and a metal is not
  // a dark dead shape - but image-based lighting contributes diffuse as well as
  // specular, so it is also an ambient term. Absent = ENV_INTENSITY.
  //
  // An UNDERGROUND level is the reason this is authorable rather than a
  // constant. Turning the sun off is not on its own enough to make a room read
  // as underground: an environment at the default strength goes on lighting
  // every surface from every direction, so the level is dim but still lit from
  // nowhere, which is exactly the flat look a lamp is meant to replace. Dropped
  // near zero, what is left is what the level's own lights reach, and a surface
  // outside their range goes black - which is what the geometry framing a
  // corridor is supposed to do.
  envIntensity?: number;
  // A CAPTURED sky to be lit by, in place of the one the renderer generates from
  // the three colours above: a key into `HDRI_ASSETS` (`render3d/assets.ts`), or
  // absent for the generated one.
  //
  // What it buys is everything a real sky has that a vertical gradient with a
  // lobe in it does not - a horizon with a shape, a bright side and a shaded
  // side, bounce off whatever the ground is made of - and what a surface
  // reflects is the whole of that rather than a smear. It costs a download,
  // which is why it is a per-level choice and not the default: a level that
  // names none is dressed by arithmetic, exactly as it always was.
  //
  // The sun is UNCHANGED by it and stays authored above. An environment map is
  // light from every direction at once, so it has no shadow to cast; the sharp
  // shadow that says a level is outdoors is still the `DirectionalLight`, and
  // pointing it where the sky's own sun is (`hdriRotation` turns the sky, the
  // three `sun dir` fields turn the light) is what makes the two agree.
  //
  // A name this build has no asset for falls back to the generated sky rather
  // than to nothing, which is the same rule an unknown `texture` follows.
  hdri?: string;
  // Which way round the sky is, in degrees about the vertical axis. A capture
  // faces wherever the camera was pointing when it was taken, and a level is
  // built facing wherever it is built facing; this is the one number that puts
  // the sky's sun on the same side as the level's.
  hdriRotation?: number;
  // Draw the sky BEHIND the level as well as reflecting it. Off by default,
  // because the two are different jobs with different resolution needs: the
  // reflection is convolved down to a 256-wide mip chain and a 1k capture is
  // ample, while the background is magnified by the camera's narrow lens and a
  // 1k one is visibly soft. Turning it on with a bigger capture is a level
  // decision (see `assets:optimize-hdri --size`), so the flag is here and the
  // fallback is `backgroundColor` as before.
  hdriBackground?: boolean;
  // What is behind everything. Absent = the page's own background, so the 3D
  // scene's horizon and the letterbox bars agree and the frame does not read as
  // a window cut into a different game.
  backgroundColor?: string;
  // Air, thickening with distance from the CAMERA (see `render3d/environment.ts`).
  //
  // `fogAmount` is how much of the fog colour a surface `FOG_REFERENCE_DISTANCE`
  // from the camera takes on - 20 m, about where the gameplay plane sits - so 0
  // (and absent) is no fog at all, which is what every level authored before
  // these fields gets. Everything nearer takes less and everything further
  // takes more, on the exponential law that says so.
  //
  // It is a FRACTION rather than a density, and that is the point rather than a
  // simplification. A density is in 1/metres - an inverse length, the one thing
  // this block must not contain (see the note above it), since it would have to
  // be scaled the opposite way from every other number in the file. A fraction
  // passes through `scaleLevelData` untouched like the colours and the sun
  // direction, and the metres it is measured over live once, in the renderer.
  fogAmount?: number;
  // Absent = `backgroundColor`, which is what aerial perspective means: distance
  // fades into whatever is behind everything, rather than into a second colour
  // that has to be kept in step with it by hand.
  fogColor?: string;
}

export interface LevelData {
  player: { x: number; y: number; radius: number };
  bodies: LevelBodyData[];
  // Camera-behaviour volumes (see CameraRegionData). Absent = the camera just
  // follows the avatar, which is what every level authored before this field did.
  cameraRegions?: CameraRegionData[];
  // Camera paths (see CameraPathData). Absent = the rule set is regions-only,
  // which is every level authored before this field.
  cameraPaths?: CameraPathData[];
  // Editor-only annotations (see NoteData). Never read by the sim or the game
  // renderer, so a level plays identically with or without them.
  notes?: NoteData[];
  // Chains strung between pairs of bodies (see ChainData). Absent = a level with
  // no chains, which is every level authored before this field.
  chains?: ChainData[];
  // Vines hanging from single anchors (see VineData). Absent = a level with no
  // vines, which is every level authored before this field.
  vines?: VineData[];
  // Light and air for the 3D renderer (see EnvironmentData). Render-only, and
  // absent means the defaults, so the 2D renderer and every existing level are
  // untouched by it.
  environment?: EnvironmentData;
}

// ---------------------------------------------------------------------------
// The retired flat form
// ---------------------------------------------------------------------------
//
// What levels on disk (and the generated `levelData.ts`) still carry, kept here
// because reading it is a permanent obligation and not a transitional one: the
// Godot extractor writes it, so the flat form is still an INPUT to this project
// even after every hand-authored level has been rewritten.
//
// `normalizeLevelData` is the single gate, and it runs inside `scaleLevelData`
// rather than at each loader, because that is the one thing a level cannot reach
// the sim (or the editor) without passing through - the conversion between the
// pixels on disk and the metres everything downstream is written in. A migration
// a caller can forget is a migration that is missing wherever a new caller is
// added, and every failure here is silent: a hook-proof wall builds as an
// ordinary static and starts catching the hook it has repelled since the level
// was designed, a dropped background list is decoration that vanishes with
// nothing to report, and a dropped light list is a level that goes dark.

// The retired per-entry visual. Its seven LIGHT-shaped fields are read here and
// turned into a light object; the three APPEARANCE ones carry straight over.
export interface LegacyVisualData {
  kind?: "auto" | "mesh" | "none";
  mesh?: string;
  offsetX?: number;
  offsetY?: number;
  offsetZ?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  scale?: number;
  depth?: number;
  texture?: string;
  tileScale?: number;
  tileOffsetX?: number;
  tileOffsetY?: number;
  bevel?: number;
  emissive?: string;
  emissiveIntensity?: number;
  // The seven that described a light in disguise.
  emissiveRange?: number;
  emissiveTexture?: string;
  emissiveDirX?: number;
  emissiveDirY?: number;
  emissiveDirZ?: number;
  emissiveAngle?: number;
  emissivePenumbra?: number;
  emissiveShadow?: boolean;
  emissiveFlicker?: number;
}

export interface LegacyBodyData {
  kind: BodyKind | typeof LEGACY_IMPERMEABLE;
  impermeable?: boolean;
  collision?: boolean;
  x: number;
  y: number;
  rot: number;
  shape: ShapeData;
  color?: string;
  opacity?: number;
  friction?: number;
  material?: string;
  thickness?: number;
  force?: number;
  flow?: number;
  drag?: number;
  group?: string;
  visual?: LegacyVisualData;
}

// The retired background list, older still: decoration before it was a flag, and
// a flag before it was the absence of a collision object.
export interface LegacyBackgroundData {
  x: number;
  y: number;
  rot: number;
  shape: ShapeData;
  color?: string;
  opacity?: number;
  group?: string;
  visual?: LegacyVisualData;
}

// The retired top-level light list: a light with no parent, which is what made a
// lamp two authored things that could disagree.
export interface LegacyLightData {
  kind?: "point" | "spot";
  x: number;
  y: number;
  z?: number;
  color?: string;
  intensity?: number;
  range?: number;
  angle?: number;
  penumbra?: number;
  dirX?: number;
  dirY?: number;
  dirZ?: number;
  castShadow?: boolean;
  shadowNear?: number;
  flicker?: number;
}

// Appearance a retired background panel is migrated with: an opaque dark slate,
// deliberately distinct from the geometry grey so a backdrop does not read as a
// wall. It was the default of a list that no longer exists, so it is written out
// EXPLICITLY by the migration rather than left to a default - the body defaults
// are the grey, and a decoration silently changing colour on load is exactly the
// kind of migration that looks like a rendering bug.
export const LEGACY_BACKGROUND_COLOR = "#313244";
export const LEGACY_BACKGROUND_OPACITY = 1;

// What a file may contain: either form, in any mixture. Everything downstream of
// `normalizeLevelData` sees `LevelData` and none of this.
export interface RawLevelData {
  player: { x: number; y: number; radius: number };
  bodies: (LevelBodyData | LegacyBodyData)[];
  backgrounds?: LegacyBackgroundData[];
  lights?: LegacyLightData[];
  cameraRegions?: CameraRegionData[];
  cameraPaths?: CameraPathData[];
  notes?: NoteData[];
  chains?: (ChainData | LegacyChainData)[];
  vines?: VineData[];
  environment?: EnvironmentData;
}

function isLegacyBody(b: LevelBodyData | LegacyBodyData): b is LegacyBodyData {
  return !Array.isArray((b as LevelBodyData).objects);
}

// The appearance half of a retired visual, as a geometry object.
//
// A retired entry drew ONE shape, whether it collided or not, so that shape is
// what the geometry object is - stated outright rather than borrowed from the
// collision object beside it. `depth` and `texture` fall back to what the entry
// collided as (`thickness`, `material`), which is what the extruded outline used
// to read off it: the migration is where that reading happens, once, instead of
// on every frame for ever.
function geometryFromLegacy(
  v: LegacyVisualData | undefined,
  shape: ShapeData | undefined,
  decorZ: number | undefined,
  color: string | undefined,
  opacity: number | undefined,
  solid?: { thickness?: number; material?: string },
): GeometryObjectData {
  return {
    type: "geometry",
    ...(v?.depth === undefined && solid?.thickness !== undefined
      ? { depth: solid.thickness }
      : {}),
    ...(v?.texture === undefined && solid?.material !== undefined
      ? { texture: solid.material }
      : {}),
    // The retired `auto` is what a primitive is now called, and it is the
    // default either way. `none` never reaches here - a legacy entry that drew
    // nothing produces no geometry object at all (`objectsOfLegacy`), which is
    // how that state is spelt now.
    ...(v?.kind === "mesh" ? { kind: "mesh" as const } : {}),
    ...(v?.mesh !== undefined ? { mesh: v.mesh } : {}),
    ...(shape !== undefined ? { shape } : {}),
    // The retired visual placed itself in the BODY's frame with its own
    // `offset*`/`rot*`; the object placement it becomes says the same thing in
    // the fields every object kind shares.
    ...(v?.offsetX !== undefined ? { x: v.offsetX } : {}),
    ...(v?.offsetY !== undefined ? { y: v.offsetY } : {}),
    ...(v?.rotZ !== undefined ? { rot: v.rotZ } : {}),
    ...(v?.offsetZ !== undefined ? { z: v.offsetZ } : decorZ !== undefined ? { z: decorZ } : {}),
    ...(v?.rotX !== undefined ? { rotX: v.rotX } : {}),
    ...(v?.rotY !== undefined ? { rotY: v.rotY } : {}),
    ...(v?.scale !== undefined ? { scale: v.scale } : {}),
    ...(v?.depth !== undefined ? { depth: v.depth } : {}),
    ...(v?.bevel !== undefined ? { bevel: v.bevel } : {}),
    ...(v?.texture !== undefined ? { texture: v.texture } : {}),
    ...(v?.tileScale !== undefined ? { tileScale: v.tileScale } : {}),
    ...(v?.tileOffsetX !== undefined ? { tileOffsetX: v.tileOffsetX } : {}),
    ...(v?.tileOffsetY !== undefined ? { tileOffsetY: v.tileOffsetY } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
    ...(v?.emissive !== undefined ? { emissive: v.emissive } : {}),
    ...(v?.emissiveIntensity !== undefined ? { emissiveIntensity: v.emissiveIntensity } : {}),
    ...(v?.emissiveTexture !== undefined ? { emissiveTexture: v.emissiveTexture } : {}),
  };
}

// The DERIVED light a glowing shape used to throw, written out as the light
// object it always was. Only a shape that actually emitted and actually reached
// gets one - `emissiveRange: 0` was the opt-out, and it stays one by producing no
// light rather than by a field that says so.
//
// It is a `spot` because that is what the derived light was, aimed by the same
// defaults: -z, into the level where the geometry is. What is NOT reproduced is
// the two rules that made the derived light guess - the reach derived from the
// glow as a square root, and the source pushed clear of the emitting face - and
// both are deliberate. A migrated lamp gets its reach written out explicitly, so
// a number that used to be inferred is now visible and adjustable; and the
// stand-off is `DEFAULT_LIGHT_Z`, since an object placement is a place rather
// than a thing to be nudged off a bounding box that is not known until a GLB
// arrives.
function lightFromLegacyEmissive(v: LegacyVisualData | undefined): LightObjectData | null {
  if (!v?.emissive) return null;
  const glow = Math.max(0, v.emissiveIntensity ?? 1);
  if (glow <= 0) return null;
  const range = v.emissiveRange !== undefined ? Math.max(0, v.emissiveRange) : LEGACY_EMISSIVE_RANGE * Math.sqrt(glow);
  if (range <= 0) return null;
  return {
    type: "light",
    kind: "spot",
    ...(v.offsetX !== undefined ? { x: v.offsetX } : {}),
    ...(v.offsetY !== undefined ? { y: v.offsetY } : {}),
    color: v.emissive,
    intensity: glow * LEGACY_EMISSIVE_GAIN,
    range,
    angle: v.emissiveAngle ?? LEGACY_EMISSIVE_ANGLE,
    penumbra: v.emissivePenumbra ?? LEGACY_EMISSIVE_PENUMBRA,
    // dirY and dirZ are written even at zero, because a LIGHT object's defaults
    // are not the retired emissive's: absent `dirY` means 1 (down the level) and
    // absent `dirZ` means 0, where a glowing shape aimed (0, 0, -1) into it. dirX
    // defaults to 0 on both sides, so writing it would be noise.
    ...(v.emissiveDirX ? { dirX: v.emissiveDirX } : {}),
    dirY: v.emissiveDirY ?? 0,
    dirZ: v.emissiveDirZ ?? -1,
    ...(v.emissiveShadow === true ? { castShadow: true } : {}),
    ...(v.emissiveFlicker !== undefined ? { flicker: v.emissiveFlicker } : {}),
  };
}

// The retired derived light's own constants, frozen here rather than imported
// from `render3d/lights.ts`. A migration has to reproduce what the OLD build
// did, and a constant the new renderer is still free to re-tune is not that: if
// `DEFAULT_LIGHT_RANGE` is changed tomorrow, every level migrated the day after
// would come out differently from every level migrated today.
//
// They are in scene PIXELS, because a migration runs on the file's own units.
const LEGACY_EMISSIVE_GAIN = 14;
const LEGACY_EMISSIVE_RANGE = 600;
const LEGACY_EMISSIVE_ANGLE = 55;
const LEGACY_EMISSIVE_PENUMBRA = 0.6;

// Where decoration sat when its visual said nothing, in scene pixels: just
// behind the gameplay plane. Written out by the migration rather than left to a
// default, since the default now belongs to a body with no collision objects and
// a migrated panel should not depend on that rule staying put.
const LEGACY_DECOR_Z = -35;

// Fold every retired form into what it now is. Idempotent, and a no-op for a
// level already in the nested form, so it costs nothing to run on the way out as
// well as on the way in.
//
// THE ORDERING IS LOAD-BEARING and it is what makes the migration bit-identical.
// A group's body is emitted where its FIRST member sat, which is exactly where
// `groupRuns` used to emit it, so `World.add` stamps the same `buildIndex` on
// the same body and every recorded replay - which names bodies by build order -
// replays unchanged. Panels are APPENDED after the bodies for the same reason
// they always were, and the retired light list after those, since neither builds
// anything and neither can therefore move a build index.
//
// The migrated body's own origin is (0, 0, 0) and its objects keep the world
// placements the flat entries carried. That is not laziness, it is the only
// choice that is bit-identical: `buildLevelBodies` puts the engine origin at the
// combined centre of mass and takes each piece's offset from there, so an
// authored origin of zero leaves that arithmetic reading exactly the numbers it
// read before, down to the last bit. Re-origining a migrated body onto its
// centre of mass would round every offset through a rotation and back.
export function normalizeLevelData(raw: RawLevelData): LevelData {
  const legacyBodies = raw.bodies.some(isLegacyBody);
  const panels = raw.backgrounds ?? [];
  const lights = raw.lights ?? [];
  if (!legacyBodies && panels.length === 0 && lights.length === 0) {
    return finish(raw, raw.bodies as LevelBodyData[], (i) => i);
  }

  const bodies: LevelBodyData[] = [];
  // Where each retired entry index ended up, so `ChainData` can be renumbered:
  // several entries of one group became one body, which is what a group always
  // meant and what the chain list could not say.
  const bodyOfEntry: number[] = raw.bodies.map(() => -1);

  // The retired background list is folded into the ENTRIES first, as the
  // non-colliding bodies it was already migrated to before this format existed,
  // so there is one grouping pass rather than two.
  //
  // It has to be one pass, because a panel carries the same `group` tag a body
  // does and a panel welded onto a crate is exactly what the tag was for: a
  // backdrop swinging with the thing it decorates. Migrating panels separately
  // drops that tag on the floor, and the failure is silent - the paint simply
  // stops following.
  //
  // APPENDED rather than prepended, which is the rule the old migration had and
  // for the reason it had it: a run is emitted where its FIRST member sits, so a
  // panel joining an existing group cannot move that group's body, and a panel
  // joining nothing lands after every body that builds. Either way no build
  // index moves and no recorded replay is renumbered.
  const entries: (LevelBodyData | LegacyBodyData)[] = [
    ...raw.bodies,
    ...panels.map(
      (p): LegacyBodyData => ({
        // A kind is a statement about physics and a panel has none; `static` is
        // what it reads as everywhere it is asked, and being non-colliding is
        // what stops anything asking.
        kind: "static",
        collision: false,
        x: p.x,
        y: p.y,
        rot: p.rot,
        shape: p.shape,
        // Written out rather than left to the body defaults: the panel list had
        // its own, and decoration that quietly turns grey on load is a migration
        // that looks exactly like a rendering bug.
        color: p.color ?? LEGACY_BACKGROUND_COLOR,
        opacity: p.opacity ?? LEGACY_BACKGROUND_OPACITY,
        ...(p.group !== undefined ? { group: p.group } : {}),
        ...(p.visual !== undefined ? { visual: p.visual } : {}),
      }),
    ),
  ];

  // The retired grouping, resolved in one pass BEFORE anything is emitted. It
  // has to be, because a group's body-level properties come from its first
  // COLLIDING member rather than simply its first (`groupLead`): a backdrop
  // welded onto a crate must not paint the crate its own colour, and the
  // backdrop may perfectly well be listed first. An emit-as-you-go loop reads
  // the wrong entry and has no way to go back.
  for (const run of legacyRuns(entries)) {
    const index = bodies.length;
    // Only the original entries are numbered: `ChainData` indexes those, and a
    // panel folded in above was never nameable by a chain.
    for (const i of run) if (i < raw.bodies.length) bodyOfEntry[i] = index;
    const members = run.map((i) => entries[i]!);
    const first = members[0]!;
    if (!isLegacyBody(first)) {
      // Already in the nested form. A run of one, by construction: only a
      // retired `group` tag can put two entries in a run.
      bodies.push(first);
      continue;
    }
    const legacy = members as LegacyBodyData[];
    const lead = legacy.find((e) => e.collision !== false) ?? first;
    // `withGeometryPrimitives` here and nowhere else: a legacy entry is exactly
    // a body authored when a collision shape drew itself, so this is where that
    // default has to be written down. A body already in the nested form (above)
    // is left with the objects it has, however few.
    bodies.push(withGeometryPrimitives({
      // A retired `impermeable` KIND is a static whose shapes are hook-proof;
      // `objectsOfLegacy` has already put the flag on the collision object.
      kind: lead.kind === LEGACY_IMPERMEABLE ? "static" : lead.kind,
      x: 0,
      y: 0,
      rot: 0,
      // Only a body with something SOLID in it has a body-level fill: a body of
      // pure decoration has its colour on the geometry object itself, and
      // writing it in both places is a second copy that nothing reads and that
      // the editor would drop on the first save.
      ...(lead.collision !== false
        ? {
            ...(lead.color !== undefined ? { color: lead.color } : {}),
            ...(lead.opacity !== undefined ? { opacity: lead.opacity } : {}),
            ...(lead.friction !== undefined ? { friction: lead.friction } : {}),
            ...(lead.force !== undefined ? { force: lead.force } : {}),
            ...(lead.flow !== undefined ? { flow: lead.flow } : {}),
            ...(lead.drag !== undefined ? { drag: lead.drag } : {}),
          }
        : {}),
      objects: legacy.flatMap(objectsOfLegacy),
    }));
  }

  // The retired light list: each becomes a body containing nothing but a light,
  // which is what a light with no visible source is. It builds no engine body,
  // so appending them cannot renumber anything.
  for (const l of lights) {
    bodies.push({
      kind: "static",
      x: l.x,
      y: l.y,
      rot: 0,
      objects: [
        {
          type: "light",
          ...(l.kind !== undefined ? { kind: l.kind } : {}),
          ...(l.z !== undefined ? { z: l.z } : {}),
          ...(l.color !== undefined ? { color: l.color } : {}),
          ...(l.intensity !== undefined ? { intensity: l.intensity } : {}),
          ...(l.range !== undefined ? { range: l.range } : {}),
          ...(l.angle !== undefined ? { angle: l.angle } : {}),
          ...(l.penumbra !== undefined ? { penumbra: l.penumbra } : {}),
          ...(l.dirX !== undefined ? { dirX: l.dirX } : {}),
          ...(l.dirY !== undefined ? { dirY: l.dirY } : {}),
          ...(l.dirZ !== undefined ? { dirZ: l.dirZ } : {}),
          ...(l.castShadow !== undefined ? { castShadow: l.castShadow } : {}),
          ...(l.shadowNear !== undefined ? { shadowNear: l.shadowNear } : {}),
          ...(l.flicker !== undefined ? { flicker: l.flicker } : {}),
        },
      ],
    });
  }

  // A retired chain names its bodies by ENTRY index, and several entries of one
  // group became one body - which is what a group always meant and what the chain
  // list could not say - so the ends are renumbered onto the emitted bodies
  // before they are turned into anchors.
  return finish(raw, bodies, (i) => bodyOfEntry[i] ?? i);
}

// The gate every level passes through however it got here, and the one place the
// result is assembled. It is a migration from a default that no longer exists,
// and it has to run on a file already in the nested form - a level saved
// yesterday is exactly as legacy as one saved last year, in the only sense that
// matters.
//
// What is NOT here any more is the geometry twin. It used to run over every body
// on every load, which made "a body with collision and no geometry" a state a
// file could not hold: drawing a bare collision shape, saving and loading it back
// returned a dressing nobody asked for. It now runs where the default it migrates
// actually applied - on a body converted from a LEGACY entry, in
// `normalizeLevelData` - so a body authored under the current rule keeps the
// objects it was authored with.
function finish(
  raw: RawLevelData,
  bodies: LevelBodyData[],
  bodyOf: (entry: number) => number,
): LevelData {
  const added = new Map<number, AnchorObjectData[]>();
  const chains = withChainAnchors(bodies, added, raw.chains, bodyOf);
  // The anchors are folded in by COPYING the bodies that gained one. Pushing
  // them into `body.objects` instead reaches back through `raw` and edits the
  // caller's level in place: for a file already in the nested form the bodies
  // here ARE the input's, so a second load found the anchors of the first and
  // added another set beside them.
  const out = bodies.map((b, i) => {
    const extra = added.get(i);
    const withAnchors = extra ? { ...b, objects: [...b.objects, ...extra] } : b;
    return withoutConflictingSpring(withAnchors);
  });
  const { backgrounds: _panels, lights: _lights, chains: _chains, ...rest } = raw;
  return { ...rest, bodies: out, ...(chains ? { chains } : {}) };
}

// `pivot` and a spring are mutually exclusive (see `LevelBodyData.springFreqX`):
// a body that could neither translate nor rotate is not a thing to author. The
// tie is broken HERE rather than left to the build, so what the editor loads,
// what the sim builds and what a level file round-trips to all agree on which
// half survived - and it is broken toward `pivot`, deterministically and
// documented, because that is the field a level could already contain.
//
// Written to return the body UNCHANGED unless it actually holds both, so the
// overwhelmingly common load - no spring anywhere - allocates nothing and every
// existing level is the same object it went in as.
function withoutConflictingSpring(b: LevelBodyData): LevelBodyData {
  if (b.pivot !== true) return b;
  if (b.springFreqX === undefined && b.springFreqY === undefined && b.springDamping === undefined) {
    return b;
  }
  const { springFreqX: _x, springFreqY: _y, springDamping: _z, ...rest } = b;
  return rest;
}

// Retired chain ends into anchor objects. Each end named a body by index and a
// point in WORLD space; it becomes an anchor object on that body, placed in the
// body's own frame, and the chain is rewritten to name the two anchors by id.
//
// The anchors it creates are collected into `added`, keyed by body index, for
// the caller to fold in - see `finish`, and the bug that rule is written
// against. They belong at the END of their body's object list: a body's
// collision objects build its shapes in authored order, an anchor is not one of
// them, and appending is what keeps the world the sim sees bit-identical.
//
// A chain whose body index is out of range keeps a dangling id, which
// `buildSceneChains` drops exactly as it dropped an out-of-range index.
function withChainAnchors(
  bodies: readonly LevelBodyData[],
  added: Map<number, AnchorObjectData[]>,
  chains: (ChainData | LegacyChainData)[] | undefined,
  bodyOf: (entry: number) => number,
): ChainData[] | undefined {
  if (!chains) return undefined;
  if (!chains.some(isLegacyChain)) return chains as ChainData[];
  // Ids continue past whatever the file already uses, so a level part-way
  // through the migration (hand-edited, or half-converted) cannot collide.
  let next = 1;
  for (const b of bodies) {
    for (const o of b.objects) if (isAnchorObject(o) && o.id >= next) next = o.id + 1;
  }
  const anchorFor = (end: LegacyChainAnchorData): number => {
    const index = bodyOf(end.body);
    const body = bodies[index];
    const id = next++;
    if (!body) return id;
    // Into the body's OWN frame, which is what every other object's placement is
    // measured in. The inverse of `worldPlacement`, and deliberately written as
    // its mirror image so the two cannot drift.
    const cos = Math.cos(-body.rot);
    const sin = Math.sin(-body.rot);
    const dx = end.x - body.x;
    const dy = end.y - body.y;
    const x = dx * cos - dy * sin;
    const y = dx * sin + dy * cos;
    const list = added.get(index) ?? [];
    list.push({
      type: "anchor",
      id,
      // Absent means zero, which is the rule every placement here is written
      // under: an anchor on the body's own origin says nothing at all.
      ...(x !== 0 ? { x } : {}),
      ...(y !== 0 ? { y } : {}),
    });
    added.set(index, list);
    return id;
  };
  return chains.map((c) =>
    isLegacyChain(c)
      ? {
          a: anchorFor(c.a),
          b: anchorFor(c.b),
          ...(c.length !== undefined ? { length: c.length } : {}),
          ...(c.color !== undefined ? { color: c.color } : {}),
        }
      : c,
  );
}

// Drawing is a GEOMETRY object's job, and collision is a collision object's. A
// file written before that split has bodies whose outlines were drawn BECAUSE
// they collided, so they get the geometry objects that say so: one PRIMITIVE per
// collision object, standing exactly where that piece stands, in its form, as
// thick as its `thickness` and wearing the surface its `material` names. The
// level looks exactly as it did and the file now says why.
//
// The outline IS copied, which is the change decoupling made and the cost it
// carries: a second copy is a second thing to resize, and the two drift apart
// the first time only one of them is. That is the point - a body may now look
// like something other than what it collides as - and the editor makes the pair
// together on a draw so the common case still needs one gesture.
//
// Applied ONLY to a body converted from a legacy entry (see `finish`), which is
// what stops it inventing a look for a body deliberately authored without one.
// Idempotent all the same: the legacy path is reached by a file that still
// carries retired panels or lights, and a run through it must not stack twins.
function withGeometryPrimitives(body: LevelBodyData): LevelBodyData {
  const collisions = body.objects.filter(isCollisionObject);
  if (!collisions.length) return body;
  // ANY geometry object at all is the body saying how it looks, and that answer
  // stands. A lamp whose collision box carries an authored mesh looks like the
  // lamp; adding an extrusion of the box beside it draws a grey brick inside the
  // fitting - visible in play, invisible in the editor, and exactly the kind of
  // thing a migration should never invent. Only a body that says NOTHING about
  // its appearance is given the objects stating what it used to look like.
  if (body.objects.some(isGeometryObject)) return body;
  return { ...body, objects: [...body.objects, ...collisions.map(primitiveOf)] };
}

// The primitive a collision object used to be drawn as: its form, at its
// placement, with the depth and surface the extrusion read off it. The one place
// that reading is written down, shared by the legacy migration here and by the
// editor's own draw (`geometryTwinFor`), so a body migrated from disk and a body
// drawn in the editor start out saying the same thing.
export function primitiveOf(c: CollisionObjectData): GeometryObjectData {
  return {
    type: "geometry",
    shape: c.shape,
    ...(c.x !== undefined ? { x: c.x } : {}),
    ...(c.y !== undefined ? { y: c.y } : {}),
    ...(c.rot !== undefined ? { rot: c.rot } : {}),
    ...(c.thickness !== undefined ? { depth: c.thickness } : {}),
    ...(c.material !== undefined ? { texture: c.material } : {}),
  };
}

// The retired `group` tag was geometry-only: an area that carried one was built
// as its own body instead, because an area was single-shape everywhere it was
// used and a grouped one would have acted through its first piece alone.
// `World.integrate` iterates an area's shapes now (`areaOverlapsBody`, which a
// decomposed concave area needs), but this is a MIGRATION and reproduces what
// the old loader did whatever the engine has since learned - every recorded
// replay names bodies by the build order it produces.
function legacyGroupable(kind: LegacyBodyData["kind"]): boolean {
  return kind !== "killzone" && kind !== "force";
}

// The retired entries as the runs that each became one body, in the order the
// runs' FIRST members sit. That ordering is the whole of what keeps this
// migration bit-identical: `World.add` stamps a build index in this order and
// every recorded replay names bodies by it, so a run emitted anywhere else
// renumbers the world.
function legacyRuns(bodies: readonly (LevelBodyData | LegacyBodyData)[]): number[][] {
  const runs: number[][] = [];
  const byTag = new Map<string, number[]>();
  bodies.forEach((b, i) => {
    if (!isLegacyBody(b)) {
      runs.push([i]);
      return;
    }
    // A non-colliding entry's own kind is not consulted: a kind is a statement
    // about physics and decoration makes none, so a backdrop a level happens to
    // leave marked `force` still rides the crate it was welded to.
    const tag =
      b.group !== undefined && (b.collision === false || legacyGroupable(b.kind))
        ? b.group
        : undefined;
    if (tag === undefined) {
      runs.push([i]);
      return;
    }
    const existing = byTag.get(tag);
    if (existing) {
      existing.push(i);
      return;
    }
    const run = [i];
    byTag.set(tag, run);
    runs.push(run);
  });
  return runs;
}

// One retired entry's objects, in the order the renderers walk them: what it
// collides as first, then what it looks like, then what it lights with.
function objectsOfLegacy(b: LegacyBodyData): SceneObjectData[] {
  const drawn = b.collision === false;
  const objects: SceneObjectData[] = [];
  if (!drawn) {
    objects.push({
      type: "collision",
      shape: b.shape,
      ...(b.impermeable === true || b.kind === LEGACY_IMPERMEABLE
        ? { impermeable: true }
        : {}),
      ...(b.material !== undefined ? { material: b.material } : {}),
      ...(b.thickness !== undefined ? { thickness: b.thickness } : {}),
    });
  }
  // The entry's own shape, either way: a colliding entry's geometry is the
  // outline it drew because it collided, and decoration was only ever the shape.
  // Written only when the entry authored a visual at all - a plain wall gets the
  // one `withGeometryPrimitives` states, and a `none` visual is a wall that drew
  // nothing, which is now spelt as having no geometry object rather than as a
  // kind that means "ignore me".
  //
  // Decoration carries its OWN fill and not the body's, which is the rule
  // `syncGroupProps` had for exactly the reason material and thickness were per
  // entry: a backdrop is authored to sit behind the geometry, so painting it the
  // lead shape's colour is precisely wrong.
  if ((b.visual !== undefined && b.visual.kind !== "none") || drawn) {
    objects.push(
      geometryFromLegacy(
        b.visual,
        b.shape,
        drawn ? LEGACY_DECOR_Z : undefined,
        drawn ? b.color : undefined,
        drawn ? b.opacity : undefined,
        drawn ? undefined : { thickness: b.thickness, material: b.material },
      ),
    );
  }
  const light = lightFromLegacyEmissive(b.visual);
  if (light) objects.push(light);
  return objects.map((o) => placeInWorld(o, b.x, b.y, b.rot));
}

// Push a retired entry's WORLD placement onto the object, since the migrated
// body's own origin is zero. An object placement composes as
// `body ∘ object`, and the body is the identity here, so the object simply
// carries what the entry carried - with any offset the retired visual had
// already stated rotated into the entry's own frame first, exactly as
// `mountVisual` composed it.
function placeInWorld(
  o: SceneObjectData,
  x: number,
  y: number,
  rot: number,
): SceneObjectData {
  const lx = o.x ?? 0;
  const ly = o.y ?? 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return {
    ...o,
    x: x + lx * cos - ly * sin,
    y: y + lx * sin + ly * cos,
    rot: rot + (o.rot ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

// Scale every length by `factor` (pass PX = 1 / PIXELS_PER_METER on load, or
// PIXELS_PER_METER on save), leaving rotations and kinds untouched. `force` is
// an acceleration (length/s²) so it scales too; `friction` is dimensionless and
// passes through. Returns a fresh copy so the caller's data stays pristine.
// Every dimension of a shape is a length, whichever kind it is — a polygon's
// vertices included. One scaler for all three, so a new kind cannot be missed by
// one of the lists that carry shapes.
function scaleShape(s: ShapeData, factor: number): ShapeData {
  if (s.kind === "rect") return { kind: "rect", w: s.w * factor, h: s.h * factor };
  if (s.kind === "circle") return { kind: "circle", r: s.r * factor };
  return { kind: "poly", verts: s.verts.map((v) => ({ x: v.x * factor, y: v.y * factor })) };
}

// One scene object's lengths, and only its lengths.
//
// It rebuilds the object field by field like everything else here, which is what
// makes a forgotten field a silent loss rather than a type error - hence the
// round-trip case in `cli render3d`, which is the thing that actually holds this
// function to its list.
export function scaleObject(o: SceneObjectData, factor: number): SceneObjectData {
  // The placement is a length on both axes and an angle on the third, for every
  // object kind, which is most of the reason placement is one shared shape.
  const placed = {
    ...(o.x !== undefined ? { x: o.x * factor } : {}),
    ...(o.y !== undefined ? { y: o.y * factor } : {}),
    ...(o.rot !== undefined ? { rot: o.rot } : {}),
  };
  if (o.type === "collision") {
    return {
      type: "collision",
      ...placed,
      shape: scaleShape(o.shape, factor),
      ...(o.impermeable !== undefined ? { impermeable: o.impermeable } : {}),
      // A material is a name and scales by nothing; a thickness is a length in
      // z and scales exactly as the two lengths in the plane do.
      ...(o.material !== undefined ? { material: o.material } : {}),
      ...(o.thickness !== undefined ? { thickness: o.thickness * factor } : {}),
    };
  }
  // An anchor is a placement and an id, and an id is not a length.
  if (o.type === "anchor") return { type: "anchor", id: o.id, ...placed };
  if (o.type === "light") {
    return {
      type: "light",
      ...placed,
      ...(o.kind !== undefined ? { kind: o.kind } : {}),
      ...(o.z !== undefined ? { z: o.z * factor } : {}),
      ...(o.color !== undefined ? { color: o.color } : {}),
      // NOT a length - candela against the sim's metres, and it would have to
      // scale as the SQUARE of the factor if it were converted at all. See
      // `LightObjectData`.
      ...(o.intensity !== undefined ? { intensity: o.intensity } : {}),
      ...(o.range !== undefined ? { range: o.range * factor } : {}),
      // A cone angle in degrees, a 0..1 softness, a direction and a flag. None
      // of them is a length.
      ...(o.angle !== undefined ? { angle: o.angle } : {}),
      ...(o.penumbra !== undefined ? { penumbra: o.penumbra } : {}),
      ...(o.dirX !== undefined ? { dirX: o.dirX } : {}),
      ...(o.dirY !== undefined ? { dirY: o.dirY } : {}),
      ...(o.dirZ !== undefined ? { dirZ: o.dirZ } : {}),
      ...(o.castShadow !== undefined ? { castShadow: o.castShadow } : {}),
      // A length, like `range`: the shadow camera's near plane.
      ...(o.shadowNear !== undefined ? { shadowNear: o.shadowNear * factor } : {}),
      ...(o.flicker !== undefined ? { flicker: o.flicker } : {}),
    };
  }
  return {
    type: "geometry",
    ...placed,
    ...(o.kind !== undefined ? { kind: o.kind } : {}),
    ...(o.mesh !== undefined ? { mesh: o.mesh } : {}),
    ...(o.shape !== undefined ? { shape: scaleShape(o.shape, factor) } : {}),
    // A link to a sibling, not a length.
    ...(o.matchCollision !== undefined ? { matchCollision: o.matchCollision } : {}),
    ...(o.z !== undefined ? { z: o.z * factor } : {}),
    // Rotations about the two off-plane axes, and a dimensionless multiplier of
    // a model's own size. None of them is a length.
    ...(o.rotX !== undefined ? { rotX: o.rotX } : {}),
    ...(o.rotY !== undefined ? { rotY: o.rotY } : {}),
    ...(o.scale !== undefined ? { scale: o.scale } : {}),
    ...(o.depth !== undefined ? { depth: o.depth * factor } : {}),
    ...(o.bevel !== undefined ? { bevel: o.bevel * factor } : {}),
    ...(o.texture !== undefined ? { texture: o.texture } : {}),
    // A MULTIPLE of the texture's own size rather than a length - see
    // `GeometryObjectData.tileScale` - so it passes through untouched, as
    // `scale` does. The absolute size it multiplies lives in the manifest, in
    // metres, and never reaches this function at all: it is code rather than
    // level.
    ...(o.tileScale !== undefined ? { tileScale: o.tileScale } : {}),
    // These two ARE lengths (see `tileOffsetX`), so unlike the scale above they
    // convert like the geometry does.
    ...(o.tileOffsetX !== undefined ? { tileOffsetX: o.tileOffsetX * factor } : {}),
    ...(o.tileOffsetY !== undefined ? { tileOffsetY: o.tileOffsetY * factor } : {}),
    ...(o.color !== undefined ? { color: o.color } : {}),
    ...(o.opacity !== undefined ? { opacity: o.opacity } : {}),
    // A colour, a multiplier of it, and a manifest key. None is a length.
    ...(o.emissive !== undefined ? { emissive: o.emissive } : {}),
    ...(o.emissiveIntensity !== undefined ? { emissiveIntensity: o.emissiveIntensity } : {}),
    ...(o.emissiveTexture !== undefined ? { emissiveTexture: o.emissiveTexture } : {}),
  };
}

export function scaleLevelData(rawData: RawLevelData, factor: number): LevelData {
  const data = normalizeLevelData(rawData);
  // A camera region's positions, extents, offsets, locks and buffer are
  // lengths; viewportScale, blend (seconds) and priority are not.
  const regions = data.cameraRegions?.map((r) => ({
    x: r.x * factor,
    y: r.y * factor,
    rot: r.rot,
    shape: scaleShape(r.shape, factor),
    ...(r.offsetX !== undefined ? { offsetX: r.offsetX * factor } : {}),
    ...(r.offsetY !== undefined ? { offsetY: r.offsetY * factor } : {}),
    ...(r.viewportScale !== undefined ? { viewportScale: r.viewportScale } : {}),
    ...(r.lockX !== undefined ? { lockX: r.lockX * factor } : {}),
    ...(r.lockY !== undefined ? { lockY: r.lockY * factor } : {}),
    ...(r.blend !== undefined ? { blend: r.blend } : {}),
    ...(r.buffer !== undefined ? { buffer: r.buffer * factor } : {}),
    ...(r.bufferLeft !== undefined ? { bufferLeft: r.bufferLeft * factor } : {}),
    ...(r.bufferRight !== undefined ? { bufferRight: r.bufferRight * factor } : {}),
    ...(r.bufferTop !== undefined ? { bufferTop: r.bufferTop * factor } : {}),
    ...(r.bufferBottom !== undefined ? { bufferBottom: r.bufferBottom * factor } : {}),
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
  }));
  // A camera path's placement, verts, range, lookahead and buffer are lengths;
  // rot, viewportScale, blend (seconds) and priority are not.
  //
  // Degenerate paths are dropped here rather than guarded against downstream: a
  // polyline with fewer than two DISTINCT verts has no direction, so there is
  // nothing to project onto and nothing to lead the player along. It is named
  // by its index and its origin, which is what an author looks a path up by in
  // the file - the level's own name is not known at this point, the format
  // being loaded from raw data that does not carry one.
  const paths = data.cameraPaths
    ?.filter((p, i) => {
      const distinct = p.verts?.some((v) => v.x !== p.verts[0]!.x || v.y !== p.verts[0]!.y);
      if ((p.verts?.length ?? 0) >= 2 && distinct) return true;
      console.warn(
        `[camera] cameraPaths[${i}] at (${p.x}, ${p.y}) has fewer than 2 distinct verts; dropped.`,
      );
      return false;
    })
    .map((p) => ({
      x: p.x * factor,
      y: p.y * factor,
      rot: p.rot,
      // A node's point and both its handles are lengths; nothing else about one
      // is. Absent handles stay absent, which is what keeps a plain polyline
      // byte-identical through the conversion.
      verts: p.verts.map((v) => ({
        x: v.x * factor,
        y: v.y * factor,
        ...(v.inX !== undefined ? { inX: v.inX * factor } : {}),
        ...(v.inY !== undefined ? { inY: v.inY * factor } : {}),
        ...(v.outX !== undefined ? { outX: v.outX * factor } : {}),
        ...(v.outY !== undefined ? { outY: v.outY * factor } : {}),
      })),
      // The retired scalar range/falloff were one circular radius each: folded
      // into both axes here, at the one gate, so a level that authored a
      // circle keeps exactly that circle and nothing downstream reads the
      // scalar fields at all.
      ...(p.rangeX !== undefined
        ? { rangeX: p.rangeX * factor }
        : p.range !== undefined
          ? { rangeX: p.range * factor }
          : {}),
      ...(p.rangeY !== undefined
        ? { rangeY: p.rangeY * factor }
        : p.range !== undefined
          ? { rangeY: p.range * factor }
          : {}),
      ...(p.falloffX !== undefined
        ? { falloffX: p.falloffX * factor }
        : p.falloff !== undefined
          ? { falloffX: p.falloff * factor }
          : {}),
      ...(p.falloffY !== undefined
        ? { falloffY: p.falloffY * factor }
        : p.falloff !== undefined
          ? { falloffY: p.falloff * factor }
          : {}),
      ...(p.lookaheadX !== undefined ? { lookaheadX: p.lookaheadX * factor } : {}),
      ...(p.lookaheadY !== undefined ? { lookaheadY: p.lookaheadY * factor } : {}),
      ...(p.lookaheadBufferX !== undefined
        ? { lookaheadBufferX: p.lookaheadBufferX * factor }
        : {}),
      ...(p.lookaheadBufferY !== undefined
        ? { lookaheadBufferY: p.lookaheadBufferY * factor }
        : {}),
      ...(p.viewportScale !== undefined ? { viewportScale: p.viewportScale } : {}),
      ...(p.blend !== undefined ? { blend: p.blend } : {}),
      ...(p.buffer !== undefined ? { buffer: p.buffer * factor } : {}),
      ...(p.priority !== undefined ? { priority: p.priority } : {}),
    }));
  // A note's placement, box and glyph height are lengths; its text is not.
  const notes = data.notes?.map((n) => ({
    kind: n.kind,
    x: n.x * factor,
    y: n.y * factor,
    rot: n.rot,
    w: n.w * factor,
    h: n.h * factor,
    ...(n.text !== undefined ? { text: n.text } : {}),
    ...(n.size !== undefined ? { size: n.size * factor } : {}),
  }));
  // A chain's LENGTH is a length; its two anchor ids and its colour are not. The
  // anchor POINTS are no longer here at all - they are objects on their bodies
  // and scale with every other placement, through `scaleObject`.
  const chains = data.chains?.map((c) => ({
    a: c.a,
    b: c.b,
    ...(c.length !== undefined ? { length: c.length * factor } : {}),
    ...(c.color !== undefined ? { color: c.color } : {}),
  }));
  // A vine's LENGTH and its link SPACING are both lengths; its anchor id and its
  // colour are not. The anchor point itself is an object on its body and scales
  // through `scaleObject` with every other placement, exactly as a chain end does.
  const vines = data.vines?.map((v) => ({
    anchor: v.anchor,
    ...(v.anchor2 !== undefined ? { anchor2: v.anchor2 } : {}),
    length: v.length * factor,
    ...(v.spacing !== undefined ? { spacing: v.spacing * factor } : {}),
    // Kilograms per metre already, so it crosses the conversion unchanged - the
    // one number on a vine that is not in the file's pixels.
    ...(v.density !== undefined ? { density: v.density } : {}),
    // A fraction, like the density a per-metre one: neither is in the file's
    // pixels, so both cross the conversion unchanged.
    ...(v.stiffness !== undefined ? { stiffness: v.stiffness } : {}),
    ...(v.color !== undefined ? { color: v.color } : {}),
  }));
  return {
    ...(regions ? { cameraRegions: regions } : {}),
    ...(paths ? { cameraPaths: paths } : {}),
    // Nothing in the environment block is a length (see EnvironmentData), so it
    // is copied rather than scaled - but copied, not shared, since everything
    // else here hands the caller a fresh object.
    ...(data.environment ? { environment: { ...data.environment } } : {}),
    ...(notes ? { notes } : {}),
    ...(chains ? { chains } : {}),
    ...(vines ? { vines } : {}),
    player: {
      x: data.player.x * factor,
      y: data.player.y * factor,
      radius: data.player.radius * factor,
    },
    bodies: data.bodies.map((b) => ({
      kind: b.kind,
      x: b.x * factor,
      y: b.y * factor,
      rot: b.rot,
      ...(b.color !== undefined ? { color: b.color } : {}),
      ...(b.opacity !== undefined ? { opacity: b.opacity } : {}),
      ...(b.friction !== undefined ? { friction: b.friction } : {}),
      // A restitution is a ratio and a launch is a speed, so exactly one of the
      // trampoline pair converts - the same split `flow`/`drag` makes below, and
      // the same silent failure if it is got wrong: a launch left in pixels is a
      // pad a hundred times too strong.
      ...(b.bounce !== undefined ? { bounce: b.bounce } : {}),
      ...(b.launch !== undefined ? { launch: b.launch * factor } : {}),
      ...(b.force !== undefined ? { force: b.force * factor } : {}),
      // A speed scales; a rate does not. See `LevelBodyData.flow`/`drag`.
      ...(b.flow !== undefined ? { flow: b.flow * factor } : {}),
      ...(b.drag !== undefined ? { drag: b.drag } : {}),
      ...(b.passable !== undefined ? { passable: b.passable } : {}),
      ...(b.pivot !== undefined ? { pivot: b.pivot } : {}),
      // The bearing is a POINT, so both halves are lengths and both convert;
      // the torsion frequency is a rate and its damping a ratio, so neither
      // does - the same split the linear spring's fields make below.
      ...(b.pivotX !== undefined ? { pivotX: b.pivotX * factor } : {}),
      ...(b.pivotY !== undefined ? { pivotY: b.pivotY * factor } : {}),
      ...(b.pivotFreq !== undefined ? { pivotFreq: b.pivotFreq } : {}),
      ...(b.pivotDamping !== undefined ? { pivotDamping: b.pivotDamping } : {}),
      // A spring frequency is a rate and a damping ratio is a ratio, so neither
      // is a length and neither scales - the same rule `drag` follows above,
      // and the reason `LevelBodyData.springFreqX` is authored as a frequency
      // rather than as a stiffness.
      ...(b.springFreqX !== undefined ? { springFreqX: b.springFreqX } : {}),
      ...(b.springFreqY !== undefined ? { springFreqY: b.springFreqY } : {}),
      ...(b.springDamping !== undefined ? { springDamping: b.springDamping } : {}),
      // Two angles and a time (see `LevelBodyData.swingAmp`): not one of them is
      // a length, so the pendulum crosses the conversion whole. It is the same
      // rule the torsion spring's frequency follows, and it matters more here -
      // an amplitude scaled by 100 is a body that spins rather than swings.
      ...(b.swingAmp !== undefined ? { swingAmp: b.swingAmp } : {}),
      ...(b.swingPeriod !== undefined ? { swingPeriod: b.swingPeriod } : {}),
      ...(b.swingPhase !== undefined ? { swingPhase: b.swingPhase } : {}),
      // The route is a list of POINTS, so every one of them is a length; the
      // speed is a length per second and converts with them. What does not is
      // the phase (cycles), the ease (a name) and the closure (a fact about the
      // polyline) - the same split the pendulum's fields make above.
      ...(b.movePath !== undefined
        ? { movePath: b.movePath.map((p) => ({ x: p.x * factor, y: p.y * factor })) }
        : {}),
      ...(b.moveClosed !== undefined ? { moveClosed: b.moveClosed } : {}),
      ...(b.moveSpeed !== undefined ? { moveSpeed: b.moveSpeed * factor } : {}),
      ...(b.movePhase !== undefined ? { movePhase: b.movePhase } : {}),
      ...(b.moveEase !== undefined ? { moveEase: b.moveEase } : {}),
      objects: b.objects.map((o) => scaleObject(o, factor)),
    })),
  };
}
