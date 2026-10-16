// The worker the glass ball's broken pieces are simulated in (glassShardsSim.ts),
// off the page's thread: a break throws a few hundred rigid bodies into a 3D
// physics world, and stepping them cost the page a millisecond or two a frame
// for the seconds they took to settle, and 15-20 ms on the frame of the break
// itself - a hitch at the one moment the player is watching. Here it costs the
// page a message each way a frame.
//
// Messages are handled strictly in order (`ToWorker`): each one waits for the
// last, and for the engine's own start-up.

import RAPIER from "@dimforge/rapier3d-compat";
import { ShardSim, type FromWorker, type ToWorker } from "./glassShardsSim";

const ready = RAPIER.init();
let sim: ShardSim | null = null;
let queue: Promise<void> = Promise.resolve();

const scope = self as unknown as { postMessage(m: FromWorker, transfer?: Transferable[]): void; onmessage: ((ev: MessageEvent<ToWorker>) => void) | null };

scope.onmessage = (ev) => {
  const m = ev.data;
  queue = queue.then(async () => {
    await ready;
    sim ??= new ShardSim(RAPIER);
    switch (m.type) {
      case "init":
        sim.cut(m.spec);
        scope.postMessage({ type: "pieces", pieces: sim.pieces, maxChunks: sim.maxChunks });
        break;
      case "level":
        sim.bind(m.level);
        break;
      case "scenery":
        sim.setScenery(m.scenery);
        break;
      case "frame": {
        const output = sim.frame(m.input);
        scope.postMessage({ type: "frame", seq: m.seq, output }, [output.poses.buffer]);
        break;
      }
      case "reset":
        sim.reset();
        break;
    }
  });
};
