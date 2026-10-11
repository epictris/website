/** Quiet grab feedback, unlocked by a user gesture and never part of the simulation. */
export class StarberryChime {
  private context: AudioContext | null = null;
  private readonly unlock = (): void => {
    if (typeof AudioContext === "undefined") return;
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") void this.context.resume().catch(() => {});
  };
  constructor() {
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }
  play(): void {
    const context = this.context;
    if (!context || context.state !== "running" || document.hidden) return;
    const time = context.currentTime;
    for (const [frequency, volume] of [[880, 0.025], [1320, 0.009]]) {
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = frequency!;
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(volume!, time + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.38);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(time); oscillator.stop(time + 0.4);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  }
  dispose(): void {
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
    void this.context?.close();
  }
}
