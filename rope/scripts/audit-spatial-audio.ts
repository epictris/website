// Actual browser-rendered L/R audit of every assigned, edited recording.
// Run explicitly: bun run scripts/audit-spatial-audio.ts
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { findChromium, grab } from "../src/tools/shotRunner";

const root = resolve(import.meta.dir, "..");
const assets = JSON.parse(readFileSync(join(root, "src/audio/soundAssets.json"), "utf8"));
const bank = JSON.parse(readFileSync(join(root, "src/audio/soundBank.json"), "utf8"));
const roles = new Map<string, string[]>();
for (const [slot, params] of Object.entries(bank.slots) as [string, { sounds?: string[] }][]) {
  for (const key of params.sounds ?? []) roles.set(key, [...(roles.get(key) ?? []), slot]);
}
const samples = [...roles].map(([key, slots]) => ({ key, slots, edit: bank.clips?.[key] ?? {},
  data: readFileSync(join(root, "public", assets[key].file)).toString("base64") }));
const work = mkdtempSync(join(tmpdir(), "rope-spatial-audit-"));
const entry = join(work, "entry.ts");
writeFileSync(entry, `
import { makeSpatialPanner, setListenerPose } from ${JSON.stringify(join(root, "src/audio/spatialAudio.ts"))};
import { scheduleShotEnvelope } from ${JSON.stringify(join(root, "src/audio/playbackLevel.ts"))};
const samples = ${JSON.stringify(samples)};
(async () => {
  const sr = 48000;
  const decoder = new OfflineAudioContext(2, 1, sr);
  const decoded = [];
  for (const sample of samples) {
    const bytes = Uint8Array.from(atob(sample.data), c => c.charCodeAt(0));
    const buffer = await decoder.decodeAudioData(bytes.buffer);
    decoded.push({ ...sample, buffer });
  }
  const cases = [];
  let at = .05;
  for (const sample of decoded) {
    const start = sample.edit.start ?? 0;
    const end = Math.min(sample.buffer.duration, sample.edit.end ?? sample.buffer.duration);
    const rate = 2 ** ((sample.edit.pitch ?? 0) / 12);
    const duration = (end - start) / rate;
    for (const [label, position] of [
      ['centre', {x:40,y:8}], ['left', {x:36,y:8}], ['right', {x:44,y:8}],
      ['above', {x:40,y:6}], ['below', {x:40,y:10}], ['audition', null],
    ]) {
      cases.push({sample, label, position, at, start, end, rate, duration});
      at += duration + .08;
    }
  }
  const ctx = new OfflineAudioContext(2, Math.ceil((at + .1) * sr), sr);
  setListenerPose(ctx.listener, {x:40,y:-8,z:15.75,forward:{x:0,y:0,z:-1},up:{x:0,y:1,z:0}}, 0);
  for (const c of cases) {
    const src = ctx.createBufferSource(); src.buffer = c.sample.buffer; src.playbackRate.value = c.rate;
    const gain = ctx.createGain();
    scheduleShotEnvelope(gain.gain, .25, c.at, c.duration);
    src.connect(gain);
    if (c.position) gain.connect(makeSpatialPanner(ctx,c.position)).connect(ctx.destination);
    else gain.connect(ctx.destination);
    src.start(c.at,c.start,c.end-c.start);
  }
  const rendered = await ctx.startRendering();
  const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
  const report = [];
  for (const sample of decoded) {
    const measurements = {};
    for (const c of cases.filter(c => c.sample.key === sample.key)) {
      const energies = channels.map(x => {
        let sum = 0;
        for (let i = Math.round(c.at*sr); i < Math.round((c.at+c.duration+.05)*sr); i++) sum += x[i]*x[i];
        return sum;
      });
      measurements[c.label] = {left:energies[0],right:energies[1],balanceDb:10*Math.log10(energies[0]/energies[1])};
    }
    report.push({key:sample.key,slots:sample.slots,channels:sample.buffer.numberOfChannels,measurements});
  }
  window.__shotLog = [{level:'log',text:JSON.stringify({spatialAudit:report})}];
  window.shotReady = true;
})().catch(error => {window.__shotLog=[{level:'error',text:String(error)}];window.shotReady=true});
`);
const bundle = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
assert.ok(bundle.success, String(bundle.logs));
const html = join(work, "audit.html");
writeFileSync(html, '<!doctype html><script>' + await bundle.outputs[0]!.text() + '</script>');
const chromium = findChromium();
assert.ok(chromium, "Chromium is required for actual Web Audio channel measurements");
const result = await grab(chromium, { url: `file://${html}`, out: null, gpu: false, width: 400, height: 300, timeoutMs: 60000 });
const log = result.log.find(entry => entry.text.startsWith('{"spatialAudit":'));
assert.ok(log, JSON.stringify(result.log));
const report = JSON.parse(log.text).spatialAudit;
const output = join(root, "tools/audio/spatial-audit.json");
writeFileSync(output, JSON.stringify({ method: "Chromium OfflineAudioContext, actual edited recordings, production panner/envelope helpers; camera at (40,-8,15.75), six source placements per recording", samples: report }, null, 2) + '\n');
for (const row of report) {
  const m = row.measurements;
  for (const label of ["centre", "above", "below", "audition"]) {
    assert.ok(Number.isFinite(m[label].balanceDb) && Math.abs(m[label].balanceDb) < .15,
      `${row.key} / ${label}: unexpected channel bias ${m[label].balanceDb} dB`);
  }
  assert.ok(m.left.balanceDb > 0, `${row.key}: left placement must favour left`);
  assert.ok(m.right.balanceDb < 0, `${row.key}: right placement must favour right`);
  assert.ok(Math.abs(m.left.balanceDb + m.right.balanceDb) < 1, `${row.key}: mirrored positions exceed 1 dB HRTF filter/interpolation asymmetry`);
}
console.log(`PASS: ${report.length} recordings × 6 placements; centred/elevated/audition balance within 0.15 dB, correct left/right direction and under 1 dB mirror asymmetry. Report: ${output}`);
