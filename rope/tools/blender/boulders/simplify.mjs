// Use the repository's existing meshoptimizer dependency for large voxel meshes.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';

const [folder, target, error] = process.argv.slice(2);
const read = (name, Type) => {
  const data = readFileSync(join(folder, name));
  return new Type(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
};
await MeshoptSimplifier.ready;
const [indices, measured] = MeshoptSimplifier.simplify(
  read('indices.bin', Uint32Array), read('positions.bin', Float32Array),
  3, Number(target) * 3, Number(error), ['ErrorAbsolute', 'LockBorder'],
);
writeFileSync(join(folder, 'result.bin'), new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength));
console.log(JSON.stringify({ triangles: indices.length / 3, error: measured }));
