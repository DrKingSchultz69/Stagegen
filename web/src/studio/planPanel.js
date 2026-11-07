// Right-hand panel: the LLM's visual plan, editable (palettes, prompts, camera, look).
import { fmtTime, sectionColor } from './timeline.js';

const CAMERA_MOVES = ['static', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'orbit', 'drift', 'dolly-through', 'rise', 'fall'];
const FX = ['grain', 'bloom', 'strobe', 'particles', 'chromatic', 'scanlines', 'haze'];

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export class PlanPanel {
  constructor(root, { onSave, onPreview }) {
    this.root = root;
    this.onSave = onSave;
    this.onPreview = onPreview; // live-preview edits before saving
    this.plan = null;
    this.saved = null;
    this.analysis = null;
    this.current = -1;
  }

  setData(plan, analysis) {
    this.saved = plan ? structuredClone(plan) : null;
    this.plan = plan ? structuredClone(plan) : null;
    this.analysis = analysis;
    this.render();
  }

  get dirty() {
    return JSON.stringify(this.plan) !== JSON.stringify(this.saved);
  }

  changed() {
    this.onPreview?.(this.plan);
    this.actions?.classList.toggle('hidden', !this.dirty);
  }

  setCurrent(i) {
    if (i === this.current) return;
    this.current = i;
    this.root.querySelectorAll('.sec-card').forEach((c, k) => c.classList.toggle('current', k === i));
  }

  render() {
    const { plan, analysis } = this;
    this.root.replaceChildren();
    if (!analysis) {
      this.root.append(el('div', { class: 'plan-empty' }, el('b', {}, 'No track yet.'), el('br'), 'Drop an audio file on the timeline below. It gets analyzed for tempo, beats and sections.'));
      return;
    }
    if (!plan) {
      const a = analysis;
      this.root.append(
        el('div', { class: 'plan-empty' },
          el('b', {}, 'Track analyzed'), el('br'),
          `${a.bpm || '?'} BPM · ${a.key} ${a.mode} · ${a.sections.length} sections · ${fmtTime(a.duration)}`, el('br'), el('br'),
          'Describe the visual world in the prompt bar below. The AI turns it into a palette, look and generation prompts for every section of this track.'),
      );
      return;
    }

    const head = el('div', { class: 'plan-head' },
      el('h2', {}, plan.title),
      el('p', { class: 'concept' }, plan.concept),
      el('div', { class: 'plan-meta' },
        el('span', { class: 'tag' }, `${analysis.bpm || '?'} BPM`),
        el('span', { class: 'tag' }, `${analysis.key} ${analysis.mode}`),
        el('span', { class: 'tag' }, plan.model ?? plan.provider ?? 'llm')),
      el('span', { class: 'label' }, 'Show palette'),
      this.swatches(plan.palette, (p) => { plan.palette = p; this.changed(); }),
      el('span', { class: 'label' }, 'Global style'),
      el('textarea', { rows: 2, value: plan.global_style, oninput: (e) => { plan.global_style = e.target.value; this.changed(); } }),
      el('span', { class: 'label' }, 'Avoid (negative prompt)'),
      el('textarea', { rows: 2, value: plan.negative_prompt, oninput: (e) => { plan.negative_prompt = e.target.value; this.changed(); } }),
    );
    this.root.append(head);

    plan.sections.forEach((s, i) => this.root.append(this.sectionCard(s, i)));

    this.actions = el('div', { class: 'plan-actions hidden' },
      el('button', { class: 'ghost', onclick: () => { this.plan = structuredClone(this.saved); this.render(); this.changed(); } }, 'Discard'),
      el('button', { class: 'primary', onclick: () => this.onSave?.(this.plan) }, 'Save changes'));
    this.root.append(this.actions);
    this.current = -1;
  }

  swatches(palette, onChange) {
    const p = [...palette];
    return el('div', { class: 'swatches' },
      p.map((c, k) => el('input', { type: 'color', value: c, title: c, oninput: (e) => { p[k] = e.target.value; onChange([...p]); } })));
  }

  sectionCard(s, i) {
    const a = this.analysis.sections[i];
    const update = () => this.changed();
    const range = (key, label) => el('label', { class: 'inline', title: label },
      label, el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: s[key], oninput: (e) => { s[key] = +e.target.value; update(); } }));
    const copyBtn = (key) => el('button', { class: 'ghost small copy-btn', type: 'button', onclick: (e) => { e.preventDefault(); navigator.clipboard?.writeText(s[key]); } }, 'Copy');

    return el('details', { class: 'sec-card', open: i === 0 },
      el('summary', {},
        el('span', { class: 'sec-title' }, `${i + 1}. ${s.title}`),
        el('span', { class: 'tag' }, a?.name ?? s.name),
        el('span', { class: 'sec-sub' }, `${fmtTime(s.start)}–${fmtTime(s.end)} · energy ${Math.round((s.energy ?? 0) * 100)}% · ${s.mood}`)),
      el('div', { class: 'sec-bar', style: `background:linear-gradient(90deg, ${s.palette.join(',')})` }),
      el('div', { class: 'sec-body' },
        el('span', { class: 'label' }, 'Palette'),
        this.swatches(s.palette, (p) => { s.palette = p; update(); }),
        el('span', { class: 'label' }, 'Image prompt', copyBtn('image_prompt')),
        el('textarea', { rows: 3, value: s.image_prompt, oninput: (e) => { s.image_prompt = e.target.value; update(); } }),
        el('span', { class: 'label' }, 'Video prompt', copyBtn('video_prompt')),
        el('textarea', { rows: 3, value: s.video_prompt, oninput: (e) => { s.video_prompt = e.target.value; update(); } }),
        el('span', { class: 'label' }, 'Camera'),
        el('div', { class: 'sec-row' },
          el('select', { onchange: (e) => { s.camera.move = e.target.value; update(); } },
            CAMERA_MOVES.map((m) => el('option', { value: m, selected: m === s.camera.move }, m))),
          el('span', { class: 'muted small' }, `${s.camera.from || '…'} → ${s.camera.to || '…'}`)),
        el('span', { class: 'label' }, 'Background look'),
        el('div', { class: 'sec-row' }, range('speed', 'Speed'), range('turbulence', 'Turbulence')),
        el('div', { class: 'sec-row', style: 'margin-top:6px' },
          FX.map((f) => el('label', { class: 'inline toggle small' },
            el('input', { type: 'checkbox', checked: s.fx.includes(f), onchange: (e) => {
              s.fx = e.target.checked ? [...new Set([...s.fx, f])] : s.fx.filter((x) => x !== f);
              update();
            } }), f))),
      ),
    );
  }
}

export { sectionColor };
