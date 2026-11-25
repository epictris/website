// THE SPACEMOUSE in the editor (docs/editor.md, "SpaceMouse"): the cap's
// position, as the dev server's spacenavd bridge reports it
// (src/server/ndof.ts), in the VIEW's axes and normalised to about +-1 at full
// deflection.
//
// It is a state, not a stream of deltas: the cap held still off centre keeps
// flying though the device sends nothing new, so the editor reads `axes` once
// per frame and integrates it over the frame's time. It goes back to rest on
// the cap's own zero report, when the bridge or the server goes away, and when
// the window loses focus (a release made while another window had it would
// otherwise never be heard).
//
// The axes are Blender's (GHOST_NDOFManagerUnix: t = (x, y, -z), r = (-rx,
// -ry, rz) from spacenavd's), a right-handed frame of the view: x right, y up,
// z out of the screen toward the person, rotations about those axes by the
// right-hand rule. So pushing the cap away is t.z < 0, lifting it t.y > 0,
// tilting its top back toward the person r.x > 0, twisting it anticlockwise
// seen from above r.y > 0.

import type { NdofButton, NdofMotion, NdofStatus } from "../server/ndof";
import type { Vec3 } from "./visuals/viewPose";

// spacenavd's counts at full deflection (Blender's scale, "3Dconnexion devices
// send +/- 350 usually"), dimensionless.
const FULL_DEFLECTION = 350;

export interface NdofAxes {
  readonly t: Vec3;
  readonly r: Vec3;
}

const REST: NdofAxes = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 } };

export class NdofInput {
  private state: NdofAxes = REST;
  private live = false;

  // `onPress` hears a button going down, by spacenavd's number, in the focused
  // page only (as the cap is).
  constructor(onPress: (button: number) => void) {
    const hot = import.meta.hot;
    if (!hot) return;
    hot.on("ndof:button", (b: NdofButton) => {
      if (b.pressed && document.hasFocus() && document.visibilityState === "visible") onPress(b.button);
    });
    hot.on("ndof:motion", (m: NdofMotion) => {
      const k = 1 / FULL_DEFLECTION;
      this.state = {
        t: { x: m.t[0] * k, y: m.t[1] * k, z: -m.t[2] * k },
        r: { x: -m.r[0] * k, y: -m.r[1] * k, z: m.r[2] * k },
      };
    });
    hot.on("ndof:status", (s: NdofStatus) => {
      this.live = s.connected;
      if (!s.connected) this.state = REST;
    });
    hot.on("vite:ws:disconnect", () => {
      this.live = false;
      this.state = REST;
    });
    // A reconnected server has a fresh bridge, which connects on a hello.
    hot.on("vite:ws:connect", () => hot.send("ndof:hello"));
    window.addEventListener("blur", () => (this.state = REST));
    hot.send("ndof:hello");
  }

  // Whether spacenavd is connected through the dev server.
  get connected(): boolean {
    return this.live;
  }

  // The cap now, or at rest while this page is not the one being used: the
  // cap is shared with every other window (Blender, another editor tab), and
  // only the focused one flies.
  get axes(): NdofAxes {
    return document.hasFocus() && document.visibilityState === "visible" ? this.state : REST;
  }
}

export function atRest(a: NdofAxes): boolean {
  return a.t.x === 0 && a.t.y === 0 && a.t.z === 0 && a.r.x === 0 && a.r.y === 0 && a.r.z === 0;
}
