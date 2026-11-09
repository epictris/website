import type { Camera } from "../render/camera";
import { cameraDistance } from "../render3d/space";

export interface SoundPosition { x: number; y: number }
export interface AudioPosition { x: number; y: number; z: number }
export interface AudioCamera { matrixWorld: { elements: ArrayLike<number> } }
export interface ListenerPose extends AudioPosition { forward: AudioPosition; up: AudioPosition }

// Gameplay coordinates have +y down; Web Audio has +y up. Sources remain in
// world space while the listener follows the camera, including during tails.
export function soundPosition(point: SoundPosition): AudioPosition {
  return { x: point.x, y: -point.y, z: 0 };
}

export function cameraListener(camera: Camera, rendered?: AudioCamera | null): ListenerPose {
  if (rendered) {
    const m = rendered.matrixWorld.elements;
    return { x: m[12]!, y: m[13]!, z: m[14]!,
      forward: { x: -m[8]!, y: -m[9]!, z: -m[10]! },
      up: { x: m[4]!, y: m[5]!, z: m[6]! } };
  }
  // Canvas fallback uses the renderer's default lens derivation. The 3D
  // path always supplies the actual rendered camera, including lens/z offset.
  return { x: camera.position.x, y: -camera.position.y, z: cameraDistance(camera),
    forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } };
}

export function setListenerPose(listener: AudioListener, pose: ListenerPose, at: number): void {
  // The camera already eases its motion. Follow its exact rendered pose;
  // another audio-only ease makes sources lag behind their visible position.
  setSpatialPosition(listener, pose, at);
  for (const [param, value] of [
    [listener.forwardX, pose.forward.x], [listener.forwardY, pose.forward.y], [listener.forwardZ, pose.forward.z],
    [listener.upX, pose.up.x], [listener.upY, pose.up.y], [listener.upZ, pose.up.z],
  ] as const) param.setValueAtTime(value, at);
}

export function setSpatialPosition(
  node: { positionX: AudioParam; positionY: AudioParam; positionZ: AudioParam },
  position: AudioPosition, at: number, smooth = false,
): void {
  for (const [param, value] of [[node.positionX, position.x], [node.positionY, position.y], [node.positionZ, position.z]] as const) {
    if (smooth) param.setTargetAtTime(value, at, 0.025);
    else param.setValueAtTime(value, at);
  }
}

export function makeSpatialPanner(ctx: BaseAudioContext, initialPosition: SoundPosition): PannerNode {
  const panner = ctx.createPanner();
  panner.panningModel = "HRTF";
  // Event strength owns loudness. This change only places sources relative
  // to the camera, without adding zoom-dependent volume attenuation.
  panner.rolloffFactor = 0;
  // HRTF changes direction by crossfading. A short impact must never spend
  // its attack at the default origin while waiting for a scheduled position.
  setSpatialPosition(panner, soundPosition(initialPosition), ctx.currentTime);
  return panner;
}
