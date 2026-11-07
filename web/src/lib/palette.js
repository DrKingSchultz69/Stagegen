export const DEFAULT_PALETTE = ['#07070f', '#1d1446', '#5b2a86', '#d9488f', '#ffd29d'];

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function paletteRgb(palette) {
  const p = Array.isArray(palette) && palette.length ? palette : DEFAULT_PALETTE;
  const out = [];
  for (let i = 0; i < 5; i++) out.push(hexToRgb(p[Math.min(i, p.length - 1)]));
  return out;
}

// Readable label color for a swatch.
export function inkFor(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? '#0b0b10' : '#ffffff';
}
