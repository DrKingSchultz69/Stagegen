// Stagegen Studio: operator UI running on the server laptop (http://localhost:8080).
import './studio.css';
import { api } from '../lib/api.js';
import { ShowLink, trackPosition } from '../lib/sync.js';
import { StageRenderer } from '../lib/renderer.js';
import { VisualEngine } from '../lib/visuals.js';
import { TrackPlayer } from '../lib/player.js';
import { LiveInput } from '../lib/liveInput.js';
import { Timeline, fmtTime, sectionColor } from './timeline.js';
import { PlanPanel } from './planPanel.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
let projectId = null;
let project = null;
let analysis = null;
let plan = null;
let state = null;
let settings = null;
let info = null;

const engine = new VisualEngine();
const player = new TrackPlayer();
const liveInput = new LiveInput();
const renderer = new StageRenderer($('preview'), { maxPixels: 1280 * 720 });
const timeline = new Timeline($('timeline'), { onSeek: (t) => seek(t) });
const planPanel = new PlanPanel($('planPanel'), {
  onSave: async (p) => {
    try {
      await api.savePlan(projectId, p);
      setStatus('Plan saved. Show outputs updated.');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  },
  onPreview: (p) => {
    engine.setPlan(p);
    timeline.setData(analysis, p);
    renderPads();
  },
});

const link = new ShowLink({
  role: 'studio',
  onState: (s) => {
    state = s;
    engine.setState(s);
    player.sync(s, link);
    syncControls();
  },
  onReload: async (what) => {
    if (what === 'plan' && planPanel.dirty) return; // don't clobber unsaved edits
    await reloadProject();
  },
  onPresence: (p) => {
    const chip = $('chipShows');
    chip.textContent = `${p.shows} output${p.shows === 1 ? '' : 's'}`;
    chip.className = `chip ${p.shows > 0 ? 'ok' : ''}`;
  },
  onStatus: (l) => {
    const chip = $('chipLink');
    chip.textContent = l.connected ? (l.synced ? `Server · ${l.rtt.toFixed(0)} ms` : 'Server') : 'Server offline';
    chip.className = `chip ${l.connected ? 'ok' : 'bad'}`;
  },
});

// ---------------------------------------------------------------- helpers
function setStatus(text, cls = '') {
  const el = $('promptStatus');
  el.textContent = text;
  el.className = `prompt-status ${cls}`;
}

function currentPos() {
  return state ? trackPosition(state, link.serverNow()) : 0;
}

function currentSectionIndex() {
  if (!analysis) return 0;
  if (state?.mode === 'live') return state.liveSection ?? 0;
  return engine.sectionAt(currentPos());
}

// ---------------------------------------------------------------- projects
async function refreshProjectList(selectId) {
  const list = await api.projects();
  const sel = $('projectSelect');
  sel.replaceChildren(...list.map((p) => new Option(p.name, p.id)));
  if (selectId) sel.value = selectId;
  return list;
}

async function openProject(id) {
  projectId = id;
  history.replaceState(null, '', `?project=${id}`);
  $('projectSelect').value = id;
  link.setProject(id);
  await reloadProject();
}

async function reloadProject() {
  const full = await api.project(projectId);
  project = full.project;
  analysis = full.analysis;
  plan = full.plan;
  if (full.state) {
    state = full.state;
    engine.setState(state);
  }
  engine.setAnalysis(analysis);
  engine.setPlan(plan);
  timeline.setData(analysis, plan);
  planPanel.setData(plan, analysis);
  renderPads();
  syncControls();
  $('dropZone').classList.toggle('hidden', !!project?.audio);
  $('replaceAudioBtn').classList.toggle('hidden', !project?.audio);
  if (plan?.prompt && !$('promptInput').value) $('promptInput').value = plan.prompt;
  const url = project?.audio ? `/media/${projectId}/audio?v=${project.updatedAt}` : null;
  if (url !== player.url) {
    if (url) {
      const before = project.audio.originalName;
      player.load(url).then(() => player.sync(state, link)).catch((err) => setStatus(`Audio: ${err.message}`, 'error'));
      document.title = `${project.name} · Stagegen Studio`;
      if (before) $('timeLabel').title = decodeURIComponent(before);
    } else {
      player.load(null);
    }
  }
}

// ---------------------------------------------------------------- upload
async function upload(file) {
  if (!file || !projectId) return;
  const prog = $('uploadProgress');
  const bar = prog.querySelector('.bar');
  const label = prog.querySelector('span');
  prog.classList.remove('hidden');
  try {
    await api.uploadAudio(projectId, file, (f) => {
      bar.style.width = `${(f * 100).toFixed(0)}%`;
      label.textContent = f < 1 ? `Uploading ${file.name}… ${(f * 100).toFixed(0)}%` : 'Analyzing tempo, beats and sections…';
    });
    await reloadProject();
    setStatus(`Analyzed “${file.name}”: ${analysis.bpm} BPM, ${analysis.key} ${analysis.mode}, ${analysis.sections.length} sections. Now describe the visuals below.`);
    $('promptInput').focus();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    prog.classList.add('hidden');
    bar.style.width = '0';
  }
}

$('browseBtn').addEventListener('click', () => $('fileInput').click());
$('replaceAudioBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  upload(e.target.files[0]);
  e.target.value = '';
});
const wrap = $('timelineWrap');
wrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  $('dropZone').classList.remove('hidden');
  $('dropZone').classList.add('drag');
});
wrap.addEventListener('dragleave', (e) => {
  if (wrap.contains(e.relatedTarget)) return;
  $('dropZone').classList.remove('drag');
  $('dropZone').classList.toggle('hidden', !!project?.audio);
});
wrap.addEventListener('drop', (e) => {
  e.preventDefault();
  $('dropZone').classList.remove('drag');
  upload(e.dataTransfer.files[0]);
});

// ---------------------------------------------------------------- transport & cues
async function unlockAudio() {
  try {
    await player.resume();
  } catch { /* ignore */ }
}
document.addEventListener('pointerdown', unlockAudio, { once: true });

function togglePlay() {
  if (!analysis) return;
  unlockAudio();
  if (state?.playing) link.cue('pause');
  else {
    let pos = currentPos();
    if (pos >= analysis.duration - 0.05) pos = 0;
    link.cue('play', { position: pos });
  }
}

function seek(t) {
  if (state?.mode === 'live') return;
  link.cue('seek', { position: Math.max(0, t) });
}

function cueSection(i) {
  if (!analysis) return;
  const n = analysis.sections.length;
  i = Math.max(0, Math.min(n - 1, i));
  if (state?.mode === 'live') link.cue('section', { index: i });
  else seek(analysis.sections[i].start);
}

$('playBtn').addEventListener('click', togglePlay);
$('stopBtn').addEventListener('click', () => link.cue('stop'));
$('prevSectionBtn').addEventListener('click', () => cueSection(currentSectionIndex() - 1));
$('nextSectionBtn').addEventListener('click', () => cueSection(currentSectionIndex() + 1));

$('modeSeg').addEventListener('click', (e) => {
  const mode = e.target.dataset?.mode;
  if (!mode || mode === state?.mode) return;
  if (mode === 'live' && state?.playing) link.cue('pause');
  link.cue('mode', { mode });
  if (mode === 'live') link.cue('section', { index: currentSectionIndex() });
});

$('intensity').addEventListener('input', (e) => link.cue('set', { intensity: +e.target.value }));
$('blackoutBtn').addEventListener('click', () => link.cue('set', { blackout: !state?.blackout }));
$('showAudioChk').addEventListener('change', (e) => link.cue('set', { showAudio: e.target.checked }));
$('offsetInput').addEventListener('change', (e) => link.cue('set', { visualOffsetMs: +e.target.value || 0 }));
$('monitorChk').addEventListener('change', (e) => {
  player.enabled = e.target.checked;
  player.sync(state, link);
});

// Tap tempo
let taps = [];
function tap() {
  const now = link.serverNow();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 8) taps.shift();
  if (taps.length >= 3) {
    const intervals = taps.slice(1).map((t, i) => t - taps[i]);
    const bpm = 60000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length);
    $('bpmInput').value = bpm.toFixed(1);
    link.cue('tempo', { bpm, beatAt: now });
  }
}
$('tapBtn').addEventListener('click', tap);
$('bpmInput').addEventListener('change', (e) => link.cue('tempo', { bpm: +e.target.value || 0 }));

// Live input
async function refreshInputs() {
  const sel = $('inputSelect');
  if (!LiveInput.supported()) {
    sel.replaceChildren(new Option('Audio input needs http://localhost', ''));
    sel.disabled = true;
    $('inputBtn').disabled = true;
    return;
  }
  const devs = await liveInput.devices();
  const prev = sel.value;
  sel.replaceChildren(new Option('Default input', ''), ...devs.filter((d) => d.deviceId !== 'default').map((d, i) => new Option(d.label || `Input ${i + 1}`, d.deviceId)));
  sel.value = prev;
}
$('inputBtn').addEventListener('click', async () => {
  if (liveInput.active) {
    liveInput.stop();
    $('inputBtn').textContent = 'Enable input';
    $('inputBtn').classList.remove('on');
    return;
  }
  try {
    await liveInput.start($('inputSelect').value || undefined);
    $('inputBtn').textContent = 'Input on';
    $('inputBtn').classList.add('on');
    refreshInputs(); // labels become available after permission
  } catch (err) {
    setStatus(`Live input: ${err.message}`, 'error');
  }
});

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (state?.mode !== 'live') togglePlay();
  } else if (e.key === 'ArrowRight') cueSection(currentSectionIndex() + 1);
  else if (e.key === 'ArrowLeft') cueSection(currentSectionIndex() - 1);
  else if (e.key === 'b' || e.key === 'B') link.cue('set', { blackout: !state?.blackout });
  else if (e.key === 't' || e.key === 'T') tap();
  else if (/^[1-9]$/.test(e.key)) cueSection(+e.key - 1);
});

// ---------------------------------------------------------------- UI sync
function syncControls() {
  const s = state;
  if (!s) return;
  const live = s.mode === 'live';
  $('modeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.mode));
  $('trackControls').classList.toggle('hidden', live);
  $('liveControls').classList.toggle('hidden', !live);
  $('playBtn').textContent = s.playing ? '❚❚' : '▶';
  $('blackoutBtn').classList.toggle('on', !!s.blackout);
  $('showAudioChk').checked = !!s.showAudio;
  if (document.activeElement !== $('intensity')) $('intensity').value = s.intensity;
  if (document.activeElement !== $('offsetInput')) $('offsetInput').value = s.visualOffsetMs;
  if (document.activeElement !== $('bpmInput')) $('bpmInput').value = s.bpm ? (+s.bpm).toFixed(1) : '';
  $('previewBadge').textContent = live ? 'LIVE' : 'PREVIEW';
  $('previewBadge').classList.toggle('live', live);
  if (live) refreshInputs();
}

let padsCurrent = -1;
function renderPads() {
  const root = $('sectionPads');
  root.replaceChildren();
  padsCurrent = -1;
  if (!analysis) return;
  analysis.sections.forEach((s, i) => {
    const title = engine.plan?.sections?.[i]?.title ?? s.name;
    const btn = document.createElement('button');
    btn.className = 'pad';
    btn.title = `${title} · ${fmtTime(s.start)}–${fmtTime(s.end)}`;
    btn.innerHTML = `<span class="t"></span><span class="s">${fmtTime(s.start)} · ${s.name}</span><span class="sw"></span>${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}`;
    btn.querySelector('.t').textContent = `${i + 1}. ${title}`;
    btn.querySelector('.sw').style.background = sectionColor(engine.plan, i);
    btn.addEventListener('click', () => cueSection(i));
    root.append(btn);
  });
}

function updatePads(cur) {
  if (cur === padsCurrent) return;
  padsCurrent = cur;
  const live = state?.mode === 'live';
  $('sectionPads').querySelectorAll('.pad').forEach((p, i) => {
    p.classList.toggle('current', i === cur);
    p.classList.toggle('live', live);
  });
  planPanel.setCurrent(cur);
}

// ---------------------------------------------------------------- prompt bar
async function loadModels(provider) {
  const input = $('modelInput');
  const saved = settings?.models?.[provider];
  input.value = saved || '';
  try {
    const { models, default: def } = await api.models(provider);
    $('modelList').replaceChildren(...models.map((m) => new Option(m.name, m.id)));
    if (!input.value) input.value = def ?? '';
  } catch (err) {
    setStatus(`Model list: ${err.message}`, 'error');
  }
}

$('providerSelect').addEventListener('change', (e) => loadModels(e.target.value));
$('modelInput').addEventListener('change', async (e) => {
  const provider = $('providerSelect').value;
  settings = await api.saveSettings({ models: { [provider]: e.target.value.trim() } });
});

$('refineBtn').addEventListener('click', refine);
$('promptInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) refine();
});

async function refine() {
  const prompt = $('promptInput').value.trim();
  if (!analysis) return setStatus('Upload a track first, so the prompt can be fitted to it.', 'error');
  if (!prompt) return setStatus('Describe the visuals you want first.', 'error');
  const provider = $('providerSelect').value;
  const model = $('modelInput').value.trim();
  const btn = $('refineBtn');
  btn.disabled = true;
  const t0 = performance.now();
  const tick = setInterval(() => setStatus(`Refining with ${model || provider} for ${analysis.sections.length} sections… ${((performance.now() - t0) / 1000).toFixed(0)}s`, 'busy'), 500);
  try {
    const result = await api.refine(projectId, { prompt, provider, model, revise: $('reviseChk').checked && !!plan });
    plan = result;
    engine.setPlan(plan);
    timeline.setData(analysis, plan);
    planPanel.setData(plan, analysis);
    renderPads();
    $('reviseChk').checked = true;
    clearInterval(tick);
    setStatus(`“${plan.title}”: plan ready in ${((performance.now() - t0) / 1000).toFixed(0)}s and sent to the show outputs. Edit it on the right, or refine further.`);
  } catch (err) {
    clearInterval(tick);
    setStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- dialogs
$('settingsBtn').addEventListener('click', async () => {
  settings = await api.settings();
  const form = $('settingsForm');
  form.provider.value = settings.provider;
  for (const k of ['openrouter', 'anthropic', 'kie']) {
    const key = settings.keys[k];
    form[k].value = '';
    form[k].dataset.placeholder ??= form[k].placeholder;
    form[k].placeholder = key.set
      ? `saved (${key.hint})${key.source === 'env' ? ' · from environment' : ''}. Type to replace`
      : form[k].dataset.placeholder;
  }
  $('settingsDialog').showModal();
});

$('settingsDialog').addEventListener('close', async () => {
  if ($('settingsDialog').returnValue !== 'save') return;
  const form = $('settingsForm');
  const keys = {};
  for (const k of ['openrouter', 'anthropic', 'kie']) if (form[k].value.trim()) keys[k] = form[k].value.trim();
  settings = await api.saveSettings({ provider: form.provider.value, keys });
  $('providerSelect').value = settings.provider;
  loadModels(settings.provider);
  setStatus('Settings saved.');
});

$('showOutputBtn').addEventListener('click', async () => {
  info = await api.info().catch(() => info);
  const port = location.port || info?.port || 8080;
  const hosts = [...(info?.lan ?? []).map((ip) => ({ host: ip, badge: 'LAN' })), { host: 'localhost', badge: 'this PC' }];
  $('outputUrls').replaceChildren(
    ...hosts.map(({ host, badge }) => {
      const url = `http://${host}:${port}/show/${projectId}`;
      const row = document.createElement('div');
      row.className = 'url-row';
      row.innerHTML = `<span class="badge"></span><code></code><button type="button" class="ghost small">Copy</button><a class="small" target="_blank" rel="noopener">Open</a>`;
      row.querySelector('.badge').textContent = badge;
      row.querySelector('code').textContent = url;
      row.querySelector('a').href = url;
      row.querySelector('button').addEventListener('click', () => navigator.clipboard?.writeText(url));
      return row;
    }),
  );
  $('outputDialog').showModal();
});

$('projectSelect').addEventListener('change', (e) => openProject(e.target.value));
$('newProjectBtn').addEventListener('click', async () => {
  const name = prompt('Name for the new show / track:', 'New show');
  if (name === null) return;
  const p = await api.createProject(name);
  await refreshProjectList(p.id);
  await openProject(p.id);
});
$('renameProjectBtn').addEventListener('click', async () => {
  const name = prompt('Rename project:', project?.name ?? '');
  if (!name) return;
  await api.renameProject(projectId, name);
  await refreshProjectList(projectId);
  project.name = name;
});
$('deleteProjectBtn').addEventListener('click', async () => {
  if (!confirm(`Delete “${project?.name}” and its audio/plan? This can't be undone.`)) return;
  await api.deleteProject(projectId);
  const list = await refreshProjectList();
  if (list.length) await openProject(list[0].id);
  else {
    const p = await api.createProject('My first show');
    await refreshProjectList(p.id);
    await openProject(p.id);
  }
});

// ---------------------------------------------------------------- frame loop
let last = performance.now();
let liveAccum = 0;
let pendingBeat = false;
function frame(t) {
  const dt = t - last;
  last = t;
  const now = link.serverNow();

  // Live input: analyze locally and relay to the show outputs (~30 Hz).
  const reading = liveInput.read();
  if (reading) {
    pendingBeat ||= reading.beat;
    engine.pushLive({ b: reading.b, k: reading.beat ? 1 : 0 }, now);
    $('meters').querySelectorAll('i').forEach((m, i) => m.style.setProperty('--v', `${(reading.b[i] * 100).toFixed(0)}%`));
    liveAccum += dt;
    if (liveAccum >= 33 && state?.mode === 'live') {
      link.send({ t: 'live', project: projectId, b: reading.b.map((v) => +v.toFixed(3)), k: pendingBeat ? 1 : 0 });
      liveAccum = 0;
      pendingBeat = false;
    }
  }

  const u = engine.compute(now, dt);
  renderer.render(u, dt);

  const pos = currentPos();
  if (analysis) {
    const cur = currentSectionIndex();
    timeline.draw(pos, { mode: state?.mode, currentSection: cur });
    updatePads(cur);
    if (state?.mode !== 'live') $('timeLabel').textContent = `${fmtTime(Math.min(pos, analysis.duration), true)} / ${fmtTime(analysis.duration)}`;
    // Auto-stop at the end of the track.
    if (state?.playing && state.mode === 'track' && pos > analysis.duration + 0.3) link.cue('pause');
  } else {
    timeline.draw(0);
  }
  if (state) player.sync(state, link);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
async function boot() {
  link.connect();
  const [inf, s] = await Promise.all([api.info().catch(() => null), api.settings()]);
  info = inf;
  settings = s;
  const gw = $('chipGateway');
  gw.className = `chip ${info?.gateway?.ok ? 'ok' : 'warn'}`;
  gw.title = info?.gateway?.ok ? 'AI gateway running' : 'AI gateway not reachable. Prompt refinement unavailable';
  $('providerSelect').value = settings.provider;
  loadModels(settings.provider);
  if (!settings.keys.openrouter.set && !settings.keys.anthropic.set) setStatus('Add an OpenRouter or Anthropic API key in Settings (⚙) to enable prompt refinement.');

  let list = await refreshProjectList();
  if (!list.length) {
    await api.createProject('My first show');
    list = await refreshProjectList();
  }
  const wanted = new URLSearchParams(location.search).get('project');
  await openProject(list.find((p) => p.id === wanted)?.id ?? list[0].id);
  requestAnimationFrame(frame);
}

// Debug/test handle (also handy from the browser console).
window.__stagegen = { link, engine, player, get state() { return state; } };

boot().catch((err) => setStatus(`Startup failed: ${err.message}. Is stagegen-core running?`, 'error'));
