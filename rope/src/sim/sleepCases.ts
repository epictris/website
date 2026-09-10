// Sleep cases: a settled body costs nothing, and wakes when something could
// move it.
//
// The engine's rest rule (`World.settleSleep`, `RigidBody2D.asleep`) and the
// chain's (`SceneChain.asleep`) reach no avatar digest and no invariant, so as
// with the vines this is the whole of their coverage. Every case is a way it
// could go wrong quietly: a body that never sleeps is the cost back; one that
// sleeps while still moving freezes in mid air; one that does not wake when the
// hook takes it, a crate lands on it, the platform under it moves or a blast
// reaches it is scenery the player cannot use; and a sleeping crate an awake
// one slides through is a wall that is not there.
//
// Bodies are rigs of plain rects, in level pixels (100 to the metre), on a
// `BallLevel`: the ball is the one thing here that never sleeps, and its chain
// is the wake path a player reaches for first.

import { Vec2 } from "../engine/vec2";
import { RigidBody2D, StaticBody2D } from "../engine/body";
import { BallLevel } from "../level/ballLevel";
import { LEVELS } from "../level/registry";
import type { SceneChain } from "../level/chains";
import { button, emptyFrameInput, type FrameInput } from "../input/frameInput";
import type { LevelBodyData, RawLevelData } from "../level/levelFormat";

export interface SleepResult {
  name: string;
  passed: boolean;
  details: string[];
}

const DT = 1 / 60;

class Checks {
  passed = true;
  readonly details: string[] = [];
  check(claim: string, got: boolean): void {
    if (!got) this.passed = false;
    this.details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  }
  done(name: string): SleepResult {
    return { name, passed: this.passed, details: this.details };
  }
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface Press {
  fire?: boolean;
  aim?: Vec2;
}

class Rig {
  readonly level: BallLevel;
  private prev: FrameInput = emptyFrameInput();
  frame = 0;

  constructor(bodies: LevelBodyData[], playerX: number, playerY: number, extra: Partial<RawLevelData> = {}) {
    this.level = new BallLevel({
      player: { x: playerX, y: playerY, radius: 8 },
      bodies,
      ...extra,
    } as RawLevelData);
  }

  // The rigid body built from the `index`th authored body, by build order.
  rigid(index: number): RigidBody2D {
    const body = this.level.bodies.filter((b) => b instanceof RigidBody2D && b !== this.level.ball)[index];
    if (!(body instanceof RigidBody2D)) throw new Error(`no rigid body at ${index}`);
    return body;
  }

  chain(index = 0): SceneChain {
    const chain = this.level.sceneChains[index];
    if (!chain) throw new Error(`no chain at ${index}`);
    return chain;
  }

  step(frames: number, press: Press | ((f: number) => Press) = {}, onFrame?: (f: number) => void): void {
    for (let i = 0; i < frames; i++) {
      const p = typeof press === "function" ? press(this.frame) : press;
      const input: FrameInput = {
        ...emptyFrameInput(),
        fire: button(!!p.fire, this.prev.fire),
        mouseWorldPosition: p.aim ?? this.level.ball.globalPosition,
      };
      this.prev = input;
      this.level.physicsProcess(input, DT);
      this.frame++;
      onFrame?.(this.frame);
    }
  }

  // Frames until `test` first holds, or -1 within `limit`.
  until(limit: number, test: () => boolean, press: Press = {}): number {
    for (let i = 0; i < limit; i++) {
      if (test()) return this.frame;
      this.step(1, press);
    }
    return test() ? this.frame : -1;
  }
}

const FLOOR_Y = 300;

function floor(): LevelBodyData {
  return {
    kind: "static",
    x: 0,
    y: FLOOR_Y,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 3000, h: 40 } }],
  };
}

function crate(x: number, y: number, size = 40): LevelBodyData {
  return {
    kind: "rigid",
    x,
    y,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: size, h: size } }],
  };
}

// A bracket at `y` with anchor 1 on its underside, and a lantern hanging from
// anchor 2 on its own top, on a chain built taut between them.
function lanternRig(bracketY: number, lanternY: number): { bodies: LevelBodyData[]; extra: Partial<RawLevelData> } {
  const bodies: LevelBodyData[] = [
    floor(),
    {
      kind: "static",
      x: 0,
      y: bracketY,
      rot: 0,
      objects: [
        { type: "collision", shape: { kind: "rect", w: 200, h: 40 } },
        { type: "anchor", id: 1, x: 0, y: 20, rot: 0 },
      ],
    },
    {
      kind: "rigid",
      x: 0,
      y: lanternY,
      rot: 0,
      objects: [
        { type: "collision", shape: { kind: "rect", w: 40, h: 40 } },
        { type: "anchor", id: 2, x: 0, y: -20, rot: 0 },
      ],
    },
  ];
  return { bodies, extra: { chains: [{ a: 1, b: 2 }] } };
}

function frozen(body: RigidBody2D, rig: Rig, frames: number): number {
  const at = body.globalPosition;
  const rot = body.globalRotation;
  let drift = 0;
  rig.step(frames, {}, () => {
    drift = Math.max(drift, body.globalPosition.distanceTo(at), Math.abs(body.globalRotation - rot));
  });
  return drift;
}

// ---------------------------------------------------------------------------
// lantern: a body hanging on a chain sleeps, and its chain with it.
// ---------------------------------------------------------------------------
function caseLantern(): SleepResult {
  const c = new Checks();
  const { bodies, extra } = lanternRig(0, 150);
  const rig = new Rig(bodies, -600, 260, extra);
  const lantern = rig.rigid(0);
  const chain = rig.chain();
  c.check(`the lantern hangs on the chain`, chain.holds(lantern));
  // A lantern hanging clear of everything is settled AT BUILD
  // (`settleChainsAtBuild`) and arrives asleep, with its chain.
  c.check(`asleep on arrival: the settle ran at build`, lantern.asleep && chain.asleep);
  // Woken by hand, it goes back to sleep live within a window and a bit.
  lantern.keepAwake();
  rig.step(1);
  c.check(`awake once woken, and its chain with it`, !lantern.asleep && !chain.asleep);
  const sleptAt = rig.until(400, () => lantern.asleep);
  c.check(`the lantern sleeps again by frame ${sleptAt} of 400`, sleptAt > 0 && sleptAt < 100);
  const chainAt = rig.until(60, () => chain.asleep);
  c.check(`and its chain follows it by frame ${chainAt}`, chainAt > 0);
  const drift = frozen(lantern, rig, 300);
  c.check(`asleep it does not move a micron over 300 frames (${(drift * 1000).toFixed(4)} mm)`, drift === 0);
  c.check(`and the chain stays asleep`, chain.asleep);
  c.check(`its velocity was zeroed with it`, lantern.linearVelocity.length() === 0 && lantern.angularVelocity === 0);
  return c.done("lantern — a body hanging still sleeps, its chain follows, and neither moves again");
}

// ---------------------------------------------------------------------------
// hook: the avatar's chain wakes what it takes, and it sleeps again when let go.
// ---------------------------------------------------------------------------
function caseHook(): SleepResult {
  const c = new Checks();
  const { bodies, extra } = lanternRig(0, 150);
  const rig = new Rig(bodies, -120, 260, extra);
  const lantern = rig.rigid(0);
  const chain = rig.chain();
  c.check(`asleep before the throw (frame ${rig.until(400, () => lantern.asleep && chain.asleep)})`, lantern.asleep && chain.asleep);
  const restAt = lantern.globalPosition;

  const aim = lantern.globalPosition;
  const took = rig.until(120, () => rig.level.ball.chain?.end.contact.obj === lantern, { fire: true, aim });
  c.check(`the hook takes the lantern (frame ${took})`, took > 0);
  c.check(`awake on the frame it is taken`, !lantern.asleep && !chain.asleep);
  // Held, its rest window is restarted every frame: a body on the chain's
  // path cannot sleep however still it hangs.
  let windowRan = 0;
  rig.step(90, { fire: true, aim }, () => {
    windowRan = Math.max(windowRan, lantern.stillFrames);
  });
  // Restarted at the top of every frame and counted once at the end of it, so
  // one is the most a held body's window ever reads.
  c.check(`held, its rest window never runs (longest ${windowRan} frames)`, windowRan <= 1);
  c.check(`still awake while held`, !lantern.asleep && !chain.asleep);
  c.check(`and still where it hung, the ball on the floor below (${(lantern.globalPosition.distanceTo(restAt) * 1000).toFixed(1)} mm)`, lantern.globalPosition.distanceTo(restAt) < 0.05);

  // Let go: fire released, then nothing.
  rig.step(1, {});
  const again = rig.until(900, () => lantern.asleep && chain.asleep);
  c.check(`sleeps again once let go (frame ${again})`, again > 0);
  return c.done("hook — the chain wakes the lantern it takes, and it sleeps again when let go");
}

// ---------------------------------------------------------------------------
// landing: a contact from an awake body wakes a sleeping one.
// ---------------------------------------------------------------------------
function caseLanding(): SleepResult {
  const c = new Checks();
  // The ball starts high enough to be in the air for the whole of the crate's
  // rest window.
  const rig = new Rig([floor(), crate(200, 260)], 200, -300);
  const box = rig.rigid(0);
  const slept = rig.until(60, () => box.asleep);
  c.check(`the crate sleeps under the falling ball (frame ${slept})`, slept > 0 && !rig.level.ball.asleep);
  const woke = rig.until(120, () => !box.asleep);
  c.check(`and wakes when the ball lands on it (frame ${woke})`, woke > 0);
  c.check(`the ball is above it`, rig.level.ball.globalPosition.y < box.globalPosition.y);
  return c.done("landing — a ball landing on a sleeping crate wakes it");
}

// ---------------------------------------------------------------------------
// platform: a mover that starts moving wakes what rests on it.
// ---------------------------------------------------------------------------
function casePlatform(): SleepResult {
  const c = new Checks();
  const platform: LevelBodyData = {
    kind: "static",
    x: 400,
    y: 200,
    rot: 0,
    swingAmp: 1,
    swingPeriod: 10,
    objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 20 } }],
  };
  const rig = new Rig([floor(), platform, crate(400, 170)], -600, 260);
  const box = rig.rigid(0);
  const mover = rig.level.movers[0];
  c.check(`the platform is a mover`, mover !== undefined);
  if (!mover) return c.done("platform — a moving platform wakes the crate on it");
  // Parked for two seconds, then rising at half a metre a second.
  const base = mover.body.globalPosition;
  mover.script = (body, time) => {
    body.globalRotation = 0;
    body.globalPosition = time < 2 ? base : base.add(new Vec2(0, -0.5 * (time - 2)));
  };
  const slept = rig.until(90, () => box.asleep);
  c.check(`the crate sleeps on the parked platform (frame ${slept})`, slept > 0);
  const restY = box.globalPosition.y;
  rig.step(120 - rig.frame);
  c.check(`still asleep as the platform is about to move`, box.asleep);
  const woke = rig.until(30, () => !box.asleep);
  c.check(`awake within a frame or two of the platform moving (frame ${woke})`, woke > 0 && woke <= 123);
  rig.step(60);
  const risen = restY - box.globalPosition.y;
  c.check(`and carried up with it (${(risen * 100).toFixed(1)} cm in a second)`, risen > 0.3);
  return c.done("platform — a platform that starts moving wakes the crate resting on it");
}

// ---------------------------------------------------------------------------
// impulse: any impulse wakes.
// ---------------------------------------------------------------------------
function caseImpulse(): SleepResult {
  const c = new Checks();
  const rig = new Rig([floor(), crate(0, 260)], -600, 260);
  const box = rig.rigid(0);
  const slept = rig.until(60, () => box.asleep);
  c.check(`asleep (frame ${slept})`, slept > 0);
  const at = box.globalPosition;
  box.applyImpulse(new Vec2(60, 0));
  c.check(`awake on the impulse`, !box.asleep);
  rig.step(60);
  const moved = box.globalPosition.distanceTo(at);
  c.check(`and moved by it (${(moved * 100).toFixed(1)} cm)`, moved > 0.1);
  const again = rig.until(600, () => box.asleep);
  c.check(`sleeps again once it stops (frame ${again})`, again > 0);
  return c.done("impulse — a blast wakes a sleeping crate, which sleeps again when it stops");
}

// ---------------------------------------------------------------------------
// lead: an awake crate sliding into a sleeping one with the lower id hits it.
//
// The contact gather is done for the pair's leading side, and the lower id
// led. A sleeping lead produced no contact, so the awake crate behind it
// went straight through (`collectPairContacts`).
// ---------------------------------------------------------------------------
function caseLead(): SleepResult {
  const c = new Checks();
  const rig = new Rig([floor(), crate(0, 260), crate(-150, 260)], -600, 260);
  const wall = rig.rigid(0);
  const slider = rig.rigid(1);
  c.check(`the sleeping crate has the lower id`, wall.id < slider.id);
  const slept = rig.until(60, () => wall.asleep && slider.asleep);
  c.check(`both asleep (frame ${slept})`, slept > 0);
  const wallAt = wall.globalPosition;
  slider.applyImpulse(new Vec2(120, 0));
  let crossed = false;
  rig.step(90, {}, () => {
    if (slider.globalPosition.x > wall.globalPosition.x) crossed = true;
  });
  c.check(`the slider never passes through it`, !crossed);
  c.check(`the sleeping crate was woken by the hit`, wall.stillFrames < 90);
  const shoved = wall.globalPosition.distanceTo(wallAt);
  c.check(`and shoved along (${(shoved * 100).toFixed(1)} cm)`, shoved > 0.01);
  return c.done("lead — an awake crate hits a sleeping one with the lower id instead of passing through");
}

// ---------------------------------------------------------------------------
// stack: two crates stacked both sleep, and stay stacked.
// ---------------------------------------------------------------------------
function caseStack(): SleepResult {
  const c = new Checks();
  const rig = new Rig([floor(), crate(0, 260), crate(0, 220)], -600, 260);
  const lower = rig.rigid(0);
  const upper = rig.rigid(1);
  const slept = rig.until(300, () => lower.asleep && upper.asleep);
  c.check(`both asleep (frame ${slept})`, slept > 0);
  const gap = lower.globalPosition.y - upper.globalPosition.y;
  c.check(`the upper crate is resting on the lower (${(gap * 100).toFixed(1)} cm apart)`, gap > 0.38 && gap < 0.42);
  const upperAt = upper.globalPosition;
  const drift = Math.max(frozen(lower, rig, 200), upper.globalPosition.distanceTo(upperAt));
  c.check(`and neither moves over 200 frames (${(drift * 1000).toFixed(4)} mm)`, drift === 0);
  return c.done("stack — two stacked crates sleep together and stay put");
}

// ---------------------------------------------------------------------------
// arena: the shipped ball level settles completely.
// ---------------------------------------------------------------------------
function caseArena(): SleepResult {
  const c = new Checks();
  const spec = LEVELS["BALL"];
  if (!spec) return c.done("arena — no ball level in the registry");
  const level = new BallLevel(spec.data);
  const input = emptyFrameInput();
  let allAsleepAt = -1;
  const sleepable = level.world.bodies.filter((b): b is RigidBody2D => b instanceof RigidBody2D && b.canSleep);
  for (let f = 1; f <= 900; f++) {
    level.physicsProcess(input, DT);
    if (
      allAsleepAt < 0 &&
      level.sceneChains.every((ch) => ch.asleep) &&
      sleepable.every((b) => b.asleep)
    ) {
      allAsleepAt = f;
    }
  }
  const awakeChains = level.sceneChains.filter((ch) => !ch.asleep).length;
  const awakeBodies = sleepable.filter((b) => !b.asleep).length;
  c.check(
    `every chain (${level.sceneChains.length}) and every sleepable body (${sleepable.length}) asleep by frame ${allAsleepAt} of 900 (${awakeChains} chains, ${awakeBodies} bodies still awake)`,
    allAsleepAt > 0 && awakeChains === 0 && awakeBodies === 0,
  );
  c.check(`the statics are not counted`, level.world.bodies.some((b) => b instanceof StaticBody2D));
  return c.done("arena — the ball arena left alone goes entirely to sleep");
}

export function runSleepCases(): SleepResult[] {
  return [
    caseLantern(),
    caseHook(),
    caseLanding(),
    casePlatform(),
    caseImpulse(),
    caseLead(),
    caseStack(),
    caseArena(),
  ];
}
