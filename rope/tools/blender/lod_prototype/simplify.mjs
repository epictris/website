// One process for the entire small experiment; existing dependency, no install.
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

await MeshoptSimplifier.ready;
const chunks = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const result = chunks.map(chunk => {
  if (!chunk.indices.length) return { indices: [], error: 0, milliseconds: 0 };
  const positions = new Float32Array(chunk.vertices.flatMap(v => v.position));
  const attributes = new Float32Array(chunk.vertices.flatMap(v => v.attributes));
  const stride = chunk.vertices[0].attributes.length;
  const start = performance.now();
  // An error target, not an arbitrary percentage. Border vertices must survive;
  // do not enable Prune or permissive seam collapse. Retain normal/UV quality.
  const [indices, error] = MeshoptSimplifier.simplifyWithAttributes(
    new Uint32Array(chunk.indices), positions, 3, attributes, stride,
    [0.05, 0.05, 0.05, ...Array(stride - 3).fill(1)], null, 0, chunk.error, ['LockBorder', 'ErrorAbsolute'],
  );
  return { indices: Array.from(indices), error, milliseconds: performance.now() - start };
});
writeFileSync(process.argv[3], JSON.stringify(result));
