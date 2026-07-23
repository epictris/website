// Opt-in structured physics trace. Off by default (zero cost besides a flag
// check); harnesses enable it and drain `lines` to a JSONL file. Each record
// carries the sim frame stamped by Level.physicsProcess.
//
// Record shapes:
//   {f, t:"contact", mode:"overlap"|"sweep", body, hit, mobile, n:[x,y],
//    cvel:[x,y]?, test}                      — every moveAndCollide hit
//   {f, t:"frame", ...}                      — per-frame snapshot (harness)
//   {f, t:"transition", from, to}            — state changes (harness)
//   {f, t:"ledge", event:"grab"|"miss", ...} — ledge detection: every grab,
//    and near-miss rejections with a reason (wrong-side, behind-wall,
//    out-of-reach, seam) — grep these when a grab "should have" happened

export const PhysTrace = {
  enabled: false,
  frame: 0,
  lines: [] as string[],

  emit(record: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.lines.push(JSON.stringify({ f: this.frame, ...record }));
  },

  reset(): void {
    this.lines.length = 0;
    this.frame = 0;
  },
};
