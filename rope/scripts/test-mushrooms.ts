import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mushroomBody, modelFromDisk, modelFromTree, modelToDisk, resizeMushroom } from '../src/editor/model';
import { loadLevelTree, type LevelData } from '../src/level/levelFormat';
import { Vec2 } from '../src/engine/vec2';
import { proceduralMushroom } from '../src/render3d/proceduralMushroom';
import { mushroomParameters } from '../src/level/mushroom';

// The fixture is in metres: read as the tree it is, as `mushroomModel` does
// (through `scaleLevelData` it would come back as the sim's level, which holds
// no models: the look is the tree's).
const fromLevelData = (data: LevelData) => modelFromTree(loadLevelTree(data));
const editor = fromLevelData({ player: { x: 0, y: 0, radius: .08 }, bodies: [mushroomBody(new Vec2(2, 3)), mushroomBody(new Vec2(5, 3))] });
const models = editor.items.filter(i => i.object === 'model');
resizeMushroom(editor, models[0]!, 'width', 1.7);
resizeMushroom(editor, models[0]!, 'capHeight', .42);
resizeMushroom(editor, models[0]!, 'stemHeight', .9);
// Through the file as the editor writes it, a tree (the model is the look,
// which the flat level the sim reads does not carry).
const reloaded = modelFromDisk(modelToDisk(editor));
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
