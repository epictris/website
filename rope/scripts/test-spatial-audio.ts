import { strict as assert } from "node:assert";
import { Vec2 } from "../src/engine/vec2";
import * as THREE from "three";
import { syncCamera, fovFromFocalLength, cameraDistance } from "../src/render3d/space";
import { cameraListener, setListenerPose, soundPosition, setSpatialPosition, makeSpatialPanner } from "../src/audio/spatialAudio";
import type { Camera } from "../src/render/camera";

const camera: Camera = { position: new Vec2(40, 8), zoom: 2, viewportWidth: 960, viewportHeight: 540 };
const rendered = new THREE.PerspectiveCamera();
syncCamera(rendered, camera, { fovYDeg: fovFromFocalLength(70), zOffset: 0 });
rendered.updateMatrixWorld(true);
const listener = cameraListener(camera, rendered);
assert.equal(listener.z, rendered.position.z, "listener uses actual 70 mm camera depth, not a viewport multiplier");
assert.ok(listener.z > 1.4 * halfHeightEstimate(camera), "the level's 70 mm lens stands farther back than the former estimate");
function halfHeightEstimate(c: Camera) { return c.viewportHeight / (2 * c.zoom * 100) * 4; }
assert.equal(cameraListener(camera).z, cameraDistance(camera), "canvas fallback shares renderer's default lens derivation");
const origin = soundPosition(camera.position);
assert.equal(origin.x - listener.x, 0, "camera centre is horizontally centred even far from world origin");
assert.equal(origin.y - listener.y, 0, "camera centre has no elevation offset");
assert.ok(origin.z < listener.z, "the level is in front of the listener");
assert.ok(soundPosition({ x: 41, y: 8 }).x > listener.x, "world-right sounds right");
assert.ok(soundPosition({ x: 39, y: 8 }).x < listener.x, "world-left sounds left");
assert.ok(soundPosition({ x: 40, y: 7 }).y > listener.y, "world-up sounds above");
assert.ok(soundPosition({ x: 40, y: 9 }).y < listener.y, "world-down sounds below");
const shifted = cameraListener({ ...camera, position: new Vec2(42, 10) });
assert.ok(origin.x - shifted.x < 0, "moving camera right puts a fixed source to the left");
assert.ok(origin.y - shifted.y > 0, "moving camera down puts a fixed source above");
const bothShifted = soundPosition({ x: 42, y: 10 });
assert.equal(bothShifted.x - shifted.x, origin.x - listener.x, "moving camera and source equally preserves direction");
assert.equal(bothShifted.y - shifted.y, origin.y - listener.y);
const halfWidth = camera.viewportWidth / (2 * camera.zoom * 100);
const halfHeight = camera.viewportHeight / (2 * camera.zoom * 100);
assert.ok(Math.atan2(halfWidth, listener.z) < Math.PI / 6, "screen edge stays within a gentle 30 degree azimuth");
assert.ok(Math.atan2(halfHeight, listener.z) < Math.PI / 12, "vertical screen edge has subtle elevation");
assert.equal(cameraListener({ ...camera, zoom: 4 }).z, cameraListener(camera).z / 2, "zoom changes listener depth consistently with the view");

const calls: [string, number, number, number?][] = [];
const param = (axis: string) => ({
  setValueAtTime(value: number, time: number) { calls.push([axis, value, time]); return this; },
  setTargetAtTime(value: number, time: number, follow: number) { calls.push([axis, value, time, follow]); return this; },
}) as AudioParam;
const node = { positionX: param("x"), positionY: param("y"), positionZ: param("z") };
setSpatialPosition(node, listener, 1);
assert.deepEqual(calls, [["x", 40, 1], ["y", -8, 1], ["z", listener.z, 1]], "initial listener placement has no sweep from the world origin");
calls.length = 0;
setSpatialPosition(node, shifted, 2, true);
assert.deepEqual(calls, [["x", 42, 2, 0.025], ["y", -10, 2, 0.025], ["z", shifted.z, 2, 0.025]], "ongoing camera motion updates all axes smoothly");
const panner = { ...node, panningModel: "equalpower", rolloffFactor: 1 };
calls.length = 0;
makeSpatialPanner({ createPanner: () => panner, currentTime: 0.5 } as unknown as AudioContext, { x: 40, y: 8 });
assert.deepEqual(calls, [["x", 40, 0.5], ["y", -8, 0.5], ["z", 0, 0.5]], "panners initialize at creation time, before a short source starts");
assert.equal(panner.panningModel, "HRTF", "elevation uses spatial audio rather than invented stereo/volume offsets");
assert.equal(panner.rolloffFactor, 0, "camera position and zoom do not change event loudness");
console.log("PASS: camera-relative world-space direction, elevation, gentle spread, zoom, smooth listener updates and stable levels");

// Nondefault lenses, authored z offsets and orbits all come from the rendered
// camera's matrix, including its orientation rather than assuming head-on.
syncCamera(rendered, camera, { fovYDeg: fovFromFocalLength(100), zOffset: 3 }, { yaw: 0.4, pitch: 0.2 });
rendered.updateMatrixWorld(true);
const orbited = cameraListener(camera, rendered);
assert.equal(orbited.x, rendered.position.x);
assert.equal(orbited.y, rendered.position.y);
assert.equal(orbited.z, rendered.position.z);
const forward = rendered.getWorldDirection(new THREE.Vector3());
assert.ok(Math.abs(orbited.forward.x - forward.x) < 1e-12);
assert.ok(Math.abs(orbited.forward.y - forward.y) < 1e-12);
assert.ok(Math.abs(orbited.forward.z - forward.z) < 1e-12);
calls.length = 0;
const listenerNode = { ...node, forwardX: param("fx"), forwardY: param("fy"), forwardZ: param("fz"),
  upX: param("ux"), upY: param("uy"), upZ: param("uz") } as AudioListener;
setListenerPose(listenerNode, orbited, 3);
assert.equal(calls.length, 9, "actual camera pose sets all position, forward and up axes");
assert.ok(calls.every(c => c.length === 3), "the listener follows the already-eased rendered camera without a second lag");
console.log("PASS: actual rendered lens/depth/z-offset/orbit, listener orientation and exact camera tracking");
