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
  // "auto" (and an absent `kind`): extrude the collision outline.
  // "mesh": a named GLTF asset from the manifest (`render3d/assets.ts`).
  // "none": physics-only, drawn by nothing - an invisible wall, or a body whose
  //         look is carried entirely by a background panel welded to it.
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
  // Texture-set key (`render3d/assets.ts`); absent = the one the shape's
  // `material` name picks, so naming the stuff a thing is made of is still the
  // only decision an author has to make.
  texture?: string;
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

// Default appearance of a background panel: an opaque dark slate, deliberately
// distinct from the geometry grey so a fresh backdrop does not read as a wall.
export const DEFAULT_BACKGROUND_COLOR = "#313244";
export const DEFAULT_BACKGROUND_OPACITY = 1;

// A background panel: a shape drawn behind the level as pure decoration.
// Deliberately NOT a body and NOT an area — it has no collision, nothing wraps
// it, no force acts through it and the sim never sees it, so it lives in its own
// list exactly as camera regions and notes do rather than gaining a `BodyKind`
// every physics path would have to exclude.
//
// Unlike a note it *is* drawn in play — it is the one editor layer whose output
// the player sees — which is what makes its z-order and its lack of a border
// load-bearing rather than cosmetic: a background draws first, behind every
// body, and with no outline at all. A border is what makes a shape read as an
// object; a backdrop has none, and anything the player can touch is drawn over
// it with one. See "Backgrounds" in docs/game-design.md.
//
// Planned, not implemented: an image fill, which lands here as
//   image?: string;                    // asset path
//   fit?: "scale" | "crop" | "tile";   // how it maps into the shape
//   tile?: number;                     // fit "tile": tile width in scene pixels
// read by `drawBackground` alongside the colour, which stays underneath as the
// panel's backing. Nothing else moves: the placement, the shape, the layer and
// the whole editor plumbing are already shared with every other item, so images
// are a change to one draw function and one inspector section.
export interface BackgroundData {
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
  // `buildSceneBackgrounds` converts it into the body's frame once, at load: a
  // group's origin is its combined centre of mass, which shifts as pieces are
  // added, so a local offset in the file would be authored against a moving
  // point. That is the same reason chains author their anchors in world space.
  group?: string;
  // What this panel looks like in 3D (see VisualData). A panel is decoration, so
  // this is where the reference games' parallax comes from: a panel with an
  // `offsetZ` is a prop at that depth rather than a flat fill, and the camera
  // panning past it moves it at a different rate from the gameplay plane.
  //
  // Absent = a thin extrusion just behind the plane, which is what a flat fill
  // drawn before every body already was, so a level authored before this field
  // looks the same as it always did.
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
  // Decoration drawn behind the level (see BackgroundData). Absent = a level
  // whose only visible shapes are its bodies, which is every level authored
  // before this field.
  backgrounds?: BackgroundData[];
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
// the kind, the mesh key, the texture key, the three rotations and the
// dimensionless `scale` are not lengths and pass through untouched.
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
    ...(v.bevel !== undefined ? { bevel: v.bevel * factor } : {}),
  };
}

// Fold the retired `impermeable` KIND into what it now is: a static body whose
// shape is hook-proof. Idempotent, and a no-op for every level authored since,
// so it costs nothing to run on the way out as well as on the way in.
//
// It runs inside `scaleLevelData` rather than at each loader, because that is
// the one gate a level cannot reach the sim (or the editor) without passing
// through - the conversion between the pixels on disk and the metres everything
// downstream is written in. A migration a caller can forget is a migration that
// is missing wherever a new caller is added, and the failure is silent: the
// body builds as an ordinary static and the hook simply starts anchoring to a
// wall that has repelled it since the level was designed.
export function normalizeLevelData(data: LevelData): LevelData {
  if (!data.bodies.some((b) => b.kind === LEGACY_IMPERMEABLE)) return data;
  return {
    ...data,
    bodies: data.bodies.map((b) =>
      b.kind === LEGACY_IMPERMEABLE ? { ...b, kind: "static" as const, impermeable: true } : b,
    ),
  };
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
  // A background panel is placement and extent and nothing else; its colour and
  // opacity are dimensionless.
  const backgrounds = data.backgrounds?.map((g) => ({
    x: g.x * factor,
    y: g.y * factor,
    rot: g.rot,
    shape: scaleShape(g.shape, factor),
    ...(g.color !== undefined ? { color: g.color } : {}),
    ...(g.opacity !== undefined ? { opacity: g.opacity } : {}),
    ...(g.group !== undefined ? { group: g.group } : {}),
    ...(g.visual !== undefined ? { visual: scaleVisual(g.visual, factor) } : {}),
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
    ...(backgrounds ? { backgrounds } : {}),
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
