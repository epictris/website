import * as THREE from "three";
import { Environment } from "../render3d/environment";
import { skinnedBoundingBox } from "../render3d/skinnedBounds";
import type { CaseResult } from "./render3dCases";

export function sunShadowCases(): CaseResult[] {
  const results: CaseResult[] = [];
  const scene = new THREE.Scene();
  const env = new Environment(scene, { sunX: 0, sunY: 0, sunZ: -1 });
  const sun = env.sun!;
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 300);
  camera.position.z = 20;
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const material = new THREE.MeshStandardMaterial();
  const mesh = (x: number, y: number, z: number, cast = false): THREE.Mesh => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = !cast;
    scene.add(m);
    return m;
  };
  mesh(0, 0, 0);
  mesh(45, 0, -80); // Visible background well outside the old 30 m square.
  const caster = mesh(45, 0, 120, true); // Behind the view camera, toward the sun.
  const farSide = mesh(10000, 0, 5000, true); // Cannot shade any visible receiver.
  const ndc = new THREE.Vector3();
  const covered = (x: number, y: number, z: number): boolean => {
    ndc.set(x, y, z).project(sun.shadow.camera);
    return Math.max(Math.abs(ndc.x), Math.abs(ndc.y), Math.abs(ndc.z)) <= 1 + 1e-6;
  };
  const fit = (): void => {
    env.follow(camera);
    sun.shadow.updateMatrices(sun);
  };
  fit();
  results.push({ name: "sun shadows: visible background and offscreen upstream caster share the volume",
    pass: covered(45, 0, -80) && covered(45, 0, 120) && covered(0, 0, 0) && sun.shadow.camera.far < 300,
    detail: `depth ${sun.shadow.camera.far}; unrelated caster excluded` });
  let moving = true;
  for (let x = -10; x <= 10; x += 0.5) {
    camera.position.x = x;
    fit();
    moving &&= covered(45, 0, -80) && covered(45, 0, 120) && covered(0, 0, 0);
  }
  results.push({ name: "sun shadows: camera pan never drops a still-visible distant receiver or its caster",
    pass: moving, detail: "41 camera positions across 20 m" });
  const width = sun.shadow.camera.right - sun.shadow.camera.left;
  caster.position.z = 180;
  fit();
  results.push({ name: "sun shadows: moving caster updates depth without rescaling map texels",
    pass: covered(45, 0, 180) && sun.shadow.camera.right - sun.shadow.camera.left === width,
    detail: `width ${width}, depth ${sun.shadow.camera.far}` });
  // Hidden parents and disabled camera layers must not inflate the fit.
  const hidden = new THREE.Group();
  hidden.visible = false;
  hidden.add(farSide);
  scene.add(hidden);
  const excluded = mesh(45, 0, 5000, true);
  excluded.layers.set(3);
  fit();
  results.push({ name: "sun shadows: invisible parents and excluded layers do not affect depth",
    pass: sun.shadow.camera.far < 400, detail: `depth ${sun.shadow.camera.far}` });

  // A huge single mesh must be clipped to the view, rather than fitting the
  // whole level or finding no vertices because none of its corners are visible.
  const hugeScene = new THREE.Scene();
  const hugeEnv = new Environment(hugeScene, { sunX: 0.35, sunY: 1, sunZ: -0.1 });
  const hugeGeometry = new THREE.BoxGeometry(20000, 20000, 20000);
  const huge = new THREE.Mesh(hugeGeometry, material);
  huge.receiveShadow = true;
  hugeScene.add(huge);
  const ortho = new THREE.OrthographicCamera(-10, 10, 5, -5, 0.1, 100);
  ortho.position.set(0, 0, 20);
  hugeEnv.follow(ortho);
  hugeEnv.sun!.shadow.updateMatrices(hugeEnv.sun!);
  let encloses = true;
  for (let i = 0; i < 8; i++) {
    ndc.set(i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1)
      .unproject(ortho).project(hugeEnv.sun!.shadow.camera);
    encloses &&= Math.max(Math.abs(ndc.x), Math.abs(ndc.y), Math.abs(ndc.z)) <= 1 + 1e-6;
  }
  results.push({ name: "sun shadows: enclosing mesh clips to orthographic view with angled sun",
    pass: encloses && hugeEnv.sun!.shadow.camera.right < 200,
    detail: `half width ${hugeEnv.sun!.shadow.camera.right}` });

  const instance = new THREE.InstancedMesh(geometry, material, 1);
  instance.castShadow = true;
  scene.add(instance);
  instance.setMatrixAt(0, new THREE.Matrix4().makeTranslation(45, 0, 250));
  fit();
  const first = covered(45, 0, 250);
  instance.setMatrixAt(0, new THREE.Matrix4().makeTranslation(45, 0, 350));
  fit();
  results.push({ name: "sun shadows: changed instance transforms refresh caster bounds",
    pass: first && covered(45, 0, 350), detail: `depth ${sun.shadow.camera.far}` });

  // A skinned caster is bounded by its bones (skinnedBounds.ts), not by
  // skinning every vertex: the bound must still enclose three's exact one in
  // any pose, blended weights included, and follow the bones when they move.
  const skinned = skinnedRod(3);
  skinned.mesh.castShadow = true;
  scene.add(skinned.mesh, skinned.root);
  let encloseAll = true;
  let worst = 0;
  for (let pose = 0; pose < 12; pose++) {
    skinned.bones.forEach((b, i) => {
      b.rotation.set(0.3 * Math.sin(pose + i), 0.5 * Math.cos(pose * 1.7 + i), 0.9 * Math.sin(pose * 0.6 - i));
    });
    skinned.root.position.set(pose * 3, -pose, 2 * pose);
    scene.updateMatrixWorld();
    skinned.mesh.computeBoundingBox();
    const exact = skinned.mesh.boundingBox!.clone();
    const bound = skinnedBoundingBox(skinned.mesh, new THREE.Box3());
    encloseAll &&= bound.clone().expandByScalar(1e-6).containsBox(exact);
    worst = Math.max(worst, ...bound.min.clone().sub(exact.min).negate().toArray(), ...bound.max.clone().sub(exact.max).toArray());
  }
  results.push({ name: "sun shadows: a skinned mesh's bone bound encloses its exact skinned bounds in every pose",
    pass: encloseAll && worst < 1, detail: `12 poses, worst slack ${worst.toFixed(3)} m` });
  skinned.root.position.set(45, 0, 400);
  skinned.bones.forEach((b) => b.rotation.set(0, 0, 0));
  fit();
  results.push({ name: "sun shadows: a moved skeleton refreshes its skinned caster's bounds",
    pass: covered(45, 0, 400), detail: `depth ${sun.shadow.camera.far}` });
  // Weights that are not a convex combination break the bone bound's
  // argument, so it must fall back to three's exact walk.
  const unnormalised = skinnedRod(2, 0.5);
  unnormalised.bones[1]!.rotation.set(0, 0, 1.2);
  unnormalised.root.updateMatrixWorld(true);
  unnormalised.mesh.updateMatrixWorld(true);
  unnormalised.mesh.computeBoundingBox();
  const exactFallback = unnormalised.mesh.boundingBox!.clone();
  results.push({ name: "sun shadows: skinned weights that do not sum to one fall back to the exact bound",
    pass: skinnedBoundingBox(unnormalised.mesh, new THREE.Box3()).equals(exactFallback), detail: "weights sum to 0.5" });
  scene.remove(skinned.mesh, skinned.root);
  skinned.mesh.geometry.dispose();
  unnormalised.mesh.geometry.dispose();
  env.dispose();
  hugeEnv.dispose();
  geometry.dispose();
  hugeGeometry.dispose();
  material.dispose();
  instance.dispose();
  return results;
}

// A rod 2 m a bone, along x, skinned to a chain of `bones` bones with each
// vertex blended between the two nearest (weights scaled by `weightSum`), the
// way a bending root's stretches are.
function skinnedRod(bones: number, weightSum = 1): { mesh: THREE.SkinnedMesh; root: THREE.Bone; bones: THREE.Bone[] } {
  const length = 2 * bones;
  const geometry = new THREE.BoxGeometry(length, 0.4, 0.4, bones * 4, 1, 1);
  geometry.translate(length / 2, 0, 0);
  const position = geometry.getAttribute("position");
  const index: number[] = [];
  const weight: number[] = [];
  for (let v = 0; v < position.count; v++) {
    const along = Math.min(bones - 1e-6, Math.max(0, position.getX(v) / 2 - 0.5));
    const a = Math.floor(along);
    const t = along - a;
    const b = Math.min(bones - 1, a + 1);
    index.push(a, b, 0, 0);
    weight.push((1 - t) * weightSum, t * weightSum, 0, 0);
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weight, 4));
  const chain: THREE.Bone[] = [];
  for (let i = 0; i < bones; i++) {
    const bone = new THREE.Bone();
    bone.position.x = i === 0 ? 0 : 2;
    chain[i - 1]?.add(bone);
    chain.push(bone);
  }
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.add(chain[0]!);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(chain));
  // The bones ride a separate root so a test can move the skeleton without
  // moving the mesh, as a bending root's segments do.
  const root = new THREE.Bone();
  root.add(chain[0]!);
  return { mesh, root, bones: chain };
}
