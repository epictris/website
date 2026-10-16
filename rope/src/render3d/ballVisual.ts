// The ball & chain avatar in 3D: a cast-iron sphere and the steel loop the chain
// deploys through - or, on Hard, a solid glass ball and a glass loop (see
// `buildGlass` and docs/glass-ball.md), which is all the rest of this header is
// not about.
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
import { standardMaterialsOf, wearAvatar } from "./avatarSurface";
import { setProbe, wearProbe } from "./reflectionProbe";
import { HOLLOW_GLASS_ORDER, hollowGlassMaterial, solidGlassMaterial } from "./glassMaterial";
import { glassBallSolid, glassWall } from "./glassWall";
import { FrameCopy } from "./frameCopy";
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

// How light, and how warm. The strokes are baked at the steel's own value (a
// mid grey, a little cool), and this barely darkens them and nudges them warm:
// the links are metal, so this is their reflectance, and anything darker
// turned them into black beads against a dark cave.
//
// Darkened to the ball (2026-10-01): next to the painted near-black model the
// pale links read as a different metal. The strokes' 0.156 linear grey times
// this tint lands the links at ~0.033, neutral - the ball's own worn albedo
// (`MODEL_ALBEDO` over its map) - so ball, chain and cuff are one iron again.
// The river's warm sun and lit sky are what keep that from being the black
// beads above; the matching roughness and metalness are on the set itself
// (`TEXTURE_ASSETS["painted steel"]`).
//
// It is NOT the authored-fill tint the surfaces rule keeps off authored sets
// (see `TEXTURE_ASSETS`): that one is a level's flat colour leaking onto a
// picture. This is the avatar's own material saying what shade of steel it is,
// stated once here rather than baked into the shipped bytes, so it can be
// changed by editing a constant instead of re-baking and re-publishing.
const FORGED_TINT = "#81817a";

// The assembly's surface, at the ball's own scale or a small part's. The
// avatar's OWN copy of it (`avatar: true`), wearing the avatar's thinner air,
// which the shared copy a wall of the same steel would get must not (see
// `avatarSurface.ts`).
export function forgedMetal(tileScale?: number): THREE.MeshStandardMaterial {
  return wearAvatar(surfaceFor({ texture: FORGED, tileScale, color: FORGED_TINT, avatar: true }));
}

// How the model's own materials are worn, over its maps. The first deliveries'
// packed roughness read a 0.49 mean and their albedo a 0.15 grey, which under plain PBR is a
// dull, near-black iron: a metal's colour IS its reflection, so a 0.15 albedo
// reflects 15% of the room, and in a dark cave the ball was a silhouette.
// Half the roughness tightens the reflection into a shine; the albedo lifted
// to a ~0.75 mean gives it something to shine with; and metalness just short
// of 1 lets the lamps light it diffusely as well, which is what shows the
// sphere's form and its hammer facets where the environment is dark. Applied
// here rather than baked into the file, so the shine is tuned by editing a
// constant instead of re-optimising and re-publishing the model.
//
// Metalness HALF rather than just short of 1 (2026-09-24): in the cave the
// environment is dark, so a near-metal lit by a mushroom showed one smeared
// highlight and a black sphere - a metal's lit side is a reflection, and there
// was nothing to reflect. At 0.5 the other half of the surface is a diffuse
// lobe that takes a lamp's colour across the whole lit hemisphere, which is
// what old iron looks like anyway: rust, grime and dust are dielectric layers
// over the metal, not chrome. Roughness up with it (0.5 -> 0.65): the
// highlight a lamp puts on the sphere spreads across more of it instead of
// sitting as one tight patch, and it softens the view-fixed highlight the
// rolling ball would otherwise wear as a sticker.
//
// Dark iron again (2026-09-30): the river is now lit by a warm top-down sun
// (docs/lighting-and-surfaces.md), so the ball no longer needs a pale albedo
// to be seen, and at a x5 lift it read as a light grey stone against the
// reference painting's near-black cannonball. The lift is what says how dark
// the iron is: ~0.3 grey keeps the sphere's form under the sun and leaves it
// black-iron in the shade. Metalness back UP (0.75) and roughness down (0.4)
// because the painting's ball is gunmetal, not rubber: a broad, soft
// reflection of the cave's blue across its upper half and a warm patch where
// the sun catches it, which only a mostly-specular surface gives. The reason
// half-metal was chosen (nothing to reflect) no longer holds: the generated
// sky is now a lit blue and the sun is on, so there is a room to reflect.
//
// The fifth delivery (2026-10-01) arrived with that lift already in its maps:
// a 0.098 linear albedo mean against the old 0.021, roughness 0.37 and
// metalness 0.86 against 0.49 and 0.74, and a cool blue-grey. Then darker, to
// Tris's reference of a near-black, faintly warm cannonball whose facets show
// only where they catch the sky: the albedo is now a TINT rather than a
// scalar, ~0.35 and warm so the blue in the maps goes neutral, landing near
// 0.033 linear. Metalness stays short of 1 (0.62 worn): at full metal the
// river has too little to reflect and the facets vanish into a black ball.
//
// The sixth delivery (same day) swapped the albedo for a hand-painted,
// neutral grey one (0.072 linear where the UVs land), so the tint is
// re-derived to hold the worn iron where the approved look put it - about
// 0.033, neutral - with the painted blotches now carrying the variation.
const MODEL_ROUGHNESS = 1;
const MODEL_METALNESS = 1;
// Linear RGB, multiplied into the albedo map.
const MODEL_ALBEDO = new THREE.Color().setRGB(0.44, 0.47, 0.48, THREE.LinearSRGBColorSpace);

// The model's materials, worn as the avatar: its shine, and the avatar's rules
// (see `avatarSurface.ts`).
function shine(obj: THREE.Object3D): void {
  for (const std of standardMaterialsOf(obj)) {
    // `loadMesh` hands out clones that share the cached file's materials,
    // so a second ball on the page must not lift the albedo twice.
    // `wearAvatar` has the same guard of its own.
    wearAvatar(std);
    // Lit from the reflection probe's cube rather than an envMap (see
    // reflectionProbe.ts `wearProbe`).
    wearProbe(std);
    if (std.userData.shined) continue;
    std.userData.shined = true;
    std.roughness = MODEL_ROUGHNESS;
    std.metalness = MODEL_METALNESS;
    std.color.multiply(MODEL_ALBEDO);
  }
}

export class BallVisual {
  readonly root = new THREE.Group();
  private readonly owned: THREE.BufferGeometry[] = [];
  // Whether this was built as the glass ball. The ball's kind may be set after
  // the level is built (`BallLevel.setBallKind`, the menu's pick), and the
  // scene rebuilds the visual when the two disagree.
  readonly glass: boolean;
  // Materials this visual made for itself and must free: the glass ball's
  // (the iron ones are cached and shared, see `forgedMetal`).
  private readonly ownedMaterials: THREE.Material[] = [];
  // The primitives standing in until the model lands, as one group so the swap
  // is a remove rather than a search. Null once it has happened.
  private stand: THREE.Group | null = new THREE.Group();
  private disposed = false;
  // The model's materials once it has landed, and what they reflect: the
  // level around the ball (`ReflectionProbe`), handed in every frame by the
  // scene. The stand-in does not wear it - its iron is the chain's, shared.
  private modelMaterials: THREE.MeshStandardMaterial[] = [];
  private reflection: THREE.CubeTexture | null = null;
  // The hollow glass ball's patch of the frame behind it (see `buildGlass`).
  private frameCopy: FrameCopy | null = null;

  constructor(
    // The ball this draws, which the scene compares against the level's to
    // follow a respawn (see `follow`).
    public ball: BallPlayer,
    // The glass ball's baked surface wear (see glassWear.ts), when it is glass.
    private readonly wear: THREE.CubeTexture | null = null,
  ) {
    this.glass = ball.glass;
    if (ball.glass) {
      this.buildGlass();
      return;
    }
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
      shine(obj);
      this.modelMaterials = standardMaterialsOf(obj);
      if (this.reflection) this.setReflection(this.reflection);
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

  // THE GLASS BALL (Hard, `BallPlayer.glass`): a magic aurora crystal ball of
  // quartz, coated outside (Tris, 2026-10-16) - hollow, with a wall of
  // `glassWall` (glassWall.ts), or solid when that is the whole radius - and a
  // solid quartz loop, in place of the iron model, which is never loaded (see
  // glassMaterial.ts for what each is and how it is drawn). Built rather than
  // modelled: a smooth sphere is the one shape a primitive draws perfectly, and
  // there is nothing hammered about glass.
  //
  // The sphere is the collider's silhouette, as the iron ball's is, and finely
  // tessellated: the lens and the film are traced off its normals, and a
  // faceted sphere refracts as a cut gem. It casts no shadow (see
  // glassMaterial.ts). Its light on the world is the scene's
  // (`Scene3D.ballGlow`).
  private buildGlass(): void {
    const sphere = new THREE.SphereGeometry(this.ball.radius, 96, 64);
    this.owned.push(sphere);
    let glass: THREE.MeshPhysicalMaterial;
    const body = new THREE.Mesh(sphere);
    if (glassBallSolid(this.ball.radius)) {
      glass = solidGlassMaterial(this.ball.radius, this.wear, true);
      // After the scene's opaque work, as glass in front of it.
      body.renderOrder = 1;
    } else {
      // What is behind the ball, copied out of the frame the moment before it
      // is drawn (frameCopy.ts) - so after everything else opaque, the loop
      // included.
      const copy = new FrameCopy();
      this.frameCopy = copy;
      glass = hollowGlassMaterial(this.ball.radius, glassWall.value, copy.uniforms, this.wear, true);
      body.renderOrder = HOLLOW_GLASS_ORDER;
      const radius = this.ball.radius;
      body.onBeforeRender = (renderer, _scene, camera) => copy.grab(renderer, camera, body, radius);
    }
    body.material = glass;
    body.name = "glass-ball";
    body.receiveShadow = true;
    this.root.add(body);
    this.ownedMaterials.push(glass);
    // The loop in solid quartz, where the iron one is (see the constructor): a
    // bar of its tube's radius, seeing the room through the same probe.
    const torus = new THREE.TorusGeometry(BallPlayer.LOOP_RADIUS, LOOP_TUBE, 16, 32);
    this.owned.push(torus);
    const ring = solidGlassMaterial(LOOP_TUBE);
    const loop = new THREE.Mesh(torus, ring);
    loop.position.set(0, threeY(-(this.ball.radius + BallPlayer.LOOP_GAP)), 0);
    loop.renderOrder = 1;
    loop.receiveShadow = true;
    this.root.add(loop);
    this.modelMaterials = [glass, ring];
    this.ownedMaterials.push(ring);
    this.stand = null;
  }

  // Wear `texture` as the model's reflection in place of the scene's sky, or
  // the sky again with null. The probe hands back the same texture every
  // frame, so this recompiles nothing past the first call.
  setReflection(texture: THREE.CubeTexture | null): void {
    this.reflection = texture;
    for (const mat of this.modelMaterials) setProbe(mat, texture);
  }

  // Draw `ball` from now on, when it is a ball of the kind and size this was
  // built for: a glass ball's respawn (`BallLevel.respawn`), a fresh BallPlayer
  // of the same ball. Nothing is rebuilt. Rebuilding disposed the glass
  // materials, which released their programs (nothing else draws with them),
  // so the respawn frame compiled the lens shader again - the hitch Tris saw
  // "every time the glass ball respawns" (2026-10-16). False when it is not
  // such a ball, and the visual has to be rebuilt.
  follow(ball: BallPlayer): boolean {
    if (ball.glass !== this.glass || ball.radius !== this.ball.radius) return false;
    this.ball = ball;
    return true;
  }

  // Whether this frame draws the hollow glass ball, which copies the frame
  // behind it as it is drawn, so wants it drawn late (`Scene3D.render`).
  get seesFrame(): boolean {
    return this.frameCopy !== null && this.root.visible;
  }

  sync(alpha: number): void {
    // A broken glass ball is its shards now (see glassShards.ts), and nothing
    // of the ball is left standing where it broke.
    this.root.visible = !this.ball.shattered;
    placeAt(this.root, this.ball.renderPosition(alpha));
    orientTo(this.root, this.ball.renderRotation(alpha));
  }

  dispose(): void {
    this.disposed = true;
    this.modelMaterials = [];
    this.reflection = null;
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
    this.frameCopy?.dispose();
    this.frameCopy = null;
    this.stand = null;
    this.root.clear();
  }
}
