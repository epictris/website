// Gamepad polling shared by the input sources. Standard-mapping indices
// (https://w3c.github.io/gamepad/#remapping); poll-based, so each input
// source samples once per physics frame.

export const PAD_A = 0;
export const PAD_B = 1;
export const PAD_X = 2;
export const PAD_Y = 3;
export const PAD_LB = 4;
export const PAD_RB = 5;
export const PAD_LT = 6;
export const PAD_RT = 7;
export const PAD_DPAD_UP = 12;
export const PAD_DPAD_DOWN = 13;
export const PAD_DPAD_LEFT = 14;
export const PAD_DPAD_RIGHT = 15;

export const TRIGGER_THRESHOLD = 0.5; // analog trigger/button → digital press

// Live view of the first connected gamepad, or null.
export interface PadReader {
  axis(i: number): number;
  pressed(i: number): boolean;
}

export function readGamepad(): PadReader | null {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
  for (const pad of navigator.getGamepads()) {
    if (!pad || !pad.connected) continue;
    return {
      axis: (i) => pad.axes[i] ?? 0,
      pressed: (i) => {
        const b = pad.buttons[i];
        return b ? b.value > TRIGGER_THRESHOLD || b.pressed : false;
      },
    };
  }
  return null;
}
