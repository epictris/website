// Hanging vines - a rope of small pass-through links hanging from one anchor,
// free at the bottom. The player walks and swings straight through it, the hook
// grabs it anywhere along its length, and it drapes over whatever it is hanging
// against.
//
// The load-bearing decision, stated once: a vine is **a chain of small
// pass-through rigid links joined by distance constraints, plus one wrap-point
// `Rope` from the vine's anchor to the grabbed link for exactly as long as the
// hook holds it**. The links carry the drape and the grab surface; that one
// extra rope carries the load. Everything else here is a consequence of that
// split.
//
// The pair constraints are `VinePair`s (`level/vinePair.ts`) and not `Rope`s.
// They were `SceneChain`s, which bought the whole chain phase for free and cost
// two orders of magnitude for it: a joint between two link CENTRES with an empty
// wrap-candidate list is degenerate in `Rope`'s terms, and solving it in closed
// form reaches the same fixed point - every number in `cli vines` to the last
// digit - at 0.14 us against 1.6. The anchor chain stays a `SceneChain`, its
// start being snapped to the anchor body's surface and so not degenerate.
//
// Why the split. A uniform particle chain is the standard game rope and it is
// the thing `Rope` exists as a rejection of: a Gauss-Seidel pass over coupled
// distance constraints leaves an order-dependent residual that reads as elastic,
// 73 mm on a 1.03 m chain in the measurements `chains.ts` records, and the
// convergence cost of getting rid of it scales with tension. So a plain dense
// chain the player hangs 70 kg off would reintroduce exactly the failure the
// rope system was built to avoid, in the most visible place there is.
//
// But the house rope alone cannot be a vine either. A wrap-point rope is a
// CONSTRAINT rather than a surface, so there is nothing for the hook's ray to
// hit halfway along one, and a taut one hangs dead straight where a vine has to
// drape.
//
// The resolution is that stretch is a LOAD problem rather than a chain problem.
// Both the residual and the convergence cost scale with tension, and an idle
// vine carries only its own weight - a few kilograms, not the 476 kg slab those
// measurements were taken against - so in that regime the pair chains reach the
// sweep's own tolerance in a dozen cheap sweeps, and each one ends the frame
// within the 5 mm that is under what the renderer can show. What a SERIES of
// them still accumulates is `links * 5 mm` of hang - 55 mm on a 3 m vine,
// measured, and invisible because nothing on screen says how long the vine
// should be. Load appears only at the
// moment the hook grabs, and that is exactly when the wrap-point rope appears
// with it (`updateVineLoads`), long-range-attachment style: one unstretchable
// constraint from the anchor straight to the grabbed link, routed around
// whatever geometry is in the way, with the pair chains above the grab left
// holding nothing but their own links against an already-taut line.

import { Vec2 } from "../engine/vec2";
import { StaticBody2D, VineLink, type PhysicsBody2D } from "../engine/body";
import { circleShape } from "../engine/shapes";
import { bodyContainsPoint, bodyOverlapCircle, bodySweepCircle } from "../engine/collision";
import { GRAVITY, type World } from "../engine/world";
import type { Rope } from "../classes/rope";
import { RopeContact } from "../lib/ropeContact";
import { ShapeGeometry } from "../lib/shapeGeometry";
import {
  collectAnchorSites,
  snapToSurface,
  SceneChain,
  stepSceneChains,
  type AnchorSite,
  type SceneConstraint,
} from "./chains";
import { VinePair } from "./vinePair";
import { buildVineBends, type VineBend } from "./vineBend";
import { catenaryPoints } from "./catenary";
import { RIGID_KINETIC_FRICTION, worldPlacement, type BuiltBodies } from "./buildBodies";
import type { LevelData, VineData } from "./levelFormat";

// Metres between links when a vine does not say.
//
// It is a cost decision and it was made on the measurements below rather than by
// eye, because every one of the three things a vine costs scales with the number
// of links: a 3 m vine is `3 / spacing` bodies, that many pair chains, and that
// many cheap solves per sweep of the chain phase. Wall clock per physics frame
// for one 3 m vine, at rest and with the player swinging on the middle of it:
//
//   spacing   links   at rest   swinging
//     0.10 m     30    1.60 ms    4.66 ms
//     0.15 m     20    0.84 ms    3.56 ms
//     0.20 m     15    0.44 ms    2.67 ms
//
// 15 cm is where that stops being most of a 16.7 ms frame for one piece of
// scenery. It costs grab-anywhere nothing (the grab radius grows with it, so
// consecutive links still overlap) and coarsens the drape slightly, which is the
// only thing it does cost.
export const DEFAULT_VINE_SPACING = 0.15;

// ...and the ceiling that default rises to on a long HANGING vine. Cost
// scales with the link count and convergence sweeps scale with it again (a
// Gauss-Seidel correction travels one link per sweep), so a long vine at a
// fixed spacing is quadratically dearer than a short one. Above
// `DEFAULT_VINE_LINK_BUDGET` links the default spacing widens instead, up to
// this ceiling - the 0.20 m row of the table above, the measured cheap end -
// so a short vine is exactly what it always was and a long one caps near the
// budget. An authored `spacing` is untouched: the author said what it costs.
//
// HANGING vines only. A span keeps the flat default, and both halves of that
// were measured rather than assumed: a taut 4 m span at 0.20 m spacing
// concentrates the same transverse gravity into fewer, heavier links and
// rings at 1.6 m/s for ever, and a SLACK span coarsened the same way put
// `session-2504f`'s unforced energy spans over the invariant's tolerance
// (24.7 J against 17) where the flat spacing replays bit-identical.
export const MAX_DEFAULT_VINE_SPACING = 0.2;
export const DEFAULT_VINE_LINK_BUDGET = 20;

// The default target spacing for a HANGING vine of this length (metres): the
// flat default up to `DEFAULT_VINE_LINK_BUDGET` links, then wider, capped.
export function defaultVineSpacing(length: number): number {
  return Math.min(
    MAX_DEFAULT_VINE_SPACING,
    Math.max(DEFAULT_VINE_SPACING, length / DEFAULT_VINE_LINK_BUDGET),
  );
}

// The one statement of which rule a vine takes, shared with the editor's link
// readout so the panel cannot disagree with the build: `gap` is the distance
// between a span's anchors, null for a hanging vine, and `length` is the
// clamped arc the vine is built at (a span's is never under its gap).
export function vineTargetSpacing(length: number, gap: number | null): number {
  if (gap !== null) return DEFAULT_VINE_SPACING;
  return defaultVineSpacing(length);
}

// The link's collision radius as a fraction of the built spacing. It is the GRAB
// radius and not the visual gauge, and the two are different numbers on purpose:
// consecutive links have to OVERLAP or the hook's ray slips between them and a
// vine has gaps in it that the player can see no reason for. Above a half the
// circles overlap; 0.6 leaves margin for the drape opening a span up.
const LINK_GRAB_RADIUS = 0.6;

// What the renderer draws the vine at, in metres. Much thinner than the grab
// radius, because the grab radius is a statement about the hook and this is a
// statement about what a vine looks like.
export const VINE_VISUAL_RADIUS = 0.03;

// Kilograms per metre of vine, so a link weighs that times the spacing it was
// built at and a vine weighs the same whatever spacing it is authored with.
//
// It is a solver number rather than a botanical one, and it is the sharpest one
// here. A PBD correction is split between the two bodies on the constraint by
// their inverse mass, so what the player's rope does to a grabbed link is set by
// the ratio between 70 kg and that link: at 0.4 kg the rope's correction lands
// 99.4% on the link, the load rope refuses it, and the two spend the whole sweep
// arguing over a body neither can move usefully - which is `session-521f`'s mass
// split, at a far worse ratio than the ball ever saw. Measured, as the worst the
// load rope stretched under a player swinging on the middle of a 3 m vine:
//
//   per link   ratio   stretch   swinging cost
//     0.4 kg     175    194 mm         11.4 ms
//     1.0 kg      70     32 mm         12.0 ms
//     2.0 kg      35    3.4 mm          8.2 ms
//     3.5 kg      20    0.0 mm          4.7 ms
//
// Stretch and cost improve together, because they are the same convergence. 25
// kg/m puts a 15 cm link at 3.75 kg and a 3 m vine at 75 kg; nobody sees
// kilograms, and the bound at the other end is that a vine must not visibly load
// the spring body or rigid platform it is anchored to, which is an authoring
// question about where a heavy vine is hung.
//
// It is the DEFAULT rather than the number, because how heavy a vine is is a
// thing about that vine (`VineData.density`). What an author is choosing is not
// how fast it falls - gravity is mass-independent and every vine hangs and
// swings the same - but how it answers the player and what it does to what it
// hangs from: a heavy vine takes the player's rope without giving, and leans on
// a spring or a rigid platform when it is hung off one; a light one is whipped
// about by a hooked player and, per the table above, stretches under them.
export const DEFAULT_VINE_DENSITY = 25;

// Kilograms in ONE link below which a vine gives visibly under a hooked player,
// and what the editor warns at. It is a per-LINK number rather than a density
// because the mass split that decides it is per link (the table above): the same
// 8 kg/m is 1.2 kg a link at the default spacing and 2.4 kg at 30 cm.
export const LIGHT_LINK_MASS = 1.5;

// The floor under an authored density, kg/m. Not a taste bound - the table above
// is a convergence measurement, and below about a kilogram a metre the load rope
// and the pair chains spend the sweep arguing over a link neither can move. A
// file may say anything; this is what gets built.
export const MIN_VINE_DENSITY = 1;

// What a vine hangs at when it does not say: a rope, which is what every vine
// was before stiffness existed. A vine that does not ask for stiffness builds
// no bend constraints at all, so it is not merely soft - it is bit-for-bit the
// vine it always was, and every replay of one still replays (see
// `level/vineBend.ts`).
export const DEFAULT_VINE_STIFFNESS = 0;

// What a renderer needs of a vine: where the cord runs this frame, and what
// colour it is. It is an interface rather than the `Vine` itself because the
// EDITOR draws vines too and has no links to read - its scene is built by
// `buildLevelBodies`, which never spawns any - so what it hands the 3D scene is
// the straight-down rest pose (see `vineRest` in `editor/model.ts`). Both
// renderers take the cord through this, so neither can have its own idea of
// where a vine is.
export interface VineCord {
  readonly color: string | null;
  // The cord's points, in metres, appended to `out` (which is cleared first).
  // An `out` parameter because this runs per vine per frame in both renderers
  // and a fresh array per call is exactly the per-frame allocation the 3D
  // renderer's transform sync is written to avoid.
  path(alpha: number, out: Vec2[]): void;
}

// Per-frame velocity kept by a vine link, and the one number here that is not
// about the solver.
//
// Nothing else damps a link. A pair chain is a PBD POSITION constraint - it
// moves bodies and credits them the velocity it moved them by - and a link
// hanging in free air touches nothing, so `contactDamp` (which is a contact
// term) never reaches it. A vine therefore has no dissipation at all: once
// excited it rings for ever, and the ringing is FED, because the sweep's own
// tolerance lets the vine lengthen by a fraction of a millimetre a frame and
// that potential energy has nowhere to go but into motion. Measured on the ball
// arena's own vines, left completely alone: the tip was still moving at 0.33 m/s
// after 900 frames and at 0.65 m/s after 3000, with total energy flat - a vine
// that visibly never stops wobbling, and the thing that put the `energy-gained`
// invariant into a permanent argument with itself on any level carrying one.
//
// A real vine is heavily damped - air, and its own internal friction - so this
// is honest as well as necessary. 0.98 a frame is `contactDamp`'s own historical
// figure and takes a disturbance to a tenth in about two seconds. It costs the
// player's swing almost nothing, the link being 3.75 kg against their 70.
const LINK_DAMPING = 0.98;

// How far a link may have MOVED, net, over the window below, and still count as
// settled.
//
// Two things about the measure, and both were arrived at the hard way.
//
// It is POSITION and not velocity, because a settled vine's links carry a
// permanent velocity churn: the chain solve corrects the top links every frame
// and credits them the velocity it moved them by, so the second link of a vine
// hanging still reads 0.27 m/s for ever. A speed test never sleeps a vine at all
// (measured: 3.83 ms a frame, unchanged by it).
//
// And it is NET displacement over a window rather than per-frame movement,
// because that churn is a limit cycle: the same links oscillate 2-7 mm every
// frame about a point they do not leave. Per frame they look like a vine moving
// at 0.4 m/s; over half a second they have gone nowhere, which is what "settled"
// means and what a player sees.
const SLEEP_DRIFT = 0.002;

// ...and how far it may be from that mark before the window is abandoned on the
// spot rather than run to its end. A vine that has genuinely been set swinging
// leaves this behind in a frame or two, so a swing never has to wait out a
// window before being counted as moving.
const MOVING_DRIFT = 0.05;

// Consecutive still frames before a vine sleeps. Half a second: long enough that
// a vine passing through stillness at the top of a swing does not drop off, and
// short enough that a level's scenery is asleep almost all of the time.
const SLEEP_FRAMES = 30;

// One frame of every vine, run by the level driver before anything solves
// against one - and after `updateVineLoads`, so a vine the hook has just caught
// is awake on the frame it is caught rather than the frame after.
//
// Two things, and the order matters. The damping comes off first, because
// `settleChainBodies` rewrites a link's velocity as (what it had at the top of
// the phase) + (what the phase moved it by), so this has to be part of what it
// had rather than something written over afterwards. Then each vine decides
// whether it is awake, which is what the caller reads to know whether to sweep
// it at all.
export function stepVines(vines: readonly Vine[]): void {
  for (const vine of vines) {
    // A vine being HELD is awake by definition: the hook has it, and what the
    // player does with it next is exactly what a sleeping vine could not answer.
    if (vine.lra) {
      wakeVine(vine);
      continue;
    }
    // ...and so is one whose anchor has moved. A vine hangs FROM something, and
    // that something may be a rigid body that swings or a spring one that sags;
    // a sleeping vine would stay behind in mid-air. A static never moves, so
    // this costs the common case one comparison. A spanning vine asks the same
    // question of BOTH its anchors, either end's body being as free to move.
    const anchor = vine.anchorContact.globalPosition;
    let anchorMoved = anchor.x !== vine.anchorAt.x || anchor.y !== vine.anchorAt.y;
    if (!anchorMoved && vine.anchor2Contact) {
      const anchor2 = vine.anchor2Contact.globalPosition;
      anchorMoved = anchor2.x !== vine.anchor2At.x || anchor2.y !== vine.anchor2At.y;
    }
    if (anchorMoved) {
      wakeVine(vine);
      if (vine.asleep) continue;
    }
    if (vine.asleep) continue;

    let worst = 0;
    for (let i = 0; i < vine.links.length; i++) {
      const link = vine.links[i]!;
      link.linearVelocity = link.linearVelocity.mul(LINK_DAMPING);
      link.angularVelocity *= LINK_DAMPING;
      worst = Math.max(worst, link.globalPosition.distanceTo(vine.sleepMark[i]!));
    }
    // Clearly moving: start the window again from where it is now.
    if (worst > MOVING_DRIFT) {
      restartWindow(vine);
      continue;
    }
    if (++vine.stillFrames < SLEEP_FRAMES) continue;
    // The window is up. Settled if it has not left its mark; otherwise it is
    // drifting slowly, and a fresh window measures the drift from here.
    if (worst > SLEEP_DRIFT) {
      restartWindow(vine);
      continue;
    }
    // Asleep. The residual velocity goes with it, or the vine wakes carrying the
    // motion it was put to sleep for not having.
    vine.asleep = true;
    vine.anchorAt = anchor;
    if (vine.anchor2Contact) vine.anchor2At = vine.anchor2Contact.globalPosition;
    for (const link of vine.links) {
      link.linearVelocity = Vec2.ZERO;
      link.angularVelocity = 0;
      link.asleep = true;
    }
  }
}

// The chain set to sweep this frame: the level's authored chains, every AWAKE
// vine's pair chains, and the held vine's load ropes - one for a hanging vine,
// two for a spanning one (see `updateVineLoads`).
//
// Rebuilt into the caller's own array rather than returned fresh, because it is
// per frame and a sleeping level must cost nothing at all - and handed back as
// the authored list itself when there is nothing to add, so a level with no
// vines makes exactly the calls it always did.
export function vineChainSet(
  authored: SceneChain[],
  vines: readonly Vine[],
  held: Vine | null,
  into: SceneConstraint[],
): readonly SceneConstraint[] {
  let extra = held?.lra ? (held.lra2 ? 2 : 1) : 0;
  for (const vine of vines) if (!vine.asleep) extra += vine.chains.length + vine.bends.length;
  if (extra === 0) return authored;
  into.length = 0;
  for (const chain of authored) into.push(chain);
  for (const vine of vines) {
    if (vine.asleep) continue;
    for (const chain of vine.chains) into.push(chain);
    // After that vine's own pair chains, so a sweep in file order reaches a
    // joint with the spacing either side of it already solved - and before the
    // load ropes, which are the one thing in the set that has the last word.
    for (const bend of vine.bends) into.push(bend);
  }
  if (held?.lra) into.push(held.lra);
  if (held?.lra2) into.push(held.lra2);
  return into;
}

function restartWindow(vine: Vine): void {
  vine.stillFrames = 0;
  for (let i = 0; i < vine.links.length; i++) vine.sleepMark[i] = vine.links[i]!.globalPosition;
}

function wakeVine(vine: Vine): void {
  restartWindow(vine);
  vine.anchorAt = vine.anchorContact.globalPosition;
  if (vine.anchor2Contact) vine.anchor2At = vine.anchor2Contact.globalPosition;
  if (!vine.asleep) return;
  vine.asleep = false;
  for (const link of vine.links) link.asleep = false;
}

export interface Vine extends VineCord {
  // Where the vine is bolted, on the anchor body's own surface. Both the first
  // pair chain and the load rope start here.
  readonly anchorContact: RopeContact;
  // The second bolt, for a vine spanning between two anchors - null for the
  // ordinary hanging vine, which is what every vine was before spans existed.
  // The last chain ends here, and a grab gets a SECOND load rope from it (see
  // `updateVineLoads`), because a span's tension runs to both ends.
  readonly anchor2Contact: RopeContact | null;
  // Top to bottom. Index `i` hangs `spacing * (i + 1)` of vine below the anchor,
  // which is what makes the load rope's rest length a multiply rather than a
  // walk.
  readonly links: VineLink[];
  // The curvature constraints that make the vine hard to bend, one per joint
  // plus the clamp at the anchor - empty for a vine of no stiffness, which is
  // what makes such a vine cost exactly what it always did (see
  // `level/vineBend.ts`). They are swept alongside the pair chains rather than
  // after them, because the two disagree by construction.
  readonly bends: VineBend[];
  // 0 = a rope, 1 = a pole. As built, so already clamped to that range.
  readonly stiffness: number;
  // Anchor-to-first-link, then each adjacent pair. These go into the level's
  // `sceneChains`, which is what buys the whole existing chain phase - the
  // residual-gated alternating sweep, static depenetration with the funded
  // velocity clamp, the credit scaling and the blocked-length lease - for free.
  //
  // The anchor one is a `SceneChain` and the pairs are `VinePair`s: a pair is
  // degenerate in `Rope`'s terms and costs two orders more as one, while the
  // anchor's start is snapped to the anchor body's surface and so is not (see
  // `level/vinePair.ts`).
  readonly chains: SceneConstraint[];
  // Metres between adjacent links, as built.
  readonly spacing: number;
  // Authored fill; null = the renderer's own vine colours.
  readonly color: string | null;
  // The live load rope, and the link it is tied to. Null whenever the hook is
  // not holding this vine. Held here rather than rebuilt per frame because a
  // `Rope` carries state a rebuild would throw away every frame: its wrap path
  // and its blocked-length lease.
  lra: SceneChain | null;
  // The second load rope of a held SPANNING vine, from `anchor2Contact` to the
  // same grabbed link - null for a hanging vine, whose arc below the grab
  // carries nothing but itself. Without it the player's weight on a span is
  // held by one end alone and the whole run to the other anchor pays out.
  lra2: SceneChain | null;
  lraLink: VineLink | null;
  // Settled, and costing nothing: out of the chain sweep entirely, and skipped
  // by `World.integrate` and the contact gather (see `VineLink.asleep`). Two 3 m
  // vines in the ball arena are 3.9 ms a physics frame awake, which is a quarter
  // of the frame for scenery that is not doing anything.
  asleep: boolean;
  // Whether this vine's settle may run at build time (spawned in its own rest
  // pose, clear of scenery and areas - see `settleVinesAtBuild`). Set once by
  // `buildOne` and read only by the build.
  readonly settleAtBuild: boolean;
  stillFrames: number;
  // Where each link was when the drift window opened. A vine is still when none
  // of them has left that mark by more than `SLEEP_DRIFT`.
  sleepMark: Vec2[];
  // Where the anchor was when the vine last looked, so a vine hanging from
  // something that moves comes with it. `anchor2At` is the same mark for the
  // second anchor, and simply never read on a hanging vine.
  anchorAt: Vec2;
  anchor2At: Vec2;
}

// Build every vine in `data` (metres) against the bodies `buildLevelBodies`
// made, adding the links to `world`. A vine naming an anchor the level does not
// have, or one on a body that built nothing, is dropped rather than fed to a
// solver that has no meaning for it - the same tolerance a chain end gets.
export function buildVines(world: World, data: LevelData, built: BuiltBodies): Vine[] {
  const anchors = collectAnchorSites(built);
  const statics = vineWrapBodies(built);
  const vines: Vine[] = [];
  for (const v of data.vines ?? []) {
    const vine = buildOne(world, v, anchors, statics);
    if (vine) vines.push(vine);
  }
  settleVinesAtBuild(world, vines);
  return vines;
}

// Frames of build-time settling before a vine is left to finish live. Ample:
// a free-hanging vine sleeps in ~30 frames and a catenary span in under 300.
const SETTLE_AT_BUILD_CAP = 300;

// Run the eligible vines' settle AT BUILD, to the same fixed point the
// level's first live frames used to carry them to - the vine arrives already
// asleep, in its genuinely settled pose, with the arc the settle gives it
// (the pair chains' tolerance of give per segment, which is what the load
// rope's birth length is measured over - a vine frozen at its spawn arc
// instead reads ~5 mm over on every held frame).
//
// It is the REAL per-frame step, not an approximation: gravity's own
// semi-implicit Euler step on the links, then `stepVines` (damping and the
// sleep bookkeeping), then `stepSceneChains` over the vine's own constraints -
// exactly the slice of `physicsProcess` these links would get. That is exact
// because eligibility (see `buildOne`) requires every link clear of scenery
// and areas: nothing else in the frame - contacts, currents, water - could
// have touched them. A vine that spawns against geometry, in water, or
// clipped by the floor settles live exactly as it always did.
function settleVinesAtBuild(world: World, vines: Vine[]): void {
  const candidates = vines.filter((v) => v.settleAtBuild);
  if (candidates.length === 0) return;
  const dt = 1 / 60;
  const chains: SceneConstraint[] = [];
  for (let frame = 0; frame < SETTLE_AT_BUILD_CAP; frame++) {
    const awake = candidates.filter((v) => !v.asleep);
    if (awake.length === 0) break;
    for (const vine of awake) {
      for (const link of vine.links) {
        link.linearVelocity = link.linearVelocity.add(GRAVITY.mul(link.gravityScale * dt));
        link.globalPosition = link.globalPosition.add(link.linearVelocity.mul(dt));
        link.globalRotation += link.angularVelocity * dt;
      }
    }
    stepVines(awake);
    chains.length = 0;
    for (const vine of awake) {
      if (vine.asleep) continue;
      for (const c of vine.chains) chains.push(c);
      for (const b of vine.bends) chains.push(b);
    }
    stepSceneChains(chains, world, dt);
  }
}

// How far the vine can hang straight down from its anchor before it meets
// something, in metres: the earliest swept-circle hit of a link-sized circle
// dropped from the anchor, over the level's statics.
//
// A vine authored longer than its drop is the ordinary case - it is how a vine
// pools on the floor - and left to spawn straight through the floor it is not an
// authored overlap the first frames settle. A link spawned past the MIDLINE of a
// slab is depenetrated out of the slab's FAR face (`circleOverlap` answers the
// shortest exit, which is downward from there), so it ends up hanging below the
// floor with nothing under it; the pair chain above it then reads its own
// resting neighbour as geometry refusing the correction, never releases its
// blocked-length lease, and pays out rope to the falling link at 0.33 m/s for
// ever. That is `session-537f`'s runaway, reached from the level file rather
// than from the solver, and it is what a 6 m vine over a 4.6 m drop did.
//
// The vine's own body is excluded because the anchor is ON it: a sweep that
// starts inside the ceiling the vine hangs from stops at zero.
function dropDistance(
  from: Vec2,
  length: number,
  spacing: number,
  radius: number,
  anchorBody: PhysicsBody2D,
  statics: readonly PhysicsBody2D[],
): number {
  // A vine anchored on the TOP of something has nowhere to hang: the body it is
  // bolted to is in the way, and left to spawn straight down its links land
  // inside that body - the ones past its midline out of the far face, which is
  // the same hole this whole function exists to close. Every link at the anchor
  // is the honest answer to a vine hung the wrong way up, and it is visibly the
  // wrong way up rather than quietly threaded through the floor.
  //
  // The test is where the FIRST LINK would go, and not a sweep against the
  // anchor body, because a sweep against that body says nothing: the anchor is
  // on its surface, so a link-sized circle there straddles it and the sweep
  // reports an immediate hit whichever way the vine hangs.
  if (bodyContainsPoint(anchorBody, from.add(new Vec2(0, Math.min(spacing, length))))) return 0;
  const motion = new Vec2(0, length);
  let stop = length;
  for (const body of statics) {
    if (body === anchorBody) continue;
    const hit = bodySweepCircle(body, from, motion, radius);
    if (hit) stop = Math.min(stop, hit.t * length);
  }
  return stop;
}

function buildOne(
  world: World,
  v: VineData,
  anchors: Map<number, AnchorSite>,
  statics: readonly PhysicsBody2D[],
): Vine | null {
  const site = anchors.get(v.anchor);
  if (!site) return null;
  const obj = site.built.body;
  if (!obj) return null;
  if (!(v.length > 0)) return null;

  // The anchor is placed in its body's frame, and then pushed onto that body's
  // own surface for the reason `chains.ts` gives: an anchor left in a body's
  // interior leaves the span starting INSIDE that body, and the wrap generator
  // resolves that as a self-intersection.
  const anchorPoint = snapToSurface(obj, worldPlacement(site.built.data, site.anchor).pos);
  const anchorContact = RopeContact.at(obj, anchorPoint);

  // The optional second anchor, making the vine a span. Missing - not in the
  // level, on a body that built nothing, or the same anchor as the first - it
  // falls back to HANGING rather than dropping the vine: one anchor is still a
  // complete vine, unlike a chain end (see `VineData.anchor2`).
  const site2 = v.anchor2 !== undefined && v.anchor2 !== v.anchor ? anchors.get(v.anchor2) : undefined;
  const obj2 = site2?.built.body ?? null;
  const anchor2Point =
    site2 && obj2 ? snapToSurface(obj2, worldPlacement(site2.built.data, site2.anchor).pos) : null;
  const anchor2Contact = obj2 && anchor2Point ? RopeContact.at(obj2, anchor2Point) : null;

  // A span authored SHORTER than the gap between its anchors is built taut, at
  // the separation itself. Built at the authored figure its chains are
  // unsatisfiable - their total reach is less than the distance they have to
  // cover - and an unsatisfiable set never converges: every sweep argues with
  // gravity over links that cannot be where every constraint wants them, the
  // vine jitters at ~0.7 m/s for ever, and it can never sleep. Taut is what a
  // too-short cord bolted at both ends IS, and the honest number for it is the
  // gap.
  const length = anchor2Point ? Math.max(v.length, anchorPoint.distanceTo(anchor2Point)) : v.length;

  // The authored spacing is a TARGET and the authored length is exact: fit a
  // whole number of links to the length and divide it back out. Authoring it the
  // other way round makes a 1 m vine at 0.3 m spacing either 0.9 m or 1.2 m long,
  // and which one it is is a rounding rule nobody should have to know.
  //
  // The count is of SEGMENTS between constraint points: a hanging vine of N
  // links is N segments (anchor to the first link, then the pairs), and a
  // spanning one is N + 1, the extra being the last link to the second anchor -
  // so a span of the minimum two segments still has a link to grab.
  const target =
    v.spacing ??
    vineTargetSpacing(length, anchor2Point ? anchorPoint.distanceTo(anchor2Point) : null);
  const segments = Math.max(anchor2Contact ? 2 : 1, Math.ceil(length / target));
  const spacing = length / segments;
  const count = anchor2Contact ? segments - 1 : segments;
  const radius = spacing * LINK_GRAB_RADIUS;
  // Kilograms per metre, so a link weighs that times the spacing it was built
  // at: the same authored vine weighs the same whatever spacing it is made from
  // (see `DEFAULT_VINE_DENSITY`).
  const density = Math.max(MIN_VINE_DENSITY, v.density ?? DEFAULT_VINE_DENSITY);
  // Clamped rather than trusted: a hand-edited file may say anything, and a
  // negative compliance is a solver that pushes the vine further from straight
  // the harder it is bent.
  const stiffness = Math.min(1, Math.max(0, v.stiffness ?? DEFAULT_VINE_STIFFNESS));

  // Where the links spawn. A hanging vine goes straight down and lies on the
  // first thing it meets rather than through it (see `dropDistance`); a
  // spanning one spawns ON its resting catenary, which is the pose the solver
  // would settle it into over empty ground - so a span at rest is at rest on
  // frame one, with nothing for the first frames to correct. A span authored
  // through geometry settles by the ordinary contact solve, its total length
  // being held from both ends.
  let spawnAt: (i: number) => Vec2;
  // Whether the spawn pose is the vine's own REST pose: a hanging vine's is
  // when nothing clips the drop (a clipped one piles at the clip and drapes
  // from there), a span's is the catenary it spawns on - unless it is stiff,
  // in which case the rest pose is the bends' force balance with the chains
  // and NOT the catenary (see `buildVineBends`).
  let spawnIsRest: boolean;
  if (anchor2Point) {
    const arcs: number[] = [];
    for (let i = 0; i < count; i++) arcs.push(spacing * (i + 1));
    const rest = catenaryPoints(anchorPoint, anchor2Point, length, arcs);
    spawnAt = (i) => rest[i]!;
    spawnIsRest = stiffness === 0;
  } else {
    const reach = dropDistance(anchorPoint, length, spacing, radius, obj as PhysicsBody2D, statics);
    spawnAt = (i) => anchorPoint.add(new Vec2(0, Math.min(spacing * (i + 1), reach)));
    spawnIsRest = reach >= length;
  }

  const links: VineLink[] = [];
  for (let i = 0; i < count; i++) {
    const link = new VineLink();
    link.setShape(circleShape(radius));
    link.mass = density * spacing;
    link.inertia = ShapeGeometry.computeMomentOfInertia(link.primaryShape(), link.mass);
    // Kinetic friction so a vine dragged over a ledge is slowed by it, and no
    // stiction: the static-friction pin holds a body's along-surface position
    // against the surface it rests on, which for a vine pooling on a floor is a
    // vine welded to the spot it first touched rather than one that settles.
    link.contactFriction = RIGID_KINETIC_FRICTION;
    // At rest (see `spawnAt`). A spawn pose that intersects geometry needs no
    // special handling - the first frames' contact solve and the chain phase's
    // own depenetration settle it, which is the answer the game already gives
    // any authored overlap.
    link.globalPosition = spawnAt(i);
    world.add(link);
    links.push(link);
  }

  const color = v.color ?? null;
  const chains: SceneConstraint[] = [];
  // Anchor to the first link, then every adjacent pair. Link ends sit at the
  // link's CENTRE (`Vec2.ZERO`) rather than on its rim: a link is a 6 cm circle
  // whose whole job is to be somewhere, and a rim contact would give the pair
  // constraint a torque arm on a body whose rotation means nothing.
  chains.push(new SceneChain(anchorContact, new RopeContact(links[0]!, Vec2.ZERO), spacing, color));
  for (let i = 1; i < links.length; i++) {
    chains.push(
      new VinePair(
        new RopeContact(links[i - 1]!, Vec2.ZERO),
        new RopeContact(links[i]!, Vec2.ZERO),
        spacing,
      ),
    );
  }
  // ...and, spanning, the last link to the second anchor. A `SceneChain` like
  // the first for the same reason the first is one: an end snapped to a body's
  // surface is not the degenerate centre-to-centre joint a `VinePair` is the
  // cheap answer to (see `level/vinePair.ts`).
  if (anchor2Contact) {
    chains.push(
      new SceneChain(anchor2Contact, new RopeContact(links[links.length - 1]!, Vec2.ZERO), spacing, color),
    );
  }

  // The vine's rest direction: straight down, that being the only pose a
  // hanging vine has - it has no authored direction, and its links are spawned
  // down the same axis. It is what the stiffness CLAMPS a hanging vine to,
  // handed over as a world vector for `buildVineBends` to put in the anchor
  // body's own frame. A span builds no clamp - its ends are pinned - so this is
  // unused there (see `buildVineBends`).
  const restDir = new Vec2(0, 1);

  // Whether this vine's settle may run AT BUILD instead of over the level's
  // first visible frames (see `settleVinesAtBuild`): its spawn pose is its own
  // rest pose, and every link is clear of the scenery AND of every area - a
  // link the contact solve would push, or one a current or water would keep
  // stirring, is not going to rest where it spawned, and such a vine settles
  // live exactly as it always did.
  const settleAtBuild =
    spawnIsRest &&
    links.every(
      (link) =>
        statics.every((body) => bodyOverlapCircle(body, link.globalPosition, radius) === null) &&
        world.areas.every((area) => bodyOverlapCircle(area, link.globalPosition, radius) === null),
    );

  return {
    anchorContact,
    anchor2Contact,
    links,
    chains,
    bends: buildVineBends(anchorContact, restDir, links, stiffness, spacing, anchor2Contact),
    stiffness,
    spacing,
    color,
    lra: null,
    lra2: null,
    lraLink: null,
    settleAtBuild,
    asleep: false,
    stillFrames: 0,
    sleepMark: links.map((l) => l.globalPosition),
    anchorAt: anchorPoint,
    anchor2At: anchor2Point ?? anchorPoint,
    // The anchor, every link centre, and the second anchor if there is one,
    // against the RENDER transforms: a link is a body, so this is where the
    // vine actually is rather than a curve fitted to it. `renderPosition` and
    // not `globalPosition` for the reason the rope's nodes are taken that way -
    // the drawn vine has to stay welded to the drawn bodies between the 60 Hz
    // steps.
    path(alpha: number, out: Vec2[]): void {
      out.length = 0;
      out.push(anchorContact.renderGlobalPosition(alpha));
      for (const link of links) out.push(link.renderPosition(alpha));
      if (anchor2Contact) out.push(anchor2Contact.renderGlobalPosition(alpha));
    },
  };
}

// The bodies a vine's load rope may bend around: the level's STATIC geometry.
//
// A scene chain solves against `NOTHING`, and that is right for a chain whose
// two ends are the whole of it. A load rope's whole point is that it is the
// force path, so tension routed past a corner has to go round it - a straight
// long-range attachment is wrong the moment the vine bends, and routing it is
// the one thing the house rope does that a textbook LRA does not.
//
// PER-LINK textbook LRAs (anchor-to-every-link inequality at arc rest, the
// standard convergence aid) were tried and measured out. They never disagree
// with the pair chains geometrically, but they bought nothing the sweep could
// cash: the coupled cap's knee is set by the player rope and the load rope
// converging AGAINST EACH OTHER, not by error walking the pair chains, so the
// 1 mm load-rope contract still needed the full 48 sweeps with LRAs in
// (26.6 mm at cap 16 vs 35 without; 1.2-2.7 mm at 32-40, non-monotone), frame
// cost rose ~6% on the vine-hang sessions, and an over-taut span - zero slack
// anywhere by construction - sat on every LRA's rest length and rang at
// 0.27 m/s for ever.
//
// Statics only, and not every wrappable body: a static cannot move, so the wrap
// path it produces is a fact about the level rather than a thing the load rope
// could haul about, and the intermediate vine links are pass-through and are
// ignored by the wrap generator in any case (`isPassThrough`).
export function vineWrapBodies(built: BuiltBodies): PhysicsBody2D[] {
  return built.wrapBodies.filter((b) => b instanceof StaticBody2D);
}

// The load-rope rule, applied every frame from the level: derived from the
// state of the world rather than driven by grab and release events, so release,
// the hook being destroyed and re-firing at another link all fall out of one
// statement.
//
//   If the player's rope ends on a link of this vine, there must be a load rope
//   from the vine's anchor to that link, of exactly the vine's arc length down
//   to it. Otherwise there must be none.
//
// Returns the one load rope that exists this frame (there is one player rope, so
// there is at most one), for the caller to sweep alongside the scene chains.
// How much vine there is between the anchor and link `index`, RIGHT NOW: the
// summed distances along it, which is what a length of rope between two points
// on it means and which handles a curled or draped vine as readily as a straight
// one.
//
// Measured rather than taken as `spacing * (index + 1)`, and the difference is a
// visible pop. The sweep's bound is per chain (`CHAIN_TOLERANCE`) and a vine is a
// SERIES of them, so a settled vine sits up to `links * 5 mm` longer than its
// authored length - 8.3 cm on a 3 m vine at the default spacing, measured, and
// invisible because nothing on screen says how long the vine should be. A load
// rope born at the authored figure is therefore born SHORT, and its first solve
// hauls the grabbed link up by the whole difference on the frame the player
// grabs it.
//
// This is `rope-anchor-kick` in the ball's words, and it is answered the way the
// ball answers it: an anchor is born at the length the rope had actually reached
// (`BallPlayer`'s attach callback), so the constraint starts satisfied and there
// is nothing for the first solve to correct. What the load rope is for is
// refusing to let the vine pay out any FURTHER, and it does that from wherever
// it was born.
function arcTo(vine: Vine, index: number): number {
  let arc = 0;
  let prev = vine.anchorContact.globalPosition;
  for (let i = 0; i <= index; i++) {
    const p = vine.links[i]!.globalPosition;
    arc += p.distanceTo(prev);
    prev = p;
  }
  return arc;
}

// ...and the same walk from the OTHER end, for a spanning vine's second load
// rope: the summed distances from the second anchor down to link `index`.
function arcFrom2(vine: Vine, index: number): number {
  let arc = 0;
  let prev = vine.anchor2Contact!.globalPosition;
  for (let i = vine.links.length - 1; i >= index; i--) {
    const p = vine.links[i]!.globalPosition;
    arc += p.distanceTo(prev);
    prev = p;
  }
  return arc;
}

// Returns the one vine being held this frame (there is one player rope, so
// there is at most one), for the caller to sweep that vine's load ropes
// alongside the scene chains - ONE for a hanging vine, and for a spanning one
// TWO, because a span's tension runs to both anchors: held by one end alone,
// the whole run to the other anchor is just pair chains carrying a player, and
// it pays out exactly the way an unheld hanging arc is meant to and a span is
// not.
export function updateVineLoads(
  vines: readonly Vine[],
  rope: Rope | null,
  wrapBodies: PhysicsBody2D[],
): Vine | null {
  const held = rope ? rope.end.contact.obj : null;
  let active: Vine | null = null;
  for (const vine of vines) {
    const index = held instanceof VineLink ? vine.links.indexOf(held) : -1;
    if (index < 0) {
      vine.lra = null;
      vine.lra2 = null;
      vine.lraLink = null;
      continue;
    }
    const link = vine.links[index]!;
    if (!vine.lra || vine.lraLink !== link) {
      vine.lra = new SceneChain(
        vine.anchorContact,
        new RopeContact(link, Vec2.ZERO),
        arcTo(vine, index),
        vine.color,
        wrapBodies,
      );
      vine.lra2 = vine.anchor2Contact
        ? new SceneChain(
            vine.anchor2Contact,
            new RopeContact(link, Vec2.ZERO),
            arcFrom2(vine, index),
            vine.color,
            wrapBodies,
          )
        : null;
      vine.lraLink = link;
    }
    active = vine;
  }
  return active;
}
