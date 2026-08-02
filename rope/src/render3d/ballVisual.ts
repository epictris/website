// The ball & chain avatar in 3D: a cast-iron sphere and the steel loop the chain
// deploys through.
//
// The sphere is what the 2D renderer's radial-sheen gradient was standing in
// for. It is a real sphere with a real metal material, so the highlight is where
// the sun actually is rather than baked at a fixed offset - which is the single
// change that makes the ball read as an object in a lit space rather than as a
// disc with a gradient on it. Physically it is still a disc-inertia circle and
// nothing here changes that (see "Explicitly out of scope").
//
// The loop is a material point on the rim, so it rides the ball's own rotation
// rather than being placed from `renderLoopCenter` each frame: a child at the
// loop's local offset under a root carrying the interpolated pose IS
// `renderLoopCenter`, computed by the scene graph instead of by hand.

import * as THREE from "three";
import { BallPlayer } from "../classes/ballPlayer";
import { surfaceMaterial } from "./assets";
import { orientTo, placeAt, threeY } from "./space";

// How much thicker than the collision radius the mounting loop's ring is drawn.
// The loop is a 2 cm collision circle (`BallPlayer.LOOP_RADIUS`) and a torus of
// exactly that radius reads as a dot; the tube is what makes it a forged ring.
const LOOP_TUBE = BallPlayer.LOOP_RADIUS * 0.42;

export class BallVisual {
  readonly root = new THREE.Group();
  private readonly owned: THREE.BufferGeometry[] = [];

  constructor(private readonly ball: BallPlayer) {
    const sphere = new THREE.SphereGeometry(ball.radius, 32, 24);
    this.owned.push(sphere);
    const body = new THREE.Mesh(sphere, surfaceMaterial("cast iron"));
    body.castShadow = true;
    body.receiveShadow = true;
    this.root.add(body);

    // The loop, at the material point the chain leaves through: the top of the
    // ball at rotation 0, which in the ball's own frame is
    // `-(radius + LOOP_GAP)` in y - so +y once negated into three's frame.
    const torus = new THREE.TorusGeometry(BallPlayer.LOOP_RADIUS, LOOP_TUBE, 10, 20);
    this.owned.push(torus);
    const loop = new THREE.Mesh(torus, surfaceMaterial("steel"));
    loop.castShadow = true;
    loop.position.set(0, threeY(-(ball.radius + BallPlayer.LOOP_GAP)), 0);
    this.root.add(loop);
  }

  sync(alpha: number): void {
    placeAt(this.root, this.ball.renderPosition(alpha));
    orientTo(this.root, this.ball.renderRotation(alpha));
  }

  dispose(): void {
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    this.root.clear();
  }
}
