// Minimal client for Meta Model API (OpenAI-compatible Responses API) with a tool loop.
import fs from 'node:fs';
import { config, assertMetaKey } from './config.js';

export async function post(pathname, body, { timeoutMs = 90_000 } = {}) {
  assertMetaKey();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(config.meta.baseUrl + pathname, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.meta.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || res.statusText;
      const err = new Error(`Meta API ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally { clearTimeout(t); }
}

export const usageTotals = { calls: 0, input: 0, output: 0 };
function track(u) {
  usageTotals.calls += 1;
  usageTotals.input += u?.input_tokens || 0;
  usageTotals.output += u?.output_tokens || 0;
}

export function outputText(resp) {
  if (typeof resp.output_text === 'string') return resp.output_text;
  return (resp.output || [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
}

/** One-shot structured extraction (JSON schema, strict). */
export async function structured({ model = config.meta.visionModel, instructions, content, schema, name = 'result', effort = 'low' }) {
  const resp = await post('/responses', {
    model,
    instructions,
    reasoning: { effort },
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_schema', name, schema, strict: true } },
  });
  track(resp.usage);
  return JSON.parse(outputText(resp));
}

/**
 * Agent loop: the model may call tools; we execute them and feed results back
 * until it produces a final message (or we hit maxSteps).
 * @param {object} p
 * @param {string} p.instructions system prompt
 * @param {Array} p.input conversation items (role/content)
 * @param {Array<{name,description,parameters,run:Function}>} p.tools
 */
export async function runAgent({ instructions, input, tools = [], model = config.meta.agentModel, effort = 'medium', maxSteps = 8, onToolCall }) {
  const toolDefs = tools.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const items = [...input];
  const trace = [];
  for (let step = 0; step < maxSteps; step++) {
    const resp = await post('/responses', {
      model,
      instructions,
      reasoning: { effort },
      input: items,
      tools: toolDefs,
      store: false,
      include: ['reasoning.encrypted_content'],
    });
    track(resp.usage);
    const calls = (resp.output || []).filter((o) => o.type === 'function_call');
    if (!calls.length) return { text: outputText(resp).trim(), trace };
    items.push(...resp.output);
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { /* keep empty */ }
      let result;
      try {
        const tool = byName[call.name];
        result = tool ? await tool.run(args) : { error: `unknown tool ${call.name}` };
      } catch (e) { result = { error: String(e.message || e) }; }
      trace.push({ tool: call.name, args, result });
      onToolCall?.(call.name, args, result);
      items.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
  }
  return { text: '', trace, error: 'max_steps' };
}

/**
 * Speech to text (Muse Voice Transcribe) for a WAV file: mono, 16-bit PCM, 16 or 24 kHz.
 * Multipart with two parts: `request` (JSON settings) and `audio` (the WAV).
 */
export async function transcribeWav(wavPath, { languageBias = [], keywords = [] } = {}) {
  assertMetaKey();
  const settings = { model: config.meta.transcribeModel, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' };
  if (languageBias.length) settings.languageBias = languageBias;
  if (keywords.length) settings.keywords = keywords;
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify(settings)], { type: 'application/json' }));
  form.append('audio', new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' }), 'audio.wav');
  const res = await fetch(config.meta.baseUrl + '/asr/transcribe', {
    method: 'POST', headers: { Authorization: `Bearer ${config.meta.apiKey}`, Accept: 'application/json' }, body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Transcribe ${res.status}: ${json?.error?.message || JSON.stringify(json).slice(0, 300)}`);
  usageTotals.audioMs = (usageTotals.audioMs || 0) + (json.audioDurationMs || 0);
  return { text: (json.transcript || '').trim(), durationMs: json.audioDurationMs || 0 };
}
