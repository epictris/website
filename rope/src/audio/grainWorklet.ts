// The audio-thread side of a loop voice (docs/sound.md#pace-and-pitch): one
// `WsolaLoop` or rolling-only `RollingTexture` per node, driven by k-rate params.
// Rolling randomizes short source windows; it does not scan the file at pace.
//
//   pace   how fast the file's own time runs, file-seconds per second
//   pitch  how far it is resampled (1 = the file's own pitch)
//   run    1 plays; 0 is silence that costs nothing and holds the position,
//          set once a loop has faded out, so a ball at rest is not paying for
//          a search per hop on a voice nobody hears
//
// The file arrives once, in an "init" message ({ channels, start, end, at },
// samples), and a changed clip window as "window" ({ start, end }); "stop"
// ends the node.
//
// Loaded with `audioWorklet.addModule` from the URL vite gives
// `grainWorklet.ts?worker&url` (bundled, its import included).

import { WsolaLoop } from "./grainCore";
import { RollingTexture } from "./rollingTexture";

// AudioWorkletGlobalScope, which TypeScript's DOM lib does not describe.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

type Message =
  | { type: "init"; channels: Float32Array[]; start: number; end: number; at: number; texture?: boolean; seed?: number }
  | { type: "window"; start: number; end: number }
  | { type: "stop" };

class GrainLoopProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pace", defaultValue: 1, minValue: 0, maxValue: 16, automationRate: "k-rate" },
      { name: "pitch", defaultValue: 1, minValue: 0.0625, maxValue: 16, automationRate: "k-rate" },
      { name: "run", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  private loop: WsolaLoop | RollingTexture | null = null;
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Message>) => {
      const m = e.data;
      if (m.type === "init") {
        this.loop = m.texture ? new RollingTexture(m.channels, sampleRate, m.seed) : new WsolaLoop(m.channels, sampleRate);
        this.loop.setWindow(m.start, m.end);
        if (this.loop instanceof WsolaLoop) this.loop.seek(m.at);
      } else if (m.type === "window") {
        this.loop?.setWindow(m.start, m.end);
      } else {
        this.stopped = true;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    if (this.stopped) return false;
    const out = outputs[0]!;
    const loop = this.loop;
    if (loop === null || params.run![0]! < 0.5) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    loop.process(out, out[0]!.length, params.pace![0]!, params.pitch![0]!);
    return true;
  }
}

registerProcessor("grain-loop", GrainLoopProcessor);
