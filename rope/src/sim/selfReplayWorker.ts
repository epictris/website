// The worker half of `verifySelfReplayOffThread` (selfReplayOffThread.ts): one
// recording in, its verdict out. The same `verifySelfReplay` the CLI and the
// server run, in the same browser engine as the page that recorded the run,
// which is what the check is about - only not on the thread drawing the game.

import { verifySelfReplay } from "./selfReplay";
import type { Recording } from "./trace";

self.onmessage = (e: MessageEvent<Recording>) => {
  self.postMessage(verifySelfReplay(e.data));
};
