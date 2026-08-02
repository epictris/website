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
import { surfaceFor } from "./assets";
import { orientTo, placeAt, threeY } from "./space";

// How much thicker than the collision radius the mounting loop's ring is drawn.
// The loop is a 2 cm collision circle (`BallPlayer.LOOP_RADIUS`) and a torus of
// exactly that radius reads as a dot; the tube is what makes it a forged ring.
const LOOP_TUBE = BallPlayer.LOOP_RADIUS * 0.42;

// What the whole assembly - ball, loop, every chain link, the manacle - is made
// of: one authored, photographed set of pitted and rust-bloomed iron
// (`TEXTURE_ASSETS`, keyed "rusted iron"), rather than the generated `cast iron`
// and `steel` noise it wore before. The generated pair stay its fallback, so the
// avatar looks like itself from the first frame and the maps swap in when they
// land.
//
// One surface for all of it because it IS one forged assembly: the ball and the
// chain hanging off it reading as the same metal is most of what makes them look
// like one object rather than two props that happen to touch.
export const FORGED = "rusted iron";

// How large that surface is worn on the assembly's SMALL parts. The set's own
// tile is one repeat over the ball (see its manifest entry), which along the
// sphere's equator is one repeat per ~0.75 m of surface; a 4 cm link at that
// same tile would wear the entire 1 m capture - every rust bloom in it - inside
// one link, so a chain would read as a run of differently-coloured beads. This
// is the multiple that puts the small parts at roughly the ball's own grain
// instead, which is what makes them look forged from the same bar.
export const FORGED_SMALL = 5;

// How dark. The scan is of a light, near-polished plate (albedo mean 0.71), and
// a ball & chain is a dark object - the generated `cast iron` this replaced was
// #4a4a4e. Multiplied into the albedo this lands the assembly at about that
// value while keeping every bit of the map's variation, rust included, which is
// what a darker capture would have given and a darker capture of this surface
// does not exist.
//
// It is NOT the authored-fill tint the surfaces rule keeps off photographed sets
// (see `TEXTURE_ASSETS`): that one is a level's flat colour leaking onto a
// photograph. This is the avatar's own material saying what shade of iron it is,
// stated once here rather than baked into the shipped bytes, so it can be
// changed by editing a constant instead of re-optimising and re-publishing.
const FORGED_TINT = "#71716f";

// The assembly's surface, at the ball's own scale or a small part's.
export function forgedMetal(tileScale?: number): THREE.MeshStandardMaterial {
  return surfaceFor({ texture: FORGED, tileScale, color: FORGED_TINT });
}

export class BallVisual {
  readonly root = new THREE.Group();
  private readonly owned: THREE.BufferGeometry[] = [];

  constructor(private readonly ball: BallPlayer) {
    const sphere = new THREE.SphereGeometry(ball.radius, 32, 24);
    this.owned.push(sphere);
    const body = new THREE.Mesh(sphere, forgedMetal());
    body.castShadow = true;
    body.receiveShadow = true;
    this.root.add(body);

    // The loop, at the material point the chain leaves through: the top of the
    // ball at rotation 0, which in the ball's own frame is
    // `-(radius + LOOP_GAP)` in y - so +y once negated into three's frame.
    const torus = new THREE.TorusGeometry(BallPlayer.LOOP_RADIUS, LOOP_TUBE, 10, 20);
    this.owned.push(torus);
    const loop = new THREE.Mesh(torus, forgedMetal(FORGED_SMALL));
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
