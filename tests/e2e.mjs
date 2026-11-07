// End-to-end check: studio + show outputs, sync, plan rendering. Usage: node e2e.mjs <projectId>
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const id = process.argv[2];
const base = 'http://localhost:8080';
const shots = new URL('./shots/', import.meta.url);
fs.mkdirSync(fileURLToPath(shots), { recursive: true });
const shot = (p, name) => p.screenshot({ path: fileURLToPath(new URL(name, shots)) });

// Install a sample plan (what the LLM would return) so the plan UI can be checked without a key.
const full = await (await fetch(`${base}/api/projects/${id}`)).json();
const { normalizePlan } = await import('../gateway/plan-schema.mjs');
const plan = normalizePlan(
  {
    title: 'Dust & Neon',
    concept: 'A lone figure crosses a dusk desert; at the drop the sky ignites into a storm of neon light.',
    global_style: 'cinematic, volumetric haze, anamorphic 35mm, high dynamic range',
    negative_prompt: 'text, logos, watermark, faces, people in center frame',
    palette: ['#0b0f2a', '#2a1b5c', '#7a2e8e', '#ff4d8d', '#ffd36e'],
    sections: [
      { id: 0, title: 'Long Shadows', mood: 'lonely, hushed, expectant', palette: ['#06070f', '#14183a', '#3b2a6b', '#a3476f', '#f2a76b'], image_prompt: 'vast dusk desert, dunes fading into violet haze, tiny silhouette far on the horizon', video_prompt: 'slow drift across dunes, dust in backlight, loopable', camera: { move: 'push-in', from: 'wide horizon', to: 'silhouette' }, motion: 'low', speed: 0.2, turbulence: 0.3, fx: ['grain', 'haze'] },
      { id: 1, title: 'Neon Storm', mood: 'euphoric, electric', palette: ['#12051f', '#4b0f6b', '#c2187a', '#ff5fa2', '#ffe08a'], image_prompt: 'sky erupting in neon light ribbons over desert, lightning in magenta', video_prompt: 'neon ribbons sweeping across the sky, particles rising', camera: { move: 'orbit', from: 'dunes', to: 'storm core' }, motion: 'high', speed: 0.85, turbulence: 0.8, fx: ['particles', 'bloom', 'strobe', 'chromatic'] },
    ],
  },
  full.analysis,
);
plan.prompt = 'lonely neon desert at dusk, slow build into a storm of light at the drop';
plan.model = 'sample (no LLM)';
await fetch(`${base}/api/projects/${id}/plan`, { method: 'PUT', body: JSON.stringify(plan) });

const browser = await chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=d3d11', '--enable-gpu'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const studio = await ctx.newPage();
const errors = [];
studio.on('pageerror', (e) => errors.push(`studio: ${e.message}`));
studio.on('console', (m) => m.type() === 'error' && errors.push(`studio console: ${m.text()}`));
await studio.goto(`${base}/?project=${id}`);
await studio.waitForTimeout(2500);
await shot(studio, 'studio-idle.png');

// Show outputs at different shapes.
const shows = [];
for (const [w, h, q, name] of [[1920, 1080, '?hud=1', 'show-16x9.png'], [1600, 400, '?hud=1', 'show-ultrawide.png'], [800, 1000, '?hud=1', 'show-portrait.png']]) {
  const c = await browser.newContext({ viewport: { width: w, height: h } });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`show: ${e.message}`));
  await p.goto(`${base}/show/${id}${q}`);
  await p.waitForTimeout(1200);
  await p.click('#armBtn');
  shows.push({ p, name });
}

// Play from the drop and compare positions across clients.
await studio.click('#playBtn');
await studio.waitForTimeout(400);
await studio.evaluate(() => null);
await studio.locator('#timeline').click({ position: { x: 1440 * 0.42, y: 60 } });
await studio.waitForTimeout(2500);

const studioPos = await studio.evaluate(() => document.getElementById('timeLabel').textContent);

// Sync check: every client maps wall-clock time to server time; the spread of
// (serverNow - wallNow) across clients is the cross-client timing error.
const probe = () => {
  const s = window.__stagegen;
  const wall = performance.timeOrigin + performance.now();
  const sv = s.link.serverNow();
  const st = s.state;
  const pos = st.playing ? st.anchorPos + (sv - st.anchorServerMs) / 1000 : st.anchorPos;
  const p = s.player;
  const heard = p.src ? p.startPos + (p.ctx.currentTime - p.startCtx - p.latency()) : null;
  return { offset: sv - wall, pos, heard, ctx: p.ctx?.state };
};
const samples = await Promise.all([studio, ...shows.map((s) => s.p)].map((p) => p.evaluate(probe)));
const offs = samples.map((s) => s.offset);
console.log('clock offsets (ms):', offs.map((o) => (o - offs[0]).toFixed(2)).join(', '), `→ spread ${(Math.max(...offs) - Math.min(...offs)).toFixed(2)} ms`);
console.log('studio audio: expected', samples[0].pos.toFixed(3), 's, heard', samples[0].heard?.toFixed(3), `(ctx ${samples[0].ctx})`);
for (const { p, name } of shows) {
  await shot(p, name);
  const hud = await p.evaluate(() => document.getElementById('hud').textContent);
  console.log(`--- ${name}\n${hud}`);
}
await shot(studio, 'studio-playing.png');
console.log('studio time label:', studioPos);

// Live mode: cue section 2, tap tempo.
await studio.click('#modeSeg button[data-mode="live"]');
await studio.waitForTimeout(300);
await studio.click('.pad >> nth=1');
for (let i = 0; i < 4; i++) {
  await studio.click('#tapBtn');
  await studio.waitForTimeout(500);
}
await studio.waitForTimeout(1600);
await shot(studio, 'studio-live.png');
await shot(shows[0].p, 'show-live.png');
console.log('--- live hud\n' + (await shows[0].p.evaluate(() => document.getElementById('hud').textContent)));
console.log('bpm field:', await studio.inputValue('#bpmInput'));

// Back to track mode, pause.
await studio.click('#modeSeg button[data-mode="track"]');
await studio.keyboard.press('Space');
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
