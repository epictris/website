import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mushroomBody, modelFromDisk, modelToFlatDisk, resizeMushroom } from '../src/editor/model';
import { scaleLevelData, type LevelData } from '../src/level/levelFormat';
import { PIXELS_PER_METER } from '../src/engine/units';
import { Vec2 } from '../src/engine/vec2';
import { proceduralMushroom } from '../src/render3d/proceduralMushroom';
import { mushroomParameters } from '../src/level/mushroom';

const fromLevelData = (data: LevelData) => modelFromDisk(scaleLevelData(data, PIXELS_PER_METER));
const editor = fromLevelData({ player: { x: 0, y: 0, radius: .08 }, bodies: [mushroomBody(new Vec2(2, 3)), mushroomBody(new Vec2(5, 3))] });
const models = editor.items.filter(i => i.object === 'model');
resizeMushroom(editor, models[0]!, 'width', 1.7);
resizeMushroom(editor, models[0]!, 'capHeight', .42);
resizeMushroom(editor, models[0]!, 'stemHeight', .9);
const reloaded = modelFromDisk(modelToFlatDisk(editor));
const saved = reloaded.items.filter(i => i.object === 'model');
assert.deepEqual(saved[0]!.modelRef.mushroom, { width: 1.7, capHeight: .42, stemHeight: .9 });
assert.equal(saved[1]!.modelRef.mushroom!.width, 1);
const cap = editor.items.find(i => i.object === 'collision' && i.unit === models[0]!.unit)!;
assert.equal(cap.shape.kind, 'poly');
if (cap.shape.kind === 'poly') {
  assert.ok(Math.abs(Math.max(...cap.shape.verts.map(v => v.x)) - Math.min(...cap.shape.verts.map(v => v.x)) - 1.7) < 1e-6);
}
for (const capHeight of [.02, .42, 2]) {
  const params = mushroomParameters('bouncy-mushroom', { width: 1.7, capHeight, stemHeight: .9 })!;
  const mesh = proceduralMushroom(params);
  const box = new THREE.Box3().setFromObject(mesh);
  assert.ok(Math.abs(box.max.y - capHeight) < 1e-6);
  assert.ok(Math.abs(box.min.y + .9) < 1e-6);
  mesh.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const n of o.geometry.attributes.normal!.array) assert.ok(Number.isFinite(n));
    o.geometry.dispose(); o.material.dispose();
  });
}
console.log('Mushrooms: independent parameters, save/load, cap collision and mesh bounds passed.');
