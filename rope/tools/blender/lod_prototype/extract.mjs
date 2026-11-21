// Read the snapshotted export once; no Blender, regeneration, image bake or GPU.
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import * as THREE from 'three';
import {writeFileSync} from 'node:fs';
import sharp from 'sharp';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
const document = await io.read(process.argv[2]);
const name = process.argv[4] ?? 'Cube.006';
const node = document.getRoot().listNodes().find(n=>n.getName()===name);
if(!node)throw new Error(`${name} missing`);
const primitives=node.getMesh().listPrimitives();
if(primitives.length!==1)throw new Error('Prototype expects one material on this source rock');
const p=primitives[0];
const world=new THREE.Matrix4().fromArray(node.getWorldMatrix());
const positions=[],attributes=[];
const position=p.getAttribute('POSITION');
const names=['NORMAL','TEXCOORD_0','TEXCOORD_1'];
const accessors=names.map(n=>p.getAttribute(n));
if(accessors.some(a=>!a))throw new Error('Expected normal, colour UV and lightmap UV');
const v=new THREE.Vector3(), element=[];
for(let i=0;i<position.getCount();i++){
  position.getElement(i,element); v.fromArray(element).applyMatrix4(world);
  positions.push([v.x,-v.z,v.y]); // Blender world frame for the depth planner.
  const attrs=[];
  for(const a of accessors){a.getElement(i,element);attrs.push(...element.slice(0,a.getElementSize()));}
  attributes.push(attrs);
}
const material=p.getMaterial();
const image=material.getBaseColorTexture().getImage();
const metadata=await sharp(image).metadata();
const result={name:node.getName(),positions,attributes,indices:Array.from(p.getIndices().getArray()),
  world:world.toArray(),inverseWorld:world.clone().invert().toArray(),
  textureSize:[metadata.width,metadata.height],
  attributeLayout:[{name:'normal',size:3},{name:'uv',size:2},{name:'uv1',size:2}]};
if(result.indices.length/3>250000)throw new Error('Small experiment limit: 250k triangles');
writeFileSync(process.argv[3],JSON.stringify(result));
console.log('EXTRACTED_REAL_ROCK',node.getName(),result.indices.length/3,'triangles',result.textureSize);
