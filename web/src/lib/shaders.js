// GLSL for the background layer: domain-warped fbm mapped through two 5-stop palettes
// (cross-faded between sections), driven by audio bands, beats and the section "look".
// Coordinates are normalized by the shorter screen side, so any aspect ratio works
// (16:9, 4:3, portrait, ultra-wide LED walls) without stretching.

export const vertexShader = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;

uniform vec2 uRes;
uniform float uFlow;     // accumulated flow phase (speed-dependent)
uniform float uTime;     // seconds, monotonic
uniform vec3 uPalA[5];
uniform vec3 uPalB[5];
uniform float uMix;      // 0 = palette A, 1 = palette B
uniform vec4 uBands;     // low, mid, high, level   (0..1)
uniform vec3 uBeat;      // beat pulse, downbeat pulse, onset
uniform vec3 uLook;      // speed, turbulence, section energy
uniform vec4 uFx1;       // grain, strobe, scanlines, chromatic
uniform vec4 uFx2;       // particles, haze, bloom, -
uniform vec2 uOut;       // intensity, blackout

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

vec3 palA(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  vec3 c = mix(uPalA[0], uPalA[1], smoothstep(0.0, 1.0, t));
  c = mix(c, uPalA[2], smoothstep(1.0, 2.0, t));
  c = mix(c, uPalA[3], smoothstep(2.0, 3.0, t));
  return mix(c, uPalA[4], smoothstep(3.0, 4.0, t));
}

vec3 palB(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  vec3 c = mix(uPalB[0], uPalB[1], smoothstep(0.0, 1.0, t));
  c = mix(c, uPalB[2], smoothstep(1.0, 2.0, t));
  c = mix(c, uPalB[3], smoothstep(2.0, 3.0, t));
  return mix(c, uPalB[4], smoothstep(3.0, 4.0, t));
}

vec3 pal(float t) { return mix(palA(t), palB(t), uMix); }

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  float low = uBands.x, mid = uBands.y, high = uBands.z, level = uBands.w;
  float beat = uBeat.x, down = uBeat.y;
  float turb = uLook.y, energy = uLook.z;
  float t = uFlow;

  // Beat "breath": a small zoom pulse.
  uv *= 1.0 - 0.03 * beat * (0.4 + energy) - 0.025 * down;

  vec2 p = uv * 1.25;
  vec2 q = vec2(fbm(p + vec2(0.0, 0.12 * t)), fbm(p + vec2(5.2, 1.3) - 0.1 * t));
  float w = 1.2 + 2.2 * turb + 1.2 * low;
  vec2 r = vec2(fbm(p + w * q + vec2(1.7, 9.2) + 0.15 * t),
                fbm(p + w * q + vec2(8.3, 2.8) - 0.126 * t));
  float f = fbm(p + (1.5 + 2.0 * turb) * r);

  float g = clamp(f * f * 1.6 + 0.35 * r.x * r.y + 0.15 * length(q) - 0.15, 0.0, 1.0);
  g = clamp(g + 0.16 * uv.y, 0.0, 1.0);                 // darker floor, lighter sky
  g = pow(g, 1.15);                                      // keep the top of the palette for highlights
  g = clamp(g * (0.86 + 0.1 * energy + 0.12 * level), 0.0, 1.0);

  float ca = 0.03 * uFx1.w * (0.4 + high);
  vec3 col = vec3(pal(g + ca).r, pal(g).g, pal(g - ca).b);

  // Highlights / bloom.
  float hl = smoothstep(0.55, 1.0, g);
  col += pal(1.0) * hl * (0.05 + 0.22 * uFx2.z) * (0.3 + 0.7 * mid);

  // Beat flash (+ optional strobe on downbeats).
  float flash = beat * (0.04 + 0.12 * energy) + down * 0.04 + uFx1.y * down * 0.3;
  col += pal(0.85) * flash;

  // Sparkle particles twinkling with the highs.
  if (uFx2.x > 0.01) {
    vec2 sp = uv * 38.0 + vec2(0.0, -uFlow * 0.6);
    vec2 cell = floor(sp);
    float h = hash12(cell);
    vec2 off = vec2(hash12(cell + 7.1), hash12(cell + 3.3)) - 0.5;
    float d = length(fract(sp) - 0.5 - off * 0.6);
    float tw = step(0.92, h) * smoothstep(0.09, 0.0, d) * (0.5 + 0.5 * sin(uTime * 3.0 + h * 40.0));
    col += pal(1.0) * tw * uFx2.x * (0.5 + high);
  }

  // Haze: lift shadows toward the palette midtone.
  col = mix(col, pal(0.5), 0.28 * uFx2.y * (1.0 - g));

  // Scanlines.
  col *= 1.0 - uFx1.z * 0.12 * (0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159));

  // Vignette (aspect-aware so ultra-wide screens keep bright edges).
  float vig = smoothstep(1.3, 0.25, length(uv * vec2(0.8 * min(1.0, uRes.y / uRes.x * 1.78), 1.0)));
  col *= mix(0.55, 1.0, vig);

  // Film grain.
  col += (hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 731.0) - 0.5) * uFx1.x * (0.035 + 0.05 * high);

  // Soft highlight shoulder: stacked boosts roll off instead of clipping to white.
  vec3 over = max(col - 0.72, 0.0);
  col = min(col, 0.72) + 0.28 * (1.0 - exp(-over / 0.28));

  col *= uOut.x * (1.0 - uOut.y);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
