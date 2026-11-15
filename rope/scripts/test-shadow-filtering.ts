import assert from "node:assert/strict";
import * as THREE from "three";
import { stableShadowFiltering, installStableShadowFiltering } from "../src/render3d/shadowFiltering";

const original = THREE.ShaderChunk.shadowmap_pars_fragment;
const filtered = stableShadowFiltering(original);
const start = filtered.indexOf("// Stable weighted shadow filter");
const end = filtered.indexOf("return mix( 1.0, shadow, shadowIntensity );", start);
const kernel = filtered.slice(start, end);
assert.equal((kernel.match(/texture\(shadowMap,/g) ?? []).length, 9);
assert.ok(!kernel.includes("gl_FragCoord"));
assert.equal([...kernel.matchAll(/(\d+)\.0 \* texture/g)].reduce((sum, m) => sum + Number(m[1]), 0), 16);
assert.ok(kernel.includes("/ 16.0"), "constant light and full shadow must retain their intensity");
// Keep point-light filtering and the other shadow-map implementations intact.
const point = original.indexOf("float getPointShadow");
assert.ok(point >= 0);
assert.ok(filtered.endsWith(original.slice(point)));
assert.equal(stableShadowFiltering(filtered), filtered);
assert.throws(() => stableShadowFiltering("unsupported shader"), /hook missing/);
installStableShadowFiltering();
installStableShadowFiltering();
assert.equal(THREE.ShaderChunk.shadowmap_pars_fragment, filtered);
console.log("shadow filtering: normalized fixed kernel, point shadows preserved, idempotent installation passed");
