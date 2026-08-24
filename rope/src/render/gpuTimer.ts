// How long the GPU spent on the frame, from the GPU's own clock.
//
// The renderer's wall-clock bracket around `renderer.render()` measures the CPU
// submitting the frame, not the GPU drawing it: WebGL commands are queued, so a
// scene that is entirely GPU-bound can show a 0.4 ms "draw" and still miss 60 Hz.
// `EXT_disjoint_timer_query_webgl2` is the only reading in a browser that is
// actually about the GPU, which is why the HUD's GPU row is this and not a
// share-of-frame guess.
//
// The result is not ready when the frame ends - that is the point of an
// asynchronous query - so it arrives a frame or three later. For a HUD that
// averages over a five-second window, a reading being two frames old costs
// nothing.
//
// Nothing else in the project may keep a query open at the same time: WebGL2
// allows exactly one active TIME_ELAPSED query per context.

// Queries in flight before the timer stops opening new ones. A 144 Hz display
// with a frame or two of driver pipelining is routinely four deep, which is why
// this is not the three it looks like it should be - and why `begin` polls
// whether or not it opens one. A pool that filled while nothing drained it left
// the reading frozen at whatever the last retired query said, for ever, and the
// HUD reported a rock-steady 2.789376 ms through a scene that plainly was not.
const MAX_IN_FLIGHT = 8;

interface TimerExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  // Null where the extension is missing, which is most non-Chromium browsers and
  // any context whose driver refuses timing. The HUD reports the row as
  // unavailable rather than as zero.
  static create(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuTimer | null {
    if (!(gl instanceof WebGL2RenderingContext)) return null;
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    return ext ? new GpuTimer(gl, ext) : null;
  }

  // Milliseconds of GPU time for the most recent frame whose query has come
  // back, or null until the first one does.
  lastMs: number | null = null;

  private readonly pending: WebGLQuery[] = [];
  private readonly free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: TimerExt,
  ) {}

  // Bracket the draw. `end` must follow every `begin` that returned having
  // opened one, which is why the pair is written around a single statement in
  // `Scene3D.render` rather than spread across the frame.
  begin(): void {
    // Poll FIRST, and unconditionally: this is the only call the timer is
    // guaranteed to get every frame, so a backlog that stopped `end` from
    // running has to be cleared from here or it never clears at all.
    this.drain();
    if (this.active || this.pending.length >= MAX_IN_FLIGHT) return;
    const query = this.free.pop() ?? this.gl.createQuery();
    if (!query) return;
    this.active = query;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
  }

  end(): void {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    this.drain();
  }

  // Results, in submission order. A DISJOINT flag means the GPU was interrupted
  // (a mode switch, another context taking the device) and every timing spanning
  // it is meaningless - the spec's own advice is to throw them away, not to plot
  // the spike they produce.
  private drain(): void {
    const { gl, ext } = this;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length > 0) {
      const query = this.pending[0]!;
      if (!(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean)) break;
      this.pending.shift();
      if (!disjoint) {
        // Nanoseconds, per the extension.
        this.lastMs = (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6;
      }
      this.free.push(query);
    }
    if (disjoint) this.lastMs = null;
  }
}
