/** Gemini client — Vertex AI or the Gemini API (Google AI Studio).
 *
 *  Both take the same generateContent request; only the URL differs. No
 *  backend in v1: the request goes from this service worker straight to
 *  Google with the engineer's own key (sent as x-goog-api-key, never in the
 *  URL, so it cannot end up in a logged request line).
 */
import { GEMINI } from '../shared/settings.js';

// Thinking models (2.5 Pro, 3.x) spend output tokens on reasoning before the
// visible answer. The ticket-sized answer is ~1.5k tokens; the budget has to
// cover the thinking too, or the reply comes back empty with MAX_TOKENS.
const MAX_OUTPUT_TOKENS = 8192;

/** Prefix for ids we invent when the API returns a functionCall without one. */
const LOCAL_ID = 'local_';

export function endpointUrl({ endpoint, project, location }, model) {
  const m = encodeURIComponent(model);
  if (endpoint === 'aistudio') {
    return `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
  }
  // Vertex AI. Without a project the key is an express-mode key.
  if (!project) return `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent`;
  const loc = location || 'global';
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${m}:generateContent`;
}

/** One-shot answer. */
export async function complete({ connection, model, system, user, signal }) {
  const turn = await generate({ connection, model, system, contents: [{ role: 'user', parts: [{ text: user }] }], signal });
  return { text: turn.text, usage: turn.usage, model: turn.model, provider: 'gemini' };
}

/**
 * One turn of a tool-using conversation.
 *
 * `messages` is the agent loop's provider-neutral shape:
 *   { role: 'user'|'assistant', text?, toolCalls?, toolResults?, raw? }
 * `raw` is the model's own content object from the previous turn; it is sent
 * back verbatim because Gemini 3 attaches thought signatures to function-call
 * parts and rejects a follow-up request that drops them.
 *
 * toolChoice 'none' keeps the tools declared (the history contains calls to
 * them) but forbids new calls — used for the agent's final wrap-up turn.
 *
 * Returns { text, toolCalls: [{id, name, input}], stopReason, usage, model, raw }.
 */
export async function completeWithTools({ connection, model, system, messages, tools, toolChoice = 'auto', signal }) {
  return generate({ connection, model, system, contents: toGeminiContents(messages), tools, toolChoice, signal });
}

async function generate({ connection, model, system, contents, tools = [], toolChoice = 'auto', signal }) {
  if (!connection || !connection.apiKey) throw new Error('No Gemini API key set. Open the Settings tab and add one.');
  const resolvedModel = (model || GEMINI.defaultModel).trim();
  const label = connection.endpoint === 'aistudio' ? 'Gemini API' : 'Vertex AI';

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS }
  };
  if (tools && tools.length) {
    body.tools = [{ functionDeclarations: tools.map(toFunctionDeclaration) }];
    body.toolConfig = { functionCallingConfig: { mode: toolChoice === 'none' ? 'NONE' : 'AUTO' } };
  }

  const res = await fetch(endpointUrl(connection, resolvedModel), {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': connection.apiKey },
    body: JSON.stringify(body)
  });
  const data = await parse(res, label, connection, resolvedModel);
  return readTurn(data, resolvedModel);
}

/** Exported for tests: turns a generateContent response into a turn. */
export function readTurn(data, model) {
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error(`Gemini blocked the prompt (${data.promptFeedback.blockReason}).`);
  }
  const cand = (data.candidates || [])[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  // `thought: true` parts are reasoning summaries, not the answer.
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('\n')
    .trim();
  const toolCalls = parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({
      id: p.functionCall.id || `${LOCAL_ID}${Date.now().toString(36)}_${i}`,
      name: p.functionCall.name,
      input: p.functionCall.args || {}
    }));
  const finishReason = cand ? cand.finishReason : null;

  if (!text && !toolCalls.length) {
    const hint =
      finishReason === 'MAX_TOKENS'
        ? ' The model used its whole output budget (thinking counts toward it) — lower the prompt token budget in Settings or pick a lighter model.'
        : finishReason === 'SAFETY' || finishReason === 'RECITATION' || finishReason === 'PROHIBITED_CONTENT'
          ? ' The response was filtered by Gemini.'
          : '';
    throw new Error(`Gemini returned no answer (finishReason ${finishReason || 'none'}).${hint}`);
  }

  const u = data.usageMetadata || {};
  return {
    text,
    toolCalls,
    stopReason: finishReason,
    usage: {
      input_tokens: u.promptTokenCount ?? 0,
      // Thinking is billed as output, so it is counted as output here.
      output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      thinking_tokens: u.thoughtsTokenCount ?? 0
    },
    model: data.modelVersion || model,
    raw: cand && cand.content ? cand.content : null
  };
}

/** Exported for tests. Gemini rejects an OBJECT schema with no properties,
 *  so argument-less tools are declared without `parameters`. */
export function toFunctionDeclaration(tool) {
  const decl = { name: tool.name, description: tool.description };
  const schema = tool.input_schema;
  if (schema && schema.properties && Object.keys(schema.properties).length) decl.parameters = schema;
  return decl;
}

/** Exported for tests: the agent loop's messages → Gemini `contents`. */
export function toGeminiContents(messages) {
  const names = new Map(); // tool call id → function name (functionResponse needs the name)
  const out = [];
  const push = (role, parts) => {
    const last = out[out.length - 1];
    // Gemini expects user/model turns to alternate; merge back-to-back ones
    // (e.g. tool results followed by the wrap-up instruction).
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts: [...parts] });
  };

  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const c of m.toolCalls || []) names.set(c.id, c.name);
      if (m.raw && Array.isArray(m.raw.parts) && m.raw.parts.length) {
        push('model', m.raw.parts);
        continue;
      }
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.input || {} } });
      if (parts.length) push('model', parts);
    } else if (m.toolResults && m.toolResults.length) {
      push(
        'user',
        m.toolResults.map((r) => ({
          functionResponse: {
            ...(r.id && !String(r.id).startsWith(LOCAL_ID) ? { id: r.id } : {}),
            name: names.get(r.id) || 'unknown_tool',
            response: asObject(r.content)
          }
        }))
      );
    } else {
      push('user', [{ text: m.text || '' }]);
    }
  }
  return out;
}

/** functionResponse.response must be a JSON object. */
function asObject(content) {
  let value = content;
  if (typeof content === 'string') {
    try {
      value = JSON.parse(content);
    } catch {
      return { result: content };
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
}

async function parse(res, label, connection, model) {
  const body = await res.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${label} returned a non-JSON response (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    // Google returns {error:{…}}; some Vertex errors come as [{error:{…}}].
    const err = (Array.isArray(data) ? data[0] && data[0].error : data.error) || {};
    const msg = err.message || `HTTP ${res.status}`;
    // The API's own message first — it is the useful part — then a pointer.
    let hint = '';
    if (res.status === 401 || res.status === 403) {
      hint = connection.endpoint === 'vertex'
        ? ` Check the key, that the Vertex AI API is enabled${connection.project ? ` on project "${connection.project}"` : ''}, and the key's API restrictions.`
        : ' Check the AI Studio key.';
    } else if (res.status === 404) {
      hint = ` Model "${model}" was not found${connection.endpoint === 'vertex' ? ` in location "${connection.location}"` : ''} — check the model ID in Settings.`;
    }
    const sentence = hint && !/[.!?]$/.test(msg.trim()) ? `${msg.trim()}.` : msg;
    throw new Error(`${label} error (${err.status || res.status}): ${sentence}${hint}`);
  }
  return data;
}
