/**
 * MCP-style tool surface over the live debugger session.
 *
 * The one-shot capture answers "here is everything we thought you'd need".
 * This answers "ask for what you actually need" — the model drives the
 * investigation, the same way Chrome DevTools MCP / Playwright MCP work, but
 * against the engineer's real logged-in browser rather than a fresh automated
 * one.
 *
 * Every tool runs while the debugger is still attached, so results reflect the
 * page as it is *now*, not as it was when capture stopped.
 *
 * Boundaries (these are the same privacy rules as the one-shot path):
 *   - no cookie access, no auth headers, no raw response bodies;
 *   - responses are summarised to counts/shape by the same redaction helpers;
 *   - every result is size-capped so a tool loop cannot blow up the context.
 */
import { summariseSearchResponse, summariseAutosuggestResponse } from './strategies.js';
import { unbxdApiKind, unbxdAssetKind, isUnbxdHost } from '../shared/unbxd-endpoints.js';
import { redactedParams, truncate } from './redact.js';
import { captureSiteConfig } from './site-config.js';
import { captureSdkAssets } from './sdk-assets.js';
import { runSelfDebug, runAutosuggestSelfDebug } from './self-debug.js';
import { traceValuesInResponse } from './value-trace.js';

const MAX_RESULT_CHARS = 6000;
/** Expressions that would exfiltrate credentials rather than debug a page. */
const FORBIDDEN_EVAL = /document\s*\.\s*cookie|__proto__|\bfetch\s*\(\s*['"`]https?:\/\/(?!localhost)/i;

export function createToolbox({ session, recorder }) {
  // The customer's bundle is fetched once and reused across search_bundle calls.
  const bundleCache = new Map();

  const tools = {
    list_network_requests: {
      description:
        'List network requests recorded during the capture window. Use filter "unbxd_api" for search/category/autosuggest calls, "unbxd_assets" for the SDK JS/CSS bundles, "failed" for failures and 4xx/5xx, "all" for everything. Returns metadata only — never bodies.',
      input_schema: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: ['unbxd_api', 'unbxd_assets', 'failed', 'all'], description: 'Which subset to return.' },
          limit: { type: 'number', description: 'Max rows (default 25).' }
        },
        required: ['filter']
      },
      run: ({ filter, limit = 25 }) => {
        const all = recorder.all();
        const picked = all.filter((r) => {
          if (filter === 'unbxd_api') return Boolean(unbxdApiKind(r.rawUrl));
          if (filter === 'unbxd_assets') return Boolean(unbxdAssetKind(r.rawUrl));
          if (filter === 'failed') return r.failed || (r.status != null && r.status >= 400);
          return true;
        });
        return {
          total: picked.length,
          requests: picked.slice(-Math.min(limit, 50)).map((r) => ({
            url: r.url,
            apiKind: unbxdApiKind(r.rawUrl),
            assetKind: unbxdAssetKind(r.rawUrl),
            isUnbxd: isUnbxdHost(r.rawUrl),
            method: r.method,
            type: r.type,
            status: r.status,
            failed: r.failed,
            errorText: r.errorText,
            corsError: r.corsError,
            durationMs: r.durationMs
          }))
        };
      }
    },

    get_request_detail: {
      description:
        'Full detail for one recorded request: redacted query params, safe headers, and — for search/category/autosuggest calls — a summary of the response (counts, top-level keys, product field names, shape). Never returns the response body itself.',
      input_schema: {
        type: 'object',
        properties: {
          url_contains: { type: 'string', description: 'Substring matching the request URL, e.g. "/category" or "_search.js".' }
        },
        required: ['url_contains']
      },
      run: async ({ url_contains }) => {
        const matches = recorder.all().filter((r) => r.rawUrl.includes(url_contains));
        if (!matches.length) return { found: false, hint: 'No recorded request matched. Try list_network_requests first.' };
        const r = matches[matches.length - 1];
        const detail = {
          found: true,
          matchedCount: matches.length,
          url: r.url,
          apiKind: unbxdApiKind(r.rawUrl),
          method: r.method,
          status: r.status,
          failed: r.failed,
          errorText: r.errorText,
          durationMs: r.durationMs,
          params: redactedParams(r.rawUrl),
          requestHeaders: r.requestHeaders,
          responseHeaders: r.responseHeaders
        };
        if (unbxdApiKind(r.rawUrl)) {
          const body = await session.trySend('Network.getResponseBody', { requestId: r.requestId });
          detail.responseSummary = summariseSearchResponse(body);
        }
        return detail;
      }
    },

    evaluate_js: {
      description:
        'Evaluate a JavaScript expression in the page and return its JSON value. The main way to inspect live SDK state, e.g. "window.unbxdSearch.getProductType()", "window.UnbxdAnalyticsConf", "Object.keys(window.unbxdSearch.options)". Cookie access is refused.',
      input_schema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'A JS expression. Must evaluate to something JSON-serialisable.' }
        },
        required: ['expression']
      },
      run: async ({ expression }) => {
        if (FORBIDDEN_EVAL.test(expression)) {
          return { refused: true, reason: 'This expression touches credentials or external transport, which is outside the debugging boundary.' };
        }
        const value = await session.evaluate(`(() => { try { return (${expression}); } catch (e) { return { __evalError: String(e && e.message || e) }; } })()`);
        return { value: value === undefined ? null : value };
      }
    },

    inspect_element: {
      description:
        'Geometry and layout-relevant computed styles for a CSS selector, plus the chain of ancestors that clip (overflow) or create a stacking context. Use for alignment/visibility questions.',
      input_schema: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'A CSS selector.' } },
        required: ['selector']
      },
      run: async ({ selector }) => {
        const fn = (sel) => {
          let el;
          try {
            el = document.querySelector(sel);
          } catch {
            return { error: 'invalid selector syntax' };
          }
          if (!el) return { matchCount: 0, found: false };
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const props = ['position', 'display', 'visibility', 'opacity', 'top', 'left', 'right', 'bottom', 'width', 'height', 'max-height', 'box-sizing', 'z-index', 'overflow-x', 'overflow-y', 'transform'];
          const computed = {};
          for (const p of props) computed[p] = cs.getPropertyValue(p);
          const chain = [];
          let node = el.parentElement;
          let depth = 0;
          while (node && depth < 10) {
            const pcs = getComputedStyle(node);
            const clips = pcs.overflowX !== 'visible' || pcs.overflowY !== 'visible';
            const stacks = pcs.position !== 'static' || pcs.transform !== 'none' || pcs.filter !== 'none';
            if (clips || stacks) {
              chain.push({
                tag: node.tagName.toLowerCase(),
                id: node.id || null,
                class: String(node.className || '').slice(0, 60),
                position: pcs.position,
                overflow: `${pcs.overflowX}/${pcs.overflowY}`,
                zIndex: pcs.zIndex,
                clipsChild: clips,
                createsStackingContext: stacks
              });
            }
            node = node.parentElement;
            depth += 1;
          }
          return {
            found: true,
            matchCount: document.querySelectorAll(sel).length,
            tag: el.tagName.toLowerCase(),
            rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
            computed,
            clippingOrStackingAncestors: chain
          };
        };
        return session.evaluate(`(${fn.toString()})(${JSON.stringify(selector)})`);
      }
    },

    get_sdk_config: {
      description:
        "The customer's resolved runtime Unbxd config read off the live instance, plus which config element selectors actually match the DOM, plus bundle markers and site-key consistency. Authoritative — prefer it over guessing from the bundle text.",
      input_schema: { type: 'object', properties: {} },
      run: async () => {
        const cfg = await captureSiteConfig(session, recorder, { includeCss: true });
        return {
          liveConfig: cfg.liveConfig,
          consistency: cfg.consistency,
          assetUrls: cfg.assetUrls,
          bundleMarkers: (cfg.bundleReview.find((b) => b.bundleMarkers) || {}).bundleMarkers || null,
          note: cfg.note
        };
      }
    },

    search_bundle: {
      description:
        "Regex-search the customer's {siteKey}_search.js (or _search.css) bundle and return matching snippets with surrounding context. Use to find how a config value is produced, e.g. \"productType\\\\s*[:=]\" or \"setCategoryId\". The bundle also contains the SDK library and its demo defaults, so confirm anything you find against get_sdk_config.",
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression source.' },
          asset: { type: 'string', enum: ['search.js', 'search.css', 'autosuggest.js', 'autosuggest.css'], description: 'Which bundle (default search.js).' },
          context_chars: { type: 'number', description: 'Characters of context either side (default 160, max 400).' },
          max_matches: { type: 'number', description: 'Default 5, max 12.' }
        },
        required: ['pattern']
      },
      run: async ({ pattern, asset = 'search.js', context_chars = 160, max_matches = 5 }) => {
        const url = findAssetUrl(recorder, asset);
        if (!url) return { found: false, reason: `No ${asset} bundle was observed loading. Try list_network_requests with filter "unbxd_assets".` };

        let text = bundleCache.get(url);
        if (text === undefined) {
          try {
            const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
            text = res.ok ? await res.text() : '';
          } catch (err) {
            return { found: false, reason: `Fetch failed: ${String(err && err.message)}` };
          }
          bundleCache.set(url, text);
        }
        if (!text) return { found: false, reason: 'Bundle could not be fetched.' };

        let re;
        try {
          re = new RegExp(pattern, 'gi');
        } catch (err) {
          return { error: `Invalid regex: ${String(err && err.message)}` };
        }

        const ctx = Math.min(Math.max(20, context_chars), 400);
        const cap = Math.min(Math.max(1, max_matches), 12);
        const snippets = [];
        let m;
        while ((m = re.exec(text)) !== null && snippets.length < cap) {
          snippets.push({
            index: m.index,
            snippet: text.slice(Math.max(0, m.index - ctx), m.index + m[0].length + ctx).replace(/\s+/g, ' ')
          });
          if (m.index === re.lastIndex) re.lastIndex += 1;
        }
        return { url, bundleBytes: text.length, matchCount: snippets.length, truncatedAtCap: snippets.length === cap, snippets };
      }
    },

    set_viewport: {
      description:
        'Override the viewport so responsive layout re-evaluates (real media queries, real re-render) — the CDP mechanism Playwright\'s own resize uses. Use to reproduce mobile-only layout bugs. Pass reset:true to clear the override.',
      input_schema: {
        type: 'object',
        properties: {
          width: { type: 'number', description: 'CSS pixels, e.g. 375 for mobile, 1440 for desktop.' },
          height: { type: 'number' },
          mobile: { type: 'boolean', description: 'Emulate a mobile device (touch, device pixel ratio).' },
          reset: { type: 'boolean', description: 'Clear the override and restore the real viewport.' }
        }
      },
      run: async ({ width = 390, height = 844, mobile = true, reset = false }) => {
        if (reset) {
          await session.trySend('Emulation.clearDeviceMetricsOverride');
          return { reset: true, ...(await readViewport(session)) };
        }
        const res = await session.trySend('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: mobile ? 2 : 1,
          mobile
        });
        if (res && res.__error) return { ok: false, error: res.__error };
        // Let media queries settle before reporting.
        await new Promise((r) => setTimeout(r, 350));
        return { ok: true, applied: { width, height, mobile }, ...(await readViewport(session)) };
      }
    },

    reload_page: {
      description: 'Reload the page and wait for load. Use when evidence of page-load behaviour (SDK init, first API call, URL rewriting) is missing from the capture.',
      input_schema: { type: 'object', properties: {} },
      run: async () => {
        const before = recorder.all().length;
        const result = await session.reload();
        return { ...result, requestsBefore: before, requestsAfter: recorder.all().length };
      }
    },

    get_console_errors: {
      description: 'Console errors and warnings recorded during the capture window, plus uncaught page exceptions.',
      input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
      run: ({ limit = 20 }) => ({
        entries: [...recorder.consoleEntries, ...recorder.pageErrors].slice(-Math.min(limit, 40))
      })
    },

    run_self_debug: {
      description:
        "Re-run the extension's deterministic check suite against the page as it is now (bundles loaded, SDK initialised, page type vs endpoint, the typed query reaching the API, browse target vs UnbxdAnalyticsConf.page, attribute mapping, selectors, rendering). Returns ordered pass/fail verdicts.",
      input_schema: { type: 'object', properties: {} },
      run: async () => {
        const cfg = await captureSiteConfig(session, recorder, { includeCss: false });
        const apiReq = recorder
          .all()
          .filter((r) => ['search', 'category'].includes(unbxdApiKind(r.rawUrl)))
          .pop();
        let responseSummary = null;
        if (apiReq) {
          const body = await session.trySend('Network.getResponseBody', { requestId: apiReq.requestId });
          responseSummary = summariseSearchResponse(body);
        }
        const rendered = await session.evaluate(`(() => {
          const c = (s) => { try { return document.querySelectorAll(s).length; } catch { return 0; } };
          return { domProductNodeCounts: { '[class*="product" i]': c('[class*="product" i]'), '[class*="UNX" i]': c('[class*="UNX" i]') },
                   bodyClasses: (document.body.className||'').slice(0,200),
                   visibleNoResultsText: /no results|0 results/i.test(document.body.innerText.slice(0,20000)) };
        })()`);
        return runSelfDebug(session, {
          sdkAssets: captureSdkAssets(recorder),
          siteConfig: cfg,
          searchRequest: apiReq
            ? { apiType: unbxdApiKind(apiReq.rawUrl), params: redactedParams(apiReq.rawUrl) }
            : null,
          responseSummary,
          renderedPage: rendered,
          apiCallCounts: null,
          reloaded: true
        });
      }
    },

    run_autosuggest_self_debug: {
      description:
        "Re-run the autosuggest-data check suite (distinct from run_self_debug, which is for search/category results pages): was the autosuggest API triggered, was popularProducts.count actually requested, did the response return products, and were they rendered in the dropdown. Use this — not run_self_debug — for \"autosuggest isn't showing popular products / keyword suggestions\" complaints.",
      input_schema: { type: 'object', properties: {} },
      run: async () => {
        const apiReq = recorder.all().filter((r) => unbxdApiKind(r.rawUrl) === 'autosuggest').pop();
        let requestedParams = {};
        let responseSummary = null;
        if (apiReq) {
          requestedParams = redactedParams(apiReq.rawUrl);
          const body = await session.trySend('Network.getResponseBody', { requestId: apiReq.requestId });
          responseSummary = summariseAutosuggestResponse(body, requestedParams);
        }
        const rendered = await session.evaluate(`(() => {
          const c = (s) => { try { return document.querySelectorAll(s).length; } catch { return 0; } };
          return { dropdownFound: true, popularProductNodeCounts: { '[class*="product" i]': c('[class*="product" i]'), '[class*="popular" i]': c('[class*="popular" i]') } };
        })()`);
        return runAutosuggestSelfDebug(session, {
          sdkAssets: captureSdkAssets(recorder),
          autosuggestRequest: apiReq
            ? { url: apiReq.url, params: requestedParams, status: apiReq.status, failed: apiReq.failed, errorText: apiReq.errorText }
            : null,
          responseSummary,
          rendered,
          reloaded: true
        });
      }
    },

    trace_rendered_value: {
      description:
        'Trace a value visible in the UI back to the API field that produced it, and to the template that draws it. Give it the text you can see (e.g. "2 for $12") and/or a field name. Returns which response field contains that value, which attributesMap alias the template reads it through, and matching snippets from the customer bundle. Use this for any "where does this value come from / why is this label wrong" question instead of guessing from field names.',
      input_schema: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'Text as rendered in the UI, e.g. "2 for $12".' },
          field: { type: 'string', description: 'Optionally a response field name to look up directly, e.g. "label_product_page_label".' }
        }
      },
      run: async ({ value, field }) => {
        // Response side: which field holds the value.
        const apiReq = recorder
          .all()
          .filter((r) => ['search', 'category', 'autosuggest'].includes(unbxdApiKind(r.rawUrl)))
          .pop();
        let responseTrace = null;
        let requestedFields = [];
        if (apiReq) {
          try {
            const f = new URL(apiReq.rawUrl).searchParams.get('fields');
            requestedFields = f ? f.split(',').map((x) => x.trim()) : [];
          } catch {
            /* ignore */
          }
          const body = await session.trySend('Network.getResponseBody', { requestId: apiReq.requestId });
          const raw = body && !body.__error ? (body.base64Encoded ? atob(body.body) : body.body) : '';
          const targets = [value, field].filter(Boolean);
          if (targets.length) responseTrace = traceValuesInResponse(raw, targets, { requestedFields });
        }

        // Config side: which alias maps to the field.
        const cfg = await captureSiteConfig(session, recorder, { includeCss: false, waitForSdk: false });
        const attributesMap =
          (cfg.liveConfig && cfg.liveConfig.options && cfg.liveConfig.options.products &&
            cfg.liveConfig.options.products.attributesMap) || null;

        // Template side: where the bundle mentions the field or its alias.
        const fieldsToFind = new Set();
        if (field) fieldsToFind.add(field);
        for (const t of (responseTrace && responseTrace.traced) || []) {
          for (const f of t.fields || []) {
            fieldsToFind.add(f.field);
            for (const a of f.mappedToAliases || []) fieldsToFind.add(a);
          }
        }
        if (attributesMap) {
          for (const [alias, target] of Object.entries(attributesMap)) {
            if (fieldsToFind.has(target)) fieldsToFind.add(alias);
          }
        }

        const bundleUsage = [];
        for (const name of [...fieldsToFind].slice(0, 4)) {
          const hit = await tools.search_bundle.run({ pattern: name, max_matches: 2, context_chars: 220 });
          if (hit && hit.snippets && hit.snippets.length) {
            bundleUsage.push({ name, matchCount: hit.matchCount, snippets: hit.snippets });
          }
        }

        return {
          responseTrace,
          attributesMap,
          bundleUsage,
          howToRead:
            'responseTrace names the field carrying the value. attributesMap shows the alias the template destructures it as. bundleUsage shows the markup. Element ids in customer templates are usually the product uniqueId, so an id in the pasted element pins the exact product. A value rendered with no matching response field is produced client-side (a template literal, a fallback, or another script on the page) — say so rather than inventing a field.'
        };
      }
    }
  };

  const definitions = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: t.input_schema
  }));

  async function run(name, input) {
    const tool = tools[name];
    if (!tool) return { error: `Unknown tool "${name}".` };
    try {
      const result = await tool.run(input || {});
      const json = JSON.stringify(result);
      if (json.length > MAX_RESULT_CHARS) {
        return {
          truncated: true,
          note: `Result was ${json.length} chars; truncated to ${MAX_RESULT_CHARS}. Narrow the request (smaller limit, tighter selector or pattern).`,
          partial: JSON.parse(safeTrim(json, MAX_RESULT_CHARS))
        };
      }
      return result;
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  }

  return { definitions, run, toolNames: Object.keys(tools) };
}

/* helpers ------------------------------------------------------------- */

function findAssetUrl(recorder, kind) {
  for (const r of [...recorder.all()].reverse()) {
    if (unbxdAssetKind(r.rawUrl) === kind) return r.rawUrl;
  }
  // Fall back to the combined bundle, which serves both search and autosuggest.
  for (const r of [...recorder.all()].reverse()) {
    const k = unbxdAssetKind(r.rawUrl);
    if (k && k.endsWith(kind.endsWith('.css') ? '.css' : '.js')) return r.rawUrl;
  }
  return null;
}

async function readViewport(session) {
  return {
    viewport: await session.evaluate('({ innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio })')
  };
}

/** Trim a JSON string back to something that still parses. */
function safeTrim(json, max) {
  let cut = json.slice(0, max);
  for (let i = cut.length; i > 0; i -= 1) {
    const candidate = `${cut.slice(0, i)}"}`;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* keep shrinking */
    }
  }
  return truncate(json, max);
}
