import { strict as assert } from "node:assert";
import { World } from "../src/engine/world";
import { RigidBody2D } from "../src/engine/body";
import { buildLevelBodies } from "../src/level/buildBodies";
import { scaleLevelData, type RawLevelData, type CollisionObjectData } from "../src/level/levelFormat";
import { modelFromDisk, modelToDisk, syncBodyProps, shapeMass } from "../src/editor/model";
import { surfaceOf } from "../src/audio/surfaces";
import { soundMaterialOf } from "../src/lib/soundMaterial";
import { resolveSlot, SOUND_BANK } from "../src/audio/slots";

const raw = (sound = "ivy"): RawLevelData => ({
  player: { x: 0, y: 0, radius: 8 },
  bodies: [{ kind: "rigid", x: 0, y: 0, rot: 0, objects: [
    { type: "collision", x: -100, shape: { kind: "rect", w: 100, h: 40 }, material: "steel", soundMaterial: sound },
    { type: "collision", x: 100, shape: { kind: "rect", w: 100, h: 40 }, material: "wood", soundMaterial: "stone" },
  ] }],
} as RawLevelData);
const build = (data: RawLevelData) => buildLevelBodies(new World(), scaleLevelData(data, .01), () => {}).bodies[0]!.body as RigidBody2D;
const ivy = build(raw());
const metal = build(raw("metal"));
assert.equal(ivy.mass, metal.mass, "audio identity cannot change mass");
assert.equal(ivy.inertia, metal.inertia, "audio identity cannot change inertia");
assert.deepEqual(ivy.globalPosition, metal.globalPosition, "audio identity cannot change centre of mass");
assert.deepEqual(ivy.getShapes().map(p => surfaceOf(p, ivy)), ["ivy", "stone"], "compound pieces retain independent sound materials");
assert.deepEqual(ivy.getShapes().map(p => p.material), ["steel", "wood"], "physical density presets remain independent");
const shape = ivy.getShapes()[0]!;
shape.impermeable = true;
shape.viscosity = 1;
assert.equal(surfaceOf(shape, ivy), "ivy", "explicit audio identity overrides automatic mechanical classification");
shape.soundMaterial = "auto";
assert.equal(surfaceOf(shape, ivy), "mud", "automatic audio follows mechanics");
shape.viscosity = 0;
assert.equal(surfaceOf(shape, ivy), "stone");
shape.impermeable = false;
shape.material = "glass";
assert.equal(surfaceOf(shape, ivy), "wood", "automatic audio never reads physical material");

const model = modelFromDisk(raw());
const pieces = model.items.filter(i => i.object === "collision");
assert.deepEqual(pieces.map(p => p.soundMaterial), ["ivy", "stone"]);
syncBodyProps(pieces);
assert.deepEqual(pieces.map(p => p.soundMaterial), ["ivy", "stone"], "grouping must not collapse per-shape sound identity");
const mass = shapeMass(pieces[0]!);
pieces[0]!.soundMaterial = "glass";
assert.equal(shapeMass(pieces[0]!), mass, "editor sound selection cannot change mass");
pieces[0]!.material = "lead";
assert.equal(pieces[0]!.soundMaterial, "glass", "physics selection cannot change sound selection");
const saved = modelToDisk(model);
const back = modelFromDisk(saved).items.filter(i => i.object === "collision");
assert.deepEqual(back.map(p => p.soundMaterial), ["glass", "stone"], "save/reload retains both per-shape choices");
assert.equal(back[0]!.material, "lead");
const scaled = scaleLevelData(saved, .5);
assert.deepEqual(scaled.bodies[0]!.objects.filter(o => o.type === "collision").map(o => (o as CollisionObjectData).soundMaterial), ["glass", "stone"], "scaling retains audio identity");

const legacy = raw();
for (const o of legacy.bodies[0]!.objects) delete (o as CollisionObjectData).soundMaterial;
const oldModel = modelFromDisk(legacy);
const oldPieces = oldModel.items.filter(i => i.object === "collision");
assert.deepEqual(oldPieces.map(p => p.soundMaterial), ["metal", "wood"], "legacy density-derived audio is captured once on import");
oldPieces[0]!.material = "wood";
assert.equal(oldPieces[0]!.soundMaterial, "metal");
assert.equal(soundMaterialOf({ material: "steel", soundMaterial: "auto" }), "auto", "explicit automatic choice cannot be remapped by density");
assert.equal(soundMaterialOf({ material: "steel", viscosity: 1 }), "auto", "legacy mud keeps mechanical precedence");
assert.equal(resolveSlot(SOUND_BANK, "attach", "ivy")!.key, "attach.ivy", "ivy attachment resolves the leaf impact");
assert.equal(resolveSlot(SOUND_BANK, "hook-drag", "ivy")!.key, "hook-drag", "unassigned ivy sliding retains the normal fallback");
console.log("PASS: independent physics/audio materials, compound shapes, legacy import, persistence, scaling and ivy routing");
