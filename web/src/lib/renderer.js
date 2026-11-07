// Three.js renderer for the stage visuals. Resolution-independent: it renders at an internal
// resolution (capped + adaptively scaled to keep frame rate) and the canvas is CSS-scaled
// to whatever screen it is on. Additional layers (AI assets, camera paths) attach to `scene`.
import * as THREE from 'three';
import { fragmentShader, vertexShader } from './shaders.js';

export class StageRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ maxPixels?: number, res?: {w:number,h:number}|null, scale?: number|'auto' }} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.maxPixels = opts.maxPixels ?? 1920 * 1080;
    this.forcedRes = opts.res ?? null;
    this.fixedScale = typeof opts.scale === 'number' ? opts.scale : null;
    this.dynScale = 1;
    this.frameTimes = [];
    this.lastAdapt = performance.now();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const vec3s = () => Array.from({ length: 5 }, () => new THREE.Vector3());
    this.uniforms = {
      uRes: { value: new THREE.Vector2(1, 1) },
      uFlow: { value: 0 },
      uTime: { value: 0 },
      uPalA: { value: vec3s() },
      uPalB: { value: vec3s() },
      uMix: { value: 0 },
      uBands: { value: new THREE.Vector4() },
      uBeat: { value: new THREE.Vector3() },
      uLook: { value: new THREE.Vector3() },
      uFx1: { value: new THREE.Vector4() },
      uFx2: { value: new THREE.Vector4() },
      uOut: { value: new THREE.Vector2(1, 0) },
    };
    const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    this.scene.add(quad);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  get scale() {
    return this.fixedScale ?? this.dynScale;
  }

  resize() {
    let w, h;
    if (this.forcedRes) {
      w = this.forcedRes.w;
      h = this.forcedRes.h;
    } else {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, this.canvas.clientWidth * dpr);
      h = Math.max(1, this.canvas.clientHeight * dpr);
    }
    const cap = Math.min(1, Math.sqrt(this.maxPixels / (w * h)));
    // Explicit ?scale wins; a forced output resolution renders at full size (adapting down if slow);
    // otherwise cap the internal resolution (soft gradients upscale invisibly) and adapt.
    const s = this.fixedScale ?? (this.forcedRes ? this.dynScale : cap * this.dynScale);
    const iw = Math.max(1, Math.round(w * s));
    const ih = Math.max(1, Math.round(h * s));
    if (iw !== this.width || ih !== this.height) {
      this.width = iw;
      this.height = ih;
      this.renderer.setSize(iw, ih, false);
      this.uniforms.uRes.value.set(iw, ih);
    }
  }

  // Lowers internal resolution when frames are slow, raises it again when there is headroom.
  adapt(dt) {
    if (this.fixedScale !== null) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    const now = performance.now();
    if (now - this.lastAdapt < 2000 || this.frameTimes.length < 60) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    let next = this.dynScale;
    if (avg > 22) next = Math.max(0.35, this.dynScale * 0.85);
    else if (avg < 17.5 && this.dynScale < 1) next = Math.min(1, this.dynScale * 1.08);
    if (next !== this.dynScale) {
      this.dynScale = next;
      this.frameTimes = [];
      this.resize();
    }
    this.lastAdapt = now;
  }

  render(u, dtMs) {
    const U = this.uniforms;
    U.uFlow.value = u.flow;
    U.uTime.value = u.time;
    for (let i = 0; i < 5; i++) {
      U.uPalA.value[i].set(...u.palA[i]);
      U.uPalB.value[i].set(...u.palB[i]);
    }
    U.uMix.value = u.mix;
    U.uBands.value.set(u.low, u.mid, u.high, u.level);
    U.uBeat.value.set(u.beat, u.down, u.onset);
    U.uLook.value.set(u.speed, u.turbulence, u.energy);
    U.uFx1.value.set(u.fx.grain, u.fx.strobe, u.fx.scanlines, u.fx.chromatic);
    U.uFx2.value.set(u.fx.particles, u.fx.haze, u.fx.bloom, 0);
    U.uOut.value.set(u.intensity, u.blackout);
    this.renderer.render(this.scene, this.camera);
    if (dtMs) this.adapt(dtMs);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}
