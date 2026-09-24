// The ball & chain avatar in 3D: a cast-iron sphere and the steel loop the chain
// deploys through.
//
// Since the model landed (`BALL_MESH`) both of those are one MODELLED
// assembly - a hammered iron ball with a thin forged loop at its pole - and
// what this file builds from primitives is what stands in for it until the
// file arrives. That stand-in is not scaffolding to delete: the avatar is on
// screen from the first frame, the sim runs whether or not 700 KB has landed,
// and a grey placeholder box where the player is would be a worse failure than
// on any prop. So the sphere and torus below are built, drawn, and swapped out
// in place - the one prop in this game whose fallback is a considered object
// rather than a box.
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
// `renderLoopCenter`, computed by the scene graph instead of by hand. The model
// gets this for free, and for the same reason: its ring is modelled at the pole,
// so it is a material point of the same rotating root.

import * as THREE from "three";
import { BallPlayer } from "../classes/ballPlayer";
import { BALL_MESH, BALL_MESH_RADIUS, IRON_SURFACE, loadMesh, surfaceFor } from "./assets";
import { orientTo, placeAt, threeY } from "./space";

// How much thicker than the collision radius the mounting loop's ring is drawn.
// The loop is a 2 cm collision circle (`BallPlayer.LOOP_RADIUS`) and a torus of
// exactly that radius reads as a dot; the tube is what makes it a forged ring.
const LOOP_TUBE = BallPlayer.LOOP_RADIUS * 0.42;

// What the whole assembly - ball, loop, every chain link, the manacle - is made
// of: one set of OIL STROKES on steel (`TEXTURE_ASSETS`, keyed "painted steel",
// baked by `scripts/bake-strokes.ts`), since 2026-09-17 when the game became a
// painting. Before that it was a photographed set of rust-bloomed iron, and
// before that generated `cast iron` and `steel` noise, which stays its
// fallback, so the avatar looks like itself from the first frame and the maps
// swap in when they land.
//
// One surface for all of it because it IS one forged assembly: the ball and the
// chain hanging off it reading as the same metal is most of what makes them look
// like one object rather than two props that happen to touch.
// Named in `assets.ts` beside the manifest it is a key of, because a second
// reader needs it: the preload list a page starts downloading before the app
// exists has to account for this surface, and that resolver cannot import this
// module (it would drag the avatar, the sim and three into a build step).
export const FORGED = IRON_SURFACE;

// How large that surface is worn on the assembly's SMALL parts. The set's tile
// (see its manifest entry) sizes a stroke to an eighth of the ball; a 4 cm link
// at the same tile would wear a fraction of one stroke and every link would be
// a different flat tone, a run of beads. This multiple puts the small parts at
// roughly the ball's own grain instead, which is what makes them look forged
// from the same bar. The ball itself wears the set at its own tile.
export const FORGED_SMALL = 5;

// How dark, and how warm. The strokes are baked at the steel's own value (a
// mid grey, a little cool, as the reference paints it), and this pulls the
// assembly a shade darker and toward the warm: nearly white read pale and
// cool in the game, and a warm grey is the reference's steel under a warm
// room.
//
// It is NOT the authored-fill tint the surfaces rule keeps off authored sets
// (see `TEXTURE_ASSETS`): that one is a level's flat colour leaking onto a
// picture. This is the avatar's own material saying what shade of steel it is,
// stated once here rather than baked into the shipped bytes, so it can be
// changed by editing a constant instead of re-baking and re-publishing.
const FORGED_TINT = "#b8ac9e";

// The assembly's surface, at the ball's own scale or a small part's.
export function forgedMetal(tileScale?: number): THREE.MeshStandardMaterial {
  return surfaceFor({ texture: FORGED, tileScale, color: FORGED_TINT });
}

export class BallVisual {
  readonly root = new THREE.Group();
  private readonly owned: THREE.BufferGeometry[] = [];
  // The primitives standing in until the model lands, as one group so the swap
  // is a remove rather than a search. Null once it has happened.
  private stand: THREE.Group | null = new THREE.Group();
  private disposed = false;

  constructor(private readonly ball: BallPlayer) {
    const stand = this.stand as THREE.Group;
    const sphere = new THREE.SphereGeometry(ball.radius, 32, 24);
    this.owned.push(sphere);
    const body = new THREE.Mesh(sphere, forgedMetal());
    body.castShadow = true;
    body.receiveShadow = true;
    stand.add(body);

    // The loop, at the material point the chain leaves through: the top of the
    // ball at rotation 0, which in the ball's own frame is
    // `-(radius + LOOP_GAP)` in y - so +y once negated into three's frame.
    const torus = new THREE.TorusGeometry(BallPlayer.LOOP_RADIUS, LOOP_TUBE, 10, 20);
    this.owned.push(torus);
    const loop = new THREE.Mesh(torus, forgedMetal(FORGED_SMALL));
    loop.castShadow = true;
    loop.position.set(0, threeY(-(ball.radius + BallPlayer.LOOP_GAP)), 0);
    stand.add(loop);
    this.root.add(stand);

    void loadMesh(BALL_MESH).then((obj) => {
      if (!obj || this.disposed) return;
      // The one number that has to be applied here rather than baked into the
      // file, since a level may author a different radius than the model's.
      obj.scale.multiplyScalar(ball.radius / BALL_MESH_RADIUS);
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      this.root.add(obj);
      // Removed only once the model is in the scene, so there is never a frame
      // with no avatar in it.
      if (this.stand) this.root.remove(this.stand);
      this.stand = null;
    });
  }

  sync(alpha: number): void {
    placeAt(this.root, this.ball.renderPosition(alpha));
    orientTo(this.root, this.ball.renderRotation(alpha));
  }

  dispose(): void {
    this.disposed = true;
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    this.stand = null;
    this.root.clear();
  }
}
