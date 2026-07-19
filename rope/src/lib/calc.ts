// Calc — angle helpers ported from lib/Calc.cs.

import { Vec2 } from "../engine/vec2";
import { Mathf, mod } from "../engine/mathf";
import { WrapDirection } from "./types";

export const Calc = {
  mod(a: number, b: number): number {
    return mod(a, b);
  },

  absoluteAngle(fromDir: Vec2, toDir: Vec2, wrapDir: WrapDirection): number {
    let endAngle = toDir.angle();
    let startAngle = fromDir.angle();
    if (wrapDir === WrapDirection.Clockwise) {
      if (startAngle > endAngle) endAngle += Mathf.Tau;
    } else {
      if (endAngle > startAngle) startAngle += Mathf.Tau;
    }
    return Mathf.abs(endAngle - startAngle);
  },
};
