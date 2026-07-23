// BallInputSource — gamepad → FrameInput for the ball & chain controller.
// Gamepad only for now (standard mapping):
//
//   left stick aim (rotates the ball) · RB shoot/release chain (hold-to-keep)
//   RT reel in · LT pay out · A sharp tug
//
// The ball controller reuses the FrameInput shape so recordings serialize with
// the existing tooling: aim → mouseWorldPosition, shoot → fire,
// reel in → retract, pay out → extend, tug → retractClick. Everything else
// stays NO_BUTTON.
//
// Aim encoding: while the stick is deflected the aim point is projected at the
// chain's absolute reach; a released stick sends the ball's own position,
// which BallPlayer reads as "not aiming" (rotation left to the physics).

import { Vec2 } from "../engine/vec2";
import {
  button,
  emptyFrameInput,
  type FrameInput,
  type IInputSource,
} from "./frameInput";
import { PAD_A, PAD_LT, PAD_RB, PAD_RT, readGamepad } from "./gamepad";
import { BallPlayer } from "../classes/ballPlayer";

const AIM_DEADZONE = 0.3; // left-stick deflection before it counts as aiming
const AIM_DISTANCE = BallPlayer.CHAIN_MAX_LENGTH;

export class BallInputSource implements IInputSource {
  private prev: FrameInput = emptyFrameInput();

  constructor(private aimOrigin: () => Vec2) {}

  sample(): FrameInput {
    const pad = readGamepad();
    let fire = false;
    let retract = false;
    let extend = false;
    let tug = false;
    let aimDir: Vec2 | null = null;
    if (pad) {
      const stick = new Vec2(pad.axis(0), pad.axis(1));
      if (stick.length() > AIM_DEADZONE) aimDir = stick.normalized();
      fire = pad.pressed(PAD_RB);
      retract = pad.pressed(PAD_RT);
      extend = pad.pressed(PAD_LT);
      tug = pad.pressed(PAD_A);
    }
    const origin = this.aimOrigin();
    const aimWorld = aimDir ? origin.add(aimDir.mul(AIM_DISTANCE)) : origin;

    const p = this.prev;
    const input: FrameInput = {
      ...emptyFrameInput(),
      fire: button(fire, p.fire),
      retract: button(retract, p.retract),
      extend: button(extend, p.extend),
      retractClick: button(tug, p.retractClick),
      mouseWorldPosition: aimWorld,
    };
    this.prev = input;
    return input;
  }
}
