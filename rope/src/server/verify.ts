// Replays one sealed bundle and prints its verdict as JSON: the same check the
// browser stamps into a P download (see sim/selfReplay.ts), run by the store
// in a subprocess so a two-hour run re-simulating for half a minute does not
// hold up the event loop that other players are posting to.
//
//   bun src/server/verify.ts <bundle.json.gz>

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { verifySelfReplay } from "../sim/selfReplay";
import type { Recording } from "../sim/trace";

const file = process.argv[2];
if (!file) {
  console.error("usage: verify <bundle.json.gz>");
  process.exit(2);
}
const raw = readFileSync(file);
const rec = JSON.parse((file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")) as Recording;
const v = verifySelfReplay(rec);
console.log(JSON.stringify({ identical: v.identical, firstDivergence: v.firstDivergence }));
