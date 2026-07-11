// Snooker rules layer. Same shape as the 8-ball layer (rules.ts): it takes the
// rules state, the table as it was when the shot was taken, and the ordered event
// log the sim produced, and returns the next state plus which balls were potted.
//
// Snooker is point-scoring, not clearing groups:
//  - While reds remain the shooter alternates red → colour → red …: pot a red
//    (+1) then nominate any colour (+its value, colour is RESPOTTED), and repeat.
//  - Once the reds are gone the six colours must be potted in ascending order
//    (yellow 2 … black 7) and STAY down. The black finishing the frame ends it.
//  - A foul awards the value of the ball on / involved (min 4) to the opponent,
//    passes the turn, and returns any potted colours to their spots. A potted
//    cue ball (scratch) is respotted in-hand.

import { ballValue, isColour, isRed, SNOOKER_COLOURS, type ShotEvent, type World } from "./physics";
import type { BallOn, RulesState } from "./rules";

const NAME: Record<number, string> = {
  16: "yellow",
  17: "green",
  18: "brown",
  19: "blue",
  20: "pink",
  21: "black",
};
const ballName = (id: number) => (isRed(id) ? "a red" : (NAME[id] ?? "a ball"));

export function initSnooker(breaker: 0 | 1 = 0): RulesState {
  return {
    turn: breaker,
    groups: [null, null],
    phase: "break",
    ballInHand: true, // break is from the D — free placement is fine
    winner: null,
    message: "Break!",
    scores: [0, 0],
    reds: 15,
    ballOn: "red",
  };
}

export type SnookerOutcome = {
  next: RulesState;
  potted: number[];
  firstContact: number | null;
  foul: string | null;
  respot: number[]; // colour ids to place back on their spots
  reRack: boolean; // never (kept for a uniform shape with the pool outcome)
};

/** Colours (16..21) still on the table after this shot, lowest first. */
function remainingColours(worldBefore: World, pottedThisShot: number[]): number[] {
  const off = new Set<number>(
    worldBefore.balls.filter((b) => b.potted).map((b) => b.id),
  );
  for (const id of pottedThisShot) off.add(id);
  return SNOOKER_COLOURS.filter((id) => !off.has(id));
}

export function evaluateSnooker(
  before: RulesState,
  worldBefore: World,
  events: ShotEvent[],
): SnookerOutcome {
  const shooter = before.turn;
  const opp = (1 - shooter) as 0 | 1;
  const scores: [number, number] = [before.scores![0], before.scores![1]];
  const ballOn: BallOn = before.ballOn ?? "red";

  // Parse the event log: pots (in order), the cue's first ball contact, and
  // whether anything hit a cushion / dropped after that contact (the no-rail foul).
  const potted: number[] = [];
  let firstContact: number | null = null;
  let firstContactIdx = -1;
  let railOrPotAfterContact = false;
  events.forEach((e, i) => {
    if (e.type === "pot") potted.push(e.ball);
    if (e.type === "ball" && firstContact === null && (e.a === 0 || e.b === 0)) {
      firstContact = e.a === 0 ? e.b : e.a;
      firstContactIdx = i;
    }
    if (firstContactIdx >= 0 && i > firstContactIdx && (e.type === "cushion" || e.type === "pot"))
      railOrPotAfterContact = true;
  });

  const cueScratch = potted.includes(0);
  const pottedReds = potted.filter(isRed);
  const pottedColours = potted.filter(isColour);
  let reds = before.reds! - pottedReds.length; // reds never come back, even on a foul

  // --- Foul detection. Accumulate the penalty (min 4, else the highest value
  //     of the ball wrongly hit / potted / the ball on). -----------------------
  let foul: string | null = null;
  let penalty = 4;
  const bump = (v: number) => (penalty = Math.max(penalty, v));
  const setFoul = (why: string) => {
    if (!foul) foul = why;
  };

  if (cueScratch) {
    setFoul("cue ball potted");
  }
  if (firstContact === null) {
    setFoul("no ball hit");
  } else if (ballOn === "red") {
    if (!isRed(firstContact)) {
      setFoul(`hit ${ballName(firstContact)} first`);
      bump(ballValue(firstContact));
    }
  } else if (ballOn === "colour") {
    if (!isColour(firstContact)) {
      setFoul("hit a red, needed a colour");
    }
  } else {
    // A specific colour is on (reds gone).
    if (firstContact !== ballOn) {
      setFoul(`hit ${ballName(firstContact)}, needed ${ballName(ballOn)}`);
      bump(Math.max(ballValue(firstContact), ballValue(ballOn)));
    }
  }

  // Wrongly-potted balls are fouls too.
  if (ballOn === "red" && pottedColours.length) {
    setFoul("potted a colour off a red");
    for (const c of pottedColours) bump(ballValue(c));
  } else if (ballOn === "colour") {
    if (pottedReds.length) {
      setFoul("potted a red needing a colour");
    }
    if (pottedColours.length > 1) {
      setFoul("potted two colours");
      for (const c of pottedColours) bump(ballValue(c));
    }
  } else if (typeof ballOn === "number") {
    for (const c of pottedColours) if (c !== ballOn) {
      setFoul(`potted ${ballName(c)} out of turn`);
      bump(ballValue(c));
    }
  }

  // Hit the right ball but potted nothing and drove nothing to a cushion.
  if (!foul && potted.length === 0 && firstContact !== null && !railOrPotAfterContact) {
    setFoul("no cushion after contact");
  }

  if (typeof ballOn === "number") bump(ballValue(ballOn)); // colours phase: min = ball on

  const score = () => `[${scores[0]}–${scores[1]}]`;

  // --- Foul: points to the opponent, turn passes, colours respot. ------------
  if (foul) {
    scores[opp] += penalty;
    const nextOn: BallOn = reds > 0 ? "red" : (remainingColours(worldBefore, potted)[0] ?? "red");
    return {
      next: {
        ...before,
        scores,
        reds,
        ballOn: nextOn,
        turn: opp,
        phase: "assigned",
        ballInHand: cueScratch, // scratch → play from in-hand (the D)
        winner: null,
        message: `Player ${shooter + 1} fouls (${foul}) — ${penalty} to Player ${opp + 1}. ${score()} — Player ${opp + 1}'s turn.`,
      },
      potted,
      firstContact,
      foul,
      respot: pottedColours, // returned to their spots; reds stay down
      reRack: false,
    };
  }

  // --- Legal shot. -----------------------------------------------------------
  let keepTurn = false;
  let nextOn: BallOn = "red";
  let respot: number[] = [];
  let did = "misses";
  let winner: 0 | 1 | null = null;

  if (ballOn === "red") {
    if (pottedReds.length) {
      scores[shooter] += pottedReds.length; // +1 per red
      keepTurn = true;
      nextOn = "colour"; // now nominate a colour
      did = pottedReds.length === 1 ? "pots a red (+1)" : `pots ${pottedReds.length} reds (+${pottedReds.length})`;
    } else {
      nextOn = reds > 0 ? "red" : (remainingColours(worldBefore, potted)[0] ?? "red");
      did = "plays safe";
    }
  } else if (ballOn === "colour") {
    if (pottedColours.length === 1) {
      const c = pottedColours[0];
      scores[shooter] += ballValue(c);
      respot = reds > 0 ? [c] : []; // returns while reds remain; stays once they're gone
      keepTurn = true;
      nextOn = reds > 0 ? "red" : (remainingColours(worldBefore, potted)[0] ?? "red");
      did = `pots ${NAME[c]} (+${ballValue(c)})`;
    } else {
      nextOn = reds > 0 ? "red" : (remainingColours(worldBefore, potted)[0] ?? "red");
      did = "misses the colour";
    }
  } else {
    // Specific colour, reds gone: pot it, it stays down, advance to the next.
    if (pottedColours.includes(ballOn)) {
      scores[shooter] += ballValue(ballOn);
      const rest = remainingColours(worldBefore, potted); // ballOn already excluded
      did = `pots ${NAME[ballOn]} (+${ballValue(ballOn)})`;
      if (rest.length === 0) {
        // The black finished the frame.
        winner = scores[shooter] === scores[opp] ? shooter : scores[0] > scores[1] ? 0 : 1;
      } else {
        keepTurn = true;
        nextOn = rest[0];
      }
    } else {
      nextOn = remainingColours(worldBefore, potted)[0] ?? "red";
      did = "misses";
    }
  }

  if (winner !== null) {
    return {
      next: {
        ...before,
        scores,
        reds,
        ballOn: nextOn,
        phase: "over",
        turn: shooter,
        ballInHand: false,
        winner,
        message: `Player ${winner + 1} wins ${scores[winner]}–${scores[1 - winner]}!`,
      },
      potted,
      firstContact,
      foul: null,
      respot,
      reRack: false,
    };
  }

  const nextTurn = keepTurn ? shooter : opp;
  const tail = keepTurn
    ? `${score()} — plays on.`
    : `${score()} — Player ${nextTurn + 1}'s turn.`;
  return {
    next: {
      ...before,
      scores,
      reds,
      ballOn: nextOn,
      turn: nextTurn,
      phase: "assigned",
      ballInHand: false,
      winner: null,
      message: `Player ${shooter + 1} ${did} ${tail}`,
    },
    potted,
    firstContact,
    foul: null,
    respot,
    reRack: false,
  };
}
