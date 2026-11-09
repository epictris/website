import { clipSeconds, type LayerCatalog, type LayerClip, type LayerProject, type SoundLayer } from '../audio/layerProject';
export const SOURCE_URL = (id: string): string => `/api/sound-layers/file?id=${encodeURIComponent(id)}`;
export class LayerRenderer {
    private context = new AudioContext({ sampleRate: 48000 });
    private sources = new Map<string, Promise<AudioBuffer>>();
    private prepared = new Map<string, Promise<AudioBuffer>>();
    async source(id: string): Promise<AudioBuffer> {
        let held = this.sources.get(id);
        if (!held) {
            held = fetch(SOURCE_URL(id)).then(async (r) => { if (!r.ok)
                throw Error('Source recording unavailable'); return this.context.decodeAudioData(await r.arrayBuffer()); });
            this.sources.set(id, held);
            held.catch(() => this.sources.delete(id));
        }
        return held;
    }
    private prepare(layer: SoundLayer, clip: LayerClip): Promise<AudioBuffer> {
        const e = layer.effects;
        const key = JSON.stringify([layer.sourceId, clip.start, clip.end, e.pitch, e.highpass, e.lowpass, e.fadeIn, e.fadeOut, e.decay, e.normalize]);
        const held = this.prepared.get(key);
        if (held)
            return held;
        const promise = (async () => {
            const raw = await this.source(layer.sourceId);
            const start = Math.max(0, Math.min(raw.duration - .001, clip.start));
            const end = Math.min(raw.duration, clip.end);
            const rate = 2 ** (e.pitch / 12);
            const seconds = (end - start) / rate;
            const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(seconds * 48000)), 48000);
            const src = ctx.createBufferSource();
            src.buffer = raw;
            src.playbackRate.value = rate;
            let tail: AudioNode = src;
            for (const [type, freq] of [['highpass', e.highpass], ['lowpass', e.lowpass]] as const) {
                if (freq <= 0)
                    continue;
                const filter = ctx.createBiquadFilter();
                filter.type = type;
                filter.frequency.value = Math.min(22000, freq);
                filter.Q.value = Math.SQRT1_2;
                tail.connect(filter);
                tail = filter;
            }
            tail.connect(ctx.destination);
            src.start(0, start, end - start);
            const rendered = await ctx.startRendering();
            const x = rendered.getChannelData(0);
            let peak = 0;
            const fadeIn = Math.min(x.length, Math.round(e.fadeIn * 48000));
            const fadeOut = Math.min(x.length, Math.round(e.fadeOut * 48000));
            for (let i = 0; i < x.length; i++) {
                const a = fadeIn > 0 ? Math.min(1, i / Math.max(1, fadeIn - 1)) : 1;
                const b = fadeOut > 0 ? Math.min(1, (x.length - 1 - i) / Math.max(1, fadeOut - 1)) : 1;
                x[i] *= a * b * (e.decay > 0 ? Math.exp(-i / 48000 / e.decay) : 1);
                peak = Math.max(peak, Math.abs(x[i]));
            }
            if (e.normalize && peak > 1e-9)
                for (let i = 0; i < x.length; i++)
                    x[i] /= peak;
            return rendered;
        })();
        this.prepared.set(key, promise);
        if (this.prepared.size > 150)
            this.prepared.delete(this.prepared.keys().next().value!);
        promise.catch(() => this.prepared.delete(key));
        return promise;
    }
    async render(project: LayerProject, _catalog: LayerCatalog, soloLayer?: string): Promise<AudioBuffer> {
        const active = project.layers.filter(l => !l.mute && (soloLayer ? l.id === soloLayer : !project.layers.some(l => l.solo) || l.solo));
        const clips = await Promise.all(active.flatMap(layer => layer.clips.map(async (clip) => ({ layer, clip, buffer: await this.prepare(layer, clip) }))));
        const seconds = project.seconds;
        const ctx = new OfflineAudioContext(2, Math.ceil(seconds * 48000), 48000);
        const master = ctx.createGain();
        master.gain.value = 10 ** (project.gainDb / 20);
        master.connect(ctx.destination);
        if (project.fadeOut > 0) {
            const at = Math.max(0, seconds - project.fadeOut);
            master.gain.setValueAtTime(master.gain.value, at);
            master.gain.linearRampToValueAtTime(0, seconds);
        }
        for (const layer of active) {
            const e = layer.effects;
            const input = ctx.createGain();
            input.gain.value = 10 ** (e.gainDb / 20);
            let tail: AudioNode = input;
            for (const [type, freq, value] of [['lowshelf', 180, e.bass], ['highshelf', 3500, e.treble]] as const) {
                const node = ctx.createBiquadFilter();
                node.type = type;
                node.frequency.value = freq;
                node.gain.value = value;
                tail.connect(node);
                tail = node;
            }
            if (e.drive > 0) {
                const node = ctx.createWaveShaper();
                const curve = new Float32Array(4096);
                for (let i = 0; i < curve.length; i++) {
                    const x = i * 2 / (curve.length - 1) - 1;
                    curve[i] = Math.tanh(x * (1 + e.drive * 15)) / Math.tanh(1 + e.drive * 15);
                }
                node.curve = curve;
                node.oversample = '4x';
                tail.connect(node);
                tail = node;
            }
            if (e.compression > 0) {
                const node = ctx.createDynamicsCompressor();
                node.threshold.value = -12 - e.compression * 18;
                node.ratio.value = 1 + e.compression * 11;
                node.knee.value = 6;
                node.attack.value = .005;
                node.release.value = .1;
                tail.connect(node);
                tail = node;
            }
            const pan = ctx.createStereoPanner();
            pan.pan.value = e.pan;
            tail.connect(pan);
            pan.connect(master);
            if (e.delayMix > 0) {
                const delay = ctx.createDelay(2);
                delay.delayTime.value = e.delay;
                const wet = ctx.createGain();
                wet.gain.value = e.delayMix;
                pan.connect(delay).connect(wet).connect(master);
            }
            if (e.reverb > 0) {
                const convolver = ctx.createConvolver();
                const impulse = ctx.createBuffer(2, 48000, 48000);
                let state = 1729;
                for (let ch = 0; ch < 2; ch++) {
                    const data = impulse.getChannelData(ch);
                    for (let i = 0; i < data.length; i++) {
                        state = (Math.imul(state, 1664525) + 1013904223) | 0;
                        data[i] = (state / 2147483648) * Math.exp(-i / 8500);
                    }
                }
                convolver.buffer = impulse;
                const wet = ctx.createGain();
                wet.gain.value = e.reverb;
                pan.connect(convolver).connect(wet).connect(master);
            }
            for (const item of clips.filter(c => c.layer === layer)) {
                const src = ctx.createBufferSource();
                src.buffer = item.buffer;
                src.playbackRate.value = 2 ** (item.clip.pitch / 12);
                const gain = ctx.createGain();
                gain.gain.value = item.clip.gain;
                src.connect(gain).connect(input);
                if (item.clip.at >= seconds)
                    continue;
                src.start(item.clip.at);
                // A grain crossing a circular recipe boundary wraps, like the renderer.
                const end = item.clip.at + clipSeconds(item.clip, layer);
                if (project.loop && end > seconds) {
                    const wrap = ctx.createBufferSource();
                    wrap.buffer = item.buffer;
                    wrap.playbackRate.value = src.playbackRate.value;
                    wrap.connect(gain);
                    wrap.start(0, (seconds - item.clip.at) * wrap.playbackRate.value);
                }
            }
        }
        return ctx.startRendering();
    }
}
export function wavBytes(buffer: AudioBuffer): ArrayBuffer {
    // Float WAV keeps layer exports lossless, including sub-full-scale detail.
    const channels = buffer.numberOfChannels;
    const bytes = new ArrayBuffer(44 + buffer.length * channels * 4);
    const view = new DataView(bytes);
    const word = (at: number, s: string) => { for (let i = 0; i < s.length; i++)
        view.setUint8(at + i, s.charCodeAt(i)); };
    word(0, 'RIFF');
    view.setUint32(4, bytes.byteLength - 8, true);
    word(8, 'WAVE');
    word(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channels * 4, true);
    view.setUint16(32, channels * 4, true);
    view.setUint16(34, 32, true);
    word(36, 'data');
    view.setUint32(40, bytes.byteLength - 44, true);
    const data = Array.from({ length: channels }, (_, ch) => buffer.getChannelData(ch));
    let at = 44;
    for (let i = 0; i < buffer.length; i++)
        for (let ch = 0; ch < channels; ch++) {
            view.setFloat32(at, data[ch][i], true);
            at += 4;
        }
    return bytes;
}
