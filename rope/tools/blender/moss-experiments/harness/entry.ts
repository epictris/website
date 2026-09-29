import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
declare global { interface Window { shotReady?: boolean } }
const q = new URLSearchParams(location.search);
const file = q.get("glb") ?? "d_hybrid.glb";
const W = 1500, H = 500;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H); renderer.setScissorTest(true);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.style.margin = "0"; document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x294859);
const sun = new THREE.DirectionalLight(0xffd9a3, 2.3); sun.position.set(-1.5, 2.2, 2.0); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = sun.shadow.camera.bottom = -1.5; sun.shadow.camera.right = sun.shadow.camera.top = 1.5;
sun.shadow.normalBias = 0.06; sun.shadow.bias = -0.0002; scene.add(sun);
scene.add(new THREE.HemisphereLight(0x7fa6cc, 0x22301f, 0.55));
const gltf = await new GLTFLoader().loadAsync("/out/" + file);
const root = gltf.scene;
const mats: string[] = [];
root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { const m = o as THREE.Mesh; m.castShadow = m.receiveShadow = true;
  const mat = m.material as THREE.MeshStandardMaterial; if (mat.alphaTest > 0 || /^moss/.test(m.name)) m.castShadow = false; /* alpha-cut cards cast no shadow (glTF has no flag for it; the game sets it on load) */ mats.push(`${m.name}: alphaTest=${mat.alphaTest} transparent=${mat.transparent} side=${mat.side} vertexColors=${mat.vertexColors} map=${mat.map ? mat.map.image.width : "none"}`); } });
scene.add(root);
console.log("materials\n" + mats.join("\n"));
const views = [
  { pos: [-0.3, 0.75, 3.5], look: [0, 0.1, 0] },     // the game's view: side-on, a little above
  { pos: [-0.25, 0.55, 2.1], look: [0, 0.15, 0] },   // close
  { pos: [-0.3, -1.1, 3.0], look: [0, -0.05, 0] },   // from below, like reference 2
];
const cam = new THREE.PerspectiveCamera(32, (W / 3) / H, 0.05, 50);
function drawViews() {
  views.forEach((v, i) => {
    cam.position.set(v.pos[0]!, v.pos[1]!, v.pos[2]!); cam.lookAt(v.look[0]!, v.look[1]!, v.look[2]!);
    renderer.setViewport(i * W / 3, 0, W / 3, H); renderer.setScissor(i * W / 3, 0, W / 3, H);
    renderer.render(scene, cam);
  });
}
drawViews();
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
