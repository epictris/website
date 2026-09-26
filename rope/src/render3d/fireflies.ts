// FIREFLIES: a swarm of small curious creatures that hovers where it was
// authored until the ball comes near, then keeps the ball company for the rest
// of the run - hovering a little ahead of it along the level's camera path,
// scattering when it comes too close, regrouping in front of it again - so the
// player is lit by something the WORLD gave them rather than a light of their
// own (see "Fireflies" in docs/lighting-and-surfaces.md, and
// `LightObjectData.fireflies`).
//
// Pure - no three.js in here - so `cli render3d` can step it without a GPU. The
// rig (`lights.ts`) owns the three side: the motes' draw, the pool of real
// lights, the home read off the swarm's body each frame.
//
// RENDER-SIDE and driven by the clock the rig is handed, exactly like the
// waking lights: the renderer reads the ball's drawn position and writes
// nothing back, so no replay can diverge on it. A reset builds a new scene, so
// every swarm starts at home again.
//
// EVERY FIREFLY IS AN AGENT with a position and a velocity of its own, steering
// toward where it wants to be with a capped ACCELERATION and a capped speed -
// Reynolds' steering behaviours (arrive, flee, separation), which is the
// textbook for creatures that move plausibly. The first cut was the opposite:
// a swarm centre chained to the ball (a lag paid back by the ball's velocity,
// motes carried by the centre's velocity, leashes), which made every firefly
// swing with every swing of the ball and gain and lose speed in time with it.
// A firefly here cannot follow a swing, because a swing asks for accelerations
// no firefly has.
//
// Where it wants to be is the HOVER SPOT, and the spot is deliberately blind to
// the swing. It is read off the LEVEL, never off the camera: the swarm's way
// forward is the level's authored route (its camera paths, read as geometry),
// and how far along it the player has got is the swarm's own judgement. A cut
// that read the camera controller's committed progress was rejected in play -
// fireflies moving with the camera "feel like they aren't part of the level".
//
// - Along the route, it is the swarm's own PROGRESS: it jumps forward whenever
//   the player's projection onto the route gets further along, and drifts
//   back toward the player at only `PROGRESS_RELAX` m/s when they fall behind
//   it. A swing forward extends it; the swing back barely moves it. Then
//   `LEAD_ROUTE` further along the route's way forward.
// - Across the route, it is the player's offset from the route, heavily
//   smoothed (`OFFSET_SMOOTH`), so the swing's back-and-forth reaches it
//   attenuated.
// - Where the level authors no route (or the player is far from every one),
//   it is the player's position through the same heavy smoothing.
//
// A swarm that names a FIREFLY PATH (`LightObjectData.path`) reads that path
// alone instead of the camera's, and it ENDS: when the player reaches its end
// the swarm stops following, flies back along it at `RETURN_SPEED` and waits
// at its start, noticing the player again only once they have left the
// notice ring and come back into it (see `Swarm.turnBack`).
//
// Each firefly hovers at its own place in the swarm's cloud near the spot,
// trembling there (see THE HOVER), keeps a little apart from its neighbours,
// and FLEES the ball - from where the ball is about to be, and only forward
// or sideways - when it comes within `AVOID_RADIUS`, with a harder
// acceleration than it cruises with: the scatter. Once the ball has passed,
// arriving at its place again is the regroup.
//
// ALWAYS AHEAD. The swarm is partly there to show the player the way, so
// every part of it keeps in front of them along the way forward: the spot
// (MIN_AHEAD), each firefly's place in the cloud (the same), and the scatter.
//
// WHERE IT RESTS. Fireflies fly through scene geometry freely - stopping them
// at solid scenery was built and taken out again the same day, at Tris's word
// that passing through is fine - but they never come to REST in front of it:
// a swarm hovering inside rock points at somewhere the player cannot go. So
// the hover spot is moved to open air that is still ahead of the player
// (`aheadInOpen`), and a firefly's place is drawn in toward the spot until it
// is in the open too (`target`).

import type { LightObjectData } from "../level/levelFormat";

// Yellow-green, which is what a firefly is, and well off both the river's teal
// fill and the lamps' warm flame, so a swarm reads as creatures rather than as
// another lamp.
export const FIREFLY_COLOR = "#c8f060";
// Candela for the WHOLE swarm, served by one pool light at its fireflies'
// centroid. Sized so the ball, a metre from the light, reads clearly against a
// dark cave.
export const FIREFLY_INTENSITY = 5;
// Metres. The swarm's light reaches the rock around the ball, not the room.
export const FIREFLY_RANGE = 5;
// Metres: how close the ball's centre must come to the swarm's HOME, on the
// gameplay plane, for it to start following - where the light authors no
// `wake`. A light with `wake` set uses that instead, and the editor's dashed
// wake ring is the same ring.
export const DEFAULT_FIREFLY_NOTICE = 2.5;
// A swarm's count is clamped to this: each firefly is a CPU step and a vertex
// per frame (and separation is pairwise), and past a couple of dozen a swarm
// reads as a cloud rather than as fireflies.
export const FIREFLY_MAX = 32;
// How many real point lights serve every swarm in a level, at most, handed to
// the swarms nearest the ball. Built once at `setLevel`, sized
// `min(FIREFLY_POOL, swarms)`, never removed while the level is loaded, for the
// same reason as the waking lights' pool (`GLOW_POOL`): the light count is what
// three's lit programs are compiled against.
export const FIREFLY_POOL = 3;

// The longest step a swarm is advanced by, as for the waking lights: a tab
// brought back from the background must not fling every firefly across the
// level on its first frame. A clock that runs backwards steps nothing.
export const MAX_FIREFLY_STEP = 0.1;
// Steering is integrated in steps no longer than this, so a 30 Hz frame flies
// the path a 60 Hz one does.
const SUBSTEP = 1 / 60;

// THE HOVER SPOT, relative to the player's smoothed place (see the header):
// `LEAD_ROUTE` metres along the camera path's way forward, `FOLLOW_LIFT` above,
// and `FOLLOW_Z` in front of the gameplay plane.
//
// The depth matters for the look. At 0.6 m the swarm's light passed a hand's
// width from the front of the river's rock props and tone-mapped a moss pillar
// beside the ball to white (the moss lights' own finding: at the surface a
// point light is an inverse-square hot spot, out in the air the rock is lit
// evenly).
export const LEAD_ROUTE = 2;
export const FOLLOW_LIFT = 0.4;
export const FOLLOW_Z = 0.9;
// Metres the swarm's light hangs IN FRONT of its fireflies, toward the camera.
// One point light stands in for a whole swarm, and a spread-out source has no
// inverse-square hot spot where a point does: hovering ahead of the ball, the
// swarm's spot sits right against whatever rock is in the way, and at the
// fireflies' own depth the light bleached the river's moss pillar to white.
// Pulled forward, it is further from every surface at once, which is what a
// spread-out source looks like from a metre away.
export const LIGHT_FORWARD = 0.8;
// ...and never further than these ahead of the player along the way forward,
// nor nearer. The committed progress is RATCHETED while the player hangs, so a
// swing back leaves it at the swing's forward extent: measured on a 3 m
// pendulum, that parked the swarm 4.9 m from a ball at the back of its swing -
// the edge of the light's own reach. Past the cap the spot is pulled back
// along the route toward the player (still through the smoothing below and the
// fireflies' own acceleration limit, so what reaches them is gentle).
export const MAX_AHEAD = 3.5;
export const MIN_AHEAD = 0.3;
// Seconds of smoothing on the hover spot itself, so a step in it (the
// committed progress re-seating on a new path, a clamp taking over) reaches
// the fireflies as a glide. Short, because it lags a travelling spot by its
// speed times this: 0.3 s ate 0.9 m of the lead on a 3 m/s roll. The
// fireflies' own acceleration limit does the rest of the smoothing.
const SPOT_SMOOTH = 0.1;
// Seconds of smoothing on the player's offset from the path (and, with no
// path, on the player's position), cascaded twice. A second-order low-pass:
// a swing at 0.5 Hz reaches the spot at about a fifth of its size.
export const OFFSET_SMOOTH = 0.5;
// Seconds the way forward takes to turn to a new direction of the path, which
// rounds the corners of the route's polyline.
const HEADING_TURN = 0.4;
// Metres per second the swarm's own progress along the route drifts back
// toward a player who has fallen behind it. Slow, so the back half of a swing
// barely moves it, and not zero, so a player who turns round and goes back
// is found again.
export const PROGRESS_RELAX = 0.6;
// ...and never more than this many metres of route ahead of the player's own
// projection onto it. A route that doubles back on itself (an upper run back
// over a lower one) puts a player who FALLS from the one to the other tens
// of metres further back along it in a frame: in session-1669f the player
// dropped from s = 34 to s = 9, the swarm's progress stayed at 34 - on the
// upper run, 7 m above them - and drifted back at PROGRESS_RELAX for ten
// seconds while the player went unlit. MAX_AHEAD did not catch it, being
// measured along the way forward and not up it. Within this window a
// swing-back still barely moves the progress.
const PROGRESS_WINDOW = 3.5;
// Metres of route the player's projection may move in one frame before it is
// a JUMP - a fall onto another part of a route that doubles back - after
// which the swarm's progress starts again from the player rather than being
// held at the window's far edge.
const ROUTE_JUMP = 2;
// A route is the swarm's only while the player is within this many metres of
// it; further, the swarm hovers over the player with no lead. And a nearer
// route takes over only when it is nearer by `ROUTE_SWITCH`, so a player
// between two does not flip the swarm between them.
const ROUTE_REACH = 6;
const ROUTE_SWITCH = 0.5;
// A FIREFLY PATH's end (see the header): the player has reached it once their
// projection onto the path is within this many metres of its far end.
const PATH_END_SLACK = 0.1;
// Metres per second the swarm's spot flies back along its firefly path to the
// start once the player has reached the end: an unhurried flight home, well
// under the cruise so the fireflies keep up with it as a knot.
export const RETURN_SPEED = 2;
// WHERE IT RESTS (see the header). The hover spot is kept this clear of rock,
// and always AHEAD of the player: one in rock is looked for in the open at
// ahead distances from where it was down to MIN_AHEAD, in steps of
// `SPOT_SEARCH_STEP`, each at these heights off the way forward - never
// behind the player. The first cut pulled it back toward the ball and on PAST
// it, and a swarm near a wall ahead went behind the player - played, and
// wrong: the swarm is there to show the way. Boxed in with rock all round the
// way ahead, it hovers `SPOT_BOXED_LIFT` above the player.
const SPOT_CLEARANCE = 0.5;
const SPOT_SEARCH_STEP = 0.3;
const SPOT_SEARCH_HEIGHTS: readonly number[] = [0, 0.4, -0.4, 0.8, -0.8, 1.2];
const SPOT_BOXED_LIFT = 0.8;
// A firefly's own place in the cloud is kept this clear of rock too, by
// drawing it in toward the spot (to these fractions of itself) until it is.
const SLOT_CLEARANCE = 0.3;
const SLOT_SHRINK: readonly number[] = [0.6, 0.3, 0];

// THE LEASH. No firefly ever strays further from the hover spot than the
// swarm's own detection range (`SwarmParams.notice`, the `wake` ring), measured
// on the plane as the ring is - a swarm is a thing in one place, not a spray.
// Past `LEASH_SOFT` of the range it is pulled back, harder the further, up to
// `LEASH_ACCEL`; at the range itself it stops, losing the part of its velocity
// going further out. A firefly's place in the cloud is never more than
// `LEASH_SLOT` of the range out, so a swarm with a small range rests well
// inside it. A firefly in TRANSIT - the swarm has just noticed the ball, and
// its spot has left home - is not held until it has first come within the
// range.
const LEASH_SOFT = 0.7;
const LEASH_ACCEL = 20;
const LEASH_SLOT = 0.6;
// A firefly in rock heads for the open at no less than this speed (m/s),
// with this much more acceleration (m/s²) than it cruises with.
const ROCK_EXIT_SPEED = 2;
const ROCK_EXIT_ACCEL = 12;

// THE HOVER. Each firefly has its own PLACE in the swarm's cloud - a point
// near the spot, drawn once when the swarm is built and kept: within its own
// radius (metres, at home and once following), flattened vertically, and up
// to `SLOT_Z` toward or away from the camera. There are no waypoints: a cut
// that sent each firefly to a fresh random point every second or few was
// played and rejected - near rock it re-picked every frame, and the swarm
// jumped between points. What keeps a firefly alive at its place is:
//
// - JITTER. A push of up to `JITTER_ACCEL` in a random direction, redrawn
//   every `JITTER_INTERVAL` seconds, so a firefly hanging at its place
//   trembles there and its drift is never a clean line.
// - DARTS. Every `DART_INTERVAL` seconds, a flit in a random direction - the
//   sudden hop sideways a firefly makes for no reason anyone can see - at
//   `DART_SPEED` over its own flight, reached with up to `DART_ACCEL`, and
//   never further than `DART_DISTANCE`: the dart ends the moment it has
//   covered that, and for `DART_SETTLE` seconds after the firefly sheds the
//   extra speed hard (steering over `DART_SETTLE_STEER`), so it does not
//   coast on. The first cut pushed for a fixed time instead (18 m/s² for
//   0.12 s, 2.2 m/s gained) and let the firefly coast off it, which carried
//   it 0.6 m or more: too far, too quickly.
//
// Both are drawn from the swarm's seeded generator (so two builds of a level
// still fly the same swarm) and neither reads the ball.
//
// CALM. A firefly spends most of its time HOVERING: an earlier cut (a 5 m/s²
// jitter redrawn every 0.08-0.25 s, a dart every 1.5-5 s) had fireflies under
// 0.3 m/s only 8% of the time, averaging 0.8 m/s with 19 darts a minute each -
// "constantly darting around everywhere", in play. So the jitter trembles
// rather than scribbles, darts are rare, and a firefly closes on its place at
// no more than `WANDER_SPEED` - rising to the full cruise only once it is
// more than `WANDER_NEAR`..`WANDER_FAR` metres off, which is a player who has
// moved on.
export const HOME_SPREAD: readonly [number, number] = [0.12, 0.4];
export const HOVER_SPREAD: readonly [number, number] = [0.25, 0.8];
const SLOT_Z = 0.25;
export const JITTER_ACCEL = 1.2;
const JITTER_INTERVAL: readonly [number, number] = [0.15, 0.4];
export const WANDER_SPEED = 0.35;
const WANDER_NEAR = 1.5;
const WANDER_FAR = 3;
export const DART_DISTANCE = 0.25;
export const DART_SPEED = 1.5;
const DART_ACCEL = 12;
// A dart that has not covered its distance in this long (it was held back -
// by the leash, a flee) ends anyway.
const DART_TIMEOUT = (2 * DART_DISTANCE) / DART_SPEED;
const DART_SETTLE = 0.2;
const DART_SETTLE_STEER = 0.1;
const DART_INTERVAL: readonly [number, number] = [4, 10];
// HOPS. The calm above is for a firefly AT its place - within `HOVER_NEAR`.
// Further off it does not glide there: it HOPS, a run of darts aimed at its
// place (give or take `HOP_SPREAD` radians), each no further than
// DART_DISTANCE and quicker than an idle dart (`HOP_SPEED`), with a pause of
// `HOP_PAUSE` seconds after each settles. A cut that closed every gap with a
// smooth drift at WANDER_SPEED was played and read as gliding - "it doesn't
// look right"; a firefly gets somewhere in a flurry of short hops and then
// hangs there.
const HOVER_NEAR = 0.5;
const HOVER_SETTLED = 0.3;
const HOP_SPEED = 2.5;
// A HOP's reach, which is more than an idle dart's DART_DISTANCE: a hop is a
// firefly getting somewhere, and at 0.25 m a hop could not keep up with a
// rolling player.
const HOP_REACH = 0.5;
// How hard a hop gets to its speed, and how long it settles after: a hop is a
// SNAP. At the idle dart's 12 m/s² it took 0.2 s to reach speed, and the
// hop read as a swell rather than a dart.
const HOP_ACCEL = 40;
// 0.08 s shed only about 1 m/s of a hop's speed: the firefly coasted half a
// metre past its place, out of it again, and hopped back - over and over.
const HOP_SETTLE = 0.15;
// The share of the spot's own motion a firefly near its place is carried by;
// hops make up the rest (see ARRIVE in `Swarm.substep`). None, since the spot
// is COMMITTED (see SPOT_DEADBAND): the smooth motion it would carry is the
// ideal spot's, which the committed one does not follow, so a carried firefly
// drifted off its place and had to hop back.
const CARRY = 0;
// THE DISTANCE BUFFER. The swarm COMMITS to a hover spot and keeps it until
// the ideal one - which moves with every move the player makes - is more than
// this far from it on the plane (or the player has drawn level with it, or it
// is in rock). A spot that slid with the player sent the fireflies hopping to
// a new place at every little move: in session-663f, rolling the ball about a
// half turn back and forth (0.6 m) moved the spot 0.7 m sideways and 0.5 m up
// and down as the open-air search ahead picked a new height, and the swarm
// darted between three places.
const SPOT_DEADBAND = 1.0;
// ...and re-committed when the player has come within this far of it along
// the way forward, and then placed further ahead by this many seconds of the
// player's forward speed (see `Swarm.commitSpot`).
const RECOMMIT_AHEAD = 0.3;
const COMMIT_LEAD = 0.3;
const HOP_SPREAD = 0.45;
const HOP_PAUSE: readonly [number, number] = [0.05, 0.25];
// How many directions are drawn looking for a dart that lands in the open
// (see `Swarm.wander`).
const DART_TRIES = 4;
// Seconds to open from the home knot to the hover spread, and back.
const SPREAD_EASE = 1.5;

// FLIGHT. A firefly arrives at its point at a speed proportional to how far
// off it is (`ARRIVE_TIME` seconds to cover it), capped at `CRUISE_SPEED`, and
// turns its velocity toward that over `STEER_TIME` seconds - with its
// acceleration capped at `CRUISE_ACCEL`. Metres, seconds.
//
// The cruise is faster than a rolling ball: at 2.5 m/s a 3 m/s roll left the
// swarm 2.2 m BEHIND the player, since a firefly has to outpace the player to
// get in front of them at all.
export const CRUISE_SPEED = 4;
export const CRUISE_ACCEL = 5;
const ARRIVE_TIME = 0.6;
const STEER_TIME = 0.4;
// Left well behind, a firefly CHASES: its speed cap rises from CRUISE_SPEED at
// `CHASE_FROM` metres off its point to `CHASE_SPEED` at `CHASE_FULL`. Only the
// cap - its acceleration is the same - so a player who has run away is chased
// down, plausibly, and a player hovering near is not.
export const CHASE_SPEED = 8;
const CHASE_FROM = 2;
const CHASE_FULL = 5;
// A firefly over its speed cap (a flee ending, a dart ending) BRAKES down to it
// at this deceleration rather than being clamped: the clamp chopped a fleeing
// firefly's speed in one frame, a 71 m/s² jolt.
const BRAKE = 6;

// THE SCATTER. A firefly flees the ball when the ball - where it will be in
// `AVOID_LOOKAHEAD` seconds at its smoothed velocity - comes within
// `AVOID_RADIUS` of it on the plane, harder the closer, with an acceleration up
// to `FLEE_ACCEL` and a speed up to `FLEE_SPEED`. A little sideways, each
// firefly its own way, so a swarm scatters rather than retreating in a block.
export const AVOID_RADIUS = 1.0;
const AVOID_LOOKAHEAD = 0.3;
export const FLEE_ACCEL = 12;
export const FLEE_SPEED = 4.5;
const FLEE_SWERVE = 0.6;
// The ball's velocity, read off its drawn position, smoothed over this many
// seconds; a jump longer than `TELEPORT` in one frame (a seek) is not speed.
const VELOCITY_SMOOTH = 0.1;
const TELEPORT = 2;

// Separation: fireflies closer than `SEPARATION` metres push apart, up to
// `SEPARATION_ACCEL`, so a swarm hovers as a loose cloud rather than a knot.
const SEPARATION = 0.25;
const SEPARATION_ACCEL = 2;

// The blink: every firefly glows at least BLINK_FLOOR of its full brightness,
// and flares to full once a cycle of its own length, sharply (the exponent).
const BLINK_FLOOR = 0.45;
const BLINK_PERIOD: readonly [number, number] = [1.6, 4.2];
const BLINK_SHARPNESS = 6;

// A swarm's authored law with every default applied. Metres.
export interface SwarmParams {
  count: number;
  notice: number;
  // The firefly path it guides the player along, by id, or null for the
  // camera paths.
  path: number | null;
}

// The swarm a light object authors, or null for an ordinary light: absent,
// zero or negative `fireflies`, and every spot (the pool is point lights, and
// the editor clears `fireflies` when a light is turned into a spot).
export function swarmParams(data: LightObjectData): SwarmParams | null {
  if (data.kind === "spot") return null;
  const count = Math.min(FIREFLY_MAX, Math.floor(data.fireflies ?? 0));
  if (!(count > 0)) return null;
  const wake = data.wake ?? 0;
  return {
    count,
    notice: wake > 0 ? wake : DEFAULT_FIREFLY_NOTICE,
    path: data.path ?? null,
  };
}

export function isSwarm(data: LightObjectData): boolean {
  return swarmParams(data) !== null;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Vec2 {
  x: number;
  y: number;
}

// What a swarm reads about the level: its authored routes (its camera paths,
// read as geometry), in the swarm's frame (three's: y up, metres). The rig
// builds it over the level's paths (`LightRig.swarmPlace`); nothing in it
// writes anything, and nothing in it is the camera's state.
export interface SwarmPlace {
  // How many authored routes the level has.
  routes: number;
  // Whether the one route is the swarm's own FIREFLY PATH, whose end is where
  // it leaves the player and goes back to the start (see the header). Camera
  // paths do not end: a swarm reading them follows for the rest of the run.
  ends: boolean;
  // Route `i`'s arc length.
  length(i: number): number;
  // Route `i`'s nearest point to (x, y) as an arc length and a distance -
  // confined to a window around `near` when given, so on a switchback the
  // answer stays on the branch the ball is on.
  project(i: number, x: number, y: number, near: number | null): { s: number; dist: number };
  point(i: number, s: number): Vec2;
  // Unit, toward increasing arc length: the authored way forward.
  tangent(i: number, s: number): Vec2;
  // Whether a disc of radius `r` at (x, y) overlaps the level's solid
  // scenery - somewhere the player cannot go. Fireflies fly through it freely;
  // they only never REST there (see "Where it rests" in the header).
  solid(x: number, y: number, r: number): boolean;
}

// A level with no routes and no rock: the swarm hovers over the player with
// no lead.
export const OPEN_PLACE: SwarmPlace = {
  routes: 0,
  ends: false,
  length: () => 0,
  project: () => ({ s: 0, dist: Infinity }),
  point: () => ({ x: 0, y: 0 }),
  tangent: () => ({ x: 1, y: 0 }),
  solid: () => false,
};

// One firefly: its seeded character, fixed at birth, and its twitch.
interface Mote {
  // Which way it swerves when it flees, +1 or -1.
  swerve: number;
  blinkRate: number;
  blinkPhase: number;
  // Its place in the cloud (see THE HOVER), fixed at birth: an offset from
  // the spot, x and y in units of its radius, z in metres.
  slot: Vec3;
  // Its twitch, which changes as it flies (see JITTER and DARTS): its jitter
  // push and the time left on it; the time until its next dart, and the dart
  // it is in (the time left before it gives up, its direction, and where it
  // started, which is what DART_DISTANCE is measured from), and the settle
  // after one.
  jitter: Vec3;
  jitterLeft: number;
  dartIn: number;
  dartLeft: number;
  dartDir: Vec2;
  dartFrom: Vec2;
  // This dart's reach and speed: DART_DISTANCE and DART_SPEED for a random
  // dart, less and faster for a HOP (see HOPS); and the pause before the next
  // hop.
  dartReach: number;
  dartSpeed: number;
  // ...and how hard it gets to that speed, and how long it settles after.
  dartAccel: number;
  dartSettleFor: number;
  hopWait: number;
  // Whether it is away from its place and hopping back (see HOPS).
  hopping: boolean;
  dartSettle: number;
  // Whether it has come within the detection range of the spot since the
  // swarm last changed what it was doing (see THE LEASH): until then it is
  // in transit, and the leash does not hold it.
  leashed: boolean;
}

// A small, fast, seeded generator (mulberry32): two builds of the same level
// must fly the same swarm, and a headless grab must be reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(range: readonly [number, number], u: number): number {
  return range[0] + (range[1] - range[0]) * u;
}

// One swarm's life, in three's frame (metres, y up, z toward the camera). The
// rig hands it the home (read off the swarm's body), the ball and the camera
// path's guide each frame.
export class Swarm {
  readonly params: SwarmParams;
  private readonly motes: Mote[] = [];
  // Positions and velocities, packed xyz.
  readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  // Each firefly's brightness this frame, 0..1.
  readonly brightness: Float32Array;
  // Whether the ball has been noticed. Once it has, the swarm keeps the ball
  // company for the rest of the run - its purpose is that the player stays
  // lit - or, on a firefly path, until the player reaches the path's end.
  following = false;
  // Where along its firefly path the swarm is flying back to the start, or
  // null when it is not (see `turnBack`).
  private returnS: number | null = null;
  // Where it waits once it has flown back: the path's start, at its home's
  // depth. Null = its home, which is where every swarm waits at first.
  private rest: Vec3 | null = null;
  // Whether it may notice the ball. A swarm that has just left the player at
  // its path's end is not, until the ball has been outside the notice ring of
  // where it waits: a path that ends near its own start would otherwise find
  // the player still there, follow them to the end they are standing at, and
  // turn back again, over and over.
  private armed = true;
  // 0 = the home knot, 1 = the hover spread.
  private spread = 0;
  // The swarm's own clock, the sum of the steps it was given, so a clock that
  // jumps or runs backwards cannot jump the wander.
  private time = 0;
  // The swarm's seeded generator, which the wander keeps drawing from as it
  // flies: the same swarm flies the same scribble for the same clock.
  private readonly random: () => number;
  // The ball as last seen and its smoothed velocity (for the flee's
  // lookahead), both on the plane.
  private ballWas: Vec2 | null = null;
  private readonly ballVelocity = { x: 0, y: 0 };
  // The player's offset from the route (or, with no route, their position),
  // as the two stages of the low-pass. Null until first read, and re-seeded
  // when the swarm switches between the two, since they are different
  // quantities.
  private offset: { a: Vec2; b: Vec2; route: number | null } | null = null;
  // The route the swarm is using (an index into `SwarmPlace`), the ball's arc
  // length along it this frame, and the swarm's own PROGRESS along it (see the
  // header). Null route = none in reach.
  private route: number | null = null;
  private ballS = 0;
  private progress = 0;
  // The route's way forward as the swarm has turned to it (unit), or null
  // until there has been a route.
  private heading: Vec2 | null = null;
  // The hover spot this frame, and how fast it is moving (see ARRIVE below).
  private spot: Vec3;
  private freeSpot: Vec3;
  private spotVelocity: Vec3 = { x: 0, y: 0, z: 0 };
  // The spot the swarm has committed to, and the ideal it committed at (see
  // `commitSpot`), or null until it follows the ball.
  private committed: { ideal: Vec3; spot: Vec3 } | null = null;
  // This frame's ball and level, for `target`.
  private ballNow: Vec3 | null = null;
  private placeNow: SwarmPlace = OPEN_PLACE;

  constructor(params: SwarmParams, home: Vec3, seed: number) {
    this.params = params;
    const n = params.count;
    this.positions = new Float32Array(n * 3);
    this.velocities = new Float32Array(n * 3);
    this.brightness = new Float32Array(n);
    this.spot = { ...home };
    this.freeSpot = { ...home };
    const r = rng(seed * 7919 + 17);
    this.random = r;
    for (let i = 0; i < n; i++) {
      this.motes.push({
        swerve: r() < 0.5 ? -1 : 1,
        blinkRate: (Math.PI * 2) / mix(BLINK_PERIOD, r()),
        blinkPhase: r() * Math.PI * 2,
        slot: this.randomSlot(),
        jitter: { x: 0, y: 0, z: 0 },
        jitterLeft: 0,
        dartIn: mix(DART_INTERVAL, r()),
        dartLeft: 0,
        dartFrom: { x: 0, y: 0 },
        dartReach: DART_DISTANCE,
        dartSpeed: DART_SPEED,
        dartAccel: DART_ACCEL,
        dartSettleFor: DART_SETTLE,
        hopWait: 0,
        hopping: false,
        dartSettle: 0,
        dartDir: { x: 1, y: 0 },
        leashed: false,
      });
      const t = this.target(i);
      this.positions[i * 3] = t.x;
      this.positions[i * 3 + 1] = t.y;
      this.positions[i * 3 + 2] = t.z;
    }
    this.blink();
  }

  // Advance by `dt` seconds. `home` is where the swarm idles; `ball` is the
  // ball's centre, or null where there is none (the editor, a level without
  // the ball), in which case the swarm stays home; `place` is what it may read
  // about the level - its authored routes.
  step(dt: number, home: Vec3, ball: Vec3 | null, place: SwarmPlace = OPEN_PLACE): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, MAX_FIREFLY_STEP);
    // Noticed from where it WAITS - its home, or its path's start once it has
    // flown back there - and never while it is still flying back.
    const waits = this.rest ?? home;
    const near = ball !== null && Math.hypot(ball.x - waits.x, ball.y - waits.y) <= this.params.notice;
    if (ball && !near) this.armed = true;
    if (!this.following && this.returnS === null && this.armed && near) {
      this.following = true;
      // The spot is about to leave home for the ball: every firefly is in
      // transit until it has caught up with it.
      for (const m of this.motes) m.leashed = false;
    }
    this.readBall(dt, ball);
    this.ballNow = ball;
    this.placeNow = place;
    let want = { held: home, free: home };
    let goal = home;
    if (this.following && ball) {
      want = this.hoverSpot(dt, ball, place);
      if (this.atPathEnd(place)) this.turnBack(place, home);
      else goal = this.commitSpot(want.held, ball, place);
    }
    if (!this.following) {
      goal = this.homeward(dt, place, home);
      want = { held: goal, free: goal };
    }
    const k = 1 - Math.exp(-dt / SPOT_SMOOTH);
    this.spot.x += (goal.x - this.spot.x) * k;
    this.spot.y += (goal.y - this.spot.y) * k;
    this.spot.z += (goal.z - this.spot.z) * k;
    // The velocity the fireflies are carried by is the FREE spot's - the one
    // before the MAX_AHEAD cap - through the same smoothing. The free spot is
    // the swarm's progress, which barely swings; the cap does (it drags
    // the spot back with every swing-back), and carrying ITS velocity put the
    // swing straight back into every firefly: the light swung 64% as far as
    // the ball on a 3 m pendulum. The cap still pulls them in, through the
    // closing term alone, which is slow.
    //
    // Carrying the cap's pull as well, smoothed over one or two seconds so a
    // swing would mostly cancel out of it, was tried for a player backtracking
    // (who a swarm carried by the free spot alone trails by up to 4.9 m): it
    // got that to 3.3-3.8 m and made the settled swing livelier (1.2 -> 1.4-1.5
    // m/s mean), and was taken out. The backtrack's knob is PROGRESS_RELAX.
    const was = { ...this.freeSpot };
    this.freeSpot.x += (want.free.x - this.freeSpot.x) * k;
    this.freeSpot.y += (want.free.y - this.freeSpot.y) * k;
    this.freeSpot.z += (want.free.z - this.freeSpot.z) * k;
    this.spotVelocity = {
      x: (this.freeSpot.x - was.x) / dt,
      y: (this.freeSpot.y - was.y) / dt,
      z: (this.freeSpot.z - was.z) / dt,
    };
    const steps = Math.ceil(dt / SUBSTEP - 1e-9);
    const h = dt / steps;
    for (let s = 0; s < steps; s++) this.substep(h, ball, place);
    this.blink();
  }

  // The ball's smoothed velocity on the plane, for the flee's lookahead.
  private readBall(dt: number, ball: Vec3 | null): void {
    if (!ball) {
      this.ballWas = null;
      return;
    }
    const was = this.ballWas;
    this.ballWas = { x: ball.x, y: ball.y };
    if (!was) return;
    if (Math.hypot(ball.x - was.x, ball.y - was.y) > TELEPORT) {
      this.ballVelocity.x = 0;
      this.ballVelocity.y = 0;
      return;
    }
    const k = 1 - Math.exp(-dt / VELOCITY_SMOOTH);
    this.ballVelocity.x += ((ball.x - was.x) / dt - this.ballVelocity.x) * k;
    this.ballVelocity.y += ((ball.y - was.y) / dt - this.ballVelocity.y) * k;
  }

  // Where the swarm wants to hover this frame (see the header).
  // `held` is the spot the fireflies hover about; `free` is the same before the
  // MAX_AHEAD / MIN_AHEAD cap, whose velocity is the one they are carried by.
  private hoverSpot(dt: number, ball: Vec3, place: SwarmPlace): { held: Vec3; free: Vec3 } {
    const route = this.readRoute(dt, ball, place);

    // What is smoothed: the player's offset from the route, or with no route
    // their position. Switching re-seeds the filter at the current value.
    const foot = route !== null ? place.point(route, this.ballS) : null;
    const raw = foot ? { x: ball.x - foot.x, y: ball.y - foot.y } : { x: ball.x, y: ball.y };
    if (!this.offset || this.offset.route !== route) {
      this.offset = { a: { ...raw }, b: { ...raw }, route };
    }
    const k = 1 - Math.exp(-dt / OFFSET_SMOOTH);
    const p = this.offset;
    p.a.x += (raw.x - p.a.x) * k;
    p.a.y += (raw.y - p.a.y) * k;
    p.b.x += (p.a.x - p.b.x) * k;
    p.b.y += (p.a.y - p.b.y) * k;

    if (route === null) {
      const at = { x: p.b.x, y: p.b.y + FOLLOW_LIFT, z: FOLLOW_Z };
      return { held: at, free: at };
    }

    // The way forward, ROTATED toward the route's over HEADING_TURN. Blending
    // the vectors and renormalising never turns a dead reversal - (1,0)
    // toward (-1,0) normalises straight back to (1,0) - so a switchback in
    // the route turns over the top instead, the way round whose midpoint
    // points up.
    const dir = place.tangent(route, this.progress);
    if (!this.heading) this.heading = { ...dir };
    else {
      const from = Math.atan2(this.heading.y, this.heading.x);
      let turn = Math.atan2(dir.y, dir.x) - from;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      if (Math.abs(turn) > Math.PI - 1e-3) turn = this.heading.x >= 0 ? Math.PI : -Math.PI;
      const a = from + turn * (1 - Math.exp(-dt / HEADING_TURN));
      this.heading = { x: Math.cos(a), y: Math.sin(a) };
    }
    const hd = this.heading;
    const at = place.point(route, this.progress);
    const x = at.x + p.b.x + hd.x * LEAD_ROUTE;
    const y = at.y + p.b.y + hd.y * LEAD_ROUTE;
    // Kept between MIN_AHEAD and MAX_AHEAD of the player along the way
    // forward (see MAX_AHEAD), by sliding it along that axis only.
    const ahead = (x - ball.x) * hd.x + (y - ball.y) * hd.y;
    const slide =
      ahead > MAX_AHEAD ? MAX_AHEAD - ahead : ahead < MIN_AHEAD ? MIN_AHEAD - ahead : 0;
    return {
      held: { x: x + hd.x * slide, y: y + hd.y * slide + FOLLOW_LIFT, z: FOLLOW_Z },
      free: { x, y: y + FOLLOW_LIFT, z: FOLLOW_Z },
    };
  }

  // THE COMMITTED SPOT (see SPOT_DEADBAND). `ideal` is this frame's hover
  // spot as the route and the player put it - BEFORE any search for open air,
  // so it moves smoothly with the player. The swarm keeps the spot it
  // committed to until that ideal has moved more than SPOT_DEADBAND from the
  // ideal it committed at, until the player has drawn level with the spot (it
  // would no longer be ahead), or until the spot is in rock. Then it commits
  // afresh: the ideal, further ahead if the swarm is progressing (see
  // COMMIT_LEAD), moved into open air ahead of the player (`aheadInOpen`).
  //
  // The buffer is measured on the ideal, not on where the search put the
  // spot: the search picks between heights as the ideal slides past rock, and
  // measured on its answer, a flip of height alone (0.4-0.8 m) crossed the
  // buffer - in session-663f, three moves to nearly the same place while the
  // player rolled the ball half a turn.
  private commitSpot(ideal: Vec3, ball: Vec3, place: SwarmPlace): Vec3 {
    const c = this.committed;
    const hd = this.route !== null ? this.heading : null;
    const stale =
      !c ||
      Math.hypot(ideal.x - c.ideal.x, ideal.y - c.ideal.y) > SPOT_DEADBAND ||
      (hd !== null && (c.spot.x - ball.x) * hd.x + (c.spot.y - ball.y) * hd.y < RECOMMIT_AHEAD) ||
      place.solid(c.spot.x, c.spot.y, SPOT_CLEARANCE / 2);
    if (!stale) return c.spot;
    // Progressing along the route, the new spot goes further ahead by
    // COMMIT_LEAD seconds of the swarm's own progress (never past
    // MAX_AHEAD): committed only LEAD_ROUTE ahead, a player rolling at 3 m/s
    // was level with it again in 0.4 s and left the swarm behind. The
    // progress, not the ball's own speed, because a swing moves the progress
    // only as it extends.
    let raw = { ...ideal };
    if (hd) {
      const v = this.spotVelocity;
      const forward = Math.max(0, v.x * hd.x + v.y * hd.y);
      const ahead = (ideal.x - ball.x) * hd.x + (ideal.y - ball.y) * hd.y;
      const extra = Math.min(forward * COMMIT_LEAD, Math.max(0, MAX_AHEAD - ahead));
      raw = { x: ideal.x + hd.x * extra, y: ideal.y + hd.y * extra, z: ideal.z };
    }
    const spot = this.aheadInOpen(raw, ball, hd, place);
    // A MOVE, not a nudge - further than a firefly's place from the old spot
    // - puts every firefly in TRANSIT, so the leash lets go until each has
    // caught up with the new spot. Held by the leash, the fireflies were
    // dragged with the spot as it glided to its new place, up to 0.9 m in one
    // frame: in session-1669f they appeared to teleport to the player and
    // back.
    if (c && Math.hypot(spot.x - c.spot.x, spot.y - c.spot.y) > HOVER_NEAR) {
      for (const m of this.motes) m.leashed = false;
    }
    this.committed = { ideal: { ...ideal }, spot };
    return spot;
  }

  // `spot`, or - where it sits in rock - a point in the open that is still
  // AHEAD of the player along the way forward `hd` (see WHERE IT RESTS): the
  // ahead distances from the spot's own down to MIN_AHEAD, each at the
  // SPOT_SEARCH_HEIGHTS off the way forward, first clear wins. With no way
  // forward (no route) only the heights are tried. Boxed in, above the player.
  private aheadInOpen(spot: Vec3, ball: Vec3, hd: Vec2 | null, place: SwarmPlace): Vec3 {
    if (!place.solid(spot.x, spot.y, SPOT_CLEARANCE)) return spot;
    // "Up" off the way forward: the way forward turned a quarter toward +y,
    // or plain up with no route.
    const nx = hd ? -hd.y : 0;
    const ny = hd ? hd.x : 1;
    const up = ny >= 0 ? { x: nx, y: ny } : { x: -nx, y: -ny };
    const base = hd ? (spot.x - ball.x) * hd.x + (spot.y - ball.y) * hd.y : 0;
    const side = hd ? { x: spot.x - hd.x * base, y: spot.y - hd.y * base } : spot;
    for (let a = base; a >= (hd ? MIN_AHEAD : base) - 1e-9; a -= SPOT_SEARCH_STEP) {
      for (const hgt of SPOT_SEARCH_HEIGHTS) {
        const x = side.x + (hd ? hd.x * a : 0) + up.x * hgt;
        const y = side.y + (hd ? hd.y * a : 0) + up.y * hgt;
        if (!place.solid(x, y, SPOT_CLEARANCE)) return { x, y, z: spot.z };
      }
      if (!hd) break;
    }
    return { x: ball.x, y: ball.y + SPOT_BOXED_LIFT, z: spot.z };
  }

  // Which route the swarm is using, and its progress along it, updated for
  // this frame's ball; null when the player is in reach of none.
  private readRoute(dt: number, ball: Vec3, place: SwarmPlace): number | null {
    // The nearest route to the player, globally. The one already in use keeps
    // them unless another is nearer by ROUTE_SWITCH, and it answers from a
    // window around the ball's last arc length, so a switchback in it does not
    // jump the swarm to the other branch.
    let best: number | null = null;
    let bestDist = ROUTE_REACH;
    for (let i = 0; i < place.routes; i++) {
      const d = place.project(i, ball.x, ball.y, null).dist;
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    let next = best;
    let s = best !== null ? place.project(best, ball.x, ball.y, null).s : 0;
    if (this.route !== null) {
      const kept = place.project(this.route, ball.x, ball.y, this.ballS);
      if (kept.dist <= ROUTE_REACH && (best === null || kept.dist <= bestDist + ROUTE_SWITCH)) {
        next = this.route;
        s = kept.s;
      }
    }
    if (next === null) {
      this.route = null;
      return null;
    }
    if (next !== this.route) {
      // A new route: its progress starts at the player.
      this.route = next;
      this.progress = s;
    } else if (s > this.progress) {
      this.progress = s;
    } else if (Math.abs(s - this.ballS) > ROUTE_JUMP) {
      // The player's place on the route JUMPED - they fell onto another part
      // of it - so the swarm's progress starts again from them, and it
      // resumes a point just ahead of them.
      this.progress = s;
    } else {
      // Drifting back slowly - but never more than PROGRESS_WINDOW of route
      // ahead of the player, which a fall to another part of the route
      // (see PROGRESS_WINDOW) snaps it back within at once.
      this.progress = Math.min(
        s + PROGRESS_WINDOW,
        Math.max(s, this.progress - PROGRESS_RELAX * dt),
      );
    }
    this.ballS = s;
    return next;
  }

  // Whether the player, this frame, has reached the end of the swarm's own
  // firefly path (see the header). Only a path that ends does, and only while
  // it is the route in use - the player within ROUTE_REACH of it.
  private atPathEnd(place: SwarmPlace): boolean {
    return place.ends && this.route === 0 && this.ballS >= place.length(0) - PATH_END_SLACK;
  }

  // Leave the player at the path's end: the swarm stops following and flies
  // back along the path, from its own progress, to the start (`homeward`),
  // where it waits - no longer noticing the player until they have left the
  // notice ring of that start (see `armed`). Everything it knew about the
  // player's route is dropped, since the next time it follows it starts again
  // from wherever they are.
  private turnBack(place: SwarmPlace, home: Vec3): void {
    this.following = false;
    this.armed = false;
    this.returnS = Math.min(this.progress, place.length(0));
    const start = place.point(0, 0);
    this.rest = { x: start.x, y: start.y, z: home.z };
    this.route = null;
    this.heading = null;
    this.offset = null;
    this.committed = null;
    // The spot is about to leave: every firefly is in transit again.
    for (const m of this.motes) m.leashed = false;
  }

  // Where a swarm that is not following hovers: along its firefly path at
  // RETURN_SPEED toward the start while it flies back, at its home's depth,
  // then where it waits.
  private homeward(dt: number, place: SwarmPlace, home: Vec3): Vec3 {
    if (this.returnS !== null && place.routes > 0) {
      this.returnS = Math.max(0, this.returnS - RETURN_SPEED * dt);
      const p = place.point(0, this.returnS);
      if (this.returnS === 0) this.returnS = null;
      return { x: p.x, y: p.y, z: home.z };
    }
    this.returnS = null;
    return this.rest ?? home;
  }

  // Whether the swarm is flying back along its firefly path - for a probe.
  get returning(): boolean {
    return this.returnS !== null;
  }


  private substep(h: number, ball: Vec3 | null, place: SwarmPlace): void {
    this.time += h;
    this.spread = Math.min(1, Math.max(0, this.spread + (this.following ? h : -h) / SPREAD_EASE));
    const p = this.positions;
    const v = this.velocities;
    const n = this.motes.length;
    // Where the ball will be, for the flee.
    const threat =
      this.following && ball
        ? {
            x: ball.x + this.ballVelocity.x * AVOID_LOOKAHEAD,
            y: ball.y + this.ballVelocity.y * AVOID_LOOKAHEAD,
          }
        : null;
    for (let i = 0; i < n; i++) {
      const m = this.motes[i]!;
      const j = i * 3;
      const t = this.target(i);
      const dx = t.x - p[j]!;
      const dy = t.y - p[j + 1]!;
      const dz = t.z - p[j + 2]!;
      const off = Math.hypot(dx, dy, dz);
      this.wander(i, h, place, dx, dy, off);

      // ARRIVE, as PURSUIT: a desired velocity that is the hover spot's own
      // velocity plus a closing speed toward its point, slowing as it gets
      // there, capped at the cruise speed - or the chase speed, when left far
      // behind. Without the spot's velocity a firefly trails a moving spot by
      // speed x ARRIVE_TIME, which on a 3 m/s roll put the swarm 2.5 m behind
      // the player; the spot is the one thing here that does not swing, so
      // carrying its velocity does not couple the fireflies to the swing.
      const chase = Math.min(1, Math.max(0, (off - CHASE_FROM) / (CHASE_FULL - CHASE_FROM)));
      let speedCap = CRUISE_SPEED + (CHASE_SPEED - CRUISE_SPEED) * chase;
      const sv = this.spotVelocity;
      // IN ROCK, while keeping the ball company, a firefly is IN TRANSIT and
      // never lingers (see "Where it rests" in the header): it closes on its
      // point - which is always in the open - at no less than
      // `ROCK_EXIT_SPEED`, with `ROCK_EXIT_ACCEL` more to do it with, and
      // neither jitters nor darts until it is out. Clearing the resting places
      // alone was not enough: a firefly's own darts and jitter carry it 0.2 -
      // 0.6 m past its point, and at a wall that is into the rock, where it
      // hung about for 7-15% of the time whatever the clearance.
      const inRock = this.following && place.solid(p[j]!, p[j + 1]!, 0);
      // AT ITS PLACE (within HOVER_NEAR) a firefly drifts in, in no hurry, at
      // up to WANDER_SPEED. Further off it does not glide at all - it HOPS
      // there (see HOPS, started in `wander`) - until it is WANDER_NEAR off, a
      // player who has moved on, from where a smooth chase blends in toward
      // the full cap at WANDER_FAR. It is always carried by the spot's own
      // velocity (`sv`) whatever it is doing.
      const hurry = Math.min(1, Math.max(0, (off - WANDER_NEAR) / (WANDER_FAR - WANDER_NEAR)));
      const drift = !m.hopping ? Math.min(off / ARRIVE_TIME, WANDER_SPEED) : 0;
      const catchUp = Math.min(off / ARRIVE_TIME, speedCap * hurry);
      const closing = inRock ? Math.max(off / ARRIVE_TIME, ROCK_EXIT_SPEED) : Math.max(drift, catchUp);
      const toward = off > 1e-9 ? closing / off : 0;
      // The spot's own velocity is carried only in part (`CARRY`), and in
      // full only while catching up from well behind (`hurry`). Carried in
      // full always, a firefly GLIDED along with every move of the spot - the
      // smooth slide Tris played and rejected; carried not at all, hops alone
      // (about 2 m/s with their pauses and settles) left eight fireflies up
      // to 0.9 m behind a player rolling at 3 m/s. Near its place, the rest of
      // the way is made up by hopping.
      const carry = CARRY + (1 - CARRY) * hurry;
      let wx = sv.x * carry + dx * toward;
      let wy = sv.y * carry + dy * toward;
      let wz = sv.z * carry + dz * toward;
      // A DART is a velocity it wants on top of its flight, steered to hard,
      // and shed as hard once the dart has covered its distance (see DARTS).
      // None while it is making its way out of rock.
      const darting = m.dartLeft > 0 && !inRock;
      if (darting) {
        wx += m.dartDir.x * m.dartSpeed;
        wy += m.dartDir.y * m.dartSpeed;
      }
      clampInto(wx, wy, wz, speedCap, (x, y, z) => ((wx = x), (wy = y), (wz = z)));
      const settling = !darting && m.dartSettle > 0;
      const steer = darting ? m.dartSpeed / m.dartAccel : settling ? DART_SETTLE_STEER : STEER_TIME;
      let ax = (wx - v[j]!) / steer;
      let ay = (wy - v[j + 1]!) / steer;
      let az = (wz - v[j + 2]!) / steer;
      // A dart and its settle get the dart's own acceleration: a hop stops as
      // hard as it started.
      let accelCap = CRUISE_ACCEL + (darting || settling ? m.dartAccel : 0);
      clampInto(ax, ay, az, accelCap, (x, y, z) => ((ax = x), (ay = y), (az = z)));

      // The ERRATIC part, on top of the steering (see JITTER and DARTS): the
      // cap grows by what they add, so a firefly's own twitch is never
      // smoothed away by the limit that keeps its steering plausible. None of
      // it while the firefly is making its way out of rock.
      if (inRock) {
        m.dartLeft = 0;
        accelCap += ROCK_EXIT_ACCEL;
      } else {
        ax += m.jitter.x;
        ay += m.jitter.y;
        az += m.jitter.z;
        accelCap += JITTER_ACCEL;
      }

      // FLEE: away from where the ball is about to be, harder the closer, with
      // a swerve of its own so the swarm scatters rather than backing off in
      // a block.
      if (threat) {
        // Where the firefly will be relative to the ball, on the RELATIVE
        // motion: a ball flying alongside the swarm is no threat to it. Read
        // off the ball's motion alone, a ball rolling at 3 m/s looked 0.9 m
        // ahead of itself - inside a swarm hovering 1 m ahead - and kept the
        // swarm fleeing a ball it was keeping pace with.
        const fx = p[j]! + v[j]! * AVOID_LOOKAHEAD - threat.x;
        const fy = p[j + 1]! + v[j + 1]! * AVOID_LOOKAHEAD - threat.y;
        const d = Math.hypot(fx, fy);
        if (d < AVOID_RADIUS) {
          const push = FLEE_ACCEL * (1 - d / AVOID_RADIUS);
          let nx = d > 1e-6 ? fx / d : m.swerve;
          let ny = d > 1e-6 ? fy / d : 0;
          // FORWARD OR SIDEWAYS, never back: the swarm stays ahead of the
          // player even while it scatters. Fleeing straight away from the
          // ball sent fireflies the ball came up beneath back past it - played
          // as the swarm "rapidly moving behind the player". The part of the
          // flee pointing back along the way forward is dropped, and a flee
          // left with nothing is sideways, its own way.
          const hd = this.route !== null ? this.heading : null;
          if (hd) {
            const back = nx * hd.x + ny * hd.y;
            if (back < 0) {
              nx -= hd.x * back;
              ny -= hd.y * back;
              const len = Math.hypot(nx, ny);
              if (len > 1e-6) {
                nx /= len;
                ny /= len;
              } else {
                nx = -hd.y * m.swerve;
                ny = hd.x * m.swerve;
              }
            }
          }
          ax += push * (nx - ny * m.swerve * FLEE_SWERVE);
          ay += push * (ny + nx * m.swerve * FLEE_SWERVE);
          accelCap = Math.max(accelCap, FLEE_ACCEL);
          speedCap = Math.max(speedCap, FLEE_SPEED);
        }
      }

      // SEPARATION from the others.
      for (let o = 0; o < n; o++) {
        if (o === i) continue;
        const sx = p[j]! - p[o * 3]!;
        const sy = p[j + 1]! - p[o * 3 + 1]!;
        const sz = p[j + 2]! - p[o * 3 + 2]!;
        const d = Math.hypot(sx, sy, sz);
        if (d < SEPARATION && d > 1e-6) {
          const push = (SEPARATION_ACCEL * (1 - d / SEPARATION)) / d;
          ax += sx * push;
          ay += sy * push;
          az += sz * push;
        }
      }

      // Semi-implicit Euler, with the acceleration and then the speed capped:
      // the caps are what make the flight plausible - nothing a firefly does
      // is faster or sharper than a firefly.
      clampInto(ax, ay, az, accelCap, (x, y, z) => ((ax = x), (ay = y), (az = z)));

      // THE LEASH, soft: past LEASH_SOFT of the detection range from the
      // spot, a pull back toward it growing to LEASH_ACCEL at the limit - on
      // top of the caps, so it always wins - so a firefly turns back before
      // it reaches the hard limit below rather than being stopped by it.
      if (m.leashed) {
        const held = this.leashAt();
        const lx = held.x - p[j]!;
        const ly = held.y - p[j + 1]!;
        const ld = Math.hypot(lx, ly);
        const soft = LEASH_SOFT * this.params.notice;
        if (ld > soft) {
          const pull = (LEASH_ACCEL * Math.min(1, (ld - soft) / (this.params.notice - soft))) / ld;
          ax += lx * pull;
          ay += ly * pull;
        }
      }

      v[j]! += ax * h;
      v[j + 1]! += ay * h;
      v[j + 2]! += az * h;
      const speed = Math.hypot(v[j]!, v[j + 1]!, v[j + 2]!);
      if (speed > speedCap) {
        const keep = Math.max(speedCap, speed - BRAKE * h) / speed;
        v[j]! *= keep;
        v[j + 1]! *= keep;
        v[j + 2]! *= keep;
      }
      p[j]! += v[j]! * h;
      p[j + 1]! += v[j + 1]! * h;
      p[j + 2]! += v[j + 2]! * h;

      // The dart's distance cap: covered, it ends, and the settle sheds its
      // speed (see DARTS).
      if (m.dartLeft > 0 && Math.hypot(p[j]! - m.dartFrom.x, p[j + 1]! - m.dartFrom.y) >= m.dartReach) {
        m.dartLeft = 0;
        m.dartSettle = m.dartSettleFor;
      }

      // THE LEASH, hard: never further than the detection range from the
      // spot it is held to (see `leashAt`), once it has been within it. Put
      // back on the limit, and the part of its velocity carrying it further
      // out spent.
      const anchor = this.leashAt();
      const ox = p[j]! - anchor.x;
      const oy = p[j + 1]! - anchor.y;
      const od = Math.hypot(ox, oy);
      const limit = this.params.notice;
      if (!m.leashed) {
        if (od <= limit) m.leashed = true;
      } else if (od > limit) {
        const nx = ox / od;
        const ny = oy / od;
        p[j] = anchor.x + nx * limit;
        p[j + 1] = anchor.y + ny * limit;
        const out = v[j]! * nx + v[j + 1]! * ny;
        if (out > 0) {
          v[j]! -= out * nx;
          v[j + 1]! -= out * ny;
        }
      }
    }
  }

  // The spot the leash holds a firefly to: the COMMITTED spot while the
  // swarm keeps the ball company, home otherwise - never the spot as it
  // glides between them. Held to the gliding one, a firefly was dragged with
  // it the moment it was re-leashed, up to 0.34 m a frame in session-1669f
  // even after a move had let the leash go; the committed spot only changes
  // on a move, which finds the firefly outside its range and in transit.
  private leashAt(): Vec3 {
    return this.following && this.committed ? this.committed.spot : this.spot;
  }

  // The route's way forward as the swarm is using it (unit), or null while it
  // has none - for a probe.
  aheadDir(): Vec2 | null {
    return this.route !== null && this.heading ? { ...this.heading } : null;
  }

  // Firefly `i`'s own point this instant: the hover spot (or home) plus its
  // place in the cloud, at its own radius - kept, while it keeps the ball
  // company, AHEAD of the player (never less than MIN_AHEAD along the way
  // forward) and out of rock (drawn in toward the spot until it is clear).
  private target(i: number): Vec3 {
    const m = this.motes[i]!;
    const u = smooth(this.spread);
    // Never further out than LEASH_SLOT of the leash (see THE LEASH), so a
    // swarm with a small detection range rests well inside it.
    // The cloud's radius, the same for every firefly: its place (`slot`) is
    // already spread uniformly over the disc. Scaling it by a radius of the
    // firefly's own as well bunched most places near the middle (0.07-0.55 m
    // out of 0.8), where eight fireflies crowding one another kept pushing
    // some out past HOVER_NEAR and hopping back - 2.5 hop runs a second at
    // rest.
    const radius = Math.min(
      HOME_SPREAD[1] + (HOVER_SPREAD[1] - HOME_SPREAD[1]) * u,
      LEASH_SLOT * this.params.notice,
    );
    let x = this.spot.x + radius * m.slot.x;
    let y = this.spot.y + radius * m.slot.y;
    const z = this.spot.z + m.slot.z * (0.35 + 0.65 * u);
    const ball = this.ballNow;
    if (!this.following || !ball) return { x, y, z };
    const hd = this.route !== null ? this.heading : null;
    if (hd) {
      const along = (x - ball.x) * hd.x + (y - ball.y) * hd.y;
      if (along < MIN_AHEAD) {
        x += hd.x * (MIN_AHEAD - along);
        y += hd.y * (MIN_AHEAD - along);
      }
    }
    const place = this.placeNow;
    if (place.solid(x, y, SLOT_CLEARANCE)) {
      const ox = x - this.spot.x;
      const oy = y - this.spot.y;
      for (const k of SLOT_SHRINK) {
        x = this.spot.x + ox * k;
        y = this.spot.y + oy * k;
        if (!place.solid(x, y, SLOT_CLEARANCE)) break;
      }
    }
    return { x, y, z };
  }

  // A random place in the cloud: a point in the unit disc (uniformly, hence
  // the square root), flattened vertically, and a depth within SLOT_Z.
  private randomSlot(): Vec3 {
    const r = this.random;
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r());
    return { x: Math.cos(a) * d, y: Math.sin(a) * d * 0.7, z: (r() * 2 - 1) * SLOT_Z };
  }

  // Run firefly `i`'s twitch clocks by `h`: a new jitter, a dart begun or
  // ended, whenever one is due - and, while it is away from its place (`dx`,
  // `dy` to it, `off` metres), the next HOP toward it once it has paused.
  private wander(i: number, h: number, place: SwarmPlace, dx: number, dy: number, off: number): void {
    const m = this.motes[i]!;
    const r = this.random;
    m.jitterLeft -= h;
    if (m.jitterLeft <= 0) {
      // A random direction on the sphere, squashed in depth so the scribble
      // reads on screen, at half to full strength.
      const a = r() * Math.PI * 2;
      const zc = r() * 2 - 1;
      const ring = Math.sqrt(1 - zc * zc);
      const s = JITTER_ACCEL * (0.5 + 0.5 * r());
      m.jitter = { x: Math.cos(a) * ring * s, y: Math.sin(a) * ring * s, z: zc * s * 0.5 };
      m.jitterLeft = mix(JITTER_INTERVAL, r());
    }
    if (m.dartSettle > 0) m.dartSettle -= h;
    if (m.dartLeft > 0) {
      m.dartLeft -= h;
      // Timed out short of its distance: it settles all the same.
      if (m.dartLeft <= 0) m.dartSettle = m.dartSettleFor;
    }
    const x = this.positions[i * 3]!;
    const y = this.positions[i * 3 + 1]!;

    // HOPS: away from its place, the next hop once the last has settled and
    // the pause after it is up - aimed at the place give or take HOP_SPREAD,
    // and no further than it (short of it by half the hover radius, so a firefly
    // arrives rather than overshoots).
    // Hopping from beyond HOVER_NEAR until back within HOVER_SETTLED: the gap
    // between is so a firefly trembling at the edge of its place does not
    // hop in and out of it - a single radius had them hopping 80 times a
    // minute at rest.
    if (off > HOVER_NEAR) m.hopping = true;
    else if (off < HOVER_SETTLED) m.hopping = false;
    if (m.hopping && m.dartLeft <= 0 && m.dartSettle <= 0) {
      m.hopWait -= h;
      if (m.hopWait <= 0) {
        // Quick enough to outrun a spot on the move: the hop speed on top of
        // the spot's own, and the pause after it shorter the faster the spot.
        const sv = this.spotVelocity;
        const moving = Math.hypot(sv.x, sv.y);
        const a = Math.atan2(dy, dx) + (r() * 2 - 1) * HOP_SPREAD;
        m.dartDir = { x: Math.cos(a), y: Math.sin(a) };
        m.dartFrom = { x, y };
        m.dartReach = Math.min(HOP_REACH, Math.max(0.05, off - HOVER_SETTLED / 2));
        m.dartSpeed = HOP_SPEED + moving;
        m.dartAccel = HOP_ACCEL;
        m.dartSettleFor = HOP_SETTLE;
        m.dartLeft = (2 * m.dartReach) / m.dartSpeed;
        m.hopWait = mix(HOP_PAUSE, r()) * Math.max(0.2, 1 - moving / HOP_SPEED);
      }
      return;
    }

    m.dartIn -= h;
    if (m.dartIn <= 0) {
      m.dartIn = mix(DART_INTERVAL, r());
      // Toward the open, while keeping the ball company: a dart lands
      // DART_DISTANCE away, and one that would land in rock is redrawn, and
      // skipped if none of DART_TRIES will do. Near a wall, darts in any
      // direction had the swarm dipping into it every second or so.
      for (let tries = 0; tries < DART_TRIES; tries++) {
        const a = r() * Math.PI * 2;
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        const lx = x + ux * DART_DISTANCE;
        const ly = y + uy * DART_DISTANCE;
        if (this.following && place.solid(lx, ly, 0)) continue;
        // ...and one that would carry it out of its place is redrawn too: an
        // idle dart from a firefly already 0.3 m off landed past HOVER_NEAR,
        // and every one of those set off a run of hops back.
        if (Math.hypot(lx - x - dx, ly - y - dy) > HOVER_SETTLED) continue;
        m.dartDir = { x: ux, y: uy };
        m.dartFrom = { x, y };
        m.dartReach = DART_DISTANCE;
        m.dartSpeed = DART_SPEED;
        m.dartAccel = DART_ACCEL;
        m.dartSettleFor = DART_SETTLE;
        m.dartLeft = DART_TIMEOUT;
        break;
      }
    }
  }

  private blink(): void {
    for (let i = 0; i < this.motes.length; i++) {
      const m = this.motes[i]!;
      const wave = 0.5 + 0.5 * Math.sin(m.blinkRate * this.time + m.blinkPhase);
      this.brightness[i] = BLINK_FLOOR + (1 - BLINK_FLOOR) * Math.pow(wave, BLINK_SHARPNESS);
    }
  }

  // Where the swarm's light hangs: its fireflies' centroid, pushed
  // `LIGHT_FORWARD` toward the camera (see there). Each firefly's motion is
  // acceleration-capped, so their mean is as smooth as they are.
  lightAt(): Vec3 {
    const n = this.motes.length;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < n; i++) {
      x += this.positions[i * 3]!;
      y += this.positions[i * 3 + 1]!;
      z += this.positions[i * 3 + 2]!;
    }
    return { x: x / n, y: y / n, z: z / n + LIGHT_FORWARD };
  }

  // The hover spot this frame, for a probe.
  hoverAt(): Vec3 {
    return { ...this.spot };
  }
}

// Hand `set` the vector (x, y, z) shortened to at most `cap` long.
function clampInto(
  x: number,
  y: number,
  z: number,
  cap: number,
  set: (x: number, y: number, z: number) => void,
): void {
  const len = Math.hypot(x, y, z);
  if (len > cap && len > 0) {
    const s = cap / len;
    set(x * s, y * s, z * s);
  } else set(x, y, z);
}

function smooth(u: number): number {
  return u * u * (3 - 2 * u);
}

// How many pool lights a level with `swarms` swarms builds.
export function fireflyPoolSizeFor(swarms: number): number {
  return Math.max(0, Math.min(FIREFLY_POOL, swarms));
}
