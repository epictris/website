import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { setMossShadowScales, wearMossShadowBias } from "/home/tris/projects/website/rope/src/render3d/mossShadow";
declare global { interface Window { shotReady?: boolean } }
const q = new URLSearchParams(location.search);
const file = q.get("glb") ?? "d_hybrid.glb";
const W = 1500, H = 500;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H); renderer.setScissorTest(true);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; // as the game (environment.ts)
document.body.style.margin = "0"; document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x294859);
const sun = new THREE.DirectionalLight(0xffd9a3, 2.3); sun.position.set(-1.5, 2.2, 2.0); sun.castShadow = true;
// The sun's shadow as the game has it (render3d/environment.ts): a 2048 map over a 30 m box, near 0.5, far 75,
// so a texel is 1.5 cm and the biases mean what they mean in a level. `?mb=0` leaves the moss's own biases off.
const nb = Number(q.get("nb") ?? "0.03");
const SD = Number(q.get("sd") ?? "30"); // `?sd=` and `?ms=` try a tighter box or a bigger map: what finer shadow texels would buy
const MS = Number(q.get("ms") ?? "2048");
sun.shadow.mapSize.set(MS, MS);
sun.shadow.camera.left = sun.shadow.camera.bottom = -SD / 2; sun.shadow.camera.right = sun.shadow.camera.top = SD / 2;
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = SD * 2.5; sun.shadow.camera.updateProjectionMatrix();
sun.position.set(-1.5 * 10, 2.2 * 10, 2.0 * 10);
if (q.get("sun")) { const [x, y, z] = q.get("sun")!.split(",").map(Number); sun.position.set(x! * 30, y! * 30, z! * 30); } // `?sun=x,y,z`: a level's sun direction (ball.json sunX/Y/Z, the game's frame)
sun.shadow.normalBias = nb; sun.shadow.bias = Number(q.get("cb") ?? "-0.0008"); sun.shadow.radius = Number(q.get("rad") ?? "3"); scene.add(sun);
const mossBias = q.get("mb") !== "0";
// `?cs=&ns=&rs=` try other scales of the moss's biases and filter (mossShadow.ts's defaults otherwise).
setMossShadowScales({ constant: q.has("cs") ? Number(q.get("cs")) : undefined, normal: q.has("ns") ? Number(q.get("ns")) : undefined, radius: q.has("rs") ? Number(q.get("rs")) : undefined });
scene.add(new THREE.HemisphereLight(0x7fa6cc, 0x22301f, 0.55));
const gltf = await new GLTFLoader().loadAsync("/out/" + file);
const root = gltf.scene;
const mats: string[] = [];
root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { const m = o as THREE.Mesh; m.castShadow = m.receiveShadow = true;
  const mat = m.material as THREE.MeshStandardMaterial;
  /* The game's rule (sceneDressing.ts): the Blender names of the mesh and its ancestors - GLTFLoader strips the dots
     from `name` and keeps the original in userData.name, and the optimiser can leave the mesh on an unnamed child. */
  const names: string[] = []; for (let p: THREE.Object3D | null = m; p; p = p.parent) { const n = (p.userData.name as string | undefined) ?? p.name; if (n) names.push(n); }
  const decal = names.some((n) => /\.moss\.shadow$/.test(n));
  if (decal) m.castShadow = false; /* the leaves cast (since 2026-09-30); the shadow decal does not */
  if (mossBias && !decal && names.some((n) => /\.moss$/.test(n))) wearMossShadowBias(mat);
  mats.push(`${m.name}: alphaTest=${mat.alphaTest} transparent=${mat.transparent} side=${mat.side} vertexColors=${mat.vertexColors} map=${mat.map ? mat.map.image.width : "none"}`); } });
scene.add(root);
if (q.get("ground") === "1") { // a floor under the rock: the rock's own shadow on it says whether the sun shadows at all
  const g = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: 0x8a8a80 }));
  g.rotation.x = -Math.PI / 2; g.position.y = -0.62; g.receiveShadow = true; scene.add(g);
}
console.log("materials\n" + mats.join("\n"));
let views = [
  { pos: [-0.3, 0.75, 3.5], look: [0, 0.1, 0] },     // the game's view: side-on, a little above
  { pos: [-0.25, 0.55, 2.1], look: [0, 0.15, 0] },   // close
  { pos: [-0.3, -1.1, 3.0], look: [0, -0.05, 0] },   // from below, like reference 2
];
if (q.get("fit") === "1") { // frame whatever was loaded (a rock exported from a level is not at the origin, nor 1 m)
  const bb = new THREE.Box3().setFromObject(root); const c = bb.getCenter(new THREE.Vector3()); const s = bb.getSize(new THREE.Vector3()).length();
  views = views.map((v) => ({ pos: [c.x + v.pos[0]! * s / 1.5, c.y + v.pos[1]! * s / 1.5, c.z + v.pos[2]! * s / 1.5], look: [c.x + v.look[0]! * s, c.y + v.look[1]! * s, c.z + v.look[2]! * s] }));
  sun.shadow.camera.far = 500;
}
const cam = new THREE.PerspectiveCamera(32, (W / 3) / H, 0.05, 50);
function drawViews() {
  views.forEach((v, i) => {
    cam.position.set(v.pos[0]!, v.pos[1]!, v.pos[2]!); cam.lookAt(v.look[0]!, v.look[1]!, v.look[2]!);
    renderer.setViewport(i * W / 3, 0, W / 3, H); renderer.setScissor(i * W / 3, 0, W / 3, H);
    renderer.render(scene, cam);
  });
}
drawViews();
console.log("shadow " + JSON.stringify({ enabled: renderer.shadowMap.enabled, type: renderer.shadowMap.type, map: !!sun.shadow.map, mapSize: sun.shadow.mapSize.toArray(), cam: [sun.shadow.camera.near, sun.shadow.camera.far, sun.shadow.camera.left, sun.shadow.camera.right], bias: sun.shadow.bias, normalBias: sun.shadow.normalBias, radius: sun.shadow.radius, casters: (() => { let n = 0; scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.castShadow) n++; }); return n; })() }));
console.log("info " + JSON.stringify({ calls: renderer.info.render.calls / 3, triangles: renderer.info.render.triangles / 3, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries }));
// a cheap stress figure: 36 copies in view, average frame time (software GL here, so only relative)
const grid = new THREE.Group();
for (let i = 0; i < 36; i++) { const c = root.clone(); c.position.set((i % 6 - 2.5) * 1.6, 0, -Math.floor(i / 6) * 1.6 - 1); grid.add(c); }
scene.add(grid); root.visible = false;
cam.position.set(0, 4, 9); cam.lookAt(0, 0, -4); renderer.setViewport(0, 0, W, H); renderer.setScissor(0, 0, W, H);
renderer.render(scene, cam);
const t0 = performance.now(); const N = 8;
for (let i = 0; i < N; i++) renderer.render(scene, cam);
renderer.getContext().finish();
console.log("stress " + JSON.stringify({ copies: 36, triangles: renderer.info.render.triangles, calls: renderer.info.render.calls, msPerFrame: (performance.now() - t0) / N }));
scene.remove(grid); root.visible = true; drawViews();
window.shotReady = true;
