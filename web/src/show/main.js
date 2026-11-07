// Show output: open http://<server>:8080/show/<projectId> on the show laptop.
//
// URL options (all optional):
//   ?res=3840x1080   render at an exact output resolution (LED processors, odd walls)
//   ?fit=contain|cover|stretch   how a forced resolution maps to the window (default contain)
//   ?scale=0.5       fixed internal render scale (default: adaptive)
//   ?hud=1           show the info overlay on start
import './show.css';
import { api } from '../lib/api.js';
import { ShowLink, trackPosition } from '../lib/sync.js';
import { StageRenderer } from '../lib/renderer.js';
import { VisualEngine } from '../lib/visuals.js';
import { TrackPlayer } from '../lib/player.js';

const projectId = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] ?? '');
const params = new URLSearchParams(location.search);
const resMatch = /^(\d{2,5})x(\d{2,5})$/.exec(params.get('res') ?? '');
const forcedRes = resMatch ? { w: +resMatch[1], h: +resMatch[2] } : null;
const fit = ['contain', 'cover', 'stretch'].includes(params.get('fit')) ? params.get('fit') : 'contain';
const scaleParam = parseFloat(params.get('scale'));

const $ = (id) => document.getElementById(id);
const canvas = $('output');
const hud = $('hud');
if (params.get('hud') === '1') hud.classList.remove('hidden');

const engine = new VisualEngine();
const player = new TrackPlayer();
player.enabled = false;
let projectName = '';
let audioUrlLoaded = null;
let pendingAudioUrl = null;
let lastState = null;

// ---------------------------------------------------------------- layout for forced resolutions
function layoutCanvas() {
  if (!forcedRes) {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    return;
  }
  const W = window.innerWidth, H = window.innerHeight;
  const ar = forcedRes.w / forcedRes.h;
  let w = W, h = H;
  if (fit === 'contain') {
    if (W / H > ar) w = H * ar; else h = W / ar;
  } else if (fit === 'cover') {
    if (W / H > ar) h = W / ar; else w = H * ar;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}
layoutCanvas();
window.addEventListener('resize', layoutCanvas);

const renderer = new StageRenderer(canvas, {
  res: forcedRes,
  scale: Number.isFinite(scaleParam) ? scaleParam : 'auto',
  maxPixels: 1920 * 1080,
});

// ---------------------------------------------------------------- data
function setStatus(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = cls ?? '';
}

async function loadProject() {
  if (!projectId) {
    $('armTitle').textContent = 'No project in URL';
    return;
  }
  try {
    const full = await api.project(projectId);
    projectName = full.project?.name ?? projectId;
    $('armTitle').textContent = projectName;
    document.title = `${projectName} · Stagegen Output`;
    engine.setAnalysis(full.analysis);
    engine.setPlan(full.plan);
    const url = full.project?.audio ? `/media/${projectId}/audio?v=${full.project.updatedAt}` : null;
    if (!full.project?.audio) setStatus('stAssets', 'Track: none uploaded yet', 'warn');
    else setStatus('stAssets', `Track: ${full.analysis?.bpm ?? '?'} BPM · ${full.analysis?.sections?.length ?? 0} sections`, 'ok');
    // Only download the audio when this output is asked to play it.
    pendingAudioUrl = url;
    if (lastState?.showAudio && url !== audioUrlLoaded) await loadAudio(url);
  } catch (err) {
    $('armTitle').textContent = err.message;
  }
}

async function loadAudio(url) {
  audioUrlLoaded = url;
  try {
    await player.load(url);
  } catch (err) {
    console.warn(err);
  }
}

const link = new ShowLink({
  role: 'show',
  project: projectId,
  onState: async (state) => {
    lastState = state;
    engine.setState(state);
    player.enabled = !!state.showAudio;
    if (state.showAudio && pendingAudioUrl && audioUrlLoaded !== pendingAudioUrl) await loadAudio(pendingAudioUrl);
    player.sync(state, link);
  },
  onReload: () => loadProject(),
  onLive: (m) => engine.pushLive(m, link.serverNow()),
  onStatus: (l) => {
    setStatus('stLink', l.connected ? 'Server: connected' : 'Server: reconnecting… (visuals keep running)', l.connected ? 'ok' : 'warn');
    setStatus('stSync', l.synced ? `Clock: synced (±${(l.rtt / 2).toFixed(1)} ms)` : 'Clock: syncing', l.synced ? 'ok' : '');
  },
});
link.connect();
loadProject();
window.__stagegen = { link, engine, player, get state() { return lastState; } };

// ---------------------------------------------------------------- controls
async function arm() {
  $('arm').classList.add('hidden');
  try {
    await player.resume();
  } catch { /* audio optional */ }
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  if (lastState) player.sync(lastState, link);
}
$('armBtn').addEventListener('click', arm);

window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (e.key === 'h' || e.key === 'H') {
    hud.classList.toggle('hidden');
  } else if (e.key === 'Enter' && !$('arm').classList.contains('hidden')) {
    arm();
  }
});

let idleTimer;
window.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
});

// ---------------------------------------------------------------- render loop
let last = performance.now();
let fps = 60;
function frame(t) {
  const dt = t - last;
  last = t;
  fps = fps * 0.95 + (1000 / Math.max(1, dt)) * 0.05;
  const now = link.serverNow();
  const u = engine.compute(now, dt);
  renderer.render(u, dt);
  if (lastState) player.sync(lastState, link);

  if (!hud.classList.contains('hidden')) {
    const s = lastState;
    const sec = engine.sections[u.section];
    hud.textContent = [
      `${projectName}`,
      `mode      ${s?.mode ?? '-'}${s?.mode === 'track' ? (s.playing ? '  ▶ playing' : '  ❚❚ paused') : ''}`,
      `position  ${s?.mode === 'track' ? trackPosition(s, now).toFixed(2) + ' s' : '-'}`,
      `section   ${sec ? `${u.section + 1}/${engine.sections.length} ${engine.plan?.sections?.[u.section]?.title ?? sec.name}` : '-'}`,
      `render    ${renderer.width}×${renderer.height} (scale ${renderer.scale.toFixed(2)})  ${fps.toFixed(0)} fps`,
      `window    ${window.innerWidth}×${window.innerHeight} @${devicePixelRatio}x${forcedRes ? `  forced ${forcedRes.w}×${forcedRes.h} ${fit}` : ''}`,
      `sync      ${link.synced ? `rtt ${link.rtt.toFixed(1)} ms` : 'syncing'}  ${link.connected ? '' : '(offline)'}`,
      `audio     ${s?.showAudio ? (player.buffer ? 'on' : 'loading') : 'off'}`,
    ].join('\n');
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
