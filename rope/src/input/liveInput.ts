// LiveInputSource — keyboard + mouse → FrameInput, ported from
// classes/Input/LiveInputSource.cs. Keybinds match the Godot project's input map
// (physical keys, US-QWERTY positions):
//
//   move_left R · move_right T · jump Space · retract C · extend S
//   fire left-click · retract-tug right-click · spawn 1 small / 2 large circle

import { Vec2 } from "../engine/vec2";
import {
  button,
  emptyFrameInput,
  type ButtonInput,
  type FrameInput,
  type IInputSource,
} from "./frameInput";
import { screenToWorld, type Camera } from "../render/camera";

export class LiveInputSource implements IInputSource {
  private keys = new Set<string>();
  private mouseLeft = false;
  private mouseRight = false;
  private mouseScreen = new Vec2(0, 0);
  private prev: FrameInput = emptyFrameInput();

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
  ) {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseScreen = new Vec2(e.clientX - rect.left, e.clientY - rect.top);
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouseLeft = true;
      if (e.button === 2) this.mouseRight = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseLeft = false;
      if (e.button === 2) this.mouseRight = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private held(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  sample(): FrameInput {
    const b = (held: boolean, prev: ButtonInput) => button(held, prev);
    const p = this.prev;
    const input: FrameInput = {
      moveLeft: b(this.held("KeyR"), p.moveLeft),
      moveRight: b(this.held("KeyT"), p.moveRight),
      jump: b(this.held("Space"), p.jump),
      retract: b(this.held("KeyC"), p.retract),
      extend: b(this.held("KeyS"), p.extend),
      fire: b(this.mouseLeft, p.fire),
      retractClick: b(this.mouseRight, p.retractClick),
      spawnSmallCircle: b(this.held("Digit1"), p.spawnSmallCircle),
      spawnLargeCircle: b(this.held("Digit2"), p.spawnLargeCircle),
      mouseWorldPosition: screenToWorld(this.camera, this.mouseScreen.x, this.mouseScreen.y),
    };
    this.prev = input;
    return input;
  }
}
