// Vine stiffness - what makes a vine hard to BEND, on a scale from a rope to a
// pole (`VineData.stiffness`).
//
// The load-bearing decision, stated once: stiffness is a **three-point
// curvature constraint with a COMPLIANCE, solved by XPBD in the same sweep as
// the vine's pair chains**. Everything else here is a consequence of that.
//
// Why a three-point constraint. A vine is a chain of links held at a spacing by
// pair chains (`level/vines.ts`), and a spacing says nothing at all about
// shape: any curl, coil or zigzag satisfies every one of them. What the pair
// chains leave free is exactly the CURVATURE, and the curvature at a link is a
// statement about that link and its two neighbours - so that triple is the
// smallest thing a bending constraint can be written on. Two of them straight
// is a straight vine, and there is no fourth point to consult.
//
// The measure is the middle point's distance from the CHORD MIDPOINT of its
// neighbours, `|b - (a + c)/2|`, which is zero exactly when the three are
// straight and evenly spaced. Written as an angle instead it would need an
// arctangent per triple per pass and a small-angle case around straight, for a
// value the solver immediately turns back into a displacement; written this way
// the gradient is one unit vector and the constraint is linear in what it
// actually moves.
//
// Why compliance rather than a stiffness factor. The obvious PBD spelling of
// "half stiff" is to apply half of each correction, and it is a trap here: the
// stiffness that produces is a function of how many passes the solver happened
// to take, and this sweep's pass count is neither fixed nor knowable in advance
// - it runs to a residual and stops (see `sweepChains`), so a vine would be
// stiffer on a frame that had a hard rig elsewhere in the level and softer on a
// quiet one. XPBD exists to answer exactly that: the constraint carries a
// compliance in metres per newton, accumulates its own multiplier across the
// passes of a frame, and converges to the same physical stiffness whatever the
// pass count is. `stiffness` therefore means a real bending rigidity rather
// than a solver setting.
//
// Why there is a constraint on every SCALE and not only between neighbours.
// A stiff vine is a stiff SERIAL chain, which is the one shape a Gauss-Seidel
// sweep is worst at: a joint at the anchor can only learn what the tip is doing
// by the news being passed link by link, one link per pass, and the moment the
// links resist bending that news is also what every pass is arguing about. It
// does not converge in any pass count worth paying for - measured, on a 3 m
// vine with a 70 kg player swinging onto its tip, with neighbour-only bends at
// the stiffest setting there is:
//
//   sweeps    worst lean off vertical    worst kink at one joint    cost
//       64            28 deg                     15 deg            6.1 ms
//      512            25 deg                      7 deg           11.8 ms
//
// Eight times the solver for three degrees of lean: it is not short of sweeps,
// it is the wrong sweep. So the same constraint is also written between links 2 apart, 4
// apart, 8 apart and so on - each one a straightness statement about a longer
// span of the vine, and each one a single pass that moves the whole span rather
// than a rumour travelling down it. That is a multigrid V-cycle spelled as
// extra constraints, it costs about three times the constraints (59 against 20
// on that vine) and LESS wall clock than the neighbour-only set it replaces
// (3.7 ms against 6.1), because a sweep that converges is a sweep the loop
// leaves early. The same rig at the same 64 sweeps ends at 1.7 degrees of lean
// and 2.8 of kink - a pole.
//
// Every scale carries the FULL rigidity rather than a share of it. The
// alternative - splitting it between the scales so a smooth bend adds back up
// to exactly `EI` - makes a single joint the vine is kinked at (which is what
// the hook pulling on ONE link is) that many times softer than a smooth bend,
// and a stiff vine that kinks where it is grabbed is the artifact the whole
// feature exists to prevent. Carried in full, the fine scale - the physical one
// - resists exactly what the rigidity says, and a smooth bend is stiffer than
// `EI` by the number of scales, which is `log2(links)`: 4 for a vine of 10
// links and 5 for one of 20. That is absorbed into where the two ends of the
// slider are set, below, and it is why they are set by measurement.
//
// Why it is swept WITH the pair chains rather than after them. They disagree by
// construction: a bend correction that straightens the vine drags two links off
// their spacing, and the pair solve that puts the spacing back bends the vine.
// Run in separate phases each one's answer is the other's residual and neither
// converges - which is the same statement `sweepChains` already makes about two
// chains sharing a body, one order further out. So a bend is a
// `SceneConstraint` and goes into that loop.

import { Vec2 } from "../engine/vec2";
import { RigidBody2D, VineLink } from "../engine/body";
import { RopeContact } from "../lib/ropeContact";
import { CHAIN_TOLERANCE, VINE_TOLERANCE, type SceneConstraint } from "./chains";

// The bending rigidity EI, in newton-metres squared, that `stiffness` 0 and 1
// stand for. A vine's compliance is interpolated GEOMETRICALLY between them, so
// each 0.1 of stiffness multiplies the rigidity by about 2.5.
//
// Geometrically because the useful range is six decades wide. EI is a real beam
// quantity - a cantilever of length L under an end load P deflects P·L³/(3·EI)
// at its tip - so the ENDS can be read rather than guessed, against the load
// this game actually applies, which is a 70 kg player (700 N) on a 3 m vine:
// 6.3 m of deflection at EI = 1000, and 6.3 mm at EI = 1000000. Anything below
// the first is a rope whatever it is called, and past the second the difference
// is under what the renderer can draw.
//
// What the slider does between them is measured rather than derived, because
// what the multi-scale set above adds to a smooth bend is a factor, not a law.
// The worst the vine leaned off vertical while a 70 kg player swung onto its
// tip and hung there, and how straight it stayed while doing it (1.000 is a
// perfectly straight rod):
//
//   stiffness      EI      worst lean   straightness   what it reads as
//         0         -         45 deg       0.917       a rope
//       0.1         4         44 deg       0.928       a rope
//      0.25        32         39 deg       0.965       a heavy cord
//       0.5      1000         25 deg       0.996       a springy branch
//      0.75     31623        9.5 deg       0.999       a sapling
//       0.9    251189        3.6 deg       1.000       a pole that gives
//         1   1000000        1.7 deg       1.000       a pole
//
// A linear map would have spent nine tenths of the slider between the last two
// rows, which are the two an author cannot tell apart, and squeezed the first
// five into its bottom tenth.
//
// The bottom end is deliberately NOT zero: `stiffness: 0` builds no bend
// constraints at all (see `buildVineBends`), so a vine that does not ask for
// stiffness is bit-for-bit the vine it was before this existed, and every
// recorded replay of one still replays. What `LIMP` is is the softest thing a
// vine that DID ask can be - visibly a cord rather than a rope, so the bottom of
// the slider still does something.
export const BEND_EI_LIMP = 1;
export const BEND_EI_POLE = 1000000;

// The bending rigidity an authored `stiffness` stands for.
export function bendRigidity(stiffness: number): number {
  const s = Math.min(1, Math.max(0, stiffness));
  return BEND_EI_LIMP * Math.pow(BEND_EI_POLE / BEND_EI_LIMP, s);
}

// The XPBD compliance of ONE joint of a vine of the given link spacing, in
// metres per newton.
//
// It is derived rather than tuned, and the derivation is what makes `stiffness`
// mean the same thing at any spacing. A joint of a discretised beam is an
// angular spring of `EI / L`, and its energy is `(EI/L)·θ²/2`; this
// constraint's own energy is `C²/(2·α)`, and `C = L·sin(θ/2)`, which is `L·θ/2`
// for the small angles a stiff vine ever reaches. Equating the two gives
//
//     α = L³ / (4·EI)
//
// so the compliance scales with the CUBE of the spacing. Without that a vine
// re-authored at 30 cm spacing instead of 15 would be eight times floppier for
// the same authored number, and spacing is a cost decision that is supposed to
// cost nothing else (see `DEFAULT_VINE_SPACING`).
export function bendCompliance(stiffness: number, spacing: number): number {
  return (spacing * spacing * spacing) / (4 * bendRigidity(stiffness));
}

// One end of a bend triple: either a vine link, which the constraint may move,
// or a point on the body the vine hangs from, which it may not.
//
// The anchor end is IMMOVABLE on purpose, and it is the one simplification
// here. A cantilever exerts a moment on whatever it is bolted to, so a stiff
// vine on a swinging platform should heel it over - but that moment would have
// to be applied at a point off the anchor body's centre of mass, through a
// torque arm, and paid for in the phase's own velocity credit, all so that a
// piece of scenery can lean on the thing it hangs from. The existing statement
// about vines and their anchors is the opposite one: a vine must not visibly
// load what it is hung from, and where it is hung is an authoring question (see
// `DEFAULT_VINE_DENSITY`). So the anchor holds the vine and the vine does not
// pull back, exactly as a static one would.
class BendEnd {
  constructor(
    readonly link: VineLink | null,
    readonly fixed: RopeContact | null,
  ) {}

  get position(): Vec2 {
    return this.link ? this.link.globalPosition : this.fixed!.globalPosition;
  }

  // Inverse mass: zero for the anchor end, which is what makes it immovable.
  get inverseMass(): number {
    return this.link ? 1 / this.link.mass : 0;
  }

  move(delta: Vec2): void {
    if (this.link) this.link.globalPosition = this.link.globalPosition.add(delta);
  }
}

// The curvature at one link: how far it is from straight between its
// neighbours, held to zero through a compliance.
//
// Positions only, and no rotation. A link is a circle whose whole job is to be
// somewhere and whose spin means nothing to anything - the pair chains
// deliberately take it at its centre so they have no torque arm on it either
// (see `buildOne`) - so a bend that spent part of its correction rotating links
// would be spending it where nothing can see it.
export class VineBend implements SceneConstraint {
  // The XPBD multiplier for this constraint, in newtons, accumulated across the
  // passes of ONE frame and reset by `beginFrame`. It is what makes the answer
  // independent of how many passes the sweep takes: the multiplier remembers
  // how much force the constraint has already asked for, so a second pass
  // corrects the remainder rather than applying the whole thing again.
  private lambda = 0;
  // The compliance in the position solver's own units, `α / Δt²`, fixed for the
  // frame by `beginFrame` so the residual below can be read at any point in the
  // sweep without being handed a timestep.
  private alphaTilde = 0;

  constructor(
    private readonly a: BendEnd,
    private readonly b: BendEnd,
    private readonly c: BendEnd,
    // Metres per newton. Zero is a rigid joint.
    private readonly compliance: number,
    // The exit bar the sweep holds this bend to: loose on a hanging vine,
    // tight on a span, exactly as the pair chains split (see `buildOne`'s
    // joint-tolerance note) - a span's bends argue with leased tight pairs,
    // and left on the loose bar the mid-stiffness span rang at 0.63 m/s and
    // never slept.
    readonly tolerance: number = VINE_TOLERANCE,
  ) {}

  beginFrame(delta: number): void {
    this.lambda = 0;
    this.alphaTilde = this.compliance / (delta * delta);
  }

  // How far this joint is from the shape its compliance says it should be in,
  // in metres.
  //
  // NOT the curvature itself, which is the thing this differs from a chain's
  // over-length on. A chain is satisfied at zero, but a compliant bend is
  // satisfied BENT - it is a spring, and a spring at rest under a load is
  // extended. What XPBD makes zero at convergence is `C + α̃·λ`, the constraint
  // measured against the force the constraint has been paid, and that is the
  // number the sweep's residual gate wants: a bend that has reached the shape
  // its stiffness asks for stops asking for sweeps, however bent it is.
  get residual(): number {
    return Math.abs(this.curvature() + this.alphaTilde * this.lambda);
  }


  // How far the middle point is off the chord midpoint of its neighbours, in
  // metres: zero when the triple is straight and evenly spaced, and read live
  // rather than remembered, because what the sweep is asking is where the vine
  // is NOW - a joint this pass satisfied exactly is bent again the moment the
  // pair chains and the load rope have had their say.
  private curvature(): number {
    return this.b.position.sub(this.a.position.add(this.c.position).mul(0.5)).length();
  }

  // Every correction here is honest motion - a bend has no path and no topology
  // to jump (see `Rope.topologyCreditScale`) - so a link is paid velocity for
  // all of it. That payment is what makes a stiff vine spring BACK rather than
  // merely being straightened where it stands.
  get creditScale(): number {
    return 1;
  }

  // The elastic potential this joint is storing, in joules: a compliant
  // constraint is a spring, `E = C²/(2·α)`. It is what a bent branch is ABOUT
  // to spend as motion, so `mechanicalEnergy` must carry it or the spring-back
  // reads as an unforced gain - the same statement the spring body's
  // `0.5·m·w²·d²` term makes (see `sim/trace.ts`).
  //
  // The curvature in it is the FORCE-CONSISTENT one, `α̃·λ` - the deformation
  // implied by the force the solver actually applied this frame - and not the
  // measured `curvature()`. The two agree at convergence, and only one of them
  // survives not being there: at a branch's stiffness the compliance is 1e-8
  // m/N, so `C²/2α` reads a MILLIMETRE of sweep residual as kilojoules
  // (measured: 3.7 kJ on a branch hanging at rest, swinging by thousands over
  // a ring the true energy of is tens of joules). The realized force is
  // bounded by what the bodies' inertia let the solver take, so the estimate
  // is smooth where the geometry is noise.
  get elasticEnergy(): number {
    const c = this.alphaTilde * this.lambda;
    return (c * c) / (2 * this.compliance);
  }

  eachBody(fn: (body: RigidBody2D) => void): void {
    if (this.a.link) fn(this.a.link);
    if (this.b.link) fn(this.b.link);
    if (this.c.link) fn(this.c.link);
  }

  holds(body: RigidBody2D): boolean {
    return this.a.link === body || this.b.link === body || this.c.link === body;
  }

  // Nothing to settle: a bend has no length to lease out and nothing to re-base
  // when the geometry refuses it. A stiff vine held bent by a wall is a stiff
  // vine held bent by a wall, and it straightens when the wall stops being
  // there.
  settle(): void {}

  solve(): void {
    const offset = this.b.position.sub(this.a.position.add(this.c.position).mul(0.5));
    const c = offset.length();
    // Dead straight: no gradient, and nothing to correct. The multiplier is
    // left where it is rather than cleared, so a joint that passes through
    // straight mid-frame does not forget what it has already been paid.
    if (c < 1e-12) return;
    const normal = offset.div(c);
    // Σ w·|∇C|², with ∇C = +n at the middle point and -n/2 at each outer one.
    const wSum = this.b.inverseMass + (this.a.inverseMass + this.c.inverseMass) * 0.25;
    // Every end fixed: a one-link vine's clamp against an anchor that cannot
    // move is the whole of this, and there is nothing for it to correct.
    if (wSum <= 0) return;
    const dLambda = (-c - this.alphaTilde * this.lambda) / (wSum + this.alphaTilde);
    this.lambda += dLambda;
    this.b.move(normal.mul(this.b.inverseMass * dLambda));
    this.a.move(normal.mul(-0.5 * this.a.inverseMass * dLambda));
    this.c.move(normal.mul(-0.5 * this.c.inverseMass * dLambda));
  }
}

// The bend constraints of one vine: one per joint, plus the CLAMP at the
// anchor.
//
// The clamp is what makes a stiff vine a pole rather than a rigid rod on a
// pivot. Without it the joints hold the vine straight and the whole straight
// thing swings freely about the point it is bolted to - a pendulum, which is
// not what a pole bolted to a ceiling does. It is the same three-point
// constraint as every other joint, with a GHOST point standing in for the link
// that would be above the anchor if the vine carried on through it: hold the
// anchor straight between that ghost and the first link, and the first link is
// held out along the vine's rest direction.
//
// The ghost is a point on the ANCHOR BODY, so it turns with that body - a stiff
// vine on a platform that tips over goes with it and keeps pointing the way it
// was hung, which is what "clamped" means. The rest direction it encodes is the
// one the vine was BUILT at, which is straight down: a vine has no authored
// direction, so straight down is the only rest pose there is (see `buildOne`).
//
// A SPANNING vine (`anchor2` set) gets no ghost clamp at either end: a vine
// lashed at both ends is PINNED there, not cantilevered, so its ends are
// hinges and the stiffness lives entirely in the joints. What it gets instead
// is the mirror of the anchor-side triples at the second anchor, so the far
// end is exactly as smooth as the near one. The triples cannot all be
// satisfied - a span with slack can never be straight - and they do not have
// to be: XPBD bends are springs, and the equilibrium is the force balance
// between them and the inextensible chains, which is the elastica a stiff rod
// with excess length bows into between two pins. `stiffness` on a span
// therefore reads as how hard the drape is pressed toward that bow: 0 the
// catenary, 1 a flattened arc that resists kinking where it is grabbed.
export function buildVineBends(
  anchor: RopeContact,
  // The vine's rest direction as it was built, a world unit vector - straight
  // down, that being the only pose a vine has (see `buildOne`). Turned into the
  // anchor body's own frame here, so a stiff vine on a platform that tips over
  // goes with it and keeps pointing the way it was hung. Unused for a span,
  // which builds no clamp.
  restDir: Vec2,
  links: readonly VineLink[],
  stiffness: number,
  spacing: number,
  // The second anchor of a spanning vine; null for the hanging one.
  anchor2: RopeContact | null = null,
): VineBend[] {
  if (!(stiffness > 0) || links.length === 0) return [];
  // The exit bar every bend of this vine takes: loose on a hanging vine,
  // tight on a span (see `VineBend.tolerance`).
  const tolerance = anchor2 ? CHAIN_TOLERANCE : VINE_TOLERANCE;
  const at = (i: number): BendEnd => new BendEnd(links[i]!, null);
  const fixed = (c: RopeContact): BendEnd => new BendEnd(null, c);
  // The scale-k ghost: k spacings back up the rest direction from the anchor.
  // A contact on the ANCHOR BODY, so it turns with it.
  const ghost = (k: number): RopeContact =>
    RopeContact.at(
      anchor.obj,
      anchor.globalPosition.sub(restDir.mul(spacing * k)),
    );

  const n = links.length;
  const bends: VineBend[] = [];
  for (let k = 1; k <= n; k *= 2) {
    const compliance = bendCompliance(stiffness, spacing * k);
    // The clamp at this scale: ghost - anchor - the link k spacings down.
    // Hanging vines only; a span's ends are pinned (see above).
    if (!anchor2 && k - 1 < n) {
      bends.push(new VineBend(fixed(ghost(k)), fixed(anchor), at(k - 1), compliance, tolerance));
    }
    // The joint AT that link, whose upper neighbour is the anchor itself.
    if (2 * k - 1 < n) {
      bends.push(new VineBend(fixed(anchor), at(k - 1), at(2 * k - 1), compliance, tolerance));
    }
    // ...and every joint below it that has a neighbour k links either side.
    for (let i = k; i + k < n; i++) {
      bends.push(new VineBend(at(i - k), at(i), at(i + k), compliance, tolerance));
    }
    // A span's far end, mirrored: the joint whose outer neighbour is the
    // second anchor itself. In the vine's positions - anchor at 0, link i at
    // i + 1, the second anchor at n + 1 - this is the triple centred at
    // n + 1 - k, and its other neighbour is a link, the first anchor, or (for
    // a scale too coarse to fit) nothing.
    if (anchor2) {
      const upper = n + 1 - 2 * k;
      if (upper > 0) {
        bends.push(new VineBend(at(upper - 1), at(n - k), fixed(anchor2), compliance, tolerance));
      } else if (upper === 0) {
        bends.push(new VineBend(fixed(anchor), at(n - k), fixed(anchor2), compliance, tolerance));
      }
    }
  }
  return bends;
}
