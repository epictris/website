// Run with Node: the texture encoder deliberately uses Node's sharp backend.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readdirSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Document, NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import sharp from 'sharp';

const scratch = mkdtempSync(join(tmpdir(), 'lightmap-encoding-'));
try {
  const width = 2048, height = 16;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 73 + (i >> 4)) % 256;
  const png = await sharp(pixels, {raw: {width, height, channels: 3}}).png().toBuffer();
  const doc = new Document();
  const buffer = doc.createBuffer();
  // This is the broken name Blender previously produced from Cube.002.
  const texture = doc.createTexture('Cube').setMimeType('image/png').setImage(png);
  const mat = doc.createMaterial().setEmissiveTexture(texture).setEmissiveFactor([1, 1, 1])
    .setExtras({gameBakedLighting: {version: 1}});
  const primitive = doc.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array([0,0,0, 1,0,0, 0,1,0])).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array([0,0, 1,0, 0,1])).setBuffer(buffer));
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const path = join(scratch, 'fixture.glb');
  const cache = join(scratch, 'cache');
  let cachedFiles;
  for (let run = 0; run < 2; run++) {
    await io.write(path, doc);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./encode-textures.mjs', import.meta.url)), path, '--cache', cache], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const files = readdirSync(cache).map((name) => [name, statSync(join(cache, name)).mtimeMs]);
    assert.equal(files.length, 1);
    if (run) assert.deepEqual(files, cachedFiles, 'cache hit must not rewrite the encoded image');
    cachedFiles = files;
    const out = (await io.read(path)).getRoot().listTextures()[0];
    assert.equal(out.getMimeType(), 'image/webp');
    const decoded = await sharp(out.getImage()).removeAlpha().raw().toBuffer({resolveWithObject: true});
    assert.equal(decoded.info.width, width);
    assert.equal(decoded.info.height, height);
    assert.deepEqual(decoded.data, pixels);
    assert.match(out.getName(), / baked light$/);
  }
  console.log('Lightmap encoding: truncated names still preserve every pixel and full resolution, fresh and cached');
} finally {
  rmSync(scratch, {recursive: true, force: true});
}
