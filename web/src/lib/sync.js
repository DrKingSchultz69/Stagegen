// WebSocket link to stagegen-core: show state, cues, live relay and clock sync.
//
// The server is the master clock. We estimate offset = serverTime - performance.now()
// from ping/pong round trips (keeping the lowest-latency samples), so every client
// can compute the same track position for the same moment.

export class ShowLink {
  constructor({ role, project = '', onState, onReload, onPresence, onLive, onStatus } = {}) {
    this.role = role;
    this.project = project;
    this.handlers = { onState, onReload, onPresence, onLive, onStatus };
    this.offset = 0;
    this.rtt = Infinity;
    this.synced = false;
    this.connected = false;
    this.samples = [];
    this.ws = null;
    this.pingTimer = null;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.samples = [];
      this.hello();
      this.schedulePings();
      this.handlers.onStatus?.(this);
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = () => {
      this.connected = false;
      clearTimeout(this.pingTimer);
      this.handlers.onStatus?.(this);
      setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => ws.close();
  }

  setProject(project) {
    this.project = project;
    this.hello();
  }

  hello() {
    if (this.project) this.send({ t: 'hello', role: this.role, project: this.project });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  cue(cmd, extra = {}) {
    return this.send({ t: 'cue', project: this.project, cmd, ...extra });
  }

  serverNow() {
    return performance.now() + this.offset;
  }

  schedulePings() {
    let quick = 8;
    const tick = () => {
      if (!this.connected) return;
      this.send({ t: 'ping', c: performance.now() });
      this.pingTimer = setTimeout(tick, quick-- > 0 ? 150 : 2000);
    };
    tick();
  }

  onMessage(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    switch (m.t) {
      case 'pong': {
        const now = performance.now();
        const rtt = now - m.c;
        this.samples.push({ rtt, offset: m.s - (m.c + rtt / 2) });
        if (this.samples.length > 15) this.samples.shift();
        const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.offset = best.offset;
        this.rtt = best.rtt;
        this.synced = true;
        this.handlers.onStatus?.(this);
        break;
      }
      case 'state':
        if (m.project !== this.project) return;
        if (!this.synced && typeof m.now === 'number') this.offset = m.now - performance.now();
        this.handlers.onState?.(m.state);
        break;
      case 'reload':
        if (m.project === this.project) this.handlers.onReload?.(m.what);
        break;
      case 'presence':
        if (m.project === this.project) this.handlers.onPresence?.(m);
        break;
      case 'live':
        if (m.project === this.project) this.handlers.onLive?.(m);
        break;
    }
  }
}

// Track position (seconds) for a show state at a given server time.
export function trackPosition(state, serverNow) {
  if (!state) return 0;
  let pos = state.anchorPos;
  if (state.playing) pos += (serverNow - state.anchorServerMs) / 1000;
  return pos;
}
