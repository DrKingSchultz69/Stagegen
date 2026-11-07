// Prompt refinement: turns a rough idea + the track analysis into a per-section visual plan.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { Plan, normalizePlan, parseJsonLoose } from './plan-schema.mjs';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

const SYSTEM_PROMPT = `You are the visual director for live music performances. Your job is to design the background visuals that play on a screen or LED wall behind a performing artist, perfectly matched to one specific track.

You receive:
- The artist's rough idea for the visuals.
- An analysis of the track: tempo, key and mode, loudness, dynamics, brightness, arousal/valence estimates, and its sections (start/end seconds, relative energy 0..1, brightness, trend, bar count). Section names such as "intro", "build", "peak", "breakdown" are heuristic labels from the analysis.

Produce a visual plan for the whole show and one entry per analysis section (keep every section id unchanged and in order).

How the plan is used:
- image_prompt and video_prompt are sent unchanged to text-to-image and image/text-to-video models (e.g. Flux, Seedream, Kling, Veo). Write them as concrete, visual, self-contained prompts: subject, environment, light, color, texture, lens/composition, and for video the motion. Include the global style naturally rather than referencing it.
- The palette colors drive procedurally generated GLSL gradients that sit behind and between the generated assets, so they must be valid #RRGGBB hex, ordered darkest to brightest, and work as a smooth gradient.
- camera describes the move across the backdrop during that section (it becomes keyframes in a 3D scene). speed and turbulence (0..1) drive how fast and how turbulent the background flows.

Rules for stage backdrops:
- These sit behind a live performer. Keep the center and lower third calmer and less detailed; put visual interest at the edges, top and depth of the frame.
- No text, letters, logos, watermarks, UI, or recognizable real people. No close-up faces.
- Wide compositions that survive cropping to anything from 16:9 to ultra-wide LED walls.
- Video motion should be slow-evolving and loopable; let energy come from light, particles and camera rather than fast cuts.
- Map the music: low-energy sections get darker, sparser, slower visuals; peaks get the brightest palette, the most motion, the highest speed/turbulence, and more FX. Builds should visibly escalate toward the next peak. Keep one coherent visual world across the whole track, evolving rather than jumping between unrelated scenes.
- Respect the artist's idea; enrich it, don't replace it. If a previous plan is provided, revise it according to the new instruction and keep what the instruction doesn't touch.`;

function userMessage({ prompt, analysis, projectName, previousPlan }) {
  const parts = [
    `Show / track name: ${projectName || 'untitled'}`,
    `Artist's idea:\n${prompt}`,
    `Track analysis (JSON):\n${JSON.stringify(analysis)}`,
  ];
  if (previousPlan) {
    const { prompt: _p, provider: _pr, model: _m, createdAt: _c, ...plan } = previousPlan;
    parts.push(`Previous plan to revise (JSON):\n${JSON.stringify(plan)}`);
  }
  parts.push('Return only the plan.');
  return parts.join('\n\n');
}

class RefineError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function refineWithAnthropic(input) {
  const client = new Anthropic({ apiKey: input.apiKey });
  const model = input.model || DEFAULT_ANTHROPIC_MODEL;
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(Plan) },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage(input) }],
    });
    if (response.stop_reason === 'refusal') {
      throw new RefineError(422, `The model declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new RefineError(502, 'The model ran out of output tokens before finishing the plan. Try a shorter prompt.');
    }
    let raw = response.parsed_output;
    if (!raw) {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      raw = parseJsonLoose(text);
    }
    if (!raw) throw new RefineError(502, 'The model did not return a valid plan.');
    return { raw, model: response.model ?? model };
  } catch (err) {
    if (err instanceof RefineError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new RefineError(401, 'Anthropic rejected the API key.');
    if (err instanceof Anthropic.PermissionDeniedError) throw new RefineError(403, `Anthropic: ${err.message}`);
    if (err instanceof Anthropic.NotFoundError) throw new RefineError(400, `Unknown Anthropic model "${model}".`);
    if (err instanceof Anthropic.RateLimitError) throw new RefineError(429, 'Anthropic rate limit reached - try again shortly.');
    if (err instanceof Anthropic.BadRequestError) throw new RefineError(400, `Anthropic: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new RefineError(502, `Anthropic API error ${err.status ?? ''}: ${err.message}`);
    throw new RefineError(502, `Could not reach Anthropic: ${err.message}`);
  }
}

async function openRouterChat(apiKey, body) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Stagegen',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(280_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

async function refineWithOpenRouter(input) {
  if (!input.model) throw new RefineError(400, 'Pick an OpenRouter model in the prompt bar or Settings.');
  const base = {
    model: input.model,
    max_tokens: 16000,
    messages: [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\nRespond with a single JSON object matching the provided schema.` },
      { role: 'user', content: userMessage(input) },
    ],
  };
  const schema = z.toJSONSchema(Plan);
  let r = await openRouterChat(input.apiKey, {
    ...base,
    response_format: { type: 'json_schema', json_schema: { name: 'visual_plan', strict: true, schema } },
  });
  // Some models don't support json_schema; retry with plain JSON mode + the schema in the prompt.
  if (r.status === 400 || r.status === 404 || r.status === 422) {
    base.messages[0].content += `\n\nJSON schema:\n${JSON.stringify(schema)}`;
    r = await openRouterChat(input.apiKey, { ...base, response_format: { type: 'json_object' } });
  }
  if (r.status === 401) throw new RefineError(401, 'OpenRouter rejected the API key.');
  if (r.status === 402) throw new RefineError(402, 'OpenRouter: insufficient credits.');
  if (r.status === 429) throw new RefineError(429, 'OpenRouter rate limit reached - try again shortly.');
  if (r.status !== 200 || !r.json) {
    throw new RefineError(502, `OpenRouter error ${r.status}: ${r.json?.error?.message ?? r.text.slice(0, 300)}`);
  }
  const choice = r.json.choices?.[0];
  const raw = parseJsonLoose(choice?.message?.content ?? '');
  if (!raw) {
    throw new RefineError(502, `The model did not return a valid plan${choice?.finish_reason === 'length' ? ' (output was cut off)' : ''}.`);
  }
  return { raw, model: r.json.model ?? input.model };
}

export async function refine(input) {
  if (!input?.apiKey) throw new RefineError(400, 'Missing API key.');
  if (!input.prompt) throw new RefineError(400, 'Missing prompt.');
  if (!input.analysis?.sections?.length) throw new RefineError(400, 'Missing track analysis.');
  const { raw, model } =
    input.provider === 'anthropic' ? await refineWithAnthropic(input) : await refineWithOpenRouter(input);
  return { plan: normalizePlan(raw, input.analysis), model };
}

export { RefineError };
