// 8-ball rules layer. Operates on the physics World plus the ordered event log
// a shot produced. Mostly a sandbox with real win/lose + foul detection; every
// foul resolves the same friendly way: the incoming player gets ball-in-hand
// and may place the cue ball anywhere before shooting.

import type { ShotEvent, World } from "./physics";

export type Group = "solids" | "stripes";
export type Phase = "break" | "open" | "assigned" | "over";

export type RulesState = {
  turn: 0 | 1;
  groups: [Group | null, Group | null];
  phase: Phase;
  ballInHand: boolean; // may the current player reposition the cue ball?
  winner: 0 | 1 | null;
  message: string;
};

export function initRules(breaker: 0 | 1 = 0): RulesState {
  return {
    turn: breaker,
    groups: [null, null],
    phase: "break",
    ballInHand: true, // break is taken from the kitchen; free placement is fine
    winner: null,
    message: "Break!",
  };
}

export function groupOf(id: number): Group | "eight" | "cue" {
  if (id === 0) return "cue";
  if (id === 8) return "eight";
  return id < 8 ? "solids" : "stripes";
}

/** Balls of a group still on the table (not potted) in the given world. */
function remaining(world: World, group: Group): number {
  return world.balls.filter(
    (b) => !b.potted && groupOf(b.id) === group,
  ).length;
}

export type ShotOutcome = {
  next: RulesState;
  potted: number[];
  firstContact: number | null;
  foul: string | null;
  reRack: boolean; // 8 on the break -> re-rack, same breaker
};

/**
 * Evaluate a completed shot. `before` is the rules state and `worldBefore` is
 * the table *as it was when the shot was taken* (so we can tell which balls the
 * shooter had already cleared); `events` is the ordered log from the sim.
 */
export function evaluateShot(
  before: RulesState,
  worldBefore: World,
  events: ShotEvent[],
): ShotOutcome {
  const shooter = before.turn;
  const opp = (1 - shooter) as 0 | 1;

  const potted: number[] = [];
  let firstContact: number | null = null;
  let firstContactIdx = -1;
  let railOrPotAfterContact = false;

  events.forEach((e, i) => {
    if (e.type === "pot") potted.push(e.ball);
    if (e.type === "ball" && firstContact === null) {
      if (e.a === 0 || e.b === 0) {
        firstContact = e.a === 0 ? e.b : e.a;
        firstContactIdx = i;
      }
    }
    if (
      firstContactIdx >= 0 &&
      i > firstContactIdx &&
      (e.type === "cushion" || e.type === "pot")
    ) {
      railOrPotAfterContact = true;
    }
  });

  const cueScratch = potted.includes(0);
  const eightPotted = potted.includes(8);
  const shooterGroup = before.groups[shooter];
  const clearedBefore =
    shooterGroup !== null && remaining(worldBefore, shooterGroup) === 0;

  // --- 8-ball on the break: re-rack, same breaker. -------------------------
  if (before.phase === "break" && eightPotted) {
    return {
      next: { ...initRules(shooter), message: "8 on the break — re-rack." },
      potted,
      firstContact,
      foul: null,
      reRack: true,
    };
  }

  // --- Win / loss on the 8. ------------------------------------------------
  if (eightPotted) {
    // Legal only if the shooter had already cleared their group and did not
    // scratch. Anything else loses the game.
    const legal8 = clearedBefore && !cueScratch;
    const winner = legal8 ? shooter : opp;
    const loseWhy = cueScratch
      ? "scratched potting the 8"
      : !clearedBefore
        ? "sunk the 8 early"
        : "potted the 8 illegally";
    return {
      next: {
        ...before,
        phase: "over",
        winner,
        ballInHand: false,
        message: legal8
          ? `Player ${shooter + 1} sinks the 8 — Player ${shooter + 1} wins!`
          : `Player ${shooter + 1} ${loseWhy} — Player ${opp + 1} wins!`,
      },
      potted,
      firstContact,
      foul: legal8 ? null : "illegal 8",
      reRack: false,
    };
  }

  // --- Foul detection. -----------------------------------------------------
  let foul: string | null = null;
  if (cueScratch) foul = "scratch";
  else if (firstContact === null) foul = "no ball hit";
  else if (!railOrPotAfterContact && potted.length === 0)
    foul = "no rail after contact";
  else if (
    before.phase === "assigned" &&
    shooterGroup !== null &&
    !clearedBefore &&
    groupOf(firstContact) !== shooterGroup &&
    groupOf(firstContact) !== "eight"
  )
    foul = "wrong ball first";
  else if (
    before.phase === "assigned" &&
    clearedBefore &&
    groupOf(firstContact) !== "eight"
  )
    foul = "must hit the 8";

  // --- Group assignment (first legal pot after the break opens the table). --
  let groups = before.groups.slice() as [Group | null, Group | null];
  let phase = before.phase;
  const legalObjectPots = potted.filter((id) => id !== 0 && id !== 8);

  if (!foul && (phase === "open" || phase === "break") && legalObjectPots.length) {
    const gs = new Set(legalObjectPots.map((id) => groupOf(id) as Group));
    if (gs.size === 1) {
      const g = [...gs][0];
      groups[shooter] = g;
      groups[opp] = g === "solids" ? "stripes" : "solids";
      phase = "assigned";
    }
    // Mixed solids+stripes on one shot: table stays open.
  } else if (phase === "break") {
    phase = "open";
  }

  // --- Did the shooter pot one of their own? -> keep the table. ------------
  const myGroup = groups[shooter];
  const pottedOwn =
    myGroup !== null
      ? potted.some((id) => groupOf(id) === myGroup)
      : legalObjectPots.length > 0; // open table: any object ball counts
  const keepTurn = !foul && pottedOwn;

  const nextTurn = keepTurn ? shooter : opp;
  // Narrate the shot: how many balls the shooter sank, whether they fouled, and
  // whose turn it is now. Drives the on-table popup as well as the status line.
  const sank = legalObjectPots.length;
  const balls = sank === 1 ? "1 ball" : `${sank} balls`;
  let did: string;
  if (sank > 0 && foul) did = `sank ${balls} then fouled (${foul})`;
  else if (foul) did = `fouled (${foul})`;
  else if (sank > 0) did = `sank ${balls}`;
  else did = "missed";
  const message = keepTurn
    ? `Player ${shooter + 1} ${did} — plays on.`
    : `Player ${shooter + 1} ${did} — Player ${nextTurn + 1}'s turn.`;
  const next: RulesState = {
    turn: nextTurn,
    groups,
    phase,
    ballInHand: !!foul, // foul -> incoming player gets ball in hand
    winner: null,
    message,
  };

  return { next, potted, firstContact, foul, reRack: false };
}
