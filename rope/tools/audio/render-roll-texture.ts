// Offline diagnostic using the production grain renderer. Mono float32 I/O.
import { RollingTexture } from '../../src/audio/rollingTexture';
const [input, output, rateText, secondsText] = process.argv.slice(2);
if (!input || !output) throw new Error('input.f32 output.f32 rate seconds');
const bytes = await Bun.file(input).arrayBuffer();
const rate = Number(rateText);
const renderer = new RollingTexture([new Float32Array(bytes)], rate, 1729);
const result = new Float32Array(Math.round(Number(secondsText) * rate));
for (let at = 0; at < result.length; at += 128) {
  renderer.process([result], Math.min(128, result.length - at), 1, 1, at);
}
await Bun.write(output, result);
