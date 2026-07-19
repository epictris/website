// Debug draw buffer. The C# code drew directly via Godot's canvas each frame;
// here draw commands accumulate into a buffer that the canvas renderer consumes
// and Level clears at the top of every physics frame.

import { Vec2 } from "./vec2";

export type DrawCmd =
  | { kind: "line"; a: Vec2; b: Vec2; color: string; width: number }
  | { kind: "arrow"; a: Vec2; b: Vec2; color: string; width: number };

export const Colors = {
  SandyBrown: "#f4a460",
  DarkRed: "#8b0000",
  Red: "#ff4d4d",
  Yellow: "#ffe14d",
  White: "#ffffff",
  SkyBlue: "#65bddb",
} as const;

export const Debug = {
  cmds: [] as DrawCmd[],

  clear(): void {
    this.cmds.length = 0;
  },

  drawLine(a: Vec2, b: Vec2, color: string, width = 1): void {
    this.cmds.push({ kind: "line", a, b, color, width });
  },

  drawArrow(a: Vec2, b: Vec2, color: string, width = 1): void {
    this.cmds.push({ kind: "arrow", a, b, color, width });
  },
};
