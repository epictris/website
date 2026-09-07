// Deterministic libm: the transcendental functions the simulation is allowed
// to call.
//
// ECMAScript leaves `Math.sin`, `Math.cos`, `Math.exp`, `Math.pow` and the rest
// of the transcendentals IMPLEMENTATION-DEFINED. V8 ships fdlibm ports for
// some, glibc's for others and LLVM libc's since mid-2026; JavaScriptCore (bun,
// Safari) calls the platform libm; SpiderMonkey carries its own fdlibm fork.
// They agree to within an ulp and disagree in the last bit, and a physics step
// that tests `depth > 0` on a 1e-17 m overlap turns that last bit into a
// different branch and a different game (`session-1052f` f379, where bun left
// the browser's recording). Every recorded replay is therefore only evidence
// on the engine it was made on - unless the sim never asks the engine.
//
// This module is that. It is a port of fdlibm 5.3 (Sun Microsystems, 1993,
// via the FreeBSD msun / V8 `ieee754.cc` lineage) - the same code Java's
// `StrictMath` mandates for exactly this reason - written against the parts
// of IEEE 754 that ECMAScript DOES pin down: `+ - * /` and `Math.sqrt` are
// correctly rounded to double on every engine, no engine contracts to FMA or
// evaluates in extended precision, and integer bit-twiddling is exact. Given
// those, this file computes the same bits everywhere.
//
// Two rules keep it honest:
// - Every non-trivial constant is built from its hex bit pattern (`W`),
//   never a decimal literal: the spec only guarantees correctly rounded
//   parsing up to 20 significant digits and fdlibm prints 21.
// - The sim never calls the banned `Math` members. `cli dmath` scans for them
//   and checks this file against committed bit-exact vectors, so a change
//   that alters a single ulp - here or in the engine underneath - is a red
//   case rather than a replay that quietly diverges.
//
// fdlibm licence: "Copyright (C) 1993 by Sun Microsystems, Inc. All rights
// reserved. Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved." (See
// THIRD-PARTY-NOTICES.md at the repository root.)

// ---------------------------------------------------------------------------
// Bit access. One scratch double and its two 32-bit words, with the word
// order resolved once from the platform's endianness rather than assumed.
// ---------------------------------------------------------------------------

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LITTLE_ENDIAN ? 1 : 0;
const LO = LITTLE_ENDIAN ? 0 : 1;

// High word as a SIGNED int32 (fdlibm's `hx`): the sign bit falls out of `< 0`.
function hi(x: number): number {
  f64[0] = x;
  return u32[HI]! | 0;
}

// Low word as an unsigned int (fdlibm's `lx`).
function lo(x: number): number {
  f64[0] = x;
  return u32[LO]!;
}

// A double from its two words (`INSERT_WORDS`). Either word may be given as a
// negative int32; the typed array stores it modulo 2^32, which is the bit
// pattern intended.
function W(h: number, l: number): number {
  u32[HI] = h;
  u32[LO] = l;
  return f64[0]!;
}

function setHi(x: number, h: number): number {
  f64[0] = x;
  u32[HI] = h;
  return f64[0]!;
}

function setLo(x: number, l: number): number {
  f64[0] = x;
  u32[LO] = l;
  return f64[0]!;
}

// Truncation toward zero to an int, the C `static_cast<int32_t>(double)` every
// fdlibm routine uses for values it has already bounded.
const trunc = Math.trunc;
const abs = Math.abs;
const sqrt = Math.sqrt;
const floor = Math.floor;

const HUGE = 1.0e300;
const TINY = 1.0e-300;
const TWO24 = W(0x41700000, 0);
const TWON24 = W(0x3e700000, 0);
const TWO54 = W(0x43500000, 0);
const TWOM54 = W(0x3c900000, 0);
const TWO53 = W(0x43400000, 0);
const LN2_HI = W(0x3fe62e42, 0xfee00000);
const LN2_LO = W(0x3dea39ef, 0x35793c76);
const INVLN2 = W(0x3ff71547, 0x652b82fe);
const PIO2_HI = W(0x3ff921fb, 0x54442d18);
const PIO2_LO = W(0x3c91a626, 0x33145c07);
const PIO4_HI = W(0x3fe921fb, 0x54442d18);
const PI = W(0x400921fb, 0x54442d18);
const PI_LO = W(0x3ca1a626, 0x33145c07);

// ---------------------------------------------------------------------------
// scalbn(x, n) = x * 2^n, exact, with fdlibm's over/underflow handling.
// ---------------------------------------------------------------------------

export function scalbn(x: number, n: number): number {
  let hx = hi(x);
  const lx = lo(x);
  let k = (hx & 0x7ff00000) >> 20;
  if (k === 0) {
    // 0 or subnormal
    if ((lx | (hx & 0x7fffffff)) === 0) return x;
    x *= TWO54;
    hx = hi(x);
    k = ((hx & 0x7ff00000) >> 20) - 54;
    if (n < -50000) return TINY * x;
  }
  if (k === 0x7ff) return x + x; // NaN or Inf
  k = k + n;
  if (k > 0x7fe) return HUGE * (hx < 0 ? -HUGE : HUGE);
  if (k > 0) return setHi(x, (hx & 0x800fffff) | (k << 20));
  if (k <= -54) {
    if (n > 50000) return HUGE * (hx < 0 ? -HUGE : HUGE);
    return TINY * (hx < 0 ? -TINY : TINY);
  }
  k += 54;
  x = setHi(x, (hx & 0x800fffff) | (k << 20));
  return x * TWOM54;
}

// ---------------------------------------------------------------------------
// Argument reduction: x rem pi/2, in y[0] + y[1], returning n mod 8.
// ---------------------------------------------------------------------------

// 2/pi as 24-bit chunks, 396 hex digits of it.
const TWO_OVER_PI = new Int32Array([
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62, 0x95993c, 0x439041, 0xfe5163,
  0xabdebb, 0xc561b7, 0x246e3a, 0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129,
  0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c, 0x7026b4, 0x5f7e41, 0x3991d6, 0x398353, 0x39f49c,
  0x845f8b, 0xbdf928, 0x3b1ff8, 0x97ffde, 0x05980f, 0xef2f11, 0x8b5a0a, 0x6d1f6d, 0x367ecf,
  0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5, 0xf17b3d, 0x0739f7, 0x8a5292,
  0xea6bfb, 0x5fb11f, 0x8d5d08, 0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3,
  0x91615e, 0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880, 0x4d7327, 0x310606, 0x1556ca,
  0x73a8c9, 0x60e27b, 0xc08c6b,
]);

// High words of n*pi/2 for n = 1..32.
const NPIO2_HW = new Int32Array([
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb,
  0x402921fb, 0x402c463a, 0x402f6a7a, 0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb,
  0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a, 0x40407e4c,
  0x4041475c, 0x4042106c, 0x4042d97c, 0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb,
  0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb,
]);

// pi/2 in 24-bit chunks.
const PIO2_CHUNKS = [
  W(0x3ff921fb, 0x40000000),
  W(0x3e74442d, 0x00000000),
  W(0x3cf84698, 0x80000000),
  W(0x3b78cc51, 0x60000000),
  W(0x39f01b83, 0x80000000),
  W(0x387a2520, 0x40000000),
  W(0x36e38222, 0x80000000),
  W(0x3569f31d, 0x00000000),
];

const INVPIO2 = W(0x3fe45f30, 0x6dc9c883); // 53 bits of 2/pi
const PIO2_1 = W(0x3ff921fb, 0x54400000); // first 33 bits of pi/2
const PIO2_1T = W(0x3dd0b461, 0x1a626331); // pi/2 - pio2_1
const PIO2_2 = W(0x3dd0b461, 0x1a600000); // second 33 bits of pi/2
const PIO2_2T = W(0x3ba3198a, 0x2e037073); // pi/2 - (pio2_1+pio2_2)
const PIO2_3 = W(0x3ba3198a, 0x2e000000); // third 33 bits of pi/2
const PIO2_3T = W(0x397b839a, 0x252049c1); // pi/2 - (pio2_1+pio2_2+pio2_3)

// Scratch for the reduction: the reduced argument as a head and a tail.
const remY = new Float64Array(2);
const remTx = new Float64Array(3);

// __kernel_rem_pio2 at fdlibm's "extended" precision (prec = 2, jk = 4), the
// only precision the double routines call it at. `x` holds the argument as
// `nx` 24-bit pieces, scaled by 2^e0; the result lands in `y` and the return
// value is n mod 8.
const krIq = new Int32Array(20);
const krF = new Float64Array(20);
const krFq = new Float64Array(20);
const krQ = new Float64Array(20);

function kernelRemPio2(x: Float64Array, y: Float64Array, e0: number, nx: number): number {
  const jk = 4;
  const jp = jk;
  const iq = krIq;
  const f = krF;
  const fq = krFq;
  const q = krQ;
  let i: number, j: number, k: number, m: number;
  let z: number, fw: number;
  let n = 0;
  let ih = 0;

  const jx = nx - 1;
  let jv = trunc((e0 - 3) / 24);
  if (jv < 0) jv = 0;
  let q0 = e0 - 24 * (jv + 1);

  // f[0..jx+jk] = ipio2[jv-jx .. jv+jk], zero below index 0.
  j = jv - jx;
  m = jx + jk;
  for (i = 0; i <= m; i++, j++) f[i] = j < 0 ? 0 : TWO_OVER_PI[j]!;

  // q[0..jk]
  for (i = 0; i <= jk; i++) {
    for (j = 0, fw = 0; j <= jx; j++) fw += x[j]! * f[jx + i - j]!;
    q[i] = fw;
  }

  let jz = jk;
  for (;;) {
    // Distill q[] into iq[] reversingly.
    for (i = 0, j = jz, z = q[jz]!; j > 0; i++, j--) {
      fw = trunc(TWON24 * z);
      iq[i] = trunc(z - TWO24 * fw);
      z = q[j - 1]! + fw;
    }

    // Compute n.
    z = scalbn(z, q0);
    z -= 8 * floor(z * 0.125);
    n = trunc(z);
    z -= n;
    ih = 0;
    if (q0 > 0) {
      i = iq[jz - 1]! >> (24 - q0);
      n += i;
      iq[jz - 1] = iq[jz - 1]! - (i << (24 - q0));
      ih = iq[jz - 1]! >> (23 - q0);
    } else if (q0 === 0) {
      ih = iq[jz - 1]! >> 23;
    } else if (z >= 0.5) {
      ih = 2;
    }

    if (ih > 0) {
      // q > 0.5
      n += 1;
      let carry = 0;
      for (i = 0; i < jz; i++) {
        // compute 1-q
        j = iq[i]!;
        if (carry === 0) {
          if (j !== 0) {
            carry = 1;
            iq[i] = 0x1000000 - j;
          }
        } else {
          iq[i] = 0xffffff - j;
        }
      }
      if (q0 > 0) {
        // rare case: chance is 1 in 12
        switch (q0) {
          case 1:
            iq[jz - 1] = iq[jz - 1]! & 0x7fffff;
            break;
          case 2:
            iq[jz - 1] = iq[jz - 1]! & 0x3fffff;
            break;
        }
      }
      if (ih === 2) {
        z = 1 - z;
        if (carry !== 0) z -= scalbn(1, q0);
      }
    }

    // Check whether recomputation is needed.
    if (z === 0) {
      j = 0;
      for (i = jz - 1; i >= jk; i--) j |= iq[i]!;
      if (j === 0) {
        for (k = 1; jk >= k && iq[jk - k] === 0; k++) {
          // k = number of terms needed
        }
        for (i = jz + 1; i <= jz + k; i++) {
          // add q[jz+1] to q[jz+k]
          f[jx + i] = TWO_OVER_PI[jv + i]!;
          for (j = 0, fw = 0; j <= jx; j++) fw += x[j]! * f[jx + i - j]!;
          q[i] = fw;
        }
        jz += k;
        continue;
      }
    }
    break;
  }

  // Chop off zero terms.
  if (z === 0) {
    jz -= 1;
    q0 -= 24;
    while (iq[jz] === 0) {
      jz--;
      q0 -= 24;
    }
  } else {
    // Break z into 24-bit pieces if necessary.
    z = scalbn(z, -q0);
    if (z >= TWO24) {
      fw = trunc(TWON24 * z);
      iq[jz] = z - TWO24 * fw;
      jz += 1;
      q0 += 24;
      iq[jz] = fw;
    } else {
      iq[jz] = z;
    }
  }

  // Convert integer "bit" chunks to floating-point values.
  fw = scalbn(1, q0);
  for (i = jz; i >= 0; i--) {
    q[i] = fw * iq[i]!;
    fw *= TWON24;
  }

  // Compute PIo2[0..jp] * q[jz..0].
  for (i = jz; i >= 0; i--) {
    for (fw = 0, k = 0; k <= jp && k <= jz - i; k++) fw += PIO2_CHUNKS[k]! * q[i + k]!;
    fq[jz - i] = fw;
  }

  // Compress fq[] into y[] (prec 2).
  fw = 0;
  for (i = jz; i >= 0; i--) fw += fq[i]!;
  y[0] = ih === 0 ? fw : -fw;
  fw = fq[0]! - fw;
  for (i = 1; i <= jz; i++) fw += fq[i]!;
  y[1] = ih === 0 ? fw : -fw;
  return n & 7;
}

// __ieee754_rem_pio2: x rem pi/2 into remY, returning n.
function remPio2(x: number): number {
  const y = remY;
  const hx = hi(x);
  const ix = hx & 0x7fffffff;
  let z: number, w: number, t: number, r: number, fn: number;
  let n: number;

  if (ix <= 0x3fe921fb) {
    // |x| ~<= pi/4, no reduction needed
    y[0] = x;
    y[1] = 0;
    return 0;
  }
  if (ix < 0x4002d97c) {
    // |x| < 3pi/4, special case with n = +-1
    if (hx > 0) {
      z = x - PIO2_1;
      if (ix !== 0x3ff921fb) {
        // 33+53 bit pi is good enough
        y[0] = z - PIO2_1T;
        y[1] = z - y[0]! - PIO2_1T;
      } else {
        // near pi/2, use 33+33+53 bit pi
        z -= PIO2_2;
        y[0] = z - PIO2_2T;
        y[1] = z - y[0]! - PIO2_2T;
      }
      return 1;
    }
    z = x + PIO2_1;
    if (ix !== 0x3ff921fb) {
      y[0] = z + PIO2_1T;
      y[1] = z - y[0]! + PIO2_1T;
    } else {
      z += PIO2_2;
      y[0] = z + PIO2_2T;
      y[1] = z - y[0]! + PIO2_2T;
    }
    return -1;
  }
  if (ix <= 0x413921fb) {
    // |x| ~<= 2^19*(pi/2), medium size
    t = abs(x);
    n = trunc(t * INVPIO2 + 0.5);
    fn = n;
    r = t - fn * PIO2_1;
    w = fn * PIO2_1T; // 1st round good to 85 bits
    if (n < 32 && ix !== NPIO2_HW[n - 1]) {
      y[0] = r - w; // quick check, no cancellation
    } else {
      const j = ix >> 20;
      y[0] = r - w;
      let i = j - ((hi(y[0]!) >>> 20) & 0x7ff);
      if (i > 16) {
        // 2nd iteration needed, good to 118 bits
        t = r;
        w = fn * PIO2_2;
        r = t - w;
        w = fn * PIO2_2T - (t - r - w);
        y[0] = r - w;
        i = j - ((hi(y[0]!) >>> 20) & 0x7ff);
        if (i > 49) {
          // 3rd iteration needed, 151 bits, covers every case
          t = r;
          w = fn * PIO2_3;
          r = t - w;
          w = fn * PIO2_3T - (t - r - w);
          y[0] = r - w;
        }
      }
    }
    y[1] = r - y[0]! - w;
    if (hx < 0) {
      y[0] = -y[0]!;
      y[1] = -y[1]!;
      return -n;
    }
    return n;
  }

  // All other (large) arguments.
  if (ix >= 0x7ff00000) {
    // Inf or NaN
    y[0] = y[1] = x - x;
    return 0;
  }
  // z = scalbn(|x|, ilogb(x) - 23)
  const e0 = (ix >> 20) - 1046;
  z = W(ix - (e0 << 20), lo(x));
  const tx = remTx;
  for (let i = 0; i < 2; i++) {
    tx[i] = trunc(z);
    z = (z - tx[i]!) * TWO24;
  }
  tx[2] = z;
  let nx = 3;
  while (tx[nx - 1] === 0) nx--; // skip zero terms
  n = kernelRemPio2(tx, y, e0, nx);
  if (hx < 0) {
    y[0] = -y[0]!;
    y[1] = -y[1]!;
    return -n;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Kernels on [-pi/4, pi/4]. `y` is the tail of `x`.
// ---------------------------------------------------------------------------

const S1 = W(0xbfc55555, 0x55555549);
const S2 = W(0x3f811111, 0x1110f8a6);
const S3 = W(0xbf2a01a0, 0x19c161d5);
const S4 = W(0x3ec71de3, 0x57b1fe7d);
const S5 = W(0xbe5ae5e6, 0x8a2b9ceb);
const S6 = W(0x3de5d93a, 0x5acfd57c);

function kernelSin(x: number, y: number, iy: number): number {
  const ix = hi(x) & 0x7fffffff;
  if (ix < 0x3e400000) return x; // |x| < 2^-27
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

const C1 = W(0x3fa55555, 0x5555554c);
const C2 = W(0xbf56c16c, 0x16c15177);
const C3 = W(0x3efa01a0, 0x19cb1590);
const C4 = W(0xbe927e4f, 0x809c52ad);
const C5 = W(0x3e21ee9e, 0xbdb4b1c4);
const C6 = W(0xbda8fae9, 0xbe8838d4);

function kernelCos(x: number, y: number): number {
  const ix = hi(x) & 0x7fffffff;
  if (ix < 0x3e400000) return 1; // |x| < 2^-27
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y)); // |x| < 0.3
  const qx = ix > 0x3fe90000 ? 0.28125 : W(ix - 0x00200000, 0); // x > 0.78125 ? : x/4
  const iz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (iz - (z * r - x * y));
}

const TAN_T = [
  W(0x3fd55555, 0x55555563),
  W(0x3fc11111, 0x1110fe7a),
  W(0x3faba1ba, 0x1bb341fe),
  W(0x3f9664f4, 0x8406d637),
  W(0x3f8226e3, 0xe96e8493),
  W(0x3f6d6d22, 0xc9560328),
  W(0x3f57dbc8, 0xfee08315),
  W(0x3f4344d8, 0xf2f26501),
  W(0x3f3026f7, 0x1a8d1068),
  W(0x3f147e88, 0xa03792a6),
  W(0x3f12b80f, 0x32f0a7e9),
  W(0xbef375cb, 0xdb605373),
  W(0x3efb2a70, 0x74bf7ad4),
];
const PIO4 = W(0x3fe921fb, 0x54442d18);
const PIO4LO = W(0x3c81a626, 0x33145c07);

// iy = 1 returns tan(x+y); iy = -1 returns -1/tan(x+y).
function kernelTan(x: number, y: number, iy: number): number {
  const hx = hi(x);
  const ix = hx & 0x7fffffff;
  let z: number, r: number, v: number, w: number, s: number;
  if (ix < 0x3e300000) {
    // |x| < 2^-28
    if ((ix | lo(x) | (iy + 1)) === 0) return 1 / abs(x);
    if (iy === 1) return x;
    // compute -1 / (x+y) carefully
    z = w = x + y;
    z = setLo(z, 0);
    v = y - (z - x);
    let t: number;
    const a = (t = -1 / w);
    t = setLo(t, 0);
    s = 1 + t * z;
    return t + a * (s + t * v);
  }
  if (ix >= 0x3fe59428) {
    // |x| >= 0.6744
    if (hx < 0) {
      x = -x;
      y = -y;
    }
    z = PIO4 - x;
    w = PIO4LO - y;
    x = z + w;
    y = 0;
  }
  z = x * x;
  w = z * z;
  // Break x^5*(T[1]+x^2*T[2]+...) into odd and even parts.
  r = TAN_T[1]! + w * (TAN_T[3]! + w * (TAN_T[5]! + w * (TAN_T[7]! + w * (TAN_T[9]! + w * TAN_T[11]!))));
  v = z * (TAN_T[2]! + w * (TAN_T[4]! + w * (TAN_T[6]! + w * (TAN_T[8]! + w * (TAN_T[10]! + w * TAN_T[12]!)))));
  s = z * x;
  r = y + z * (s * (r + v) + y);
  r += TAN_T[0]! * s;
  w = x + r;
  if (ix >= 0x3fe59428) {
    v = iy;
    return (1 - ((hx >> 30) & 2)) * (v - 2 * (x - (w * w / (w + v) - r)));
  }
  if (iy === 1) return w;
  // compute -1.0 / (x+r) accurately
  z = setLo(w, 0);
  v = r - (z - x); // z+v = r+x
  let t: number;
  const a = (t = -1 / w);
  t = setLo(t, 0);
  s = 1 + t * z;
  return t + a * (s + t * v);
}

// ---------------------------------------------------------------------------
// Trigonometry.
// ---------------------------------------------------------------------------

export function sin(x: number): number {
  const ix = hi(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelSin(x, 0, 0); // |x| ~< pi/4
  if (ix >= 0x7ff00000) return x - x; // Inf or NaN
  const n = remPio2(x);
  const y0 = remY[0]!;
  const y1 = remY[1]!;
  switch (n & 3) {
    case 0:
      return kernelSin(y0, y1, 1);
    case 1:
      return kernelCos(y0, y1);
    case 2:
      return -kernelSin(y0, y1, 1);
    default:
      return -kernelCos(y0, y1);
  }
}

export function cos(x: number): number {
  const ix = hi(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelCos(x, 0);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x);
  const y0 = remY[0]!;
  const y1 = remY[1]!;
  switch (n & 3) {
    case 0:
      return kernelCos(y0, y1);
    case 1:
      return -kernelSin(y0, y1, 1);
    case 2:
      return -kernelCos(y0, y1);
    default:
      return kernelSin(y0, y1, 1);
  }
}

export function tan(x: number): number {
  const ix = hi(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelTan(x, 0, 1);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x);
  // 1 -> n even, -1 -> n odd
  return kernelTan(remY[0]!, remY[1]!, 1 - ((n & 1) << 1));
}

const ATANHI = [
  W(0x3fddac67, 0x0561bb4f), // atan(0.5)hi
  W(0x3fe921fb, 0x54442d18), // atan(1.0)hi
  W(0x3fef730b, 0xd281f69b), // atan(1.5)hi
  W(0x3ff921fb, 0x54442d18), // atan(inf)hi
];
const ATANLO = [
  W(0x3c7a2b7f, 0x222f65e2), // atan(0.5)lo
  W(0x3c81a626, 0x33145c07), // atan(1.0)lo
  W(0x3c700788, 0x7af0cbbd), // atan(1.5)lo
  W(0x3c91a626, 0x33145c07), // atan(inf)lo
];
const AT = [
  W(0x3fd55555, 0x5555550d),
  W(0xbfc99999, 0x9998ebc4),
  W(0x3fc24924, 0x920083ff),
  W(0xbfbc71c6, 0xfe231671),
  W(0x3fb745cd, 0xc54c206e),
  W(0xbfb3b0f2, 0xaf749a6d),
  W(0x3fb10d66, 0xa0d03d51),
  W(0xbfadde2d, 0x52defd9a),
  W(0x3fa97b4b, 0x24760deb),
  W(0xbfa2b444, 0x2c6a6c2f),
  W(0x3f90ad3a, 0xe322da11),
];

export function atan(x: number): number {
  const hx = hi(x);
  const ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) {
    // |x| >= 2^66
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lo(x) !== 0)) return x + x; // NaN
    if (hx > 0) return ATANHI[3]! + ATANLO[3]!;
    return -ATANHI[3]! - ATANLO[3]!;
  }
  if (ix < 0x3fdc0000) {
    // |x| < 0.4375
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    id = -1;
  } else {
    x = abs(x);
    if (ix < 0x3ff30000) {
      // |x| < 1.1875
      if (ix < 0x3fe60000) {
        // 7/16 <= |x| < 11/16
        id = 0;
        x = (2 * x - 1) / (2 + x);
      } else {
        // 11/16 <= |x| < 19/16
        id = 1;
        x = (x - 1) / (x + 1);
      }
    } else if (ix < 0x40038000) {
      // |x| < 2.4375
      id = 2;
      x = (x - 1.5) / (1 + 1.5 * x);
    } else {
      // 2.4375 <= |x| < 2^66
      id = 3;
      x = -1 / x;
    }
  }
  // end of argument reduction
  let z = x * x;
  const w = z * z;
  // break sum from i=0 to 10 aT[i]z**(i+1) into odd and even poly
  const s1 = z * (AT[0]! + w * (AT[2]! + w * (AT[4]! + w * (AT[6]! + w * (AT[8]! + w * AT[10]!)))));
  const s2 = w * (AT[1]! + w * (AT[3]! + w * (AT[5]! + w * (AT[7]! + w * AT[9]!))));
  if (id < 0) return x - x * (s1 + s2);
  z = ATANHI[id]! - (x * (s1 + s2) - ATANLO[id]! - x);
  return hx < 0 ? -z : z;
}

export function atan2(y: number, x: number): number {
  const hx = hi(x);
  const lx = lo(x);
  const ix = hx & 0x7fffffff;
  const hy = hi(y);
  const ly = lo(y);
  const iy = hy & 0x7fffffff;
  if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) || iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) {
    return x + y; // x or y is NaN
  }
  if (hx === 0x3ff00000 && lx === 0) return atan(y); // x = 1.0
  const m = ((hy >> 31) & 1) | ((hx >> 30) & 2); // 2*sign(x) + sign(y)

  // when y = 0
  if ((iy | ly) === 0) {
    switch (m) {
      case 0:
      case 1:
        return y; // atan(+-0, +anything) = +-0
      case 2:
        return PI + TINY; // atan(+0, -anything) = pi
      default:
        return -PI - TINY; // atan(-0, -anything) = -pi
    }
  }
  // when x = 0
  if ((ix | lx) === 0) return hy < 0 ? -PIO2_HI - TINY : PIO2_HI + TINY;
  // when x is INF
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0:
          return PIO4_HI + TINY; // atan(+INF, +INF)
        case 1:
          return -PIO4_HI - TINY; // atan(-INF, +INF)
        case 2:
          return 3 * PIO4_HI + TINY; // atan(+INF, -INF)
        default:
          return -3 * PIO4_HI - TINY; // atan(-INF, -INF)
      }
    }
    switch (m) {
      case 0:
        return 0; // atan(+..., +INF)
      case 1:
        return -0; // atan(-..., +INF)
      case 2:
        return PI + TINY; // atan(+..., -INF)
      default:
        return -PI - TINY; // atan(-..., -INF)
    }
  }
  // when y is INF
  if (iy === 0x7ff00000) return hy < 0 ? -PIO2_HI - TINY : PIO2_HI + TINY;

  // compute y/x
  const k = (iy - ix) >> 20;
  let z: number;
  let mm = m;
  if (k > 60) {
    // |y/x| > 2^60
    z = PIO2_HI + 0.5 * PI_LO;
    mm &= 1;
  } else if (hx < 0 && k < -60) {
    z = 0; // 0 > |y|/x > -2^-60
  } else {
    z = atan(abs(y / x)); // safe to do y/x
  }
  switch (mm) {
    case 0:
      return z; // atan(+, +)
    case 1:
      return -z; // atan(-, +)
    case 2:
      return PI - (z - PI_LO); // atan(+, -)
    default:
      return z - PI_LO - PI; // atan(-, -)
  }
}

const PS0 = W(0x3fc55555, 0x55555555);
const PS1 = W(0xbfd4d612, 0x03eb6f7d);
const PS2 = W(0x3fc9c155, 0x0e884455);
const PS3 = W(0xbfa48228, 0xb5688f3b);
const PS4 = W(0x3f49efe0, 0x7501b288);
const PS5 = W(0x3f023de1, 0x0dfdf709);
const QS1 = W(0xc0033a27, 0x1c8a2d4b);
const QS2 = W(0x40002ae5, 0x9c598ac8);
const QS3 = W(0xbfe6066c, 0x1b8d0159);
const QS4 = W(0x3fb3b8c5, 0xb12e9282);

export function asin(x: number): number {
  const hx = hi(x);
  const ix = hx & 0x7fffffff;
  let t = 0;
  let w: number, p: number, q: number, c: number, r: number, s: number;
  if (ix >= 0x3ff00000) {
    // |x| >= 1
    if (((ix - 0x3ff00000) | lo(x)) === 0) return x * PIO2_HI + x * PIO2_LO; // asin(1) = +-pi/2
    return NaN; // asin(|x|>1) is NaN
  }
  if (ix < 0x3fe00000) {
    // |x| < 0.5
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    t = x * x;
    p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
    q = 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
    w = p / q;
    return x + x * w;
  }
  // 1 > |x| >= 0.5
  w = 1 - abs(x);
  t = w * 0.5;
  p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
  q = 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
  s = sqrt(t);
  if (ix >= 0x3fef3333) {
    // |x| > 0.975
    w = p / q;
    t = PIO2_HI - (2 * (s + s * w) - PIO2_LO);
  } else {
    w = setLo(s, 0);
    c = (t - w * w) / (s + w);
    r = p / q;
    p = 2 * s * r - (PIO2_LO - 2 * c);
    q = PIO4_HI - 2 * w;
    t = PIO4_HI - (p - q);
  }
  return hx > 0 ? t : -t;
}

export function acos(x: number): number {
  const hx = hi(x);
  const ix = hx & 0x7fffffff;
  let z: number, p: number, q: number, r: number, w: number, s: number, c: number, df: number;
  if (ix >= 0x3ff00000) {
    // |x| >= 1
    if (((ix - 0x3ff00000) | lo(x)) === 0) {
      // |x| == 1
      if (hx > 0) return 0; // acos(1) = 0
      return PI + 2 * PIO2_LO; // acos(-1) = pi
    }
    return NaN; // acos(|x|>1) is NaN
  }
  if (ix < 0x3fe00000) {
    // |x| < 0.5
    if (ix <= 0x3c600000) return PIO2_HI + PIO2_LO; // |x| < 2^-57
    z = x * x;
    p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
    q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
    r = p / q;
    return PIO2_HI - (x - (PIO2_LO - x * r));
  }
  if (hx < 0) {
    // x < -0.5
    z = (1 + x) * 0.5;
    p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
    q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
    s = sqrt(z);
    r = p / q;
    w = r * s - PIO2_LO;
    return PI - 2 * (s + w);
  }
  // x > 0.5
  z = (1 - x) * 0.5;
  s = sqrt(z);
  df = setLo(s, 0);
  c = (z - df * df) / (s + df);
  p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
  q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
  r = p / q;
  w = r * s + c;
  return 2 * (df + w);
}

// ---------------------------------------------------------------------------
// Exponentials and logarithms.
// ---------------------------------------------------------------------------

const EXP_P1 = W(0x3fc55555, 0x5555553e);
const EXP_P2 = W(0xbf66c16c, 0x16bebd93);
const EXP_P3 = W(0x3f11566a, 0xaf25de2c);
const EXP_P4 = W(0xbebbbd41, 0xc5d26bf1);
const EXP_P5 = W(0x3e663769, 0x72bea4d0);
const E = W(0x4005bf0a, 0x8b145769);
const O_THRESHOLD = W(0x40862e42, 0xfefa39ef);
const U_THRESHOLD = W(0xc0874910, 0xd52d3051);
const TWOM1000 = W(0x01700000, 0);
const TWO1023 = W(0x7fe00000, 0);

export function exp(x: number): number {
  let hx = hi(x);
  const xsb = (hx >>> 31) & 1; // sign bit of x
  hx &= 0x7fffffff; // high word of |x|
  let k = 0;
  let hiPart = 0;
  let loPart = 0;
  let t: number;

  // filter out non-finite argument
  if (hx >= 0x40862e42) {
    // |x| >= 709.78...
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | lo(x)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0; // exp(+-inf) = {inf, 0}
    }
    if (x > O_THRESHOLD) return HUGE * HUGE; // overflow
    if (x < U_THRESHOLD) return TWOM1000 * TWOM1000; // underflow
  }

  // argument reduction
  if (hx > 0x3fd62e42) {
    // |x| > 0.5 ln2
    if (hx < 0x3ff0a2b2) {
      // and |x| < 1.5 ln2
      if (x === 1) return E;
      hiPart = x - (xsb === 0 ? LN2_HI : -LN2_HI);
      loPart = xsb === 0 ? LN2_LO : -LN2_LO;
      k = 1 - xsb - xsb;
    } else {
      k = trunc(INVLN2 * x + (xsb === 0 ? 0.5 : -0.5));
      t = k;
      hiPart = x - t * LN2_HI; // t*ln2HI is exact here
      loPart = t * LN2_LO;
    }
    x = hiPart - loPart;
  } else if (hx < 0x3e300000) {
    // |x| < 2^-28
    return 1 + x;
  } else {
    k = 0;
  }

  // x is now in primary range
  t = x * x;
  const twopk = k >= -1021 ? W(0x3ff00000 + (k << 20), 0) : W(0x3ff00000 + ((k + 1000) << 20), 0);
  const c = x - t * (EXP_P1 + t * (EXP_P2 + t * (EXP_P3 + t * (EXP_P4 + t * EXP_P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - (loPart - (x * c) / (2 - c) - hiPart);
  if (k >= -1021) {
    if (k === 1024) return y * 2 * TWO1023;
    return y * twopk;
  }
  return y * twopk * TWOM1000;
}

const Q1 = W(0xbfa11111, 0x111110f4);
const Q2 = W(0x3f5a01a0, 0x19fe5585);
const Q3 = W(0xbf14ce19, 0x9eaadbb7);
const Q4 = W(0x3ed0cfca, 0x86e65239);
const Q5 = W(0xbe8afdb7, 0x6e09c32d);

export function expm1(x: number): number {
  let hx = hi(x);
  const xsb = hx & 0x80000000; // sign bit of x
  hx &= 0x7fffffff; // high word of |x|
  let k: number;
  let hiPart = 0;
  let loPart = 0;
  let c = 0;
  let t: number, y: number;

  // filter out huge and non-finite argument
  if (hx >= 0x4043687a) {
    // |x| >= 56*ln2
    if (hx >= 0x40862e42) {
      // |x| >= 709.78...
      if (hx >= 0x7ff00000) {
        if (((hx & 0xfffff) | lo(x)) !== 0) return x + x; // NaN
        return xsb === 0 ? x : -1; // exp(+-inf) = {inf, -1}
      }
      if (x > O_THRESHOLD) return HUGE * HUGE; // overflow
    }
    if (xsb !== 0) {
      // x < -56*ln2, return -1.0 with inexact
      if (x + TINY < 0) return TINY - 1;
    }
  }

  // argument reduction
  if (hx > 0x3fd62e42) {
    // |x| > 0.5 ln2
    if (hx < 0x3ff0a2b2) {
      // and |x| < 1.5 ln2
      if (xsb === 0) {
        hiPart = x - LN2_HI;
        loPart = LN2_LO;
        k = 1;
      } else {
        hiPart = x + LN2_HI;
        loPart = -LN2_LO;
        k = -1;
      }
    } else {
      k = trunc(INVLN2 * x + (xsb === 0 ? 0.5 : -0.5));
      t = k;
      hiPart = x - t * LN2_HI; // t*ln2_hi is exact here
      loPart = t * LN2_LO;
    }
    x = hiPart - loPart;
    c = hiPart - x - loPart;
  } else if (hx < 0x3c900000) {
    // |x| < 2^-54, return x
    t = HUGE + x;
    return x - (t - (HUGE + x));
  } else {
    k = 0;
  }

  // x is now in primary range
  const hfx = 0.5 * x;
  const hxs = x * hfx;
  const r1 = 1 + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
  t = 3 - r1 * hfx;
  let e = hxs * ((r1 - t) / (6 - x * t));
  if (k === 0) return x - (x * e - hxs); // c is 0
  const twopk = W(0x3ff00000 + (k << 20), 0); // 2^k
  e = x * (e - c) - c;
  e -= hxs;
  if (k === -1) return 0.5 * (x - e) - 0.5;
  if (k === 1) {
    if (x < -0.25) return -2 * (e - (x + 0.5));
    return 1 + 2 * (x - e);
  }
  if (k <= -2 || k > 56) {
    // suffice to return exp(x)-1
    y = 1 - (e - x);
    if (k === 1024) y = y * 2 * TWO1023;
    else y = y * twopk;
    return y - 1;
  }
  if (k < 20) {
    t = W(0x3ff00000 - (0x200000 >> k), 0); // t = 1 - 2^-k
    y = t - (e - x);
    y = y * twopk;
  } else {
    t = W((0x3ff - k) << 20, 0); // 2^-k
    y = x - (e + t);
    y += 1;
    y = y * twopk;
  }
  return y;
}

const LG1 = W(0x3fe55555, 0x55555593);
const LG2 = W(0x3fd99999, 0x9997fa04);
const LG3 = W(0x3fd24924, 0x94229359);
const LG4 = W(0x3fcc71c5, 0x1d8e78af);
const LG5 = W(0x3fc74664, 0x96cb03de);
const LG6 = W(0x3fc39a09, 0xd078c69f);
const LG7 = W(0x3fc2f112, 0xdf3e5244);
const ONE_THIRD = W(0x3fd55555, 0x55555555);
const TWO_THIRDS = W(0x3fe55555, 0x55555555);

export function log(x: number): number {
  let hx = hi(x);
  const lx = lo(x);
  let k = 0;
  if (hx < 0x00100000) {
    // x < 2^-1022
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity; // log(+-0) = -inf
    if (hx < 0) return NaN; // log(-#) = NaN
    k -= 54;
    x *= TWO54; // subnormal number, scale up x
    hx = hi(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = setHi(x, hx | (i0 ^ 0x3ff00000)); // normalize x or x/2
  k += i0 >> 20;
  const f = x - 1;
  let R: number, dk: number;
  if ((0x000fffff & (2 + hx)) < 3) {
    // -2^-20 <= f < 2^-20
    if (f === 0) {
      if (k === 0) return 0;
      dk = k;
      return dk * LN2_HI + dk * LN2_LO;
    }
    R = f * f * (0.5 - ONE_THIRD * f);
    if (k === 0) return f - R;
    dk = k;
    return dk * LN2_HI - (R - dk * LN2_LO - f);
  }
  const s = f / (2 + f);
  dk = k;
  const z = s * s;
  let i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * LN2_HI - (hfsq - (s * (hfsq + R) + dk * LN2_LO) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * LN2_HI - (s * (f - R) - dk * LN2_LO - f);
}

export function log1p(x: number): number {
  const hx = hi(x);
  const ax = hx & 0x7fffffff;
  let k = 1;
  let f = 0;
  let hu = 0;
  let c = 0;
  let u: number;
  if (hx < 0x3fda827a) {
    // 1+x < sqrt(2)+
    if (ax >= 0x3ff00000) {
      // x <= -1.0
      if (x === -1) return -Infinity; // log1p(-1) = -inf
      return NaN; // log1p(x<-1) = NaN
    }
    if (ax < 0x3e200000) {
      // |x| < 2^-29
      if (ax < 0x3c900000) return x; // |x| < 2^-54
      return x - x * x * 0.5;
    }
    if (hx > 0 || hx <= (0xbfd2bec4 | 0)) {
      // sqrt(2)/2- <= 1+x < sqrt(2)+
      k = 0;
      f = x;
      hu = 1;
    }
  }
  if (hx >= 0x7ff00000) return x + x;
  if (k !== 0) {
    if (hx < 0x43400000) {
      u = 1 + x;
      hu = hi(u);
      k = (hu >> 20) - 1023;
      c = k > 0 ? 1 - (u - x) : x - (u - 1); // correction term
      c /= u;
    } else {
      u = x;
      hu = hi(u);
      k = (hu >> 20) - 1023;
      c = 0;
    }
    hu &= 0x000fffff;
    // The approximation to sqrt(2) used in thresholds is not critical, but
    // the ones above must give less strict bounds than this one so the k==0
    // case is never reached from here.
    if (hu < 0x6a09e) {
      u = setHi(u, hu | 0x3ff00000); // normalize u
    } else {
      k += 1;
      u = setHi(u, hu | 0x3fe00000); // normalize u/2
      hu = (0x00100000 - hu) >> 2;
    }
    f = u - 1;
  }
  const hfsq = 0.5 * f * f;
  let R: number;
  if (hu === 0) {
    // |f| < 2^-20
    if (f === 0) {
      if (k === 0) return 0;
      c += k * LN2_LO;
      return k * LN2_HI + c;
    }
    R = hfsq * (1 - TWO_THIRDS * f);
    if (k === 0) return f - R;
    return k * LN2_HI - (R - (k * LN2_LO + c) - f);
  }
  const s = f / (2 + f);
  const z = s * s;
  R = z * (LG1 + z * (LG2 + z * (LG3 + z * (LG4 + z * (LG5 + z * (LG6 + z * LG7))))));
  if (k === 0) return f - (hfsq - s * (hfsq + R));
  return k * LN2_HI - (hfsq - (s * (hfsq + R) + (k * LN2_LO + c)) - f);
}

// ---------------------------------------------------------------------------
// Hyperbolics.
// ---------------------------------------------------------------------------

const OVERFLOW_THRESHOLD = 710.4758600739439; // 16 digits: parsed exactly everywhere
const LOG_MAXD = 709.7822265625; // 0x40862E42 00000000, exact
const TWO_M28 = W(0x3e300000, 0);
const LN2 = W(0x3fe62e42, 0xfefa39ef);

export function sinh(x: number): number {
  const h = x < 0 ? -0.5 : 0.5;
  const ax = abs(x);
  // |x| in [0, 22]: sign(x)*0.5*(E+E/(E+1))
  if (ax < 22) {
    if (ax < TWO_M28) return x; // |x| < 2^-28: sinh(x) = x
    const t = expm1(ax);
    if (ax < 1) return h * (2 * t - (t * t) / (t + 1));
    return h * (t + t / (t + 1));
  }
  // |x| in [22, log(maxdouble)]: 0.5 * exp(|x|)
  if (ax < LOG_MAXD) return h * exp(ax);
  // |x| in [log(maxdouble), overflow threshold]
  if (ax <= OVERFLOW_THRESHOLD) {
    const w = exp(0.5 * ax);
    const t = h * w;
    return t * w;
  }
  // |x| > overflow threshold, or NaN
  return x * 1.0e307;
}

export function cosh(x: number): number {
  const ix = hi(x) & 0x7fffffff;
  // |x| in [0, 0.5*ln2]: 1 + expm1(|x|)^2 / (2*exp(|x|))
  if (ix < 0x3fd62e43) {
    const t = expm1(abs(x));
    const w = 1 + t;
    if (ix < 0x3c800000) return w; // |x| < 2^-55: cosh(x) = 1
    return 1 + (t * t) / (w + w);
  }
  // |x| in [0.5*ln2, 22]: (exp(|x|) + 1/exp(|x|)) / 2
  if (ix < 0x40360000) {
    const t = exp(abs(x));
    return 0.5 * t + 0.5 / t;
  }
  // |x| in [22, log(maxdouble)]: half*exp(|x|)
  if (ix < 0x40862e42) return 0.5 * exp(abs(x));
  // |x| in [log(maxdouble), overflow threshold]
  if (abs(x) <= OVERFLOW_THRESHOLD) {
    const w = exp(0.5 * abs(x));
    const t = 0.5 * w;
    return t * w;
  }
  // x is INF or NaN
  if (ix >= 0x7ff00000) return x * x;
  // |x| > overflow threshold
  return HUGE * HUGE;
}

export function asinh(x: number): number {
  const hx = hi(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x7ff00000) return x + x; // x is inf or NaN
  if (ix < 0x3e300000) return x; // |x| < 2^-28
  let w: number;
  if (ix > 0x41b00000) {
    // |x| > 2^28
    w = log(abs(x)) + LN2;
  } else if (ix > 0x40000000) {
    // 2^28 > |x| > 2.0
    const t = abs(x);
    w = log(2 * t + 1 / (sqrt(x * x + 1) + t));
  } else {
    // 2.0 > |x| > 2^-28
    const t = x * x;
    w = log1p(abs(x) + t / (1 + sqrt(1 + t)));
  }
  return hx > 0 ? w : -w;
}

export function atanh(x: number): number {
  const hx = hi(x);
  const lx = lo(x);
  const ix = hx & 0x7fffffff;
  if (ix > 0x3ff00000 || (ix === 0x3ff00000 && lx !== 0)) return NaN; // |x| > 1
  if (ix === 0x3ff00000) return x > 0 ? Infinity : -Infinity;
  if (ix < 0x3e300000) return x; // |x| < 2^-28
  x = setHi(x, ix); // x = |x|
  let t: number;
  if (ix < 0x3fe00000) {
    // x < 0.5
    t = x + x;
    t = 0.5 * log1p(t + (t * x) / (1 - x));
  } else {
    t = 0.5 * log1p((x + x) / (1 - x));
  }
  return hx >= 0 ? t : -t;
}

// ---------------------------------------------------------------------------
// pow (fdlibm e_pow.c).
// ---------------------------------------------------------------------------

const BP = [1.0, 1.5];
const DP_H = [0.0, W(0x3fe2b803, 0x40000000)];
const DP_L = [0.0, W(0x3e4cfdeb, 0x43cfd006)];
const L1 = W(0x3fe33333, 0x33333303);
const L2 = W(0x3fdb6db6, 0xdb6fabff);
const L3 = W(0x3fd55555, 0x518f264d);
const L4 = W(0x3fd17460, 0xa91d4101);
const L5 = W(0x3fcd864a, 0x93c9db65);
const L6 = W(0x3fca7e28, 0x4a454eef);
const POW_LG2 = W(0x3fe62e42, 0xfefa39ef);
const POW_LG2_H = W(0x3fe62e43, 0x00000000);
const POW_LG2_L = W(0xbe205c61, 0x0ca86c39);
const OVT = 8.0085662595372944372e-17; // -(1024-log2(ovfl+.5ulp)); 20 digits, parsed exactly everywhere
const CP = W(0x3feec709, 0xdc3a03fd); // 2/(3ln2)
const CP_H = W(0x3feec709, 0xe0000000); // (float)cp
const CP_L = W(0xbe3e2fe0, 0x145b01f5); // tail of cp_h
const IVLN2 = W(0x3ff71547, 0x652b82fe); // 1/ln2
const IVLN2_H = W(0x3ff71547, 0x60000000); // 24 bits of 1/ln2
const IVLN2_L = W(0x3e54ae0b, 0xf85ddf44); // 1/ln2 tail
const POW_ONE_THIRD = W(0x3fd55555, 0x55555555);

export function pow(x: number, y: number): number {
  const hx = hi(x);
  const lx = lo(x);
  const hy = hi(y);
  const ly = lo(y);
  let ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;
  let i: number, j: number, k: number, n: number;
  let z: number, t: number, u: number, v: number, w: number, r: number;
  let t1: number, t2: number, p_h: number, p_l: number;

  // y == 0: x**0 = 1
  if ((iy | ly) === 0) return 1;
  // +-NaN return x+y
  if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) || iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) {
    return x + y;
  }

  // Determine whether y is an odd int when x < 0:
  //   yisint = 0 ... y is not an integer
  //   yisint = 1 ... y is an odd int
  //   yisint = 2 ... y is an even int
  let yisint = 0;
  if (hx < 0) {
    if (iy >= 0x43400000) {
      yisint = 2; // even integer y
    } else if (iy >= 0x3ff00000) {
      k = (iy >> 20) - 0x3ff; // exponent
      if (k > 20) {
        j = ly >>> (52 - k);
        if ((j << (52 - k)) === (ly | 0)) yisint = 2 - (j & 1);
      } else if (ly === 0) {
        j = iy >> (20 - k);
        if (j << (20 - k) === iy) yisint = 2 - (j & 1);
      }
    }
  }

  // special value of y
  if (ly === 0) {
    if (iy === 0x7ff00000) {
      // y is +-inf
      if (((ix - 0x3ff00000) | lx) === 0) return y - y; // (+-1)**+-inf is NaN
      if (ix >= 0x3ff00000) return hy >= 0 ? y : 0; // (|x|>1)**+-inf = inf, 0
      return hy < 0 ? -y : 0; // (|x|<1)**-,+inf = inf, 0
    }
    if (iy === 0x3ff00000) {
      // y is +-1
      if (hy < 0) return 1 / x;
      return x;
    }
    if (hy === 0x40000000) return x * x; // y is 2
    if (hy === 0x3fe00000) {
      // y is 0.5
      if (hx >= 0) return sqrt(x); // x >= +0
    }
  }

  let ax = abs(x);
  // special value of x
  if (lx === 0) {
    if (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000) {
      z = ax; // x is +-0, +-inf, +-1
      if (hy < 0) z = 1 / z; // z = 1/|x|
      if (hx < 0) {
        if (((ix - 0x3ff00000) | yisint) === 0) {
          z = NaN; // (-1)**non-int is NaN
        } else if (yisint === 1) {
          z = -z; // (x<0)**odd = -(|x|**odd)
        }
      }
      return z;
    }
  }

  n = (hx >> 31) + 1;
  // (x<0)**(non-int) is NaN
  if ((n | yisint) === 0) return NaN;

  let s = 1; // sign of result: -1 for (-ve)**(odd int)
  if ((n | (yisint - 1)) === 0) s = -1;

  // |y| is huge
  if (iy > 0x41e00000) {
    // |y| > 2^31
    if (iy > 0x43f00000) {
      // |y| > 2^64, must over/underflow
      if (ix <= 0x3fefffff) return hy < 0 ? HUGE * HUGE : TINY * TINY;
      if (ix >= 0x3ff00000) return hy > 0 ? HUGE * HUGE : TINY * TINY;
    }
    // over/underflow if x is not close to one
    if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY;
    if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY;
    // now |1-x| is tiny <= 2^-20, suffice to compute log(x) by
    // x - x^2/2 + x^3/3 - x^4/4
    t = ax - 1; // t has 20 trailing zeros
    w = t * t * (0.5 - t * (POW_ONE_THIRD - t * 0.25));
    u = IVLN2_H * t; // ivln2_h has 21 sig. bits
    v = t * IVLN2_L - w * IVLN2;
    t1 = setLo(u + v, 0);
    t2 = v - (t1 - u);
  } else {
    n = 0;
    // take care of subnormal number
    if (ix < 0x00100000) {
      ax *= TWO53;
      n -= 53;
      ix = hi(ax);
    }
    n += (ix >> 20) - 0x3ff;
    j = ix & 0x000fffff;
    // determine interval
    ix = j | 0x3ff00000; // normalize ix
    if (j <= 0x3988e) {
      k = 0; // |x| < sqrt(3/2)
    } else if (j < 0xbb67a) {
      k = 1; // |x| < sqrt(3)
    } else {
      k = 0;
      n += 1;
      ix -= 0x00100000;
    }
    ax = setHi(ax, ix);

    // compute ss = s_h+s_l = (x-1)/(x+1) or (x-1.5)/(x+1.5)
    u = ax - BP[k]!; // bp[0]=1.0, bp[1]=1.5
    v = 1 / (ax + BP[k]!);
    const ss = u * v;
    const s_h = setLo(ss, 0);
    // t_h = ax+bp[k] High
    let t_h = W(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
    let t_l = ax - (t_h - BP[k]!);
    const s_l = v * (u - s_h * t_h - s_h * t_l);
    // compute log(ax)
    let s2 = ss * ss;
    r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += s_l * (s_h + ss);
    s2 = s_h * s_h;
    t_h = setLo(3 + s2 + r, 0);
    t_l = r - (t_h - 3 - s2);
    // u+v = ss*(1+...)
    u = s_h * t_h;
    v = s_l * t_h + t_l * ss;
    // 2/(3log2)*(ss+...)
    p_h = setLo(u + v, 0);
    p_l = v - (p_h - u);
    const z_h = CP_H * p_h; // cp_h+cp_l = 2/(3*log2)
    const z_l = CP_L * p_h + p_l * CP + DP_L[k]!;
    // log2(ax) = (ss+..)*2/(3*log2) = n + dp_h + z_h + z_l
    t = n;
    t1 = setLo(z_h + z_l + DP_H[k]! + t, 0);
    t2 = z_l - (t1 - t - DP_H[k]! - z_h);
  }

  // split up y into y1+y2 and compute (y1+y2)*(t1+t2)
  const y1 = setLo(y, 0);
  p_l = (y - y1) * t1 + y * t2;
  p_h = y1 * t1;
  z = p_l + p_h;
  j = hi(z);
  i = lo(z);
  if (j >= 0x40900000) {
    // z >= 1024
    if (((j - 0x40900000) | i) !== 0) return s * HUGE * HUGE; // z > 1024: overflow
    if (p_l + OVT > z - p_h) return s * HUGE * HUGE; // overflow
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    // z <= -1075
    if (((j - (0xc090cc00 | 0)) | i) !== 0) return s * TINY * TINY; // z < -1075: underflow
    if (p_l <= z - p_h) return s * TINY * TINY; // underflow
  }

  // compute 2**(p_h+p_l)
  i = j & 0x7fffffff;
  k = (i >> 20) - 0x3ff;
  n = 0;
  if (i > 0x3fe00000) {
    // if |z| > 0.5, set n = [z+0.5]
    n = j + (0x00100000 >> (k + 1));
    k = ((n & 0x7fffffff) >> 20) - 0x3ff; // new k for n
    t = W(n & ~(0x000fffff >> k), 0);
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) n = -n;
    p_h -= t;
  }
  t = setLo(p_l + p_h, 0);
  u = t * POW_LG2_H;
  v = (p_l - (t - p_h)) * POW_LG2 + t * POW_LG2_L;
  z = u + v;
  w = v - (z - u);
  t = z * z;
  t1 = z - t * (EXP_P1 + t * (EXP_P2 + t * (EXP_P3 + t * (EXP_P4 + t * EXP_P5))));
  r = (z * t1) / (t1 - 2 - (w + z * w));
  z = 1 - (r - z);
  j = hi(z);
  j += n << 20;
  if (j >> 20 <= 0) {
    z = scalbn(z, n); // subnormal output
  } else {
    z = setHi(z, hi(z) + (n << 20));
  }
  return s * z;
}

// ---------------------------------------------------------------------------
// hypot: V8's two-argument `Math.hypot` (scale by the larger magnitude, then
// sqrt). Kept as V8 computes it so a recording made in Chromium replays here
// bit for bit.
// ---------------------------------------------------------------------------

export function hypot(x: number, y: number): number {
  const a = abs(x);
  const b = abs(y);
  if (a === Infinity || b === Infinity) return Infinity;
  const max = a > b ? a : b;
  if (a !== a || b !== b) return NaN;
  if (max === 0) return 0;
  return sqrt((a / max) * (a / max) + (b / max) * (b / max)) * max;
}

// The namespace the sim calls. Frozen, so a stray `dmath.sin = Math.sin` is a
// thrown error rather than a quiet reintroduction of the platform libm.
export const dmath = Object.freeze({
  sin,
  cos,
  tan,
  atan,
  atan2,
  asin,
  acos,
  exp,
  expm1,
  log,
  log1p,
  pow,
  sinh,
  cosh,
  asinh,
  atanh,
  hypot,
  scalbn,
});

export type DmathName = keyof typeof dmath;
