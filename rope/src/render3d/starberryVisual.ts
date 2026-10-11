import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import type { VineCord } from "../level/vines";
import { restStarberries } from "../level/starberry";
import { threeY } from "./space";
import { StarberryChime } from "./starberryChime";
import { leafDepth, naturalStemPoint, starberryLeaves, stemFraction, type LeafFootprint } from "../render/starberryArt";

// Broad, broken pigment marks, rather than a glossy uniform plastic surface.
function pigmentTexture(woody = false): THREE.DataTexture {
  const width = 64, height = 128, pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const cellX = Math.floor(x / (woody ? 5 : 9)), cellY = Math.floor(y / 15);
    const n = Math.sin(cellX * 73.7 + cellY * 19.3) * 43758.5;
    const stroke = n - Math.floor(n);
    const grain = Math.sin(x * 2.7 + y * 0.8) * 0.025;
    const tone = 0.7 + stroke * 0.25 + grain;
    const at = (y * width + x) * 4;
    pixels[at] = Math.round(255 * tone);
    pixels[at + 1] = Math.round(255 * tone);
    pixels[at + 2] = Math.round(245 * tone);
    pixels[at + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}

function heartGeometry(): THREE.BufferGeometry {
  const outline = new THREE.Shape();
  outline.moveTo(0, 0.13);
  outline.bezierCurveTo(-0.26, -0.12, -0.58, 0.1, -0.46, 0.43);
  outline.bezierCurveTo(-0.36, 0.71, -0.11, 0.82, 0, 1);
  outline.bezierCurveTo(0.12, 0.8, 0.38, 0.68, 0.46, 0.43);
  outline.bezierCurveTo(0.58, 0.1, 0.26, -0.12, 0, 0.13);
  const boundary = outline.getPoints(7);
  const positions: number[] = [], colors: number[] = [], uv: number[] = [];
  for (let i = 0; i < boundary.length - 1; i++) {
    const a = boundary[i]!, b = boundary[i + 1]!;
    for (const [x, y, z, tone] of [[0, 0.43, 0.055, 1],
      [a.x, a.y, -0.05 * a.y * a.y, 0.83], [b.x, b.y, -0.05 * b.y * b.y, 0.83]]) {
      positions.push(x!, y!, z!); colors.push(tone!, tone!, tone!);
      uv.push(x! + 0.5, y!);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  return geometry;
}

function fruitGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const points: THREE.Vector2[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.53 : 0.92;
    points.push(new THREE.Vector2(Math.cos(angle) * r, Math.sin(angle) * r));
  }
  const start = points[9]!.clone().lerp(points[0]!, 0.78);
  shape.moveTo(start.x, start.y);
  for (let i = 0; i < 10; i++) {
    const p = points[i]!, next = points[(i + 1) % 10]!;
    const end = p.clone().lerp(next, 0.22), before = p.clone().lerp(next, 0.78);
    shape.quadraticCurveTo(p.x, p.y, end.x, end.y);
    shape.lineTo(before.x, before.y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: true,
    bevelThickness: 0.16, bevelSize: 0.07, bevelSegments: 3, steps: 1, curveSegments: 4 });
  g.translate(0, 0, -0.15);
  g.computeVertexNormals();
  return g;
}

interface Plant {
  group: THREE.Group;
  leaves: THREE.InstancedMesh;
  veins: THREE.InstancedMesh;
  stems: THREE.InstancedMesh;
  fruit: THREE.Mesh[];
  halos: THREE.Mesh[];
  materials: THREE.MeshStandardMaterial[];
  light: THREE.PointLight;
  pulse: number[];
  held: boolean[];
}

/** Shared geometry, instanced foliage; all interactive motion comes from physics. */
export class StarberryLayer {
  private chime: StarberryChime | null = null;
  private readonly plants: Plant[] = [];
  private readonly leafGeometry = heartGeometry();
  private readonly fruitGeometry = fruitGeometry();
  private readonly stemGeometry = new THREE.CylinderGeometry(1, 1, 1, 6);
  private readonly haloGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly leafPigment = pigmentTexture();
  private readonly stemPigment = pigmentTexture(true);
  private readonly leafMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff,
    map: this.leafPigment, vertexColors: true, roughness: 0.94, side: THREE.DoubleSide });
  private readonly stemMaterial = new THREE.MeshStandardMaterial({ color: 0x6b6842,
    map: this.stemPigment, roughness: 0.98 });
  private readonly veinMaterial = new THREE.MeshStandardMaterial({ color: 0x738150, roughness: 0.96 });
  private readonly haloMaterial = new THREE.ShaderMaterial({
    uniforms: { strength: { value: 1 } }, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 uvHalo; void main(){uvHalo=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec2 uvHalo; uniform float strength;
      void main(){float r=length(uvHalo-.5)*2.; float a=pow(max(0.,1.-r),2.4);
      gl_FragColor=vec4(1.,.53,.055,a*.8*strength);}`,
  });
  private readonly path: Vec2[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();
  private readonly occupied: LeafFootprint[] = [];

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
    const leaves = this.instances(this.leafGeometry, this.leafMaterial, 512);
    const veins = this.instances(this.stemGeometry, this.veinMaterial, 512);
    const stems = this.instances(this.stemGeometry, this.stemMaterial, 1024);
    // One local light per plant, following the fruit closest to the player.
    const light = new THREE.PointLight(0xffb52e, 0, 1.25, 2);
    group.add(leaves, veins, stems, light); this.scene.add(group);
    return { group, leaves, veins, stems, light, fruit: [], halos: [], materials: [], pulse: [], held: [] };
  }

  private segment(mesh: THREE.InstancedMesh, index: number, a: THREE.Vector3, b: THREE.Vector3, radius: number): void {
    this.direction.subVectors(b, a);
    const length = this.direction.length();
    this.dummy.position.addVectors(a, b).multiplyScalar(0.5);
    this.dummy.quaternion.setFromUnitVectors(this.up, this.direction.normalize());
    this.dummy.scale.set(radius, length * 1.08, radius); this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }

  sync(vines: readonly VineCord[], alpha: number, ball?: { position: Vec2; radius: number }): void {
    let index = 0;
    this.occupied.length = 0;
    const time = performance.now() / 1000;
    for (const vine of vines) {
      if (!vine.starberry) continue;
      this.chime ??= new StarberryChime();
      const plant = this.plants[index] ?? (this.plants[index] = this.create()); index++;
      plant.group.visible = true;
      vine.path(alpha, this.path);
      if (this.path.length < 2) { plant.group.visible = false; continue; }
      const settings = vine.starberry;
      const berries = vine.berryPoses?.(alpha) ?? restStarberries(this.path, settings);
      let stems = 0, leaves = 0, length = 0;
      for (let i = 1; i < this.path.length; i++) length += this.path[i]!.distanceTo(this.path[i - 1]!);
      const segments = Math.min(350, Math.max(8, Math.ceil(length / 0.045)));
      const stem3 = (fraction: number, out: THREE.Vector3) => {
        const p = naturalStemPoint(this.path, fraction, settings.seed);
        return out.set(p.x, threeY(p.y), -0.025 * Math.sin(fraction * 17));
      };
      for (let i = 0; i < segments; i++) {
        const f = (i + 0.5) / segments;
        stem3(i / segments, this.a); stem3((i + 1) / segments, this.b);
        const radius = (0.041 - f * 0.024) * (1 + Math.sin(f * 47 + settings.seed) * 0.12);
        this.segment(plant.stems, stems++, this.a, this.b, radius);
      }
      const lastGrab = plant.pulse.reduce((latest, pulse) => Math.max(latest, pulse ?? -100), -100);
      const shiver = Math.max(0, 1 - (time - lastGrab) / 0.65);
      const foliage = starberryLeaves(this.path, settings, berries, this.occupied);
      const depth = leafDepth(ball?.radius ?? 0.22, settings.radius);
      for (const [i, leaf] of foliage.entries()) {
        const { variation, size, base, root, angle } = leaf;
        const flutter = Math.sin(time * 1.6 + i * 2.4) * 0.025 + Math.sin(time * 19 - i) * shiver * 0.04;
        this.a.set(root.x, threeY(root.y), 0); this.b.set(base.x, threeY(base.y), depth);
        this.segment(plant.stems, stems++, this.a, this.b, 0.0045);
        this.dummy.position.copy(this.b);
        this.dummy.rotation.set((variation - 0.5) * 0.25 + flutter, 0.12 * Math.sin(i), Math.PI + angle);
        this.dummy.scale.set(size, size, size); this.dummy.updateMatrix();
        plant.leaves.setMatrixAt(leaves, this.dummy.matrix);
        this.color.setHSL(0.22 + variation * 0.055, 0.24 + variation * 0.12, 0.23 + variation * 0.075);
        plant.leaves.setColorAt(leaves, this.color);
        this.a.set(0, 0.15, 0.07).applyMatrix4(this.dummy.matrix);
        this.b.set(0, 0.82, 0.015).applyMatrix4(this.dummy.matrix);
        this.segment(plant.veins, leaves++, this.a, this.b, 0.0012);
      }
      for (let i = 0; i < berries.length; i++) {
        const berry = berries[i]!;
        if (!plant.fruit[i]) {
          const material = new THREE.MeshStandardMaterial({ color: 0xeaaa32, emissive: 0xffb52c,
            emissiveIntensity: 1.6, roughness: 0.64, metalness: 0.04 });
          const mesh = new THREE.Mesh(this.fruitGeometry, material); mesh.castShadow = true;
          const halo = new THREE.Mesh(this.haloGeometry, this.haloMaterial.clone());
          plant.group.add(mesh, halo); plant.fruit.push(mesh); plant.halos.push(halo); plant.materials.push(material);
        }
        if (berry.held && !plant.held[i]) { plant.pulse[i] = time; this.chime.play(); }
        plant.held[i] = berry.held;
        const pulse = Math.max(0, 1 - (time - (plant.pulse[i] ?? -100)) / 0.55);
        const mesh = plant.fruit[i]!, halo = plant.halos[i]!;
        mesh.visible = halo.visible = true;
        mesh.position.set(berry.fruit.x, threeY(berry.fruit.y), 0);
        mesh.scale.setScalar(settings.radius);
        mesh.rotation.z = -Math.atan2(berry.fruit.x - berry.joint.x, berry.fruit.y - berry.joint.y) * 0.25;
        plant.materials[i]!.emissiveIntensity = settings.glow * (1.6 + pulse * 0.8 + (berry.held ? 0.2 : 0));
        halo.position.copy(mesh.position); halo.position.z = -0.04;
        halo.scale.setScalar(settings.radius * (5.8 + pulse * 0.5));
        (halo.material as THREE.ShaderMaterial).uniforms.strength!.value = settings.glow * (1 + pulse);
        const root = stem3(stemFraction(this.path, berry.root), new THREE.Vector3());
        const end = mesh.position.clone().lerp(root, Math.min(0.7, settings.radius * 0.45 / Math.max(0.001, root.distanceTo(mesh.position))));
        const side = i % 2 ? 1 : -1;
        const control1 = root.clone().lerp(end, 0.25).add(new THREE.Vector3(side * 0.025, 0.055, -0.025));
        const control2 = end.clone().lerp(root, 0.2).add(new THREE.Vector3(-side * 0.015, 0.045, -0.015));
        const curve = new THREE.CubicBezierCurve3(root, control1, control2, end);
        for (let j = 0; j < 9; j++) {
          curve.getPoint(j / 9, this.a); curve.getPoint((j + 1) / 9, this.b);
          this.segment(plant.stems, stems++, this.a, this.b, 0.032 - j * 0.0014);
        }
      }
      const nearest = berries.reduce<typeof berries[number] | undefined>((best, b) =>
        !best || (ball && b.fruit.distanceTo(ball.position) < best.fruit.distanceTo(ball.position)) ? b : best, undefined);
      if (nearest) plant.light.position.set(nearest.fruit.x, threeY(nearest.fruit.y), 0.18);
      plant.light.intensity = nearest && ball ? settings.glow * 0.55
        * THREE.MathUtils.clamp((1.6 - nearest.fruit.distanceTo(ball.position)) / 0.6, 0, 1) : 0;
      for (let i = berries.length; i < plant.fruit.length; i++) {
        plant.fruit[i]!.visible = plant.halos[i]!.visible = false;
      }
      plant.stems.count = stems; plant.leaves.count = plant.veins.count = leaves;
      for (const mesh of [plant.stems, plant.leaves, plant.veins]) mesh.instanceMatrix.needsUpdate = true;
      if (plant.leaves.instanceColor) plant.leaves.instanceColor.needsUpdate = true;
    }
    for (let i = index; i < this.plants.length; i++) this.plants[i]!.group.visible = false;
  }

  hide(): void { for (const p of this.plants) p.group.visible = false; }
  dispose(): void {
    this.chime?.dispose();
    for (const p of this.plants) {
      this.scene.remove(p.group);
      p.leaves.dispose(); p.veins.dispose(); p.stems.dispose();
      for (const m of p.materials) m.dispose();
      for (const h of p.halos) (h.material as THREE.Material).dispose();
    }
    for (const g of [this.leafGeometry, this.fruitGeometry, this.stemGeometry, this.haloGeometry]) g.dispose();
    this.leafMaterial.dispose(); this.stemMaterial.dispose(); this.veinMaterial.dispose(); this.haloMaterial.dispose();
    this.leafPigment.dispose(); this.stemPigment.dispose();
  }
}
