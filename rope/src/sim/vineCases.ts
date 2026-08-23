// Vine cases: hand-built scenes with the answer written down, run by
// `cli vines`.
//
// A vine (see `level/vines.ts`) is two things at once - a chain of pass-through
// bodies that carries the drape and the grab surface, and one wrap-point rope
// that carries the load - and almost nothing about either half is visible to the
// existing suites. It touches no avatar digest while nobody is holding it, it
// violates no invariant when it comes apart, and a build that quietly stopped
// making links renders as a level with no vine in it and passes everything.
//
// So the assertions here are the ones nothing else can make:
//
//   - the engine guards, in isolation, on bare bodies (`link-contacts`), in
//     BOTH directions: nothing is blocked by a link, and a link is blocked by
//     nothing but statics;
//   - that the player is BIT-IDENTICAL walking and swinging through a vine
//     (`pass-through`) - which is the whole of what "pass-through" means, and
//     the only form of it that cannot be satisfied by a nearly-no-op;
//   - that the load rope holds the anchor-to-grab arc in MILLIMETRES under a
//     hanging, swinging player (`grab-hang`), that being its entire job;
//   - that a winch hauls as far up a vine as up a static (`winch`), which is
//     `ball-winch-hung-anchor`'s statement about mass splits, made here because
//     the ratio between a 70 kg player and one link is far worse than any the
//     ball ever saw;
//   - and that exactly zero or one load rope exists on every frame of a
//     fire/grab/release/regrab cycle (`release-refire`), the load rope being
//     derived per frame rather than driven by events.

import { Vec2 } from "../engine/vec2";
import { wrapAngle } from "../engine/mathf";
import {
  CharacterBody2D,
  RigidBody2D,
  StaticBody2D,
  VineLink,
  type PhysicsBody2D,
} from "../engine/body";
import { circleShape, rectShape } from "../engine/shapes";
import { bodyOverlapCircle } from "../engine/collision";
import { World } from "../engine/world";
import { Level } from "../level/level";
import { BallLevel } from "../level/ballLevel";
import { mechanicalEnergy } from "./trace";
import { CHAIN_TOLERANCE } from "../level/chains";
import {
  DEFAULT_VINE_DENSITY,
  LIGHT_LINK_MASS,
  MIN_VINE_DENSITY,
  type Vine,
} from "../level/vines";
import {
  button,
  emptyFrameInput,
  type FrameInput,
} from "../input/frameInput";
import { scaleLevelData, type LevelBodyData, type RawLevelData } from "../level/levelFormat";
import { modelFromDisk, modelToDisk } from "../editor/model";
import { PX } from "../engine/units";

export interface VineResult {
  name: string;
  passed: boolean;
  details: string[];
}

function ok(name: string, passed: boolean, details: string[]): VineResult {
  return { name, passed, details };
}

const DT = 1 / 60;
// Scene pixels per metre, which is what a level file is authored in.
const P = 100;

// ---------------------------------------------------------------------------
// Rigs
// ---------------------------------------------------------------------------

// A hall: a floor, a ceiling, and an anchor on the ceiling's underside at x = 0.
// Every case here is this plus whatever it adds, so a difference between two
// cases is the thing the case is about.
function hall(opts: {
  vineLength?: number;
  spacing?: number;
  density?: number;
  stiffness?: number;
  floorY?: number;
  playerX?: number;
  playerY?: number;
  extra?: LevelBodyData[];
}): RawLevelData {
  const bodies: LevelBodyData[] = [
    {
      kind: "static",
      x: 0,
      y: opts.floorY ?? 600,
      rot: 0,
      objects: [{ type: "collision", shape: { kind: "rect", w: 3000, h: 40 } }],
    },
    {
      kind: "static",
      x: 0,
      y: -500,
      rot: 0,
      objects: [
        { type: "collision", shape: { kind: "rect", w: 600, h: 40 } },
        // On the ceiling's underside, so the surface snap has nothing to do and
        // the anchor point is a number the case can state.
        { type: "anchor", id: 1, x: 0, y: 20 },
      ],
    },
    ...(opts.extra ?? []),
  ];
  return {
    player: { x: opts.playerX ?? -250, y: opts.playerY ?? -320, radius: 12 },
    bodies,
    ...(opts.vineLength === undefined
      ? {}
      : {
          vines: [
            {
              anchor: 1,
              length: opts.vineLength,
              ...(opts.spacing === undefined ? {} : { spacing: opts.spacing }),
              ...(opts.density === undefined ? {} : { density: opts.density }),
              ...(opts.stiffness === undefined ? {} : { stiffness: opts.stiffness }),
            },
          ],
        }),
  };
}

// One frame's input, as the buttons a case actually presses.
interface Press {
  fire?: boolean;
  retract?: boolean;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  aim?: Vec2;
}

// A level plus the edge-triggered input bookkeeping every driver here needs.
// `InputBuffer`s are edge-triggered, so a case that hand-rolls `pressed` gets a
// key latched on for ever - the same trap `cli continue` documents.
class Rig {
  readonly level: Level;
  private prev: FrameInput = emptyFrameInput();

  constructor(data: RawLevelData) {
    this.level = new Level(data);
  }

  get vine(): Vine {
    return this.level.vines[0]!;
  }

  step(frames: number, press: Press | ((f: number) => Press) = {}, onFrame?: (f: number) => void): void {
    for (let i = 0; i < frames; i++) {
      const p = typeof press === "function" ? press(i) : press;
      const input: FrameInput = {
        ...emptyFrameInput(),
        fire: button(!!p.fire, this.prev.fire),
        retract: button(!!p.retract, this.prev.retract),
        moveLeft: button(!!p.left, this.prev.moveLeft),
        moveRight: button(!!p.right, this.prev.moveRight),
        jump: button(!!p.jump, this.prev.jump),
        mouseWorldPosition: p.aim ?? Vec2.ZERO,
      };
      this.prev = input;
      this.level.physicsProcess(input, DT);
      onFrame?.(i);
    }
  }

  // Metres of vine between the anchor and link `index`, summed along it - the
  // same walk `arcTo` does inside `updateVineLoads`, restated here so the case
  // measures the vine rather than trusting the number the load rope was built
  // with.
  arcTo(index: number): number {
    let arc = 0;
    let prev = this.vine.anchorContact.globalPosition;
    for (let i = 0; i <= index; i++) {
      const p = this.vine.links[i]!.globalPosition;
      arc += p.distanceTo(prev);
      prev = p;
    }
    return arc;
  }

  // The link the player's rope currently ends on, or -1.
  heldIndex(): number {
    const end = this.level.player.rope?.end.contact.obj;
    return end instanceof VineLink ? this.vine.links.indexOf(end) : -1;
  }

  // The deepest a link is inside static geometry, in metres.
  worstEmbed(): number {
    let worst = 0;
    for (const link of this.vine.links) {
      const shape = link.primaryShape().shape;
      if (shape.kind !== "circle") continue;
      for (const other of this.level.world.bodies) {
        if (!(other instanceof StaticBody2D)) continue;
        const ov = bodyOverlapCircle(other, link.globalPosition, shape.radius);
        if (ov) worst = Math.max(worst, ov.depth);
      }
    }
    return worst;
  }
}

// ---------------------------------------------------------------------------
// link-contacts: the engine guards, on bare bodies.
//
// The rule they implement is one sentence - a non-solid body blocks nothing, and
// is blocked only by statics - and it is asserted here rather than through a
// level because every one of these is a NEGATIVE: what must be checked is that a
// pair produces no contact, which a scene can satisfy by the two never being
// near each other.
// ---------------------------------------------------------------------------
function caseLinkContacts(): VineResult {
  const details: string[] = [];
  let passed = true;
  const check = (claim: string, got: boolean): void => {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  };

  const world = new World();
  const ground = new StaticBody2D();
  ground.globalPosition = new Vec2(0, 1);
  ground.setShape(rectShape(20, 1));
  world.add(ground);

  // A link resting in the floor, a second link on top of it, and a rigid box in
  // the same place - every pair the rule has an answer for, all overlapping.
  const link = new VineLink();
  link.setShape(circleShape(0.09));
  link.mass = 3.75;
  link.globalPosition = new Vec2(0, 0.52);
  world.add(link);

  const twin = new VineLink();
  twin.setShape(circleShape(0.09));
  twin.mass = 3.75;
  twin.globalPosition = new Vec2(0.02, 0.42);
  world.add(twin);

  const box = new RigidBody2D();
  box.setShape(rectShape(0.4, 0.4));
  box.mass = 10;
  box.inertia = 1;
  box.globalPosition = new Vec2(0.01, 0.45);
  world.add(box);

  const contacts = world.collectContacts();
  const pair = (a: PhysicsBody2D, b: PhysicsBody2D): boolean =>
    contacts.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
  check("link vs static: a contact exists (this is how a vine drapes)", pair(link, ground));
  check("link vs link: no contact", !pair(link, twin));
  check("link vs rigid: no contact", !pair(link, box));
  check("rigid vs static: unaffected", pair(box, ground));

  // The character sweep walks straight through, and is not depenetrated out.
  const walker = new CharacterBody2D();
  walker.setShape(circleShape(0.12));
  walker.globalPosition = new Vec2(-1, 0.52);
  world.add(walker);
  const hit = world.moveAndCollide(walker, new Vec2(2, 0), true);
  check(
    `character sweep through a link reports nothing (got ${hit ? hit.getCollider().name : "null"})`,
    hit === null || hit.getCollider() !== link,
  );
  walker.globalPosition = new Vec2(0, 0.52); // dead centre of the link
  const inside = world.moveAndCollide(walker, new Vec2(0.01, 0), true);
  check(
    "a character standing INSIDE a link is not pushed out of it",
    inside === null || inside.getCollider() !== link,
  );

  // ...and neither is a rigid body.
  const before = box.globalPosition;
  const pushed = world.depenetrateRigid(box, 2, (o) => o === link || o === twin);
  check(
    `depenetration against links alone moves nothing (${pushed.length} normals, ` +
      `${(box.globalPosition.distanceTo(before) * 1000).toFixed(3)} mm)`,
    pushed.length === 0 && box.globalPosition.distanceTo(before) === 0,
  );

  // The CONVERSE, which is the half of the rule the recovery sweep was missing:
  // the link is not pushed out of the box either. One direction alone is not
  // pass-through - the ball sails through the vine untouched, and the sweep then
  // throws the vine out of the ball's way, which is exactly what a vine
  // "colliding with the ball" looks like from the outside (it moved 1.16 m).
  const linkBefore = link.globalPosition;
  const linkPushed = world.depenetrateRigid(link, 2, (o) => o === box);
  check(
    `a link is not pushed out of a rigid body either (${linkPushed.length} normals, ` +
      `${(link.globalPosition.distanceTo(linkBefore) * 1000).toFixed(3)} mm)`,
    linkPushed.length === 0 && link.globalPosition.distanceTo(linkBefore) === 0,
  );
  // ...while the floor still holds it up, which is the "only by statics" half.
  const held = world.depenetrateRigid(link, 2, (o) => o === ground);
  check(`but it IS pushed out of static scenery (${held.length} normals)`, held.length > 0);

  // And the hook can still see one: links are on LAYER_ANCHOR, which is the
  // layer the hook's ray asks for and no other query does. In a world of its
  // own, so what the ray reaches is the link rather than whatever else this
  // scene has piled on the same spot.
  const lone = new World();
  const target = new VineLink();
  target.setShape(circleShape(0.09));
  lone.add(target);
  const hookRay = lone.intersectRay(new Vec2(-1, 0), new Vec2(1, 0), { collisionMask: 1 | 2 });
  const solidRay = lone.intersectRay(new Vec2(-1, 0), new Vec2(1, 0), { collisionMask: 1 });
  check(`a hook ray (mask 1|2) reaches a link`, hookRay?.collider === target);
  check(`a mask-1 ray - every other query in the game - does not`, solidRay === null);

  return ok("link-contacts — a non-solid body blocks nothing, and is blocked only by statics", passed, details);
}

// ---------------------------------------------------------------------------
// rest: a vine hangs straight, settles, and stays where it settled.
//
// The bound on the droop is the one the sweep's own tolerance implies. It is a
// per-CHAIN bound and a vine is a series of them, so a settled vine may hang up
// to `links * CHAIN_TOLERANCE` longer than its authored length; what may not
// happen is any pair ending a frame over that bound, or the vine creeping,
// ringing, or leaning off the plumb line under no load at all.
// ---------------------------------------------------------------------------
function caseRest(): VineResult {
  const details: string[] = [];
  let passed = true;
  const rig = new Rig(hall({ vineLength: 300 }));
  const vine = rig.vine;
  rig.step(240);

  const start = vine.links.map((l) => l.globalPosition);
  let worstOver = 0;
  let worstSpeed = 0;
  let worstLean = 0;
  rig.step(120, {}, () => {
    for (const c of vine.chains) worstOver = Math.max(worstOver, c.residual);
    for (const l of vine.links) {
      worstSpeed = Math.max(worstSpeed, l.linearVelocity.length());
      worstLean = Math.max(worstLean, Math.abs(l.globalPosition.x));
    }
  });
  let drift = 0;
  vine.links.forEach((l, i) => {
    drift = Math.max(drift, l.globalPosition.distanceTo(start[i]!));
  });

  const anchorY = vine.anchorContact.globalPosition.y;
  const tipY = vine.links[vine.links.length - 1]!.globalPosition.y;
  const hang = tipY - anchorY;
  const droopBound = vine.links.length * CHAIN_TOLERANCE;
  const droop = hang - 3;

  const claims: Array<[string, boolean]> = [
    [`${vine.links.length} links, ${vine.chains.length} pair chains`, vine.links.length === 20 && vine.chains.length === 20],
    [`worst pair over-length ${(worstOver * 1000).toFixed(3)} mm <= ${CHAIN_TOLERANCE * 1000} mm`, worstOver <= CHAIN_TOLERANCE],
    [`hangs ${hang.toFixed(4)} m against 3 m authored: droop ${(droop * 1000).toFixed(1)} mm, bound ${(droopBound * 1000).toFixed(0)} mm`, droop >= 0 && droop <= droopBound],
    [`plumb: worst |x| ${(worstLean * 1000).toFixed(3)} mm <= 1 mm`, worstLean <= 0.001],
    [`settled: worst link speed ${worstSpeed.toFixed(5)} m/s <= 0.05`, worstSpeed <= 0.05],
    [`no creep: worst drift over 120 frames ${(drift * 1000).toFixed(3)} mm <= 1 mm`, drift <= 0.001],
  ];
  for (const [claim, got] of claims) {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  }
  return ok("rest — a vine hangs plumb, within the sweep's own tolerance, and stays there", passed, details);
}

// ---------------------------------------------------------------------------
// drape: a vine landing on a ledge, and a vine pooling on a floor.
//
// Both are emergent and need no vine-specific code at all - link-vs-static
// contacts in `World.integrate`, plus the chain phase's own depenetration
// against statics - so what is asserted is that the emergence is STABLE: the
// geometry really is holding the vine up, nothing ends up inside it, nothing
// buzzes, and nothing walks across the floor for ever.
//
// A vine longer than its drop is the case that made the spawn rule necessary,
// and it is the pool: authored straight through the floor, its tail spawns past
// the slab's midline, is depenetrated out of the FAR face, and hangs below the
// world while the pair chain above pays out rope to it for ever (see
// `dropDistance`). It reads as the vine growing without limit, and no invariant
// in the project can see it.
// ---------------------------------------------------------------------------
function caseDrape(): VineResult {
  const details: string[] = [];
  let passed = true;

  const check = (claim: string, got: boolean): void => {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  };

  const settle = (rig: Rig, frames: number): { speed: number; embed: number; drift: number } => {
    rig.step(frames);
    const p0 = rig.vine.links.map((l) => l.globalPosition);
    let speed = 0;
    let embed = 0;
    rig.step(120, {}, () => {
      embed = Math.max(embed, rig.worstEmbed());
      for (const l of rig.vine.links) speed = Math.max(speed, l.linearVelocity.length());
    });
    let drift = 0;
    rig.vine.links.forEach((l, i) => {
      drift = Math.max(drift, l.globalPosition.distanceTo(p0[i]!));
    });
    return { speed, embed, drift };
  };

  // (a) A ledge across the vine's drop, 2.8 m below the anchor. A 4 m vine would
  // hang to y = -0.8 in clear air; on the ledge its tail stops at the ledge's
  // top face, a link's radius clear of it.
  const ledge: LevelBodyData = {
    kind: "static",
    x: -80,
    y: -200,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 40 } }],
  };
  const over = new Rig(hall({ vineLength: 400, extra: [ledge] }));
  const o = settle(over, 360);
  const tipY = over.vine.links[over.vine.links.length - 1]!.globalPosition.y;
  check(`ledge: the tail is held at ${tipY.toFixed(3)} m, not the -0.8 m of a free hang`, tipY <= -2.1);
  check(`ledge: worst embed ${(o.embed * 1000).toFixed(2)} mm <= 5 mm`, o.embed <= 0.005);
  check(`ledge: worst link speed ${o.speed.toFixed(4)} m/s <= 0.05`, o.speed <= 0.05);
  check(`ledge: worst drift over 120 frames ${(o.drift * 1000).toFixed(2)} mm <= 5 mm`, o.drift <= 0.005);

  // (b) A 6 m vine over a 4.6 m drop: 1.4 m of it has nowhere to go but the
  // floor. This is the runaway case above.
  const pool = new Rig(hall({ vineLength: 600, floorY: 100 }));
  const p = settle(pool, 420);
  const floorTop = 1 - 0.2;
  const resting = pool.vine.links.filter((l) => l.globalPosition.y > floorTop - 0.2).length;
  const deepest = Math.max(...pool.vine.links.map((l) => l.globalPosition.y));
  check(`pool: ${resting} of ${pool.vine.links.length} links are down on the floor`, resting >= 5);
  check(`pool: nothing is below the floor (deepest link ${deepest.toFixed(3)} m)`, deepest <= floorTop);
  check(`pool: worst embed ${(p.embed * 1000).toFixed(2)} mm <= 5 mm`, p.embed <= 0.005);
  check(`pool: worst link speed ${p.speed.toFixed(4)} m/s <= 0.05`, p.speed <= 0.05);
  check(`pool: worst drift over 120 frames ${(p.drift * 1000).toFixed(2)} mm <= 5 mm`, p.drift <= 0.005);

  return ok("drape — a vine landing on a ledge and a vine pooling on a floor both settle, and neither is inside the geometry", passed, details);
}

// ---------------------------------------------------------------------------
// pass-through: the player walks and swings through a resting vine, and the two
// runs are BIT-IDENTICAL.
//
// Anything weaker than bit-identical is satisfiable by a vine that shoves the
// player a millimetre, which is the failure this is written against: the guards
// are three lines in the hottest loops in the engine, and "almost no effect" is
// exactly what a half-applied one looks like.
// ---------------------------------------------------------------------------
function casePassThrough(): VineResult {
  const details: string[] = [];
  // The vine hangs to the floor across the player's path, so the walk really
  // does go through it rather than under it.
  const withVine = new Rig(hall({ vineLength: 700, floorY: 100, playerX: -300, playerY: 0 }));
  const without = new Rig(hall({ floorY: 100, playerX: -300, playerY: 0 }));
  // Settle the vine before the walk, so the player meets a vine at rest.
  withVine.step(240);
  without.step(240);

  const script = (f: number): Press => ({ right: true, jump: f === 120 });
  const trackA: Array<[Vec2, Vec2]> = [];
  const trackB: Array<[Vec2, Vec2]> = [];
  withVine.step(300, script, () => {
    trackA.push([withVine.level.player.globalPosition, withVine.level.player.velocity]);
  });
  without.step(300, script, () => {
    trackB.push([without.level.player.globalPosition, without.level.player.velocity]);
  });

  let firstDiff = -1;
  let worst = 0;
  for (let i = 0; i < trackA.length; i++) {
    const [pa, va] = trackA[i]!;
    const [pb, vb] = trackB[i]!;
    const same = pa.x === pb.x && pa.y === pb.y && va.x === vb.x && va.y === vb.y;
    if (!same && firstDiff < 0) firstDiff = i;
    worst = Math.max(worst, pa.distanceTo(pb));
  }
  const crossed = trackA.some(([p]) => p.x > 0.2) && trackA[0]![0].x < -0.2;
  const passed = firstDiff < 0 && crossed;
  details.push(
    `${crossed ? "ok  " : "BAD "} the walk really crosses the vine ` +
      `(x ${trackA[0]![0].x.toFixed(2)} -> ${trackA[trackA.length - 1]![0].x.toFixed(2)})`,
  );
  details.push(
    `${firstDiff < 0 ? "ok  " : "BAD "} 300 frames of walking, jumping and landing are bit-identical ` +
      `with and without the vine (first difference at frame ${firstDiff}, worst ${(worst * 1000).toFixed(3)} mm)`,
  );
  return ok("pass-through — a vine changes nothing about the avatar that walks through it", passed, details);
}

// Fire at a point and hold, until the rope's far end is a vine link. Returns the
// index grabbed, or -1.
function grab(rig: Rig, aim: Vec2, frames = 90): number {
  let index = -1;
  rig.step(frames, { fire: true, aim }, () => {
    if (index < 0) index = rig.heldIndex();
  });
  return index;
}

// ---------------------------------------------------------------------------
// grab-hang: the load rope's entire job, in millimetres.
//
// The player hangs and swings off the middle of a vine. The arc of vine between
// the anchor and the grabbed link may not measurably exceed what it was when the
// hook landed - that is what stops the vine reading as elastic, and it is the
// one thing the pair chains alone cannot do (`links * CHAIN_TOLERANCE` of give,
// and a 70:3.75 kg mass split at the grabbed link).
// ---------------------------------------------------------------------------
function caseGrabHang(): VineResult {
  const details: string[] = [];
  let passed = true;
  const rig = new Rig(hall({ vineLength: 300, playerX: -250, playerY: -320 }));
  rig.step(30);
  const mid = Math.floor(rig.vine.links.length / 2);
  const aim = rig.vine.links[mid]!.globalPosition;
  const index = grab(rig, aim, 20);

  const arcAtGrab = rig.arcTo(index);
  let worstArc = 0;
  let worstLraOver = 0;
  let lraMissing = 0;
  rig.step(400, { fire: true, aim }, () => {
    worstArc = Math.max(worstArc, rig.arcTo(index));
    const lra = rig.vine.lra;
    if (!lra) {
      lraMissing++;
      return;
    }
    worstLraOver = Math.max(worstLraOver, lra.rope.getCurrentLength() - lra.rope.maxRopeLength);
  });

  const player = rig.level.player;
  const swung = Math.abs(player.globalPosition.x - aim.x) > 0.3 || player.globalPosition.y < aim.y;
  const claims: Array<[string, boolean]> = [
    [`grabbed link ${index} of ${rig.vine.links.length}`, index === mid],
    [`a load rope exists on every one of the 400 held frames (${lraMissing} missing)`, lraMissing === 0],
    // The sharp one, and the load rope's whole job: the CONSTRAINT is never over
    // its own length. It reads exactly zero, which is what "the vine does not
    // stretch under load" means.
    [
      `load rope worst over its own length ${(worstLraOver * 1000).toFixed(3)} mm <= 1 mm`,
      worstLraOver <= 0.001,
    ],
    // The arc is a different quantity and needs its own bound. It is the summed
    // link-to-link distance, so it exceeds the load rope's routed length by
    // however far the links BOW off that line - which the pair chains' own
    // tolerance permits, at up to `CHAIN_TOLERANCE` each. A number here instead
    // of the rule reads as a regression the first time anything changes how the
    // vine hangs, which is what damping the links did to it (3 mm to 11).
    [
      `anchor-to-grab arc ${worstArc.toFixed(4)} m against ${arcAtGrab.toFixed(4)} at the grab: ` +
        `excess ${((worstArc - arcAtGrab) * 1000).toFixed(2)} mm, bound ` +
        `${((index + 1) * CHAIN_TOLERANCE * 1000).toFixed(0)} mm (${index + 1} pairs of bow)`,
      worstArc - arcAtGrab <= (index + 1) * CHAIN_TOLERANCE,
    ],
    [`the player is actually hanging on it (swung off the grab point)`, swung],
  ];
  for (const [claim, got] of claims) {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  }
  return ok("grab-hang — the load rope holds the anchor-to-grab arc under a swinging player", passed, details);
}

// ---------------------------------------------------------------------------
// winch: how far a winch hauls must not depend on what is holding the far end.
//
// `ball-winch-hung-anchor`'s methodology, and here for a sharper reason than
// there: a PBD correction splits by inverse mass, and the ratio between the
// player and one link is 19:1 where the ball's against its hung anchor was 5:1.
// Left uncoupled, the rope's correction lands almost entirely on the link, the
// load rope puts it straight back, and the player is hauled by what is left.
// ---------------------------------------------------------------------------
function caseWinch(): VineResult {
  const details: string[] = [];
  const rig = new Rig(hall({ vineLength: 300, playerX: -250, playerY: -320 }));
  rig.step(30);
  const mid = Math.floor(rig.vine.links.length / 2);
  const aim = rig.vine.links[mid]!.globalPosition;
  grab(rig, aim, 20);
  const vineStart = rig.level.player.globalPosition;
  rig.step(240, { fire: true, retract: true, aim });
  const vineTravel = vineStart.distanceTo(rig.level.player.globalPosition);

  // The same rig with a small static block where the link was, and no vine at
  // all: the winch's own baseline.
  const block: LevelBodyData = {
    kind: "static",
    x: Math.round(aim.x * P),
    y: Math.round(aim.y * P),
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 18, h: 18 } }],
  };
  const control = new Rig(hall({ playerX: -250, playerY: -320, extra: [block] }));
  control.step(30);
  control.step(20, { fire: true, aim });
  const staticStart = control.level.player.globalPosition;
  control.step(240, { fire: true, retract: true, aim });
  const staticTravel = staticStart.distanceTo(control.level.player.globalPosition);

  const ratio = staticTravel > 0 ? vineTravel / staticTravel : 0;
  const passed = ratio >= 0.8;
  details.push(
    `${passed ? "ok  " : "BAD "} winched ${vineTravel.toFixed(3)} m up a vine against ` +
      `${staticTravel.toFixed(3)} m up a static in the same place (${(ratio * 100).toFixed(0)}%, want >= 80%)`,
  );
  return ok("winch — hauling up a vine goes as far as hauling up a static", passed, details);
}

// ---------------------------------------------------------------------------
// corner-grab: a load rope routed round a corner.
//
// This is the whole reason the load rope is a wrap-point `Rope` and not the
// straight long-range attachment the PBD literature describes: a straight one is
// wrong the moment the vine bends round something, and this one routes itself
// and keeps its length exact along the routed path.
// ---------------------------------------------------------------------------
function caseCornerGrab(): VineResult {
  const details: string[] = [];
  let passed = true;
  const check = (claim: string, got: boolean): void => {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  };

  // A pillar beside the vine, so hauling the grabbed link sideways puts its
  // corner between the anchor and the grab.
  const pillar: LevelBodyData = {
    kind: "static",
    x: 90,
    y: -330,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 60, h: 300 } }],
  };
  const rig = new Rig(hall({ vineLength: 400, playerX: 420, playerY: -120, extra: [pillar] }));
  rig.step(60);
  const grabIndex = rig.vine.links.length - 3;
  const aim = rig.vine.links[grabIndex]!.globalPosition;
  const index = grab(rig, aim, 40);
  check(`grabbed a link near the free end (${index} of ${rig.vine.links.length})`, index >= 0);

  let wrapped = 0;
  let worstOver = 0;
  rig.step(300, { fire: true, right: true, aim: rig.level.player.globalPosition.add(new Vec2(2, 0)) }, () => {
    const lra = rig.vine.lra;
    if (!lra) return;
    if (lra.rope.path().length > 2) wrapped++;
    worstOver = Math.max(worstOver, lra.rope.overLength);
  });
  check(`the load rope routed round the pillar on ${wrapped} frames`, wrapped > 0);
  check(
    `and stayed at its routed length: worst over-length ${(worstOver * 1000).toFixed(2)} mm <= ${CHAIN_TOLERANCE * 1000} mm`,
    worstOver <= CHAIN_TOLERANCE,
  );

  // Release: the rule is derived per frame, so letting go of fire removes it.
  rig.step(1, {});
  check("releasing the hook removes the load rope on the very next frame", rig.vine.lra === null);
  rig.step(300);
  const maxSpeed = Math.max(...rig.vine.links.map((l) => l.linearVelocity.length()));
  check(`and the vine relaxes and settles (worst link speed ${maxSpeed.toFixed(4)} m/s <= 0.15)`, maxSpeed <= 0.15);

  return ok("corner-grab — the load rope wraps a corner, keeps its routed length, and goes away on release", passed, details);
}

// ---------------------------------------------------------------------------
// release-refire: zero or one load rope, on every frame.
//
// The rule is derived from the world each frame rather than driven by grab and
// release events, and this is that claim stated as the thing it buys: a fire, a
// grab, a release, a regrab on a different link, and at no point two load ropes
// pulling on one vine or a stale one pulling on a link nobody is holding.
// ---------------------------------------------------------------------------
function caseReleaseRefire(): VineResult {
  const details: string[] = [];
  let passed = true;
  const rig = new Rig(hall({ vineLength: 300, playerX: -250, playerY: -320 }));
  rig.step(30);
  const links = rig.vine.links;
  const first = Math.floor(links.length / 2);
  const second = links.length - 4;

  let bad = 0;
  let mismatched = 0;
  const audit = (): void => {
    const live = rig.vine.lra ? 1 : 0;
    if (live > 1) bad++;
    const held = rig.heldIndex();
    // The rule, restated: a load rope exists exactly while the rope ends on a
    // link of this vine, and it is tied to that link.
    if ((held >= 0) !== (live === 1)) mismatched++;
    if (live === 1 && rig.vine.lraLink !== links[held]) mismatched++;
  };

  const aimA = links[first]!.globalPosition;
  rig.step(60, { fire: true, aim: aimA }, audit);
  const grabbedA = rig.heldIndex();
  // Let go, fall clear, then fire again at a different link.
  rig.step(40, {}, audit);
  const releasedClean = rig.vine.lra === null;
  const aimB = links[second]!.globalPosition;
  rig.step(90, { fire: true, aim: aimB }, audit);
  const grabbedB = rig.heldIndex();
  rig.step(40, {}, audit);

  const claims: Array<[string, boolean]> = [
    [`first grab landed on link ${grabbedA}`, grabbedA >= 0],
    [`releasing left no load rope`, releasedClean],
    [`the second grab landed on a different link (${grabbedB})`, grabbedB >= 0 && grabbedB !== grabbedA],
    [`never more than one load rope (${bad} frames)`, bad === 0],
    [`the load rope matched what the player was holding on every frame (${mismatched} mismatches)`, mismatched === 0],
    [`and none is left over at the end`, rig.vine.lra === null],
  ];
  for (const [claim, got] of claims) {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  }
  return ok("release-refire — the load rope is exactly what the player is holding, every frame", passed, details);
}

// ---------------------------------------------------------------------------
// format: a vine survives both round trips.
//
// Neither is visible anywhere else, and both fail silently. A `length` the
// scaler forgets is a vine a hundred times too long, and the EDITOR rewrites the
// whole file every 750 ms while a level is open - so a field it drops is gone
// from disk before anyone notices it was read, and the level simply loads one
// day with no vine in it.
// ---------------------------------------------------------------------------
function caseFormat(): VineResult {
  const details: string[] = [];
  let passed = true;
  const check = (claim: string, got: boolean): void => {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  };

  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 12 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: -300,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 400, h: 40 } },
          { type: "anchor", id: 7, x: 0, y: 20 },
        ],
      },
    ],
    vines: [
      { anchor: 7, length: 250, spacing: 12, density: 8, stiffness: 0.4, color: "#446622" },
    ],
  };

  // px -> m: the two LENGTHS scale and nothing else does. The density is the
  // trap here - it is a number with a metre in it (kg/m) that must NOT be
  // scaled, and scaling it would make every authored weight wrong by 100x.
  const metres = scaleLevelData(authored, PX);
  const mv = metres.vines?.[0];
  check(
    `px -> m: length ${mv?.length} m, spacing ${mv?.spacing} m, anchor ${mv?.anchor}, colour ${mv?.color}`,
    mv?.length === 2.5 && mv?.spacing === 0.12 && mv.anchor === 7 && mv.color === "#446622",
  );
  check(`px -> m: density ${mv?.density} kg/m crosses unchanged`, mv?.density === 8);
  // A fraction, like the density a per-metre figure: neither is in the file's
  // pixels, and a scaled stiffness would make a pole out of a cord.
  check(`px -> m: stiffness ${mv?.stiffness} crosses unchanged`, mv?.stiffness === 0.4);

  // ...and back, which is the trip that catches a field the scaler copies in one
  // direction only.
  const back = scaleLevelData(metres, P);
  check(
    `m -> px round trip is exact`,
    JSON.stringify(back.vines) === JSON.stringify(authored.vines),
  );

  // The editor's own trip, through `EdVine`, which is a different shape entirely.
  const saved = modelToDisk(modelFromDisk(authored));
  const sv = saved.vines?.[0];
  const anchorObj = saved.bodies[0]?.objects.find((o) => o.type === "anchor");
  check(
    `editor: saved back as anchor ${sv?.anchor}, length ${sv?.length}, spacing ${sv?.spacing}, ` +
      `density ${sv?.density}, stiffness ${sv?.stiffness}, colour ${sv?.color}`,
    sv !== undefined &&
      sv.length === 250 &&
      sv.spacing === 12 &&
      sv.density === 8 &&
      sv.stiffness === 0.4 &&
      sv.color === "#446622" &&
      anchorObj?.type === "anchor" &&
      sv.anchor === anchorObj.id,
  );

  // An unauthored spacing and colour must come back ABSENT rather than as the
  // editor's idea of the default written out, or a level gains fields nobody
  // authored the first time it is opened.
  const bare = modelToDisk(
    modelFromDisk({ ...authored, vines: [{ anchor: 7, length: 250 }] }),
  ).vines?.[0];
  check(
    `editor: an unauthored spacing, density, stiffness and colour stay absent`,
    bare?.spacing === undefined &&
      bare?.density === undefined &&
      bare?.stiffness === undefined &&
      bare?.color === undefined,
  );

  // A vine hung off the TOP of a body has nowhere to go, and every link piles at
  // the anchor rather than threading down through the body it is bolted to (see
  // `dropDistance`). Nothing else can see this: the vine renders, no invariant
  // fires, and what a level gets is a vine hanging through its own floor.
  const upsideDown = new Rig({
    ...authored,
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 400, h: 40 } },
          // On the TOP face, so the vine is asked to hang into the slab.
          { type: "anchor", id: 7, x: 0, y: -20 },
        ],
      },
    ],
    vines: [{ anchor: 7, length: 300 }],
  });
  upsideDown.step(120);
  const anchorY = upsideDown.vine.anchorContact.globalPosition.y;
  const deepest = Math.max(...upsideDown.vine.links.map((l) => l.globalPosition.y));
  check(
    `a vine hung off the top of a body piles at its anchor (deepest link ${((deepest - anchorY) * 1000).toFixed(0)} mm below it, not 3000)`,
    deepest - anchorY < 0.3,
  );

  // A vine naming an anchor the level does not have is dropped at both ends,
  // exactly as a chain end is.
  const orphan = new Rig({ ...authored, vines: [{ anchor: 99, length: 250 }] });
  check(`a vine naming a missing anchor builds nothing`, orphan.level.vines.length === 0);
  const zero = new Rig({ ...authored, vines: [{ anchor: 7, length: 0 }] });
  check(`and so does one of no length`, zero.level.vines.length === 0);

  return ok("format — a vine survives the metre conversion and the editor's own round trip", passed, details);
}

// ---------------------------------------------------------------------------
// ball-vine: the ball passes through a vine, its HOOK catches on one.
//
// Both halves are wanted and they are different questions. The ball's BODY goes
// through because a link is non-solid like anything else; its CHAIN catches
// because `BallHook`'s attach paths take a link like any other rigid body. A
// vine is a thing to hook, not a thing to bump into.
//
// The pass-through half is asserted as bit-identical, for the reason
// `pass-through` is: "the ball barely noticed the vine" is what a half-applied
// guard looks like. The catch half is asserted with the energy, because hanging
// 52 kg off a 75 kg vine through two coupled constraints is exactly where a
// solver mints joules, and the ball corpus's `energy-gained` invariant is a
// 17 J bar on a scene a vine adds ~940 J to.
// ---------------------------------------------------------------------------
function caseBallVine(): VineResult {
  const details: string[] = [];
  let passed = true;
  const check = (claim: string, got: boolean): void => {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  };

  const scene = (withVine: boolean): RawLevelData => ({
    player: { x: 120, y: 200, radius: 12 },
    bodies: [
      { kind: "static", x: 0, y: 300, rot: 0, objects: [{ type: "collision", shape: { kind: "rect", w: 2000, h: 40 } }] },
      {
        kind: "static",
        x: 0,
        y: -500,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 600, h: 40 } },
          { type: "anchor", id: 1, x: 0, y: 20 },
        ],
      },
    ],
    ...(withVine ? { vines: [{ anchor: 1, length: 700, spacing: 20 }] } : {}),
  });

  const drive = (level: BallLevel) => {
    let prev = emptyFrameInput();
    return (deploy: boolean, aim: Vec2): void => {
      const input: FrameInput = {
        ...emptyFrameInput(),
        fire: button(deploy, prev.fire),
        mouseWorldPosition: aim,
      };
      prev = input;
      level.physicsProcess(input, DT);
    };
  };

  // (a) The ball falling straight down a vine's line. Both sides of the pair are
  // asserted, and the second is the one that has teeth: the ball's own track
  // stays bit-identical even when the guard is only half applied, because the
  // half that was missing pushes the LINK rather than the ball.
  //
  // The ball is dropped rather than steered, and that is the point of the rig.
  // A ball has no drive of its own - the aim steers a roll, the chain does the
  // rest - so a "roll at the vine" that never deploys the chain travels about
  // 13 cm and passes 1.1 m clear of the nearest link. The encounter is therefore
  // asserted too (`closest approach`), because a pass-through case that never
  // reaches the thing it passes through is a case that cannot fail.
  const fall = (withVine: boolean, ballX: number) => {
    const data = scene(withVine);
    const level = new BallLevel({ ...data, player: { ...data.player, x: ballX, y: -420 } });
    const feed = drive(level);
    const ball: Array<[Vec2, Vec2]> = [];
    const links: Vec2[][] = [];
    let closest = Infinity;
    for (let f = 0; f < 240; f++) {
      feed(false, Vec2.ZERO);
      const p = level.ball.globalPosition;
      ball.push([p, level.ball.linearVelocity]);
      const vine = level.vines[0];
      if (!vine) continue;
      links.push(vine.links.map((l) => l.globalPosition));
      for (const l of vine.links) closest = Math.min(closest, l.globalPosition.distanceTo(p));
    }
    return { ball, links, closest };
  };
  // Down the vine's own line, the same drop with the vine deleted, and the same
  // drop with the ball 15 m along the hall - the control for the vine's side.
  const through = fall(true, 0);
  const noVine = fall(false, 0);
  const farAway = fall(true, 1500);

  check(
    `the ball really does fall through the vine (closest approach ` +
      `${through.closest.toFixed(3)} m, touching under 0.21)`,
    through.closest < 0.21,
  );

  let firstDiff = -1;
  for (let i = 0; i < through.ball.length; i++) {
    const [pa, va] = through.ball[i]!;
    const [pb, vb] = noVine.ball[i]!;
    if (pa.x !== pb.x || pa.y !== pb.y || va.x !== vb.x || va.y !== vb.y) {
      firstDiff = i;
      break;
    }
  }
  check(
    `240 frames of the ball falling through a vine are bit-identical to the same fall with no vine ` +
      `(first difference at frame ${firstDiff})`,
    firstDiff < 0,
  );

  let vineDiff = -1;
  let vineWorst = 0;
  for (let i = 0; i < through.links.length; i++) {
    for (let k = 0; k < through.links[i]!.length; k++) {
      const d = through.links[i]![k]!.distanceTo(farAway.links[i]![k]!);
      vineWorst = Math.max(vineWorst, d);
      if (d !== 0 && vineDiff < 0) vineDiff = i;
    }
  }
  check(
    `and the VINE is bit-identical to the same 240 frames with the ball 15 m away ` +
      `(first difference at frame ${vineDiff}, worst ${(vineWorst * 1000).toFixed(2)} mm)`,
    vineDiff < 0,
  );

  // (b) The chain thrown at the vine catches it, and hangs there without the
  // pair minting energy.
  const level = new BallLevel(scene(true));
  const feed = drive(level);
  for (let f = 0; f < 180; f++) feed(false, Vec2.ZERO);
  const vine = level.vines[0]!;
  const aim = vine.links[vine.links.length - 4]!.globalPosition;
  for (let f = 0; f < 60; f++) feed(true, aim);
  const held = level.ball.chain?.end.contact.obj;
  check(`the chain caught a link`, held instanceof VineLink);
  check(`and a load rope was made for it`, vine.lra !== null);

  const at = mechanicalEnergy(level.world);
  let worst = 0;
  for (let f = 0; f < 1200; f++) {
    feed(true, aim);
    worst = Math.max(worst, mechanicalEnergy(level.world) - at);
  }
  check(
    `hanging on it for 20 s gains ${worst.toFixed(2)} J of mechanical energy (bar 5)`,
    worst <= 5,
  );

  return ok("ball-vine — the ball rolls through a vine and its chain catches on one", passed, details);
}

// ---------------------------------------------------------------------------
// sleep: a settled vine costs nothing, and wakes when it is caught.
//
// This is the engine's one piece of sleeping (see `VineLink.asleep`) and it is
// what makes a vine affordable: two 3 m vines in the ball arena are 3.9 ms a
// physics frame awake and 0.19 ms asleep, against 0.21 ms for the same arena
// with no vines in it at all.
//
// Every clause here is a way it could go wrong quietly. A vine that never
// sleeps is the cost back; one that sleeps while still moving freezes in mid
// air; one that does not wake when the hook takes it is a vine the player
// cannot use.
// ---------------------------------------------------------------------------
function caseSleep(): VineResult {
  const details: string[] = [];
  let passed = true;
  const check = (claim: string, got: boolean): void => {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  };

  // The floor close under the spawn, so the player is still within reach of the
  // vine after the long settle this case needs.
  const rig = new Rig(hall({ vineLength: 300, floorY: 100, playerX: -100, playerY: -320 }));
  const vine = rig.vine;
  rig.step(30);
  check(`still awake while it is settling (frame 30)`, !vine.asleep);

  let sleptAt = -1;
  rig.step(600, {}, (f) => {
    if (sleptAt < 0 && vine.asleep) sleptAt = f + 31;
  });
  check(`asleep by frame ${sleptAt} of 630`, vine.asleep && sleptAt > 0 && sleptAt < 500);

  // Asleep it must STAY where it was, not drift or fall.
  const at = vine.links.map((l) => l.globalPosition);
  rig.step(300);
  let drift = 0;
  vine.links.forEach((l, i) => {
    drift = Math.max(drift, l.globalPosition.distanceTo(at[i]!));
  });
  check(`and does not move a micron over the next 300 frames (${(drift * 1000).toFixed(4)} mm)`, drift === 0);
  check(`its links report themselves asleep to the engine`, vine.links.every((l) => l.asleep));

  // The hook takes it: awake on the frame it is caught.
  const aim = vine.links[vine.links.length - 2]!.globalPosition;
  const index = grab(rig, aim, 60);
  check(`grabbed link ${index}`, index >= 0);
  check(`awake the moment it is held`, !vine.asleep && vine.links.every((l) => !l.asleep));
  rig.step(120, { fire: true, aim });
  check(`and stays awake while it is held`, !vine.asleep);

  // Released, it settles and goes back to sleep.
  let sleptAgain = false;
  rig.step(900, {}, () => {
    if (vine.asleep) sleptAgain = true;
  });
  check(`sleeps again once let go`, sleptAgain);

  return ok("sleep — a settled vine costs nothing, holds its place, and wakes when the hook takes it", passed, details);
}

// ---------------------------------------------------------------------------
// ball-steer: the ball turns while it hangs on a vine.
//
// Aim steering is kinematic - `BallPlayer.resolveInput` writes the frame's
// angular velocity straight from the aim error - so a ball that will not turn is
// never a torque problem. It is something later in the frame taking the rotation
// back, and the only thing that does is `unwindOverLength`, which refuses
// over-length the chain phase could not pay.
//
// Holding a vine, the phase does not TRY to pay: the coupled sweep leaves the
// ball's chain inside `CHAIN_TOLERANCE` rather than at zero (see `sweepChains`),
// and 5 mm of solver budget billed to the spin is the whole frame's turn. That
// was `session-337f`: the rope ended over length on all 312 held frames, the
// unwind took the entire turn back on 107 of them, the ball's rotation stood at
// exactly -0.17794 rad while the aim error wound up to 13.8 rad/s, and the game
// read as a force resisting the mouse.
//
// So the case is written in the unit the player feels - how far the loop lags
// the aim it is being steered to - at a rate a hand actually moves at (a full
// turn every 4 s). Unfixed it reads 109 degrees of lag and 133 frames of a ball
// that did not turn at all; fixed, 19 degrees and none.
// ---------------------------------------------------------------------------
function caseBallSteer(): VineResult {
  const details: string[] = [];
  let passed = true;
  const check = (claim: string, got: boolean): void => {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  };

  const data: RawLevelData = {
    player: { x: 120, y: 200, radius: 12 },
    bodies: [
      { kind: "static", x: 0, y: 300, rot: 0, objects: [{ type: "collision", shape: { kind: "rect", w: 2000, h: 40 } }] },
      {
        kind: "static",
        x: 0,
        y: -500,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 600, h: 40 } },
          { type: "anchor", id: 1, x: 0, y: 20 },
        ],
      },
    ],
    vines: [{ anchor: 1, length: 700, spacing: 20 }],
  };

  const level = new BallLevel(data);
  let prev = emptyFrameInput();
  const feed = (fire: boolean, aim: Vec2): void => {
    const input: FrameInput = {
      ...emptyFrameInput(),
      fire: button(fire, prev.fire),
      mouseWorldPosition: aim,
    };
    prev = input;
    level.physicsProcess(input, DT);
  };

  for (let f = 0; f < 180; f++) feed(false, Vec2.ZERO);
  const vine = level.vines[0]!;
  const grabAt = vine.links[vine.links.length - 4]!.globalPosition;
  for (let f = 0; f < 60; f++) feed(true, grabAt);
  check(`the chain is holding a link`, level.ball.chain?.end.contact.obj instanceof VineLink);

  // The sweep starts where the loop already points, so what is measured is the
  // steering rather than the transient of catching up to a jump.
  const start = level.ball.loopDirection.angle();
  let worstLag = 0;
  let pinned = 0;
  let turned = 0;
  let previous = level.ball.globalRotation;
  const FRAMES = 600;
  for (let f = 0; f < FRAMES; f++) {
    const angle = start + (f / 240) * Math.PI * 2;
    const aim = level.ball.globalPosition.add(
      new Vec2(Math.cos(angle), Math.sin(angle)).mul(2),
    );
    feed(true, aim);
    // The controller's own error term, read after the frame: how far the loop
    // still is from the aim it was steered to (`BallPlayer.resolveInput`).
    const lag = Math.abs(
      wrapAngle(aim.sub(level.ball.globalPosition).angle() - level.ball.loopDirection.angle()),
    );
    worstLag = Math.max(worstLag, lag);
    const step = level.ball.globalRotation - previous;
    previous = level.ball.globalRotation;
    // A frame that asked for a turn and got none. The aim moves 1.5 degrees a
    // frame here, so every one of these is a refusal.
    if (step === 0 && lag > 0.01) pinned++;
    turned += Math.abs(step);
  }

  check(
    `and still holding it ${FRAMES} frames later`,
    level.ball.chain?.end.contact.obj instanceof VineLink,
  );
  check(
    `the loop never lags the aim by more than ${((worstLag * 180) / Math.PI).toFixed(1)} deg (bar 45)`,
    worstLag < Math.PI / 4,
  );
  check(`and the ball is never pinned for a frame (${pinned} of ${FRAMES})`, pinned === 0);
  // Loose, and only here to catch the degenerate way the two above could pass:
  // a ball that never turns and an aim it happens to stay near.
  check(`the ball turned ${(turned / (Math.PI * 2)).toFixed(2)} times while it did it`, turned > Math.PI * 2);

  return ok("ball-steer — the ball turns to the aim while it hangs on a vine", passed, details);
}

// ---------------------------------------------------------------------------
// weight: what an authored density does, and what it must not do.
//
// `VineData.density` is kilograms per METRE, so the same vine weighs the same
// whatever spacing it is built at, and the number is deliberately not a length -
// a scaler that treated it as one would make every authored weight wrong by a
// factor of 100 (`format` asserts that crossing).
//
// The thing worth asserting about weight is what it DOESN'T change. Gravity is
// mass-independent, so a heavy vine and a light one hang in exactly the same
// place and swing at exactly the same rate; what weight buys is how the vine
// answers a hooked player, through the mass split at the grabbed link. Measured
// here on a 3 m vine with a player swinging on the middle of it, worst stretch
// of the load rope:
//
//   density   per link   stretch   swinging cost
//     2 kg/m    0.30 kg    622 mm         8.3 ms
//     8 kg/m    1.20 kg     23 mm         8.1 ms
//    25 kg/m    3.75 kg      0 mm         3.6 ms
//    60 kg/m    9.00 kg      0 mm         2.0 ms
//
// So a light vine is a real authoring choice with a real cost, which is why the
// editor warns below `LIGHT_LINK_MASS` rather than refusing the number, and why
// `MIN_VINE_DENSITY` is only the floor where the solve stops converging at all.
// ---------------------------------------------------------------------------
function caseWeight(): VineResult {
  const details: string[] = [];
  let passed = true;
  const check = (claim: string, got: boolean): void => {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  };

  const built = (density: number | undefined) => {
    const rig = new Rig(
      hall({
        vineLength: 300,
        playerX: -250,
        playerY: -320,
        ...(density === undefined ? {} : { density }),
      }),
    );
    rig.step(30);
    return rig;
  };

  // Weight is linear in the density and does not depend on the spacing: the
  // same 3 m vine at 25 kg/m weighs 75 kg made of 20 links or of 10.
  const mass = (rig: Rig): number => rig.vine.links.reduce((m, l) => m + l.mass, 0);
  const light = built(2);
  const heavy = built(60);
  const byDefault = built(undefined);
  const coarse = new Rig(
    hall({ vineLength: 300, spacing: 30, playerX: -250, playerY: -320 }),
  );
  coarse.step(30);
  check(
    `2 kg/m weighs ${mass(light).toFixed(1)} kg and 60 kg/m weighs ${mass(heavy).toFixed(1)} kg`,
    Math.abs(mass(light) - 6) < 1e-9 && Math.abs(mass(heavy) - 180) < 1e-9,
  );
  check(
    `an unauthored density is ${DEFAULT_VINE_DENSITY} kg/m (${mass(byDefault).toFixed(1)} kg)`,
    Math.abs(mass(byDefault) - DEFAULT_VINE_DENSITY * 3) < 1e-9,
  );
  check(
    `and the same vine at half the links still weighs ${mass(coarse).toFixed(1)} kg ` +
      `(${coarse.vine.links.length} links against ${byDefault.vine.links.length})`,
    Math.abs(mass(coarse) - mass(byDefault)) < 1e-9 &&
      coarse.vine.links.length < byDefault.vine.links.length,
  );

  // A density under the floor is BUILT at the floor rather than taken at its
  // word: below it the load rope and the pair chains argue over a link neither
  // can move, and a file may say anything.
  const underfloor = built(0.001);
  check(
    `a density under the floor builds at ${MIN_VINE_DENSITY} kg/m ` +
      `(${mass(underfloor).toFixed(2)} kg, not ${(0.001 * 3).toFixed(3)})`,
    Math.abs(mass(underfloor) - MIN_VINE_DENSITY * 3) < 1e-9,
  );

  // The negative, and the sharp one: weight changes nothing about how a vine
  // hangs. Every link of the heavy vine is where the light one's is, to the bit
  // - anything else would mean mass had leaked into a place gravity does not
  // put it.
  let worstApart = 0;
  for (let i = 0; i < light.vine.links.length; i++) {
    worstApart = Math.max(
      worstApart,
      light.vine.links[i]!.globalPosition.distanceTo(heavy.vine.links[i]!.globalPosition),
    );
  }
  check(
    `a 6 kg vine and a 180 kg one hang in the same place ` +
      `(worst link ${(worstApart * 1e6).toFixed(3)} microns apart)`,
    worstApart < 1e-6,
  );

  // And the positive: the heavier vine holds a hooked player where the light one
  // gives. Same grab, same swing, and the only difference is the number.
  const stretch = (rig: Rig): number => {
    const mid = Math.floor(rig.vine.links.length / 2);
    const aim = rig.vine.links[mid]!.globalPosition;
    grab(rig, aim, 20);
    let worst = 0;
    rig.step(400, { fire: true, aim }, () => {
      const lra = rig.vine.lra;
      if (lra) worst = Math.max(worst, lra.rope.getCurrentLength() - lra.rope.maxRopeLength);
    });
    return worst;
  };
  const lightStretch = stretch(built(2));
  const heavyStretch = stretch(built(60));
  check(
    `the 60 kg/m vine holds the player: load rope stretched ${(heavyStretch * 1000).toFixed(2)} mm (bar 1)`,
    heavyStretch <= 0.001,
  );
  check(
    `the 2 kg/m one gives, which is the trade being offered: ${(lightStretch * 1000).toFixed(0)} mm`,
    lightStretch > heavyStretch,
  );
  check(
    `and a link of it is under the ${LIGHT_LINK_MASS} kg the editor warns at ` +
      `(${(mass(light) / light.vine.links.length).toFixed(2)} kg)`,
    mass(light) / light.vine.links.length < LIGHT_LINK_MASS,
  );

  return ok("weight — an authored density changes what the vine holds, not how it hangs", passed, details);
}

// ---------------------------------------------------------------------------
// stiffness: what an authored stiffness does, and what it must not do.
//
// `VineData.stiffness` is a fraction between a rope and a pole (see
// `level/vineBend.ts`), and nothing else in this suite can see it. A stiff vine
// hangs in exactly the same place as a limp one - straight down, because that
// is its rest pose either way - so the whole difference is what happens when
// something tries to BEND it, and the two things it has to be are:
//
//   - unbendable in proportion to what it says, under the biggest load in the
//     game (a 70 kg player hanging off it), and
//   - CLAMPED at its anchor rather than hinged there: a pole bolted to a
//     ceiling holds itself out along the way it was hung and comes back to it
//     when let go, where a rigid rod on a pivot would swing off like a
//     pendulum and stay wherever it stopped.
//
// ...and the thing it must not do is cost a vine that never asked for it
// anything at all, which is asserted the only way that means anything: the same
// vine, with and without the field, bit for bit.
// ---------------------------------------------------------------------------

// The vine's shape, as the two numbers this case is written in: how far the
// anchor-to-tip chord leans off vertical in degrees, and how straight the cord
// is (chord over arc, 1 being a perfectly straight rod).
function vineLean(vine: Vine): number {
  const a = vine.anchorContact.globalPosition;
  const tip = vine.links[vine.links.length - 1]!.globalPosition;
  const d = tip.sub(a);
  return (Math.atan2(d.x, d.y) * 180) / Math.PI;
}

function vineStraightness(vine: Vine): number {
  const a = vine.anchorContact.globalPosition;
  let arc = 0;
  let prev = a;
  for (const link of vine.links) {
    arc += link.globalPosition.distanceTo(prev);
    prev = link.globalPosition;
  }
  return arc > 0 ? a.distanceTo(prev) / arc : 1;
}

function caseStiffness(): VineResult {
  const details: string[] = [];
  let passed = true;
  const check = (claim: string, got: boolean): void => {
    if (!got) passed = false;
    details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  };

  // A vine that does not ask for stiffness is the vine it always was. Bit for
  // bit against the same level with the field absent, over a run that hangs the
  // player off it - anything less is satisfied by a nearly-no-op.
  const trace = (stiffness: number | undefined): string[] => {
    const rig = new Rig(hall({ vineLength: 300, ...(stiffness === undefined ? {} : { stiffness }) }));
    rig.step(30);
    const aim = rig.vine.links[rig.vine.links.length - 1]!.globalPosition;
    grab(rig, aim, 20);
    const out: string[] = [];
    rig.step(200, { fire: true, aim }, () => {
      for (const link of rig.vine.links) {
        out.push(`${link.globalPosition.x},${link.globalPosition.y}`);
      }
    });
    return out;
  };
  const absent = trace(undefined);
  const zero = trace(0);
  check(
    `stiffness 0 is bit-identical to a vine with no stiffness at all ` +
      `(${absent.length} samples)`,
    absent.length > 0 && absent.join("|") === zero.join("|"),
  );
  const limp = new Rig(hall({ vineLength: 300, stiffness: 0 }));
  check(`...and builds no bend constraints (${limp.vine.bends.length})`, limp.vine.bends.length === 0);

  // The player hooks the TIP and hangs on it, which is the biggest bending load
  // the game has: 70 kg on the end of a 3 m lever.
  const hang = (stiffness: number): { lean: number; straight: number; end: number } => {
    const rig = new Rig(hall({ vineLength: 300, stiffness }));
    rig.step(30);
    const aim = rig.vine.links[rig.vine.links.length - 1]!.globalPosition;
    grab(rig, aim, 20);
    let lean = 0;
    let straight = 1;
    rig.step(400, { fire: true, aim }, () => {
      lean = Math.max(lean, Math.abs(vineLean(rig.vine)));
      straight = Math.min(straight, vineStraightness(rig.vine));
    });
    return { lean, straight, end: Math.abs(vineLean(rig.vine)) };
  };
  const rope = hang(0);
  const pole = hang(1);
  const branch = hang(0.5);
  check(
    `a rope is bent right over by a hooked player: ${rope.lean.toFixed(0)} deg off vertical, ` +
      `${rope.straight.toFixed(3)} straight (bar 30 deg)`,
    rope.lean > 30,
  );
  check(
    `a pole is not: ${pole.lean.toFixed(1)} deg, ${pole.straight.toFixed(3)} straight (bars 5 deg, 0.99)`,
    pole.lean < 5 && pole.straight > 0.99,
  );
  check(
    `and half way between is half way between: ${branch.lean.toFixed(0)} deg, ` +
      `${branch.straight.toFixed(3)} straight`,
    branch.lean < rope.lean && branch.lean > pole.lean && branch.straight > rope.straight,
  );
  // The clamp, from the other side: the player is still hanging on it 400
  // frames later, and the pole is still where it was hung.
  check(
    `the pole is still vertical with the player hanging on it (${pole.end.toFixed(1)} deg, ` +
      `against the rope's ${rope.end.toFixed(0)})`,
    pole.end < 5 && rope.end > pole.end,
  );

  // The clamp is in the ANCHOR BODY's frame, not the world's. Turn the ceiling
  // a quarter turn and a pole goes with it - it holds itself straight out,
  // horizontal, under its own 50 kg - where a rope hangs down as it always did.
  // Nothing else in the game can tell a clamp from a hinge: a hinged rod hangs
  // vertically too.
  const turned = (stiffness: number): number => {
    const rig = new Rig(hall({ vineLength: 200, stiffness, floorY: 900 }));
    rig.step(60);
    rig.vine.anchorContact.obj.globalRotation = -Math.PI / 2;
    rig.step(300);
    return Math.abs(vineLean(rig.vine));
  };
  const turnedPole = turned(1);
  const turnedRope = turned(0);
  check(
    `a pole on a ceiling turned a quarter turn comes with it: ${turnedPole.toFixed(0)} deg ` +
      `off world-down (bar 80)`,
    turnedPole > 80,
  );
  check(
    `...while a rope hangs where gravity says: ${turnedRope.toFixed(0)} deg (bar 5)`,
    turnedRope < 5,
  );

  // A file may say anything. Out of range is clamped rather than fed to a
  // solver: a negative compliance is a joint that bends FURTHER the harder it
  // is pushed, and there is no such vine.
  const over = new Rig(hall({ vineLength: 300, stiffness: 5 }));
  const under = new Rig(hall({ vineLength: 300, stiffness: -2 }));
  const full = new Rig(hall({ vineLength: 300, stiffness: 1 }));
  check(
    `stiffness 5 builds as 1 (${over.vine.stiffness}) and -2 as 0 (${under.vine.stiffness})`,
    over.vine.stiffness === 1 && under.vine.stiffness === 0,
  );
  check(
    `...so the over-stiff vine is the pole (${over.vine.bends.length} bends against ` +
      `${full.vine.bends.length}) and the negative one is the rope (${under.vine.bends.length})`,
    over.vine.bends.length === full.vine.bends.length && under.vine.bends.length === 0,
  );

  // And a stiff vine still SLEEPS. It is scenery, and scenery that is not doing
  // anything must cost nothing - a vine whose bends kept it twitching would
  // never drop out of the sweep, which is where a vine's whole cost is.
  const settling = new Rig(hall({ vineLength: 300, stiffness: 1 }));
  let asleep = -1;
  settling.step(600, {}, (f) => {
    if (asleep < 0 && settling.vine.asleep) asleep = f;
  });
  check(`a pole left alone is asleep by frame ${asleep} of 600`, asleep >= 0);

  return ok("stiffness — a stiff vine refuses to bend and is clamped where it hangs", passed, details);
}

export function runVineCases(): VineResult[] {
  return [
    caseFormat(),
    caseWeight(),
    caseStiffness(),
    caseLinkContacts(),
    caseRest(),
    caseDrape(),
    casePassThrough(),
    caseGrabHang(),
    caseWinch(),
    caseCornerGrab(),
    caseReleaseRefire(),
    caseBallVine(),
    caseBallSteer(),
    caseSleep(),
  ];
}
