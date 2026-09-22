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

/**
 * One turn of a tool-using conversation, normalised across providers.
 *
 * `messages` is kept in a provider-neutral shape by the agent loop:
 *   { role: 'user'|'assistant', text?, toolCalls?, toolResults? }
 * and converted here, because the two APIs disagree about where tool results
 * live (Anthropic: a user message with tool_result blocks; OpenAI: dedicated
 * role:"tool" messages).
 *
 * Returns { text, toolCalls: [{id, name, input}], stopReason, usage }.
 */
export async function completeWithTools({ provider, model, apiKey, system, messages, tools, signal }) {
  if (!apiKey) throw new Error('No API key set. Open the Settings tab and add one.');
  const resolvedModel = model || PROVIDERS[provider]?.defaultModel || PROVIDERS.claude.defaultModel;
  return provider === 'openai'
    ? openAiTurn({ model: resolvedModel, apiKey, system, messages, tools, signal })
    : claudeTurn({ model: resolvedModel, apiKey, system, messages, tools, signal });
}

async function claudeTurn({ model, apiKey, system, messages, tools, signal }) {
  const body = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    messages: messages.map(toClaudeMessage)
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

  const data = await parse(res, 'Anthropic');
  const blocks = data.content || [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
    stopReason: data.stop_reason,
    usage: data.usage || null,
    model: data.model || model
  };
}

function toClaudeMessage(m) {
  if (m.role === 'assistant') {
    const content = [];
    if (m.text) content.push({ type: 'text', text: m.text });
    for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    return { role: 'assistant', content };
  }
  if (m.toolResults && m.toolResults.length) {
    return {
      role: 'user',
      content: m.toolResults.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content }))
    };
  }
  return { role: 'user', content: m.text || '' };
}

async function openAiTurn({ model, apiKey, system, messages, tools, signal }) {
  const chat = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      chat.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls && m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input || {}) }
              }))
            }
          : {})
      });
    } else if (m.toolResults && m.toolResults.length) {
      for (const r of m.toolResults) chat.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    } else {
      chat.push({ role: 'user', content: m.text || '' });
    }
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: chat,
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema }
      }))
    })
  });

  const data = await parse(res, 'OpenAI');
  const msg = data.choices?.[0]?.message || {};
  return {
    text: (msg.content || '').trim(),
    toolCalls: (msg.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function?.name,
      input: safeJson(c.function?.arguments)
    })),
    stopReason: data.choices?.[0]?.finish_reason,
    usage: data.usage || null,
    model: data.model || model
  };
}

function safeJson(str) {
  try {
    return JSON.parse(str || '{}');
  } catch {
    return {};
  }
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
