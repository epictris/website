// The glass ball's broken pieces in 3D: every chunk `render/glassShards.ts` is
// carrying, in quartz: solid chunks, or shards of a hollow ball's wall.
//
// One `BatchedMesh` for the lot: a break is a few dozen pieces, each of its
// own shape (render/glassFracture.ts), and what changes per piece from frame to
// frame is only its transform. Every shape any break can throw is added to the
// batch once, when the pieces are cut (as the level loads), so a break uploads
// no geometry; a chunk is an instance of its shape.
//
// A piece is seen through (glassMaterial.ts "PIECES"): two batches of the same
// pieces, the frame behind multiplied by what each face passes, then each
// face's light added - with the aurora film where the ball's surface was and
// bare quartz on every broken face (`coatNm`).

import * as THREE from "three";
import type { GlassShards } from "../render/glassShards";
import { PIECE_LIGHT_ORDER, PIECE_TRANSMIT_ORDER, pieceGlassMaterial, setPieceSlabs } from "./glassMaterial";
import { setProbe } from "./reflectionProbe";

export class ShardLayer {
  // The light batch; `through` is the transmit batch, instance for instance.
  private mesh: THREE.BatchedMesh | null = null;
  private through: THREE.BatchedMesh | null = null;
  private readonly material = pieceGlassMaterial("light");
  private readonly transmit = pieceGlassMaterial("transmit");
  private geometryIds: number[] = [];
  private instances: number[] = [];
  private builtFor = -1;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly fade = new THREE.Color();
  // Set by `Scene3D.prewarm` around its compile (see `sync`).
  prewarming = false;

  constructor(private readonly scene: THREE.Scene) {}

  // Lay this frame's chunks.
  sync(shards: GlassShards | null): void {
    if (shards && shards.piecesVersion !== this.builtFor) this.build(shards);
    const mesh = this.mesh;
    const through = this.through;
    if (!mesh || !through) return;
    const chunks = shards?.chunks ?? [];
    let i = 0;
    for (const c of chunks) {
      let id = this.instances[i];
      const geometry = this.geometryIds[c.piece]!;
      if (id === undefined) {
        id = mesh.addInstance(geometry);
        through.addInstance(geometry);
        this.instances.push(id);
      } else {
        for (const b of [mesh, through]) {
          if (b.getGeometryIdAt(id) !== geometry) b.setGeometryIdAt(id, geometry);
          b.setVisibleAt(id, true);
        }
      }
      this.pos.set(c.x, c.y, c.z);
      this.q.set(c.qx, c.qy, c.qz, c.qw);
      this.m.compose(this.pos, this.q, this.one);
      mesh.setMatrixAt(id, this.m);
      through.setMatrixAt(id, this.m);
      // How much of it is left as it fades away, read by both draws.
      this.fade.setScalar(c.fade);
      mesh.setColorAt(id, this.fade);
      through.setColorAt(id, this.fade);
      i++;
    }
    for (let j = i; j < this.instances.length; j++) {
      mesh.setVisibleAt(this.instances[j]!, false);
      through.setVisibleAt(this.instances[j]!, false);
    }
    // Shown while the scene is prewarmed even with nothing to draw: three
    // compiles only what is visible, and the first break must not be the frame
    // the pieces' programs are built on.
    mesh.visible = through.visible = i > 0 || this.prewarming;
  }

  // Run `draw` with the pieces hidden, and put them back: the probe they
  // reflect is captured from among them (see `Scene3D.captureReflection`).
  withoutShards(draw: () => void): void {
    const shown = this.mesh?.visible ?? false;
    if (this.mesh && this.through) this.mesh.visible = this.through.visible = false;
    try {
      draw();
    } finally {
      if (this.mesh && this.through) this.mesh.visible = this.through.visible = shown;
    }
  }

  // What the pieces reflect and see through: the ball's probe (see
  // `BallVisual.setReflection`), or the room's sky again with null.
  setReflection(texture: THREE.CubeTexture | null): void {
    setProbe(this.material, texture);
    setProbe(this.transmit, texture);
  }

  clear(): void {
    for (const b of [this.mesh, this.through]) {
      if (!b) continue;
      for (const id of this.instances) b.setVisibleAt(id, false);
      b.visible = false;
    }
  }

  dispose(): void {
    this.disposeMesh();
    this.material.dispose();
    this.transmit.dispose();
  }

  // Every shape the pieces can take, in one batch.
  private build(shards: GlassShards): void {
    this.disposeMesh();
    this.builtFor = shards.piecesVersion;
    const pieces = shards.pieces;
    if (pieces.length === 0) return;
    // A hollow ball's shards are plates of its wall, which collide as parts.
    const slabs = pieces.some((p) => p.parts !== undefined);
    setPieceSlabs(this.material, slabs);
    setPieceSlabs(this.transmit, slabs);
    let vertices = 0;
    let indices = 0;
    for (const p of pieces) {
      vertices += p.positions.length / 3;
      indices += p.indices.length;
    }
    const make = (material: THREE.Material, order: number): THREE.BatchedMesh => {
      const mesh = new THREE.BatchedMesh(shards.maxChunks, vertices, indices, material);
      mesh.name = "glass-shards";
      // Glass casts no shadow (see glassMaterial.ts).
      mesh.castShadow = false;
      // Over the opaque scene and the water.
      mesh.renderOrder = order;
      // Culled per piece (`perObjectFrustumCulled`) and never as a whole: the
      // batch's own bounds are measured when it is made, empty, and a shower
      // inside them was culled entire.
      mesh.frustumCulled = false;
      mesh.visible = false;
      return mesh;
    };
    const through = make(this.transmit, PIECE_TRANSMIT_ORDER);
    const mesh = make(this.material, PIECE_LIGHT_ORDER);
    this.geometryIds = pieces.map((p) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(p.normals, 3));
      g.setAttribute("coatNm", new THREE.BufferAttribute(p.coatNm, 1));
      g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      const id = mesh.addGeometry(g);
      if (through.addGeometry(g) !== id) throw new Error("ShardLayer: the two batches numbered a piece differently");
      g.dispose();
      return id;
    });
    // Each shape's bounds, which three works out the first time a batch draws
    // an instance of it - over every vertex, in JavaScript: about 8 ms the
    // first frame the pieces were drawn, three frames after the break, in the
    // pool's mirror (Tris, 2026-10-16: "the frame stutter that occurs after
    // the ball smashes into a surface"). Worked out here, as the level loads.
    const box = new THREE.Box3();
    const sphere = new THREE.Sphere();
    for (const id of this.geometryIds) {
      for (const b of [mesh, through]) {
        b.getBoundingBoxAt(id, box);
        b.getBoundingSphereAt(id, sphere);
      }
    }
    // One instance from the start, hidden, with a colour: the per-piece colour
    // (the fade) is a different program from none, and the prewarm has to
    // compile the one the first break draws with.
    const first = mesh.addInstance(this.geometryIds[0]!);
    through.addInstance(this.geometryIds[0]!);
    this.fade.setScalar(1);
    for (const b of [mesh, through]) {
      b.setColorAt(first, this.fade);
      b.setVisibleAt(first, false);
    }
    this.instances.push(first);
    this.scene.add(through, mesh);
    this.mesh = mesh;
    this.through = through;
  }

  private disposeMesh(): void {
    for (const b of [this.mesh, this.through]) {
      if (!b) continue;
      this.scene.remove(b);
      b.dispose();
    }
    this.mesh = null;
    this.through = null;
    this.geometryIds = [];
    this.instances = [];
  }
}

