// The glass ball's surface wear: fingerprints, wiped smears and dust, BAKED
// once into a cube texture in the ball's own frame (Tris, 2026-10-16: "slight
// surface imperfections/smudge/dust marks ... as realistic as possible ... use
// best-practice methods ... without making performance concessions").
//
// WHY BAKED. Wear is detail at a scale far below a pixel at the play camera: a
// fingerprint ridge is half a millimetre, a speck of dust a tenth of one, and
// the whole 24 cm ball is a few dozen pixels across. Evaluated in the ball's
// shader every frame, that detail is either aliased (shimmering specks as the
// ball turns) or paid for with supersampling on every pixel of every frame.
// Baked once, at a resolution that resolves it, and MIPMAPPED, the hardware's
// trilinear filter hands each pixel the average of exactly the wear it covers:
// a grey haze of dust and a duller patch where a thumb pressed, from across the
// level, and the ridges of the print up close. The ball's shader pays one
// filtered texture read for all of it.
//
// WHY A CUBE. The ball is a sphere, and a cube map is the parameterisation of
// a sphere with no poles to pinch and no seam to hide: the shader reads it by
// the surface's direction from the ball's centre, in the ball's own frame, so
// the wear rolls with the ball.
//
// WHAT IS IN IT, per texel (RGBA, 0..1):
//
//   R - GREASE: skin oil left by a fingerprint's ridges, a smear wiped across
//       the glass, and a faint film everywhere a hand has been. Grease turns a
//       polished surface rough, so it blurs the reflection and hazes the view
//       through (see `solidGlassMaterial`).
//   G - DUST COVERAGE: the share of the texel covered by dust - specks in three
//       size classes, clumped rather than even, and lint fibres.
//   B - DUST ALBEDO: how light the dust there is (mineral grey to near white).
//   A - SCUFFS: the share of the texel scratched - fine scratches everywhere
//       and abraded patches of parallel ones (see `scuffs`).
//
// Every quantity is in METRES on the ball's surface (`uRadius` converts), so a
// print is a thumb's size on the ball whatever the resolution.
//
// The marks are placed from a fixed seed, so every glass ball - and every
// screenshot of one - wears the same history.

import * as THREE from "three";

// Texels per cube face: 1024 puts a texel at 0.18 mm on the 12 cm ball, which
// resolves a fingerprint's 0.45 mm ridges; the bake takes 2x2 samples per
// texel and spreads every mark finer than a texel over one, so it lands as its
// true coverage rather than a coin toss.
const FACE_SIZE = 1024;

// How many marks of each kind the ball carries. A 24 cm sphere has 0.18 m² of
// surface and a print covers about 2 cm² of it, so it takes a couple of dozen
// for a handled ball to show a few on the side facing the camera.
// Four prints: twenty-two read as too many (Tris, 2026-10-16: "reduce the
// fingerprints by 80%").
const PRINTS = 4;
// Two wipes (and with them two abraded patches, see `scuffs`): twelve read as
// too many streaks (Tris, 2026-10-16: "reduce the wipes by 80%").
const SMEARS = 2;

// A fixed-seed generator (mulberry32).
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    let t = (s = (s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A random point on the sphere and a tangent frame there, twisted at random.
function frameAt(random: () => number): { c: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 } {
  const z = random() * 2 - 1;
  const a = random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  const c = new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z);
  const helper = Math.abs(c.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u0 = new THREE.Vector3().crossVectors(helper, c).normalize();
  const v0 = new THREE.Vector3().crossVectors(c, u0);
  const twist = random() * Math.PI * 2;
  const u = u0.clone().multiplyScalar(Math.cos(twist)).addScaledVector(v0, Math.sin(twist));
  const v = new THREE.Vector3().crossVectors(c, u);
  return { c, u, v };
}

const BAKE_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const BAKE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform float uRadius;
// A texel's size on the surface (m), which a sub-texel mark's edge is spread
// over.
uniform float uTexel;
uniform vec3 uPrintC[ ${PRINTS} ];
uniform vec3 uPrintU[ ${PRINTS} ];
uniform vec3 uPrintV[ ${PRINTS} ];
// Per print: half-width, half-height (m), how much was wiped off it (0..1),
// and a seed.
uniform vec4 uPrint[ ${PRINTS} ];
uniform vec3 uSmearC[ ${SMEARS} ];
uniform vec3 uSmearU[ ${SMEARS} ];
uniform vec3 uSmearV[ ${SMEARS} ];
// Per smear: half-length, half-width (m), strength, seed.
uniform vec4 uSmear[ ${SMEARS} ];

float hash13( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}
vec3 hash33( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}
float noise3( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( hash13( i ), hash13( i + vec3( 1, 0, 0 ) ), f.x ), mix( hash13( i + vec3( 0, 1, 0 ) ), hash13( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( hash13( i + vec3( 0, 0, 1 ) ), hash13( i + vec3( 1, 0, 1 ) ), f.x ), mix( hash13( i + vec3( 0, 1, 1 ) ), hash13( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
    f.z );
}
float fbm3( vec3 p ) {
  float a = 0.0, w = 0.5;
  for ( int i = 0; i < 5; i ++ ) { a += w * noise3( p ); p = p * 2.03 + 17.1; w *= 0.5; }
  return a;
}

// ONE FINGERPRINT at the surface point p (metres), in its own tangent frame.
// A print is the ridge pattern of a fingertip pressed and lifted: ridges about
// 0.45 mm apart flowing round a core (a whorl, its flow bent by a slow warp so
// no two read alike), deposited as grease along the ridges, densest in the
// middle of the pad and breaking up toward its edge, where the finger met the
// curve of the ball less firmly. Some prints are part-wiped: their ridges
// smeared into a film.
float fingerprint( vec3 p, int i ) {
  vec3 c = uPrintC[ i ] * uRadius;
  vec3 d = p - c;
  if ( dot( normalize( p ), uPrintC[ i ] ) < 0.0 ) return 0.0;
  vec2 q = vec2( dot( d, uPrintU[ i ] ), dot( d, uPrintV[ i ] ) );
  vec4 k = uPrint[ i ];
  vec2 e = q / k.xy;
  float pad = length( e );
  if ( pad > 1.25 ) return 0.0;
  // The pad's outline, ragged.
  float edge = 1.0 - smoothstep( 0.7, 1.05 + 0.15 * ( noise3( vec3( q * 900.0, k.w ) ) - 0.5 ), pad );
  // Ridge flow: a whorl round a core off the pad's centre, warped.
  vec2 core = q - vec2( 0.0, k.y * 0.15 );
  float warp = fbm3( vec3( q * 160.0, k.w ) ) - 0.5;
  float flow = length( core * vec2( 1.0, 0.82 ) ) + warp * 0.0016 + 0.0004 * sin( atan( core.y, core.x ) * 2.0 + k.w );
  float ridge = 0.5 + 0.5 * cos( 6.2831853 * flow / 0.00045 );
  ridge = smoothstep( 0.25, 0.85, ridge );
  // Where the ridge left more or less oil, and the breaks in the ridges.
  float deposit = smoothstep( 0.3, 0.75, noise3( vec3( q * 2200.0, k.w + 4.0 ) ) );
  float pressed = edge * ( 0.55 + 0.45 * smoothstep( 1.0, 0.2, pad ) );
  float sharp = ridge * mix( 0.45, 1.0, deposit );
  // A part-wiped print is a film where its ridges were.
  return pressed * mix( sharp, 0.35, k.z );
}

// ONE SMEAR: a wipe across the glass with a cloth or a palm - a band of grease
// drawn out in fine parallel streaks, heavier at the start of the stroke and
// thinning toward its end.
float smear( vec3 p, int i ) {
  vec3 c = uSmearC[ i ] * uRadius;
  vec3 d = p - c;
  if ( dot( normalize( p ), uSmearC[ i ] ) < 0.0 ) return 0.0;
  vec2 q = vec2( dot( d, uSmearU[ i ] ), dot( d, uSmearV[ i ] ) );
  vec4 k = uSmear[ i ];
  // A gently curving stroke.
  q.y += 0.12 * q.x * q.x / k.x;
  float along = q.x / k.x;
  if ( abs( along ) > 1.0 ) return 0.0;
  float across = abs( q.y ) / ( k.y * ( 0.75 + 0.25 * noise3( vec3( q.x * 200.0, k.w, 0.0 ) ) ) );
  float band = 1.0 - smoothstep( 0.55, 1.0, across );
  float ends = smoothstep( 1.0, 0.75, abs( along ) ) * mix( 1.0, 0.45, along * 0.5 + 0.5 );
  float streaks = noise3( vec3( q.y * 5200.0, q.x * 40.0, k.w ) );
  streaks = 0.35 + 0.65 * smoothstep( 0.25, 0.8, streaks );
  return k.z * band * ends * streaks;
}

// DUST at p: specks in three size classes, gathered in clumps rather than
// spread evenly (dust settles and is rubbed into patches), plus lint fibres.
// Returns coverage (x) and albedo (y).
vec2 dust( vec3 p ) {
  float clump = smoothstep( 0.35, 0.75, fbm3( p * 45.0 ) );
  float cover = 0.0;
  float albedo = 0.0;
  // cell size (m), share of cells holding a speck, speck radius range (m).
  // Household dust: grains of a few hundredths to a fifth of a millimetre,
  // which no camera here resolves - what they make is a faint, uneven haze. A
  // class of millimetre grains was tried and read as "random white dots"
  // (Tris, 2026-10-16): grit that size on a glass ball is a thing one wipes
  // off.
  // Sparse: a fifth of the first pass, which read as too dusty (Tris,
  // 2026-10-16: "reduce the dust by 80%").
  vec4 classes[ 2 ];
  classes[ 0 ] = vec4( 0.0006, 0.06, 0.00003, 0.00009 );
  classes[ 1 ] = vec4( 0.0016, 0.024, 0.00009, 0.00020 );
  for ( int k = 0; k < 2; k ++ ) {
    vec4 cl = classes[ k ];
    vec3 cell = floor( p / cl.x );
    for ( int x = -1; x <= 1; x ++ ) for ( int y = -1; y <= 1; y ++ ) for ( int z = -1; z <= 1; z ++ ) {
      vec3 id = cell + vec3( x, y, z ) + float( k ) * 101.0;
      vec3 h = hash33( id );
      float share = cl.y * mix( 0.25, 1.6, clump );
      if ( hash13( id + 7.7 ) > share ) continue;
      vec3 at = ( cell + vec3( x, y, z ) + h ) * cl.x;
      float r = mix( cl.z, cl.w, h.x * h.x );
      vec3 o = p - at;
      float dist = length( o );
      if ( dist > r * 1.3 + uTexel ) continue;
      // An irregular grain, not a disc, its edge spread over a texel so a
      // grain smaller than one lands as the share of it that it covers.
      float rr = r * ( 0.75 + 0.5 * noise3( normalize( o + 1e-9 ) * 3.0 + id ) );
      float inside = ( 1.0 - smoothstep( rr - 0.5 * uTexel, rr + 0.5 * uTexel, dist ) ) * min( 1.0, rr / uTexel );
      if ( inside > cover ) { cover = inside; albedo = mix( 0.3, 0.55, h.y ); }
    }
  }
  // Lint: a few thin curled fibres, a millimetre or three long.
  vec3 cell = floor( p / 0.008 );
  for ( int x = -1; x <= 1; x ++ ) for ( int y = -1; y <= 1; y ++ ) for ( int z = -1; z <= 1; z ++ ) {
    vec3 id = cell + vec3( x, y, z ) + 503.0;
    if ( hash13( id ) > 0.008 ) continue;
    vec3 h = hash33( id );
    vec3 at = ( cell + vec3( x, y, z ) + h ) * 0.008;
    vec3 dir = normalize( hash33( id + 3.3 ) - 0.5 );
    vec3 o = p - at;
    float t = clamp( dot( o, dir ), - 0.0015, 0.0015 );
    vec3 bend = normalize( cross( dir, normalize( p ) ) ) * 0.0004 * sin( t * 2200.0 + h.z * 6.0 );
    float dist = length( o - dir * t - bend );
    // A fibre 0.02 mm thick is a tenth of a texel: what lands is its share.
    float fibre = ( 1.0 - smoothstep( 0.0, uTexel, dist ) ) * min( 1.0, 0.00002 / uTexel );
    if ( fibre > cover ) { cover = fibre; albedo = 0.5; }
  }
  return vec2( cover, albedo );
}

// SCUFFS at p: what a glass ball that has been rolled, set down and knocked
// about carries - fine scratches everywhere, a few millimetres long, at every
// angle, and here and there an ABRADED patch where it was dragged across
// something, a dense run of parallel scratches. A scratch is a groove a few
// hundredths of a millimetre wide whose walls scatter light, so what lands here
// is its coverage of the texel, which the shader turns into roughness and a
// bright scatter (it is why a scratch shows as a fine white line in a glint).
float scuffs( vec3 p ) {
  float cover = 0.0;
  // Scattered scratches.
  vec3 cell = floor( p / 0.004 );
  for ( int x = -1; x <= 1; x ++ ) for ( int y = -1; y <= 1; y ++ ) for ( int z = -1; z <= 1; z ++ ) {
    vec3 id = cell + vec3( x, y, z ) + 911.0;
    if ( hash13( id ) > 0.45 ) continue;
    vec3 h = hash33( id );
    vec3 at = ( cell + vec3( x, y, z ) + h ) * 0.004;
    vec3 o = p - at;
    float half_ = mix( 0.0008, 0.0045, h.z * h.z );
    if ( length( o ) > half_ + uTexel ) continue;
    vec3 dir = normalize( cross( normalize( hash33( id + 2.2 ) - 0.5 ), normalize( p ) ) );
    float t = clamp( dot( o, dir ), - half_, half_ );
    float dist = length( o - dir * t );
    float width = mix( 0.00001, 0.00004, h.x );
    // Fading out toward its ends, as a scratch shallows.
    float depth = 1.0 - pow( abs( t ) / half_, 4.0 );
    float line = ( 1.0 - smoothstep( 0.0, uTexel, dist ) ) * min( 1.0, width / uTexel ) * depth;
    cover = max( cover, line * mix( 0.5, 1.0, h.y ) );
  }
  // Abraded patches: parallel scratches in a band, the grooves of varying
  // depth. One per smear, placed at the smear's frame turned through a fixed
  // permutation of the axes - an orthogonal map, so the frame stays a frame,
  // and the patch lands somewhere else on the ball than its smear.
  for ( int i = 0; i < ${SMEARS}; i ++ ) {
    vec3 c = uSmearC[ i ].zxy * uRadius;
    if ( dot( normalize( p ), normalize( c ) ) < 0.0 ) continue;
    vec3 d = p - c;
    vec2 q = vec2( dot( d, uSmearV[ i ].zxy ), dot( d, uSmearU[ i ].zxy ) );
    float patch_ = 1.0 - smoothstep( 0.4, 1.0, length( q / vec2( 0.012, 0.006 ) ) + 0.3 * ( noise3( vec3( q * 300.0, float( i ) ) ) - 0.5 ) );
    if ( patch_ <= 0.0 ) continue;
    float grooves = smoothstep( 0.55, 0.9, noise3( vec3( q.y * 9000.0, q.x * 60.0, float( i ) ) ) );
    cover = max( cover, patch_ * grooves * 0.8 );
  }
  return cover;
}

vec4 wearAt( vec3 dir ) {
  vec3 p = normalize( dir ) * uRadius;
  // The film of handling over everything: no part of a glass ball that has
  // been held is optically clean, and the film is uneven - thicker where it
  // was held, thinner where it was wiped. Light: at 0.1-0.4 it read as fog
  // over the whole ball (Tris, 2026-10-16: "a bit less foggy").
  float grease = 0.04 + 0.12 * smoothstep( 0.25, 0.85, fbm3( p * 22.0 ) );
  for ( int i = 0; i < ${PRINTS}; i ++ ) grease = max( grease, fingerprint( p, i ) );
  for ( int i = 0; i < ${SMEARS}; i ++ ) grease = max( grease, smear( p, i ) );
  vec2 d = dust( p );
  return vec4( grease, d.x, d.y, scuffs( p ) );
}

void main() {
  // 2x2 samples over this texel's footprint, each of which already smooths a
  // speck's edge over a texel (\`uTexel\`): detail finer than a texel lands as
  // its coverage, and the mip chain built from this averages it on down.
  vec3 dx = dFdx( vDir );
  vec3 dy = dFdy( vDir );
  vec4 sum = vec4( 0.0 );
  for ( int i = 0; i < 2; i ++ ) for ( int j = 0; j < 2; j ++ ) {
    vec2 o = ( vec2( i, j ) + 0.5 ) / 2.0 - 0.5;
    sum += wearAt( vDir + dx * o.x + dy * o.y );
  }
  vec4 w = sum / 4.0;
  // Albedo is only meaningful where there is dust; carry it un-premultiplied.
  w.b = w.g > 0.0 ? clamp( w.b / max( w.g, 1e-4 ), 0.0, 1.0 ) * step( 1e-4, w.g ) : 0.0;
  gl_FragColor = w;
}
`;

// Bake the wear for a ball of `radius` metres, once, with `renderer`. The
// returned cube is mipmapped and lives for the page.
export function bakeGlassWear(renderer: THREE.WebGLRenderer, radius: number): THREE.CubeTexture {
  const random = rng(0x5eed61a5);
  const printC: THREE.Vector3[] = [];
  const printU: THREE.Vector3[] = [];
  const printV: THREE.Vector3[] = [];
  const print: THREE.Vector4[] = [];
  for (let i = 0; i < PRINTS; i++) {
    const f = frameAt(random);
    printC.push(f.c);
    printU.push(f.u);
    printV.push(f.v);
    // A fingertip's pad, 13-17 mm by 16-21 mm; most crisp, some part-wiped.
    print.push(
      new THREE.Vector4(
        0.0065 + 0.002 * random(),
        0.008 + 0.0025 * random(),
        random() < 0.4 ? 0.4 + 0.5 * random() : 0.1 * random(),
        random() * 100,
      ),
    );
  }
  const smearC: THREE.Vector3[] = [];
  const smearU: THREE.Vector3[] = [];
  const smearV: THREE.Vector3[] = [];
  const smears: THREE.Vector4[] = [];
  for (let i = 0; i < SMEARS; i++) {
    const f = frameAt(random);
    smearC.push(f.c);
    smearU.push(f.u);
    smearV.push(f.v);
    // A wipe 4-9 cm long and 1.2-2.4 cm wide - a palm or a cloth dragged
    // across - lighter than a pressed print.
    smears.push(new THREE.Vector4(0.02 + 0.025 * random(), 0.006 + 0.006 * random(), 0.4 + 0.35 * random(), random() * 100));
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERTEX,
    fragmentShader: BAKE_FRAGMENT,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uRadius: { value: radius },
      // A face spans a quarter turn of the sphere; at its centre a texel is
      // that arc over the face's width.
      uTexel: { value: ((Math.PI / 2) * radius) / FACE_SIZE },
      uPrintC: { value: printC },
      uPrintU: { value: printU },
      uPrintV: { value: printV },
      uPrint: { value: print },
      uSmearC: { value: smearC },
      uSmearU: { value: smearU },
      uSmearV: { value: smearV },
      uSmear: { value: smears },
    },
  });
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));

  const target = new THREE.WebGLCubeRenderTarget(FACE_SIZE, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  // Data, not colour: read back exactly as written.
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.name = "glass-wear";
  const camera = new THREE.CubeCamera(0.1, 10, target);

  const autoClear = renderer.autoClear;
  const shadows = renderer.shadowMap.autoUpdate;
  renderer.autoClear = true;
  renderer.shadowMap.autoUpdate = false;
  try {
    camera.update(renderer, scene);
  } finally {
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadows;
    geometry.dispose();
    material.dispose();
  }
  return target.texture;
}
