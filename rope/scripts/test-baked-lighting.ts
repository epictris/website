import { strict as assert } from "node:assert";
import * as THREE from "three";
import { BakedField, restoreLightmap, shBasis, useBakedLighting, validateBakedField, type BakedFieldData } from "../src/render3d/bakedLighting";
import { wearProbe } from "../src/render3d/reflectionProbe";

// A constant white radiance field should stay constant for every normal.
const coefficients = Array.from({length: 8*27}, (_, i) => i % 27 < 3 ? 1/.282095 : 0);
const data: BakedFieldData = {version:1,min:[0,0,0],max:[1,1,1],size:[2,2,2],coefficients};
for (const n of [[1,0,0],[0,1,0],[0,0,1],[-1,0,0],[0,-1,0]]) {
  const basis = shBasis(...n as [number,number,number]);
  assert.ok(Math.abs(basis.reduce((v,b,k)=>v+b*coefficients[k*3],0)-1)<1e-6);
}
assert.throws(()=>validateBakedField({...data,coefficients:[0]}));
assert.throws(()=>validateBakedField({...data,max:[0,1,1]}));
assert.throws(()=>validateBakedField({...data,size:[4096,4096,4096]}));
const field = new BakedField(data);
assert.equal(field.texture.image.depth,18);

const map = new THREE.Texture(); map.channel=1;
const staticMat = new THREE.MeshStandardMaterial({emissiveMap:map,emissive:0xffffff,emissiveIntensity:3});
staticMat.userData.gameBakedLighting={version:1};
restoreLightmap(staticMat);
assert.equal(staticMat.lightMap,map);
assert.equal(staticMat.lightMap.channel,1);
assert.equal(staticMat.lightMapIntensity,3*Math.PI);
assert.equal(staticMat.emissiveMap,null);
assert.equal(staticMat.emissiveIntensity,0);
const constant = new THREE.MeshStandardMaterial({emissive:new THREE.Color(.1,.2,.3),emissiveIntensity:2});
constant.userData.gameBakedLighting={version:1};
restoreLightmap(constant);
assert.ok(constant.lightMap);
assert.ok(Math.abs((constant.lightMap as THREE.DataTexture).image.data[1]-.2)<1e-6);

// The player's reflection patch expands lights_fragment_maps before our
// patch runs. Both must survive, and the field must enter BEFORE lighting
// is accumulated, with no duplicate declarations after repeated frames.
const mat = new THREE.MeshStandardMaterial();
wearProbe(mat);
const root=new THREE.Group(); root.add(new THREE.Mesh(new THREE.SphereGeometry(),mat));
useBakedLighting(root,field);
useBakedLighting(root,field);
const shader = {uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,
  fragmentShader:THREE.ShaderLib.standard.fragmentShader} as THREE.WebGLProgramParametersWithUniforms;
mat.onBeforeCompile(shader,{} as THREE.WebGLRenderer);
assert.ok(shader.fragmentShader.includes("probeIrradiance"));
assert.equal(shader.fragmentShader.split("uniform highp sampler3D bakedFieldTexture;").length,2);
assert.ok(shader.fragmentShader.indexOf("irradiance += bakedIrradiance")<shader.fragmentShader.indexOf("#include <lights_fragment_end>"));
assert.ok(shader.vertexShader.includes("bakedPosition = instanceMatrix * bakedPosition"));
assert.equal((shader.uniforms.bakedFieldEnabled as {value:number}).value,1);
useBakedLighting(root,null);
assert.equal((shader.uniforms.bakedFieldEnabled as {value:number}).value,0);
field.dispose();
console.log("baked lighting: validation, linear units, UV channel, SH, shader composition and level switching passed");
