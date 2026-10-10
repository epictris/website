// Rope-bridge solver study (see plans/rope-bridge.md).
//
// A standalone rig, independent of the engine: n rigid slats hung between two
// static anchors by short inextensible chains, optionally with the 52 kg ball
// hung from the middle slat, stepped at 60 Hz with gravity and nothing else.
// Three ways of enforcing the chain lengths are compared on it:
//
//   gs      Gauss-Seidel over the chains, one PBD projection per chain per
//           pass (torque arms included), alternating direction, exit on
//           tolerance - what `sweepChains` does, minus the wrap machinery.
//   sub     the same projection, the frame split into k substeps with a fixed
//           number of passes each ("small steps"; Box2D v3's soft step without
//           the softness).
//   direct  every chain at once: J W J^T lambda = -C over the taut chains,
//           dense solve, apply W J^T lambda, repeat (Newton); optionally damped
//           (max rotation per step) and regularised (diagonal compliance).
//
//   bun scripts/bridge-solver-study.ts              # the five scenarios
//   bun scripts/bridge-solver-study.ts ratio 10     # one scenario, slats 10x heavier
//
// Units: metres, seconds, kilograms; y down; g = 9.8. Not part of `bun run test`.

type BodyState = { x: number; y: number; th: number; vx: number; vy: number; w: number; im: number; iI: number; m: number };
type Chain = { a: number; ra: [number, number]; b: number; rb: [number, number]; L: number };

const G = 9.8;
const SLAT_SCALE = process.argv[2] === "ratio" ? Number(process.argv[3] ?? "1") : 1;
const DT = 1 / 60;

function makeRig(n: number, slack: number, ball: "none" | "rest" | "swing") {
  const w = 0.15, h = 0.05, m = 2.625 * SLAT_SCALE, I = 5.469e-3 * SLAT_SCALE, gap = 0.15;
  const bodies: BodyState[] = [];
  const chains: Chain[] = [];
  // statics: index 0 = left anchor, 1 = right anchor (infinite mass)
  const pitch = w + gap;
  const span = n * w + (n + 1) * gap;
  bodies.push({ x: -span / 2, y: 0, th: 0, vx: 0, vy: 0, w: 0, im: 0, iI: 0, m: Infinity });
  bodies.push({ x: span / 2, y: 0, th: 0, vx: 0, vy: 0, w: 0, im: 0, iI: 0, m: Infinity });
  for (let i = 0; i < n; i++) {
    bodies.push({ x: -span / 2 + gap + w / 2 + i * pitch, y: 0, th: 0, vx: 0, vy: 0, w: 0, im: 1 / m, iI: 1 / I, m });
  }
  const L = gap * (1 + slack);
  chains.push({ a: 0, ra: [0, 0], b: 2, rb: [-w / 2, 0], L });
  for (let i = 0; i < n - 1; i++) chains.push({ a: 2 + i, ra: [w / 2, 0], b: 3 + i, rb: [-w / 2, 0], L });
  chains.push({ a: 2 + n - 1, ra: [w / 2, 0], b: 1, rb: [0, 0], L });
  if (ball !== "none") {
    const mid = 2 + Math.floor(n / 2);
    const bm = 52.115, bI = 0.3752;
    const rope = 1.69;
    bodies.push({ x: bodies[mid]!.x, y: rope, th: 0, vx: ball === "swing" ? 3 : 0, vy: 0, w: 0, im: 1 / bm, iI: 1 / bI, m: bm });
    chains.push({ a: mid, ra: [0, 0], b: bodies.length - 1, rb: [0, 0], L: rope });
  }
  return { bodies, chains, mid: 2 + Math.floor(n / 2) };
}

function anchor(b: BodyState, r: [number, number]): [number, number] {
  const c = Math.cos(b.th), s = Math.sin(b.th);
  return [b.x + c * r[0] - s * r[1], b.y + s * r[0] + c * r[1]];
}

// C = |pb - pa| - L (>0 means over length). Returns n, ra, rb (world arms).
function evalChain(bodies: BodyState[], ch: Chain) {
  const A = bodies[ch.a]!, B = bodies[ch.b]!;
  const pa = anchor(A, ch.ra), pb = anchor(B, ch.rb);
  const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
  const len = Math.hypot(dx, dy);
  const nx = dx / len, ny = dy / len;
  const rax = pa[0] - A.x, ray = pa[1] - A.y, rbx = pb[0] - B.x, rby = pb[1] - B.y;
  return { C: len - ch.L, nx, ny, rax, ray, rbx, rby, A, B };
}

let evals = 0;

function project(bodies: BodyState[], ch: Chain): number {
  evals++;
  const e = evalChain(bodies, ch);
  if (e.C <= 0) return 0;
  const { A, B, nx, ny } = e;
  const raxn = e.rax * ny - e.ray * nx, rbxn = e.rbx * ny - e.rby * nx;
  const wa = A.im + A.iI * raxn * raxn, wb = B.im + B.iI * rbxn * rbxn;
  const tot = wa + wb;
  if (tot < 1e-9) return e.C;
  const lam = e.C / tot;
  A.x += nx * lam * A.im; A.y += ny * lam * A.im; A.th += raxn * lam * A.iI;
  B.x -= nx * lam * B.im; B.y -= ny * lam * B.im; B.th -= rbxn * lam * B.iI;
  return e.C;
}

function maxC(bodies: BodyState[], chains: Chain[]): number {
  let m = 0;
  for (const ch of chains) m = Math.max(m, evalChain(bodies, ch).C);
  return m;
}

function gsSolve(bodies: BodyState[], chains: Chain[], cap: number, tol: number): number {
  let sweeps = 0;
  for (let s = 0; s < cap; s++) {
    sweeps++;
    if (s % 2 === 0) for (let i = 0; i < chains.length; i++) project(bodies, chains[i]!);
    else for (let i = chains.length - 1; i >= 0; i--) project(bodies, chains[i]!);
    if (maxC(bodies, chains) <= tol) break;
  }
  return sweeps;
}

function solveDense(Amat: Float64Array, b: Float64Array, k: number): Float64Array {
  const a = Float64Array.from(Amat), x = Float64Array.from(b);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r * k + c]!) > Math.abs(a[p * k + c]!)) p = r;
    if (p !== c) {
      for (let j = 0; j < k; j++) { const t = a[c * k + j]!; a[c * k + j] = a[p * k + j]!; a[p * k + j] = t; }
      const t = x[c]!; x[c] = x[p]!; x[p] = t;
    }
    const piv = a[c * k + c]!;
    if (Math.abs(piv) < 1e-14) continue;
    for (let r = c + 1; r < k; r++) {
      const f = a[r * k + c]! / piv;
      if (f === 0) continue;
      for (let j = c; j < k; j++) a[r * k + j] -= f * a[c * k + j]!;
      x[r] -= f * x[c]!;
    }
  }
  for (let c = k - 1; c >= 0; c--) {
    let s = x[c]!;
    for (let j = c + 1; j < k; j++) s -= a[c * k + j]! * x[j]!;
    const piv = a[c * k + c]!;
    x[c] = Math.abs(piv) < 1e-14 ? 0 : s / piv;
  }
  return x;
}

// One Newton step over the active set, with the inequality handled by dropping
// chains whose multiplier came out pushing (slack) and re-solving.
function directSolve(bodies: BodyState[], chains: Chain[], maxNewton: number, tol: number, reg = 0, damp = Infinity): number {
  let steps = 0;
  for (let it = 0; it < maxNewton; it++) {
    steps++;
    let active = chains.map((ch, i) => i).filter((i) => { evals++; return evalChain(bodies, chains[i]!).C > 0; });
    if (active.length === 0) break;
    let lambda: Float64Array | null = null;
    let rows: ReturnType<typeof evalChain>[] = [];
    for (let pass = 0; pass < 4; pass++) {
      const k = active.length;
      rows = active.map((i) => evalChain(bodies, chains[i]!));
      // J rows in generalized coords (x,y,th per body); A = J W J^T.
      const A = new Float64Array(k * k);
      const b = new Float64Array(k);
      for (let p = 0; p < k; p++) {
        const rp = rows[p]!;
        b[p] = -rp.C;
        for (let q = 0; q < k; q++) {
          const rq = rows[q]!;
          let sum = 0;
          // shared bodies between row p and row q
          const bp = [[rp.A, -rp.nx, -rp.ny, -(rp.rax * rp.ny - rp.ray * rp.nx)], [rp.B, rp.nx, rp.ny, rp.rbx * rp.ny - rp.rby * rp.nx]] as const;
          const bq = [[rq.A, -rq.nx, -rq.ny, -(rq.rax * rq.ny - rq.ray * rq.nx)], [rq.B, rq.nx, rq.ny, rq.rbx * rq.ny - rq.rby * rq.nx]] as const;
          for (const [bodyP, jx, jy, jt] of bp) for (const [bodyQ, kx, ky, kt] of bq) {
            if (bodyP !== bodyQ) continue;
            sum += bodyP.im * (jx * kx + jy * ky) + bodyP.iI * jt * kt;
          }
          A[p * k + q] = sum + (p === q ? reg : 0);
        }
      }
      lambda = solveDense(A, b, k);
      // lambda < 0 would push the chain apart: it is slack, drop it.
      const keep = active.filter((_, p) => lambda![p]! <= 0);
      if (keep.length === active.length) break;
      active = keep;
      if (active.length === 0) { lambda = null; break; }
    }
    if (!lambda) break;
    // Damping: scale the whole step so no body turns more than `damp` rad.
    let scale = 1;
    if (Number.isFinite(damp)) {
      const dth = new Map<BodyState, number>();
      for (let p = 0; p < active.length; p++) {
        const r = rows[p]!, l = lambda[p]!;
        dth.set(r.A, (dth.get(r.A) ?? 0) - (r.rax * r.ny - r.ray * r.nx) * l * r.A.iI);
        dth.set(r.B, (dth.get(r.B) ?? 0) + (r.rbx * r.ny - r.rby * r.nx) * l * r.B.iI);
      }
      let worst = 0;
      for (const v of dth.values()) worst = Math.max(worst, Math.abs(v));
      if (worst > damp) scale = damp / worst;
    }
    for (let p = 0; p < active.length; p++) {
      const r = rows[p]!, l = lambda[p]! * scale;
      // dq = W J^T lambda. Row p's J on A is (-n, -(ra x n)), on B (n, rb x n).
      r.A.x += -r.nx * l * r.A.im; r.A.y += -r.ny * l * r.A.im; r.A.th += -(r.rax * r.ny - r.ray * r.nx) * l * r.A.iI;
      r.B.x += r.nx * l * r.B.im; r.B.y += r.ny * l * r.B.im; r.B.th += (r.rbx * r.ny - r.rby * r.nx) * l * r.B.iI;
    }
    if (maxC(bodies, chains) <= tol) break;
  }
  return steps;
}

type Mode = { kind: "gs"; cap: number } | { kind: "sub"; k: number; passes: number } | { kind: "direct"; newton: number; reg?: number; damp?: number };

function run(n: number, slack: number, ball: "none" | "rest" | "swing", mode: Mode, frames: number, tol: number) {
  const { bodies, chains, mid } = makeRig(n, slack, ball);
  evals = 0;
  let maxEnd = 0, maxDth = 0, maxW = 0, maxV = 0, iters = 0, blew = false;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    const sub = mode.kind === "sub" ? mode.k : 1;
    const h = DT / sub;
    for (let s = 0; s < sub; s++) {
      const prev = bodies.map((b) => [b.x, b.y, b.th] as const);
      for (const b of bodies) if (b.im > 0) { b.vy += G * h; b.x += b.vx * h; b.y += b.vy * h; b.th += b.w * h; }
      if (mode.kind === "gs") iters += gsSolve(bodies, chains, mode.cap, tol);
      else if (mode.kind === "sub") iters += gsSolve(bodies, chains, mode.passes, -1);
      else iters += directSolve(bodies, chains, mode.newton, tol, mode.reg ?? 0, mode.damp ?? Infinity);
      bodies.forEach((b, i) => {
        if (b.im === 0) return;
        const p = prev[i]!;
        b.vx = (b.x - p[0]) / h; b.vy = (b.y - p[1]) / h; b.w = (b.th - p[2]) / h;
        maxDth = Math.max(maxDth, Math.abs(b.th - p[2]));
      });
    }
    maxEnd = Math.max(maxEnd, maxC(bodies, chains));
    for (const b of bodies) if (b.im > 0) { maxW = Math.max(maxW, Math.abs(b.w)); maxV = Math.max(maxV, Math.hypot(b.vx, b.vy)); if (!Number.isFinite(b.x) || Math.hypot(b.vx, b.vy) > 50) blew = true; }
  }
  const ms = performance.now() - t0;
  const label = mode.kind === "gs" ? `gs cap=${mode.cap}` : mode.kind === "sub" ? `sub k=${mode.k} p=${mode.passes}` : `direct N=${mode.newton}${mode.damp !== undefined ? " d=" + mode.damp : ""}${mode.reg ? " r=" + mode.reg : ""}`;
  console.log(
    `${label.padEnd(16)} n=${String(n).padStart(2)} slack=${(slack * 100).toFixed(0).padStart(2)}% ball=${ball.padEnd(5)} | iters/frame=${(iters / frames).toFixed(1).padStart(6)} evals/frame=${(evals / frames).toFixed(0).padStart(6)} ${(ms / frames).toFixed(3).padStart(6)} ms/frame | worst end-of-frame over=${(maxEnd * 1000).toFixed(2).padStart(7)} mm maxΔθ/step=${maxDth.toFixed(3).padStart(6)} rad max|w|=${maxW.toFixed(1).padStart(7)} max|v|=${maxV.toFixed(2).padStart(6)} sag=${bodies[mid]!.y.toFixed(3)}${blew ? "  BLEW UP" : ""}`,
  );
}

const FRAMES = 600;
const TOL = 0.005;
const scenarios: [number, number, "none" | "rest" | "swing"][] = process.argv[2] === "ratio" ? [[19, 0.03, "swing"]] : [
  [19, 0, "none"],
  [19, 0.03, "none"],
  [19, 0.03, "rest"],
  [19, 0.03, "swing"],
  [57, 0.03, "swing"],
];
for (const [n, slack, ball] of scenarios) {
  run(n, slack, ball, { kind: "gs", cap: 64 }, FRAMES, TOL);
  run(n, slack, ball, { kind: "gs", cap: 512 }, FRAMES, TOL);
  run(n, slack, ball, { kind: "sub", k: 4, passes: 4 }, FRAMES, TOL);
  run(n, slack, ball, { kind: "sub", k: 8, passes: 2 }, FRAMES, TOL);
  run(n, slack, ball, { kind: "sub", k: 8, passes: 4 }, FRAMES, TOL);
  run(n, slack, ball, { kind: "sub", k: 16, passes: 2 }, FRAMES, TOL);
  run(n, slack, ball, { kind: "direct", newton: 16, damp: 0.1 }, FRAMES, TOL);
  run(n, slack, ball, { kind: "direct", newton: 16, damp: 0.1, reg: 1e-3 }, FRAMES, TOL);
  run(n, slack, ball, { kind: "direct", newton: 16, damp: 0.1, reg: 1e-2 }, FRAMES, TOL);
  console.log("");
}
