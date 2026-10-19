// Hanging vines - a rope of small pass-through links hanging from one anchor,
// free at the bottom. The player walks and swings straight through it, and the
// hook grabs it anywhere along its length.
//
// The load-bearing decision, stated once: a vine is **a chain of small
// pass-through rigid links joined by distance constraints, plus one straight
// long-range attachment from the vine's anchor to the grabbed link for exactly
// as long as the hook holds it**. The links carry the hang and the grab
// surface; that one extra constraint carries the load. Everything else here is
// a consequence of that split.
//
// VINES IGNORE THE SCENERY, and that is a design decision rather than a
// simplification the solver forced: a link collides with nothing at all
// (`VineLink` is `passable`), so a vine neither drapes over a ledge nor pools
// on a floor, and a level is authored so that neither ever has to happen. What
// that buys is most of what a vine used to cost. The links leave the contact
// gather, the depenetration sweep and `settleChainBodies`' static push-out
// entirely (the dense-scene scan was 3.9 ms a frame against 1.7 in an empty
// scene, for the same two vines), and the load path is a straight line by
// construction - so the load rope stops being a wrap-routing `Rope` and
// becomes `VineAnchor`, a closed-form distance inequality (see
// `level/vineAnchor.ts`), which is the solve that used to dominate every held
// frame.
//
// The pair constraints are `VinePair`s (`level/vinePair.ts`) and not `Rope`s,
// for the cost reason recorded there: closed form reaches the same fixed point
// at 0.14 us against 1.6. The anchor joint and the load ropes are
// `VineAnchor`s - the same closed form with the torque arm the anchor contact
// needs, since it sits on the anchor body's surface rather than at a centre.
//
// Why the split. A uniform particle chain is the standard game rope and it is
// the thing `Rope` exists as a rejection of: a Gauss-Seidel pass over coupled
// distance constraints leaves an order-dependent residual that reads as
// elastic, 73 mm on a 1.03 m chain in the measurements `chains.ts` records,
// and the convergence cost of getting rid of it scales with tension. A vine
// accepts a LITTLE of that - a few millimetres of visible give under a
// swinging player is vine flex, not elastic - but the unbounded form of it
// (the player sinking as the whole series pays out) is refused by the load
// rope, which bounds the grabbed link inside its arc of the anchor whatever
// the sweep count. That is what lets the coupled sweep run to a much lower
// cap than the rigid-vine contract needed (see `MAX_COUPLED_SWEEPS`).
//
// The house rope alone cannot be a vine either: a wrap-point rope is a
// CONSTRAINT rather than a surface, so there is nothing for the hook's ray to
// hit halfway along one, which is why the links are real bodies at all.
//
// Load appears only at the moment the hook grabs, and that is exactly when the
// load rope appears with it (`updateVineLoads`), long-range-attachment style:
// one inextensible straight-line bound from the anchor to the grabbed link,
// with the pair chains above the grab left holding nothing but their own links
// against an already-taut line.

import { Vec2 } from "../engine/vec2";
import type { IslandUnit } from "../engine/ties";
import { LAYER_HOOK, LAYER_PLAYER, LAYER_ROPE, VineLink, type CollisionObject2D } from "../engine/body";
import {
  MIN_STALK,
  STARBERRY_STIFFNESS,
  berryMass,
  berryOffset,
  stalkCap,
  stalkMass,
  stalkReach,
  berryRadius,
  pointAlong,
  starberrySettings,
  type StarberryPose,
  type StarberrySettings,
} from "./starberry";
import { circleShape } from "../engine/shapes";
import { bodyOverlapCircle } from "../engine/collision";
import { World } from "../engine/world";
import type { Rope } from "../classes/rope";
import { RopeContact } from "../lib/ropeContact";
import { ShapeGeometry } from "../lib/shapeGeometry";
import {
  CHAIN_TOLERANCE,
  anchorWorldPoint,
  collectAnchorSites,
  snapToSurface,
  type AnchorSite,
} from "./chains";
import { VineAnchor } from "./vineAnchor";
import { STRUT_GIVE, VinePair, VineStrut } from "./vinePair";
import { buildStalkBends, buildVineBends, type StalkClamp, type VineBend } from "./vineBend";
import { catenaryPoints } from "./catenary";
import { PlantUnit } from "./plantRows";
import { buildLevelBodies, type BuiltBodies } from "./buildBodies";
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
// (Those were measured before vines ignored the scenery and the load rope went
// closed-form; the scaling argument holds and the absolute costs are several
// times smaller now.) 15 cm is the default: it costs grab-anywhere nothing
// (the grab radius grows with it, so consecutive links still overlap) and
// coarsens the curve slightly, which is the only thing it does cost.
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

// The slack a hanging vine's joints leave per segment under its long-range
// attachments: the sweep's own tolerance, so a settled vine's series give (up
// to `CHAIN_TOLERANCE` a pair) never lands past the attachment and grinds
// against it. Taken off the joints rather than added to the attachments, so
// the vine rests on its drawn arc (see `jointLength` in `buildOne`).
export const VINE_LRA_GIVE = 0.005;

// How viscous a vine is to the ball's manacle threaded onto it, when it does
// not say: the reference mud, so a ring on a vine creeps down it under a
// hanging ball at exactly the speed a cuff creeps through `ball.json`'s mud
// (see `lib/vineClamp.ts` and `creepSpeed`). Authorable per vine
// (`VineData.viscosity`) for the reason mud's is per shape: a vine a ring
// slides down in two seconds and one it rides for a minute are different
// puzzles. 0 is a ring that never slides.
export const DEFAULT_VINE_VISCOSITY = 1;

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
  readonly braidSeed: number | null;
  // The braid drawn as laid rope instead of a leafy vine (`VineData.rope`).
  readonly rope?: boolean;
  // Read-only material coordinates for renderers; no decorative state enters
  // the solver. Live links divide the built rest length into equal intervals.
  readonly restLength?: number;
  readonly attachedAtBothEnds?: boolean;
  // A berry vine's settings (`level/starberry.ts`), and where its berries are
  // this frame. A cord with settings and no poses (the editor's) is drawn
  // with its berries at rest.
  readonly starberry?: StarberrySettings;
  berryPoses?(alpha: number): StarberryPose[];
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

const NO_BERRIES: ReadonlySet<VineLink> = new Set();

// The berries (`VineLink.solid`) something is against this frame: either side
// of one of the world's contacts - only the ball's pieces and its cuff can
// meet a berry (`growBerries`) - or a body on the chain's path, wrapped or
// bitten. Empty, and allocating nothing, on a level with no berry.
export function touchedBerries(
  vines: readonly Vine[],
  contacts: readonly { a: CollisionObject2D; b: CollisionObject2D }[],
  chainPath: () => readonly { contact: { obj: CollisionObject2D } }[],
): ReadonlySet<VineLink> {
  if (!vines.some((vine) => vine.berries.length > 0)) return NO_BERRIES;
  const out = new Set<VineLink>();
  const berry = (obj: CollisionObject2D): void => {
    if (obj instanceof VineLink && obj.solid) out.add(obj);
  };
  for (const c of contacts) {
    berry(c.a);
    berry(c.b);
  }
  for (const node of chainPath()) berry(node.contact.obj);
  return out;
}

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
//
// `touched` is the berries (`VineLink.solid`) the ball or its chain is against
// this frame (`touchedBerries`).
export function stepVines(vines: readonly Vine[], touched: ReadonlySet<VineLink> = NO_BERRIES): void {
  for (const vine of vines) {
    // A vine being HELD is awake by definition: the hook has it, and what the
    // player does with it next is exactly what a sleeping vine could not answer.
    if (vine.lra) {
      wakeVine(vine);
      // A stiff span the ball's ring holds as a row of its island
      // (`syncSpanUnits` with `rowed`) is damped here as a free span is: the
      // island cannot damp a link (`VineLink.canSleep` is false) and nothing
      // else does, and undamped the cord rang under the swinging ball for
      // the whole of a hold. A held berry plant stays undamped: its bounce
      // is the energy the damping would take (`PlantUnit`).
      if (vine.unit === null || vine.heldBerry !== null) continue;
      for (const link of vine.allLinks) {
        link.linearVelocity = link.linearVelocity.mul(LINK_DAMPING);
        link.angularVelocity *= LINK_DAMPING;
      }
      continue;
    }
    // ...and so is one whose berry the ball or the chain is against. Damped
    // like any awake vine, but never let sleep while it is touched: the window
    // starts again every frame. Asleep when it was struck, the contact
    // already credited the berry the push (the engine's own wake leaves a
    // link to its vine, `VineLink.wake`), and it moves off with it from here.
    if (touched.size > 0 && vine.berries.some((berry) => touched.has(berry.fruit))) wakeVine(vine);
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
    for (let i = 0; i < vine.allLinks.length; i++) {
      const link = vine.allLinks[i]!;
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
    for (const link of vine.allLinks) {
      link.linearVelocity = Vec2.ZERO;
      link.angularVelocity = 0;
      link.asleep = true;
    }
  }
}

// Keep every vine's island unit in step with who holds it: every vine is a
// unit of the island (2026-10-19) - a stiff span, a limp span, a hanging cord
// and a berry plant nobody holds alike - so no vine is the positional sweep's.
// The span had to be (a floor and a bend that cannot both be met, which the
// sweep's last word never resolves, see `PlantUnit`), and so had the hanging
// cord a ring holds: held positionally, the ball's chain could not close
// against it - the spin rollback took the ring link's share of every
// correction back, so a 52 kg ball was whipped round the grab of a light rope
// that hardly moved (`session-175f`: 430 mm solved onto the grab link over 131
// frames, 332 of it rolled back), and letting the link keep its share left the
// coupled sweep unconverged, the chain ending every frame ~4 mm over. Every
// other vine is one so that no vine is solved by two systems, a ball's chain
// over a free cord and a berry's stalk included.
//
// While a rope ends on one of its links, a unit only where the driver makes
// that rope a row of the same island (`rowed`: the ball level with its ring on
// the cord, `BallLevel.syncBallRow`), because a rope solved positionally
// against links the island integrates would be two solvers on one body: the grapple level's rope is the sweep's,
// so its hold is too, with the load ropes in the coupled sweep and the rope's
// own books (the lease, the unwind's forgiveness) as they always were, and
// the unit comes back the frame the hold ends with the velocities the sweep
// left. A rowed unit's rows are built with the load ropes the vine has at the
// time, so it is rebuilt when a load rope is born, reborn (the ring crossing
// a link) or dropped (`PlantUnit.lra`); the warm start it loses is one
// frame's.
//
// Called by both level drivers right after `updateVineLoads`, by the ball
// level once more at the top of its frame (the hook's swept attach runs
// before the world steps, and a span taken there must be in the right hands
// for that step), and at build with no rope. A unit the ball level installed
// for a held berry plant (`PlantUnit.berry` set) is that level's to drop, and
// is left alone.
export function syncSpanUnits(
  world: World,
  vines: readonly Vine[],
  rope: Rope | null,
  rowed = false,
): void {
  const end = rope ? rope.end.contact.obj : null;
  for (const vine of vines) {
    const held = end instanceof VineLink && vine.links.includes(end);
    const unit = vine.unit;
    const own = unit instanceof PlantUnit && unit.berry === null;
    // A held berry plant's unit is the ball level's (`syncPlantUnit`).
    if (unit !== null && !own) continue;
    if (held && !rowed) {
      if (own) {
        world.ties.removeUnit(unit);
        vine.unit = null;
      }
      continue;
    }
    if (unit !== null) {
      if (!own || (unit.lra === vine.lra && unit.linkCount === vine.allLinks.length)) continue;
      world.ties.removeUnit(unit);
      vine.unit = null;
    }
    const fresh = new PlantUnit(vine, null);
    vine.unit = fresh;
    world.ties.addUnit(fresh);
  }
}

function restartWindow(vine: Vine): void {
  vine.stillFrames = 0;
  for (let i = 0; i < vine.allLinks.length; i++) vine.sleepMark[i] = vine.allLinks[i]!.globalPosition;
}

export function wakeVine(vine: Vine): void {
  restartWindow(vine);
  vine.anchorAt = vine.anchorContact.globalPosition;
  if (vine.anchor2Contact) vine.anchor2At = vine.anchor2Contact.globalPosition;
  if (!vine.asleep) return;
  vine.asleep = false;
  for (const link of vine.allLinks) link.asleep = false;
}

// One berry on a berry vine: a two-body stalk off cord link `parentIndex`.
export interface VineBerry {
  readonly parentIndex: number;
  // Metres down the cord from its anchor, as authored: where its stalk is
  // DRAWN leaving the cord (`berryPoses`).
  readonly along: number;
  readonly joint: VineLink;
  readonly fruit: VineLink;
  // The stalk's length, metres: the in-plane line from its root on the cord to
  // the berry as drawn (`stalkReach`), which is where the stalk's spring is at
  // rest (see `growBerries`).
  readonly reach: number;
  // Where the stalk's ropes catch, metres from the root: the reach plus the
  // plant's `stretch` of it (`stalkCap`); the stalk is a spring up to here.
  readonly cap: number;
  // The berry's drawn radius, metres.
  readonly radius: number;
  // The stalk's clamps, joint then berry, for the build to aim
  // (`aimBerries`); null for a stalk of no stiffness.
  readonly clamps: readonly [StalkClamp, StalkClamp] | null;
}

// The stalk joint's radius, metres. It is no target - its mask leaves the hook
// out - so it only has to be a shape.
const BERRY_JOINT_RADIUS = 0.025;
// The berry's collision circle as a fraction of its drawn radius: the drawn
// berry is a little oval (`roundBerryGeometry`), a radius along its stalk and
// ~0.92 of one across it, and the circle splits the difference - what the
// ball rolls against and the hook bites is the fruit's silhouette.
const BERRY_BODY_RADIUS = 0.95;

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
  // walk. The CORD only: a berry vine's stalk bodies are in `allLinks`.
  readonly links: VineLink[];
  // Every body the vine owns - the cord, then each berry's stalk joint and
  // berry. What the level registers, and what damping, sleep and wake walk;
  // `links` stays the ordered cord the curve and the arcs are measured on.
  readonly allLinks: VineLink[];
  // A berry vine's berries (empty on any other vine): the cord link each
  // stalk leaves from, the stalk's middle joint, and the berry - the one body
  // on the vine the hook can bite.
  readonly berries: VineBerry[];
  // The berry the hook holds this frame, or null. Written by
  // `updateVineLoads`, read by the renderers.
  heldBerry: VineLink | null;
  // The curvature constraints that make the vine hard to bend, one per joint
  // plus the clamp at the anchor - empty for a vine of no stiffness, which is
  // what makes such a vine cost exactly what it always did (see
  // `level/vineBend.ts`). Spring rows of the vine's unit (`PlantUnit`). A
  // berry vine's stalks add theirs (`buildStalkBends`).
  readonly bends: (VineBend | StalkClamp)[];
  // 0 = a rope, 1 = a pole. As built, so already clamped to that range.
  readonly stiffness: number;
  // How viscous the cord is to a ring sliding along it (see
  // `DEFAULT_VINE_VISCOSITY`). As built: never negative.
  readonly viscosity: number;
  // Anchor-to-first-link, then each adjacent pair, and a berry's stalk ropes:
  // distance ceilings, rows of the vine's unit (`PlantUnit`). The pairs are
  // `VinePair`s, the anchor ones `VineAnchor`s (see `level/vinePair.ts`).
  readonly chains: (VinePair | VineAnchor)[];
  // A stiff vine's joint floors (`VineStrut`), one per joint - empty on a limp
  // vine.
  readonly struts: VineStrut[];
  // Metres between adjacent links, as built.
  readonly spacing: number;
  // Authored fill; null = the renderer's own vine colours.
  readonly color: string | null;
  // The live load rope, and the link it is tied to. Null whenever the hook is
  // not holding this vine. Held here rather than rebuilt per frame because it
  // carries state a rebuild would throw away: its blocked-length lease, and
  // the arc it was born at.
  lra: VineAnchor | null;
  // The second load rope of a held SPANNING vine, from `anchor2Contact` to the
  // same grabbed link - null for a hanging vine, whose arc below the grab
  // carries nothing but itself. Without it the player's weight on a span is
  // held by one end alone and the whole run to the other anchor pays out.
  lra2: VineAnchor | null;
  lraLink: VineLink | null;
  // The island unit this vine is solved as (`PlantUnit` in
  // `level/plantRows.ts`): the free plant's own (`syncSpanUnits`), or a held
  // berry's (set by `BallLevel`). Null only between a unit dropped and its
  // replacement built.
  unit: IslandUnit | null;
  // Settled, and costing nothing: the island sleeps its unit, and skipped
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
  const vines: Vine[] = [];
  const plans = new Map<Vine, BerryPlan[]>();
  for (const v of data.vines ?? []) {
    const vine = buildOne(world, v, anchors, plans);
    if (vine) vines.push(vine);
  }
  // A stiff span is the island's from the start (see `syncSpanUnits`), so
  // its settle below is the island's settle and the level opens on the pose
  // the island holds it in.
  syncSpanUnits(world, vines, null);
  settleVinesAtBuild(world, vines);
  // Berries are grown on the cord where it SETTLED, toward where they were
  // authored, and then settled with it. Grown at spawn, each would hang where
  // the cord's settle carried it: a hanging vine comes to rest a few
  // millimetres a link longer than authored (its joints' give, bounded by the
  // per-link long-range attachments), which is 76 mm at the third berry of the
  // berry garden's 3.4 m vine. Grown from the settled link, the stalk takes
  // that up, and what is left is the stalk's own sag under the berry.
  const berried: Vine[] = [];
  for (const [vine, plan] of plans) {
    growBerries(world, vine, plan);
    if (vine.settleAtBuild && vine.asleep) {
      wakeVine(vine);
      berried.push(vine);
    }
  }
  // The grown stalks are the plants' units' too (`PlantUnit.linkCount`).
  syncSpanUnits(world, vines, null);
  settleVinesAtBuild(world, berried);
  // ...and then aimed: each settled plant's stalks are grown into the shape
  // that, loaded, holds every berry where it was drawn (`aimBerries`).
  for (let round = 0; round < BERRY_AIM_ROUNDS; round++) {
    const missed = berried.filter((vine) => aimBerries(vine, plans.get(vine)!) > BERRY_AIM_TOLERANCE);
    if (missed.length === 0) break;
    for (const vine of missed) wakeVine(vine);
    settleVinesAtBuild(world, missed);
  }
  return vines;
}

// The aim rounds a berry vine settled at build may take, and the miss it stops
// at, metres. Measured on the garden and BALL's plant: unaimed, berries settle
// 41-78 mm from where they were drawn; one round takes that to 5-15 mm and a
// second to 3-18 mm. That is the floor: a settle ends when the plant SLEEPS
// (`stepVines`), still swaying by about that much, so further rounds chase
// the sway (ten were measured, wandering between 2 and 17 mm).
//
// The CORD is not aimed. It settles 5.4 mm a link longer than drawn on BALL's
// plant (the joints' give inside the sweep's exit bar), but the give is not a
// property of the vine: shortened by it, the next settle gave a third as much
// and left tips 26-70 mm SHORT. A berry's stalk is drawn from the cord's
// authored length down it rather than from its link (`berryPoses`), so the
// root is where the editor draws it whatever the give.
const BERRY_AIM_ROUNDS = 2;
const BERRY_AIM_TOLERANCE = 0.005;

// Aim a settled plant's stalks at where their berries were drawn, and return
// the worst miss it found.
//
// A stalk's stiffness is internal to the plant (`StalkClamp`), so a berry's
// weight bends the cord where its stalk joins it and the berry settles lower
// than it was drawn - 40-80 mm, where the old world-fixed clamp held it up by
// pushing on nothing. The plant's unloaded shape is never seen, only the
// loaded one, so it is the unloaded shape that gives: each clamp's rest target
// is moved by the miss (the joint's by half of it), and the caller settles
// the plant again. Momentum is untouched - the rest shape is all that moves.
// A stalk of no stiffness hangs where its weight takes it, and is not aimed.
function aimBerries(vine: Vine, plan: readonly BerryPlan[]): number {
  let worst = 0;
  for (const [i, berry] of vine.berries.entries()) {
    if (!berry.clamps) continue;
    const miss = plan[i]!.at.sub(berry.fruit.globalPosition);
    worst = Math.max(worst, miss.length());
    berry.clamps[0].aim(miss.mul(0.5));
    berry.clamps[1].aim(miss);
  }
  return worst;
}

// Where a berry was authored (metres, in the level) and the cord link its
// stalk leaves from; see `buildOne`.
interface BerryPlan {
  readonly parentIndex: number;
  // Metres down the cord from its anchor, as authored.
  readonly along: number;
  readonly at: Vec2;
  readonly radius: number;
}

// A berry vine's berries, grown from the cord as it stands now. Each is a
// short vine of its own hung off a cord link: two bodies (the stalk's middle
// joint, then the berry) on pair constraints, bent toward the stalk's rest
// direction by its own bends - stiffer the less the berry is to sway - with a
// long-range attachment from the cord link to the berry so the stalk cannot
// pay out under the chain. Only the berry's mask keeps the hook; the cord and
// the joint are no targets. Every body is a `VineLink`, and the stalk's joint
// collides with nothing, like the cord; the berry is SOLID to the ball, the
// hook and the chain (`VineLink.solid`), so the ball knocks it about and the
// chain wraps it, and it hangs among the scenery without meeting it.
function growBerries(world: World, vine: Vine, plan: readonly BerryPlan[]): void {
  for (const { parentIndex, along, at, radius } of plan) {
    const parent = vine.links[parentIndex]!;
    // The stalk is as long as it is drawn: the in-plane line from its root on
    // the cord to the berry, as every length in the game is. (From 2026-10-11
    // to 2026-10-12 it was the 3D hypotenuse across `BERRY_CORD_DEPTH`, which
    // left every stalk slack at rest by the difference, so a pull first drew
    // the berry out and then swung it in - the plane's picture of a berry
    // tipping back toward the cord's depth. Tris: the half-3D motion feels
    // wrong in a 2D game.)
    //
    // Its ropes stand `stretch` of the reach over it (`stalkCap`), so between
    // the reach and the cap the stalk is its clamp's spring along its own
    // axis, not a rope: a ball dropped onto a hanging berry is caught by the
    // spring and thrown back, where a rope caught it dead (see
    // `DEFAULT_STALK_STRETCH`). The cap is still a rope, the hard stop a
    // trampoline's frame is.
    const span = Math.max(MIN_STALK, at.distanceTo(parent.globalPosition));
    const reach = stalkReach(span);
    const cap = stalkCap(reach, vine.starberry ?? {});
    const direction = at.sub(parent.globalPosition).normalized();
    const step = span / 2;
    const branch: VineLink[] = [];
    for (let j = 0; j < 2; j++) {
      const fruit = j === 1;
      const body = new VineLink();
      body.name = fruit ? "Starberry" : "StarberryStem";
      body.setShape(circleShape(fruit ? radius * BERRY_BODY_RADIUS : BERRY_JOINT_RADIUS));
      if (fruit) {
        // Solid to the ball, the hook and the chain, and to nothing else: not
        // the scenery it hangs among, which would shove an authored berry out
        // of a rock it overlaps, and not another berry (`VineLink.solid`).
        body.passable = false;
        body.solid = true;
        body.primaryShape().mask = LAYER_PLAYER | LAYER_HOOK | LAYER_ROPE;
      } else {
        body.primaryShape().mask &= ~LAYER_HOOK;
      }
      // The berry weighs its plant's density times its drawn sphere
      // (`StarberrySettings.berryDensity`, so a bigger berry is heavier), the
      // stem the stalk's density times its reach (`stalkDensity`, so a longer
      // stalk is heavier); the defaults are heavier than a cord link for the
      // cord's own reason (`DEFAULT_VINE_DENSITY`).
      body.mass = fruit ? berryMass(radius, vine.starberry ?? {}) : stalkMass(reach, vine.starberry ?? {});
      body.inertia = ShapeGeometry.computeMomentOfInertia(body.primaryShape(), body.mass);
      // The chain bites the berry off-centre; a berry that spun on that arm
      // would wind the stalk round it. The renderer turns it with the stalk.
      body.kinematicRotation = true;
      body.globalPosition = parent.globalPosition.add(direction.mul(step * (j + 1)));
      world.add(body);
      branch.push(body);
      vine.allLinks.push(body);
      vine.sleepMark.push(body.globalPosition);
      vine.chains.push(
        new VinePair(
          new RopeContact(j === 0 ? parent : branch[0]!, Vec2.ZERO),
          new RopeContact(body, Vec2.ZERO),
          cap / 2,
        ),
      );
    }
    const source = new RopeContact(parent, Vec2.ZERO);
    // The cord edge the stalk is held against runs back up the cord three times
    // as far as the stalk reaches out from it. Over one link the clamp pulled
    // that link with a lever ~2.7 times the stalk, the sweep left it short of
    // converged at its exit bar, and the leftover fed a bob that never let a
    // plant sleep. Measured on the garden and BALL's plant, each left alone for
    // 600 frames: an edge of 1.5 spans left one plant awake for good, 2 to 4
    // let all of them sleep (1 did too, until the hanging vine's joints were
    // shortened by a give - see `jointLength` - and BALL's plant woke for good).
    // Never past the first link: from the anchor, which the bends hold
    // immovable, the edge would carry the stalk's torque straight into it as
    // if a rod ran from the anchor to the root. Only a stalk on the first link
    // takes the anchor itself.
    const back = Math.max(1, Math.ceil((3 * span) / vine.spacing));
    const above = parentIndex > 0 ? vine.links[Math.max(0, parentIndex - back)]! : vine.anchorContact;
    const stiffness = buildStalkBends(above, parent, [branch[0]!, branch[1]!], 0.5 - vine.starberry!.sway * 0.2, step);
    if (stiffness) vine.bends.push(...stiffness.bends);
    vine.chains.push(
      new VineAnchor(source, new RopeContact(branch[1]!, Vec2.ZERO), cap + CHAIN_TOLERANCE),
    );
    vine.berries.push({ parentIndex, along, joint: branch[0]!, fruit: branch[1]!, reach, cap, radius, clamps: stiffness?.clamps ?? null });
  }
}

// Frames of build-time settling before a vine is left to finish live. Ample:
// a free-hanging vine sleeps in ~30 frames and a catenary span in under 300.
const SETTLE_AT_BUILD_CAP = 300;

// Run the eligible vines' settle AT BUILD, to the same fixed point the
// level's first live frames used to carry them to - the vine arrives already
// asleep, in its genuinely settled pose, with the arc the settle gives it
// (the joints' give per segment, which is what the load rope's birth length
// is measured over - a vine frozen at its spawn arc instead reads ~5 mm over
// on every held frame).
//
// It is the REAL per-frame step, not an approximation: the island's frame for
// each vine's unit - gravity, the substeps, its rows - exactly as
// `World.integrate` would give it, then `stepVines` (damping and the sleep
// bookkeeping). That is exact because eligibility (see `buildOne`) requires
// every link clear of scenery and areas: nothing else in the frame -
// contacts, currents, water - could have touched them. A vine that spawns
// against geometry, in water, or clipped by the floor settles live exactly as
// it always did.
function settleVinesAtBuild(world: World, vines: Vine[]): void {
  const candidates = vines.filter((v) => v.settleAtBuild);
  if (candidates.length === 0) return;
  const dt = 1 / 60;
  const units = new Set<IslandUnit>();
  for (let frame = 0; frame < SETTLE_AT_BUILD_CAP; frame++) {
    const awake = candidates.filter((v) => !v.asleep);
    if (awake.length === 0) break;
    units.clear();
    for (const vine of awake) units.add(vine.unit!);
    world.stepTiesStandalone(dt, units);
    stepVines(awake);
  }
}

function buildOne(
  world: World,
  v: VineData,
  anchors: Map<number, AnchorSite>,
  // Where a berry vine's berries are to be grown, once it has settled.
  plans: Map<Vine, BerryPlan[]>,
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
  const anchorPoint = snapToSurface(obj, anchorWorldPoint(site));
  const anchorContact = RopeContact.at(obj, anchorPoint);

  // The optional second anchor, making the vine a span. Missing - not in the
  // level, on a body that built nothing, or the same anchor as the first - it
  // falls back to HANGING rather than dropping the vine: one anchor is still a
  // complete vine, unlike a chain end (see `VineData.anchor2`).
  const site2 = v.anchor2 !== undefined && v.anchor2 !== v.anchor ? anchors.get(v.anchor2) : undefined;
  const obj2 = site2?.built.body ?? null;
  const anchor2Point =
    site2 && obj2 ? snapToSurface(obj2, anchorWorldPoint(site2)) : null;
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
  const starberry = v.starberry ? starberrySettings(v.starberry, length) : undefined;
  const stiffness = Math.min(
    1,
    Math.max(0, v.stiffness ?? (starberry ? STARBERRY_STIFFNESS : DEFAULT_VINE_STIFFNESS)),
  );
  // A negative viscosity is a law with no meaning; the floor is a ring that
  // never slides.
  const viscosity = Math.max(0, v.viscosity ?? DEFAULT_VINE_VISCOSITY);

  // Where the links spawn. A hanging vine goes straight down its full length -
  // there is nothing for it to lie on, a link colliding with nothing - and a
  // spanning one spawns ON its resting catenary, which is the pose the solver
  // would settle it into: either way a vine at rest is at rest on frame one,
  // with nothing for the first frames to correct.
  let spawnAt: (i: number) => Vec2;
  // A span spawns on the catenary its length implies. That is a LIMP span's
  // rest pose; a stiff one's is the bends' force balance with its joints, a
  // flatter bow (see `buildVineBends`), which it settles into from there - at
  // build, like every vine clear of areas (`settleAtBuild`), so the level opens
  // with it already at rest and the editor can draw where it rests
  // (`settledVinePaths`).
  if (anchor2Point) {
    const arcs: number[] = [];
    for (let i = 0; i < count; i++) arcs.push(spacing * (i + 1));
    const rest = catenaryPoints(anchorPoint, anchor2Point, length, arcs);
    spawnAt = (i) => rest[i]!;
  } else {
    spawnAt = (i) => anchorPoint.add(new Vec2(0, spacing * (i + 1)));
  }

  const links: VineLink[] = [];
  for (let i = 0; i < count; i++) {
    const link = new VineLink();
    link.setShape(circleShape(radius));
    // A berry vine's cord is no target: only its berries are. It hangs behind
    // the gameplay plane in the 3D scene to say so (see
    // `render3d/starberryVisual.ts`).
    if (starberry) link.primaryShape().mask &= ~LAYER_HOOK;
    link.mass = density * spacing;
    link.inertia = ShapeGeometry.computeMomentOfInertia(link.primaryShape(), link.mass);
    // No friction coefficients: a link contacts nothing (`passable`), so there
    // is no surface for a coefficient to mean anything against.
    // At rest (see `spawnAt`) - which may be inside geometry, links ignoring
    // the scenery entirely.
    link.globalPosition = spawnAt(i);
    world.add(link);
    links.push(link);
  }

  const color = v.color ?? null;
  const braidSeed = Number.isInteger(v.braidSeed) && v.braidSeed! >= 0 ? v.braidSeed! : null;
  const rope = braidSeed !== null && v.rope === true;
  const chains: (VinePair | VineAnchor)[] = [];
  // A HANGING vine's joints are `VINE_LRA_GIVE` short of the spacing, and its
  // long-range attachments (below) exactly on the drawn arc. The joints' give
  // inside their exit bar is what a settled vine rests on: it hangs against
  // its attachments, a give apart from them, so with the attachments at the
  // drawn arc plus a give per segment (as they were) it rested 5.4 mm a link
  // LONGER than drawn - BALL's plant's tip 104 mm below where the editor draws
  // it. Moved down together, the two keep the same give between them and the
  // vine rests on its drawing. A span has no attachments to rest on, and its
  // joints are held at the spacing.
  const jointLength = anchor2Contact ? spacing : spacing - VINE_LRA_GIVE;
  // Anchor to the first link, then every adjacent pair. Link ends sit at the
  // link's CENTRE (`Vec2.ZERO`) rather than on its rim: a link is a 6 cm circle
  // whose whole job is to be somewhere, and a rim contact would give the pair
  // constraint a torque arm on a body whose rotation means nothing. The anchor
  // joint is a `VineAnchor` and not a `VinePair` because its other end is on
  // the anchor body's SURFACE, which is a real torque arm when that body is
  // rigid (see `level/vineAnchor.ts`).
  chains.push(
    new VineAnchor(
      anchorContact,
      new RopeContact(links[0]!, Vec2.ZERO),
      jointLength,
    ),
  );
  for (let i = 1; i < links.length; i++) {
    chains.push(
      new VinePair(
        new RopeContact(links[i - 1]!, Vec2.ZERO),
        new RopeContact(links[i]!, Vec2.ZERO),
        jointLength,
      ),
    );
  }
  // ...and, spanning, the last link to the second anchor - a `VineAnchor` like
  // the first, for the same reason the first is one.
  if (anchor2Contact) {
    chains.push(
      new VineAnchor(
        anchor2Contact,
        new RopeContact(links[links.length - 1]!, Vec2.ZERO),
        spacing,
      ),
    );
  } else {
    // A HANGING vine also gets a textbook long-range attachment per link:
    // anchor to link i, at the drawn arc down to it - its joints a give short
    // (see `jointLength`), so the series' give lands on it rather than grinding
    // past it. A stiff
    // serial chain is the one shape a Gauss-Seidel sweep is worst at - news
    // travels one link per sweep - and these carry the anchor's refusal to
    // every link in ONE pass. They were tried before and measured out, but
    // against a different knee: with the load rope still a wrap-routing
    // `Rope`, the sweep count was set by the player rope and the load rope
    // converging against each other, which no pair-chain aid could touch.
    // With that fight closed-form the sweep count IS the pair-chain series
    // (~40 sweeps on a held vertical vine, measured on `session-322f`), and
    // this is the standard answer to it. Hanging vines only: a taut span has
    // zero slack anywhere by construction, sits ON every LRA's rest length,
    // and rang at 0.27 m/s for ever when this was tried there.
    for (let i = 1; i < links.length; i++) {
      chains.push(
        new VineAnchor(
          anchorContact,
          new RopeContact(links[i]!, Vec2.ZERO),
          spacing * (i + 1),
        ),
      );
    }
  }

  // A STIFF vine's joints refuse to shorten as well as to stretch (`VineStrut`):
  // a rod does not fold, and without the floor its bends straightened a span
  // by piling its links into each other. Every joint, anchors included, a
  // give under its length. A limp vine is a rope, and a rope folds.
  //
  // Kept apart from `chains`, because the sweep takes them AFTER the bends
  // (`vineChainSet`). Every bend pass shortens the joints it straightens, so
  // with the struts solved before the bends a forward pass ended with every
  // joint one bend pass short of its floor. At rest that is inside the exit
  // bar; with the span swinging in it is not, the sweep ran to its cap, and a
  // capped sweep's displacement is paid out as velocity (`settleChainBodies`)
  // - 2.9 J to 15.9 J on the one frame in nineteen that capped, on BALL's
  // 2.5 m span over a 1.96 m gap at 0.3 (session-381f), a limit cycle the
  // damping never caught and the vine never slept from. Solved last, the
  // forward pass ends on the floors, the gate is met in 5-13 sweeps, and the
  // same span kicked at 3 m/s sleeps in 90 frames (`cli vines` `span-kick`).
  const struts: VineStrut[] = [];
  if (stiffness > 0) {
    const ends = [anchorContact, ...links.map((l) => new RopeContact(l, Vec2.ZERO))];
    if (anchor2Contact) ends.push(anchor2Contact);
    for (let i = 1; i < ends.length; i++) {
      const last = anchor2Contact !== null && i === ends.length - 1;
      struts.push(new VineStrut(ends[i - 1]!, ends[i]!, (last ? spacing : jointLength) - STRUT_GIVE));
    }
  }

  // The vine's rest direction: straight down, that being the only pose a
  // hanging vine has - it has no authored direction, and its links are spawned
  // down the same axis. It is what the stiffness CLAMPS a hanging vine to,
  // handed over as a world vector for `buildVineBends` to put in the anchor
  // body's own frame. A span builds no clamp - its ends are pinned - so this is
  // unused there (see `buildVineBends`).
  const restDir = new Vec2(0, 1);
  const bends = buildVineBends(anchorContact, restDir, links, stiffness, spacing, anchor2Contact);

  // A berry vine's berries are PLANNED here and grown after the cord has
  // settled (`growBerries`): where each is authored, in the level, and the
  // cord link its stalk will leave from. The cord's rest pose is the one the
  // editor places berries against (`vineRestPath`) and the one the links
  // spawn on, so the plan is read off the spawn.
  const allLinks = [...links];
  const berries: VineBerry[] = [];
  const plan: BerryPlan[] = [];
  if (starberry) {
    const spawnPath = [anchorPoint, ...links.map((l) => l.globalPosition)];
    if (anchor2Point) spawnPath.push(anchor2Point);
    for (const [i, along] of starberry.along.entries()) {
      plan.push({
        // The cord link nearest the authored root: a link is a body, and the
        // point between two of them is not one.
        parentIndex: Math.min(links.length - 1, Math.max(0, Math.round(along / spacing) - 1)),
        along,
        at: pointAlong(spawnPath, along).add(berryOffset(i, starberry)),
        radius: berryRadius(i, starberry),
      });
    }
  }

  // Whether this vine's settle may run AT BUILD instead of over the level's
  // first visible frames (see `settleVinesAtBuild`): every link is clear of
  // every area - a link a current or water would keep stirring is not going
  // to rest where it spawned, and such a vine settles live exactly as it
  // always did. Scenery no longer matters: a link collides with nothing, so
  // the geometry around it cannot touch the settle either at build or live.
  // (A stiff span was once kept to a live settle for spawning off its rest
  // pose; nothing in the build's settle depends on where it starts.)
  const settleAtBuild =
    links.every((link) =>
      world.areas.every((area) => bodyOverlapCircle(area, link.globalPosition, radius) === null),
    ) &&
    plan.every((p) =>
      world.areas.every((area) => bodyOverlapCircle(area, p.at, p.radius) === null),
    );

  const vine: Vine = {
    anchorContact,
    anchor2Contact,
    links,
    allLinks,
    berries,
    heldBerry: null,
    starberry,
    // Each berry's stalk root, joint and berry, against the render transforms
    // for the reason `path` below gives.
    // The root is the point of the cord its authored length down it, not the
    // link the stalk is tied to: that is the nearest link, up to half a
    // spacing away (10 cm on BALL's plant), and drawn from it the stalk left
    // the cord where it was not drawn in the editor.
    berryPoses(alpha: number): StarberryPose[] {
      const cord: Vec2[] = [];
      vine.path(alpha, cord);
      return berries.map((b) => ({
        root: pointAlong(cord, b.along),
        joint: b.joint.renderPosition(alpha),
        fruit: b.fruit.renderPosition(alpha),
        radius: b.radius,
        held: vine.heldBerry === b.fruit,
      }));
    },
    chains,
    struts,
    bends,
    stiffness,
    viscosity,
    spacing,
    color,
    braidSeed,
    rope,
    restLength: spacing * (links.length + (anchor2Contact ? 1 : 0)),
    attachedAtBothEnds: anchor2Contact !== null,
    lra: null,
    lra2: null,
    lraLink: null,
    unit: null,
    settleAtBuild,
    asleep: false,
    stillFrames: 0,
    sleepMark: allLinks.map((l) => l.globalPosition),
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
  if (plan.length) plans.set(vine, plan);
  return vine;
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
export function updateVineLoads(vines: readonly Vine[], rope: Rope | null): Vine | null {
  const held = rope ? rope.end.contact.obj : null;
  let active: Vine | null = null;
  for (const vine of vines) {
    // A held BERRY loads the cord at the link its stalk leaves from: the
    // stalk's own long-range attachment carries the berry to that link, and
    // the load rope carries the link to the anchor.
    const berry = held instanceof VineLink ? vine.berries.find((b) => b.fruit === held) : undefined;
    vine.heldBerry = berry?.fruit ?? null;
    const index = berry ? berry.parentIndex : held instanceof VineLink ? vine.links.indexOf(held) : -1;
    if (index < 0) {
      vine.lra = null;
      vine.lra2 = null;
      vine.lraLink = null;
      continue;
    }
    const link = vine.links[index]!;
    if (!vine.lra || vine.lraLink !== link) {
      vine.lra = new VineAnchor(
        vine.anchorContact,
        new RopeContact(link, Vec2.ZERO),
        arcTo(vine, index),
      );
      vine.lra2 = vine.anchor2Contact
        ? new VineAnchor(
            vine.anchor2Contact,
            new RopeContact(link, Vec2.ZERO),
            arcFrom2(vine, index),
          )
        : null;
      vine.lraLink = link;
    }
    active = vine;
  }
  return active;
}

// Where a span with these anchors and settings RESTS, metres, anchor to anchor:
// built and settled on its own, in a world of nothing but its two anchors.
//
// For the editor, which draws a vine where it rests (`vineRestPath`). A limp
// span rests on the catenary its length implies and needs none of this; a
// stiff one rests in the bends' force balance with its joints, a flatter bow
// with no closed form. Exact rather than approximate, because a span's settle
// is a statement about the span alone: its links collide with nothing, and
// the build settles it with the same steps (`settleVinesAtBuild`), so this is
// where the level's own span stands when it opens - unless it hangs in an
// area, which settles it live and keeps stirring it.
export function restingSpanPath(top: Vec2, end: Vec2, vine: Omit<VineData, "anchor" | "anchor2">): Vec2[] | null {
  // Each anchor on a body of its own: a body that builds nothing is no anchor
  // (see `buildVines`), and an anchor is pushed onto its body's surface, so
  // each body is a tenth of a millimetre of collision centred on its anchor
  // (a centimetre moved every span 5 mm).
  const post = (id: number, at: Vec2) => ({
    kind: "static",
    x: at.x,
    y: at.y,
    rot: 0,
    objects: [
      { type: "collision", x: 0, y: 0, shape: { kind: "rect", w: 0.0001, h: 0.0001 } },
      { type: "anchor", id, x: 0, y: 0 },
    ],
  });
  const data = {
    player: { x: top.x, y: top.y - 1, radius: 0.1 },
    bodies: [post(1, top), post(2, end)],
    vines: [{ ...vine, starberry: undefined, anchor: 1, anchor2: 2 }],
  } as unknown as LevelData;
  const world = new World();
  const built = buildLevelBodies(world, data, () => {});
  const span = buildVines(world, data, built)[0];
  if (!span) return null;
  return [span.anchorContact.globalPosition, ...span.links.map((l) => l.globalPosition), span.anchor2Contact!.globalPosition];
}
