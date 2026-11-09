// Contact-driven sample events from the cosmetic drape's actual solver.
// No second geometry query and no full-chain landing performance.
import { PhysicsBody2D, type CollisionShape2D } from "../engine/body";
import type { Vec2 } from "../engine/vec2";
import type { DrapeContact } from "../classes/slackChain";
import { surfaceOf, type SurfaceKind } from "./surfaces";

export interface ChainSurfaceCue { speed: number; x: number; y: number; surface: SurfaceKind }
export interface ChainImpactCue extends ChainSurfaceCue { at?: number }

export class ChainSurfaceAudio {
  private step = 0;
  private contacts = new Map<CollisionShape2D, Map<number, number>>();
  private recent: { point: Vec2; time: number }[] = [];
  private time = 0;
  private baseline = true;

  reset(): void {
    this.contacts.clear();
    this.recent = [];
    this.baseline = true;
  }

  observe(hits: readonly DrapeContact[], dt: number, excluded: PhysicsBody2D,
    wet: number): { drag: ChainSurfaceCue | null; impacts: ChainImpactCue[] } {
    this.step++;
    this.time += dt;
    let drag: ChainSurfaceCue | null = null;
    const arrivals: { cue: ChainImpactCue; point: Vec2 }[] = [];
    // Snapshots already deduplicate solver passes. Also deduplicate injected
    // reports so one node/shape can never create more than one audio arrival.
    const seen = new Map<CollisionShape2D, Set<number>>();
    for (const hit of hits) {
      const body = hit.shape.owner;
      if (!(body instanceof PhysicsBody2D) || body === excluded || body.removed || !body.isSolid || !hit.shape.wrappable) continue;
      let nodes = seen.get(hit.shape);
      if (!nodes) seen.set(hit.shape, nodes = new Set());
      if (nodes.has(hit.node)) continue;
      nodes.add(hit.node);
      let history = this.contacts.get(hit.shape);
      if (!history) this.contacts.set(hit.shape, history = new Map());
      const previous = history.get(hit.node) ?? -Infinity;
      history.set(hit.node, this.step);
      const surface = surfaceOf(hit.shape, body);
      const slide = Math.min(4, hit.slideSpeed) * (1 - wet);
      if (slide > 0.06 && (!drag || slide > drag.speed)) drag = { speed: slide, x: hit.point.x, y: hit.point.y, surface };
      const speed = Math.min(4, hit.normalSpeed) * (1 - wet);
      if (!this.baseline && this.step - previous > 3 && speed >= 0.25) {
        arrivals.push({ cue: { speed, x: hit.point.x, y: hit.point.y, surface, at: 1 }, point: hit.point });
      }
    }
    for (const [shape, history] of this.contacts) {
      for (const [node, step] of history) if (this.step - step > 3) history.delete(node);
      if (!history.size) this.contacts.delete(shape);
    }
    this.baseline = false;
    this.recent = this.recent.filter(event => this.time - event.time < 0.035);
    // Strongest contacts lead. Neighbouring simultaneous arrivals form one
    // small gesture; weak voices cannot bury the main impact in a buzz.
    arrivals.sort((a, b) => b.cue.speed - a.cue.speed);
    const selected: typeof arrivals = [];
    for (const arrival of arrivals) {
      const group = selected.find(other => other.cue.surface === arrival.cue.surface && other.point.distanceTo(arrival.point) < 0.12);
      if (group) {
        group.cue.speed = Math.min(4, Math.hypot(group.cue.speed, arrival.cue.speed));
        continue;
      }
      if (selected.length >= 3 || this.recent.some(event => event.point.distanceTo(arrival.point) < 0.12)) continue;
      selected.push(arrival);
    }
    for (const event of selected) this.recent.push({ point: event.point, time: this.time });
    return { drag, impacts: selected.map(event => event.cue) };
  }
}
