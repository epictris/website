// Link-to-link contact proxy: local bending travel creates short sample
// gestures. Translation alone and stationary curvature do not rattle.
import { Vec2 } from "../engine/vec2";
export interface ChainJingleCue { speed: number; x: number; y: number }

export class ChainArticulationAudio {
  private nodes: readonly Vec2[] = [];
  private bends: number[] = [];
  private travel: number[] = [];
  private cooldown = 0;

  reset(): void {
    this.nodes = [];
    this.bends = [];
    this.travel = [];
    this.cooldown = 0;
  }

  observe(nodes: readonly Vec2[], dt: number, wet: number): ChainJingleCue[] {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const baseline = nodes.length !== this.nodes.length;
    const candidates: ChainJingleCue[] = [];
    const velocities = nodes.map((p, i) => baseline ? Vec2.ZERO : p.sub(this.nodes[i]!).div(dt));
    for (let i = 1; i < nodes.length - 1; i++) {
      const a = nodes[i]!.sub(nodes[i - 1]!);
      const b = nodes[i + 1]!.sub(nodes[i]!);
      if (a.length() < 0.005 || b.length() < 0.005) { this.travel[i] = 0; this.bends[i] = 0; continue; }
      const bend = Math.atan2(a.x * b.y - a.y * b.x, a.dot(b));
      const delta = bend - (this.bends[i] ?? bend);
      const turned = Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
      this.bends[i] = bend;
      const relative = velocities[i]!.sub(velocities[i - 1]!.add(velocities[i + 1]!).mul(0.5)).length();
      if (baseline || relative < 0.12 || turned < 0.003 || wet >= 1) { this.travel[i] = 0; continue; }
      this.travel[i] = (this.travel[i] ?? 0) + turned;
      if (this.travel[i]! >= 0.12) {
        candidates.push({ speed: Math.min(2, relative) * (1 - wet), x: nodes[i]!.x, y: nodes[i]!.y });
        this.travel[i] = 0; // excess motion is never queued after stopping
      }
    }
    this.nodes = nodes.slice();
    if (this.cooldown > 0 || !candidates.length) return [];
    candidates.sort((a, b) => b.speed - a.speed);
    this.cooldown = 0.04;
    // One local articulation cluster, independent of node count.
    return candidates.slice(0, 1);
  }
}
