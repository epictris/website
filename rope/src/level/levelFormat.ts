// Canonical, hand-editable level format — the single source of truth for the
// level schema, shared by the runtime loaders (`Level`, `BallLevel`) and the
// level editor. `levelData.ts` is auto-generated from a Godot scene and stays
// untouched; its narrower body-kind union is structurally assignable to this
// superset, so generated levels load through this format unchanged.
//
// Geometry is authored in Godot/scene pixels (as in the generated data); the
// simulation runs in metres. `scaleLevelData(data, PX)` converts on load and
// `scaleLevelData(data, PIXELS_PER_METER)` converts back for saving to disk.

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
// Hook-proof (`impermeable`) is deliberately NOT among them - it is a per-shape
// flag below. It was a kind while it could only ever be static scene geometry,
// and that cost the two things a level actually wants: a hook-proof crate that
// still falls and is hauled about (nothing can be `rigid` and `impermeable` at
// once when both are kinds), and a compound wall with one attachable ledge and
// hook-proof faces everywhere else.
export type BodyKind = "static" | "anchor" | "killzone" | "rigid" | "force";

// The retired kind, as levels on disk (and the generated `levelData.ts`) still
// carry it. `normalizeLevelData` folds it into `static` + `impermeable: true`
// at load, so nothing past that line ever sees it.
export const LEGACY_IMPERMEABLE = "impermeable";

// A shape as authored on disk. `poly` is a **convex** vertex loop in the item's
// own local frame, centred on its area centroid (the loader re-centres one that
// is not, shifting the item's position to compensate, since a body's origin is
// its centre of mass everywhere in the engine). A rect stays its own kind rather
// than being written as a four-vertex poly: every recorded replay was simulated
// through the rect-specific collision routines.
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

// What a body LOOKS like in the 3D renderer (`src/render3d/`), as opposed to
// what it collides as. Render-only data throughout: `sim/*`, the mass
// computation in `buildBodies.ts` and `contactCases.ts` all ignore it, and a
// level with none of it plays and looks identical to one authored before the
// field, because the default is to extrude the collision outline.
//
// The default is the point. A body with no `visual` is drawn as its own
// collision geometry given depth, so a level is fully 3D the moment it loads and
// an authored visual is a decoration on top of a scene that already works -
// rather than the scene being invisible until every body has a model.
//
// Lengths here are authored in scene pixels on disk exactly as every other
// length is, and `scaleVisual` converts them; angles and the uniform `scale` are
// dimensionless and pass through. Getting that wrong is silent: `scaleLevelData`
// rebuilds objects field by field, so a field it does not enumerate is dropped
// on the next save rather than reported.
export interface VisualData {
  // How this shape is turned into something the GPU draws. The two real answers
  // are the two ways a thing gets a look in this game, and they are a choice:
  //
  // "auto" (and an absent `kind`): the shape's own PRIMITIVE - the authored
  //         rect, circle or convex loop - extruded through z and wearing a
  //         tileable PBR surface (`texture` + `tileScale`). No file, no download, and
  //         what the player sees is exactly the outline they collide with.
  // "mesh": a named GLTF asset from the manifest (`render3d/assets.ts`) instead,
  //         which may bring its own materials or wear the same surface set.
  // "none": drawn by nothing - an invisible wall.
  kind?: "auto" | "mesh" | "none";
  // Manifest key. `kind: "mesh"` only; an unknown key draws the placeholder
  // rather than nothing, so a missing asset is visible instead of silent.
  mesh?: string;
  // Placement of the mesh in the BODY's frame. A compound body carries one
  // visual per authored piece, each riding that piece's own local transform, so
  // these are offsets from the piece rather than from the group's centre of mass.
  offsetX?: number;
  offsetY?: number;
  // Depth placement: 0 is the gameplay plane, positive is toward the camera.
  offsetZ?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  // Uniform mesh scale, dimensionless: it multiplies a model's own size and is
  // not a length, so it does NOT scale on the way in or out.
  scale?: number;
  // Auto-extrusion controls (`kind` "auto" or absent).
  // Extrusion depth; absent = the shape's own `thickness`, which is the number
  // its mass is already computed from, so a body is as thick as it weighs.
  depth?: number;
  // Which surface to wear. A key of `TEXTURE_ASSETS` (an authored PBR set:
  // albedo, normal, roughness, metallic and ambient-occlusion maps) or of
  // `TEXTURE_SETS` (the generated surfaces, keyed by material name) - one
  // namespace, looked up in that order by `render3d/assets.ts`.
  //
  // Absent = the one the shape's `material` name picks, so naming the stuff a
  // thing is made of is still the only decision an author has to make.
  //
  // It applies to BOTH visual kinds: an extrusion is textured with it, and a
  // `mesh` wears it instead of the materials its own file carries. A mesh that
  // authors none keeps its own, which is what lets a fully-textured prop drop in
  // untouched and a bare one (geometry only, ~20 KB) be dressed as level stuff.
  texture?: string;
  // Tiling scale: how large this shape wears the texture, as a MULTIPLE of the
  // size the texture itself was authored at. 1 is life size - one repeat covers
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
  // Where the texture STARTS on this shape, as a shift in world space: +x moves
  // it right, +y moves it down (level coordinates, the same sense as the shape's
  // own `x`/`y`). Absent is 0.
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
  // Edge break. Absent = DEFAULT_BEVEL.
  bevel?: number;
}

export interface LevelBodyData {
  // `normalizeLevelData` is what every level passes through on the way in, so
  // downstream this is a `BodyKind`; the wider type is only how the retired
  // `"impermeable"` kind is still readable off disk.
  kind: BodyKind | typeof LEGACY_IMPERMEABLE;
  // Hook-proof: the grapple hook is destroyed on this surface and the ball's is
  // deflected, instead of either anchoring. It is solid either way - being
  // hook-proof is about the rope and nothing else - so the avatar stands on it,
  // bodies collide with it and the rope still wraps its corners.
  //
  // Per SHAPE, which is per entry here, and unlike every other body-level
  // property it does NOT collapse onto a group's first member: a compound wall
  // whose one attachable ledge is a piece among hook-proof faces is precisely
  // what it is for, and which surface the hook reached is a question about a
  // shape rather than about a body.
  impermeable?: boolean;
  // Does this shape take part in the simulation at all? Absent (and true) is a
  // piece of the level; FALSE is decoration - it is drawn and nothing else. It
  // never becomes a collision shape, never enters the `World`, carries no mass,
  // and no physics path has to know it exists.
  //
  // That last clause is the whole design. Decoration used to be its own list
  // (`backgrounds`) precisely to keep it out of the sim, on the argument that a
  // pass-through `BodyKind` would have to be excluded by every physics query one
  // call site at a time. The argument was right about the danger and wrong about
  // the remedy: a shape that is never BUILT is excluded from everything by
  // construction, exactly as a separate list was, while staying one authorable
  // thing with one set of tools - drawn, picked, dragged, grouped, given a 3D
  // visual and a texture by the same code as every wall.
  //
  // A non-colliding entry may still be a member of a `group`: it then rides that
  // group's engine body, so a lantern hung on a swinging crate swings with it
  // without adding a shape, a seam or a gram to what the crate collides as
  // (`buildLevelBodies` resolves it into `BuiltBodies.decor`). Every physics
  // property - kind, friction, material, thickness, impermeable - is meaningless
  // on one and ignored rather than refused, since a shape may be switched back
  // and forth while a level is authored.
  //
  // Drawing keeps the two rules the old background layer had, and they are
  // structural rather than stylistic (see "Backgrounds" in docs/game-design.md):
  // decoration is drawn BEFORE anything solid, so nothing the player can touch
  // is ever hidden behind it, and it is never STROKED, since a border is what
  // makes a shape read as an object.
  collision?: boolean;
  x: number;
  y: number;
  rot: number;
  shape: ShapeData;
  // Optional appearance (hex colour + 0..1 fill opacity). Absent = the defaults.
  color?: string;
  opacity?: number;
  // Surface friction, 0 (ice) .. 1 (rubber). Absent = DEFAULT_SURFACE_FRICTION.
  friction?: number;
  // What this shape is made of and how thick it is through z - the dimension
  // the 2D view cannot show. Together they are the shape's mass: its area times
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
  // Both are per SHAPE and not per body, which is the one property of a
  // compound group that deliberately does NOT collapse onto the first member's:
  // a body made of a stone head on a wooden shaft is exactly the case, and its
  // mass, centre of mass and moment of inertia are all sums over the pieces
  // (`buildBodies.ts`), so each piece bringing its own material is what those
  // sums are for.
  //
  // Only a `rigid` body has a mass at all - a static is infinite - but they are
  // authored on any solid geometry, as `friction` is: they state what the thing
  // is made of, and they also fix where a compound body's origin sits, which
  // the editor rotates a group about whatever its kind.
  material?: string;
  // Metres in the sim, scene pixels on disk like every other length.
  thickness?: number;
  // Force areas only: acceleration magnitude in pixels/s² (metres/s² once
  // scaled), applied along the body's own rotation — rot 0 flows right, so
  // rotating the area steers the current. Negative reverses it.
  force?: number;
  // Compound-body tag. Every entry sharing the same non-empty `group` becomes
  // ONE engine body carrying all their shapes (`addShape`), placed at the
  // group's combined centre of mass with each piece keeping its authored offset
  // and angle. Absent = a body of its own, which is every body authored before
  // this field.
  //
  // The point is not to save entries - several overlapping bodies already look
  // identical - but that the pieces are then *one* body, which is what makes a
  // concave form behave like a solid: the rope refuses to wrap a vertex buried
  // inside another shape of the same body (`isSeamVertex`) and ledge detection
  // refuses to grab one (`isSeamOccluded`), so a span crossing the join runs
  // straight instead of snagging where the real surface is smooth. See
  // "Convex-only polygons; compound bodies" in docs/game-design.md.
  //
  // The group's kind, colour, opacity, friction and force are taken from its
  // FIRST entry: a body has one of each, so the rest are ignored (the editor
  // keeps them in sync so a file never disagrees with what it draws).
  // `material`, `thickness` and `impermeable` are the exceptions and stay per
  // entry - see the fields.
  group?: string;
  // What this shape looks like in 3D (see VisualData). Per authored entry like
  // `material` and `thickness` and for the same reason: a compound body of a
  // stone head on a wooden shaft is two visuals on one body, each riding its own
  // piece, so `syncGroupProps` leaves it alone.
  visual?: VisualData;
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
// not in the body's local frame: a grouped body's origin is its combined centre
// of mass, which moves as pieces are added, and a world point is what the editor
// actually has under the pointer. `buildSceneChains` converts each into the
// engine body's local frame once, at load.
export interface ChainAnchorData {
  // Index into `LevelData.bodies` of the body this end is tied to. Two ends may
  // name entries of the same group - that is one body, and a chain tied to
  // itself at both ends, so the editor refuses it.
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

// Appearance a retired background panel is migrated with: an opaque dark slate,
// deliberately distinct from the geometry grey so a backdrop does not read as a
// wall. It was the default of a list that no longer exists, so it is written out
// EXPLICITLY by the migration rather than left to a default - the body defaults
// are the grey, and a decoration silently changing colour on load is exactly the
// kind of migration that looks like a rendering bug.
export const LEGACY_BACKGROUND_COLOR = "#313244";
export const LEGACY_BACKGROUND_OPACITY = 1;

// THE RETIRED BACKGROUND LIST, as levels on disk still carry it.
//
// Decoration was its own list because it had to stay out of the sim: nothing
// collides with it, nothing wraps it, no force reaches through it. That is still
// true and is now said by `LevelBodyData.collision: false`, which keeps it out
// by never building it - so decoration stopped being a second kind of thing with
// a second set of tools (its own layer, its own inspector, its own resolve path)
// and became one flag on the shapes a level already has.
//
// `normalizeLevelData` folds each panel into a non-colliding body, keeping its
// placement, its group tag, its visual, and its colour written out explicitly.
// Nothing past that line has ever seen a `BackgroundData`.
export interface LegacyBackgroundData {
  x: number;
  y: number;
  rot: number;
  shape: ShapeData;
  // Optional appearance (hex colour + 0..1 fill opacity). Absent = the defaults.
  color?: string;
  opacity?: number;
  // Compound-body membership, the SAME tag `LevelBodyData.group` carries: a
  // panel tagged into a group is drawn in that group's engine body's frame, so
  // decoration on a rigid body swings, falls and turns with it instead of
  // staying welded to the spot it was authored at.
  //
  // A tag rather than a body index (which is how `ChainAnchorData` names a body)
  // because this IS the grouping mechanism and not a second one: an author welds
  // a backdrop into a compound body exactly as they weld two shapes together,
  // and a tag no body carries - several panels grouped with nothing else, or a
  // group whose bodies were deleted - is simply decoration that does not move.
  //
  // The placement stays in WORLD coordinates like everything else on disk, and
  // `buildLevelBodies` converts it into the body's frame once, at load: a
  // group's origin is its combined centre of mass, which shifts as pieces are
  // added, so a local offset in the file would be authored against a moving
  // point. That is the same reason chains author their anchors in world space.
  group?: string;
  visual?: VisualData;
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
// direction is a direction, the colours are colours, and the haze is a
// dimensionless 0..1 rather than a fog density in 1/metres - an inverse length
// would have to be scaled the OTHER way by `scaleLevelData`, which is a trap
// worth designing out rather than commenting on. So the whole block passes
// through the scaler untouched.
export interface EnvironmentData {
  // Direction the sunlight TRAVELS, in the sim's own frame (x right, y down),
  // plus a z toward the camera. Not normalised; absent = a warm sun from the
  // upper left and slightly in front, which is the reference look's key light.
  sunX?: number;
  sunY?: number;
  sunZ?: number;
  sunColor?: string;
  // Multiplier on the sun's default strength. 0 is an overcast level lit by the
  // sky alone, which is a legitimate thing to author.
  sunIntensity?: number;
  // Hemisphere fill: the sky above and the bounce off whatever is below.
  skyColor?: string;
  groundColor?: string;
  fillIntensity?: number;
  // What is behind everything, and what distance fades into. Absent = the page's
  // own background, so the 3D scene's horizon and the letterbox bars agree.
  backgroundColor?: string;
  fogColor?: string;
  // Atmospheric perspective, 0 (vacuum) .. 1 (thick). This is what makes a
  // background layer at -20 m read as far away rather than as a small object.
  haze?: number;
}

export interface LevelData {
  player: { x: number; y: number; radius: number };
  bodies: LevelBodyData[];
  // THE RETIRED decoration list (see LegacyBackgroundData). Read off disk and
  // folded into `bodies` as non-colliding shapes by `normalizeLevelData`;
  // nothing writes it any more, and nothing downstream of that gate reads it.
  backgrounds?: LegacyBackgroundData[];
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

// Scale every length by `factor` (pass PX = 1 / PIXELS_PER_METER on load, or
// PIXELS_PER_METER on save), leaving rotations and kinds untouched. `force` is
// an acceleration (length/s²) so it scales too; `friction` is dimensionless and
// passes through. Returns a fresh copy so the caller's data stays pristine.
// Every dimension of a shape is a length, whichever kind it is — a polygon's
// vertices included. One scaler for all three, so a new kind cannot be missed by
// one of the four lists that carry shapes.
function scaleShape(s: ShapeData, factor: number): ShapeData {
  if (s.kind === "rect") return { kind: "rect", w: s.w * factor, h: s.h * factor };
  if (s.kind === "circle") return { kind: "circle", r: s.r * factor };
  return { kind: "poly", verts: s.verts.map((v) => ({ x: v.x * factor, y: v.y * factor })) };
}

// A visual's lengths, and only its lengths. The offsets (z included), the
// extrusion depth and the bevel are metres in the sim and scene pixels on disk;
// the kind, the mesh key, the texture key, the three rotations and the two
// dimensionless factors (`scale`, `tileScale`) are not lengths and pass through
// untouched.
//
// It rebuilds the object field by field like everything else here, which is what
// makes a forgotten field a silent loss rather than a type error - hence the
// round-trip case in `cli render3d`, which is the thing that actually holds this
// function to its list.
export function scaleVisual(v: VisualData, factor: number): VisualData {
  return {
    ...(v.kind !== undefined ? { kind: v.kind } : {}),
    ...(v.mesh !== undefined ? { mesh: v.mesh } : {}),
    ...(v.offsetX !== undefined ? { offsetX: v.offsetX * factor } : {}),
    ...(v.offsetY !== undefined ? { offsetY: v.offsetY * factor } : {}),
    ...(v.offsetZ !== undefined ? { offsetZ: v.offsetZ * factor } : {}),
    ...(v.rotX !== undefined ? { rotX: v.rotX } : {}),
    ...(v.rotY !== undefined ? { rotY: v.rotY } : {}),
    ...(v.rotZ !== undefined ? { rotZ: v.rotZ } : {}),
    ...(v.scale !== undefined ? { scale: v.scale } : {}),
    ...(v.depth !== undefined ? { depth: v.depth * factor } : {}),
    ...(v.texture !== undefined ? { texture: v.texture } : {}),
    // A MULTIPLE of the texture's own size rather than a length - see
    // `VisualData.tileScale` - so it passes through untouched, as `scale` does.
    // The absolute size it multiplies lives in the manifest, in metres, and never
    // reaches this function at all: it is code rather than level.
    ...(v.tileScale !== undefined ? { tileScale: v.tileScale } : {}),
    // These two ARE lengths (see `VisualData.tileOffsetX`), so unlike the scale
    // above they convert like the geometry does.
    ...(v.tileOffsetX !== undefined ? { tileOffsetX: v.tileOffsetX * factor } : {}),
    ...(v.tileOffsetY !== undefined ? { tileOffsetY: v.tileOffsetY * factor } : {}),
    ...(v.bevel !== undefined ? { bevel: v.bevel * factor } : {}),
  };
}

// Fold the two retired forms into what they now are: the `impermeable` KIND
// into a static body whose shape is hook-proof, and the `backgrounds` LIST into
// non-colliding bodies. Idempotent, and a no-op for a level carrying neither, so
// it costs nothing to run on the way out as well as on the way in.
//
// It runs inside `scaleLevelData` rather than at each loader, because that is
// the one gate a level cannot reach the sim (or the editor) without passing
// through - the conversion between the pixels on disk and the metres everything
// downstream is written in. A migration a caller can forget is a migration that
// is missing wherever a new caller is added, and both failures here are silent:
// a hook-proof wall builds as an ordinary static and simply starts catching the
// hook it has repelled since the level was designed, and a dropped background
// list is decoration that vanishes with nothing to report.
//
// Panels are APPENDED rather than prepended, because `ChainData` names bodies by
// index into this array and a migration that renumbered them would re-anchor
// every chain in the file. Where decoration is DRAWN is not a matter of list
// order - a non-colliding shape draws before every solid one wherever it sits
// (see `LevelBodyData.collision`) - which is what makes appending free.
export function normalizeLevelData(data: LevelData): LevelData {
  const panels = data.backgrounds ?? [];
  if (panels.length === 0 && !data.bodies.some((b) => b.kind === LEGACY_IMPERMEABLE)) return data;
  const bodies: LevelBodyData[] = data.bodies.map((b) =>
    b.kind === LEGACY_IMPERMEABLE ? { ...b, kind: "static" as const, impermeable: true } : b,
  );
  for (const p of panels) {
    bodies.push({
      // A kind is a statement about physics and a panel has none; `static` is
      // what it reads as everywhere it is asked, and `collision: false` is what
      // stops anything asking.
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
    });
  }
  const { backgrounds: _dropped, ...rest } = data;
  return { ...rest, bodies };
}

export function scaleLevelData(rawData: LevelData, factor: number): LevelData {
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
      // Absent means "collides", so only the false is ever written - a level of
      // ordinary walls stays byte-identical through a save.
      ...(b.collision !== undefined ? { collision: b.collision } : {}),
      x: b.x * factor,
      y: b.y * factor,
      rot: b.rot,
      shape: scaleShape(b.shape, factor),
      ...(b.color !== undefined ? { color: b.color } : {}),
      ...(b.opacity !== undefined ? { opacity: b.opacity } : {}),
      ...(b.friction !== undefined ? { friction: b.friction } : {}),
      ...(b.impermeable !== undefined ? { impermeable: b.impermeable } : {}),
      // A material is a name and scales by nothing; a thickness is a length in
      // z and scales exactly as the two lengths in the plane do.
      ...(b.material !== undefined ? { material: b.material } : {}),
      ...(b.thickness !== undefined ? { thickness: b.thickness * factor } : {}),
      ...(b.force !== undefined ? { force: b.force * factor } : {}),
      ...(b.group !== undefined ? { group: b.group } : {}),
      // Render-only, and scaled exactly like the geometry it decorates: see
      // `scaleVisual` for which of its fields are lengths.
      ...(b.visual !== undefined ? { visual: scaleVisual(b.visual, factor) } : {}),
    })),
  };
}
