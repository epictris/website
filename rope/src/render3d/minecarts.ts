// The drawn minecarts (docs/minecarts.md): each live cart as its template
// body's look, its wheels turned by the sim's wheel angle, and a cart that
// has left the end of its line carried on round a bend OUT of the play plane,
// away from the camera, and round a second one back to running sideways, as
// though the rails turned two corners into the rock.
//
// Render-side by construction. The sim removed the cart's body the frame it
// reached the end (`level/tracks.ts`), so nothing the drawn cart does past
// that point can touch the ball or the chain: what is drawn here is a model
// moving on a path, fed by one `TrackExit` event and the sim clock.
//
// A cart is drawn as an AUTHORED body is: a `BodyVisual` built from the cart's
// own `BuiltBody` (so its debug geometry follows the template's flags), and
// the template body node's look - its `Model3D` and anything else under it -
// built by a `TreeLook` of its own into that visual's authored frame. The
// level's own `TreeLook` never draws the template: a `Track2D` is a mark in
// the plane to it, and it does not descend into one.

import * as THREE from "three";
import type { PhysicsBody2D } from "../engine/body";
import { Vec2 } from "../engine/vec2";
import type { LevelNode } from "../level/nodes";
import type { Minecart, MineTrack, TrackExit } from "../level/tracks";
import { BodyVisual } from "./bodyVisuals";
import type { LightRig } from "./lights";
import { placeAt, threeRotation } from "./space";
import { TreeLook } from "./treeLook";

// How far past the second bend a leaving cart runs on sideways before it is
// dropped, metres.
const RUN_OUT = 6;
// The slowest a leaving cart is drawn going: a cart pushed gently off the end
// still leaves rather than idling on the bend in plain view.
const MIN_EXIT_SPEED = 1;

interface CartLook {
  readonly visual: BodyVisual;
  readonly look: TreeLook;
  // +1 when the line runs the way the model faces (its +x), -1 when the cart
  // travels backwards in its own frame: a cart on a right-to-left line is
  // built upright, so it drives toward its -x and its wheels turn the other way.
  readonly facing: number;
  // The wheels in the model, once its file has landed.
  wheels: THREE.Object3D[] | null;
  stamp: number;
}

interface Leaving {
  readonly cart: CartLook;
  readonly exit: TrackExit;
  // Sim seconds since it left.
  time: number;
}

export interface CartHost {
  readonly tracks?: readonly MineTrack[];
}

export class CartLooks {
  private readonly live = new Map<PhysicsBody2D, CartLook>();
  private readonly leaving: Leaving[] = [];
  // Exits ingested whose visual has not yet been handed over (the body leaves
  // the world on the step the event is written).
  private readonly exits = new Map<PhysicsBody2D, TrackExit>();
  private stamp = 0;
  private readonly templates = new Map<string, LevelNode | null>();

  constructor(
    private readonly root: THREE.Object3D,
    private readonly tree: readonly LevelNode[],
    private readonly opts: { rig: LightRig; shown: boolean; debug: boolean; roots: boolean },
  ) {}

  // The cart body node under a track node, found once.
  private templateOf(track: string): LevelNode | null {
    if (this.templates.has(track)) return this.templates.get(track)!;
    let found: LevelNode | null = null;
    const walk = (nodes: readonly LevelNode[]): void => {
      for (const n of nodes) {
        if (found) return;
        if (n.type === "Track2D" && n.id === track) {
          found = (n.children ?? []).find((c) => c.type === "RigidBody2D" || c.type === "StaticBody2D" || c.type === "AnimatableBody2D") ?? null;
          return;
        }
        if (n.children) walk(n.children);
      }
    };
    walk(this.tree);
    this.templates.set(track, found);
    return found;
  }

  private build(track: MineTrack, cart: Minecart): CartLook {
    const visual = new BodyVisual(cart.body, cart.built, this.opts.debug, this.opts.roots);
    this.root.add(visual.root);
    const template = this.templateOf(track.node);
    const look = new TreeLook(template ? [template] : [], {
      bodyFrame: (id) => (template && id === template.id ? visual.frame : null),
      solid: () => true,
      rig: this.opts.rig,
      shown: this.opts.shown,
    });
    // The line's direction in the body's own frame is `-rotationOffset`.
    const facing = Math.cos(cart.mount.rotationOffset) >= 0 ? 1 : -1;
    return { visual, look, facing, wheels: null, stamp: this.stamp };
  }

  // The steps' exits, each as it happens (the host drains them per step, as
  // it does the sparks), and the leaving carts carried on by the step.
  ingest(exits: readonly TrackExit[], step: number): void {
    for (const l of this.leaving) l.time += step;
    for (const e of exits) this.exits.set(e.body, e);
  }

  // Once a render frame: every live cart built or kept and posed, every cart
  // that has gone either handed to the bend (it left the line) or dropped,
  // and every leaving cart placed along its bend.
  sync(host: CartHost, alpha: number, step: number): void {
    this.stamp++;
    for (const track of host.tracks ?? []) {
      for (const cart of track.carts) {
        let c = this.live.get(cart.body);
        if (!c) {
          c = this.build(track, cart);
          this.live.set(cart.body, c);
        }
        c.stamp = this.stamp;
        c.visual.sync(alpha);
        // Between the steps the wheels turn on at the last step's rate.
        this.turnWheels(c, cart.wheelAngle - cart.wheelSpeed * step * (1 - alpha));
      }
    }
    for (const [body, c] of this.live) {
      if (c.stamp === this.stamp) continue;
      this.live.delete(body);
      const exit = this.exits.get(body);
      this.exits.delete(body);
      if (exit) this.leaving.push({ cart: c, exit, time: 0 });
      else this.drop(c);
    }
    this.exits.clear();
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const l = this.leaving[i]!;
      if (!this.poseLeaving(l, l.time + alpha * step)) {
        this.drop(l.cart);
        this.leaving.splice(i, 1);
      }
    }
  }

  // The way out, two corners in the rock: a quarter circle of the exit radius
  // from where the cart left the line, turning from the line's direction to
  // straight away from the camera; `exitDepth` straight on into the depth; a
  // second quarter circle back to running sideways, toward the track's
  // `exitTurn`; and a straight run out behind the scenery. Each turn is a yaw
  // about the screen's vertical. Returns false once it has run out.
  private poseLeaving(l: Leaving, t: number): boolean {
    const { exit } = l;
    const R = Math.max(0.05, exit.exitRadius);
    const D = Math.max(0, exit.exitDepth);
    const speed = Math.max(MIN_EXIT_SPEED, exit.speed);
    const u = speed * t;
    const quarter = Math.PI / 2;
    // The path, by arc length: the bend away from the camera, the straight
    // into the depth, the bend back to running sideways, and the run out.
    const bend = quarter * R;
    const first = bend;
    const straight = first + D;
    const second = straight + bend;
    if (u > second + RUN_OUT) return false;
    // Which way it was running on screen, and which way it turns at the
    // second bend; the yaw that second bend turns through goes back toward
    // the screen's x one way or the other.
    const sx = exit.direction.x >= 0 ? 1 : -1;
    const side = exit.exitTurn >= 0 ? 1 : -1;
    const k = side === sx ? -sx : sx;
    const corner = exit.position.add(exit.direction.mul(R));
    let inPlane: Vec2;
    let away: number;
    let yaw: number;
    if (u <= first) {
      const phi = u / R;
      inPlane = exit.position.add(exit.direction.mul(R * Math.sin(phi)));
      away = R * (1 - Math.cos(phi));
      yaw = sx * phi;
    } else if (u <= straight) {
      inPlane = corner;
      away = R + (u - first);
      yaw = sx * quarter;
    } else if (u <= second) {
      const psi = (u - straight) / R;
      inPlane = corner.add(new Vec2(side * R * (1 - Math.cos(psi)), 0));
      away = R + D + R * Math.sin(psi);
      yaw = sx * quarter + k * psi;
    } else {
      inPlane = corner.add(new Vec2(side * (R + (u - second)), 0));
      away = 2 * R + D;
      yaw = sx * quarter + k * quarter;
    }
    const root = l.cart.visual.root;
    placeAt(root, inPlane, -away);
    // Yaw about the screen's vertical (+x turning by +yaw toward -z), and the
    // pitch the cart had on the line levelled out over the first bend, as a
    // tunnel floor runs level.
    root.rotation.set(0, 0, 0);
    root.rotateY(yaw);
    root.rotateZ(threeRotation(exit.rotation) * Math.max(0, 1 - u / first));
    this.turnWheels(l.cart, exit.wheelAngle + (exit.wheelSpeed >= 0 ? 1 : -1) * Math.abs(exit.wheelSpeed) * t);
    return true;
  }

  // The model's wheels (objects named for a wheel, each with its origin on its
  // axle and turning about the model's sideways axis) to the sim's angle.
  private turnWheels(c: CartLook, angle: number): void {
    if (c.wheels === null || c.wheels.length === 0) {
      const found: THREE.Object3D[] = [];
      c.visual.frame.traverse((o) => {
        if (/wheel/i.test(o.name) && !/wheel/i.test(o.parent?.name ?? "")) found.push(o);
      });
      if (found.length === 0) return;
      c.wheels = found;
    }
    for (const w of c.wheels) w.rotation.z = -c.facing * angle;
  }

  private drop(c: CartLook): void {
    c.look.dispose();
    c.visual.root.removeFromParent();
    c.visual.dispose();
  }

  dispose(): void {
    for (const c of this.live.values()) this.drop(c);
    this.live.clear();
    for (const l of this.leaving) this.drop(l.cart);
    this.leaving.length = 0;
    this.exits.clear();
  }
}
