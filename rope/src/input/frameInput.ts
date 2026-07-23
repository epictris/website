// Per-frame input snapshot, ported from classes/Input/FrameInput.cs.

import { Vec2 } from "../engine/vec2";

export interface ButtonInput {
  held: boolean;
  pressed: boolean;
  released: boolean;
}

export const NO_BUTTON: ButtonInput = { held: false, pressed: false, released: false };

export interface FrameInput {
  moveLeft: ButtonInput;
  moveRight: ButtonInput;
  jump: ButtonInput;
  retract: ButtonInput;
  extend: ButtonInput;
  fire: ButtonInput;
  retractClick: ButtonInput;
  spawnSmallCircle: ButtonInput;
  spawnLargeCircle: ButtonInput;
  mouseWorldPosition: Vec2;
}

export function emptyFrameInput(): FrameInput {
  return {
    moveLeft: { ...NO_BUTTON },
    moveRight: { ...NO_BUTTON },
    jump: { ...NO_BUTTON },
    retract: { ...NO_BUTTON },
    extend: { ...NO_BUTTON },
    fire: { ...NO_BUTTON },
    retractClick: { ...NO_BUTTON },
    spawnSmallCircle: { ...NO_BUTTON },
    spawnLargeCircle: { ...NO_BUTTON },
    mouseWorldPosition: Vec2.ZERO,
  };
}

// Build a ButtonInput from a held flag and the previous frame's state.
export function button(held: boolean, prev: ButtonInput): ButtonInput {
  return { held, pressed: held && !prev.held, released: !held && prev.held };
}

export interface IInputSource {
  sample(): FrameInput;
}
