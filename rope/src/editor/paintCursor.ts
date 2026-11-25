// The paint brush's cursor (moss, ivy): where the next dab would land, drawn
// under the pointer while a painted kind is armed or its brush is on.
//
// Two parts, both in the formation's frame (the strokes' frame):
// - the RING, as the Blender stamp brush draws it (stampbrush/brush.py,
//   `_draw` and `circle`): the brush's radius on the plane facing the
//   surface's normal, lifted a hair off it, green to paint and red to erase,
//   drawn with no depth test, since on a bumpy face half of it would sink out
//   of sight;
// - the FOOTPRINT: the rock's sample points the dab reaches (`RockSamples`,
//   the coverage's own points), each as strong as the weight the dab lays
//   there. So the region under the ring is the paint's, not a disc's: it
//   wraps over an edge, and leaves out a face turned away from the dab, as
//   the paint does.

import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { RockSamples } from "./paintCoverage";

// stampbrush/brush.py: COLOR, ERASE_COLOR and the ring's 2 px width.
const PAINT = new THREE.Color(0.7, 1.0, 0.35);
const ERASE = new THREE.Color(1.0, 0.35, 0.3);
const RING_OPACITY = 0.9;
const RING_PX = 2;
const RING_SEGMENTS = 48;
// The footprint's dots: the coverage's size, and their opacity at full weight.
const DOT_PX = 3;
const DOT_OPACITY = 0.9;
// Over the coverage's dots (decorationPanel's preview, 12) and the rock.
const RENDER_ORDER = 40;

export interface BrushAt {
  // The formation's frame in the world, and the dab in it.
  frame: THREE.Matrix4;
  p: THREE.Vector3;
  n: THREE.Vector3;
  r: number;
  erase: boolean;
  // The rock's samples, or null while it has not loaded (the ring alone).
  samples: RockSamples | null;
}

export class PaintCursor {
  readonly object = new THREE.Group();
  private readonly ring: Line2;
  private readonly ringMaterial = new LineMaterial({
    linewidth: RING_PX,
    transparent: true,
    opacity: RING_OPACITY,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  private readonly dots: THREE.Points;
  private readonly dotsMaterial = new THREE.PointsMaterial({
    size: DOT_PX,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });

  constructor() {
    this.object.name = "paint-cursor";
    // A group's order sorts its children against other groups' (three's
    // groupOrder): without it the coverage's group (12) draws over the
    // footprint, and an erase hid what it would clear under the green.
    this.object.renderOrder = RENDER_ORDER;
    this.object.matrixAutoUpdate = false;
    this.object.visible = false;
    const geo = new LineGeometry();
    const circle: number[] = [];
    for (let k = 0; k <= RING_SEGMENTS; k++) {
      const t = (k / RING_SEGMENTS) * Math.PI * 2;
      circle.push(Math.cos(t), Math.sin(t), 0);
    }
    geo.setPositions(circle);
    this.ring = new Line2(geo, this.ringMaterial);
    this.ring.computeLineDistances();
    this.dots = new THREE.Points(new THREE.BufferGeometry(), this.dotsMaterial);
    for (const o of [this.ring, this.dots]) {
      o.raycast = () => {};
      o.renderOrder = RENDER_ORDER;
      o.frustumCulled = false;
    }
    this.object.add(this.dots, this.ring);
  }

  // Draw the brush at `at`, or hide it.
  set(at: BrushAt | null): void {
    if (!at) {
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.matrix.copy(at.frame);
    this.object.matrixWorldNeedsUpdate = true;
    const colour = at.erase ? ERASE : PAINT;
    this.ringMaterial.color.copy(colour);
    const n = at.n.clone().normalize();
    // stampbrush's lift: a fiftieth of the radius, at most 5 mm.
    this.ring.position.copy(at.p).addScaledVector(n, Math.min(at.r * 0.02, 0.005));
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.ring.scale.setScalar(at.r);
    this.setFootprint(at, colour, n);
  }

  // The footprint's points, built afresh per move (a buffer that changes
  // length after upload is not something WebGL resizes).
  private setFootprint(at: BrushAt, colour: THREE.Color, n: THREE.Vector3): void {
    const positions: number[] = [];
    const colours: number[] = [];
    const samples = at.samples;
    if (samples) {
      const pts = samples.points;
      samples.reach({ p: [at.p.x, at.p.y, at.p.z], n: [n.x, n.y, n.z], r: at.r }, (i, w) => {
        positions.push(pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!);
        colours.push(colour.r, colour.g, colour.b, w * DOT_OPACITY);
      });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(colours, 4));
    this.dots.geometry.dispose();
    this.dots.geometry = g;
  }

  // The footprint's point count, for the cases.
  get footprint(): number {
    return this.dots.geometry.getAttribute("position")?.count ?? 0;
  }

  // Placed every frame by its owner: a 3D body's depth and tilt move the
  // formation with no pointer move.
  setFrame(frame: THREE.Matrix4): void {
    this.object.matrix.copy(frame);
    this.object.matrixWorldNeedsUpdate = true;
  }
}
