// The glass ball's shards in 3D: every piece `render/glassShards.ts` is
// carrying, as one `InstancedMesh` of glass plates.
//
// One mesh for the lot, for the chain layer's reason (see chainVisual.ts): a
// break is a hundred-odd tiny identical objects for a second, and what differs
// per piece is a transform. The plate is the system's own triangle extruded
// through the wall's thickness, so its edge is a facet that catches the light
// as it tumbles - which is most of what a sliver of glass in flight is.

import * as THREE from "three";
import { GlassShards, SHARD_TRIANGLE } from "../render/glassShards";
import { glassMaterial } from "./glassMaterial";
import { setProbe } from "./reflectionProbe";

const CAPACITY = 256;

export class ShardLayer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshPhysicalMaterial;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  // Set by `Scene3D.prewarm` around its compile (see `sync`).
  prewarming = false;

  constructor(private readonly scene: THREE.Scene) {
    // One unit across and one unit thick, centred on its centroid: scaled per
    // piece to its plate and its wall.
    const outline = new THREE.Shape(SHARD_TRIANGLE.map(([x, y]) => new THREE.Vector2(x, y)));
    const prism = new THREE.ExtrudeGeometry(outline, { depth: 1, bevelEnabled: false });
    prism.translate(0, 0, -0.5);
    prism.computeVertexNormals();
    this.geometry = prism;
    // Lit from the ball's reflection probe, like the ball itself: the shards
    // fly from where the probe stands, so what it sees is the room they are
    // in. Without it they reflect the level's sky, whose dark band round the
    // horizon is most of what a tumbling plate faces, and a shower of glass
    // read as dark confetti.
    this.material = glassMaterial(true);
    this.mesh = new THREE.InstancedMesh(prism, this.material, CAPACITY);
    this.mesh.name = "glass-shards";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  // Lay this frame's pieces. The system keeps the sim's frame (y down), and
  // three's is y up: a reflection through the y axis, which turns a rotation
  // about (x, y, z) into one about (-x, y, -z) by the same angle.
  sync(shards: GlassShards | null): void {
    let i = 0;
    for (const s of shards?.shards ?? []) {
      if (i >= CAPACITY) break;
      const k = GlassShards.scaleOf(s);
      if (k <= 0) continue;
      this.pos.set(s.x, -s.y, s.z);
      this.q.set(-s.qx, s.qy, -s.qz, s.qw);
      this.scl.set(s.sx * k, s.sy * k, s.thick);
      this.m.compose(this.pos, this.q, this.scl);
      this.mesh.setMatrixAt(i++, this.m);
    }
    this.mesh.count = i;
    // Shown while the scene is prewarmed even with nothing to draw: three
    // compiles only what is visible, and the first break must not be the frame
    // the shards' program is built on.
    this.mesh.visible = i > 0 || this.prewarming;
    if (i > 0) this.mesh.instanceMatrix.needsUpdate = true;
    // Measured afresh, for depth of field's reach test (see chainVisual.ts).
    this.mesh.boundingSphere = null;
  }

  // Run `draw` with the shards hidden, and put them back: the probe they
  // reflect is captured from among them (see `Scene3D.captureReflection`), and
  // a cube of glass inches from its lens is a reflection of nothing but glass.
  withoutShards(draw: () => void): void {
    const shown = this.mesh.visible;
    this.mesh.visible = false;
    try {
      draw();
    } finally {
      this.mesh.visible = shown;
    }
  }

  // What the shards reflect: the ball's probe (see `BallVisual.setReflection`),
  // or the room's sky again with null.
  setReflection(texture: THREE.CubeTexture | null): void {
    setProbe(this.material, texture);
  }

  clear(): void {
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
