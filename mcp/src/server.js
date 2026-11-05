#!/usr/bin/env node
/**
 * Unbxd CX Debug — MCP server for the support team.
 *
 * A support agent pastes a customer complaint and a URL into Claude (Desktop
 * or Code). This server opens that storefront in a real browser, reproduces
 * the issue, runs the same deterministic checks as the CX Debug Assistant
 * extension, and answers the routing question: is this the customer's site
 * code/CSS (revert to customer), the Unbxd config / API / SDK (raise an
 * internal Jira), or not reproducible (ask for more)?
 *
 * The model is the MCP client. This server holds no API key and calls no LLM:
 * it returns evidence, a deterministic routing suggestion and the playbook, and
 * Claude writes the answer.
 *
 * stdout is the MCP channel — log to stderr only.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { setDocLoader } from '../../src/shared/docs.js';
import { ISSUE_TYPE_LIST } from '../../src/shared/issue-types.js';
import { unbxdApiKind } from '../../src/shared/unbxd-endpoints.js';
import { createToolbox } from '../../src/capture/toolbox.js';
import { capturePageInventory } from '../../src/capture/page-inventory.js';
import { captureCssProvenance, clippingAncestor } from '../../src/capture/css-provenance.js';
import { BrowserManager } from './browser.js';
import { runTriage, navigate, typeInSearchBox, waitOutChallenge } from './triage.js';
import { buildJiraDraft } from './report.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = {
  'SKILLS.md': 'Debugging playbooks per issue type (what the triage injects)',
  'common-issues.md': 'Previously-resolved patterns and their fixes',
  'unbxd-search-sdk-doc.md': 'Search SDK configuration reference',
  'AUTOSUGGEST_SDK_REFERENCE.md': 'Autosuggest SDK reference',
  'INTERNAL_ARCHITECTURE_AND_DEBUGGING_GUIDE.md': 'Search SDK internals and debugging guide'
};

// The shared prompt code reads the team's markdown through this loader.
setDocLoader(async (name) => {
  if (!DOCS[name]) throw new Error(`Unknown doc ${name}`);
  return readFile(path.join(REPO_ROOT, name), 'utf8');
});

const log = (...args) => console.error('[unbxd-cx-mcp]', ...args);
const env = process.env;
const flag = (v, fallback) => (v == null || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));

const manager = new BrowserManager({
  headless: flag(env.UNBXD_MCP_HEADLESS, false),
  channel: env.UNBXD_MCP_BROWSER_CHANNEL ?? 'chrome',
  executablePath: env.UNBXD_MCP_EXECUTABLE_PATH || null,
  cdpUrl: env.UNBXD_MCP_CDP_URL || null,
  idleMs: Number(env.UNBXD_MCP_IDLE_MINUTES || 10) * 60_000,
  log
});
const MAX_TOKENS = Number(env.UNBXD_MCP_MAX_TOKENS || 16000);

/* ------------------------------------------------------------------ */
/* Tools                                                                 */
/* ------------------------------------------------------------------ */

const ISSUE_TYPE_IDS = ISSUE_TYPE_LIST.map((t) => t.id);
const ISSUE_TYPE_HELP = ISSUE_TYPE_LIST.map((t) => `${t.id} = ${t.label} (${t.hint})`).join(' ');

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });
const text = (value) => ({ content: [{ type: 'text', text: value }] });

/** Unbxd API calls recorded after request number `since`, for "what did that do?". */
function unbxdCallsSince(run, since) {
  return run.recorder
    .all()
    .slice(since)
    .filter((r) => unbxdApiKind(r.rawUrl))
    .map((r) => ({ kind: unbxdApiKind(r.rawUrl), status: r.failed ? `failed: ${r.errorText}` : r.status, durationMs: r.durationMs, url: r.url }));
}

async function settle(page) {
  await new Promise((r) => setTimeout(r, 1000));
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

function locatorFor(page, { selector, text: visibleText }) {
  if (selector) return page.locator(selector).first();
  if (visibleText) return page.getByText(visibleText, { exact: false }).first();
  throw new Error('Give either selector (CSS) or text (visible text) to target an element.');
}

const OWN_TOOLS = {
  triage_ui_issue: {
    description:
      "START HERE for any customer-reported Unbxd search UI issue on a Shopify/Magento (or other) storefront. Opens the page in a real browser with network + console recording, reproduces the issue (types into the search box for autosuggest issues, searches for search_query if needed), runs Unbxd's deterministic checks (SDK bundles loaded, SDK initialised, page type vs endpoint, the query/category reaching the API, attribute mapping, config selectors, API results vs rendered DOM), attributes every script, stylesheet, console error and failed request to Unbxd vs the customer's site, finds customer CSS overriding the Unbxd widget, and spots competing search apps. Returns a routing decision — revert to customer / raise internal Jira (which team) / need more evidence — with its evidence, matching known issues, the relevant playbook, and the exact answer format to use. Omit url to re-analyse the page already open after reproducing more steps with interact.",
    annotations: { title: 'Triage a UI issue', readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Customer page where the issue shows: a search results page, category page, or any page with the search box (autosuggest issues). Omit to re-analyse the currently open page.' },
        complaint: { type: 'string', description: "The customer's complaint / support comment, verbatim. If they pasted the HTML of the wrong element or quoted a wrong value, include it — quoted values are traced back to the API field that produced them." },
        issue_type: { type: 'string', enum: ['auto', ...ISSUE_TYPE_IDS], description: `Default auto (detected from the page and the complaint). ${ISSUE_TYPE_HELP}` },
        search_query: { type: 'string', description: 'Autosuggest issues: the term to type (use the customer\'s; if unknown a category word from the store is picked). Search-results issues when url is not already a results page: the query to search for.' },
        device: { type: 'string', enum: ['desktop', 'mobile'], description: 'Viewport to reproduce on (default desktop). Use mobile when the customer reports a phone-only problem.' },
        include_screenshot: { type: 'boolean', description: 'Attach a screenshot of the reproduced state (default true).' }
      }
    },
    run: async (args) => {
      if (!args.url && !manager.run) throw new Error('Give a url — no page is open yet.');
      const result = await runTriage(manager, args, { maxTokens: MAX_TOKENS });
      const content = [{ type: 'text', text: result.text }];
      if (result.screenshot) content.push({ type: 'image', data: result.screenshot.toString('base64'), mimeType: 'image/jpeg' });
      return { content };
    }
  },

  open_page: {
    description: 'Open a URL in a fresh, recorded page without analysing it — for exploring before a triage, or reproducing a multi-step flow (open → interact → triage_ui_issue without url). Starts a new recording.',
    annotations: { title: 'Open page', readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        device: { type: 'string', enum: ['desktop', 'mobile'] }
      },
      required: ['url']
    },
    run: async ({ url, device = 'desktop' }) => {
      const run = await manager.newRun({ device });
      const nav = await navigate(run, url);
      await waitOutChallenge(run);
      return json({ ...nav, title: await run.page.title().catch(() => null), unbxdApiCalls: unbxdCallsSince(run, 0), recording: run.recorder.summary() });
    }
  },

  interact: {
    description:
      'Act on the open page like a shopper, then report which Unbxd API calls that triggered. Actions: click / hover (selector or visible text), fill (selector + value), press (key, optional selector), select (selector + value, e.g. a sort dropdown), scroll (value = pixels, for infinite scroll), go_back (back-button issues), wait (value = ms). Use it to reproduce steps from the complaint (apply a facet, change page, sort) or to get past a storefront password page.',
    annotations: { title: 'Interact with page', openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'hover', 'fill', 'press', 'select', 'scroll', 'go_back', 'wait'] },
        selector: { type: 'string', description: 'CSS selector of the target element.' },
        text: { type: 'string', description: 'Visible text of the target element (alternative to selector).' },
        value: { type: 'string', description: 'fill: text to enter. select: option value or label. scroll: pixels (default 1200). wait: milliseconds (max 15000).' },
        key: { type: 'string', description: 'press: key name, e.g. Enter, ArrowDown, Escape.' }
      },
      required: ['action']
    },
    run: async ({ action, selector, text: visibleText, value, key }) => {
      const run = manager.current();
      const { page } = run;
      const since = run.recorder.all().length;
      const errorsBefore = run.recorder.pageErrors.length + run.recorder.consoleEntries.length;
      const target = selector || visibleText;
      switch (action) {
        case 'click':
          await locatorFor(page, { selector, text: visibleText }).click({ timeout: 8000 });
          run.steps.push(`Clicked ${target}`);
          break;
        case 'hover':
          await locatorFor(page, { selector, text: visibleText }).hover({ timeout: 8000 });
          run.steps.push(`Hovered ${target}`);
          break;
        case 'fill':
          await locatorFor(page, { selector, text: visibleText }).fill(String(value ?? ''), { timeout: 8000 });
          run.steps.push(`Filled ${target}`);
          break;
        case 'press':
          if (!key) throw new Error('press needs key.');
          if (selector || visibleText) await locatorFor(page, { selector, text: visibleText }).press(key, { timeout: 8000 });
          else await page.keyboard.press(key);
          run.steps.push(`Pressed ${key}${target ? ` in ${target}` : ''}`);
          break;
        case 'select':
          await locatorFor(page, { selector, text: visibleText }).selectOption(String(value ?? ''), { timeout: 8000 }).catch(async () => {
            await locatorFor(page, { selector, text: visibleText }).selectOption({ label: String(value ?? '') }, { timeout: 8000 });
          });
          run.steps.push(`Selected "${value}" in ${target}`);
          break;
        case 'scroll':
          await page.mouse.wheel(0, Number(value) || 1200);
          run.steps.push(`Scrolled ${Number(value) || 1200}px`);
          break;
        case 'go_back':
          await page.goBack({ timeout: 15000 }).catch(() => null);
          run.steps.push('Pressed browser Back');
          break;
        case 'wait':
          await page.waitForTimeout(Math.min(Number(value) || 1000, 15000));
          break;
        default:
          throw new Error(`Unknown action ${action}`);
      }
      await settle(page);
      return json({
        ok: true,
        url: page.url(),
        historyLength: await page.evaluate(() => history.length).catch(() => null),
        unbxdApiCallsTriggered: unbxdCallsSince(run, since),
        newConsoleErrors: run.recorder.pageErrors.length + run.recorder.consoleEntries.length - errorsBefore
      });
    }
  },

  type_in_search_box: {
    description: "Type a query into the page's search box the way a shopper does (key by key, so autosuggest fires), optionally pressing Enter. Finds the visible input via the SDK's searchBoxEl or common selectors, opening a search toggle if the input is hidden. Reports whether the autosuggest / search API fired.",
    annotations: { title: 'Type in search box', openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter afterwards (default false).' }
      },
      required: ['query']
    },
    run: async ({ query, submit = false }) => json(await typeInSearchBox(manager.current(), query, { submit }))
  },

  screenshot: {
    description: 'Screenshot the open page: the viewport (default), the full page, or one element by CSS selector. Use to see what the customer sees — misaligned dropdowns, wrong labels, empty grids.',
    annotations: { title: 'Screenshot', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of one element to capture.' },
        full_page: { type: 'boolean' }
      }
    },
    run: async ({ selector, full_page: fullPage = false }) => {
      const { page } = manager.current();
      const buf = selector
        ? await page.locator(selector).first().screenshot({ type: 'jpeg', quality: 65, timeout: 8000 })
        : await page.screenshot({ type: 'jpeg', quality: 60, fullPage });
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }] };
    }
  },

  get_page_inventory: {
    description:
      "Everything on the open page attributed to an owner: platform and theme (Shopify theme name/role, Magento vendor/theme), every script and stylesheet by source (Unbxd, theme, app/module, platform, third-party), Unbxd script tags and their order, console errors with the script that raised them, failed requests by owner, the platform's own search UI, competing search apps (Klevu, Searchspring, Boost…), and bot-protection/password pages.",
    annotations: { title: 'Page inventory', readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const run = manager.current();
      return json(await capturePageInventory(run.session, run.recorder));
    }
  },

  check_css_overrides: {
    description:
      "For one element: which stylesheet wins each layout/visibility property (display, visibility, opacity, position, size, overflow, z-index, transform…), whether that stylesheet is Unbxd's or the customer's (with file URL and selector), where customer CSS overrides a value Unbxd's CSS set, and what hides the element. Optionally the same for its clipping/transformed ancestors. This is the evidence for 'the customer's theme CSS breaks our widget'.",
    annotations: { title: 'CSS overrides', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element.' },
        ancestors: { type: 'number', description: 'Also inspect this many clipping/transformed ancestors (0-3, default 0).' }
      },
      required: ['selector']
    },
    run: async ({ selector, ancestors = 0 }) => {
      const run = manager.current();
      const base = `document.querySelector(${JSON.stringify(selector)})`;
      const targets = [{ label: selector, expression: base, expectVisible: true, role: 'element' }];
      for (let i = 0; i < Math.min(Math.max(0, ancestors), 3); i += 1) {
        targets.push({ label: `${selector} — clipping/transformed ancestor #${i + 1}`, expression: clippingAncestor(base, i), role: 'ancestor' });
      }
      return json(await captureCssProvenance(run.session, targets, { pageUrl: run.page.url() }));
    }
  },

  draft_jira_ticket: {
    description:
      'Build the internal Jira ticket body from the last triage: environment (site key, platform/theme, URL, device, browser), steps to reproduce, the automated check table, the exact Unbxd API call and status, SDK asset status, console errors by owner, CSS findings, competing widgets and known-issue matches — plus your title, root cause and fix. Returns markdown to paste into Jira (or pass to an Atlassian MCP tool if one is connected).',
    annotations: { title: 'Draft Jira ticket', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        root_cause: { type: 'string', description: '2-4 sentences, tied to the evidence.' },
        severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
        severity_reason: { type: 'string' },
        team: { type: 'string', description: 'Defaults to the team from the routing decision.' },
        expected: { type: 'string' },
        actual: { type: 'string' },
        fix: { type: 'string', description: 'Suggested fix; for config issues, the fix prompt naming {siteKey}_search.js, the key path, and current → target values.' },
        notes: { type: 'string' }
      }
    },
    run: async (input) => {
      const run = manager.run;
      const draft = buildJiraDraft(run && run.lastTriage, input);
      return text(draft.markdown);
    }
  },

  close_browser: {
    description: 'Close the browser this server opened (it also closes itself after an idle timeout). When attached to your own Chrome, only disconnects.',
    annotations: { title: 'Close browser' },
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      await manager.close();
      return text('Browser closed.');
    }
  }
};

// The extension's agent-mode toolbox, exposed as-is: same tools, same
// redaction, same size caps. Definitions are static, so read them once.
const TOOLBOX_DEFS = createToolbox({ session: null, recorder: null }).definitions;
const TOOLBOX_READ_ONLY = new Set(['list_network_requests', 'get_request_detail', 'inspect_element', 'get_sdk_config', 'search_bundle', 'get_console_errors', 'run_self_debug', 'run_autosuggest_self_debug', 'trace_rendered_value']);

function toolboxFor(run) {
  if (!run.toolbox) run.toolbox = createToolbox({ session: run.session, recorder: run.recorder });
  return run.toolbox;
}

const TOOL_LIST = [
  ...Object.entries(OWN_TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
  ...TOOLBOX_DEFS.map((d) => ({
    name: d.name,
    description: `${d.description} (Works on the page opened by triage_ui_issue / open_page.)`,
    inputSchema: d.input_schema,
    annotations: { readOnlyHint: TOOLBOX_READ_ONLY.has(d.name) }
  }))
];

/* ------------------------------------------------------------------ */
/* Prompts                                                               */
/* ------------------------------------------------------------------ */

const PROMPTS = {
  triage: {
    description: 'Triage a customer-reported Unbxd search UI issue: whose problem is it, and what to send back or file.',
    arguments: [
      { name: 'url', description: 'Customer page where the issue shows', required: true },
      { name: 'complaint', description: "The customer's complaint, verbatim", required: true },
      { name: 'search_query', description: 'Search term involved (autosuggest / search issues)', required: false },
      { name: 'device', description: 'desktop or mobile', required: false }
    ],
    build: ({ url, complaint, search_query: q, device }) =>
      [
        'A customer raised this Unbxd search UI issue. Work out whose problem it is — the customer\'s site code/CSS, the Unbxd config, the Unbxd API/SDK, or catalogue data — and produce what support needs to act on it.',
        '',
        `Page: ${url}`,
        `Customer complaint: ${complaint}`,
        q ? `Search term: ${q}` : null,
        device ? `Device: ${device}` : null,
        '',
        `1. Call triage_ui_issue with url, the complaint verbatim${q ? ', search_query' : ''}${device ? ', device' : ''}.`,
        '2. If the routing confidence is low or the evidence is thin, settle it with a few targeted follow-up calls (get_request_detail, check_css_overrides, inspect_element, search_bundle, trace_rendered_value, or interact then triage_ui_issue without url). Stop once the evidence is clear.',
        '3. Answer in the structure the triage result specifies: Decision, Why, Reply to customer, Internal Jira draft.',
        '4. If the decision is Raise internal Jira, call draft_jira_ticket with your title, root cause, severity and fix, and include its output.'
      ]
        .filter((l) => l !== null)
        .join('\n')
  }
};

/* ------------------------------------------------------------------ */
/* Server                                                                */
/* ------------------------------------------------------------------ */

const server = new Server(
  { name: 'unbxd-cx-debug', version: '0.1.0' },
  {
    capabilities: { tools: {}, prompts: {}, resources: {} },
    instructions:
      'Debugs Unbxd search UI issues on customer storefronts (Shopify, Magento, others) for the Unbxd support team. Start every investigation with triage_ui_issue (url + the customer complaint): it reproduces the issue in a real browser and returns a routing decision — revert to customer, raise an internal Jira, or need more evidence — with evidence and the answer format. Other tools inspect the same live page. Never claim a cause the evidence does not show.'
  }
);

// One browser, one page: run tool calls one at a time so a second call cannot
// replace the page under a first one that is still capturing.
let queue = Promise.resolve();
const exclusive = (fn) => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }));

server.setRequestHandler(CallToolRequestSchema, (request) =>
  exclusive(async () => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (OWN_TOOLS[name]) return await OWN_TOOLS[name].run(args);
      if (TOOLBOX_DEFS.some((d) => d.name === name)) {
        const run = manager.current();
        return json(await toolboxFor(run).run(name, args));
      }
      return { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true };
    } catch (err) {
      log(`${name} failed:`, err && err.stack ? err.stack : err);
      return { content: [{ type: 'text', text: `${name} failed: ${String((err && err.message) || err).split('\n')[0]}` }], isError: true };
    }
  })
);

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.entries(PROMPTS).map(([name, p]) => ({ name, description: p.description, arguments: p.arguments }))
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const p = PROMPTS[request.params.name];
  if (!p) throw new Error(`Unknown prompt ${request.params.name}`);
  return {
    description: p.description,
    messages: [{ role: 'user', content: { type: 'text', text: p.build(request.params.arguments || {}) } }]
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: Object.entries(DOCS).map(([file, description]) => ({
    uri: `unbxd-docs:///${file}`,
    name: file,
    description,
    mimeType: 'text/markdown'
  }))
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const file = String(request.params.uri).replace(/^unbxd-docs:\/\/\//, '');
  if (!DOCS[file]) throw new Error(`Unknown resource ${request.params.uri}`);
  return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: await readFile(path.join(REPO_ROOT, file), 'utf8') }] };
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager.close().catch(() => {});
  process.exit(code);
}

const transport = new StdioServerTransport();
transport.onclose = () => shutdown(0);
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.stdin.on('end', () => shutdown(0));

await server.connect(transport);
log(`ready (${manager.mode}; ${TOOL_LIST.length} tools)`);
