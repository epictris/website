import * as THREE from "three";
import { Environment } from "../render3d/environment";
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
  env.dispose();
  hugeEnv.dispose();
  geometry.dispose();
  hugeGeometry.dispose();
  material.dispose();
  instance.dispose();
  return results;
}
