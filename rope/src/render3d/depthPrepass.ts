// The scenery's depth, laid down before anything is shaded.
//
// WHY. Three sorts its opaque draws by MATERIAL before depth (`painterSortStable`:
// render order, then material id, then distance), so a level whose rocks each
// wear their own baked material is drawn in material order, not front to
// back. Every rock drawn before the rock in front of it is shaded in full and
// then painted over - and a scenery fragment is the expensive kind: a baked
// colour and normal map, three's physical surface model, and every lamp in the
// level (see lightReach.ts). The closed rocks are also double-sided in the
// export, so a rock's own back faces were shaded under its front ones.
//
// Measured live (2026-10-16, ball.json at the spawn, 3701x2082, RTX 4070
// SUPER, interleaved blocks): the scenery was 3.4 of the main pass's 4.3 ms,
// and laying its depth first took the pass to 2.0 ms - the scenery was being
// shaded about twice per pixel. At the player's 4K setting that was the
// difference between 10% of frames dropped at 144 Hz and none.
//
// HOW. Each eligible mesh carries a DEPTH STAND-IN: a child sharing its
// geometry, wearing one depth-only material (no colour written), ordered ahead
// of every other opaque draw (`PREPASS_ORDER`). So inside the one ordinary
// render the stand-ins write the nearest depth first, and when the real
// materials follow, three's default `LessEqualDepth` test lets each pixel's
// nearest surface through and rejects everything behind it before its
// fragment shader runs. Riding the scene graph rather than being a second
// `renderer.render` means three culls, hides and transforms a stand-in with
// its mesh for nothing, and the frame's lights are the same lights throughout
// (a separate pass with no lights in it would make three re-validate every lit
// material's program twice a frame).
//
// It is the textbook z-prepass (Babylon's `needDepthPrePass` is the same
// draw-twice-in-one-group), applied only where it pays: big static opaque
// meshes with expensive shading, which is what a Blender scene is made of.
//
// EXACTNESS. The stand-in's depth must equal its mesh's to the bit, or the
// real surface fails its own test and the pixel shows whatever was behind
// it. Both programs compute `gl_Position` from the same matrices with the
// same expression (three's `project_vertex`), and `installInvariantPosition`
// declares it `invariant` in every built-in vertex shader, which is the
// language's guarantee that two programs evaluating the same expression get
// the same result. Checked live: 0 of 7.7 M pixels differ with the stand-ins
// in, and a stand-in offset by a few metres changes 659 k.
//
// What is eligible is what that holds for: a plain mesh whose material is
// opaque, writes and tests depth the default way, cuts nothing out of itself
// (no alpha test, map or hash), moves no vertex (no displacement, morph or
// skin) and has no shader patch of its own (whose vertex half could be
// anything). Back-side-only materials are out too: the stand-in draws front
// faces, which must be a subset of what its mesh draws. A double-sided mesh's
// back faces get no stand-in and are depth-tested as before.
//
// A mesh whose material is later swapped for a see-through one must LEAVE
// (`leaveDepthPrepass`), or its stand-in hides what should show through it:
// the scene's own water, which the pool's material replaces, is the one case
// (`Scene3D.adoptSceneryWater`).

import * as THREE from "three";

// Ahead of every opaque draw in the frame. The depth-of-field composite uses
// `Number.MIN_SAFE_INTEGER`, but on its own layer, so the two never meet.
export const PREPASS_ORDER = -1e9;

const STAND_IN = "depth-prepass";

// Shared by every stand-in, so the whole prepass is one program. Front faces
// only (see the header); no fog, no tone mapping - nothing it computes is kept.
const DEPTH_ONLY = new THREE.MeshBasicMaterial({
  colorWrite: false,
  side: THREE.FrontSide,
  fog: false,
  toneMapped: false,
});
DEPTH_ONLY.name = STAND_IN;

// Why `mesh` cannot take a stand-in, or null when it can. A reason rather than
// a boolean so `cli render3d` and a probe can say what kept a mesh out.
export function prepassRefusal(mesh: THREE.Mesh): string | null {
  if (!mesh.isMesh) return "not a mesh";
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return "skinned";
  if ((mesh as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return "batched";
  if (mesh.geometry.morphAttributes.position?.length) return "morph targets";
  const material = mesh.material;
  if (Array.isArray(material)) return "material groups";
  if (material.transparent) return "transparent";
  if (material.alphaTest > 0) return "alpha test";
  if (material.alphaHash) return "alpha hash";
  if (!material.depthTest || !material.depthWrite) return "depth not tested and written";
  if (material.depthFunc !== THREE.LessEqualDepth) return "depth function";
  if (!material.colorWrite) return "writes no colour";
  if (material.side === THREE.BackSide) return "back side only";
  if (material.blending !== THREE.NormalBlending) return "blended";
  const maps = material as THREE.MeshStandardMaterial;
  if (maps.alphaMap) return "alpha map";
  if (maps.displacementMap) return "displacement map";
  if (maps.wireframe) return "wireframe";
  if (Object.prototype.hasOwnProperty.call(material, "onBeforeCompile")) return "shader patch";
  return null;
}

// Give `mesh` its stand-in, if it is eligible and has none. Returns whether it
// has one now. The stand-in is a child, so a `clone(true)` of the scene (every
// mount of a cached file, see sceneDressing.ts) carries it.
export function joinDepthPrepass(mesh: THREE.Mesh): boolean {
  if (standInOf(mesh)) return true;
  if (prepassRefusal(mesh) !== null) return false;
  addStandIn(mesh, DEPTH_ONLY, PREPASS_ORDER);
  return true;
}

// A PICTURE - an image shown as it is on a plane, whose map the scene export
// names `<image> picture` (tools/blender/scene_export.py `prepare_pictures`) -
// is blended, and a blended surface writes no depth, so anything drawn after
// it paints over it even where the picture stands in front. The water is
// drawn after all transparent scenery (renderOrder 10, water.ts), and drew
// over the river's root-room backdrop wherever a card stands in the pool
// (2026-10-17); the depth of field also blurred a card by whatever was behind
// it.
//
// So a picture lays its depth too, but AFTER it is drawn, not before: a depth
// laid first would reject the scenery behind the picture's soft outline, which
// then blended over nothing and drew a dark rim. Every picture is blended (in
// three's back-to-front order) and then every picture's depth is laid
// (`PICTURE_DEPTH_ORDER`), so all that is drawn later - the water - is tested
// against the cards. The depth is cut out by the picture's own map at half
// alpha (`PICTURE_DEPTH_CUT`), the textbook cut: a picture is not reliably
// opaque inside its outline - the root-room cards are 252 of 255 throughout,
// and a cut at 0.99 let the pool through them in blotches - so only the
// outline's soft ramp is in question, where a later surface behind the card
// draws over its outer half and is rejected under its inner half.
export const PICTURE_DEPTH_ORDER = 1;
export const PICTURE_DEPTH_CUT = 0.5;

export function isPicture(mesh: THREE.Mesh): boolean {
  const material = mesh.material;
  if (Array.isArray(material) || !material.transparent) return false;
  const map = (material as THREE.MeshBasicMaterial).map;
  return !!map && / picture$/.test(map.name);
}

// Give a picture its depth, once. Returns whether `mesh` is a picture.
export function joinPictureDepth(mesh: THREE.Mesh): boolean {
  if (!isPicture(mesh)) return false;
  if (standInOf(mesh)) return true;
  const material = mesh.material as THREE.MeshBasicMaterial;
  const depth = new THREE.MeshBasicMaterial({
    map: material.map,
    alphaTest: PICTURE_DEPTH_CUT,
    colorWrite: false,
    // Transparent only to be drawn in the transparent pass, after the picture.
    transparent: true,
    depthWrite: true,
    side: material.side,
    fog: false,
    toneMapped: false,
  });
  depth.name = STAND_IN;
  addStandIn(mesh, depth, PICTURE_DEPTH_ORDER);
  return true;
}

function addStandIn(mesh: THREE.Mesh, material: THREE.Material, renderOrder: number): void {
  const standIn = new THREE.Mesh(mesh.geometry, material);
  standIn.name = STAND_IN;
  standIn.renderOrder = renderOrder;
  // It IS its mesh, drawn a second way: the identity in its mesh's frame, a
  // shadow nobody needs twice, and nothing for a pick to land on.
  standIn.matrixAutoUpdate = false;
  standIn.castShadow = false;
  standIn.receiveShadow = false;
  standIn.raycast = () => {};
  standIn.userData[STAND_IN] = true;
  mesh.add(standIn);
}

export function leaveDepthPrepass(mesh: THREE.Mesh): void {
  const standIn = standInOf(mesh);
  if (standIn) mesh.remove(standIn);
}

// Whether `o` is a stand-in: what a traversal that restyles or counts the
// scene's meshes (the editor's highlight) leaves alone.
export function isDepthStandIn(o: THREE.Object3D): boolean {
  return o.userData[STAND_IN] === true;
}

function standInOf(mesh: THREE.Mesh): THREE.Object3D | undefined {
  return mesh.children.find(isDepthStandIn);
}

// The declaration that makes a vertex shader's `gl_Position` the same in every
// program that computes it the same way (see EXACTNESS above).
export const INVARIANT_POSITION = "invariant gl_Position;";

// `chunk` (three's `logdepthbuf_pars_vertex`) with the declaration ahead of
// it. ShaderChunk has no vertex-only header; this is the vertex-only
// declarations chunk every built-in mesh shader includes at global scope
// (basic, standard, physical, depth, shadow - `cli render3d` checks), so it
// hosts the qualifier for all of them, clones and restyled copies included.
// Idempotent. Exported so `cli render3d` can read it without a GPU.
export function invariantPositionChunk(chunk: string): string {
  return chunk.includes(INVARIANT_POSITION) ? chunk : `${INVARIANT_POSITION}\n${chunk}`;
}

// Before any material is made or compiled (see lightReach.ts for why it has
// to be before); environment.ts imports this.
THREE.ShaderChunk.logdepthbuf_pars_vertex = invariantPositionChunk(THREE.ShaderChunk.logdepthbuf_pars_vertex);
