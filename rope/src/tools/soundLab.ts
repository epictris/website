// A local audition workspace. No writes to the game's sound bank, no uploads.
export {};
type Candidate = {
  id: string; name: string; buffer: AudioBuffer; peak: number; rms: number;
  source: string; article: HTMLElement;
};
type Feedback = { name: string; favorite: boolean; note: string };
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const context = new AudioContext({ sampleRate: 48000 });
const master = context.createGain();
master.connect(context.destination);
const candidates: Candidate[] = [];
const voices = new Set<AudioBufferSourceNode>();
let a: Candidate | null = null;
let b: Candidate | null = null;
let repeatTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
const storageKey = "rope.soundLab.feedback.v1";
let feedback: Record<string, Feedback> = {};
try { feedback = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { /* unavailable storage */ }
const status = (message: string): void => { $("status").textContent = message; };
const db = (v: number): string => v > 0 ? `${(20 * Math.log10(v)).toFixed(1)} dBFS` : "silence";
const level = (): number => Number($<HTMLInputElement>("level").value);
const strength = (): number => Number($<HTMLSelectElement>("strength").value);
const matching = (): boolean => $<HTMLInputElement>("match").checked;
function persist(): void {
  try { localStorage.setItem(storageKey, JSON.stringify(feedback)); }
  catch { status("Browser storage unavailable. Export feedback before leaving."); }
}

function stop(): void {
  generation++;
  if (repeatTimer) clearTimeout(repeatTimer);
  repeatTimer = null;
  for (const voice of voices) {
    try { voice.stop(); } catch { /* already ended */ }
  }
  voices.clear();
  for (const c of candidates) c.article.classList.remove("playing");
}

function matchGain(c: Candidate): number {
  if (!matching() || c.rms < 1e-8) return 1;
  // Every loaded candidate shares a target. Lower it for the highest crest
  // factor, rather than clipping that candidate or limiting it differently.
  let target = 10 ** (-20 / 20);
  for (const item of candidates) {
    if (item.rms > 1e-8 && item.peak > 0) target = Math.min(target, 0.8 * item.rms / item.peak);
  }
  return target / c.rms;
}

async function play(c: Candidate): Promise<void> {
  stop();
  const token = generation;
  await context.resume();
  if (token !== generation) return;
  const mode = $<HTMLSelectElement>("mode").value;
  c.article.classList.add("playing");
  status(`Playing ${c.name}${mode === "once" ? "" : ` · ${mode}`} · ${matching() ? "matched active RMS" : "original level"}`);
  const launch = (): void => {
    if (token !== generation) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = c.buffer;
    source.loop = mode === "loop";
    // Repetition keeps the sum bounded even for a long tail at 6 hits/sec.
    const overlap = mode === "repeat" ? Math.max(1, Math.ceil(c.buffer.duration * 6)) : 1;
    gain.gain.value = matchGain(c) * strength() / overlap;
    source.connect(gain).connect(master);
    voices.add(source);
    source.onended = () => {
      voices.delete(source);
      source.disconnect(); gain.disconnect();
      if (token === generation && mode === "once") c.article.classList.remove("playing");
    };
    source.start();
    if (mode === "repeat") repeatTimer = setTimeout(launch, 1000 / 6);
  };
  launch();
}

function button(label: string, action: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.textContent = label;
  el.addEventListener("click", action);
  return el;
}

function setAB(which: "a" | "b", c: Candidate): void {
  if (which === "a") a = c; else b = c;
  const target = $<HTMLButtonElement>(`play-${which}`);
  target.disabled = false;
  target.textContent = `Play ${which.toUpperCase()}: ${c.name}`;
}

function waveform(canvas: HTMLCanvasElement, buffer: AudioBuffer): void {
  canvas.width = 1000; canvas.height = 100;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "#65bddb";
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  ctx.beginPath();
  for (let px = 0; px < canvas.width; px++) {
    let lo = 0, hi = 0;
    for (const x of channels) {
      for (let i = Math.floor(px * x.length / canvas.width); i < (px + 1) * x.length / canvas.width && i < x.length; i++) {
        lo = Math.min(lo, x[i]); hi = Math.max(hi, x[i]);
      }
    }
    ctx.moveTo(px, 50 - hi * 48); ctx.lineTo(px, 50 - lo * 48);
  }
  ctx.stroke();
}

async function add(bytes: ArrayBuffer, name: string, source: string): Promise<void> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const id = Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2, "0")).join("");
  if (candidates.some(c => c.id === id)) return;
  const buffer = await context.decodeAudioData(bytes.slice(0));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  let peak = 0;
  for (const x of channels) for (const v of x) peak = Math.max(peak, Math.abs(v));
  let sum = 0, count = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (channels.some(x => Math.abs(x[i]) > Math.max(peak * 0.01, 1e-7))) {
      for (const x of channels) { sum += x[i] ** 2; count++; }
    }
  }
  const article = document.createElement("article");
  const c: Candidate = { id, name, buffer, peak, rms: count ? Math.sqrt(sum / count) : 0, source, article };
  candidates.push(c);
  const saved = feedback[id];
  const note: Feedback = saved && typeof saved.note === "string" ? saved : { name, favorite: false, note: "" };
  feedback[id] = note;
  const title = document.createElement("h2"); title.className = "name"; title.textContent = name;
  const canvas = document.createElement("canvas"); canvas.setAttribute("aria-label", `Waveform of ${name}`);
  waveform(canvas, buffer);
  const metrics = document.createElement("p"); metrics.className = "metrics";
  metrics.textContent = `${buffer.duration.toFixed(3)} s · ${buffer.numberOfChannels} channel(s) · peak ${db(peak)} · active RMS ${db(c.rms)} · SHA ${id.slice(0, 12)}`;
  const controls = document.createElement("div"); controls.className = "bar";
  const favorite = button(note.favorite ? "★ Favorite" : "☆ Favorite", () => {
    note.favorite = !note.favorite;
    favorite.textContent = note.favorite ? "★ Favorite" : "☆ Favorite";
    favorite.setAttribute("aria-pressed", String(note.favorite)); persist();
  });
  favorite.setAttribute("aria-pressed", String(note.favorite));
  const download = button("Download WAV", () => downloadWav(c));
  controls.append(button("Play", () => void play(c).catch(e => status(String(e)))),
    button("Set A", () => setAB("a", c)), button("Set B", () => setAB("b", c)), favorite, download);
  const textarea = document.createElement("textarea");
  textarea.placeholder = "What works? What should change? e.g. keep attack, less metal, shorter tail";
  textarea.setAttribute("aria-label", `Feedback for ${name}`);
  textarea.value = note.note;
  textarea.addEventListener("input", () => { note.note = textarea.value; persist(); });
  article.append(title, canvas, metrics, controls, textarea);
  $("candidates").append(article);
  if (!a) setAB("a", c); else if (!b) setAB("b", c);
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadWav(c: Candidate): void {
  const b = c.buffer, channels = b.numberOfChannels;
  const data = new ArrayBuffer(44 + b.length * channels * 2), view = new DataView(data);
  const str = (offset: number, value: string): void => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, data.byteLength - 8, true); str(8, "WAVE"); str(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, b.sampleRate, true); view.setUint32(28, b.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); str(36, "data"); view.setUint32(40, data.byteLength - 44, true);
  const samples = Array.from({ length: channels }, (_, i) => b.getChannelData(i));
  for (let i = 0; i < b.length; i++) for (let ch = 0; ch < channels; ch++) {
    view.setInt16(44 + (i * channels + ch) * 2, Math.round(Math.max(-1, Math.min(1, samples[ch][i])) * 32767), true);
  }
  // Original decoded level, without audition gain/strength, for game import.
  download(new Blob([data], { type: "audio/wav" }), `${c.name.replace(/\.[^.]+$/, "")}.wav`);
}

async function loadFiles(files: File[]): Promise<void> {
  stop();
  for (const file of files) {
    try { await add(await file.arrayBuffer(), file.name, "Local file"); }
    catch (e) { status(`Could not decode ${file.name}: ${String(e)}`); return; }
  }
  status(`${candidates.length} candidate(s) loaded.`);
}

$("files").addEventListener("change", e => {
  const input = e.target as HTMLInputElement;
  void loadFiles([...input.files ?? []]); input.value = "";
});
$("drop").addEventListener("dragover", e => e.preventDefault());
$("drop").addEventListener("drop", e => { e.preventDefault(); void loadFiles([...(e as DragEvent).dataTransfer?.files ?? []]); });
$("stop").addEventListener("click", stop);
$("play-a").addEventListener("click", () => { if (a) void play(a).catch(e => status(String(e))); });
$("play-b").addEventListener("click", () => { if (b) void play(b).catch(e => status(String(e))); });
for (const id of ["match", "strength", "mode"]) $(id).addEventListener("change", stop);
$("level").addEventListener("input", () => {
  master.gain.setTargetAtTime(10 ** (level() / 20), context.currentTime, 0.01);
  $("level-value").textContent = `${level()} dB`;
});
master.gain.value = 10 ** (level() / 20);
document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
window.addEventListener("pagehide", stop);

$("export").addEventListener("click", () => {
  const report = { version: 1, date: new Date().toISOString(),
    settings: { activeRmsMatch: matching(), outputDb: level(), strength: strength(), mode: $<HTMLSelectElement>("mode").value },
    a: a?.id, b: b?.id,
    candidates: candidates.map(c => ({ sha256: c.id, source: c.source, ...feedback[c.id] })) };
  download(new Blob([JSON.stringify(report, null, 2) + "\n"], { type: "application/json" }), "sound-feedback.json");
});

async function loadRemote(kind: "starter" | "library"): Promise<void> {
  stop();
  try {
    const url = kind === "starter" ? "/tools/audio/out/manifest.json" : "/api/sounds";
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
      throw new Error(kind === "starter" ? "Run bun run audio:render, then use this page on the dev server. You can also add WAVs directly." : "Game library requires the dev server.");
    }
    const data = await response.json();
    const files: { name: string; file: string; source: string }[] = kind === "starter"
      ? data.candidates.map((c: { name: string; file: string; source: string }) => ({ ...c, file: `/tools/audio/out/${c.file}` }))
      : Object.values(data.assets) as { name: string; file: string; source: string }[];
    for (const file of files) {
      const audio = await fetch(file.file);
      if (!audio.ok) throw new Error(`${file.name}: HTTP ${audio.status}`);
      await add(await audio.arrayBuffer(), file.name, file.source);
    }
    status(`${candidates.length} candidate(s) loaded.`);
  } catch (e) { status(String(e)); }
}
$("starter").addEventListener("click", () => void loadRemote("starter"));
$("library").addEventListener("click", () => void loadRemote("library"));
