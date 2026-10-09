// `verifySelfReplay` for a page that is still playing: the re-simulation runs
// in a worker, so pressing P does not freeze the game while it runs.
//
// On the page's own thread it cost ~0.35 ms per recorded frame (a 265-frame
// editor test froze for 96 ms, trace 2026-10-09), so a two-minute run would
// have stopped the game for over two seconds at the press. The verdict is the
// same one: a worker runs the same modules in the same engine as the page.
//
// Browser-only (`Worker`, `import.meta.url` resolved by vite); the CLI and the
// server call `verifySelfReplay` directly.

import type { SelfReplayVerdict } from "./selfReplay";
import type { Recording } from "./trace";

// A fresh worker per check, ended with it: P is pressed a few times a session,
// and a worker kept alive would hold the whole sim's modules for nothing.
export function verifySelfReplayOffThread(rec: Recording): Promise<SelfReplayVerdict> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./selfReplayWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<SelfReplayVerdict>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`self-replay worker: ${e.message}`));
    };
    worker.postMessage(rec);
  });
}
