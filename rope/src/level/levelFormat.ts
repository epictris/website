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
// - impermeable: static, but hooks are destroyed on contact instead of attaching.
// - anchor:      the mirror image of impermeable — the hook attaches to it, but
//                nothing collides with it and the rope never wraps it. Scenery
//                the player swings from and passes through (a background grate,
//                a girder, a chandelier).
// - killzone:    an Area2D that resets the level when the avatar enters it.
// - rigid:       a dynamic RigidBody2D (gravity + collisions), authored in place.
// - force:       an Area2D that accelerates every body inside it along the
//                area's own rotation (a river current, wind, an updraft).
export type BodyKind = "static" | "impermeable" | "anchor" | "killzone" | "rigid" | "force";

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

export interface LevelBodyData {
  kind: BodyKind;
  x: number;
  y: number;
  rot: number;
  shape: ShapeData;
  // Optional appearance (hex colour + 0..1 fill opacity). Absent = the defaults.
  color?: string;
  opacity?: number;
  // Surface friction, 0 (ice) .. 1 (rubber). Absent = DEFAULT_SURFACE_FRICTION.
  friction?: number;
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
  group?: string;
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

export function scaleLevelData(data: LevelData, factor: number): LevelData {
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
      ...(b.force !== undefined ? { force: b.force * factor } : {}),
      ...(b.group !== undefined ? { group: b.group } : {}),
    })),
  };
}
