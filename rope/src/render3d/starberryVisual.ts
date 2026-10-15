// Berry vines in the 3D scene (`level/starberry.ts`), ported from karin-lu's
// `add-boulder-and-root-generation` branch and laid out in depth to say what
// can be caught: the cord hangs `BERRY_CORD_DEPTH` behind the gameplay plane,
// one thin woody strand with no leaves; each stalk leaves it reaching FORWARD
// and arrives at its berry in the plane the ball and its chain move in. Only
// the berries are targets, and only they stand where the chain can reach.
//
// Everything interactive follows the physics (the cord's links, each berry's
// stalk joint and berry); the crooked line and the grab pulse are
// presentation only. The berry's light is its own and stays inside it: no
// halo, no light thrown on its surroundings (`roundBerryMaterial`).

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import type { VineCord } from "../level/vines";
import { BERRY_CORD_DEPTH, berrySide, restStarberries } from "../level/starberry";
import { threeY } from "./space";
import {
  berryCapGeometry,
  roundBerryGeometry,
  roundBerryKnot,
  roundBerryMaterial,
  roundBerryTexture,
} from "./roundBerry";
import { makeVineLeafMaterial, makeVineLeafShadowMaterial } from "./vineLeafMaterial";
import {
  BERRY_CORD_COLOR,
  STALK_RADIUS,
  berryCordRadius,
  naturalStemPoint,
  roundBerryAttachment,
  stemFraction,
} from "../render/starberryArt";

// Fine woody grain for the cord and the stalks.
function grainTexture(): THREE.DataTexture {
  const width = 64;
  const height = 128;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = Math.sin(Math.floor(x / 5) * 73.7 + Math.floor(y / 15) * 19.3) * 43758.5;
      const tone = 0.7 + (n - Math.floor(n)) * 0.25 + Math.sin(x * 2.7 + y * 0.8) * 0.025;
      const at = (y * width + x) * 4;
      pixels[at] = Math.round(255 * tone);
      pixels[at + 1] = Math.round(255 * tone);
      pixels[at + 2] = Math.round(245 * tone);
      pixels[at + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// Segments in one stalk's curve.
const STALK_SEGMENTS = 9;

interface Plant {
  group: THREE.Group;
  cord: THREE.InstancedMesh;
  stalks: THREE.InstancedMesh;
  fruit: THREE.Mesh[];
  // Each berry's knot and its cap of leaves (`berryCapGeometry`, its own).
  knots: THREE.Mesh[];
  caps: THREE.Mesh[];
  // The seed the caps were grown from, and each berry's radius when its cap
  // was: a new seed or a resized berry regrows them.
  capSeed: number;
  capRadii: number[];
  materials: THREE.MeshStandardMaterial[];
  // Each berry's light, as its material reads it (`roundBerryMaterial`).
  glows: { value: number }[];
  pulse: number[];
  held: boolean[];
}

// Shared geometry and materials, one instanced group per plant.
export class StarberryLayer {
  private readonly plants: Plant[] = [];
  private readonly berryGeometry = roundBerryGeometry();
  private readonly knotGeometry = roundBerryKnot();
  // The flecks every berry shares, made with the first plant.
  private flecks: THREE.DataTexture | null = null;
  private readonly stemGeometry = new THREE.CylinderGeometry(1, 1, 1, 6);
  private readonly grain = grainTexture();
  // The cord and the stalks: one woody brown, so the stalks read as the
  // vine's own growth and the leaves are the only green.
  private readonly cordMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(BERRY_CORD_COLOR),
    map: this.grain,
    roughness: 0.96,
  });
  // The knot at the top of a berry: the stalk's wood, too small for grain.
  private readonly knotMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(BERRY_CORD_COLOR),
    roughness: 0.96,
  });
  // The cap's leaves: the standard vine's leaf material
  // (`makeVineLeafMaterial`), each leaf's green carried as vertex colour.
  private readonly leafMaterial = Object.assign(makeVineLeafMaterial(), { vertexColors: true });
  private readonly leafDepthMaterial = makeVineLeafShadowMaterial(false);
  private readonly leafDistanceMaterial = makeVineLeafShadowMaterial(true);
  // Scratch, reused every frame.
  private readonly path: Vec2[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly root = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly control1 = new THREE.Vector3();
  private readonly control2 = new THREE.Vector3();
  private readonly curve = new THREE.CubicBezierCurve3();
  private readonly direction = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly scene: THREE.Scene) {}

  private instances(geometry: THREE.BufferGeometry, material: THREE.Material, count: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }

  private create(): Plant {
    const group = new THREE.Group();
    const cord = this.instances(this.stemGeometry, this.cordMaterial, 352);
    const stalks = this.instances(this.stemGeometry, this.cordMaterial, 128);
    group.add(cord, stalks);
    this.scene.add(group);
    return {
      group,
      cord,
      stalks,
      fruit: [],
      knots: [],
      caps: [],
      capSeed: NaN,
      capRadii: [],
      materials: [],
      glows: [],
      pulse: [],
      held: [],
    };
  }

  // Berry `index`'s cap, grown from `seed` for a berry `radius` across.
  private growCap(plant: Plant, index: number, seed: number, radius: number): THREE.Mesh {
    plant.capRadii[index] = radius;
    const cap = plant.caps[index];
    const geometry = berryCapGeometry(seed, index, radius);
    if (cap) {
      cap.geometry.dispose();
      cap.geometry = geometry;
      return cap;
    }
    const mesh = new THREE.Mesh(geometry, this.leafMaterial);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.leafDepthMaterial;
    mesh.customDistanceMaterial = this.leafDistanceMaterial;
    plant.group.add(mesh);
    plant.caps[index] = mesh;
    return mesh;
  }

  // A cylinder from `a` to `b`, written into instance `index` of `mesh`.
  private segment(mesh: THREE.InstancedMesh, index: number, a: THREE.Vector3, b: THREE.Vector3, radius: number): void {
    this.direction.subVectors(b, a);
    const length = this.direction.length();
    this.dummy.position.addVectors(a, b).multiplyScalar(0.5);
    this.dummy.quaternion.setFromUnitVectors(this.up, this.direction.normalize());
    this.dummy.scale.set(radius, length * 1.08, radius);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }

  // Every berry vine on the level, laid this frame. `time` is the scene's
  // clock (seconds) and drives only the grab pulse.
  sync(vines: readonly VineCord[], alpha: number, time: number): void {
    let index = 0;
    for (const vine of vines) {
      if (!vine.starberry) continue;
      vine.path(alpha, this.path);
      if (this.path.length < 2) continue;
      const plant = this.plants[index] ?? (this.plants[index] = this.create());
      index++;
      plant.group.visible = true;
      const settings = vine.starberry;
      const flecks = (this.flecks ??= roundBerryTexture());
      const berries = vine.berryPoses?.(alpha) ?? restStarberries(this.path, settings);

      // The cord, set back behind the plane: one strand along the crooked line.
      let length = 0;
      for (let i = 1; i < this.path.length; i++) length += this.path[i]!.distanceTo(this.path[i - 1]!);
      const segments = Math.min(plant.cord.instanceMatrix.count, Math.max(8, Math.ceil(length / 0.045)));
      const cordPoint = (fraction: number, out: THREE.Vector3): THREE.Vector3 => {
        const p = naturalStemPoint(this.path, fraction, settings.seed);
        return out.set(p.x, threeY(p.y), -BERRY_CORD_DEPTH - 0.025 * Math.sin(fraction * 17));
      };
      for (let i = 0; i < segments; i++) {
        cordPoint(i / segments, this.a);
        cordPoint((i + 1) / segments, this.b);
        this.segment(plant.cord, i, this.a, this.b, berryCordRadius((i + 0.5) / segments, settings.seed));
      }
      plant.cord.count = segments;

      // A new seed regrows every cap.
      const regrow = plant.capSeed !== settings.seed;
      plant.capSeed = settings.seed;

      // The stalks and berries. A stalk leaves the cord heading toward the
      // camera and turns into its berry, which hangs in the plane.
      let stalks = 0;
      for (let i = 0; i < berries.length; i++) {
        const berry = berries[i]!;
        if (!plant.fruit[i]) {
          const { material, glow } = roundBerryMaterial(flecks);
          const mesh = new THREE.Mesh(this.berryGeometry, material);
          mesh.castShadow = true;
          const knot = new THREE.Mesh(this.knotGeometry, this.knotMaterial);
          knot.castShadow = true;
          plant.group.add(mesh, knot);
          plant.fruit.push(mesh);
          plant.knots.push(knot);
          plant.materials.push(material);
          plant.glows.push(glow);
        }
        if (berry.held && !plant.held[i]) plant.pulse[i] = time;
        plant.held[i] = berry.held;
        const pulse = Math.max(0, 1 - (time - (plant.pulse[i] ?? -100)) / 0.55);
        const mesh = plant.fruit[i]!;
        const knot = plant.knots[i]!;
        mesh.visible = knot.visible = true;
        mesh.position.set(berry.fruit.x, threeY(berry.fruit.y), 0);
        mesh.scale.setScalar(berry.radius);
        // The light inside it, as the vine's glow setting says (1.5 is the
        // look as made), brightening a moment when the hook takes it.
        plant.glows[i]!.value = (settings.glow / 1.5) * (1 + pulse * 0.8 + (berry.held ? 0.15 : 0));

        const rootFraction = stemFraction(this.path, berry.root);
        cordPoint(rootFraction, this.root);
        const root2 = naturalStemPoint(this.path, rootFraction, settings.seed);
        const attachment = roundBerryAttachment(root2, berry.fruit, berry.radius);
        this.axis.set(attachment.axis.x, threeY(attachment.axis.y), 0);
        this.end.set(attachment.end.x, threeY(attachment.end.y), 0);
        // The knot on the berry's top, the stalk's own thickness.
        knot.quaternion.setFromUnitVectors(this.up, this.axis);
        knot.position.copy(mesh.position).addScaledVector(this.axis, berry.radius);
        knot.scale.setScalar(STALK_RADIUS);
        mesh.quaternion.copy(knot.quaternion);
        // The cap's leaves, in the berry's own frame.
        const cap =
          regrow || !plant.caps[i] || plant.capRadii[i] !== berry.radius
            ? this.growCap(plant, i, settings.seed, berry.radius)
            : plant.caps[i]!;
        cap.visible = true;
        cap.position.copy(mesh.position);
        cap.quaternion.copy(mesh.quaternion);
        cap.scale.setScalar(berry.radius);
        const side = berrySide(i, settings);
        // Out of the cord square to the plane, then into the berry along its
        // growth axis.
        this.control1
          .copy(this.root)
          .lerp(this.end, 0.25)
          .setZ(this.root.z + BERRY_CORD_DEPTH * 0.75)
          .add(this.a.set(side * 0.025, 0.055, 0));
        this.control2.set(attachment.control.x, threeY(attachment.control.y), 0);
        this.curve.v0.copy(this.root);
        this.curve.v1.copy(this.control1);
        this.curve.v2.copy(this.control2);
        this.curve.v3.copy(this.end);
        for (let j = 0; j < STALK_SEGMENTS && stalks < plant.stalks.instanceMatrix.count; j++) {
          this.curve.getPoint(j / STALK_SEGMENTS, this.a);
          this.curve.getPoint((j + 1) / STALK_SEGMENTS, this.b);
          this.segment(plant.stalks, stalks++, this.a, this.b, STALK_RADIUS * (1 - (0.35 * j) / STALK_SEGMENTS));
        }
      }
      for (let i = berries.length; i < plant.fruit.length; i++) {
        plant.fruit[i]!.visible = plant.knots[i]!.visible = false;
        if (plant.caps[i]) plant.caps[i]!.visible = false;
      }
      plant.stalks.count = stalks;
      plant.cord.instanceMatrix.needsUpdate = true;
      plant.stalks.instanceMatrix.needsUpdate = true;
    }
    for (let i = index; i < this.plants.length; i++) this.plants[i]!.group.visible = false;
  }

  hide(): void {
    for (const p of this.plants) p.group.visible = false;
  }

  dispose(): void {
    for (const p of this.plants) {
      this.scene.remove(p.group);
      p.cord.dispose();
      p.stalks.dispose();
      for (const cap of p.caps) cap.geometry.dispose();
      for (const m of p.materials) m.dispose();
    }
    for (const g of [this.berryGeometry, this.knotGeometry, this.stemGeometry]) g.dispose();
    for (const m of [this.cordMaterial, this.knotMaterial, this.leafMaterial, this.leafDepthMaterial, this.leafDistanceMaterial]) m.dispose();
    this.grain.dispose();
    this.flecks?.dispose();
  }
}
