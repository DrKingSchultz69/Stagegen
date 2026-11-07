// Web Audio track player that follows the shared show clock. It schedules playback so the
// audio is *heard* at the same server time the visuals show that position (output latency
// compensated), and re-syncs if the audio clock drifts away from the server clock.
import { trackPosition } from './sync.js';

export class TrackPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.src = null;
    this.enabled = true;
    this.startCtx = 0;
    this.startPos = 0;
    this.rev = -1;
    this.url = null;
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  resume() {
    return this.ensureContext().resume();
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  async load(url) {
    this.stop();
    this.buffer = null;
    this.url = url;
    if (!url) return;
    const ctx = this.ensureContext();
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not load audio (${res.status})`);
    const data = await res.arrayBuffer();
    if (this.url !== url) return; // superseded
    this.buffer = await ctx.decodeAudioData(data);
  }

  latency() {
    return (this.ctx?.outputLatency || 0) + (this.ctx?.baseLatency || 0);
  }

  stop() {
    if (this.src) {
      try { this.src.stop(); } catch { /* already stopped */ }
      this.src.disconnect();
      this.src = null;
    }
  }

  setVolume(v) {
    this.ensureContext();
    this.gain.gain.value = v;
  }

  /** Call every frame and on every state change. */
  sync(state, link) {
    const shouldPlay = this.enabled && this.buffer && state?.mode === 'track' && state.playing && this.ctx?.state === 'running';
    if (!shouldPlay) {
      this.stop();
      return;
    }
    const now = link.serverNow();
    const expected = trackPosition(state, now);
    if (expected >= this.buffer.duration) {
      this.stop();
      return;
    }
    if (this.src && this.rev === state.rev) {
      const heard = this.startPos + (this.ctx.currentTime - this.startCtx - this.latency());
      if (Math.abs(heard - expected) < 0.04 || this.ctx.currentTime < this.startCtx) return;
    }
    this.start(state, now);
  }

  start(state, serverNow) {
    this.stop();
    const ctx = this.ctx;
    const lat = this.latency();
    let pos = state.anchorPos;
    let when = ctx.currentTime + (state.anchorServerMs - serverNow) / 1000 - lat;
    if (when < ctx.currentTime) {
      pos += ctx.currentTime - when;
      when = ctx.currentTime;
    }
    if (pos >= this.buffer.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.start(when, Math.max(0, pos));
    this.src = src;
    this.startCtx = when;
    this.startPos = pos;
    this.rev = state.rev;
  }
}
