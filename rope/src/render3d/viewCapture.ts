// A VIEW CAPTURE (F4 in the game): what is needed to put a headless grab on the
// same picture, in the units `cli shot` takes. `cli shot --view capture.json`
// reads it back.
export interface ViewCapture {
  // The registry id of the level played (`?level=`).
  level: string;
  // The sim-metre point the camera looks at (sim y down, as `--at`).
  at: [number, number];
  // Yaw and pitch in degrees (`--orbit`); the game's own view is head-on.
  orbit: [number, number];
  zoom: number;
  // The served tree (see src/sim/treeStamp.ts).
  tree: string;
  srcHash: string;
}
