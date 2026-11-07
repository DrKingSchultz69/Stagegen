// Stagegen ai-gateway: local sidecar called by stagegen-core (C++). Listens on 127.0.0.1 only.
//
//   GET  /health
//   GET  /models?provider=openrouter|anthropic
//   POST /refine   { provider, model, apiKey, prompt, analysis, projectName, previousPlan? }
//
// API keys are passed in per request by the core, which stores them DPAPI-encrypted.
import http from 'node:http';
import { refine, RefineError, DEFAULT_ANTHROPIC_MODEL } from './refine.mjs';

const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.STAGEGEN_GATEWAY_PORT || 8091);

const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (recommended)' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
];

let openRouterCache = { at: 0, data: null };

async function openRouterModels() {
  if (openRouterCache.data && Date.now() - openRouterCache.at < 10 * 60_000) return openRouterCache.data;
  const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenRouter models request failed (${res.status})`);
  const { data = [] } = await res.json();
  const textModels = data.filter((m) => {
    const out = m.architecture?.output_modalities;
    return !out || out.includes('text');
  });
  const rank = (id) => (id.startsWith('anthropic/') ? 0 : id.startsWith('openai/') ? 1 : id.startsWith('google/') ? 2 : 3);
  textModels.sort((a, b) => rank(a.id) - rank(b.id) || (b.created ?? 0) - (a.created ?? 0));
  const models = textModels.map((m) => ({ id: m.id, name: m.name ?? m.id }));
  const pick = (re) => textModels.filter((m) => re.test(m.id)).sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0]?.id;
  const def = pick(/^anthropic\/claude-opus/) ?? pick(/^anthropic\/claude/) ?? models[0]?.id ?? '';
  openRouterCache = { at: Date.now(), data: { models, default: def } };
  return openRouterCache.data;
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new RefineError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/models') {
      const provider = url.searchParams.get('provider') ?? 'openrouter';
      if (provider === 'anthropic') return send(res, 200, { models: ANTHROPIC_MODELS, default: DEFAULT_ANTHROPIC_MODEL });
      return send(res, 200, await openRouterModels());
    }

    if (req.method === 'POST' && url.pathname === '/refine') {
      const input = JSON.parse(await readBody(req));
      const t0 = Date.now();
      const result = await refine(input);
      console.log(`[gateway] refined plan via ${input.provider}/${result.model} in ${Date.now() - t0} ms`);
      return send(res, 200, result);
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err instanceof RefineError ? err.status : err instanceof SyntaxError ? 400 : 500;
    if (status >= 500) console.error('[gateway]', err);
    send(res, status, { error: err.message ?? String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[gateway] listening on http://127.0.0.1:${PORT}`));
