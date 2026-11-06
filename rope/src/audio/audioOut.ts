// The Web Audio side of the sound system (docs/sound.md#playing-it).
//
// `SoundObserver` says what each sim step sounded like; this plays it with the
// files assigned to each event (`SOUND_BANK`, audio/slots.ts). It owns the
// AudioContext, a looping voice per continuous sound (a roll per surface, the
// whoosh, the wade), the one-shots, and the clock that puts each step's sounds
// at the right moment.
//
// TIMING. A rendered frame runs zero, one or several sim steps, all at once.
// Their sounds are queued as the steps run (`push`) and scheduled together at
// the end of the frame (`flush`), each step at its own place on the sim's 60 Hz
// clock: the last step of the frame plays `LEAD` from now, the one before it a
// step earlier. Played as they arrived instead, a frame's worth of steps would
// land in a lump, and a fast wind's links would be a 60 Hz buzz.
//
// SILENCE. A frame that ran no steps - a paused replay, the settings panel,
// the finish linger's end - fades every loop out, so a ball that stops being
// simulated stops being heard.
//
// LIVE. The bank and the library are read afresh on every step, so an
// assignment changed in the editor's Sounds menu is heard on the next one: a
// loop whose file is no longer assigned is stopped and its new one started.

import type { SoundLevel } from "../render/settings";
import { SOUND_ASSETS } from "./library";
import { SOUND_BANK, resolveSlot, type SlotParams, type SoundFamily } from "./slots";
import type { SoundStep } from "./soundObserver";
import { SURFACE_KINDS, type SurfaceKind } from "./surfaces";

export type SoundVolume = SoundLevel;
// Off, and three steps of about 5 dB.
const VOLUME_GAIN: Record<SoundVolume, number> = { off: 0, low: 0.32, medium: 0.56, high: 1 };

// How far ahead of the audio clock the frame's last step is scheduled, s: a
// little over a 60 Hz frame, so a frame that runs late still lands its sounds
// in the future.
const LEAD = 0.025;
const STEP = 1 / 60;
// How quickly a loop follows its targets, s - one step, so it tracks the sim
// without zippering between steps.
const FOLLOW = STEP;
// How wide the stereo picture is: a sound at the edge of the view pans this
// far, and one further out no further.
const PAN_WIDTH = 0.6;
// Concurrent one-shots, beyond which a new one is dropped: a fast wind can ask
// for a few hundred links a second.
const MAX_ONESHOTS = 48;
// A one-shot is louder the faster it happened, in proportion, up to this many
// times its volume at the reference speed; a loop up to `LOOP_MAX_GAIN`.
const ONESHOT_MAX_GAIN = 2;
const LOOP_MAX_GAIN = 1.5;
// A loop's pitch is held inside two octaves either way, so a speed far off its
// reference does not turn a roll into a squeal or a growl.
const RATE_MIN = 0.25;
const RATE_MAX = 4;

// A loop's level against its reference speed, by family: a roll and a wade
// grow in proportion to the speed; the air goes as its SQUARE (the pressure of
// moving air goes as the dynamic pressure, rho v^2 / 2), which is what keeps a
// whoosh silent at walking pace and loud in a swing. Each fades in from rest
// over the bottom of its range, so a ball creeping or settling plays nothing.
function loopLevel(family: SoundFamily, ratio: number): number {
  const fade = smoothstep(0.02, 0.1, ratio);
  const level = family === "whoosh" ? ratio * ratio : ratio;
  return Math.min(LOOP_MAX_GAIN, level) * fade;
}

interface LoopVoice {
  // What it is playing: the slot it was resolved to, and which of its files.
  slot: string;
  sound: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

export class AudioOut {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bus: AudioNode | null = null;
  private volume: SoundVolume;
  private readonly queue: SoundStep[] = [];
  // Keyed by CHANNEL: "roll:moss", "whoosh", "wade".
  private readonly loops = new Map<string, LoopVoice>();
  // Decoded files, by library key (a key carries its bytes' hash, so a key is
  // one recording for ever).
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private readonly ready = new Map<string, AudioBuffer>();
  // The file a slot played last, so a one-shot never plays the same twice
  // running when it has a choice.
  private readonly lastPick = new Map<string, string>();
  private live = 0;
  // Instruments, for `window.__sound` (see `stats`).
  private readonly counts = { oneShots: 0, dropped: 0, missing: 0 };
  private analyser: AnalyserNode | null = null;
  private capture: { node: ScriptProcessorNode; chunks: Float32Array[] } | null = null;

  constructor(volume: SoundVolume) {
    this.volume = volume;
  }

  // Called from a user gesture: browsers start an AudioContext suspended until
  // the page is interacted with, and the game's first click is the earliest
  // there is.
  unlock(): void {
    if (this.volume === "off") return;
    if (this.ctx === null) this.start();
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  // From the settings panel, which is itself a press: a sound turned on there
  // starts there, rather than waiting for the next click in the level.
  setVolume(volume: SoundVolume): void {
    this.volume = volume;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(VOLUME_GAIN[volume], this.ctx.currentTime, 0.05);
    }
    this.unlock();
  }

  // A hidden tab runs no frames, so nothing would fade the loops: suspend.
  setHidden(hidden: boolean): void {
    if (this.ctx === null) return;
    if (hidden) void this.ctx.suspend();
    else if (this.volume !== "off") void this.ctx.resume();
  }

  // The bank or the library changed (the editor's menu): start decoding what
  // is newly assigned. The loops re-resolve on their next step by themselves.
  bankChanged(): void {
    this.preloadAssigned();
  }

  push(step: SoundStep): void {
    if (this.ctx === null || this.volume === "off") return;
    this.queue.push(step);
  }

  // Schedule the steps this frame ran. `listenerX` is the camera's centre and
  // `halfWidth` how far either side of it the view reaches, metres.
  flush(listenerX: number, halfWidth: number): void {
    const ctx = this.ctx;
    if (ctx === null || ctx.state !== "running") {
      this.queue.length = 0;
      return;
    }
    const now = ctx.currentTime;
    const pan = (x: number): number => {
      const p = (x - listenerX) / Math.max(halfWidth, 1e-3);
      return Math.max(-1, Math.min(1, p)) * PAN_WIDTH;
    };
    const n = this.queue.length;
    if (n === 0) {
      this.silence();
      return;
    }
    for (let i = 0; i < n; i++) {
      this.playStep(this.queue[i]!, Math.max(now, now + LEAD - (n - 1 - i) * STEP), pan);
    }
    this.queue.length = 0;
  }

  // Fade every loop out: no step is coming (a frame that ran none, or a page
  // that has stopped stepping altogether - the editor leaving ▶ Test).
  silence(): void {
    if (!this.ctx) return;
    this.queue.length = 0;
    for (const v of this.loops.values()) v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  // Play one library file now, at `volume` dB, centred - the menu's audition.
  // Starts the context if it has to (a preview is a press).
  async preview(key: string, volume = 0, rate = 1): Promise<boolean> {
    this.unlock();
    const buffer = await this.load(key);
    if (!buffer || !this.ctx) return false;
    this.oneShot(buffer, dbToGain(volume), 0, rate, this.ctx.currentTime);
    return true;
  }

  // ---------------------------------------------------------------------------

  private start(): void {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = VOLUME_GAIN[this.volume];
    // A limiter, not a compressor: it touches only what would clip, which a
    // few loud one-shots on top of a roll and a whoosh can.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    this.master.connect(limiter);
    limiter.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    limiter.connect(this.analyser);
    this.bus = this.master;
    this.preloadAssigned();
  }

  private preloadAssigned(): void {
    if (!this.ctx) return;
    for (const slot of Object.values(SOUND_BANK.slots)) for (const key of slot.sounds ?? []) void this.load(key);
  }

  // Fetch and decode a library file, once. Null for a key the library does not
  // have or a file that fails, which is said once in the console and is then
  // silence - a missing sound is a sound that is not played, not a crash.
  private load(key: string): Promise<AudioBuffer | null> {
    const held = this.buffers.get(key);
    if (held) return held;
    const ctx = this.ctx;
    const asset = SOUND_ASSETS[key];
    if (!ctx || !asset) return Promise.resolve(null);
    const p = fetch(asset.file)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.arrayBuffer();
      })
      .then((bytes) => ctx.decodeAudioData(bytes))
      .then((buffer) => {
        this.ready.set(key, buffer);
        return buffer;
      })
      .catch((err: unknown) => {
        this.counts.missing++;
        console.warn(`[sound] "${key}" (${asset.file}): ${String(err)}`);
        return null;
      });
    this.buffers.set(key, p);
    return p;
  }

  // The decoded buffer if it is ready; otherwise starts it and answers null,
  // so the step plays what it can rather than waiting.
  private now(key: string): AudioBuffer | null {
    const b = this.ready.get(key);
    if (!b) void this.load(key);
    return b ?? null;
  }

  private playStep(step: SoundStep, t: number, pan: (x: number) => number): void {
    for (const surface of SURFACE_KINDS) {
      if (surface === "vine") continue;
      const roll = step.roll.get(surface);
      this.driveLoop(`roll:${surface}`, "roll", surface, roll?.speed ?? 0, roll ? pan(roll.x) : null, t);
    }
    this.driveLoop("whoosh", "whoosh", null, step.air.speed, pan(step.air.x), t);
    this.driveLoop("wade", "wade", null, step.wade.speed * step.wade.interface, pan(step.wade.x), t);
    if (step.splash) this.play("splash", null, step.splash.speed, pan(step.splash.x), t);
    for (const s of step.strikes) this.play(s.family, s.surface, s.speed, pan(s.x), t + (s.at - 1) * STEP);
    for (const c of step.clinks) this.play("wind", null, c.speed, pan(c.x), t + (c.at - 1) * STEP);
  }

  // A loop, at `speed` (0 = silent). `pan` null is "not touching": fade out.
  private driveLoop(
    channel: string,
    family: SoundFamily,
    surface: SurfaceKind | null,
    speed: number,
    pan: number | null,
    t: number,
  ): void {
    const resolved = resolveSlot(SOUND_BANK, family, surface);
    let voice = this.loops.get(channel);
    // Unassigned, or assigned something else since it started: stop it.
    if (voice && (!resolved || voice.slot !== resolved.key || !resolved.params.sounds.includes(voice.sound))) {
      voice.gain.gain.setTargetAtTime(0, t, 0.03);
      voice.src.stop(t + 0.2);
      this.loops.delete(channel);
      voice = undefined;
    }
    if (!resolved) return;
    const params = resolved.params;
    const active = pan !== null && speed > 0;
    if (!voice) {
      if (!active) return;
      const key = this.pick(resolved.key, params);
      const buffer = key ? this.now(key) : null;
      if (!key || !buffer) return;
      voice = this.startLoop(resolved.key, key, buffer, t);
      this.loops.set(channel, voice);
    }
    const ratio = speed / Math.max(params.refSpeed, 1e-3);
    const gain = active ? dbToGain(params.volume) * loopLevel(family, ratio) : 0;
    voice.gain.gain.setTargetAtTime(gain, t, FOLLOW);
    if (active) {
      const rate = Math.min(RATE_MAX, Math.max(RATE_MIN, Math.pow(Math.max(ratio, 1e-3), params.pitchFollow)));
      voice.src.playbackRate.setTargetAtTime(rate, t, FOLLOW);
      voice.pan.pan.setTargetAtTime(pan, t, FOLLOW);
    }
  }

  private startLoop(slot: string, sound: string, buffer: AudioBuffer, t: number): LoopVoice {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    src.connect(gain).connect(pan).connect(this.bus!);
    // From a random point in the file, so a roll that stops and starts does
    // not restart the same bar of it every time.
    src.start(t, Math.random() * buffer.duration);
    src.onended = () => pan.disconnect();
    return { slot, sound, src, gain, pan };
  }

  // A one-shot for `family` on `surface`, at `speed`.
  private play(family: SoundFamily, surface: SurfaceKind | null, speed: number, pan: number, t: number): void {
    const resolved = resolveSlot(SOUND_BANK, family, surface);
    if (!resolved) return;
    const params = resolved.params;
    const key = this.pick(resolved.key, params);
    const buffer = key ? this.now(key) : null;
    if (!buffer) return;
    const gain = dbToGain(params.volume) * Math.min(ONESHOT_MAX_GAIN, speed / Math.max(params.refSpeed, 1e-3));
    const rate = Math.pow(2, ((Math.random() * 2 - 1) * params.pitchJitter) / 12);
    this.oneShot(buffer, gain, pan, rate, t);
  }

  // One of the slot's files at random, never the one it played last when it
  // has another.
  private pick(slot: string, params: SlotParams): string | null {
    const choices = params.sounds.filter((k) => SOUND_ASSETS[k]);
    if (choices.length === 0) return null;
    const last = this.lastPick.get(slot);
    const pool = choices.length > 1 ? choices.filter((k) => k !== last) : choices;
    const key = pool[Math.floor(Math.random() * pool.length)]!;
    this.lastPick.set(slot, key);
    return key;
  }

  private oneShot(buffer: AudioBuffer, gain: number, pan: number, rate: number, at: number): void {
    const ctx = this.ctx!;
    if (gain <= 1e-4) return;
    if (this.live >= MAX_ONESHOTS) {
      this.counts.dropped++;
      return;
    }
    this.counts.oneShots++;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.bus!);
    this.live++;
    src.onended = () => {
      this.live--;
      p.disconnect();
    };
    src.start(Math.max(ctx.currentTime, at));
  }

  // ---------------------------------------------------------------------------
  // Instruments: `window.__sound`, for a script driving the page headlessly,
  // where nothing can listen.

  // A recording of the output, mono, at the context's rate, from
  // `startCapture` until `takeCapture`: what a replay actually sounded like.
  startCapture(): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.analyser || this.capture) return false;
    // A ScriptProcessorNode rather than a worklet: it is an instrument, not
    // part of the sound, and needs no module of its own.
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    node.onaudioprocess = (e) => chunks.push(e.inputBuffer.getChannelData(0).slice());
    this.analyser.connect(node);
    // A processor only runs while connected onward; through nothing audible.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    this.capture = { node, chunks };
    return true;
  }

  takeCapture(): Float32Array {
    const cap = this.capture;
    if (!cap) return new Float32Array(0);
    cap.node.disconnect();
    this.analyser?.disconnect(cap.node);
    this.capture = null;
    const out = new Float32Array(cap.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of cap.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  // The context's state, what has played, the loops running and which file
  // each is on, and the last ~43 ms at the output as RMS and peak dBFS.
  stats(): {
    state: AudioContextState | "none";
    sampleRate: number;
    counts: AudioOut["counts"];
    live: number;
    loops: Record<string, string>;
    decoded: number;
    rmsDb: number;
    peakDb: number;
  } {
    let rmsDb = -Infinity;
    let peakDb = -Infinity;
    if (this.analyser) {
      const buf = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(buf);
      let s = 0;
      let p = 0;
      for (const v of buf) {
        s += v * v;
        p = Math.max(p, Math.abs(v));
      }
      rmsDb = 10 * Math.log10(s / buf.length);
      peakDb = 20 * Math.log10(p);
    }
    return {
      state: this.ctx?.state ?? "none",
      sampleRate: this.ctx?.sampleRate ?? 0,
      counts: { ...this.counts },
      live: this.live,
      loops: Object.fromEntries([...this.loops].map(([channel, v]) => [channel, v.sound])),
      decoded: this.ready.size,
      rmsDb,
      peakDb,
    };
  }
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
