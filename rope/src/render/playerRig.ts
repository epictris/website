// Render-side player rig: two arms and two feet drawn as small circles in the
// player colour, posed from the same state fields the sim steers by (state
// machine, velocity, rope spans). Pure visuals — keeps its own phase and
// smoothing state, advances the walk cycle by distance travelled (so animation
// speed tracks movement speed), and never touches the sim.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { Player } from "../classes/player";
import { GroundedState } from "../classes/states/groundedState";
import { OnWallState, WallMode } from "../classes/states/onWallState";
import { LedgeHangState } from "../classes/states/ledgeHangState";
import { LedgeClimbState } from "../classes/states/ledgeClimbState";
import { WallJumpingState } from "../classes/states/wallJumpingState";
import { LedgeDetection } from "../lib/ledgeDetection";
import { Surface } from "../lib/surface";
import { SurfaceType } from "../lib/types";
import type { PhysicsBody2D } from "../engine/body";
import type { Level } from "../level/level";

// Right limbs green, left limbs red (ayu-mirage) — distinct from the body,
// so they stay readable without outlines.
const RIGHT_COLOR = "#bae67e";
const LEFT_COLOR = "#ff4d4d";
// Fixed on-screen sizes, expressed as world lengths (metres) via PX so they
// render at a constant pixel size regardless of PIXELS_PER_METER.
const LIMB_RADIUS = 2.4 * PX;
const STRIDE = 5.25 * PX; // walk-cycle foot swing amplitude — matches ARM_REACH
const LIFT = 2 * PX; // walk-cycle foot lift
const FOOT_SPREAD = 2 * PX; // per-foot lateral offset in the walk cycle
const ARM_REACH = 5.25 * PX; // horizontal arm travel per unit amplitude
const ARM_HANG = 7.5 * PX; // hand depth below the shoulder at mid-swing
const ARM_ARC = 0.03 * PIXELS_PER_METER; // shallow arc: rise per horizontal length² (1/length)
const SMOOTH = 0.35; // per-render-frame lerp toward the pose target
// Visual cadence cap. Distance-locked gait at this sim's speeds (~25 body
// lengths/s) would demand humanly impossible stride rates; past the cap the
// grip slips a little instead — slip reads far better than limb blur.
const MAX_CYCLE_HZ = 3;
const MAX_PHASE_STEP = (2 * Math.PI * MAX_CYCLE_HZ) / 60; // per ~60fps frame

function advancePhase(d: number): void {
  phase += Math.max(-MAX_PHASE_STEP, Math.min(MAX_PHASE_STEP, d));
}
const SNAP_DISTANCE = 25 * PX; // teleport/reset: jump straight to the target

// Limb order: [right arm, left arm, right foot, left foot]. The player's
// right side faces the viewer's left (front-on POV), so default poses put
// the right limbs at negative screen-x.
const enum Limb {
  ArmR = 0,
  ArmL = 1,
  FootR = 2,
  FootL = 3,
}

let phase = 0;
let prevPos: Vec2 | null = null;
// Supporting mover tracked across render frames — its actual per-frame
// displacement is subtracted from the gait's phase advance (a velocity-based
// estimate would need the frame's physics-step count, which render can't see).
let prevSupportId = -1;
let prevSupportPos: Vec2 | null = null;
// Smoothed limb offsets in player-local space. Smoothing world positions
// would make limbs trail the player at speed; offsets move rigidly with the
// body and only pose *changes* get eased.
const current: (Vec2 | null)[] = [null, null, null, null];

// Passive wall contact (no toward-input, so the sim state is still grounded
// or airborne): render-side probe, read-only test sweeps to either side.
let wallPressed = false;

function touchingWallNormal(player: Player): Vec2 | null {
  for (const sign of [-1, 1]) {
    const hit = player.moveAndCollide(new Vec2(sign * 1.5 * PX, 0), true);
    if (!hit) continue;
    const nrm = hit.getNormal();
    const collider = hit.getCollider() as PhysicsBody2D;
    if (Surface.getSurfaceType(nrm, collider.isRotating) === SurfaceType.WALL) return nrm;
  }
  return null;
}

// All four limbs pinned flat against a wall face — shared by the wall-slide
// state and passive wall contact.
function pressedPose(player: Player, n: Vec2): Vec2[] {
  const p = player.globalPosition;
  const r = player.radius;
  let up = n.orthogonal();
  if (up.y > 0) up = up.mul(-1);
  const base = p.add(n.mul(-(r - 1 * PX)));
  return [
    base.add(up.mul(5.5 * PX)),
    base.add(up.mul(3 * PX)),
    base.add(up.mul(-5 * PX)),
    base.add(up.mul(-7.5 * PX)),
  ];
}

function airbornePose(player: Player): Vec2[] {
  const p = player.globalPosition;
  const r = player.radius;
  // Jump → fall blend on vertical velocity: falling, the legs tuck in and
  // the arms ride higher than during the jump's rise.
  const fall = Math.min(1, Math.max(0, player.velocity.y / (300 * PX)));
  const jump: Vec2[] = [
    new Vec2(-r * 0.9, -r * 0.25),
    new Vec2(r * 0.9, -r * 0.25),
    new Vec2(-r * 0.85, r * 0.9),
    new Vec2(r * 0.85, r * 0.9),
  ];
  const falling: Vec2[] = [
    new Vec2(-r * 0.9, -r * 0.65),
    new Vec2(r * 0.9, -r * 0.65),
    new Vec2(-r * 0.55, r * 0.9),
    new Vec2(r * 0.55, r * 0.9),
  ];
  return jump.map((o, i) => p.add(o.lerp(falling[i]!, fall)));
}

function groundedPose(player: Player, state: GroundedState): Vec2[] {
  const p = player.globalPosition;
  const r = player.radius;
  const n = state.surfaceNormal.lengthSquared() > 0 ? state.surfaceNormal : Vec2.UP;
  const t = n.orthogonal();

  // The gait runs in the supporting surface's frame: standing on a mover the
  // player is carried, not running — subtract the contact-point surface
  // velocity (v + ω × r, as the sim does) before measuring locomotion.
  const support = state.supportBody;
  const surfVel =
    support && support.isMobile && !support.removed
      ? support.velocityAtPoint(p.sub(n.mul(r)))
      : Vec2.ZERO;
  const relVel = player.velocity.sub(surfVel);

  // Walk → run blend: 0 at walking speeds, 1 at top ground speed.
  const speed = Math.abs(relVel.cross(n));
  const run = Math.min(1, Math.max(0, (speed - 60 * PX) / (240 * PX)));

  // Stride amplitude scales with speed: short steps when barely moving,
  // full stride at the run threshold, longest at top speed.
  const amp = 0.4 + 0.6 * Math.min(1, speed / (60 * PX)) + 0.6 * run;
  const stride = STRIDE * amp;
  // Ground-contact fraction of each foot's cycle. Real walking keeps both
  // feet down part of the time (duty > 0.5); running shrinks contact toward
  // a brief touch, leaving flight gaps between strides.
  const duty = 0.6 - 0.4 * run;

  // Cadence follows from ground truth instead of a free constant: a planted
  // foot is stationary in the world, so the body covers the full stance sweep
  // (2 * stride) during the stance fraction of the cycle. That both locks
  // stance feet to the ground (no foot-slip) and makes strides naturally
  // fewer and longer as speed and stride grow.
  const cycleDistance = (2 * stride) / duty;
  // Surface-relative displacement: world delta minus the platform's measured
  // motion over the same render frame.
  let platformDelta = 0;
  if (support && support.isMobile && !support.removed) {
    if (prevSupportId === support.id && prevSupportPos) {
      platformDelta = support.globalPosition.sub(prevSupportPos).dot(t);
    }
    prevSupportId = support.id;
    prevSupportPos = support.globalPosition;
  } else {
    prevSupportId = -1;
    prevSupportPos = null;
  }
  if (prevPos) {
    advancePhase((p.sub(prevPos).dot(t) - platformDelta) * ((2 * Math.PI) / cycleDistance));
  }

  const footBase = p.add(n.mul(-(r - 0.5 * PX)));
  const armBase = p.add(n.mul(-0.5 * PX));
  const moving = speed > 5 * PX;
  if (!moving) {
    // Standing against a wall: brace the limbs on it.
    const wn = touchingWallNormal(player);
    if (wn) {
      wallPressed = true;
      return pressedPose(player, wn);
    }
    // t points screen-left for upright ground (n = UP), so the player's right
    // limbs (viewer's left, front-on) take the +t side.
    return [
      armBase.add(t.mul(r * 0.8)),
      armBase.add(t.mul(-r * 0.8)),
      footBase.add(t.mul(4.2 * PX)),
      footBase.add(t.mul(-4.2 * PX)),
    ];
  }

  const liftAmp = LIFT * (1 + 1.5 * run);
  const shoulder = p.add(n.mul(4.5 * PX));
  // Running arms carry a bent elbow: the hand rides a little higher.
  const armHang = ARM_HANG * (1 - 0.15 * run);

  // Travel direction along the surface tangent; the player's right limbs
  // stay on the trailing side of the body, whichever way it runs.
  const fwd = relVel.dot(t) >= 0 ? 1 : -1;

  const pose: Vec2[] = [];
  for (let i = 0; i < 2; i++) {
    const u = ((phase / (2 * Math.PI) + i * 0.5) % 1 + 1) % 1;
    let fx: number; // normalized foot position along the surface, [-1, 1]
    let lift: number;
    if (u < duty) {
      // Stance: planted, sweeping front to back, exactly tracking the ground.
      fx = 1 - 2 * (u / duty);
      lift = 0;
    } else {
      // Swing: the foot leaves the ground behind, accelerates past the body
      // and decelerates into the next touchdown (smoothstep), with the lift
      // peaking just before mid-swing (heel recovery) and settling flat.
      const w = (u - duty) / (1 - duty);
      fx = -1 + 2 * w * w * (3 - 2 * w);
      lift = Math.sin(Math.PI * Math.pow(w, 0.85)) * liftAmp;
    }
    // Arms swing anti-phase with the same-side leg on a wide, shallow arc,
    // with three touches of realism:
    //  - the swing lags the leg cycle slightly (soft-tissue delay),
    //  - the arc is asymmetric: the hand rises more in front of the body
    //    than behind it (hands come up in front, sweep low past the hip),
    //  - at speed the whole swing shifts a little rearward (driven elbows).
    // Near-sinusoidal even when the leg cycle turns asymmetric at speed —
    // real arm swing keeps its harmonic shape while running.
    const armX = -Math.cos(2 * Math.PI * (u - 0.06)) * ARM_REACH * amp;
    const frontness = Math.max(0, (armX * fwd) / (ARM_REACH * 1.6));
    const rise = armX * armX * ARM_ARC * (1 + 0.7 * frontness);
    pose[Limb.ArmR + i] = shoulder
      .add(t.mul(armX - 0.8 * PX * run * fwd))
      .add(n.mul(-(armHang - rise)));
    pose[Limb.FootR + i] = footBase
      .add(t.mul((i === 0 ? -fwd : fwd) * FOOT_SPREAD + fx * stride))
      .add(n.mul(lift));
  }
  return pose;
}

function wallPose(player: Player, state: OnWallState): Vec2[] {
  const p = player.globalPosition;
  const r = player.radius;
  const n = state.surfaceNormal;
  // Along-wall direction, pointing up.
  let up = n.orthogonal();
  if (up.y > 0) up = up.mul(-1);
  const base = p.add(n.mul(-(r - 1 * PX)));

  if (state.wallMode === WallMode.Running) {
    // Climb cycle, built like the ground gait: each limb grips the wall
    // (world-stationary while the body slides past — grip fraction of the
    // cycle) then lifts slightly off the wall and reaches to re-grip.
    // Same-side hand and foot run half a cycle apart (diagonal crawl).
    const amp = 3 * PX; // half sweep along the wall
    const duty = 0.55; // gripping fraction of the cycle
    const cycleDistance = (2 * amp) / duty; // grip-locked, as in groundedPose
    if (prevPos) advancePhase(p.sub(prevPos).dot(up) * ((2 * Math.PI) / cycleDistance));

    const limb = (u: number): { x: number; lift: number } => {
      if (u < duty) return { x: amp * (1 - 2 * (u / duty)), lift: 0 };
      const w = (u - duty) / (1 - duty);
      return {
        x: amp * (-1 + 2 * w * w * (3 - 2 * w)),
        lift: Math.sin(Math.PI * w) * 1.8 * PX,
      };
    };

    const pose: Vec2[] = [];
    for (let i = 0; i < 2; i++) {
      const uh = ((phase / (2 * Math.PI) + i * 0.5) % 1 + 1) % 1;
      const uf = (uh + 0.5) % 1;
      const h = limb(uh);
      const f = limb(uf);
      pose[Limb.ArmR + i] = base.add(up.mul(5 * PX + h.x)).add(n.mul(h.lift));
      pose[Limb.FootR + i] = base.add(up.mul(-7 * PX + f.x)).add(n.mul(f.lift));
    }
    return pose;
  }

  // Sliding: limbs pinned against the wall, fixed relative to the player.
  return pressedPose(player, n);
}

function ledgePose(player: Player, body: LedgeHangState["body"], vertexIndex: number): Vec2[] {
  const info = !body.removed ? LedgeDetection.grabInfo(body, vertexIndex) : null;
  if (!info) return airbornePose(player);
  const p = player.globalPosition;
  const r = player.radius;
  // Feet flat on the wall face below the corner.
  let down = info.wallNormal.orthogonal();
  if (down.y < 0) down = down.mul(-1);
  const footBase = p.add(info.wallNormal.mul(-(r - 1 * PX)));
  return [
    // Hands gripping the corner: one on the top face, one on the wall face.
    info.vertex.add(info.floorNormal.mul(1.2 * PX)),
    info.vertex.add(info.wallNormal.mul(1.2 * PX)),
    footBase.add(down.mul(1.5 * PX)),
    footBase.add(down.mul(4.5 * PX)),
  ];
}

function poseTargets(player: Player): Vec2[] {
  wallPressed = false;
  const state = player.state;
  if (state instanceof GroundedState) return groundedPose(player, state);
  // Not grounded: drop the mover-tracking so a later re-land starts fresh.
  prevSupportId = -1;
  prevSupportPos = null;
  if (state instanceof OnWallState) return wallPose(player, state);
  if (state instanceof LedgeHangState || state instanceof LedgeClimbState) {
    return ledgePose(player, state.body, state.vertexIndex);
  }
  // Airborne against a wall (falling beside it, shoved into it, mid
  // wall-jump launch): brace on it.
  const wn = touchingWallNormal(player);
  if (wn) {
    wallPressed = true;
    return pressedPose(player, wn);
  }
  return airbornePose(player);
}

let lastP: Vec2 | null = null;
// Which way the player faces (+1 right, -1 left): the far-side limbs (the
// player's right when facing right, and vice versa) draw behind the body.
let facing = 1;
let backLimbs: number[] = [];
let frontLimbs: number[] = [];

// Pose crossfade: when the animation kind changes (ground ↔ air ↔ wall ↔
// ledge), the old pose is frozen and eased into the new one instead of the
// limbs jumping to the new targets.
const BLEND_FRAMES = 10; // ~165ms at 60fps
let lastKind = "";
let blend = 1; // 0 → just switched, 1 → fully on the current pose
let blendFrom: (Vec2 | null)[] = [null, null, null, null];

function poseKind(player: Player): string {
  if (wallPressed) return "wall-press";
  const state = player.state;
  if (state instanceof GroundedState) return "ground";
  if (state instanceof OnWallState) {
    return state.wallMode === WallMode.Running ? "wall-run" : "wall-slide";
  }
  if (state instanceof LedgeHangState || state instanceof LedgeClimbState) return "ledge";
  return "air";
}

// Advance the rig one render frame: compute pose targets and smooth toward
// them. Called before the rope is drawn so the rope can originate from the
// right hand's current position.
export function updatePlayerRig(level: Level): void {
  const player = level.player;
  const p = player.globalPosition;
  const targets = poseTargets(player);

  // The right arm holds the deployed rope: track the first span's direction.
  const rope = player.rope;
  let ropeHeld = false;
  if (rope) {
    const span = rope.getSpans()[0]?.span;
    if (span && span.end.distanceSquaredTo(p) > PX * PX) {
      targets[Limb.ArmR] = p.add(p.directionTo(span.end).mul(player.radius + 1.5 * PX));
      ropeHeld = true;
    }
  }

  if (player.xInputDirection !== 0) facing = player.xInputDirection;
  const state = player.state;
  // A wall jump launches away from the wall — face the jump direction.
  if (state instanceof WallJumpingState && state.surfaceNormal.x !== 0) {
    facing = state.surfaceNormal.x > 0 ? 1 : -1;
  }
  // Facing right (+1) the viewer sees the player's right profile, so the
  // LEFT limbs are on the far side and draw behind the body — and vice versa.
  backLimbs = facing > 0 ? [Limb.ArmL, Limb.FootL] : [Limb.ArmR, Limb.FootR];
  // The rope-holding arm always reads in front — the rope originates from it.
  if (ropeHeld) backLimbs = backLimbs.filter((i) => i !== Limb.ArmR);
  frontLimbs = [Limb.ArmR, Limb.ArmL, Limb.FootR, Limb.FootL].filter(
    (i) => !backLimbs.includes(i),
  );

  // Crossfade on animation-kind changes: freeze the outgoing pose's offsets
  // and ease toward the new pose over BLEND_FRAMES.
  const kind = poseKind(player);
  if (kind !== lastKind) {
    lastKind = kind;
    blendFrom = current.slice();
    blend = blendFrom.some((c) => c !== null) ? 0 : 1;
  }
  if (blend < 1) blend = Math.min(1, blend + 1 / BLEND_FRAMES);
  const ease = blend * blend * (3 - 2 * blend);

  for (let i = 0; i < targets.length; i++) {
    let target = targets[i]!.sub(p);
    const from = blendFrom[i];
    if (blend < 1 && from) target = from.lerp(target, ease);
    const cur = current[i];
    current[i] =
      cur === null || cur.distanceTo(target) > SNAP_DISTANCE ? target : cur.lerp(target, SMOOTH);
  }
  prevPos = p;
  lastP = p;
}


function drawLimbs(ctx: CanvasRenderingContext2D, indices: number[]): void {
  if (!lastP) return;
  for (const i of indices) {
    const off = current[i];
    if (!off) continue;
    ctx.fillStyle = i === Limb.ArmR || i === Limb.FootR ? RIGHT_COLOR : LEFT_COLOR;
    ctx.beginPath();
    ctx.arc(lastP.x + off.x, lastP.y + off.y, LIMB_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Far-side limbs — drawn before the player body so they sit behind it.
export function drawPlayerRigBack(ctx: CanvasRenderingContext2D): void {
  drawLimbs(ctx, backLimbs);
}

// Near-side limbs — drawn after the body (and rope) so they sit in front.
export function drawPlayerRigFront(ctx: CanvasRenderingContext2D): void {
  drawLimbs(ctx, frontLimbs);
}
