// Non-destructive sound-authoring data. Only exported mixes enter game playback.
export interface LayerSource {
    id: string;
    name: string;
    file: string;
    seconds: number;
    source: string;
    author: string;
    license: string;
}
export interface LayerClip {
    id: string;
    start: number;
    end: number;
    at: number;
    pitch: number;
    gain: number;
}
export interface LayerEffects {
    gainDb: number;
    pitch: number;
    pan: number;
    highpass: number;
    lowpass: number;
    bass: number;
    treble: number;
    fadeIn: number;
    fadeOut: number;
    decay: number;
    normalize: boolean;
    drive: number;
    delay: number;
    delayMix: number;
    reverb: number;
    compression: number;
}
export interface SoundLayer {
    id: string;
    name: string;
    sourceId: string;
    clips: LayerClip[];
    effects: LayerEffects;
    mute: boolean;
    solo: boolean;
}
export interface LayerProject {
    id: string;
    name: string;
    slot: string;
    assetKey: string | null;
    seconds: number;
    loop: boolean;
    gainDb: number;
    fadeOut: number;
    layers: SoundLayer[];
}
export interface LayerCatalog {
    version: 1;
    sources: LayerSource[];
    projects: LayerProject[];
}
export const defaultEffects = (): LayerEffects => ({
    gainDb: 0, pitch: 0, pan: 0, highpass: 0, lowpass: 20000, bass: 0, treble: 0,
    fadeIn: 0, fadeOut: 0.01, decay: 0, normalize: false,
    drive: 0, delay: 0.15, delayMix: 0, reverb: 0, compression: 0,
});
export const clipSeconds = (clip: LayerClip, layer: SoundLayer): number => (clip.end - clip.start) / 2 ** ((layer.effects.pitch + clip.pitch) / 12);
export function validateProject(project: LayerProject, sources: LayerSource[]): void {
    if (!project || !/^[a-zA-Z0-9_-]{1,160}$/.test(project.id) || typeof project.name !== 'string' || project.name.length > 200)
        throw Error('Invalid project identity');
    if (typeof project.slot !== 'string' || typeof project.loop !== 'boolean' || (project.assetKey !== null && typeof project.assetKey !== 'string'))
        throw Error('Invalid event assignment');
    const range = (v: number, lo: number, hi: number) => {
        if (!Number.isFinite(v) || v < lo || v > hi)
            throw Error(`Value outside ${lo}–${hi}`);
    };
    range(project.seconds, 0.02, 60);
    range(project.gainDb, -60, 24);
    range(project.fadeOut, 0, 5);
    if (!Array.isArray(project.layers) || project.layers.length > 64)
        throw Error('A project supports up to 64 layers');
    const ids = new Set<string>();
    for (const layer of project.layers) {
        if (!layer || typeof layer.name !== 'string' || typeof layer.id !== 'string' || ids.has(layer.id))
            throw Error('Invalid or duplicate layer');
        ids.add(layer.id);
        const source = sources.find(s => s.id === layer.sourceId);
        if (!source)
            throw Error('Unknown source');
        if (!Array.isArray(layer.clips) || layer.clips.length > 512)
            throw Error('Too many clips');
        const e = layer.effects;
        for (const [key, lo, hi] of [
            ['gainDb', -60, 24], ['pitch', -24, 24], ['pan', -1, 1], ['highpass', 0, 18000], ['lowpass', 20, 22000],
            ['bass', -24, 24], ['treble', -24, 24], ['fadeIn', 0, 5], ['fadeOut', 0, 5], ['decay', 0, 10],
            ['drive', 0, 1], ['delay', 0.01, 2], ['delayMix', 0, 1], ['reverb', 0, 1], ['compression', 0, 1],
        ] as const)
            range(e[key], lo, hi);
        if (typeof e.normalize !== 'boolean' || typeof layer.mute !== 'boolean' || typeof layer.solo !== 'boolean')
            throw Error('Invalid layer switches');
        for (const clip of layer.clips) {
            if (typeof clip.id !== 'string')
                throw Error('Invalid clip');
            range(clip.start, 0, source.seconds);
            range(clip.end, clip.start + 0.001, source.seconds + 0.001);
            range(clip.at, 0, 60);
            range(clip.pitch, -24, 24);
            range(clip.gain, 0, 4);
        }
    }
}
