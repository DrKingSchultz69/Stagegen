// The structured "visual plan" the LLM produces for a track, plus normalization helpers.
import { z } from 'zod';

export const CAMERA_MOVES = [
  'static', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down',
  'orbit', 'drift', 'dolly-through', 'rise', 'fall',
];
export const FX = ['grain', 'bloom', 'strobe', 'particles', 'chromatic', 'scanlines', 'haze'];

export const SectionPlan = z.object({
  id: z.number().int().describe('Section id from the analysis, unchanged'),
  title: z.string().describe('Evocative 1-4 word title for this part of the show'),
  mood: z.string().describe('Short mood description, e.g. "tense, nocturnal, expectant"'),
  palette: z.array(z.string()).describe('3 to 5 hex colors (#RRGGBB) from darkest to brightest for this section'),
  image_prompt: z.string().describe('Prompt for a text-to-image model: a wide stage backdrop still'),
  video_prompt: z.string().describe('Prompt for a text/image-to-video model: 5-10 s loopable backdrop motion'),
  camera: z.object({
    move: z.enum(CAMERA_MOVES),
    from: z.string().describe('What the frame starts on'),
    to: z.string().describe('What the frame ends on'),
  }),
  motion: z.enum(['low', 'mid', 'high']),
  speed: z.number().describe('Background flow speed 0..1'),
  turbulence: z.number().describe('Background warp/turbulence 0..1'),
  fx: z.array(z.enum(FX)),
});

export const Plan = z.object({
  title: z.string().describe('Name for the whole visual show'),
  concept: z.string().describe('2-3 sentence visual concept tying the show together'),
  global_style: z.string().describe('Style suffix appended to every generation prompt'),
  negative_prompt: z.string().describe('Things every generation must avoid'),
  palette: z.array(z.string()).describe('5 hex colors (#RRGGBB) for the whole show, darkest to brightest'),
  sections: z.array(SectionPlan),
});

const DEFAULT_PALETTE = ['#07070f', '#1d1446', '#5b2a86', '#d9488f', '#ffd29d'];

function normHex(c) {
  if (typeof c !== 'string') return null;
  let s = c.trim();
  if (!s.startsWith('#')) {
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    s = '#' + s;
  }
  if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + [...s.slice(1)].map((ch) => ch + ch).join('');
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

function normPalette(arr, fallback, size = 5) {
  const out = (Array.isArray(arr) ? arr : []).map(normHex).filter(Boolean).slice(0, size);
  if (out.length < 3) return [...fallback];
  while (out.length < size) out.push(out[out.length - 1]);
  return out;
}

const clamp01 = (v, d) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

// Merges LLM output onto the analysis sections so timing always comes from the audio analysis.
export function normalizePlan(raw, analysis) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const palette = normPalette(r.palette, DEFAULT_PALETTE);
  const rawSections = (Array.isArray(r.sections) ? r.sections : []).filter((x) => x && typeof x === 'object');
  const hasIds = rawSections.some((x) => Number.isInteger(x.id));
  const sections = (analysis?.sections ?? []).map((sec, i) => {
    const s = (hasIds ? rawSections.find((x) => x.id === sec.id) : rawSections[i]) ?? {};
    const motion = ['low', 'mid', 'high'].includes(s.motion) ? s.motion : sec.energy > 0.8 ? 'high' : sec.energy > 0.5 ? 'mid' : 'low';
    return {
      id: sec.id,
      name: sec.name,
      start: sec.start,
      end: sec.end,
      energy: sec.energy,
      title: String(s.title ?? sec.name),
      mood: String(s.mood ?? ''),
      palette: normPalette(s.palette, palette),
      image_prompt: String(s.image_prompt ?? ''),
      video_prompt: String(s.video_prompt ?? ''),
      camera: {
        move: CAMERA_MOVES.includes(s.camera?.move) ? s.camera.move : 'drift',
        from: String(s.camera?.from ?? ''),
        to: String(s.camera?.to ?? ''),
      },
      motion,
      speed: clamp01(s.speed, 0.2 + 0.6 * (sec.energy ?? 0.5)),
      turbulence: clamp01(s.turbulence, 0.3 + 0.5 * (sec.energy ?? 0.5)),
      fx: Array.isArray(s.fx) ? s.fx.filter((f) => FX.includes(f)) : [],
    };
  });
  return {
    title: String(r.title ?? 'Untitled show'),
    concept: String(r.concept ?? ''),
    global_style: String(r.global_style ?? ''),
    negative_prompt: String(r.negative_prompt ?? ''),
    palette,
    sections,
  };
}

export function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}
