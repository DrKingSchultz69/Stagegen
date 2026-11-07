// Computes the visual parameters for a moment in the show from the analysis, the plan,
// the shared show state and (in live mode) the live-input levels. Used identically by the
// studio preview and the show output, so both render the same thing.
import { paletteRgb, DEFAULT_PALETTE } from './palette.js';
import { trackPosition } from './sync.js';

const FX_KEYS = ['grain', 'strobe', 'scanlines', 'chromatic', 'particles', 'haze', 'bloom'];
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);

// Last index i with arr[i] <= x, or -1.
function lastLE(arr, x) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export class VisualEngine {
  constructor() {
    this.analysis = null;
    this.plan = null;
    this.state = null;
    this.live = { b: [0, 0, 0, 0], at: -Infinity, beatAt: -Infinity };
    this.flow = 0;
    this.time = 0;
    this.sm = { low: 0, mid: 0, high: 0, level: 0, onset: 0 };
  }

  setAnalysis(a) {
    this.analysis = a && a.sections ? a : null;
    this.downSet = new Set((this.analysis?.downbeats ?? []).map((t) => Math.round(t * 1000)));
  }
  setPlan(p) { this.plan = p && p.sections ? p : null; }
  setState(s) { this.state = s; }

  pushLive(msg, serverNow) {
    if (Array.isArray(msg.b)) this.live.b = msg.b;
    this.live.at = serverNow;
    if (msg.k) this.live.beatAt = serverNow;
  }

  get sections() {
    return this.analysis?.sections ?? [];
  }

  sectionLook(i) {
    const sec = this.sections[i];
    const ps = this.plan?.sections?.find((s) => s.id === sec?.id) ?? this.plan?.sections?.[i];
    const energy = sec?.energy ?? 0.6;
    const fxList = ps?.fx ?? [];
    const fx = {};
    for (const k of FX_KEYS) fx[k] = fxList.includes(k) ? 1 : 0;
    fx.grain = Math.max(fx.grain, 0.45);
    return {
      palette: paletteRgb(ps?.palette ?? this.plan?.palette ?? DEFAULT_PALETTE),
      speed: ps?.speed ?? 0.2 + 0.6 * energy,
      turbulence: ps?.turbulence ?? 0.3 + 0.5 * energy,
      energy,
      fx,
    };
  }

  sectionAt(pos) {
    const secs = this.sections;
    for (let i = secs.length - 1; i >= 0; i--) if (pos >= secs[i].start) return i;
    return 0;
  }

  /** Visual position in the track (seconds), including the latency offset. */
  position(serverNow) {
    const s = this.state;
    if (!s) return 0;
    return trackPosition(s, serverNow) - (s.visualOffsetMs ?? 0) / 1000;
  }

  compute(serverNow, dtMs) {
    const dt = Math.min(0.1, Math.max(0, dtMs / 1000));
    this.time += dt;
    const s = this.state ?? { mode: 'track', playing: false, intensity: 1, blackout: false };
    const a = this.analysis;
    const secCount = this.sections.length;
    const beatPeriod = a?.bpm ? 60 / a.bpm : 0.5;

    let raw = { low: 0, mid: 0, high: 0, level: 0, onset: 0 };
    let beat = 0, down = 0, idx = 0, prevIdx = 0, mix = 1, pos = 0;

    if (s.mode === 'live') {
      idx = Math.min(Math.max(0, s.liveSection ?? 0), Math.max(0, secCount - 1));
      prevIdx = Math.min(Math.max(0, s.livePrevSection ?? idx), Math.max(0, secCount - 1));
      mix = clamp01((serverNow - (s.liveSectionSince ?? 0)) / 1500);
      const fresh = serverNow - this.live.at < 600;
      if (fresh) {
        const [l, m, h, lv] = this.live.b;
        raw = { low: l, mid: m, high: h, level: lv, onset: 0 };
      } else {
        const breathe = 0.35 + 0.1 * Math.sin(this.time * 0.7);
        raw = { low: breathe, mid: breathe * 0.8, high: breathe * 0.5, level: breathe, onset: 0 };
      }
      const sinceLive = (serverNow - this.live.beatAt) / 1000;
      if (sinceLive < 2) beat = Math.exp(-sinceLive * 7);
      if (s.bpm > 0 && !(fresh && sinceLive < 2)) {
        const period = 60000 / s.bpm;
        const elapsed = serverNow - (s.beatAnchorMs ?? 0);
        const phase = ((elapsed % period) + period) % period;
        beat = Math.exp(-(phase / 1000) * 7);
        if (Math.round((elapsed - phase) / period) % 4 === 0) down = beat;
      }
    } else if (a) {
      pos = this.position(serverNow);
      const fps = a.frames.fps;
      const n = a.frames.low.length;
      const fi = Math.min(n - 1, Math.max(0, Math.floor(pos * fps)));
      const k = s.playing ? 1 : 0.35;
      raw = {
        low: (a.frames.low[fi] / 255) * k,
        mid: (a.frames.mid[fi] / 255) * k,
        high: (a.frames.high[fi] / 255) * k,
        level: (a.frames.rms[fi] / 255) * k,
        onset: (a.frames.onset[fi] / 255) * k,
      };
      idx = this.sectionAt(pos);
      prevIdx = Math.max(0, idx - 1);
      const start = this.sections[idx]?.start ?? 0;
      mix = idx === 0 ? 1 : clamp01((pos - start) / Math.min(2, 2 * beatPeriod));
      if (s.playing && a.beats?.length) {
        const bi = lastLE(a.beats, pos);
        if (bi >= 0) {
          const since = pos - a.beats[bi];
          beat = Math.exp(-since * 7);
          if (this.downSet.has(Math.round(a.beats[bi] * 1000))) down = beat;
        }
      }
    }

    // Attack/release smoothing so the visuals don't flicker.
    for (const key of Object.keys(raw)) {
      const v = raw[key];
      const rate = v > this.sm[key] ? 30 : 5;
      this.sm[key] = lerp(this.sm[key], v, 1 - Math.exp(-dt * rate));
    }

    const A = this.sectionLook(prevIdx);
    const B = this.sectionLook(idx);
    const m = smoothstep(mix);
    const speed = lerp(A.speed, B.speed, m);
    const turbulence = lerp(A.turbulence, B.turbulence, m);
    const energy = lerp(A.energy, B.energy, m);
    const fx = {};
    for (const key of FX_KEYS) fx[key] = lerp(A.fx[key], B.fx[key], m);

    this.flow += dt * (0.06 + 0.45 * speed) * (0.7 + 0.6 * this.sm.level);

    return {
      flow: this.flow,
      time: this.time,
      palA: A.palette,
      palB: B.palette,
      mix: m,
      low: this.sm.low,
      mid: this.sm.mid,
      high: this.sm.high,
      level: this.sm.level,
      onset: this.sm.onset,
      beat,
      down,
      speed,
      turbulence,
      energy,
      fx,
      intensity: s.intensity ?? 1,
      blackout: s.blackout ? 1 : 0,
      // info for HUDs
      pos,
      section: idx,
      mode: s.mode,
    };
  }
}
