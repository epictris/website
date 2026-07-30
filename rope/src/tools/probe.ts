// TEMP probe: why does the deploying chain not wrap the wall corner?
import { readFileSync } from "node:fs";
import { levelFromRecording } from "../sim/replay";
import { inputDeserializer, type Recording } from "../sim/trace";
import { Vec2 } from "../engine/vec2";
import { circleOverlap } from "../engine/collision";
import { PhysicsBody2D } from "../engine/body";
import { ShapeGeometry } from "../lib/shapeGeometry";
import type { BallLevel } from "../level/ballLevel";

const rec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Recording;
const from = Number(process.argv[3] ?? 350);
const to = Number(process.argv[4] ?? 362);
const level = levelFromRecording(rec) as BallLevel;
const de = inputDeserializer();
for (let i = 0; i < rec.frames.length; i++) {
  level.physicsProcess(de(rec.frames[i]!), 1 / 60);
  const f = i + 1;
  if (f < from || f > to) continue;
  const ball: any = (level as any).ball;
  const chain = ball.chain;
  if (!chain) { console.log(`f${f} no chain`); continue; }
  const nodes = chain.path();
  const a = nodes[0].contact.globalPosition;
  const b = nodes[nodes.length - 1].contact.globalPosition;
  console.log(`f${f} inFlight=${!!ball.hookInFlight} nodes=${nodes.length} span=(${(a.x*100).toFixed(0)},${(a.y*100).toFixed(0)})->(${(b.x*100).toFixed(0)},${(b.y*100).toFixed(0)})`);
  // For each solid body, report shapes whose corners lie near the span.
  for (const body of level.bodies) {
    if (!(body instanceof PhysicsBody2D) || !body.isSolid) continue;
    body.getShapes().forEach((s, si) => {
      if (s.shape.kind === "circle") return;
      for (const c of ShapeGeometry.getGlobalCorners(s)) {
        // perpendicular distance to the span line, only if between the ends
        const d = b.sub(a);
        const t = c.sub(a).dot(d) / d.lengthSquared();
        if (t < 0 || t > 1) continue;
        const perp = c.sub(a.add(d.mul(t))).length();
        if (perp > 0.15) continue;
        const shapes = body.getShapes();
        let seam = false;
        for (let k = 0; k < shapes.length; k++) {
          if (k === si) continue;
          if (circleOverlap(c, 0.005, shapes[k]!)) seam = true;
        }
        console.log(`   ${body.name}[${si}] corner (${(c.x*100).toFixed(0)},${(c.y*100).toFixed(0)}) perp=${(perp*100).toFixed(1)}px seam=${seam}`);
      }
    });
  }
}
