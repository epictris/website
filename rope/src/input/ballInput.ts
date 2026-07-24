// BallInputSource — mouse + gamepad → FrameInput for the ball & chain
// controller. Keyboard has no bindings here; the two aim devices merge, most
// recent wins:
//
//   Mouse:   move to aim (cursor) · left-click deploy chain · right-click reel in
//   Gamepad: left stick aim · RB deploy chain (hold-to-keep) · A reel in ·
//            top face button (X on a Pro Controller) restart level
//
// The ball controller reuses the FrameInput shape so recordings serialize with
// the existing tooling: aim → mouseWorldPosition, deploy → fire,
// reel in → retract, restart → jump. Everything else stays NO_BUTTON.
//
// Aim encoding differs by device. The mouse always aims: its cursor projects
// straight to world space. The stick aims only while deflected; a released
// stick sends the ball's own position, which BallPlayer reads as "not aiming"
// (rotation left to the physics).

import { Vec2 } from "../engine/vec2";
import {
  button,
  emptyFrameInput,
  type FrameInput,
  type IInputSource,
} from "./frameInput";
import { PAD_A, PAD_RB, PAD_Y, readGamepad } from "./gamepad";
import { screenToWorld, type Camera } from "../render/camera";
import { BallPlayer } from "../classes/ballPlayer";

const AIM_DEADZONE = 0.3; // left-stick deflection before it counts as aiming
const AIM_DISTANCE = BallPlayer.CHAIN_MAX_LENGTH;

export class BallInputSource implements IInputSource {
  private prev: FrameInput = emptyFrameInput();
  private mouseLeft = false;
  private mouseRight = false;
  private mouseScreen = new Vec2(0, 0);
  private aimSource: "mouse" | "pad" = "mouse";

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private aimOrigin: () => Vec2,
  ) {
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseScreen = new Vec2(e.clientX - rect.left, e.clientY - rect.top);
      this.aimSource = "mouse";
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouseLeft = true;
      if (e.button === 2) this.mouseRight = true;
      this.aimSource = "mouse";
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseLeft = false;
      if (e.button === 2) this.mouseRight = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  sample(): FrameInput {
    const pad = readGamepad();
    let padFire = false;
    let padReel = false;
    let restart = false;
    let padAim: Vec2 | null = null;
    if (pad) {
      const stick = new Vec2(pad.axis(0), pad.axis(1));
      if (stick.length() > AIM_DEADZONE) {
        padAim = stick.normalized();
        this.aimSource = "pad";
      }
      padFire = pad.pressed(PAD_RB);
      padReel = pad.pressed(PAD_A);
      restart = pad.pressed(PAD_Y);
    }

    const aimWorld =
      this.aimSource === "pad"
        ? this.aimOrigin().add((padAim ?? Vec2.ZERO).mul(AIM_DISTANCE))
        : screenToWorld(this.camera, this.mouseScreen.x, this.mouseScreen.y);

    const p = this.prev;
    const input: FrameInput = {
      ...emptyFrameInput(),
      fire: button(this.mouseLeft || padFire, p.fire),
      retract: button(this.mouseRight || padReel, p.retract),
      jump: button(restart, p.jump), // top face button (X on Pro Controller) → restart
      mouseWorldPosition: aimWorld,
    };
    this.prev = input;
    return input;
  }
}
