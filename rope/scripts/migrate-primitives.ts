// ONE-OFF: level files written when a geometry object could dress a body's
// collision outlines, rewritten so every primitive states its own form.
//
// It is kept rather than deleted because it IS the record of what the files on
// disk were before the decoupling, and because `levels/*.json` is content: a
// level that predates this and turns up in a branch, a backup or a bug report is
// migrated by running it again rather than by hand. Idempotent - a file with no
// shapeless primitive left in it is written back unchanged.
//
// The pairing it inverts is the retired `outlineDressings`: shapeless geometry
// objects paired with collision objects in authored order, and the first of them
// covered every piece a later one did not. So each collision object gets the
// primitive that was drawing it, carrying the outline, the placement, the depth
// (`thickness`) and the surface (`material`) the extrusion used to read off it -
// which is what makes the migrated level pixel-identical to the one before it.
//
//   bun run scripts/migrate-primitives.ts [levels/*.json]

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Obj {
  type: string;
  shape?: unknown;
  kind?: string;
  x?: number;
  y?: number;
  rot?: number;
  thickness?: number;
  material?: string;
  depth?: number;
  texture?: string;
  [k: string]: unknown;
}

interface Body {
  objects?: Obj[];
  [k: string]: unknown;
}

// A shapeless PRIMITIVE is what this migrates. A shapeless mesh is left a mesh -
// a prop replaces the outline rather than wearing it, so its placement was
// always its own - and only gains the placeholder it drew until its file arrived.
const isGeometry = (o: Obj) => o.type === "geometry";
const isPrimitive = (o: Obj) => isGeometry(o) && o.kind !== "mesh";

function migrateBody(body: Body): { body: Body; changed: number } {
  const objects = body.objects ?? [];
  const collisions = objects.filter((o) => o.type === "collision");
  const shapeless = objects.filter((o) => isGeometry(o) && o.shape === undefined);
  if (!shapeless.length) return { body, changed: 0 };
  // The retired pairing, exactly: piece i is drawn by the i'th shapeless
  // geometry object, or by the first one where there is no i'th.
  const drawnBy = collisions.map((_, i) => shapeless[i] ?? shapeless[0]);

  let changed = 0;
  const out: Obj[] = [];
  for (const o of objects) {
    if (!isGeometry(o) || o.shape !== undefined) {
      out.push(o);
      continue;
    }
    const drew = collisions.filter((_, i) => drawnBy[i] === o);
    if (!drew.length) {
      // A shapeless geometry object on a body with no collision at all: there
      // was never an outline for it to draw, and there is nothing to copy.
      out.push(o);
      continue;
    }
    if (!isPrimitive(o)) {
      out.push({ ...o, shape: drew[0]!.shape });
      changed++;
      continue;
    }
    for (const c of drew) {
      out.push(primitiveOf(o, c));
      changed++;
    }
  }
  return { body: { ...body, objects: out }, changed };
}

// The primitive a dressing plus the piece it dressed become. The dressing's own
// fields win wherever it stated one: it could already override the depth and the
// surface, and those overrides are what it was authored for.
function primitiveOf(dressing: Obj, c: Obj): Obj {
  const out: Obj = { ...dressing, shape: c.shape };
  // The placement is the PIECE's: a shapeless primitive was drawn at each piece
  // it dressed, whatever its own x/y/rot said, so those are what the level
  // actually looked like.
  for (const k of ["x", "y", "rot"] as const) {
    if (c[k] !== undefined) out[k] = c[k];
    else delete out[k];
  }
  if (out.depth === undefined && c.thickness !== undefined) out.depth = c.thickness;
  if (out.texture === undefined && c.material !== undefined) out.texture = c.material;
  return out;
}

const args = process.argv.slice(2);
const files = args.length
  ? args
  : readdirSync("levels")
      .filter((f) => f.endsWith(".json"))
      .map((f) => join("levels", f));

for (const file of files) {
  const data = JSON.parse(readFileSync(file, "utf8")) as { bodies?: Body[] };
  let changed = 0;
  data.bodies = (data.bodies ?? []).map((b) => {
    const r = migrateBody(b);
    changed += r.changed;
    return r.body;
  });
  if (!changed) {
    console.log(`${file}: nothing to migrate`);
    continue;
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`${file}: ${changed} primitives now state their own form`);
}
