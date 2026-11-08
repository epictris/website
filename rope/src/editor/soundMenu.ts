// The editor's SOUNDS menu (docs/sound.md#the-sounds-menu): which file plays
// for each event in the game.
//
// Two halves. The LIBRARY is every sound uploaded (drop files on the menu, or
// Upload…), each with a preview, what plays it, and its credit - source,
// author and licence, which an upload cannot know and `cli assets` requires.
// The EVENTS are the game's sound events (audio/slots.ts), a row for each
// family's default and one per surface that overrides it; a row takes files
// dropped onto it, dragged from the library or picked from its list, and has
// the event's volume, reference speed and pitch.
//
// A library file's Edit opens its CLIP EDITOR (editor/clipEditor.ts): its
// waveform, cropped by dragging, and its own volume and pitch - how the game
// plays that file wherever it is assigned, kept in the bank's `clips`. The
// file itself is never changed.
//
// Every change is heard at once - in this editor's ▶ Test, which shares the
// menu's copy, and in a game open in another tab, which is told over a
// BroadcastChannel - and saved to `src/audio/soundBank.json` a moment later
// through the dev server (src/server/sounds.ts). The library is saved by the
// server as it changes.

import type { SoundAsset } from "../audio/library";
import { SOUND_ASSETS } from "../audio/library";
import type { Audition } from "../audio/audioOut";
import {
  FAMILIES,
  SOUND_BANK,
  cleanClip,
  clipPlay,
  slotKey,
  slotParams,
  type ClipEdit,
  type FamilySpec,
  type SlotParams,
  type SoundBank,
} from "../audio/slots";
import { SURFACE_LABELS, type SurfaceKind } from "../audio/surfaces";
import { broadcastSounds, type SoundSystem } from "../audio/soundSystem";
import { ClipEditor } from "./clipEditor";

const API = "/api/sounds";
const OPEN_KEY = "rope.editor.soundFamilies";
const SAVE_DELAY_MS = 300;
const DRAG_TYPE = "application/x-rope-sound";
// The narrowest the menu is drawn at: an event row's file, its list and its
// three settings on two lines.
const MENU_MIN_WIDTH = 520;
const ACCEPT ="audio/*,.wav,.ogg,.oga,.opus,.mp3,.flac,.m4a,.aac,.aif,.aiff,.webm";

export class SoundMenu {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private bank: SoundBank = { slots: {} };
  private assets: Record<string, SoundAsset> = {};
  private open = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly openFamilies: Set<string> = readOpen();
  // Where an Upload… press puts what it uploads: a slot, or just the library.
  private uploadTarget: string | null = null;
  // The library file whose clip editor is open, and that editor; rebuilt with
  // the menu, so the audition playing is held here (the decoded file is the
  // sound system's, decoded once).
  private editing: string | null = null;
  private clipEditor: ClipEditor | null = null;
  private audition: { key: string; a: Audition } | null = null;
  // Told when the menu opens or closes, however it was closed (the toolbar
  // button keeps its lit state by it).
  onOpenChange: ((open: boolean) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly system: SoundSystem,
  ) {
    injectStyles();
    this.root = document.createElement("div");
    this.root.className = "snd-menu";
    this.root.hidden = true;
    const head = div("snd-head");
    const title = div("snd-title");
    title.textContent = "SOUNDS";
    const close = button("×", () => this.hide());
    close.title = "Close (Esc)";
    const lab = document.createElement("a");
    lab.href = "./sound-lab.html";
    lab.target = "_blank";
    lab.rel = "noopener";
    lab.textContent = "Compare sounds ↗";
    lab.style.color = "#65bddb";
    head.append(title, lab, close);
    this.status = div("snd-status");
    this.body = div("snd-body");
    this.root.append(head, this.status, this.body);
    parent.appendChild(this.root);

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.multiple = true;
    this.fileInput.accept = ACCEPT;
    this.fileInput.hidden = true;
    this.fileInput.addEventListener("change", () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = "";
      void this.upload(files, this.uploadTarget);
    });
    this.root.appendChild(this.fileInput);

    // Files dropped anywhere on the menu that no row takes go to the library.
    this.root.addEventListener("dragover", (e) => {
      if (hasFiles(e) || e.dataTransfer?.types.includes(DRAG_TYPE)) e.preventDefault();
    });
    this.root.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      void this.upload([...e.dataTransfer!.files], null);
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (!this.open || e.code !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.hide();
    else void this.show();
  }

  async show(): Promise<void> {
    this.open = true;
    this.root.hidden = false;
    this.place();
    this.onOpenChange?.(true);
    this.say("Loading…");
    try {
      const res = await fetch(API);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as { assets: Record<string, SoundAsset>; bank: SoundBank };
      this.assets = data.assets;
      this.bank = data.bank;
      this.system.apply({ assets: this.assets, bank: this.bank });
      this.say("");
    } catch (e) {
      // A server started before the sound service existed has no endpoint.
      this.say(`Could not load the sound library (${String(e)}). Restart the dev server if it predates the Sounds menu.`, true);
      this.assets = { ...SOUND_ASSETS };
      this.bank = { slots: { ...SOUND_BANK.slots } };
    }
    this.render();
  }

  // Beside the toolbar rather than over it, so every button stays in reach -
  // the toolbar's width is its tools', which differ by layer and workspace, so
  // it is measured. A window too narrow for both overlaps the toolbar rather
  // than squeezing the menu under a readable width.
  private place(): void {
    const bar = document.querySelector(".ed-bar")?.getBoundingClientRect();
    const minWidth = Math.min(MENU_MIN_WIDTH, window.innerWidth - 16);
    const left = bar ? Math.min(bar.right + 8, window.innerWidth - 8 - minWidth) : 8;
    this.root.style.left = `${Math.max(8, left)}px`;
  }

  hide(): void {
    this.open = false;
    this.root.hidden = true;
    this.system.stopPreview();
    this.audition = null;
    this.onOpenChange?.(false);
  }

  // ---------------------------------------------------------------------------

  private say(text: string, warn = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("warn", warn);
  }

  // The bank changed: heard now, saved shortly.
  private changed(): void {
    this.system.apply({ assets: this.assets, bank: this.bank });
    broadcastSounds({ assets: this.assets, bank: this.bank });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveBank(), SAVE_DELAY_MS);
    this.render();
  }

  private async saveBank(): Promise<void> {
    this.saveTimer = null;
    try {
      const res = await fetch(`${API}/bank`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.bank),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      this.say("Saved.");
    } catch (e) {
      this.say(`Not saved: ${String(e)}`, true);
    }
  }

  // The library changed on the server: take its copy and tell everyone.
  private libraryChanged(): void {
    this.system.apply({ assets: this.assets, bank: this.bank });
    broadcastSounds({ assets: this.assets, bank: this.bank });
    this.render();
  }

  private async upload(files: File[], slot: string | null): Promise<void> {
    if (!files.length) return;
    let done = 0;
    for (const file of files) {
      this.say(`Uploading ${file.name} (${done + 1} of ${files.length})…`);
      try {
        const res = await fetch(`${API}?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error ?? res.statusText);
        const { key, asset } = out as { key: string; asset: SoundAsset };
        this.assets[key] = asset;
        if (slot) this.assign(slot, key, false);
        done++;
      } catch (e) {
        this.say(`${file.name}: ${String(e)}`, true);
        this.libraryChanged();
        return;
      }
    }
    this.libraryChanged();
    if (slot) this.changed();
    this.say(`Added ${done} sound${done === 1 ? "" : "s"}${slot ? ` to ${slotLabel(slot)}` : ""}. Fill in where each came from below.`);
  }

  // Saved without rebuilding the menu, so a Tab from one credit field to the
  // next keeps its place.
  private async patchCredit(
    key: string,
    field: "source" | "author" | "license",
    input: HTMLInputElement,
  ): Promise<void> {
    try {
      const res = await fetch(`${API}/assets/${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: input.value }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? res.statusText);
      this.assets[key] = out.asset;
      input.classList.toggle("missing", !(out.asset as SoundAsset)[field].trim());
      this.system.apply({ assets: this.assets, bank: this.bank });
      broadcastSounds({ assets: this.assets, bank: this.bank });
      this.say("Saved.");
    } catch (e) {
      this.say(`Not saved: ${String(e)}`, true);
    }
  }

  private async remove(key: string): Promise<void> {
    try {
      const res = await fetch(`${API}/assets/${key}`, { method: "DELETE" });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? res.statusText);
      delete this.assets[key];
      // The server dropped its clip edit with it.
      if (this.bank.clips) delete this.bank.clips[key];
      if (this.editing === key) this.editing = null;
      this.say(`Removed ${key}.`);
      this.libraryChanged();
    } catch (e) {
      this.say(String(e), true);
    }
  }

  private slot(key: string): Partial<SlotParams> {
    return (this.bank.slots[key] ??= {});
  }

  private assign(slot: string, sound: string, notify = true): void {
    const s = this.slot(slot);
    const list = s.sounds ?? [];
    if (!list.includes(sound)) s.sounds = [...list, sound];
    if (notify) this.changed();
  }

  // A clip edit committed: heard at once, in the game too.
  private setClip(key: string, edit: ClipEdit, audition: boolean): void {
    const asset = this.assets[key];
    if (!asset) return;
    let clip: ClipEdit | null;
    try {
      clip = cleanClip(edit, asset.seconds);
    } catch (e) {
      this.say(String(e instanceof Error ? e.message : e), true);
      this.render();
      return;
    }
    const clips = (this.bank.clips ??= {});
    if (clip) clips[key] = clip;
    else delete clips[key];
    if (!Object.keys(clips).length) delete this.bank.clips;
    this.changed();
    if (audition) void this.play(key);
  }

  // Audition a file as the game plays it; `volume` is the event's, when it is
  // played from one.
  private async play(key: string, volume = 0): Promise<void> {
    const a = await this.system.preview(key, volume);
    this.audition = a ? { key, a } : null;
  }

  // The audition playing `key`, until it has played out.
  private auditionOf(key: string): Audition | null {
    const held = this.audition;
    if (!held || held.key !== key) return null;
    const elapsed = ((performance.now() - held.a.startedAt) / 1000) * held.a.rate;
    if (elapsed > held.a.end - held.a.start + 0.05) {
      this.audition = null;
      return null;
    }
    return held.a;
  }

  private unassign(slot: string, sound: string): void {
    const s = this.slot(slot);
    s.sounds = (s.sounds ?? []).filter((k) => k !== sound);
    if (!s.sounds.length) delete s.sounds;
    if (!Object.keys(s).length) delete this.bank.slots[slot];
    this.changed();
  }

  // ---------------------------------------------------------------------------

  private render(): void {
    const scroll = this.body.scrollTop;
    this.clipEditor?.dispose();
    this.clipEditor = null;
    this.body.innerHTML = "";
    this.body.append(this.renderLibrary(), this.renderEvents());
    this.body.scrollTop = scroll;
  }

  private renderLibrary(): HTMLElement {
    const sec = div("snd-sec");
    const head = div("snd-sec-head");
    const h = div("snd-h");
    h.textContent = "Library";
    const up = button("Upload…", () => {
      this.uploadTarget = null;
      this.fileInput.click();
    });
    up.title = "Add sound files (or drop them anywhere on this menu). Any format ffmpeg reads; stored as mono Opus.";
    head.append(h, up);
    sec.appendChild(head);
    const keys = Object.keys(this.assets).sort();
    if (!keys.length) {
      const empty = div("snd-muted");
      empty.textContent = "No sounds yet. Drop files here, or onto an event below to assign them as they upload.";
      sec.appendChild(empty);
      return sec;
    }
    const used = usage(this.bank);
    for (const key of keys) {
      const a = this.assets[key]!;
      const row = div("snd-lib");
      row.draggable = true;
      row.addEventListener("dragstart", (e) => e.dataTransfer?.setData(DRAG_TYPE, key));
      const top = div("snd-lib-top");
      const play = button("▶", () => void this.play(key));
      play.title = "Play, as the game plays it";
      const name = div("snd-lib-name");
      name.textContent = a.name;
      name.title = `${key}\n${(a.bytes / 1024).toFixed(0)} KB`;
      // How long it plays: the file's length, or - lit - what its clip edit
      // plays of it, with the edit in full on hover.
      const clip = this.bank.clips?.[key];
      const len = div(clip ? "snd-muted snd-clip-tag" : "snd-muted");
      const played = clip ? clipPlay(this.bank, key, a.seconds) : null;
      len.textContent = `${(played ? (played.end - played.start) / played.rate : a.seconds).toFixed(2)} s`;
      len.title = clip
        ? `Edited: plays ${clipSummary(clip, a.seconds)} of the ${a.seconds.toFixed(2)} s file (the file itself is unchanged)`
        : "Its length";
      const isEditing = this.editing === key;
      const edit = button(isEditing ? "Done" : "Edit", () => {
        this.editing = isEditing ? null : key;
        this.render();
      });
      edit.classList.toggle("active", isEditing);
      edit.title = "Crop what plays, and set this file's own volume and pitch - the file is not changed";
      const slots = used.get(key) ?? [];
      const where = div(slots.length ? "snd-muted" : "snd-warn");
      where.textContent = slots.length ? slots.map(slotLabel).join(", ") : "not played by anything";
      where.title = slots.length
        ? "The events that play this sound"
        : "Assign it to an event, or remove it - `cli assets` fails on a sound nothing plays";
      const del = button("Remove", () => void this.remove(key));
      del.disabled = slots.length > 0;
      del.title = slots.length ? "Unassign it from every event first" : "Delete this sound from the library";
      top.append(play, name, len, where, edit, del);
      row.appendChild(top);
      if (isEditing) {
        // Not a drag source while it is being edited: a drag on the waveform
        // is a crop, not an assignment.
        row.draggable = false;
        row.classList.add("editing");
        this.clipEditor = new ClipEditor({
          asset: a,
          edit: clip ?? {},
          buffer: this.system.decoded(key),
          onCommit: (next, audition) => this.setClip(key, next, audition),
          onPlay: () => void this.play(key),
          audition: () => this.auditionOf(key),
        });
        row.appendChild(this.clipEditor.el);
      }
      const credit = div("snd-credit");
      for (const field of ["source", "author", "license"] as const) {
        const input = document.createElement("input");
        input.className = "ed-text snd-credit-in";
        input.placeholder = field === "source" ? "source URL" : field === "license" ? "licence (e.g. CC0)" : "author";
        input.value = a[field];
        input.classList.toggle("missing", !a[field].trim());
        input.title = {
          source: "Where it came from - the page you downloaded it from",
          author: "Who made it (CC BY obliges you to credit them)",
          license: "Its licence. It must allow redistribution (CC0, CC BY, CC BY-NC); see docs/asset-store.md",
        }[field];
        input.addEventListener("change", () => void this.patchCredit(key, field, input));
        credit.appendChild(input);
      }
      row.appendChild(credit);
      sec.appendChild(row);
    }
    return sec;
  }

  private renderEvents(): HTMLElement {
    const sec = div("snd-sec");
    const h = div("snd-h");
    h.textContent = "Events";
    sec.appendChild(h);
    const hint = div("snd-muted");
    hint.textContent =
      "A surface with no sounds of its own plays its event's Default. Drop files on a row to upload and assign them, or drag them from the library.";
    sec.appendChild(hint);
    for (const f of FAMILIES) sec.appendChild(this.renderFamily(f));
    return sec;
  }

  private renderFamily(f: FamilySpec): HTMLElement {
    const box = div("snd-fam");
    const head = div("snd-fam-head");
    const isOpen = this.openFamilies.has(f.family);
    const twist = div("snd-twist");
    twist.textContent = isOpen ? "▾" : "▸";
    const label = div("snd-fam-label");
    label.textContent = f.label;
    const summary = div("snd-muted");
    summary.textContent = familySummary(f, this.bank);
    head.append(twist, label, summary);
    head.title = f.help;
    head.addEventListener("click", () => {
      if (isOpen) this.openFamilies.delete(f.family);
      else this.openFamilies.add(f.family);
      writeOpen(this.openFamilies);
      this.render();
    });
    box.appendChild(head);
    if (!isOpen) return box;
    const help = div("snd-muted snd-help");
    help.textContent = f.help;
    box.appendChild(help);
    box.appendChild(this.renderSlot(f, null));
    for (const s of f.surfaces ?? []) box.appendChild(this.renderSlot(f, s));
    return box;
  }

  private renderSlot(f: FamilySpec, surface: SurfaceKind | null): HTMLElement {
    const key = slotKey(f.family, surface);
    const params = slotParams(this.bank, key, f.family);
    const row = div("snd-slot");
    row.addEventListener("dragover", (e) => {
      if (hasFiles(e) || e.dataTransfer?.types.includes(DRAG_TYPE)) {
        e.preventDefault();
        row.classList.add("drop");
      }
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop"));
    row.addEventListener("drop", (e) => {
      row.classList.remove("drop");
      const dragged = e.dataTransfer?.getData(DRAG_TYPE);
      if (dragged) {
        e.preventDefault();
        e.stopPropagation();
        this.assign(key, dragged);
        return;
      }
      if (hasFiles(e)) {
        e.preventDefault();
        e.stopPropagation();
        void this.upload([...e.dataTransfer!.files], key);
      }
    });

    const line = div("snd-slot-line");
    const name = div("snd-slot-name");
    name.textContent = surface === null ? "Default" : SURFACE_LABELS[surface].label;
    name.title = surface === null ? `${f.label} on any surface without sounds of its own` : SURFACE_LABELS[surface].is;
    line.appendChild(name);
    const chips = div("snd-chips");
    for (const sound of params.sounds) {
      const chip = div("snd-chip");
      const a = this.assets[sound];
      const play = document.createElement("span");
      play.className = "snd-chip-name";
      play.textContent = a?.name ?? `${sound} (missing)`;
      play.title = "Play";
      play.addEventListener("click", () => void this.play(sound, params.volume));
      const x = document.createElement("span");
      x.className = "snd-chip-x";
      x.textContent = "×";
      x.title = "Unassign";
      x.addEventListener("click", () => this.unassign(key, sound));
      chip.append(play, x);
      chips.appendChild(chip);
    }
    if (!params.sounds.length) {
      const none = div("snd-muted");
      none.textContent = surface === null ? "silent" : "uses Default";
      chips.appendChild(none);
    }
    line.appendChild(chips);
    const add = document.createElement("select");
    add.className = "ed-select snd-add";
    add.title = "Assign a sound from the library";
    add.appendChild(new Option("+ sound", ""));
    for (const k of Object.keys(this.assets).sort()) {
      if (!params.sounds.includes(k)) add.appendChild(new Option(this.assets[k]!.name, k));
    }
    add.appendChild(new Option("Upload…", "__upload"));
    add.addEventListener("change", () => {
      if (add.value === "__upload") {
        this.uploadTarget = key;
        this.fileInput.click();
      } else if (add.value) this.assign(key, add.value);
      add.value = "";
    });
    line.appendChild(add);
    row.appendChild(line);

    // A surface row's settings apply only once it has sounds of its own: until
    // then it plays the Default, settings and all.
    if (params.sounds.length) {
      const opts = div("snd-opts");
      opts.appendChild(this.num(key, "volume", "volume", params.volume, "dB", -40, 12, 1, "Volume at the reference speed"));
      opts.appendChild(
        this.num(key, "refSpeed", "at", params.refSpeed, "m/s", 0.1, 40, 0.1, `The ${f.speedIs} this sound is right at: ${f.loop ? "played at its own pitch and pace and at the volume set" : "played at the volume set; quieter slower, louder faster"}`),
      );
      if (f.loop) {
        opts.appendChild(this.num(key, "pitchFollow", "pitch follows", params.pitchFollow, "", 0, 1, 0.05, "How far the pitch follows the speed: 0 never changes, 1 is an octave up at twice the reference speed"));
        opts.appendChild(this.num(key, "paceFollow", "pace follows", params.paceFollow, "", 0, 1, 0.05, "How far the recording's pace follows the speed, apart from its pitch: 0 never changes, 1 plays its texture twice as quick at twice the reference speed. Equal to pitch follows is a tape played faster"));
      } else {
        opts.appendChild(this.num(key, "pitchJitter", "pitch ±", params.pitchJitter, "st", 0, 12, 0.5, "Each play is detuned at random by up to this many semitones (st) either way, so a repeated sound does not sound like one recording"));
      }
      row.appendChild(opts);
    }
    return row;
  }

  private num(
    key: string,
    field: "volume" | "refSpeed" | "pitchJitter" | "pitchFollow" | "paceFollow",
    label: string,
    value: number,
    unit: string,
    min: number,
    max: number,
    step: number,
    help: string,
  ): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "snd-num";
    wrap.title = help;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "ed-num";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(Math.round(value * 100) / 100);
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      this.slot(key)[field] = Math.min(max, Math.max(min, v));
      this.changed();
    });
    const name = document.createElement("span");
    name.textContent = label;
    wrap.append(name, input);
    if (unit) {
      const u = document.createElement("span");
      u.textContent = unit;
      wrap.appendChild(u);
    }
    return wrap;
  }
}

function usage(bank: SoundBank): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [slot, s] of Object.entries(bank.slots)) {
    for (const k of s.sounds ?? []) out.set(k, [...(out.get(k) ?? []), slot]);
  }
  return out;
}

function familySummary(f: FamilySpec, bank: SoundBank): string {
  const keys = [slotKey(f.family), ...(f.surfaces ?? []).map((s) => slotKey(f.family, s))];
  const set = keys.filter((k) => (bank.slots[k]?.sounds ?? []).length > 0);
  if (!set.length) return "silent";
  const hasDefault = set.includes(slotKey(f.family));
  const overrides = set.length - (hasDefault ? 1 : 0);
  return [hasDefault ? "default set" : "no default", overrides ? `${overrides} surface${overrides === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(", ");
}

// "0.120-0.480 s, -3 dB, +2 st": what a clip edit changes, in short.
function clipSummary(c: ClipEdit, seconds: number): string {
  const parts: string[] = [];
  if (c.start !== undefined || c.end !== undefined) {
    parts.push(`${(c.start ?? 0).toFixed(2)}-${(c.end ?? seconds).toFixed(2)} s`);
  }
  if (c.volume) parts.push(`${c.volume > 0 ? "+" : ""}${c.volume} dB`);
  if (c.pitch) parts.push(`${c.pitch > 0 ? "+" : ""}${c.pitch} st`);
  return parts.join(", ");
}

function slotLabel(key: string): string {
  const [family, surface] = key.split(".") as [string, SurfaceKind | undefined];
  const f = FAMILIES.find((x) => x.family === family);
  const name = f?.label ?? family;
  return surface ? `${name} / ${SURFACE_LABELS[surface]?.label ?? surface}` : name;
}

function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes("Files") ?? false;
}

function div(cls: string): HTMLElement {
  const e = document.createElement("div");
  e.className = cls;
  return e;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "ed-btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function readOpen(): Set<string> {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function writeOpen(open: Set<string>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // Storage refused: the state still holds for this page.
  }
}

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement("style");
  css.textContent = `
  /* From the toolbar's right edge (\`place\`) to the window's, over the
     inspector, so the toolbar - and the button that opened it - stays in
     reach. Opaque: a level drawn through a panel of text is the text made
     harder to read. */
  .snd-menu { position: absolute; top: 8px; right: 8px; left: 8px;
    max-height: calc(100vh - 16px); display: flex;
    flex-direction: column; background: #1f2430; border: 1px solid #313244;
    border-radius: 2px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); pointer-events: auto; z-index: 20; }
  .snd-menu[hidden] { display: none; }
  .snd-head { display: flex; justify-content: space-between; align-items: center;
    padding: 8px 8px 4px 12px; }
  .snd-title { color: #65bddb; letter-spacing: 0.22em; }
  .snd-status { padding: 0 12px 4px; min-height: 1.3em; color: #9aa0ac; }
  .snd-status.warn, .snd-warn { color: #e0af68; }
  .snd-body { overflow-y: auto; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 14px; }
  .snd-sec { display: flex; flex-direction: column; gap: 6px; }
  .snd-sec-head { display: flex; justify-content: space-between; align-items: center; }
  .snd-h { color: #65bddb; border-bottom: 1px solid #313244; padding-bottom: 2px; flex: 1; }
  .snd-sec-head .snd-h { border-bottom: none; }
  .snd-muted { color: #6c7280; }
  .snd-lib { border: 1px solid #313244; padding: 4px 6px; display: flex; flex-direction: column;
    gap: 4px; cursor: grab; }
  .snd-lib-top { display: flex; gap: 8px; align-items: center; }
  .snd-lib-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  .snd-lib-top > .snd-muted, .snd-lib-top > .snd-warn { flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .snd-lib.editing { cursor: default; border-color: #3c445c; }
  .snd-lib-top > .snd-clip-tag { color: #65bddb; }
  .snd-clip { display: flex; flex-direction: column; gap: 2px; padding: 2px 0 4px; }
  .snd-wave { border: 1px solid #313244; }
  /* The page lays its own two canvases over the window (editor.html); this
     one sits in the row. */
  .snd-wave-canvas { position: static; display: block; width: 100%; height: 72px; touch-action: none; }
  .snd-wave-axis { display: flex; justify-content: space-between; }
  .snd-clip-line { display: flex; gap: 4px 16px; align-items: center; flex-wrap: wrap; }
  .snd-clip-line .snd-num .ed-num.time { width: 9ch; }
  .snd-clip-status { margin-left: auto; white-space: nowrap; }
  .snd-credit { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 4px; }
  .snd-credit-in { min-width: 0; }
  .snd-credit-in.missing { border-color: #e0af68; }
  .snd-fam { border-top: 1px solid #313244; }
  .snd-fam-head { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; cursor: pointer;
    user-select: none; }
  .snd-fam-head:hover .snd-fam-label { color: #65bddb; }
  .snd-twist { width: 1ch; color: #9aa0ac; }
  .snd-fam-label { min-width: 12ch; }
  .snd-help { padding: 0 0 4px 3ch; }
  .snd-slot { padding: 3px 0 3px 3ch; border: 1px dashed transparent; }
  .snd-slot.drop { border-color: #65bddb; background: rgba(101,189,219,0.08); }
  .snd-slot-line { display: flex; gap: 8px; align-items: center; }
  .snd-slot-name { width: 9ch; flex: none; color: #9aa0ac; }
  .snd-chips { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; min-width: 0; }
  .snd-chip { display: inline-flex; gap: 6px; align-items: center; border: 1px solid #3c445c;
    background: #2a2f3d; padding: 1px 6px; max-width: 100%; }
  .snd-chip-name { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .snd-chip-name:hover { color: #65bddb; }
  .snd-chip-x { cursor: pointer; color: #9aa0ac; }
  .snd-chip-x:hover { color: #e0af68; }
  .snd-add { flex: none; max-width: 16ch; }
  .snd-opts { display: flex; gap: 4px 16px; padding: 4px 0 0 calc(9ch + 8px); flex-wrap: wrap; }
  .snd-num { display: inline-flex; gap: 4px; align-items: center; color: #9aa0ac; }
  .snd-num .ed-num { width: 6ch; }
  `;
  document.head.appendChild(css);
}
