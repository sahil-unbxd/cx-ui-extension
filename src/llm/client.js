/** BYO-key LLM client. Two providers behind one call signature.
 *  No backend in v1: the request goes from this service worker straight to the
 *  provider, with the engineer's own key. */
import { PROVIDERS } from '../shared/settings.js';

const MAX_OUTPUT_TOKENS = 1400;

export async function complete({ provider, model, apiKey, system, user, signal }) {
  if (!apiKey) throw new Error('No API key set. Open the Settings tab and add one.');
  const impl = provider === 'openai' ? callOpenAI : callClaude;
  return impl({
    model: model || PROVIDERS[provider]?.defaultModel || PROVIDERS.claude.defaultModel,
    apiKey,
    system,
    user,
    signal
  });
}

async function callClaude({ model, apiKey, system, user, signal }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for a browser-originated call; without it Anthropic rejects
      // the request with a CORS error rather than an auth error.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });

  const data = await parse(res, 'Anthropic');
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { text, usage: data.usage || null, model: data.model || model, provider: 'claude' };
}

async function callOpenAI({ model, apiKey, system, user, signal }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  const data = await parse(res, 'OpenAI');
  const text = (data.choices?.[0]?.message?.content || '').trim();
  return { text, usage: data.usage || null, model: data.model || model, provider: 'openai' };
}

async function parse(res, label) {
  const body = await res.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${label} returned a non-JSON response (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = data.error?.message || data.message || `HTTP ${res.status}`;
    throw new Error(`${label} error: ${msg}`);
  }
  return data;
}
