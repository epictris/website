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
// - anchor:      hook-only scenery — the hook attaches to it, but nothing
//                collides with it and the rope never wraps it (a background
//                grate, a girder, a chandelier).
// - killzone:    an Area2D that resets the level when the avatar enters it.
// - rigid:       a dynamic RigidBody2D (gravity + collisions), authored in place.
// - force:       an Area2D that accelerates every body inside it along the
//                area's own rotation (a river current, wind, an updraft).
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
export type BodyKind = "static" | "anchor" | "killzone" | "rigid" | "force";

// The retired kind, as levels on disk (and the generated `levelData.ts`) still
// carry it. `normalizeLevelData` folds it into `static` + `impermeable: true`
// at load, so nothing past that line ever sees it.
export const LEGACY_IMPERMEABLE = "impermeable";

// A shape as authored on disk. `poly` is a **convex** vertex loop in the
// object's own local frame, centred on its area centroid (the loader re-centres
// one that is not, shifting the object's position to compensate, since a body's
// origin is its centre of mass everywhere in the engine). A rect stays its own
// kind rather than being written as a four-vertex poly: every recorded replay
// was simulated through the rect-specific collision routines.
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

// Default strength of a new force area, in scene pixels/s² (→ 3 m/s², roughly a
// third of gravity: a current that carries but does not fling).
export const DEFAULT_FORCE_MAGNITUDE = 300;

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
// looks. Levels written under the old default are given the geometry object that
// states it, once, at load (`withGeometryTwin` in this file), so nothing on disk
// changed appearance when the default went away.
//
// A geometry object with no `shape` of its own draws the body's COLLISION
// outlines: that is how a wall wears brick at twice life size without the file
// carrying its outline a second time where the two could drift apart, and it is
// what the migrated twin is. An authored `shape` is a form of its own, which is
// what decoration and a prop's placeholder are.
export interface GeometryObjectData extends ObjectPlacement {
  type: "geometry";
  // How this is turned into something the GPU draws. The three answers are the
  // three ways a thing gets a look in this game, and they are a choice:
  //
  // "auto" (and an absent `kind`): a PRIMITIVE - this object's own `shape`, or
  //         the body's collision outlines when it has none - extruded through z
  //         and wearing a tileable PBR surface (`texture` + `tileScale`). No
  //         file, no download, and what the player sees is exactly the outline
  //         they collide with.
  // "mesh": a named GLTF asset from the manifest (`render3d/assets.ts`) instead,
  //         which may bring its own materials or wear the same surface set.
  // "none": drawn by nothing - an invisible wall. It exists because absence
  //         already means "the default look": without an explicit way to say it,
  //         a body could not opt out of being drawn at all.
  kind?: "auto" | "mesh" | "none";
  // Manifest key. `kind: "mesh"` only; an unknown key draws the placeholder
  // rather than nothing, so a missing asset is visible instead of silent.
  mesh?: string;
  // The outline this is drawn as. Absent = the body's own collision shapes,
  // which is what dresses a wall without restating its geometry. Required in
  // practice for a body that has no collision objects (decoration), since there
  // would otherwise be no outline at all; a `mesh` with neither draws a unit
  // placeholder until its file arrives.
  shape?: ShapeData;
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
  // Extrusion depth; absent = the collision object's own `thickness`, which is
  // the number its mass is already computed from, so a body is as thick as it
  // weighs.
  depth?: number;
  // Edge break. Absent = DEFAULT_BEVEL.
  bevel?: number;
  // Which surface to wear. A key of `TEXTURE_ASSETS` (an authored PBR set:
  // albedo, normal, roughness, metallic, ambient-occlusion and emission maps) or
  // of `TEXTURE_SETS` (the generated surfaces, keyed by material name) - one
  // namespace, looked up in that order by `render3d/assets.ts`.
  //
  // Absent = the one the collision object's `material` name picks, so naming the
  // stuff a thing is made of is still the only decision an author has to make.
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

export type SceneObjectData =
  | CollisionObjectData
  | GeometryObjectData
  | LightObjectData;

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
  // ...and how far the whole body sits off the gameplay plane, positive toward
  // the camera. Absent = on the plane.
  //
  // It completes the frame. `x`, `y` and `rot` were body-relative from the
  // start and `z` was not, so a body was a frame in the plane and an absolute
  // depth outside it - which meant pulling an assembly forward was editing every
  // object in it, and the one field that could not be moved as a unit was the
  // one the 2D view cannot show. An object's `z` is now an offset from this,
  // exactly as its `x` is an offset from the body's.
  //
  // A LENGTH, so it converts between the file's pixels and the sim's metres.
  z?: number;
  // Everything a body has exactly one of. They were per-entry and collapsed onto
  // a group's first member, which is a rule an author had to know and a file
  // could disagree with; here there is one of each because there is one body.
  //
  // Optional appearance (hex colour + 0..1 fill opacity). Absent = the defaults.
  color?: string;
  opacity?: number;
  // Surface friction, 0 (ice) .. 1 (rubber). Absent = DEFAULT_SURFACE_FRICTION.
  friction?: number;
  // Force areas only: acceleration magnitude in pixels/s² (metres/s² once
  // scaled), applied along the body's own rotation — rot 0 flows right, so
  // rotating the area steers the current. Negative reverses it.
  force?: number;
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

// Does this body take part in the simulation at all? One predicate, so "is this
// drawn only" is asked the same way by the builder, both renderers and the
// editor rather than being spelled out per call site.
export function collides(b: LevelBodyData): boolean {
  return b.objects.some(isCollisionObject);
}

// A chain strung between two bodies: the same wrap-point rope the grapple and
// the ball & chain use, authored into the level and solved every frame.
//
// It constrains the pair - a rigid body on either end hangs, swings and is
// hauled by it, while a static (or an `anchor`) is infinite mass and simply
// holds. A foreground chain's span additionally wraps scene geometry through the
// ordinary solver, so a chain laid over a corner catches on it.
//
// The anchor points are authored in WORLD coordinates (scene pixels on disk),
// not in the body's local frame: a body's ENGINE origin is its combined centre
// of mass, which moves as collision objects are added, and a world point is what
// the editor actually has under the pointer. `buildSceneChains` converts each
// into the engine body's local frame once, at load.
export interface ChainAnchorData {
  // Index into `LevelData.bodies` of the body this end is tied to. A chain tied
  // to the same body at both ends has nothing to constrain, so the editor
  // refuses it and the loader drops it.
  body: number;
  x: number;
  y: number;
}

export interface ChainData {
  a: ChainAnchorData;
  b: ChainAnchorData;
  // Chain length. Absent = the distance between the two anchor points as
  // authored, i.e. a chain that starts exactly taut.
  length?: number;
  // Optional appearance. Absent = the renderer's own chain colours (the same
  // forged-iron links the ball & chain hangs on).
  color?: string;
}

// Default framing of a camera region: no offset, unchanged viewport, no lock.
// A region with all of these is a no-op, so a freshly drawn one changes nothing
// until a field is authored.
export const DEFAULT_VIEWPORT_SCALE = 1;

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
  // What is behind everything. Absent = the page's own background, so the 3D
  // scene's horizon and the letterbox bars agree and the frame does not read as
  // a window cut into a different game.
  //
  // There is no fog here any more (see `render3d/environment.ts`): distance is
  // said by parallax, by the sun's shadow and by the environment's own gradient
  // rather than by muting everything behind the gameplay plane.
  backgroundColor?: string;
}

export interface LevelData {
  player: { x: number; y: number; radius: number };
  bodies: LevelBodyData[];
  // Camera-behaviour volumes (see CameraRegionData). Absent = the camera just
  // follows the avatar, which is what every level authored before this field did.
  cameraRegions?: CameraRegionData[];
  // Editor-only annotations (see NoteData). Never read by the sim or the game
  // renderer, so a level plays identically with or without them.
  notes?: NoteData[];
  // Chains strung between pairs of bodies (see ChainData). Absent = a level with
  // no chains, which is every level authored before this field.
  chains?: ChainData[];
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
  notes?: NoteData[];
  chains?: ChainData[];
  environment?: EnvironmentData;
}

function isLegacyBody(b: LevelBodyData | LegacyBodyData): b is LegacyBodyData {
  return !Array.isArray((b as LevelBodyData).objects);
}

// The appearance half of a retired visual, as a geometry object. `shape` is left
// absent when the entry had a collision shape of its own (the geometry is the
// body's own outline, which is what an extruded body already was) and set when it
// did not.
function geometryFromLegacy(
  v: LegacyVisualData | undefined,
  shape: ShapeData | undefined,
  decorZ: number | undefined,
  color: string | undefined,
  opacity: number | undefined,
): GeometryObjectData {
  return {
    type: "geometry",
    ...(v?.kind !== undefined ? { kind: v.kind } : {}),
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
    return { ...raw, bodies: (raw.bodies as LevelBodyData[]).map(withGeometryTwin) };
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
    bodies.push({
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
          }
        : {}),
      objects: legacy.flatMap(objectsOfLegacy),
    });
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
          ...(l.flicker !== undefined ? { flicker: l.flicker } : {}),
        },
      ],
    });
  }

  const chains = raw.chains?.map((c) => ({
    ...c,
    a: { ...c.a, body: bodyOfEntry[c.a.body] ?? c.a.body },
    b: { ...c.b, body: bodyOfEntry[c.b.body] ?? c.b.body },
  }));

  const { backgrounds: _panels, lights: _lights, ...rest } = raw;
  return { ...rest, bodies: bodies.map(withGeometryTwin), ...(chains ? { chains } : {}) };
}

// Drawing is a GEOMETRY object's job, and collision is a collision object's. A
// file written before that split has bodies whose outlines were drawn BECAUSE
// they collided, so they get the geometry object that says so: one with no shape
// of its own, which already means "draw this body's collision outlines". The
// level looks exactly as it did, and the file now says why instead of leaning on
// a default that no longer exists.
//
// The outline is deliberately NOT copied onto it. A second copy is a second
// thing to resize, and the two would drift apart the first time only one of them
// was.
//
// Idempotent, which it has to be: a body that gets a twin has a shapeless
// geometry object the next time it passes through here, and every level passes
// through here on every load.
function withGeometryTwin(body: LevelBodyData): LevelBodyData {
  if (!body.objects.some(isCollisionObject)) return body;
  // ANY geometry object at all is the body saying how it looks, and that answer
  // stands. A lamp whose collision box carries an authored mesh looks like the
  // lamp; adding an extrusion of the box beside it draws a grey brick inside the
  // fitting - visible in play, invisible in the editor, and exactly the kind of
  // thing a migration should never invent. Only a body that says NOTHING about
  // its appearance is given the object stating what it used to look like.
  if (body.objects.some(isGeometryObject)) return body;
  // Placed where the first collision object is. A shapeless auto dressing is
  // drawn at each piece it dresses, so this changes nothing about the picture -
  // but it is what the editor shows and what a later save writes, and a geometry
  // object sitting half a screen from the wall it draws is a lie about the
  // level even while it renders correctly. It matters for the legacy form in
  // particular, where a migrated body sits at the origin and its objects carry
  // the world placement.
  const lead = body.objects.find(isCollisionObject)!;
  return {
    ...body,
    objects: [
      ...body.objects,
      {
        type: "geometry",
        ...(lead.x !== undefined ? { x: lead.x } : {}),
        ...(lead.y !== undefined ? { y: lead.y } : {}),
        ...(lead.rot !== undefined ? { rot: lead.rot } : {}),
      },
    ],
  };
}

// Areas are single-shape everywhere they are used - `World.integrate` tests
// overlap against `area.primaryShape()`, not `getShapes()` - so a grouped area
// would silently act through its first piece alone. Grouping was geometry-only,
// and an area that carried a tag was built as its own body instead.
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
  // A colliding entry's geometry took its outline from the collision shape, so
  // it needs none of its own; decoration was only ever the shape, so it does.
  // Both are written only when the entry authored a visual at all - a plain wall
  // gets the implicit default and no object, which is what keeps a migrated file
  // the same size as the one it replaced.
  //
  // Decoration carries its OWN fill and not the body's, which is the rule
  // `syncGroupProps` had for exactly the reason material and thickness were per
  // entry: a backdrop is authored to sit behind the geometry, so painting it the
  // lead shape's colour is precisely wrong.
  if (b.visual !== undefined || drawn) {
    objects.push(
      geometryFromLegacy(
        b.visual,
        drawn ? b.shape : undefined,
        drawn ? LEGACY_DECOR_Z : undefined,
        drawn ? b.color : undefined,
        drawn ? b.opacity : undefined,
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
      ...(o.flicker !== undefined ? { flicker: o.flicker } : {}),
    };
  }
  return {
    type: "geometry",
    ...placed,
    ...(o.kind !== undefined ? { kind: o.kind } : {}),
    ...(o.mesh !== undefined ? { mesh: o.mesh } : {}),
    ...(o.shape !== undefined ? { shape: scaleShape(o.shape, factor) } : {}),
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
  // A chain's anchor points and its length are lengths; the body indices and
  // the colour are not.
  const chains = data.chains?.map((c) => ({
    a: { body: c.a.body, x: c.a.x * factor, y: c.a.y * factor },
    b: { body: c.b.body, x: c.b.x * factor, y: c.b.y * factor },
    ...(c.length !== undefined ? { length: c.length * factor } : {}),
    ...(c.color !== undefined ? { color: c.color } : {}),
  }));
  return {
    ...(regions ? { cameraRegions: regions } : {}),
    // Nothing in the environment block is a length (see EnvironmentData), so it
    // is copied rather than scaled - but copied, not shared, since everything
    // else here hands the caller a fresh object.
    ...(data.environment ? { environment: { ...data.environment } } : {}),
    ...(notes ? { notes } : {}),
    ...(chains ? { chains } : {}),
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
      ...(b.z !== undefined ? { z: b.z * factor } : {}),
      ...(b.color !== undefined ? { color: b.color } : {}),
      ...(b.opacity !== undefined ? { opacity: b.opacity } : {}),
      ...(b.friction !== undefined ? { friction: b.friction } : {}),
      ...(b.force !== undefined ? { force: b.force * factor } : {}),
      objects: b.objects.map((o) => scaleObject(o, factor)),
    })),
  };
}
