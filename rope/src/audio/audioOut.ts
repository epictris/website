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
// SILENCE. Once the sim stops stepping - a paused replay, the settings panel,
// the finish linger's end - every loop fades out, so a ball that stops being
// simulated stops being heard. "Stops" is a step OVERDUE, not a frame that ran
// none: on a display faster than 60 Hz most frames run none, and fading on
// each of them pulled every loop's level down between steps, a flutter at the
// frame rate. A fade cancels what the steps had scheduled ahead (up to `LEAD`),
// or the last step's level, scheduled after it, would take the loop back up
// and hold it there.
//
// LOOPS. A loop voice is a `grain-loop` AudioWorkletNode (audio/grainWorklet.ts)
// rather than a looping buffer source, so its PACE (how fast the file's time
// runs) and its PITCH follow the speed apart (docs/sound.md#pace-and-pitch).
// Rolling defaults to native pace/pitch, with speed driving level and tone.
//
// LIVE. The bank and the library are read afresh on every step, so an
// assignment changed in the editor's Sounds menu is heard on the next one: a
// loop whose file is no longer assigned is stopped and its new one started.
//
// CLIPS. A file's clip edit (`SoundBank.clips`, audio/slots.ts) is applied at
// playing, never to the file: a one-shot plays only its window, a loop loops
// within it, and its gain and rate multiply the slot's. A running loop takes a
// changed window, gain and rate on its next step.

import type { Camera } from "../render/camera";
import { cameraListener, setListenerPose, soundPosition, setSpatialPosition, makeSpatialPanner, type SoundPosition, type AudioCamera } from "./spatialAudio";
import type { SoundLevel } from "../render/settings";
import { SOUND_ASSETS } from "./library";
import { SOUND_BANK, clipPlay, resolveSlot, landingMix, type LandingLayer, type ClipPlay, type SlotParams, type SoundFamily } from "./slots";
import type { SoundStep } from "./soundObserver";
import { SURFACE_KINDS, type SurfaceKind } from "./surfaces";
import grainWorkletUrl from "./grainWorklet.ts?worker&url";
import { strikeLevel, loopGainFollow, scheduleShotEnvelope, windLevel } from "./playbackLevel";

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
// Concurrent one-shots, beyond which a new one is dropped: a fast wind can ask
// for a few hundred links a second.
const MAX_ONESHOTS = 48;
// A one-shot is louder the faster it happened, in proportion, up to this many
// times its volume at the reference speed; a loop up to `LOOP_MAX_GAIN`.
const LOOP_MAX_GAIN = 1.5;
// A loop's pitch is held inside two octaves either way, so a speed far off its
// reference does not turn a loop into a squeal or a growl. Extreme independent
// pace changes can still smear transients; rolling defaults to no stretching.
const RATE_MIN = 0.25;
const RATE_MAX = 4;
const PACE_MAX = 16;
// How long after a loop's fade starts its voice stops working (`run` 0), s:
// nine time constants of a step's fade (-78 dB), so it never cuts off audibly.
const REST_AFTER = 9 * FOLLOW;

// Movement loops scale with reference speed. Wind uses its separate speed
// threshold and acceleration swell in windLevel; rolling keeps its soft floor.
function loopLevel(family: SoundFamily, ratio: number): number {
  const fade = family === "roll" ? smoothstep(0, 0.03, ratio) : smoothstep(0.02, 0.1, ratio);
  const level = family === "roll" && ratio < 1 ? Math.pow(ratio, 1.25) : ratio;
  return Math.min(LOOP_MAX_GAIN, level) * fade;
}

interface LoopVoice {
  // What it is playing: the slot it was resolved to, and which of its files.
  slot: string;
  sound: string;
  node: AudioWorkletNode;
  gain: GainNode;
  pan: PannerNode;
  tone: BiquadFilterNode | null;
  rings: BiquadFilterNode[];
  // The file's length, s, and the window last sent to the worklet, samples.
  seconds: number;
  window: { start: number; end: number };
  // Faded out with its `run` param set to drop after nine gain time constants; false
  // while it is heard, and on its first step, which sets its params outright.
  resting: boolean;
  fresh: boolean;
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
  // The game's one-shots still sounding (not the menu's audition), by their
  // gain, so leaving ▶ Test can fade them too.
  private readonly shots = new Set<GainNode>();
  // The audio-clock time the last step was scheduled at, and whether the
  // loops have been faded since (so a pause fades them once, not per frame).
  private lastStepAt = -Infinity;
  private quiet = true;
  // The menu's audition, so a new one stops the last rather than piling on.
  private auditioning: AudioBufferSourceNode | null = null;
  // Instruments, for `window.__sound` (see `stats`).
  private readonly counts = { oneShots: 0, dropped: 0, missing: 0 };
  private analyser: AnalyserNode | null = null;
  // The loop voices' processor, registered once per context; loops wait for it.
  private workletReady = false;
  private impactPreviewEpoch = 0;
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

  // Schedule sources in level space and move the listener with the camera.
  flush(camera: Camera, renderedCamera?: AudioCamera | null): void {
    const ctx = this.ctx;
    if (ctx === null || ctx.state !== "running") {
      this.queue.length = 0;
      return;
    }
    const now = ctx.currentTime;
    setListenerPose(ctx.listener, cameraListener(camera, renderedCamera), now);
    const n = this.queue.length;
    if (n === 0) {
      // The next step is due a step after the last; a frame between the two
      // (most frames, above 60 Hz) is not the sim stopping.
      if (!this.quiet && now > this.lastStepAt + STEP) this.silence();
      return;
    }
    for (let i = 0; i < n; i++) {
      const t = Math.max(now, now + LEAD - (n - 1 - i) * STEP);
      this.playStep(this.queue[i]!, t);
      this.lastStepAt = t;
    }
    this.quiet = false;
    this.queue.length = 0;
  }

  // Fade every loop out: no step is coming (the sim has stopped stepping, or
  // the page has - the editor leaving ▶ Test). With `oneShots`, the one-shots
  // still ringing go too: a test that is over is over, where a pause lets a
  // landing finish.
  silence(oneShots = false): void {
    if (oneShots) this.impactPreviewEpoch++;
    if (!this.ctx) return;
    this.queue.length = 0;
    this.quiet = true;
    const t = this.ctx.currentTime;
    const fade = (param: AudioParam): void => {
      // Everything scheduled from now on goes: the steps schedule up to `LEAD`
      // ahead, and an event after the fade would undo it.
      param.cancelScheduledValues(t);
      param.setTargetAtTime(0, t, 0.05);
    };
    for (const v of this.loops.values()) {
      fade(v.gain.gain);
      // Ten of this fade's time constants, -87 dB. Whether or not it was
      // resting already: a rest the last step set was timed for that step's
      // own fade, which this one replaces.
      v.node.parameters.get("run")!.setValueAtTime(0, t + 0.5);
      v.resting = true;
    }
    if (oneShots) for (const g of this.shots) fade(g.gain);
  }

  // Play one library file now, at `volume` dB, centred, as its clip edit says
  // - the menu's audition. Starts the context if it has to (a preview is a
  // press), and stops the audition before it. Answers what is playing - the
  // window of the file and the rate it is played at - and when it started on
  // `performance.now()`'s clock, for a playhead; null if it cannot play.
  async preview(key: string, volume = 0): Promise<Audition | null> {
    this.unlock();
    const buffer = await this.load(key);
    const ctx = this.ctx;
    if (!buffer || !ctx) return null;
    this.stopPreview();
    const clip = clipPlay(SOUND_BANK, key, buffer.duration);
    const src = this.oneShot(buffer, dbToGain(volume) * clip.gain, null, clip.rate, ctx.currentTime, clip, true);
    if (!src) return null;
    this.auditioning = src;
    src.addEventListener("ended", () => {
      if (this.auditioning === src) this.auditioning = null;
    });
    // `outputLatency` is what the context says lies between scheduling and
    // the speaker; without it the playhead runs ahead of what is heard.
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    return { ...clip, startedAt: performance.now() + latency * 1000 };
  }

  stopPreview(): void {
    try {
      this.auditioning?.stop();
    } catch {
      // Already ended.
    }
    this.auditioning = null;
  }

  // The lab's collision test uses the very same velocity/surface selection
  // and playback path as a real landing. Its extra gain is monitor level only.
  async auditionLanding(surface: SurfaceKind, speed: number, volumeDb = 0): Promise<LandingLayer[]> {
    this.unlock();
    this.silence(true);
    const epoch = this.impactPreviewEpoch;
    const layers = landingMix(SOUND_BANK, surface, speed);
    const buffers = await Promise.all(layers.flatMap(layer => layer.params.sounds.map(key => this.load(key))));
    if (epoch !== this.impactPreviewEpoch) return [];
    if (!layers.length || buffers.some(buffer => !buffer) || !this.ctx) throw new Error("Landing sounds are unavailable. Load the current game library on the dev server.");
    this.play("land", surface, speed, null, this.ctx.currentTime, dbToGain(volumeDb));
    return layers;
  }

  // A library file decoded, for drawing it (the menu's waveform). Starts the
  // context if it has to, which the menu's opening press allows.
  decoded(key: string): Promise<AudioBuffer | null> {
    if (this.ctx === null) this.start();
    return this.load(key);
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
    ctx.audioWorklet.addModule(grainWorkletUrl).then(
      () => {
        this.workletReady = true;
      },
      (err: unknown) => {
        this.counts.missing++;
        console.warn(`[sound] loop player (${grainWorkletUrl}): ${String(err)}`);
      },
    );
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

  private playStep(step: SoundStep, t: number): void {
    for (const surface of SURFACE_KINDS) {
      if (surface === "vine") continue;
      const roll = step.roll.get(surface);
      this.driveLoop(`roll:${surface}`, "roll", surface, roll?.speed ?? 0, roll ?? null, t);
    }
    this.driveLoop("whoosh", "whoosh", null, step.air.speed, step.air, t, step.air.acceleration ?? 0);
    this.driveLoop("deploy", "deploy", null, step.deploy?.speed ?? 0, step.deploy ?? null, t);
    for (const c of step.jingles ?? []) this.play("slack", null, c.speed, c, t);
    this.driveLoop("hook-drag", "hook-drag", step.hookDrag?.surface ?? null, step.hookDrag?.speed ?? 0, step.hookDrag ?? null, t);
    this.driveLoop("chain-drag", "chain-drag", step.drag?.surface ?? null, step.drag?.speed ?? 0, step.drag ?? null, t);
    for (const c of step.chainImpacts ?? []) this.play("chain-hit", c.surface, c.speed, c, t + ((c.at ?? 1) - 1) * STEP);
    this.driveLoop("wade", "wade", null, step.wade.speed * step.wade.interface, step.wade, t);
    if (step.splash) this.play("splash", null, step.splash.speed, step.splash, t);
    for (const s of step.strikes) this.play(s.family, s.surface, s.speed, s, t + (s.at - 1) * STEP);
    for (const c of step.clinks) this.play("wind", null, c.speed, c, t + (c.at - 1) * STEP);
    if (step.taut) this.play("taut", null, step.taut.speed, step.taut, t);
    for (const c of step.creaks ?? []) this.play("creak", null, c.speed, c, t);
    for (const c of step.wraps ?? []) this.play("wrap", c.surface, c.speed, c, t + ((c.at ?? 1) - 1) * STEP);
  }

  // A loop, at `speed` (0 = silent). `pan` null is "not touching": fade out.
  private driveLoop(
    channel: string,
    family: SoundFamily,
    surface: SurfaceKind | null,
    speed: number,
    pan: SoundPosition | null,
    t: number,
    acceleration = 0,
  ): void {
    const resolved = resolveSlot(SOUND_BANK, family, surface);
    let voice = this.loops.get(channel);
    // Unassigned, or assigned something else since it started: stop it.
    if (voice && (!resolved || voice.slot !== resolved.key || !resolved.params.sounds.includes(voice.sound))) {
      this.stopLoop(voice, t);
      this.loops.delete(channel);
      voice = undefined;
    }
    if (!resolved) return;
    const params = resolved.params;
    const active = pan !== null && speed > 0 && (family !== "whoosh" || speed > params.refSpeed * 0.25);
    if (!voice) {
      if (!active || !this.workletReady) return;
      const key = this.pick(resolved.key, params);
      const buffer = key ? this.now(key) : null;
      if (!key || !buffer) return;
      voice = this.startLoop(resolved.key, key, buffer, family, pan!);
      this.loops.set(channel, voice);
    }
    // Read every step, so an edit in the menu is heard on a loop already
    // running: the window is the worklet's to change at any time.
    const clip = clipPlay(SOUND_BANK, voice.sound, voice.seconds);
    const rate = this.ctx!.sampleRate;
    const window = { start: Math.round(clip.start * rate), end: Math.round(clip.end * rate) };
    if (window.start !== voice.window.start || window.end !== voice.window.end) {
      voice.window = window;
      voice.node.port.postMessage({ type: "window", ...window });
    }
    const ratio = speed / Math.max(params.refSpeed, 1e-3);
    const level = family === "whoosh" ? windLevel(speed, acceleration, params.refSpeed) : loopLevel(family, ratio);
    const gain = active ? dbToGain(params.volume) * clip.gain * level : 0;
    const gainFollow = loopGainFollow(family);
    voice.gain.gain.setTargetAtTime(gain, t, gainFollow);
    // Quiet rolling loses some high detail without stretching its transients.
    if (voice.tone && active) {
      const cutoff = 6000 + 8000 * smoothstep(0, 1, ratio);
      if (voice.fresh) voice.tone.frequency.setValueAtTime(cutoff, t);
      else voice.tone.frequency.setTargetAtTime(cutoff, t, 0.08);
    }
    if (!active) {
      this.rest(voice, t + 9 * gainFollow);
      return;
    }
    if (voice.resting) {
      // Back before its rest fell, or after: either way it runs from now.
      const run = voice.node.parameters.get("run")!;
      run.cancelScheduledValues(t);
      run.setValueAtTime(1, t);
      voice.resting = false;
    }
    // The clip's pitch is the file's own, as a faster tape: higher AND
    // quicker, so it scales both, outside the speed's two-octave hold.
    const scaled = Math.max(ratio, 1e-3);
    const pitch = clip.rate * Math.min(RATE_MAX, Math.max(RATE_MIN, Math.pow(scaled, params.pitchFollow)));
    const pace = Math.min(PACE_MAX, clip.rate * Math.pow(scaled, params.paceFollow));
    const fresh = voice.fresh;
    const set = (param: AudioParam, value: number): void => {
      if (fresh) param.setValueAtTime(value, t);
      else param.setTargetAtTime(value, t, FOLLOW);
    };
    set(voice.node.parameters.get("pitch")!, pitch);
    set(voice.node.parameters.get("pace")!, pace);
    setSpatialPosition(voice.pan, soundPosition(pan), t, !fresh);
    voice.fresh = false;
  }

  // A loop voice for `sound`, silent until its first step sets its gain. It
  // starts at a random point in its window, so a roll that stops and starts
  // does not restart the same bar of it every time.
  private startLoop(slot: string, sound: string, buffer: AudioBuffer, family: SoundFamily, initialPosition: SoundPosition): LoopVoice {
    const ctx = this.ctx!;
    const node = new AudioWorkletNode(ctx, "grain-loop", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [buffer.numberOfChannels],
    });
    const clip = clipPlay(SOUND_BANK, sound, buffer.duration);
    const rate = ctx.sampleRate;
    const window = { start: Math.round(clip.start * rate), end: Math.round(clip.end * rate) };
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const at = window.start + Math.random() * (window.end - window.start);
    // Copied into the worklet (a transfer would empty the decoded buffer the
    // next voice on this file reads).
    node.port.postMessage({ type: "init", channels, ...window, at, texture: family === "roll", seed: Math.floor(Math.random() * 0x100000000) });
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = makeSpatialPanner(ctx, initialPosition);
    const tone = family === "roll" ? ctx.createBiquadFilter() : null;
    // Narrow resonances measured in the current cannonball recording. Retain
    // broadband contact detail instead of muffling everything above the bass.
    const rings = family === "roll" && sound.startsWith("roll-cannonball-v20-") ? [[1570, -30], [3217, -18], [3891, -12], [4740, -18]].map(([hz, db]) => {
      const filter = ctx.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = hz!;
      filter.Q.value = 9;
      filter.gain.value = db!;
      return filter;
    }) : [];
    let filtered: AudioNode = node;
    for (const filter of rings) {
      filtered.connect(filter);
      filtered = filter;
    }
    if (tone) {
      tone.type = "lowpass";
      tone.Q.value = Math.SQRT1_2;
      filtered.connect(tone).connect(gain);
    } else filtered.connect(gain);
    gain.connect(pan).connect(this.bus!);
    return { slot, sound, node, gain, pan, tone, rings, seconds: buffer.duration, window, resting: false, fresh: true };
  }

  // A voice that has faded stops working at `at` (see `REST_AFTER`). Once per
  // fade: a step that finds it already resting leaves the time it fell.
  private rest(voice: LoopVoice, at: number): void {
    if (voice.resting) return;
    voice.node.parameters.get("run")!.setValueAtTime(0, at);
    voice.resting = true;
  }

  private stopLoop(voice: LoopVoice, t: number): void {
    voice.gain.gain.setTargetAtTime(0, t, 0.03);
    this.rest(voice, t + 0.3);
    // The node ends itself on "stop"; until then its fade plays out.
    setTimeout(() => {
      voice.node.port.postMessage({ type: "stop" });
      voice.tone?.disconnect();
      for (const filter of voice.rings) filter.disconnect();
      voice.pan.disconnect();
    }, 400);
  }

  // A one-shot for `family` on `surface`, at `speed`.
  private play(family: SoundFamily, surface: SurfaceKind | null, speed: number, pan: SoundPosition | null, t: number, monitorGain = 1): void {
    const own = family === "land" ? null : resolveSlot(SOUND_BANK, family, surface);
    const layers = family === "land" ? landingMix(SOUND_BANK, surface, speed) : own ? [{ ...own, weight: 1 }] : [];
    for (const resolved of layers) {
      const params = resolved.params;
      const key = this.pick(resolved.key, params);
      const buffer = key ? this.now(key) : null;
      if (!buffer) continue;
      const clip = clipPlay(SOUND_BANK, key!, buffer.duration);
      const rate = clip.rate * Math.pow(2, ((Math.random() * 2 - 1) * params.pitchJitter) / 12);
      const gain = monitorGain * resolved.weight * dbToGain(params.volume) * clip.gain *
        strikeLevel(family, speed, params.refSpeed, (clip.end - clip.start) / rate);
      this.oneShot(buffer, gain, pan, rate, t, clip);
    }
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

  // `clip` is the window of the file played, seconds of the file. An
  // audition is played however quiet and however busy the game is.
  private oneShot(
    buffer: AudioBuffer,
    gain: number,
    pan: SoundPosition | null,
    rate: number,
    at: number,
    clip: Pick<ClipPlay, "start" | "end">,
    audition = false,
  ): AudioBufferSourceNode | null {
    const ctx = this.ctx!;
    if (!audition && gain <= 1e-4) return null;
    if (!audition && this.live >= MAX_ONESHOTS) {
      this.counts.dropped++;
      return null;
    }
    this.counts.oneShots++;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    const startAt = Math.max(ctx.currentTime, at);
    scheduleShotEnvelope(g.gain, gain, startAt, (clip.end - clip.start) / rate);
    // Auditions are centred and head-locked; gameplay sources are world-fixed.
    const p = pan ? makeSpatialPanner(ctx, pan) : ctx.createGain();
    src.connect(g).connect(p).connect(this.bus!);
    this.live++;
    if (!audition) this.shots.add(g);
    src.onended = () => {
      this.live--;
      this.shots.delete(g);
      p.disconnect();
    };
    // Offset and duration are in the buffer's own seconds, whatever the rate.
    src.start(startAt, clip.start, clip.end - clip.start);
    return src;
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

// An audition under way: the window of the file (seconds of the file) and the
// rate it plays at, and when it started on `performance.now()`'s clock.
export interface Audition extends ClipPlay {
  startedAt: number;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
