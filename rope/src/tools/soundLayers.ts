import { FAMILIES, allSlotKeys, type SoundBank } from '../audio/slots';
import type { SoundAsset } from '../audio/library';
import { broadcastSounds } from '../audio/soundSystem';
import { clipSeconds, defaultEffects, validateProject, type LayerCatalog, type LayerProject, type SoundLayer, type LayerClip, type LayerEffects } from '../audio/layerProject';
import { LayerRenderer, SOURCE_URL, wavBytes } from './layerRender';
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const renderer = new LayerRenderer();
const audio = new AudioContext({ sampleRate: 48000 });
const monitor = audio.createGain();
monitor.gain.value = 10 ** (-12 / 20);
monitor.connect(audio.destination);
let catalog: LayerCatalog = { version: 1, sources: [], projects: [] };
let bank: SoundBank = { slots: {} };
let assets: Record<string, SoundAsset> = {};
const openEffectSections = new Set(['Mix', 'Tone & envelope']);
let project: LayerProject;
let layerId = '';
let clipId = '';
let undo: LayerProject[] = [];
let redo: LayerProject[] = [];
let revision = 0;
let playhead = 0;
let voice: AudioBufferSourceNode | null = null;
let previewEpoch = 0;
let playStarted = 0;
let playOffset = 0;
let busy = false;
const uid = (): string => crypto.randomUUID();
const clone = <T>(x: T): T => structuredClone(x);
const message = (text: string): void => { $('status').textContent = text; };
async function api<T>(url: string, options?: RequestInit): Promise<T> { const res = await fetch(url, options); const body = await res.json(); if (!res.ok)
    throw Error(body.error ?? `${res.status}`); return body as T; }
const put = (url: string, body: unknown): Promise<unknown> => api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const layer = (): SoundLayer | undefined => project?.layers.find(l => l.id === layerId);
const clip = (): LayerClip | undefined => layer()?.clips.find(c => c.id === clipId);
function persist(): void { revision++; try {
    localStorage.setItem('rope.layers.' + project.id, JSON.stringify(project));
}
catch {
    message('Browser draft storage is full. Use Save draft to keep your edits.');
} }
function edit(action: () => void, redraw = true): void { stop(); const before = clone(project); action(); if (JSON.stringify(before) !== JSON.stringify(project)) {
    undo.push(before);
    if (undo.length > 60)
        undo.shift();
    redo = [];
    persist();
} if (redraw)
    draw();
else
    updateHistory(); }
function updateHistory(): void { $<HTMLButtonElement>('undo').disabled = !undo.length; $<HTMLButtonElement>('redo').disabled = !redo.length; }
function download(data: Blob, name: string): void { const url = URL.createObjectURL(data); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function stop(): void { previewEpoch++; try {
    voice?.stop();
}
catch { /* already ended */ } voice = null; updateHead(); }
async function operation(action: () => Promise<void>): Promise<void> { if (busy)
    return; busy = true; $<HTMLFieldSetElement>('workspace').disabled = true; try {
    await action();
}
catch (e) {
    message(e instanceof Error ? e.message : String(e));
}
finally {
    busy = false;
    $<HTMLFieldSetElement>('workspace').disabled = false;
    updateHistory();
    drawSources();
} }
function selectedSlot(): string { return $<HTMLSelectElement>('events').value; }
function title(slot: string): string { const [family, surface] = slot.split('.'); return (FAMILIES.find(f => f.family === family)?.label ?? family) + (surface ? ' / ' + surface : ''); }
function drawEvents(): void { const select = $<HTMLSelectElement>('events'); const chosen = select.value; const keys = allSlotKeys().filter(k => $<HTMLInputElement>('all-surfaces').checked || !k.includes('.') || bank.slots[k]?.sounds?.length || catalog.projects.some(p => p.slot === k)); select.replaceChildren(...keys.map(k => new Option(title(k) + (bank.slots[k]?.sounds?.length ? '' : ' · unassigned'), k))); if (keys.includes(chosen))
    select.value = chosen;
else
    select.value = 'land-heavy'; }
function drawVariants(chosen?: string): void { const options = catalog.projects.filter(p => p.slot === selectedSlot()); const select = $<HTMLSelectElement>('variants'); select.replaceChildren(...options.map(p => new Option(p.name + (bank.slots[p.slot]?.sounds?.includes(p.assetKey ?? '') ? ' · in game' : ''), p.id))); if (chosen)
    select.value = chosen; }
function load(id: string): void { stop(); const saved = catalog.projects.find(p => p.id === id); if (!saved)
    return; project = clone(saved); try {
    const draft = localStorage.getItem('rope.layers.' + id);
    if (draft) {
        const parsed = JSON.parse(draft);
        validateProject(parsed, catalog.sources);
        project = parsed;
    }
}
catch { /* use disk */ } layerId = project.layers[0]?.id ?? ''; clipId = project.layers[0]?.clips[0]?.id ?? ''; undo = []; redo = []; playhead = 0; revision++; $('meter').textContent = ''; draw(); message(`Editing ${project.name}. Draft changes stay separate from the game.`); }
function blank(): void { const p: LayerProject = { id: 'project-' + uid(), name: title(selectedSlot()) + ' custom', slot: selectedSlot(), assetKey: null, seconds: 1, loop: FAMILIES.find(f => f.family === selectedSlot().split('.')[0])?.loop ?? false, gainDb: 0, fadeOut: .015, layers: [] }; catalog.projects.push(p); drawVariants(p.id); load(p.id); }
function chooseEvent(): void { const options = catalog.projects.filter(p => p.slot === selectedSlot()); drawVariants(); const active = options.find(p => bank.slots[p.slot]?.sounds?.includes(p.assetKey ?? '')); if (options.length)
    load((active ?? options[0]).id);
else
    blank(); }
function button(text: string, action: () => void, pressed?: boolean): HTMLButtonElement { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = action; if (pressed !== undefined)
    b.setAttribute('aria-pressed', String(pressed)); return b; }
function drawSources(): void {
    const sources = $<HTMLSelectElement>('sources');
    const selected = sources.value;
    const query = $<HTMLInputElement>('source-search').value.trim().toLowerCase();
    const matches = catalog.sources.filter(source => source.name.toLowerCase().includes(query));
    sources.replaceChildren(...matches.map(source => {
        const option = new Option(source.name, source.id);
        option.title = source.name;
        return option;
    }));
    if (matches.some(source => source.id === selected)) sources.value = selected;
    else if (matches.length) sources.selectedIndex = 0;
    $('source-count').textContent = matches.length ? `${matches.length} recording${matches.length === 1 ? '' : 's'}` : 'No recordings match. Try another name.';
    $<HTMLButtonElement>('add').disabled = busy || !matches.length;
}
function draw(): void {
    if (!project)
        return;
    $<HTMLInputElement>('project-name').value = project.name;
    $<HTMLInputElement>('duration').value = String(project.seconds);
    $<HTMLInputElement>('mix-gain').value = String(project.gainDb);
    $<HTMLInputElement>('loop').checked = project.loop;
    drawSources();
    $('arrangement-count').textContent = `${project.layers.length} layer${project.layers.length === 1 ? '' : 's'} · ${project.seconds.toFixed(3)} s`;
    const ruler = $('ruler');
    ruler.replaceChildren();
    for (let i = 0; i <= 10; i++) {
        const tick = document.createElement('span');
        tick.className = 'tick';
        tick.style.left = i * 10 + '%';
        tick.textContent = (i * project.seconds / 10).toFixed(2);
        ruler.append(tick);
    }
    const tracks = $('tracks');
    tracks.replaceChildren();
    if (!project.layers.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Choose a source above and add your first layer.';
        tracks.append(empty);
    }
    for (const l of project.layers) {
        const track = document.createElement('div');
        track.className = 'track' + (l.id === layerId ? ' selected' : '') + (l.mute ? ' muted' : '');
        track.dataset.layerId = l.id;
        const head = document.createElement('div');
        head.className = 'track-head';
        const name = button(l.name, () => { layerId = l.id; clipId = l.clips[0]?.id ?? ''; draw(); });
        name.setAttribute('aria-pressed', String(l.id === layerId));
        head.append(name);
        const mute = button('M', () => edit(() => { l.mute = !l.mute; }), l.mute);
        mute.setAttribute('aria-label', 'Mute ' + l.name);
        mute.title = 'Mute layer';
        const solo = button('S', () => edit(() => { l.solo = !l.solo; }), l.solo);
        solo.setAttribute('aria-label', 'Solo ' + l.name);
        solo.title = 'Solo layer';
        head.append(mute, solo);
        const move = button('Move layer', () => { });
        move.className = 'layer-move';
        move.setAttribute('aria-label', 'Move all clips in ' + l.name);
        move.onpointerdown = e => drag(e, l, null, 'layer');
        head.append(move);
        const summary = document.createElement('span');
        summary.className = 'hint';
        summary.textContent = `${l.mute ? 'Muted · ' : l.solo ? 'Solo · ' : ''}${l.clips.length} clip${l.clips.length === 1 ? '' : 's'} · ${l.effects.gainDb.toFixed(1)} dB`;
        head.append(summary);
        track.append(head);
        const lane = document.createElement('div');
        lane.className = 'lane';
        lane.dataset.layerId = l.id;
        for (const c of l.clips) {
            const item = document.createElement('div');
            item.className = 'clip' + (l.id === layerId && c.id === clipId ? ' selected' : '');
            item.dataset.clipId = c.id;
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            item.setAttribute('aria-pressed', String(l.id === layerId && c.id === clipId));
            item.setAttribute('aria-label', `${l.name}, ${c.at.toFixed(3)} seconds, ${(c.end - c.start).toFixed(3)} second source window`);
            item.style.left = c.at / project.seconds * 100 + '%';
            item.style.width = clipSeconds(c, l) / project.seconds * 100 + '%';
            item.title = `${l.name} · source ${c.start.toFixed(3)}–${c.end.toFixed(3)}s · at ${c.at.toFixed(3)}s`;
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 80;
            item.append(canvas);
            void renderer.source(l.sourceId).then(buffer => wave(canvas, buffer, c.start, c.end)).catch(() => { item.title += ' · source unavailable'; });
            for (const side of ['left', 'right'] as const) {
                const handle = document.createElement('span');
                handle.className = 'handle ' + side;
                handle.onpointerdown = e => { e.stopPropagation(); drag(e, l, c, side); };
                item.append(handle);
            }
            item.onpointerdown = e => { if (!(e.target as HTMLElement).classList.contains('handle'))
                drag(e, l, c, 'move'); };
            item.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                layerId = l.id;
                clipId = c.id;
                draw();
                document.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(c.id)}"]`)?.focus({ preventScroll: true });
            }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                layerId = l.id;
                clipId = c.id;
                edit(() => { c.at = Math.max(0, c.at + (e.shiftKey ? 0.1 : 0.01) * (e.key === 'ArrowLeft' ? -1 : 1)); });
                document.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(c.id)}"]`)?.focus({ preventScroll: true });
            }
            else if (e.key === 'Delete') {
                e.preventDefault();
                e.stopPropagation();
                edit(() => { l.clips = l.clips.filter(x => x !== c); });
            } };
            lane.append(item);
        }
        track.append(lane);
        tracks.append(track);
    }
    inspector();
    updateHead();
    updateHistory();
}
function wave(canvas: HTMLCanvasElement, buffer: AudioBuffer, start = 0, end = buffer.duration): void { const ctx = canvas.getContext('2d')!; const x = buffer.getChannelData(0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.strokeStyle = '#a2c8d5'; ctx.beginPath(); const a = Math.max(0, Math.floor(start * buffer.sampleRate)); const b = Math.min(x.length, Math.ceil(end * buffer.sampleRate)); let peak = 0; for (let i = a; i < b; i++)
    peak = Math.max(peak, Math.abs(x[i])); peak = Math.max(peak, .00001); for (let px = 0; px < canvas.width; px++) {
    const from = a + Math.floor((b - a) * px / canvas.width);
    const to = a + Math.floor((b - a) * (px + 1) / canvas.width);
    let lo = 0, hi = 0;
    const step = Math.max(1, Math.floor((to - from) / 160));
    for (let i = from; i <= Math.min(to, b - 1); i += step) {
        lo = Math.min(lo, x[i]);
        hi = Math.max(hi, x[i]);
    }
    ctx.moveTo(px, canvas.height * (.5 + lo / peak * .45));
    ctx.lineTo(px, canvas.height * (.5 + hi / peak * .45));
} ctx.stroke(); }
function drag(event: PointerEvent, l: SoundLayer, c: LayerClip | null, mode: 'layer' | 'move' | 'left' | 'right'): void {
    if (event.button !== 0)
        return;
    event.preventDefault();
    stop();
    const previous = clone(project);
    const before = l.clips.map(c => ({ ...c }));
    const startX = event.clientX;
    const width = $('ruler').getBoundingClientRect().width;
    const rate = 2 ** ((l.effects.pitch + (c?.pitch ?? 0)) / 12);
    const source = catalog.sources.find(s => s.id === l.sourceId)!;
    let moved = false;
    layerId = l.id;
    clipId = c?.id ?? l.clips[0]?.id ?? '';
    const move = (e: PointerEvent) => {
        const delta = (e.clientX - startX) / width * project.seconds;
        if (Math.abs(e.clientX - startX) > 1)
            moved = true;
        if (mode === 'layer') {
            const shift = Math.max(-Math.min(...before.map(c => c.at)), delta);
            l.clips.forEach((c, i) => c.at = Math.max(0, Math.min(60, before[i].at + shift)));
        }
        else if (c) {
            const initial = before.find(x => x.id === c.id)!;
            if (mode === 'move')
                c.at = Math.max(0, Math.min(project.seconds - .001, initial.at + delta));
            if (mode === 'left') {
                const d = Math.max(-initial.start / rate, -initial.at, Math.min((initial.end - initial.start - .001) / rate, delta));
                c.start = initial.start + d * rate;
                c.at = initial.at + d;
            }
            if (mode === 'right')
                c.end = Math.max(initial.start + .001, Math.min(source.seconds, initial.end + delta * rate));
        }
        // Repaint timeline positions during drag without replacing the pointer target.
        for (const node of document.querySelectorAll<HTMLElement>('.lane')) {
            if (node.dataset.layerId !== l.id)
                continue;
            for (const item of node.querySelectorAll<HTMLElement>('.clip')) {
                const clip = l.clips.find(x => x.id === item.dataset.clipId)!;
                item.style.left = clip.at / project.seconds * 100 + '%';
                item.style.width = clipSeconds(clip, l) / project.seconds * 100 + '%';
            }
        }
    };
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); if (moved) {
        undo.push(previous);
        redo = [];
        persist();
    } draw(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
}
function inspector(): void {
    const root = $('inspector');
    root.replaceChildren();
    const l = layer();
    if (!l) {
        root.textContent = 'Select a layer, or add a recording.';
        return;
    }
    const name = document.createElement('input');
    name.value = l.name;
    name.setAttribute('aria-label', 'Layer name');
    name.onchange = () => edit(() => l.name = name.value);
    root.append(name);
    const source = catalog.sources.find(s => s.id === l.sourceId)!;
    const info = document.createElement('p');
    info.className = 'source-info hint';
    info.textContent = `${source.name} · ${source.seconds.toFixed(2)} s`;
    root.append(info);
    const link = document.createElement('a');
    link.href = SOURCE_URL(source.id);
    link.download = source.name;
    link.textContent = 'Download original recording';
    root.append(link);
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 100;
    canvas.className = 'source-wave';
    canvas.setAttribute('aria-label', 'Selected source window waveform');
    root.append(canvas);
    const selected = clip();
    void renderer.source(l.sourceId).then(buffer => wave(canvas, buffer, selected?.start ?? 0, selected?.end ?? Math.min(1, buffer.duration))).catch(e => message(String(e)));
    const sourcePicker = document.createElement('select');
    sourcePicker.className = 'source-select';
    sourcePicker.setAttribute('aria-label', 'Layer source recording');
    sourcePicker.replaceChildren(...catalog.sources.map(s => new Option(s.name, s.id)));
    sourcePicker.value = l.sourceId;
    sourcePicker.onchange = () => edit(() => { const s = catalog.sources.find(s => s.id === sourcePicker.value)!; l.sourceId = s.id; for (const c of l.clips) {
        c.start = Math.min(c.start, Math.max(0, s.seconds - .01));
        c.end = Math.min(s.seconds, Math.max(c.start + .001, c.end));
    } });
    root.append(sourcePicker);
    const actions = document.createElement('div');
    actions.className = 'bar';
    actions.append(button('Duplicate layer', () => edit(() => { const copy = clone(l); copy.id = uid(); copy.name += ' copy'; copy.clips.forEach(c => c.id = uid()); project.layers.push(copy); layerId = copy.id; clipId = copy.clips[0]?.id ?? ''; })), button('Delete layer', () => edit(() => { project.layers = project.layers.filter(x => x !== l); layerId = project.layers[0]?.id ?? ''; clipId = layer()?.clips[0]?.id ?? ''; })));
    root.append(actions);
    const effectGroups = new Map<string, HTMLElement>();
    for (const title of ['Mix', 'Tone & envelope', 'Effects']) {
        const section = document.createElement('details');
        section.className = 'effect-section';
        section.open = openEffectSections.has(title);
        section.addEventListener('toggle', () => {
            if (!section.isConnected) return;
            if (section.open) openEffectSections.add(title);
            else openEffectSections.delete(title);
        });
        const summary = document.createElement('summary');
        summary.textContent = title;
        const controls = document.createElement('div');
        controls.className = 'controls';
        effectGroups.set(title, controls);
        section.append(summary, controls);
        root.append(section);
    }
    const number = (parent: HTMLElement, label: string, value: number, min: number, max: number, step: number, action: (v: number) => void, slider = false) => { const el = document.createElement('label'); el.textContent = label; const input = document.createElement('input'); input.type = 'number'; input.setAttribute('aria-label', label); input.value = String(Number(value.toFixed(5))); input.min = String(min); input.max = String(max); input.step = String(step); input.onchange = () => { const n = Number(input.value); if (!Number.isFinite(n) || n < min || n > max) {
        input.value = String(value);
        message(`${label}: use ${min}–${max}.`);
        return;
    } edit(() => action(n)); }; el.append(input);
        if (slider) {
            const range = document.createElement('input');
            range.type = 'range';
            range.min = String(min); range.max = String(max); range.step = String(step); range.value = String(value);
            range.setAttribute('aria-label', label + ' slider');
            range.oninput = () => { input.value = range.value; };
            range.onchange = () => {
                const focused = document.activeElement === range;
                edit(() => action(Number(range.value)));
                if (focused) document.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(label + ' slider')}"]`)?.focus({ preventScroll: true });
            };
            el.append(range);
        }
        parent.append(el);
    };
    for (const [key, label, min, max, step] of [
        ['gainDb', 'Gain (dB)', -60, 24, .5], ['pitch', 'Pitch (semitones)', -24, 24, .1], ['pan', 'Pan (−1 left / 1 right)', -1, 1, .05],
        ['highpass', 'High-pass (Hz; 0 off)', 0, 18000, 10], ['lowpass', 'Low-pass (Hz)', 20, 22000, 100], ['bass', 'Bass shelf (dB)', -24, 24, .5], ['treble', 'Treble shelf (dB)', -24, 24, .5],
        ['fadeIn', 'Fade in (s)', 0, 5, .001], ['fadeOut', 'Fade out (s)', 0, 5, .001], ['decay', 'Damping (s; 0 off)', 0, 10, .01],
        ['drive', 'Saturation (0–1)', 0, 1, .05], ['compression', 'Compression (0–1)', 0, 1, .05], ['delay', 'Delay time (s)', .01, 2, .01], ['delayMix', 'Delay amount (0–1)', 0, 1, .05], ['reverb', 'Reverb amount (0–1)', 0, 1, .05],
    ] as const) {
        const group = ['gainDb', 'pitch', 'pan'].includes(key) ? 'Mix'
            : ['highpass', 'lowpass', 'bass', 'treble', 'fadeIn', 'fadeOut', 'decay'].includes(key) ? 'Tone & envelope' : 'Effects';
        number(effectGroups.get(group)!, label, l.effects[key], min, max, step, v => { l.effects[key] = v; }, ['gainDb', 'pitch', 'pan', 'bass', 'treble', 'drive', 'compression', 'delayMix', 'reverb'].includes(key));
    }
    const norm = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = l.effects.normalize;
    checkbox.onchange = () => edit(() => l.effects.normalize = checkbox.checked);
    norm.append(checkbox, 'Normalize source clip before gain');
    norm.className = 'full';
    effectGroups.get('Mix')!.append(norm);
    const clipBox = document.createElement('div');
    clipBox.className = 'clip-details';
    const h = document.createElement('h3');
    h.textContent = 'Selected clip';
    clipBox.append(h);
    root.append(clipBox);
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Select clip');
    select.replaceChildren(...l.clips.map((c, i) => new Option(`${i + 1}: at ${c.at.toFixed(3)} s`, c.id)));
    select.value = clipId;
    select.onchange = () => { clipId = select.value; draw(); };
    clipBox.append(select);
    const grid = document.createElement('div');
    grid.className = 'controls';
    clipBox.append(grid);
    if (selected) {
        number(grid, 'Start in source (s)', selected.start, 0, selected.end - .001, .001, v => selected.start = v);
        number(grid, 'End in source (s)', selected.end, selected.start + .001, source.seconds, .001, v => selected.end = v);
        number(grid, 'Timeline position (s)', selected.at, 0, 60, .001, v => selected.at = v);
        number(grid, 'Clip gain ×', selected.gain, 0, 4, .05, v => selected.gain = v);
        number(grid, 'Clip pitch (semitones)', selected.pitch, -24, 24, .1, v => selected.pitch = v);
        const actions = document.createElement('div');
        actions.className = 'bar';
        actions.append(button('Split at playhead', () => { const duration = clipSeconds(selected, l); if (playhead <= selected.at + .001 || playhead >= selected.at + duration - .001) {
            message('Place the playhead inside the selected clip to split it.');
            return;
        } edit(() => { const sourceCut = selected.start + (playhead - selected.at) * 2 ** ((l.effects.pitch + selected.pitch) / 12); const second = { ...selected, id: uid(), start: sourceCut, at: playhead }; selected.end = sourceCut; l.clips.push(second); clipId = second.id; }); }), button('Duplicate clip', () => edit(() => { const copy = { ...selected, id: uid(), at: Math.min(60, selected.at + clipSeconds(selected, l)) }; l.clips.push(copy); clipId = copy.id; })), button('Delete clip', () => edit(() => { l.clips = l.clips.filter(c => c !== selected); clipId = l.clips[0]?.id ?? ''; })));
        clipBox.append(actions);
    }
    clipBox.append(button('Add source clip at playhead', () => edit(() => { const c: LayerClip = { id: uid(), start: 0, end: Math.min(source.seconds, .2), at: playhead, pitch: 0, gain: 1 }; l.clips.push(c); clipId = c.id; })));
    root.append(effectGroups.get('Effects')!.parentElement!);
    const credits = document.createElement('p');
    credits.className = 'hint source-info';
    credits.textContent = `Source: ${source.source || 'unrecorded'} · Author: ${source.author || 'unrecorded'} · Licence: ${source.license || 'unrecorded'}`;
    root.append(credits);
}
function updateHead(): void { $('playhead').style.left = Math.max(0, Math.min(1, playhead / (project?.seconds ?? 1))) * 100 + '%'; $<HTMLInputElement>('playhead-time').value = playhead.toFixed(3); }
function animate(): void { if (voice) {
    const at = audio.currentTime - playStarted + playOffset;
    const position = project.loop ? at % project.seconds : Math.min(project.seconds, at);
    $('playhead').style.left = position / project.seconds * 100 + '%';
} requestAnimationFrame(animate); }
requestAnimationFrame(animate);
async function renderMix(solo?: string): Promise<AudioBuffer> { validateProject(project, catalog.sources); message('Rendering source layers…'); const snapshot = clone(project); const result = await renderer.render(snapshot, catalog, solo); let peak = 0; let sum = 0; for (let ch = 0; ch < result.numberOfChannels; ch++)
    for (const x of result.getChannelData(ch)) {
        peak = Math.max(peak, Math.abs(x));
        sum += x * x;
    } const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity; $('meter').textContent = `Rendered ${result.duration.toFixed(3)} s · peak ${db.toFixed(1)} dBFS · ${peak >= 1 ? 'CLIPPING — lower gain or use Set −3 dB peak' : 'headroom available'} · RMS ${(10 * Math.log10(sum / result.length / result.numberOfChannels)).toFixed(1)} dBFS`; return result; }
function peakOf(buffer: AudioBuffer): number { let peak = 0; for (let ch = 0; ch < buffer.numberOfChannels; ch++)
    for (const x of buffer.getChannelData(ch))
        peak = Math.max(peak, Math.abs(x)); return peak; }
async function preview(solo?: string): Promise<void> { stop(); const epoch = previewEpoch; await audio.resume(); await operation(async () => { const buffer = await renderMix(solo); if (epoch !== previewEpoch)
    return; const src = audio.createBufferSource(); src.buffer = buffer; src.loop = project.loop; src.connect(monitor); voice = src; playOffset = Math.min(playhead, Math.max(0, buffer.duration - .001)); playStarted = audio.currentTime; src.start(0, playOffset); src.onended = () => { if (voice === src) {
    voice = null;
    updateHead();
} }; message(`Previewing ${solo ? 'selected layer' : project.name}. Monitor gain does not change the exported mix.`); }); }
async function saveDraft(): Promise<void> { validateProject(project, catalog.sources); await put('/api/sound-layers/project', project); const index = catalog.projects.findIndex(p => p.id === project.id); if (index < 0)
    catalog.projects.push(clone(project));
else
    catalog.projects[index] = clone(project); try {
    localStorage.removeItem('rope.layers.' + project.id);
}
catch { /* storage unavailable */ } drawVariants(project.id); }
async function apply(): Promise<void> {
    stop();
    await operation(async () => {
        const buffer = await renderMix();
        if (peakOf(buffer) >= 1)
            throw Error('Mix clips. Lower Mix gain or use Set −3 dB peak before applying.');
        if (peakOf(buffer) < 1e-7)
            throw Error('The rendered mix is silent. Unmute or add an audible layer before applying.');
        const current = await api<{
            bank: SoundBank;
            assets: Record<string, SoundAsset>;
        }>('/api/sounds');
        const oldKeys = current.bank.slots[project.slot]?.sounds ?? [];
        if (project.assetKey && !oldKeys.includes(project.assetKey))
            throw Error('This variation is no longer assigned. Use New variation, or reload the current event before replacing it.');
        const expected = JSON.stringify(oldKeys);
        const uploaded = await api<{
            key: string;
            asset: SoundAsset;
        }>('/api/sounds?keepLeading=true&stereo=true&name=' + encodeURIComponent(project.name + '-' + Date.now() + '.wav'), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wavBytes(buffer) });
        const usedSources = [...new Set(project.layers.map(l => l.sourceId))].map(id => catalog.sources.find(s => s.id === id)!);
        await api('/api/sounds/assets/' + uploaded.key, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: [...new Set(usedSources.map(s => s.source).filter(Boolean))].join(' + '), author: usedSources.every(s => s.author) ? [...new Set(usedSources.map(s => s.author))].join('; ') : '', license: usedSources.every(s => s.license) ? [...new Set(usedSources.map(s => s.license))].join('; ') : '' }) });
        const fresh = await api<{
            bank: SoundBank;
            assets: Record<string, SoundAsset>;
        }>('/api/sounds');
        if (JSON.stringify(fresh.bank.slots[project.slot]?.sounds ?? []) !== expected)
            throw Error('Event assignment changed during rendering. The new asset is uploaded; reload before applying again.');
        const slot = fresh.bank.slots[project.slot] ??= {};
        slot.sounds = project.assetKey ? oldKeys.map(k => k === project.assetKey ? uploaded.key : k) : [...oldKeys, uploaded.key];
        await put('/api/sounds/bank', fresh.bank);
        const old = project.assetKey;
        project.assetKey = uploaded.key;
        if (old && !Object.values(fresh.bank.slots).some(s => s.sounds?.includes(old)))
            await api('/api/sounds/assets/' + old, { method: 'DELETE' });
        const next = await api<{
            bank: SoundBank;
            assets: Record<string, SoundAsset>;
        }>('/api/sounds');
        bank = next.bank;
        assets = next.assets;
        broadcastSounds(next);
        await saveDraft();
        draw();
        message(`Applied ${project.name} to ${title(project.slot)}. The game receives the new mix live; the editable layers are saved.`);
    });
}
$('all-surfaces').onchange = () => { drawEvents(); chooseEvent(); };
$('source-search').oninput = drawSources;
$('events').onchange = chooseEvent;
$('variants').onchange = () => load($<HTMLSelectElement>('variants').value);
$('new').onclick = () => { if (!project?.layers.length) {
    blank();
    return;
} const copy = clone(project); copy.id = 'project-' + uid(); copy.name += ' copy'; copy.assetKey = null; catalog.projects.push(copy); drawVariants(copy.id); load(copy.id); };
$('undo').onclick = () => { if (!undo.length)
    return; stop(); redo.push(clone(project)); project = undo.pop()!; persist(); draw(); };
$('redo').onclick = () => { if (!redo.length)
    return; stop(); undo.push(clone(project)); project = redo.pop()!; persist(); draw(); };
$('project-name').onchange = () => edit(() => project.name = $<HTMLInputElement>('project-name').value);
$('duration').onchange = () => { const value = Number($<HTMLInputElement>('duration').value); if (value >= .02 && value <= 60)
    edit(() => project.seconds = value);
else
    draw(); };
$('mix-gain').onchange = () => { const value = Number($<HTMLInputElement>('mix-gain').value); if (Number.isFinite(value) && value >= -60 && value <= 24)
    edit(() => project.gainDb = value);
else
    draw(); };
$('loop').onchange = () => edit(() => { project.loop = $<HTMLInputElement>('loop').checked; project.fadeOut = project.loop ? 0 : .015; });
$('ruler').onpointerdown = e => { stop(); const rect = $('ruler').getBoundingClientRect(); playhead = Math.max(0, Math.min(project.seconds, (e.clientX - rect.left) / rect.width * project.seconds)); updateHead(); };
$('playhead-time').onchange = () => { const value = Number($<HTMLInputElement>('playhead-time').value) || 0; stop(); playhead = Math.max(0, Math.min(project.seconds, value)); updateHead(); };
$('monitor').oninput = () => { const value = Number($<HTMLInputElement>('monitor').value); monitor.gain.setTargetAtTime(10 ** (value / 20), audio.currentTime, .015); $('monitor-value').textContent = value + ' dB'; };
$('play').onclick = () => void preview();
$('play').title = 'Preview mix (Space when the workspace has focus)';
$('undo').title = 'Undo (Ctrl/Cmd + Z)';
$('redo').title = 'Redo (Ctrl/Cmd + Shift + Z)';
$('play-layer').onclick = () => { if (layer())
    void preview(layerId); };
$('stop').onclick = stop;
$('save').onclick = () => void operation(async () => { await saveDraft(); message('Editable draft saved to disk. Apply to game event when ready.'); });
$('revert').onclick = () => { try {
    localStorage.removeItem('rope.layers.' + project.id);
}
catch { /* storage unavailable */ } load(project.id); };
$('export').onclick = () => void operation(async () => { const buffer = await renderMix(); download(new Blob([wavBytes(buffer)], { type: 'audio/wav' }), project.name + '.wav'); message('Exported WAV. Game assignment unchanged.'); });
$('headroom').onclick = () => void operation(async () => { const buffer = await renderMix(); const peak = peakOf(buffer); if (peak < 1e-8)
    throw Error('Mix is silent'); edit(() => project.gainDb = Math.max(-60, Math.min(24, project.gainDb - 3 - 20 * Math.log10(peak)))); message('Mix gain adjusted for a −3 dB sample peak. Preview again to measure.'); });
$('apply').onclick = () => void apply();
$('add').onclick = () => { const source = catalog.sources.find(s => s.id === $<HTMLSelectElement>('sources').value); if (!source)
    return; edit(() => { const l: SoundLayer = { id: uid(), name: source.name, sourceId: source.id, clips: [{ id: uid(), start: 0, end: Math.min(source.seconds, project.seconds), at: playhead, pitch: 0, gain: 1 }], effects: defaultEffects(), mute: false, solo: false }; project.layers.push(l); layerId = l.id; clipId = l.clips[0].id; }); };
$('import').onchange = () => void operation(async () => { const input = $<HTMLInputElement>('import'); const file = input.files?.[0]; if (!file)
    return; message('Importing recording…'); const source = await api<LayerCatalog['sources'][number]>('/api/sound-layers/source?name=' + encodeURIComponent(file.name), { method: 'POST', body: file }); if (!catalog.sources.some(s => s.id === source.id))
    catalog.sources.push(source); $<HTMLInputElement>('source-search').value = ''; draw(); $<HTMLSelectElement>('sources').value = source.id; input.value = ''; message('Recording imported. Choose Add layer to use it.'); });
document.addEventListener('visibilitychange', () => { if (document.hidden)
    stop(); });
window.addEventListener('keydown', e => { const target = e.target as HTMLElement; if (target.matches('input,select,textarea') || (target.matches('button,summary') && (e.code === 'Space' || e.code === 'Enter')))
    return; if (e.code === 'Space') {
    e.preventDefault();
    if (voice)
        stop();
    else
        void preview();
} if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    $(e.shiftKey ? 'redo' : 'undo').click();
} });
void operation(async () => { const [loaded, current] = await Promise.all([api<LayerCatalog>('/api/sound-layers'), api<{
        bank: SoundBank;
        assets: Record<string, SoundAsset>;
    }>('/api/sounds')]); catalog = loaded; bank = current.bank; assets = current.assets; drawEvents(); chooseEvent(); });
