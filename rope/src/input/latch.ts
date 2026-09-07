// ButtonLatch - a button's level as the fixed step should see it.
//
// The live input sources used to keep a plain boolean per button: set on the
// down event, cleared on the up, read once per sim step. A click shorter than a
// step - both events landing between two samples - never changed what any
// sample saw, and the press was gone without a trace (session-929f: a release
// at f852 and no press for the 77 frames after, on a hand whose recorded holds
// run as short as three frames). The mirror case lost the other edge: a
// release-and-re-press inside one step read as an unbroken hold.
//
// The latch keeps the transitions the sampler has not reported yet and plays
// them out one per sample, so every edge the DOM delivered reaches the sim as at
// least one frame. A sub-step click becomes one held frame followed by a
// released one; a sub-step re-click becomes a released frame followed by a held
// one. The queue only ever holds alternating levels, and a level that matches
// the last one queued (a key's auto-repeat, an up without a down because the
// down landed off the canvas) is not a transition and queues nothing.
export class ButtonLatch {
  // The level the last sample() returned - what the sim believes right now.
  private reported = false;
  // Levels the sim has not been told yet, oldest first; strictly alternating.
  private pending: boolean[] = [];

  // Fold in the device's current level.
  set(level: boolean): void {
    if (level !== this.level()) this.pending.push(level);
  }

  // The device's level as of its latest event, queue included.
  level(): boolean {
    return this.pending.length > 0 ? this.pending[this.pending.length - 1]! : this.reported;
  }

  // Take the level as it stands with no transition to report: the queue is
  // dropped. For a source that is not driving the game right now (the editor
  // between tests), where a click on the canvas is a selection and not a shot,
  // and must not be played into the first frames of the next test.
  reset(level: boolean): void {
    this.pending.length = 0;
    this.reported = level;
  }

  // The level for this sim step: the next unreported transition if there is
  // one, else the level as it stands. Call exactly once per step.
  sample(): boolean {
    if (this.pending.length > 0) this.reported = this.pending.shift()!;
    return this.reported;
  }
}
