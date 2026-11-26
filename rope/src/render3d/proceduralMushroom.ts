import * as THREE from 'three';
import type { MushroomParameters } from '../level/mushroom';

// One shared procedural paint map; dimensions only change the mesh.
let capPaint: THREE.DataTexture | undefined;
let capDetail: THREE.DataTexture | undefined;
let capEmission: THREE.DataTexture | undefined;

// THE MUSHROOM'S OWN LIGHT sits inside its cap (`mushroomCapCentre`) and is
// for what is AROUND it: the mushroom itself glows by its emission alone. So a
// point light inside the cap neither lights the cap, the rim, the gills or the
// stem nor is blocked by them, whatever way their faces point (every material
// here is double sided) and whether or not the light casts shadows. "Inside"
// is the cap's box in the mushroom's own frame - its width across, from below
// the gill folds to the crown - so another lamp beside or above the mushroom
// lights it as any lamp does.
//
// The test is the same in both passes: the light's world position carried
// into the mushroom's frame (`selfFrame`, world to the mushroom's group,
// refreshed before each draw and each shadow pass), then against the box.
const SELF_LIGHT_GLSL = /* glsl */ `
uniform mat4 selfFrame;
uniform vec3 selfCap;
bool insideOwnCap( vec3 world ) {
  vec3 p = ( selfFrame * vec4( world, 1.0 ) ).xyz;
  return length( p.xz ) <= selfCap.x && p.y >= selfCap.y && p.y <= selfCap.z;
}
`;
const POINT_LIGHT_INFO = "getPointLightInfo( pointLight, geometryPosition, directLight );";
// The lit pass's point lights are in view space; `viewMatrix` is rigid, so
// its inverse is the transposed rotation about the translation.
const SKIP_OWN_LIGHT = `${POINT_LIGHT_INFO}
    if ( insideOwnCap( transpose( mat3( viewMatrix ) ) * ( pointLight.position - viewMatrix[ 3 ].xyz ) ) ) directLight.color = vec3( 0.0 );`;

/** Organic bell with rounded rim, luminous gills and fibrous stem. */
export function proceduralMushroom(p: MushroomParameters): THREE.Group {
  const group = new THREE.Group();
  const selfUniforms = {
    selfFrame: { value: new THREE.Matrix4() },
    // Radius across, then the lowest and highest y counted as inside.
    selfCap: { value: new THREE.Vector3(p.width * .5, -p.capHeight * .5, p.capHeight) },
  };
  const refreshFrame = (): void => {
    selfUniforms.selfFrame.value.copy(group.matrixWorld).invert();
  };
  // Every material here compiles the SAME code (three caches a program by
  // `onBeforeCompile`'s source, so one function making two shaders would hand
  // one material the other's): emission follows the vertex paint as well as
  // the body's waking light (inert without vertex colours, as on the cap), and
  // the mushroom is lit by every light but its own (see SELF_LIGHT_GLSL).
  const patch = (material: THREE.MeshStandardMaterial): void => {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance *= vColor.rgb;\n#endif');
      Object.assign(shader.uniforms, selfUniforms);
      const lights = THREE.ShaderChunk.lights_fragment_begin;
      if (!lights.includes(POINT_LIGHT_INFO)) throw new Error("proceduralMushroom: three's point-light loop changed; the own-light exclusion needs updating");
      shader.fragmentShader = SELF_LIGHT_GLSL + shader.fragmentShader.replace("#include <lights_fragment_begin>", lights.replace(POINT_LIGHT_INFO, SKIP_OWN_LIGHT));
    };
  };
  // ...and left out of its own light's shadow (a point light's shadow is
  // drawn with the mesh's distance material, the light at `referencePosition`).
  const shadowMaterial = new THREE.MeshDistanceMaterial();
  shadowMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, selfUniforms);
    shader.fragmentShader = SELF_LIGHT_GLSL + shader.fragmentShader.replace("void main() {", "void main() {\n\tif ( insideOwnCap( referencePosition ) ) discard;");
  };
  const purple = new THREE.Color('#a75cc8');
  const cyan = new THREE.Color('#91deed'), dark = new THREE.Color('#293653');
  const lip = Math.min(p.width*.009, p.capHeight*.11, p.stemHeight*.075);
  const maturity = THREE.MathUtils.clamp(p.width/(p.capHeight*4), .4, 1);
  const phase = p.width*1.7 + p.stemHeight*2.3;
  const wave = (a: number) => .55*Math.sin(5*a+phase) + .3*Math.sin(3*a-.8) + .15*Math.sin(9*a+.4);
  const edgeRadius = (a: number) => p.width*.5*(1-.018*maturity*(1+wave(a)));
  const edgeY = (a: number) => lip*(.6*wave(a)+.16*Math.sin(13*a+phase));
  const lipAt = (a: number) => lip*(.8+.16*Math.sin(5*a+phase)+.08*Math.sin(11*a-.4));
  function surface(rows: number, sides: number, sample: (t: number, a: number) => { point: number[]; color: THREE.Color }, glow: number, reverse = false) {
    const positions: number[] = [], colors: number[] = [], indices: number[] = [];
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= sides; i++) {
      const s = sample(j / rows, i / sides * Math.PI * 2);
      positions.push(...s.point); colors.push(s.color.r, s.color.g, s.color.b);
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < sides; i++) {
      const k = j * (sides + 1) + i;
      indices.push(k, k + sides + 1, k + 1, k + 1, k + sides + 1, k + sides + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    if (reverse) for (let i = 0; i < indices.length; i += 3) [indices[i], indices[i+1]] = [indices[i+1]!, indices[i]!];
    geometry.setIndex(indices); geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .58, metalness: .05, side: THREE.DoubleSide });
    material.emissive.set('#ffffff'); material.emissiveIntensity = glow;
    patch(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.customDistanceMaterial = shadowMaterial;
    // Before the draw and before a shadow pass, which comes first in a frame.
    mesh.onBeforeRender = refreshFrame;
    mesh.onBeforeShadow = refreshFrame;
    group.add(mesh);
    return mesh;
  }
  const cap = surface(48, 192, (t, a) => {
    const angle = t*Math.PI/2, r = Math.sin(angle), crown = Math.cos(angle);
    const thickness = lipAt(a);
    const radius = (edgeRadius(a)-thickness)*r;
    return { point: [radius*Math.cos(a)+p.width*.025*crown*crown,
      thickness+(p.capHeight-thickness)*crown+edgeY(a)*r*r,
      radius*Math.sin(a)+p.width*.012*crown*crown], color: purple };
  }, 2.2, true);
  // A high-resolution, procedurally painted map keeps circular spots smooth
  // independently of mesh tessellation. Positions are fixed across edits.
  if (!capPaint) {
    const size = 1024;
    const pixels = new Uint8Array(size * size * 4);
    const detail = new Uint8Array(size * size * 4);
    const emission = new Uint8Array(size * size * 4);
    const dots = [
      [-.16, .12, .095], [.25, .28, .085], [-.44, .39, .075],
      [.04, -.32, .10], [.48, -.17, .075], [-.48, -.26, .09],
      [.15, .67, .065], [-.20, -.65, .07], [.66, .30, .065],
      [-.70, .05, .065], [.43, -.57, .06], [-.30, .68, .06],
    ];
    const spot = new THREE.Color('#ced5f2');
    const paint = new THREE.Color();
    let seed = 1937;
    const pigment = Array.from({ length: 32 * 32 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    });
    const wash = (x: number, y: number): number => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const at = (a: number, b: number) => pigment[(b & 31) * 32 + (a & 31)]!;
      return THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(at(ix, iy), at(ix+1, iy), sx),
        THREE.MathUtils.lerp(at(ix, iy+1), at(ix+1, iy+1), sx), sy);
    };
    const center = new THREE.Color('#514481'), rim = new THREE.Color('#426f9b');
    const edgeViolet = new THREE.Color('#7961a7');
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = 2 * x / (size - 1) - 1, v = 2 * y / (size - 1) - 1;
      const radius = Math.hypot(u,v), angle = Math.atan2(v,u);
      const soft = wash((u+1)*12+11, (v+1)*12+2);
      const tooth = wash((u+1)*65+5, (v+1)*65+17);
      const streak = Math.sin(angle*83+radius*15+2*soft)*THREE.MathUtils.smoothstep(radius,.15,.8);
      paint.copy(center).lerp(rim, THREE.MathUtils.smoothstep(radius,.1,1));
      const edgeBlend = THREE.MathUtils.smoothstep(radius, .76+.025*Math.sin(5*angle), .98);
      paint.lerp(edgeViolet, edgeBlend*(.55+.15*Math.sin(5*angle+.8)+.10*Math.sin(9*angle)));
      paint.multiplyScalar(.94+.10*soft+.035*(tooth-.5)+.025*streak);
      let coverage = 0;
      // How far each spot's light spreads into the cap around it: 1 at its
      // edge, falling off over about half its radius.
      let halo = 0;
      for (const [dx, dy, r] of dots) {
        const a = Math.atan2(v-dy,u-dx);
        const shape = 1+.12*Math.sin(3*a+dx*17)+.07*Math.sin(5*a+dy*13)+.12*(soft-.5);
        const distance = Math.hypot((u-dx)*(1+dy*.3),(v-dy)*(1-dx*.25));
        const edge = THREE.MathUtils.clamp((r*shape-distance)/.025+.5,0,1);
        coverage = Math.max(coverage, edge * edge * (3 - 2 * edge));
        halo = Math.max(halo, Math.exp(-Math.max(0, distance - r*shape) / (r * .45)));
      }
      paint.lerp(spot, coverage * (.78 + .12*soft));
      const i = (y * size + x) * 4;
      pixels[i] = Math.round(paint.r * 255);
      pixels[i+1] = Math.round(paint.g * 255);
      pixels[i+2] = Math.round(paint.b * 255);
      pixels[i+3] = 255;
      // Bump height in red, roughness in green: raised satin spots.
      detail[i] = Math.round(90+coverage*80+tooth*16+streak*5);
      detail[i+1] = Math.round(210-coverage*60+tooth*12);
      detail[i+3] = 255;
      // The spots are what glow on the cap: a pale cyan core, and around it
      // a deeper cyan halo where their light spreads into the cap. There is
      // no bloom pass, so the halo is what makes a spot read as a light
      // rather than as pale paint. The map is nothing else, so the cap's
      // emissive intensity is the spots' brightness.
      const around = halo * (1 - coverage) * .35;
      emission[i] = Math.round(Math.min(255, coverage*150 + around*40));
      emission[i+1] = Math.round(Math.min(255, coverage*235 + around*170));
      emission[i+2] = Math.round(Math.min(255, coverage*255 + around*255));
      emission[i+3] = 255;
    }
    const makeTexture = (data: Uint8Array) => {
      const texture = new THREE.DataTexture(data,size,size);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      return texture;
    };
    capPaint = makeTexture(pixels);
    capDetail = makeTexture(detail);
    capEmission = makeTexture(emission);
  }
  const texture = capPaint;
  const projectPaint = (geometry: THREE.BufferGeometry) => {
    const positions = geometry.getAttribute('position');
    const uv = new Float32Array(positions.count*2);
    for (let i = 0; i < positions.count; i++) {
      uv[2*i] = positions.getX(i)/p.width+.5;
      uv[2*i+1] = positions.getZ(i)/p.width+.5;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv,2));
  };
  projectPaint(cap.geometry);
  cap.material.vertexColors = false;
  cap.material.map = texture;
  cap.material.emissiveMap = capEmission!;
  cap.material.bumpMap = capDetail!;
  cap.material.bumpScale = Math.min(p.width*.003,lip*.3);
  cap.material.roughnessMap = capDetail!;
  cap.material.roughness = 1;
  // The rolled edge uses the cap's paint, bump and roughness continuously.
  const rim = surface(10,192,(t,a) => {
    const thickness = lipAt(a);
    const arc = t*Math.PI, radius = edgeRadius(a)-thickness+thickness*Math.sin(arc);
    return { point: [radius*Math.cos(a),edgeY(a)+thickness*Math.cos(arc),radius*Math.sin(a)], color: purple };
  },0,true);
  projectPaint(rim.geometry);
  rim.material.dispose();
  rim.material = cap.material.clone();
  rim.material.emissiveIntensity = 0;
  // A clone does not carry `onBeforeCompile`.
  patch(rim.material);
  // Average the join normals so the edge does not read as a separate trim.
  const capNormals = cap.geometry.getAttribute('normal');
  const rimNormals = rim.geometry.getAttribute('normal');
  const normal = new THREE.Vector3(), other = new THREE.Vector3();
  for (let i = 0; i <= 192; i++) {
    const last = 48*193+i;
    normal.fromBufferAttribute(capNormals,last);
    other.fromBufferAttribute(rimNormals,i);
    normal.add(other).normalize();
    capNormals.setXYZ(last,normal.x,normal.y,normal.z);
    rimNormals.setXYZ(i,normal.x,normal.y,normal.z);
  }
  surface(24,384,(t,a) => {
    const thickness = lipAt(a);
    const radius = (edgeRadius(a)-thickness)*t;
    const ridge = (.5+.5*Math.cos(a*48+.35*Math.sin(t*5)))**6;
    const fold = Math.sin(t*Math.PI);
    return { point: [radius*Math.cos(a),-thickness+edgeY(a)*t*t-lip*4.6*ridge*fold,radius*Math.sin(a)],
      color: dark.clone().lerp(cyan,.18+.65*ridge*fold) };
  // The gills glow by their paint: the cyan ridges bright, the dark troughs
  // between them barely, so the folds read in light of their own.
  },2);
  surface(40,64,(t,a) => {
    const fiber = Math.sin(a*27+t*7)*Math.sin(a*11-t*13);
    const radius = p.width*(.026+.022*(1-t)**5+.038*t**8)*(1+.008*fiber+.025*Math.sin(a*3+t*4));
    const bend = Math.sin(t*Math.PI);
    return { point: [p.width*.045*bend+radius*Math.cos(a),-p.stemHeight+(p.stemHeight-lip)*t,
      p.width*.022*bend*Math.sin(t*3)+radius*Math.sin(a)],
      color: dark.clone().lerp(cyan,.16+.48*t+.012*fiber) };
  },.025);
  return group;
}
