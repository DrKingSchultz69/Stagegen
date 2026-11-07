// Live audio input analysis (mixer feed / mic) for Live mode. Produces normalized
// low/mid/high/level values and beat (kick) detections.
//
// Browsers only allow audio input on secure origins: run the studio at http://localhost
// on the server laptop (the default). LAN http:// pages can't open the microphone.

export class LiveInput {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.peaks = [1e-4, 1e-4, 1e-4, 1e-4];
    this.lowAvg = 0;
    this.lastBeat = 0;
    this.active = false;
  }

  static supported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  async devices() {
    if (!LiveInput.supported()) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((d) => d.kind === 'audioinput');
  }

  async start(deviceId) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    src.connect(this.analyser);
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.wave = new Float32Array(this.analyser.fftSize);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    this.bins = { low: [Math.round(20 / hz), Math.round(150 / hz)], mid: [Math.round(150 / hz), Math.round(2000 / hz)], high: [Math.round(2000 / hz), this.freq.length] };
    this.peaks = [1e-4, 1e-4, 1e-4, 1e-4];
    this.active = true;
  }

  stop() {
    this.active = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.stream = null;
    this.ctx = null;
  }

  /** @returns {{ b: number[], beat: boolean } | null} */
  read() {
    if (!this.active) return null;
    this.analyser.getFloatFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.wave);
    const band = ([a, b]) => {
      let p = 0;
      for (let i = Math.max(1, a); i < b; i++) p += Math.pow(10, this.freq[i] / 10);
      return Math.sqrt(p);
    };
    let sq = 0;
    for (const v of this.wave) sq += v * v;
    const raw = [band(this.bins.low), band(this.bins.mid), band(this.bins.high), Math.sqrt(sq / this.wave.length)];
    // Adaptive normalization: slowly decaying peak per band.
    const b = raw.map((v, i) => {
      this.peaks[i] = Math.max(v, this.peaks[i] * 0.9985, 1e-4);
      return Math.min(1, Math.pow(v / this.peaks[i], 0.8));
    });
    const now = performance.now();
    const flux = b[0] - this.lowAvg;
    this.lowAvg += (b[0] - this.lowAvg) * 0.12;
    const beat = flux > 0.22 && b[0] > 0.5 && now - this.lastBeat > 280;
    if (beat) this.lastBeat = now;
    return { b, beat };
  }
}
