// Work counters for the constraint phase: how many sweeps, solves and path
// regenerations a frame spent, and how long the chain phase took.
//
// The cost of a rig is its WORK, not its wall clock. `session-235f`'s bridge
// read as 9 to 21 ms a frame in bun and 22 in the browser, and what those
// numbers hid was the shape of the bill: 20 chains at the 64-sweep cap, every
// frame, 1280 rope solves each regenerating a wrap path for a 15 cm segment
// that will never wrap anything. The counts are deterministic - the same bundle
// spends the same sweeps on every engine - so a case can assert on them where
// a millisecond bar would be flaky; the wall clock rides along for `cli perf`
// to report, never for a case to gate on.
//
// Nothing here writes to the sim. With `enabled` false each site is one boolean
// test; with it on, each is an increment. The substepped island solver the
// bridge plan proposes reports through the same fields, so a rig's cost reads
// the same before and after: `sweeps` is substeps times passes there, `solves`
// is rows solved, and `pathRegens` is what a wrap-routing rope still costs.

export const SolverStats = {
  enabled: false,
  // Passes over a constraint set (`sweepOneSet`), summed over every set swept
  // this frame - a frame with three independent rigs sweeping 4, 8 and 64 reads
  // 76.
  sweeps: 0,
  // Constraint solves actually run (a `SceneChain.solve` that is not skipped as
  // the identity, a rope pass of a coupled rope, a row of the island solver).
  solves: 0,
  // Wrap paths regenerated (`Rope.regeneratePath`), the dearest thing a chain
  // solve does.
  pathRegens: 0,
  // Sets that left their sweep on the cap rather than on the tolerance.
  capped: 0,
  // Milliseconds inside `stepSceneChains` and the coupled sweep this frame, by
  // the platform clock. Reported, never asserted on.
  chainMs: 0,

  reset(): void {
    this.sweeps = 0;
    this.solves = 0;
    this.pathRegens = 0;
    this.capped = 0;
    this.chainMs = 0;
  },

  snapshot(): SolverFrameStats {
    return {
      sweeps: this.sweeps,
      solves: this.solves,
      pathRegens: this.pathRegens,
      capped: this.capped,
      chainMs: this.chainMs,
    };
  },

  now(): number {
    return this.enabled ? performance.now() : 0;
  },
};

export interface SolverFrameStats {
  sweeps: number;
  solves: number;
  pathRegens: number;
  capped: number;
  chainMs: number;
}
