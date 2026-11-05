/**
 * The extension's Gemini client and agent loop, against a stubbed fetch.
 * Checks the exact requests sent to Google — URL, auth header, body shape,
 * tool round-trips, thought-signature replay — without a key or network.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { complete, completeWithTools, endpointUrl, toGeminiContents, toFunctionDeclaration } from '../../src/llm/client.js';
import { runAgentLoop } from '../../src/llm/agent.js';

const VERTEX = { endpoint: 'vertex', apiKey: 'test-key', project: 'acme-prod', location: 'global' };
const STUDIO = { endpoint: 'aistudio', apiKey: 'AIza-test', project: '', location: 'global' };

let calls;
let replies;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  replies = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = replies.shift();
    return new Response(JSON.stringify(next.body), { status: next.status || 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const textReply = (text, extra = {}) => ({
  body: {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 300 },
    modelVersion: 'gemini-2.5-pro',
    ...extra
  }
});

test('endpoint URLs: Vertex project/region, global, express mode, AI Studio', () => {
  assert.equal(
    endpointUrl(VERTEX, 'gemini-2.5-pro'),
    'https://aiplatform.googleapis.com/v1/projects/acme-prod/locations/global/publishers/google/models/gemini-2.5-pro:generateContent'
  );
  assert.equal(
    endpointUrl({ ...VERTEX, location: 'europe-west4' }, 'gemini-2.5-flash'),
    'https://europe-west4-aiplatform.googleapis.com/v1/projects/acme-prod/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent'
  );
  assert.equal(endpointUrl({ ...VERTEX, project: '' }, 'gemini-2.5-pro'), 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:generateContent');
  assert.equal(endpointUrl(STUDIO, 'gemini-2.5-pro'), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
});

test('one-shot: key in header (never URL), system instruction, thinking-sized budget, usage counts thinking', async () => {
  replies.push(textReply('**Decision** …'));
  const out = await complete({ connection: VERTEX, model: 'gemini-2.5-pro', system: 'SYS', user: 'USER' });
  const [c] = calls;
  assert.equal(c.headers['x-goog-api-key'], 'test-key');
  assert.ok(!c.url.includes('test-key'));
  assert.deepEqual(c.body.systemInstruction, { parts: [{ text: 'SYS' }] });
  assert.deepEqual(c.body.contents, [{ role: 'user', parts: [{ text: 'USER' }] }]);
  assert.ok(c.body.generationConfig.maxOutputTokens >= 4096);
  assert.equal(c.body.tools, undefined);
  assert.equal(out.text, '**Decision** …');
  assert.deepEqual([out.usage.input_tokens, out.usage.output_tokens], [1000, 500]);
});

test('thought parts are not part of the answer', async () => {
  replies.push({ body: { candidates: [{ content: { parts: [{ text: 'reasoning…', thought: true }, { text: 'ANSWER' }] }, finishReason: 'STOP' }] } });
  const out = await complete({ connection: STUDIO, model: 'gemini-2.5-pro', system: 's', user: 'u' });
  assert.equal(out.text, 'ANSWER');
});

test('empty answer with MAX_TOKENS is an explicit error, not a blank result', async () => {
  replies.push({ body: { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] } });
  await assert.rejects(complete({ connection: STUDIO, model: 'm', system: 's', user: 'u' }), /MAX_TOKENS.*output budget/);
});

test("provider errors keep Google's own message and add a pointer", async () => {
  replies.push({ status: 404, body: { error: { code: 404, status: 'NOT_FOUND', message: 'Publisher Model `gemini-9` was not found.' } } });
  await assert.rejects(complete({ connection: VERTEX, model: 'gemini-9', system: 's', user: 'u' }), /Vertex AI error \(NOT_FOUND\): Publisher Model `gemini-9` was not found\. Model "gemini-9" was not found in location "global"/);
  replies.push({ status: 403, body: [{ error: { status: 'PERMISSION_DENIED', message: 'denied' } }] });
  await assert.rejects(complete({ connection: VERTEX, model: 'm', system: 's', user: 'u' }), /PERMISSION_DENIED\): denied\. Check the key, that the Vertex AI API is enabled on project "acme-prod"/);
});

test('function declarations: no-arg tools omit parameters, others pass the schema through', () => {
  assert.deepEqual(toFunctionDeclaration({ name: 'get_sdk_config', description: 'd', input_schema: { type: 'object', properties: {} } }), { name: 'get_sdk_config', description: 'd' });
  const schema = { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] };
  assert.deepEqual(toFunctionDeclaration({ name: 'inspect_element', description: 'd', input_schema: schema }).parameters, schema);
});

test('contents: tool results carry the function name, back-to-back user turns merge', () => {
  const contents = toGeminiContents([
    { role: 'user', text: 'go' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'local_a_0', name: 'list_network_requests', input: { filter: 'failed' } }] },
    { role: 'user', toolResults: [{ id: 'local_a_0', content: JSON.stringify({ total: 0, requests: [] }) }] },
    { role: 'user', text: 'wrap up' }
  ]);
  assert.deepEqual(contents.map((c) => c.role), ['user', 'model', 'user']);
  const fr = contents[2].parts[0].functionResponse;
  assert.equal(fr.name, 'list_network_requests');
  assert.equal(fr.id, undefined, 'locally invented ids are not echoed to the API');
  assert.deepEqual(fr.response, { total: 0, requests: [] });
  assert.deepEqual(contents[2].parts[1], { text: 'wrap up' });
});

test('agent loop: tool round-trip, thought signature replayed verbatim, usage summed', async () => {
  const signed = { role: 'model', parts: [{ functionCall: { id: 'fc-1', name: 'get_sdk_config', args: {} }, thoughtSignature: 'SIG==' }] };
  replies.push({ body: { candidates: [{ content: signed, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } });
  replies.push(textReply('FINAL'));

  const ran = [];
  const toolbox = {
    definitions: [{ name: 'get_sdk_config', description: 'd', input_schema: { type: 'object', properties: {} } }],
    run: async (name, input) => {
      ran.push([name, input]);
      return ['not', 'an', 'object'];
    }
  };
  const out = await runAgentLoop({ connection: VERTEX, model: 'gemini-3-pro-preview', system: 'SYS', user: 'USER', toolbox });

  assert.equal(out.text, 'FINAL');
  assert.deepEqual(ran, [['get_sdk_config', {}]]);
  assert.equal(calls[0].body.toolConfig.functionCallingConfig.mode, 'AUTO');
  const second = calls[1].body.contents;
  assert.deepEqual(second[1], signed, 'model turn sent back exactly as received');
  const fr = second[2].parts[0].functionResponse;
  assert.deepEqual([fr.id, fr.name], ['fc-1', 'get_sdk_config']);
  assert.deepEqual(fr.response, { result: ['not', 'an', 'object'] }, 'non-object results are wrapped');
  assert.equal(out.usage.input_tokens, 1010);
});

test('agent wrap-up keeps tools declared but forbids new calls', async () => {
  const call = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_sdk_config', args: {} } }] }, finishReason: 'STOP' }] };
  replies.push({ body: call });
  replies.push(textReply('BEST EFFORT'));
  const toolbox = { definitions: [{ name: 'get_sdk_config', description: 'd', input_schema: { type: 'object', properties: {} } }], run: async () => ({ ok: true }) };
  const out = await runAgentLoop({ connection: STUDIO, model: 'm', system: 's', user: 'u', toolbox, maxIterations: 1 });
  assert.equal(out.stoppedBecause, 'iteration_cap');
  assert.equal(out.text, 'BEST EFFORT');
  const wrap = calls[1].body;
  assert.equal(wrap.toolConfig.functionCallingConfig.mode, 'NONE');
  assert.equal(wrap.tools[0].functionDeclarations[0].name, 'get_sdk_config');
});

test('completeWithTools refuses to run without a key', async () => {
  await assert.rejects(completeWithTools({ connection: { ...VERTEX, apiKey: '' }, model: 'm', system: 's', messages: [], tools: [] }), /No Gemini API key/);
});

test('settings migration drops the old Claude/OpenAI keys from storage', async () => {
  let store = { settings: { provider: 'claude', model: 'claude-sonnet-5', apiKeys: { claude: 'sk-ant-x', openai: 'sk-y' }, agentMode: true } };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (obj) => {
          store = { ...store, ...obj };
        }
      }
    }
  };
  const { getSettings, isConfigured } = await import('../../src/shared/settings.js');
  const s = await getSettings();
  assert.equal(s.model, 'gemini-2.5-pro');
  assert.equal(s.gemini.endpoint, 'vertex');
  assert.equal(s.agentMode, true, 'other preferences survive');
  assert.ok(!('apiKeys' in store.settings) && !('provider' in store.settings), 'old secrets removed from storage');
  assert.equal(isConfigured(s), false);
  delete globalThis.chrome;
});
