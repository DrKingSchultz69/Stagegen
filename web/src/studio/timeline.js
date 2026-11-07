// Waveform timeline: sections, beats/bars, playhead. Click or drag to seek.
const FALLBACK = ['#5b2a86', '#d9488f', '#2f6fdb', '#1fa38a', '#e0a030', '#b04ad9'];

export function sectionColor(plan, i) {
  const p = plan?.sections?.[i]?.palette;
  return p?.[3] ?? FALLBACK[i % FALLBACK.length];
}

export function fmtTime(s, tenths = false) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${tenths ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0')}`;
}

export class Timeline {
  constructor(canvas, { onSeek } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.analysis = null;
    this.plan = null;
    this.dragging = false;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const seekFromEvent = (e) => {
      if (!this.analysis) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.onSeek?.(x * this.analysis.duration);
    };
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });
    canvas.addEventListener('pointermove', (e) => this.dragging && seekFromEvent(e));
    canvas.addEventListener('pointerup', () => (this.dragging = false));
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(this.w * dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setData(analysis, plan) {
    this.analysis = analysis?.sections ? analysis : null;
    this.plan = plan;
  }

  draw(pos, { mode = 'track', currentSection = 0 } = {}) {
    const { ctx, w, h, analysis: a } = this;
    ctx.clearRect(0, 0, w, h);
    if (!a) return;
    const pad = 16;
    const W = w - pad * 2;
    const x = (t) => pad + (t / a.duration) * W;
    const top = 22, bottom = h - 14, mid = (top + bottom) / 2, amp = (bottom - top) / 2;

    // Sections
    a.sections.forEach((s, i) => {
      const x0 = x(s.start), x1 = x(s.end);
      const col = sectionColor(this.plan, i);
      const isCur = i === currentSection;
      ctx.fillStyle = col + (isCur ? '38' : '1c');
      ctx.fillRect(x0, top, x1 - x0, bottom - top);
      ctx.fillStyle = col;
      ctx.fillRect(x0, top - 3, x1 - x0 - 1, 3);
      ctx.fillStyle = isCur ? '#fff' : '#a9a9b8';
      ctx.font = `${isCur ? 600 : 500} 11px Inter, Segoe UI, sans-serif`;
      const title = this.plan?.sections?.[i]?.title ?? s.name;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0 - 4, top);
      ctx.clip();
      ctx.fillText(`${i + 1}. ${title}`, x0 + 4, top - 8);
      ctx.restore();
    });

    // Waveform
    const peaks = a.peaks ?? [];
    ctx.fillStyle = '#c9c9da';
    const n = peaks.length;
    const step = W / n;
    for (let i = 0; i < n; i++) {
      const v = peaks[i] * amp * 0.92;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(pad + i * step, mid - v, Math.max(1, step - 0.4), v * 2);
    }
    ctx.globalAlpha = 1;

    // Beats (bars taller)
    const down = new Set((a.downbeats ?? []).map((t) => Math.round(t * 1000)));
    const pxPerBeat = a.bpm ? (W / a.duration) * (60 / a.bpm) : 0;
    if (pxPerBeat > 3) {
      for (const b of a.beats ?? []) {
        const isBar = down.has(Math.round(b * 1000));
        if (!isBar && pxPerBeat < 6) continue;
        ctx.fillStyle = isBar ? '#6f6f85' : '#3a3a4c';
        ctx.fillRect(x(b), bottom + 3, 1, isBar ? 8 : 4);
      }
    }

    // Playhead
    if (mode === 'track') {
      const px = x(Math.min(a.duration, Math.max(0, pos)));
      ctx.fillStyle = '#fff';
      ctx.fillRect(px - 1, top - 6, 2, bottom - top + 12);
      ctx.beginPath();
      ctx.moveTo(px - 5, top - 8);
      ctx.lineTo(px + 5, top - 8);
      ctx.lineTo(px, top - 2);
      ctx.fill();
    }
  }
}
