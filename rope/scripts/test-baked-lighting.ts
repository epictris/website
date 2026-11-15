import { strict as assert } from "node:assert";
import * as THREE from "three";
import { BakedField, restoreLightmap, shBasis, useBakedLighting, validateBakedField, type BakedFieldData } from "../src/render3d/bakedLighting";
import { wearProbe } from "../src/render3d/reflectionProbe";
import { wearGlowFlora } from "../src/render3d/glowFlora";
import { bakedContactUniforms, contactLightDirection } from "../src/render3d/bakedContactShadow";

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

const logMat = new THREE.MeshStandardMaterial({emissiveMap:map,emissive:0xffffff});
logMat.userData.gameBakedLighting={version:1,encoding:"log1p",range:194};
restoreLightmap(logMat);
restoreLightmap(logMat);
const logShader = {uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,
  fragmentShader:THREE.ShaderLib.standard.fragmentShader} as THREE.WebGLProgramParametersWithUniforms;
logMat.onBeforeCompile(logShader,{} as THREE.WebGLRenderer);
assert.equal(logMat.lightMapIntensity,Math.PI);
assert.equal((logShader.uniforms.bakedLightmapLogRange as {value:number}).value,Math.log2(1+16*194));
assert.ok(logShader.fragmentShader.includes("exp2(lightMapTexel.rgb * bakedLightmapLogRange) - 1.0"));
assert.equal(logShader.fragmentShader.split("uniform float bakedLightmapLogRange;").length,2);
assert.ok(logShader.fragmentShader.includes("lightMapIrradiance * bakedContactVisibility(normal)"));
const direction = new THREE.Vector3();
contactLightDirection(data,new THREE.Vector3(.5,.5,.5),direction);
assert.deepEqual(direction.toArray(),[0,1,0],"isotropic light gets a ground contact shadow");
const directional = {...data,coefficients:coefficients.map((v,i)=>i%27>=9&&i%27<12?2:v)};
contactLightDirection(directional,new THREE.Vector3(.5,.5,.5),direction);
assert.ok(direction.x>.999,"SH x lobe points the shadow towards its source");

const flora = new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshStandardMaterial());
for (const name of ["_glow","_gill","_sway","_extra"]) flora.geometry.setAttribute(name,new THREE.Float32BufferAttribute([0,0,0],3));
assert.ok(wearGlowFlora(flora));
const floraCompile = flora.material.onBeforeCompile;
useBakedLighting(flora,field);
assert.equal(flora.material.onBeforeCompile,floraCompile,"glow flora must not receive its own boosted probe field");

// The player's reflection patch expands lights_fragment_maps before our
// patch runs. Both must survive, and the field must enter BEFORE lighting
// is accumulated, with no duplicate declarations after repeated frames.
const mat = new THREE.MeshStandardMaterial();
wearProbe(mat);
const root=new THREE.Group(); root.add(new THREE.Mesh(new THREE.SphereGeometry(),mat));
useBakedLighting(root,field);
useBakedLighting(root,field);
useBakedLighting(root,field,{position:new THREE.Vector3(.5,.5,.5),radius:.08});
assert.equal(bakedContactUniforms.bakedContactRadius.value,.08);
const shader = {uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,
  fragmentShader:THREE.ShaderLib.standard.fragmentShader} as THREE.WebGLProgramParametersWithUniforms;
mat.onBeforeCompile(shader,{} as THREE.WebGLRenderer);
assert.ok(shader.fragmentShader.includes("probeIrradiance"));
assert.equal(shader.fragmentShader.split("uniform highp sampler3D bakedFieldTexture;").length,2);
assert.ok(shader.fragmentShader.indexOf("iblIrradiance += bakedIrradiance")<shader.fragmentShader.indexOf("#include <lights_fragment_end>"));
assert.ok(shader.fragmentShader.indexOf("radiance += bakedIrradiance")<shader.fragmentShader.indexOf("#include <lights_fragment_end>"));
assert.ok(!shader.fragmentShader.includes("irradiance += bakedIrradiance"), "do not double-count diffuse light outside the IBL path");
assert.ok(shader.vertexShader.includes("bakedPosition = instanceMatrix * bakedPosition"));
assert.equal((shader.uniforms.bakedFieldEnabled as {value:number}).value,1);
useBakedLighting(root,null);
assert.equal((shader.uniforms.bakedFieldEnabled as {value:number}).value,0);
assert.equal(bakedContactUniforms.bakedContactRadius.value,0);
assert.ok(!shader.fragmentShader.includes("bakedContactVisibility"),"the player must not shadow its own probe lighting");
field.dispose();
console.log("baked lighting: validation, linear units, UV channel, SH, shader composition and level switching passed");
