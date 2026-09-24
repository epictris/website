// PER-OBJECT PROJECTION - a geometry object drawn through an orthographic lens
// inside a scene drawn through a perspective one (`GeometryObjectData.projection`).
//
// It is NOT a second camera and a second pass. Two passes cannot share a depth
// buffer honestly - a perspective camera's depth is hyperbolic and an
// orthographic one's is linear, so an ortho prop behind a perspective wall would
// sort by an accident of the two curves - and every light, shadow and fog term
// would have to be kept in step across both. Instead the object is drawn through
// the SAME camera, and only the one line that turns a view-space position into a
// clip-space one is changed:
//
//   perspective:   screen = xy_view / (-z_view * tan(fov/2))
//   orthographic:  screen = xy_view / (plane   * tan(fov/2))
//
// where `plane` is the distance along the view axis to the framed plane (the
// gameplay plane, z = 0, unless the level's camera `zOffset` moves it; see
// `orthoFramedZ`) - the distance `syncCamera` dollies to, and the depth at which the scene's
// orthographic camera is sized to agree with the perspective one to the pixel
// (see `ViewProjection` in space.ts). Scaling xy_view by `-z_view / plane` before
// the projection matrix makes the divide cancel, so the vertex lands exactly
// where the orthographic camera would put it. `z` is left alone, so the depth
// written is the true perspective depth and the object sorts against every
// other one by where it really is.
//
// Nothing else sees the change: `mvPosition` itself is untouched, so the view
// vector, the world position the shadow lookup and the lamps read, and the fog
// depth are all the object's real ones. The shadow pass draws with three's own
// depth materials, which this never patches, so what an ortho object casts is
// the shadow its authored placement throws.
//
// Under the editor's orthographic camera (`isOrthographic`, a uniform three
// already provides) the patch does nothing - the whole scene is orthographic
// then, and scaling it again would be scaling it twice.

import * as THREE from "three";
import type { GeometryProjection } from "../level/levelFormat";

// Tagged on the MATERIAL's userData rather than kept in a side table, because a
// material's userData survives `clone()` - so anything that copies the material
// (the editor's selection highlight) can still ask what lens it draws through.
const ORTHO_TAG = "orthographic";

// The depth the 2D view's scale holds at: the gameplay plane unless the level
// moved the camera along z (`SceneLens.zOffset`), in which case it is the plane
// the camera now frames. The orthographic camera is sized to that same scale,
// so this is what makes a twin land where it would under that camera.
//
// ONE uniform object shared by every twin, and written by `Scene3D.render`
// immediately before it draws. That is module state, which `Scene3D` otherwise
// forbids because two scenes can exist at once - it is safe here only because
// three re-uploads a material's uniforms on the first draw of every `render()`
// call, so each scene's frame reads the value it wrote itself.
export const orthoFramedZ = { value: 0 };

const ORTHO_UNIFORMS = /* glsl */ `#include <common>
uniform float orthoFramedZ;`;

const ORTHO_VERTEX = /* glsl */ `#include <project_vertex>
{
  // The framed plane's distance along the view axis: where the camera's
  // forward ray meets z = orthoFramedZ. Head-on that is simply the camera's
  // height above it; an orbited editor view is the same ray at a slant.
  vec3 forward = -vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] );
  float plane = forward.z < -1e-4 ? ( orthoFramedZ - cameraPosition.z ) / forward.z : 0.0;
  if ( !isOrthographic && plane > 0.0 ) {
    vec4 orthoPosition = mvPosition;
    orthoPosition.xy *= -orthoPosition.z / plane;
    gl_Position = projectionMatrix * orthoPosition;
  }
}`;

type Patchable = THREE.Material & { __painted?: true };

// `clone()` that keeps a material's shader patches. Three's `copy` carries every
// parameter but NOT `onBeforeCompile` or `customProgramCacheKey`, which are
// instance overrides - so a plain clone of a painted or orthographic material is
// silently a photographic, perspective one.
export function cloneWithPatches<M extends THREE.Material>(src: M): M {
  const clone = src.clone() as M;
  const own = (k: string): boolean => Object.prototype.hasOwnProperty.call(src, k);
  if (own("onBeforeCompile")) clone.onBeforeCompile = src.onBeforeCompile;
  if (own("customProgramCacheKey")) clone.customProgramCacheKey = src.customProgramCacheKey;
  const tagged = src as Patchable;
  if (tagged.__painted) (clone as Patchable).__painted = true;
  return clone;
}

export function isOrthographicMaterial(material: THREE.Material | THREE.Material[]): boolean {
  const first = Array.isArray(material) ? material[0] : material;
  return first?.userData[ORTHO_TAG] === true;
}

// One orthographic twin per source material. The sources are shared and cached
// for the life of the page (see assets.ts), so their twins are too: a hundred
// ortho bricks wear one material and compile one program.
const twins = new WeakMap<THREE.Material, THREE.Material>();

function orthographicTwin(src: THREE.Material): THREE.Material {
  if (isOrthographicMaterial(src)) return src;
  const cached = twins.get(src);
  if (cached) return cached;
  const twin = cloneWithPatches(src);
  twin.userData[ORTHO_TAG] = true;
  const previous = twin.onBeforeCompile;
  // The key the material had BEFORE this patch, captured now for the reason
  // `paintMaterial` gives: three's default key is the hook's source text, which
  // after the swap below would be this wrapper's - the same for every twin.
  const previousKey = Object.prototype.hasOwnProperty.call(twin, "customProgramCacheKey")
    ? twin.customProgramCacheKey.bind(twin)
    : () => previous.toString();
  twin.customProgramCacheKey = () => `${previousKey()}|ortho`;
  twin.onBeforeCompile = (shader, renderer) => {
    previous.call(twin, shader, renderer);
    shader.uniforms["orthoFramedZ"] = orthoFramedZ;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", ORTHO_UNIFORMS)
      .replace("#include <project_vertex>", ORTHO_VERTEX);
  };
  twins.set(src, twin);
  return twin;
}

// Draw every mesh under `root` through `projection`. Called on a mounted
// visual, and again on a prop's model when it arrives. Perspective is what a
// mesh already is, so it does nothing.
export function applyProjection(root: THREE.Object3D, projection: GeometryProjection | undefined): void {
  if (projection !== "orthographic") return;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(orthographicTwin)
      : orthographicTwin(mesh.material);
    // Culling tests the mesh's TRUE bounds against the perspective frustum, and
    // in front of the plane that frustum is narrower than the one the mesh is
    // drawn through - so an ortho prop near the frame edge would vanish while
    // still on screen.
    mesh.frustumCulled = false;
  });
}
