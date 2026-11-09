// The game's sound (docs/sound.md): one per page, the sparks' shape.
//
// `observe` is called once per sim step from `stepLevel` (and the editor's ▶
// Test loop), beside the sparks, the debris and the reeling chain, and is
// skipped where they are (a replay seeking through frames is not watching
// them); `flush` once per rendered frame, which schedules what the frame's
// steps sounded like. Nothing in here reaches the sim.
//
// LIVE ASSIGNMENT. The editor's Sounds menu writes the bank and the library to
// disk and also broadcasts them on `SOUND_CHANNEL`, so a game open in another
// tab of the same browser switches to the new files on its next step, with no
// reload; the editor's own ▶ Test shares the menu's copy outright.

import type { AudioCamera } from "./spatialAudio";
import type { Camera } from "../render/camera";
import type { BallLevel } from "../level/ballLevel";
import type { ChainRetract } from "../render/chainRetract";
import { AudioOut, type Audition, type SoundVolume } from "./audioOut";
import { replaceSoundAssets, type SoundAsset } from "./library";
import { replaceSoundBank, type SoundBank } from "./slots";
import { SoundObserver } from "./soundObserver";

export const SOUND_CHANNEL = "rope.sounds";

export interface SoundBroadcast {
  bank: SoundBank;
  assets: Record<string, SoundAsset>;
}

export class SoundSystem {
  private readonly observer = new SoundObserver();
  private readonly out: AudioOut;
  private channel: BroadcastChannel | null = null;

  constructor(volume: SoundVolume, opts: { listen?: boolean } = {}) {
    this.out = new AudioOut(volume);
    // Browsers keep audio off until the page is interacted with; the first
    // press anywhere - the difficulty pick, the first throw - turns it on.
    const unlock = (): void => this.out.unlock();
    for (const type of ["pointerdown", "keydown", "touchend"] as const) {
      window.addEventListener(type, unlock, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", () => this.out.setHidden(document.visibilityState === "hidden"));
    if ((opts.listen ?? true) && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(SOUND_CHANNEL);
      this.channel.onmessage = (e: MessageEvent<SoundBroadcast>) => this.apply(e.data);
    }
  }

  // A new bank and library, from the menu: in place, so every reader sees it.
  apply(next: SoundBroadcast): void {
    replaceSoundAssets(next.assets);
    replaceSoundBank(next.bank);
    this.out.bankChanged();
  }

  // `retract` is the released chain reeling in, stepped already this step
  // (render/chainRetract.ts), whose links are heard as the deployed chain's
  // are; null where nothing keeps one.
  observe(level: BallLevel, dt: number, retract: ChainRetract | null = null): void {
    this.out.push(this.observer.observe(level, dt, retract));
  }

  // Sources stay in level space; the listener follows the visible camera.
  flush(camera: Camera, renderedCamera?: AudioCamera | null): void {
    this.out.flush(camera, renderedCamera);
  }

  // Nothing more will be stepped for now (the editor leaving ▶ Test): the
  // loops and whatever one-shots are still ringing fade out.
  silence(): void {
    this.out.silence(true);
  }

  setVolume(volume: SoundVolume): void {
    this.out.setVolume(volume);
  }

  // Play one library file now, as its clip edit says: the menu's audition.
  preview(key: string, volume = 0): Promise<Audition | null> {
    return this.out.preview(key, volume);
  }

  stopPreview(): void {
    this.out.stopPreview();
  }

  // A library file decoded, for the menu's waveform.
  decoded(key: string): Promise<AudioBuffer | null> {
    return this.out.decoded(key);
  }

  // `window.__sound.stats()`: what the output is doing (`AudioOut.stats`).
  stats(): ReturnType<AudioOut["stats"]> {
    return this.out.stats();
  }

  // `window.__sound.startCapture()` / `takeCapture()`: the output itself, as
  // samples (`AudioOut.startCapture`).
  startCapture(): boolean {
    return this.out.startCapture();
  }

  takeCapture(): Float32Array {
    return this.out.takeCapture();
  }
}

// Tell every other page in this browser (the game in another tab) about a new
// bank and library.
export function broadcastSounds(message: SoundBroadcast): void {
  if (typeof BroadcastChannel === "undefined") return;
  const ch = new BroadcastChannel(SOUND_CHANNEL);
  ch.postMessage(message);
  ch.close();
}
