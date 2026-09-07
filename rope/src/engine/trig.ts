// The cosine and sine of a rotation, cached against the rotation's bit pattern.
//
// A frame rotates thousands of offsets by a few dozen distinct angles: every
// shape's mount offset by its body's rotation, every whole-body overlap query
// once per shape, the slack chain's node scan once per node per shape - some
// 84,000 `sin`/`cos` calls a frame on the ball arena, of which nearly all are
// repeats of a value that changes once a frame at most (a body's rotation) or
// never (a static's). `dmath.sin` costs about 20 ns, so that is over a
// millisecond of a physics frame spent recomputing the same few numbers.
//
// This is a direct-mapped memo in front of `dmath`, and it is EXACT: a hit
// returns the bits `dmath` computed for that exact bit pattern (the key is the
// double's two words, so +0 and -0 are different entries and a NaN never
// matches), and a miss or a collision simply recomputes. No answer anywhere
// can depend on what is in the cache, which is what lets it sit under the
// deterministic replay without a case of its own beyond `cli dmath`'s check
// that a hit and a fresh computation agree to the bit.

import { dmath } from "./dmath";

const BITS = 8;
const SIZE = 1 << BITS;
const KEY_A = new Uint32Array(SIZE);
const KEY_B = new Uint32Array(SIZE);
const FILLED = new Uint8Array(SIZE);

// Read these at the slot `trigSlot` returns, immediately - the next call may
// evict it.
export const TRIG_COS = new Float64Array(SIZE);
export const TRIG_SIN = new Float64Array(SIZE);

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

export function trigSlot(rad: number): number {
  f64[0] = rad;
  const a = u32[0]!;
  const b = u32[1]!;
  const i = Math.imul(a ^ Math.imul(b, 0x9e3779b1), 0x85ebca6b) >>> (32 - BITS);
  if (FILLED[i] === 0 || KEY_A[i] !== a || KEY_B[i] !== b) {
    KEY_A[i] = a;
    KEY_B[i] = b;
    FILLED[i] = 1;
    TRIG_COS[i] = dmath.cos(rad);
    TRIG_SIN[i] = dmath.sin(rad);
  }
  return i;
}
