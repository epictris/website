import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { validateProject, clipSeconds, type LayerCatalog } from '../src/audio/layerProject';
const catalog = JSON.parse(readFileSync(new URL('../tools/audio/layer-projects.json', import.meta.url), 'utf8')) as LayerCatalog;
for (const project of catalog.projects)
    validateProject(project, catalog.sources);
const base = catalog.projects.find(p => p.layers.length)!;
for (const corrupt of [
    (p: typeof base) => { p.seconds = Infinity; },
    (p: typeof base) => { p.layers[0].effects.gainDb = NaN; },
    (p: typeof base) => { p.layers[0].sourceId = 'outside-catalog'; },
    (p: typeof base) => { p.layers[0].clips[0].end = p.layers[0].clips[0].start; },
    (p: typeof base) => { p.layers[0].effects.delayMix = 2; },
    (p: typeof base) => { p.id = '../outside-workspace'; },
]) {
    const copy = structuredClone(base);
    corrupt(copy);
    assert.throws(() => validateProject(copy, catalog.sources));
}
const layer = structuredClone(base.layers[0]);
const clip = { id: 'test', start: 1, end: 2, at: 0, pitch: 0, gain: 1 };
layer.effects.pitch = 12;
assert.equal(clipSeconds(clip, layer), .5);
clip.pitch = -12;
assert.equal(clipSeconds(clip, layer), 1);
console.log(`PASS: ${catalog.projects.length} source projects validate; invalid sources/ranges/paths rejected; timeline pitch duration`);
