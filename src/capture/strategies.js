/** Per-issue-type capture strategies.
 *
 *  Each strategy returns a plain JSON object that the prompt builder turns into
 *  a prompt section. A strategy must only capture what its own issue type needs:
 *  no DOM geometry for SRP, no API payloads for alignment. That separation is
 *  the whole point of having separate strategies.
 *
 *  The one deliberate exception is `sdkAssets` (see runStrategy below): a fixed,
 *  small "did search.js/autosuggest.js/their CSS load" check that runs for
 *  every issue type, because a broken SDK bundle explains almost any symptom.
 *  It reports load status/timing for known Unbxd asset URLs only — never page
 *  data — so it doesn't reopen the per-type payload boundary.
 */
import { getIssueType } from '../shared/issue-types.js';
import { redactUrl, redactedParams, shapeOf, truncate } from './redact.js';
import { unbxdApiKind, isUnbxdHost } from '../shared/unbxd-endpoints.js';
import { captureSdkAssets } from './sdk-assets.js';
import { captureSiteConfig } from './site-config.js';

/* --------------------------------------------------------------------- */
/* Proxy / VPN / access                                                    */
/* --------------------------------------------------------------------- */

const NETWORK_ERROR_SIGNATURES = [
  { match: /ERR_NAME_NOT_RESOLVED|ERR_DNS/i, signal: 'dns_failure', note: 'DNS resolution failed — typical of split-tunnel VPN or an internal-only hostname.' },
  { match: /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_CONNECTION_RESET/i, signal: 'timeout', note: 'Connection timed out or was reset — corporate proxy or firewall dropping the route.' },
  { match: /ERR_CERT|ERR_SSL/i, signal: 'tls_interception', note: 'Certificate/TLS error — a TLS-intercepting proxy without its root CA trusted.' },
  { match: /ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/i, signal: 'client_blocked', note: 'Blocked locally by an extension or enterprise policy.' },
  { match: /ERR_PROXY|ERR_TUNNEL_CONNECTION_FAILED/i, signal: 'proxy_failure', note: 'Proxy tunnel failed outright.' },
  { match: /ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED/i, signal: 'connection_closed', note: 'Server or middlebox closed the connection without responding.' }
];

/** Body-less markers that a geo/WAF block returned an HTML page with 2xx/4xx. */
const GEO_BLOCK_STATUS = [403, 451, 429];

function classifyNetwork(requests) {
  const signals = new Set();
  const notes = [];
  for (const r of requests) {
    if (r.corsError) {
      signals.add('cors');
      notes.push(`CORS ${r.corsError} on ${hostOf(r.url)}`);
    }
    if (r.blockedReason) {
      signals.add('blocked');
      notes.push(`blocked (${r.blockedReason}) on ${hostOf(r.url)}`);
    }
    if (r.errorText) {
      for (const sig of NETWORK_ERROR_SIGNATURES) {
        if (sig.match.test(r.errorText)) {
          signals.add(sig.signal);
          notes.push(`${r.errorText} on ${hostOf(r.url)} — ${sig.note}`);
        }
      }
    }
    if (GEO_BLOCK_STATUS.includes(r.status)) {
      signals.add('http_block');
      const server = (r.responseHeaders && (r.responseHeaders.server || r.responseHeaders['cf-ray'])) || '';
      notes.push(`HTTP ${r.status} from ${hostOf(r.url)}${server ? ` (edge: ${truncate(server, 40)})` : ''}`);
    }
    if (r.status === 0 && !r.failed) signals.add('opaque_response');
  }
  return { signals: [...signals], notes: dedupe(notes).slice(0, 25) };
}

/** Is the failure isolated to Unbxd's own infrastructure, or is the whole page
 *  unreachable? This is the single most useful split for this issue type: an
 *  engineer's VPN/proxy usually breaks everything, while a scoped block
 *  (CORS misconfig, WAF rule) usually breaks only the Unbxd API/asset calls. */
function unbxdFailureScope(problems) {
  if (!problems.length) return 'none';
  const unbxdFailing = problems.filter((r) => r.isUnbxd);
  if (unbxdFailing.length === 0) return 'unbxd_unaffected';
  if (unbxdFailing.length === problems.length) return 'unbxd_only';
  return 'mixed';
}

async function captureProxy(session, recorder) {
  const problems = recorder.problems().map((r) => ({ ...r, isUnbxd: isUnbxdHost(r.rawUrl) }));
  const classification = classifyNetwork(problems);
  const env = await session.evaluate(`(() => ({
    origin: location.origin,
    onLine: navigator.onLine,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    languages: navigator.languages,
    protocol: location.protocol
  }))()`);

  return {
    environment: env,
    classification,
    unbxdFailureScope: unbxdFailureScope(problems),
    failedRequests: problems.slice(0, 20).map(compactRequest),
    distinctFailingHosts: dedupe(problems.map((r) => hostOf(r.url))).slice(0, 15)
  };
}

/* --------------------------------------------------------------------- */
/* Autosuggest alignment                                                   */
/* --------------------------------------------------------------------- */

const INPUT_CANDIDATES = [
  'input.unbxd-as-input', 'input[data-unbxd-search]', 'input[type="search"]',
  'input[name="q"]', 'input[name="query"]', 'input[aria-label*="search" i]',
  'input[placeholder*="search" i]'
];

const DROPDOWN_CANDIDATES = [
  '.unbxd-as-wrapper', '.unbxd-as-maincontent', '.unbxd-autosuggest',
  '[class*="autosuggest" i]', '[class*="autocomplete" i]', '[class*="typeahead" i]',
  '[role="listbox"]'
];

/** Computed properties that can explain an offset / clipping / stacking bug. */
const GEOMETRY_PROPS = [
  'position', 'display', 'visibility', 'top', 'left', 'right', 'bottom',
  'width', 'min-width', 'max-width', 'height', 'max-height', 'margin-top',
  'margin-left', 'padding-left', 'box-sizing', 'z-index', 'overflow',
  'overflow-x', 'overflow-y', 'transform', 'inset', 'float', 'direction'
];

async function captureAutosuggest(session, recorder, options = {}) {
  await session.trySend('DOM.enable');
  await session.trySend('CSS.enable');

  const inputSelector = options.inputSelector || (await firstMatching(session, INPUT_CANDIDATES));
  const dropdownSelector = options.dropdownSelector || (await firstMatching(session, DROPDOWN_CANDIDATES));

  const input = await describeNode(session, inputSelector);
  const dropdown = await describeNode(session, dropdownSelector);

  const viewport = await session.evaluate(`(() => ({
    innerWidth: innerWidth, innerHeight: innerHeight,
    devicePixelRatio: devicePixelRatio, scrollX: scrollX, scrollY: scrollY
  }))()`);

  return {
    selectorsUsed: { input: inputSelector, dropdown: dropdownSelector },
    selectorDiscovery: inputSelector && dropdownSelector ? 'ok' : 'partial — one element was not found on the page',
    viewport,
    anchorInput: input,
    dropdown,
    relativeOffset: offsetBetween(input, dropdown),
    ancestorContext: dropdownSelector ? await ancestorContext(session, dropdownSelector) : null,
    consoleErrors: recorder.consoleEntries.slice(-10)
  };
}

async function firstMatching(session, selectors) {
  const found = await session.evaluate(
    `(${((list) => list.find((sel) => {
      try { return document.querySelector(sel); } catch { return false; }
    }) || null).toString()})(${JSON.stringify(selectors)})`
  );
  return found || null;
}

/** Geometry + relevant computed styles for one element, via DOM/CSS domains. */
async function describeNode(session, selector) {
  if (!selector) return null;
  const doc = await session.trySend('DOM.getDocument', { depth: 1 });
  if (doc.__error || !doc.root) return { selector, error: 'DOM.getDocument failed' };

  const q = await session.trySend('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (q.__error || !q.nodeId) return { selector, error: 'element not found' };

  const box = await session.trySend('DOM.getBoxModel', { nodeId: q.nodeId });
  const styles = await session.trySend('CSS.getComputedStyleForNode', { nodeId: q.nodeId });
  const described = await session.trySend('DOM.describeNode', { nodeId: q.nodeId });

  const computed = {};
  if (!styles.__error) {
    for (const p of styles.computedStyle || []) {
      if (GEOMETRY_PROPS.includes(p.name)) computed[p.name] = p.value;
    }
  }

  return {
    selector,
    tag: described.node ? described.node.nodeName : null,
    attributes: described.node ? attrPairs(described.node.attributes) : null,
    box: box.__error ? null : boxToRect(box.model),
    computed
  };
}

function boxToRect(model) {
  if (!model) return null;
  const [x1, y1, x2, , , y3] = model.border;
  return {
    x: round(x1),
    y: round(y1),
    width: round(x2 - x1),
    height: round(y3 - y1),
    right: round(x2),
    bottom: round(y3),
    contentWidth: model.width,
    contentHeight: model.height
  };
}

function offsetBetween(input, dropdown) {
  if (!input || !dropdown || !input.box || !dropdown.box) return null;
  return {
    dxLeft: round(dropdown.box.x - input.box.x),
    dyTopToInputBottom: round(dropdown.box.y - input.box.bottom),
    widthDelta: round(dropdown.box.width - input.box.width),
    note: 'dxLeft/dyTopToInputBottom of 0 means the dropdown is flush under the input.'
  };
}

/** Ancestors that can clip or re-parent a positioned dropdown. */
async function ancestorContext(session, selector) {
  const fn = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const chain = [];
    let node = el.parentElement;
    let depth = 0;
    while (node && depth < 12) {
      const cs = getComputedStyle(node);
      const clips = cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      const stacks = cs.position !== 'static' || cs.transform !== 'none' ||
        cs.filter !== 'none' || cs.willChange !== 'auto' || cs.contain !== 'none';
      if (clips || stacks) {
        chain.push({
          tag: node.tagName.toLowerCase(),
          id: node.id || null,
          class: (node.className && String(node.className).slice(0, 80)) || null,
          position: cs.position,
          overflow: `${cs.overflowX}/${cs.overflowY}`,
          zIndex: cs.zIndex,
          transform: cs.transform === 'none' ? 'none' : 'set',
          clipsChild: clips,
          createsStackingContext: stacks
        });
      }
      node = node.parentElement;
      depth += 1;
    }
    return {
      parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
      attachedToBody: el.parentElement === document.body,
      clippingOrStackingAncestors: chain
    };
  };
  return session.evaluate(`(${fn.toString()})(${JSON.stringify(selector)})`);
}

/* --------------------------------------------------------------------- */
/* SRP (search results page) and PLP (category / browse page)              */
/* --------------------------------------------------------------------- */

/**
 * Only the Unbxd search and category endpoints matter for a results-page
 * capture (https://search.unbxd.io/{apiKey}/{siteKey}/search|category?...).
 * Autosuggest calls are excluded here — that's the alignment issue type's
 * territory, and it deliberately doesn't capture API data at all. Every other
 * request (analytics beacons, recs widgets, ad pixels, third-party scripts,
 * even other Unbxd endpoints) is noise and must never be forwarded as "the"
 * search call.
 */
function srpApiKind(r) {
  const kind = unbxdApiKind(r.rawUrl);
  return kind === 'search' || kind === 'category' ? kind : null;
}

/**
 * Shared by SRP and PLP: both are "the API returned X, the DOM shows Y"
 * problems over the same two endpoints. `prefer` decides which endpoint wins
 * when a page fired both (a category page that also runs a search widget).
 */
async function captureResultsPage(session, recorder, { prefer, includeSiteConfig = true } = {}) {
  const all = recorder.all().filter((r) => srpApiKind(r));
  const preferred = prefer ? all.filter((r) => srpApiKind(r) === prefer) : [];
  const candidates = preferred.length ? preferred : all;
  // The last one wins: it is the call that produced what the engineer is looking at.
  const primary = candidates[candidates.length - 1] || null;

  let response = null;
  if (primary) {
    const body = await session.trySend('Network.getResponseBody', { requestId: primary.requestId });
    response = summariseSearchResponse(body);
  }

  const rendered = await session.evaluate(`(() => {
    const count = (sel) => { try { return document.querySelectorAll(sel).length; } catch { return 0; } };
    const productish = ['[class*="product" i]','[data-product-id]','[class*="tile" i]','li[class*="item" i]','[class*="UNX" i]'];
    const counts = {};
    for (const sel of productish) counts[sel] = count(sel);
    const params = {};
    for (const [k, v] of new URLSearchParams(location.search)) params[k] = String(v).slice(0, 120);
    return {
      url: location.href.slice(0, 300),
      title: document.title.slice(0, 120),
      domProductNodeCounts: counts,
      visibleNoResultsText: /no results|0 results|nothing found/i.test(document.body.innerText.slice(0, 20000)),
      bodyTextSample: document.body.innerText.replace(/\\s+/g,' ').slice(0, 400),
      // URL/history state: the SDK rewrites the URL, and a back-button loop
      // shows up here as SDK pagination params plus a grown history stack.
      urlParams: params,
      urlHasSdkPaginationParams: ['rows','page','start','pageSize'].some((p) => p in params),
      urlHasFilterParam: Object.keys(params).some((k) => /^filter$|uFilter|^p$/i.test(k)),
      historyLength: history.length,
      bodyClasses: (document.body.className || '').slice(0, 200)
    };
  })()`);

  return {
    searchRequest: primary
      ? {
          url: primary.url,
          apiType: srpApiKind(primary),
          method: primary.method,
          params: redactedParams(primary.rawUrl),
          status: primary.status,
          failed: primary.failed,
          errorText: primary.errorText,
          durationMs: primary.durationMs,
          responseHeaders: primary.responseHeaders
        }
      : null,
    searchRequestFound: Boolean(primary),
    apiCallCounts: {
      search: all.filter((r) => srpApiKind(r) === 'search').length,
      category: all.filter((r) => srpApiKind(r) === 'category').length,
      note: 'More than one call per page load points at double initialisation or a manual getResults()/getCategoryPage() on top of the automatic one.'
    },
    otherSearchCalls: candidates
      .slice(0, -1)
      .map((r) => ({ url: r.url, apiType: srpApiKind(r), status: r.status }))
      .slice(-5),
    responseSummary: response,
    renderedPage: rendered,
    siteConfig: includeSiteConfig ? await captureSiteConfig(session, recorder, { includeCss: true }) : undefined,
    failedRequests: recorder.problems().slice(0, 8).map(compactRequest),
    consoleErrors: [...recorder.consoleEntries, ...recorder.pageErrors]
      .filter((c) => c.level === 'error')
      .slice(-10)
  };
}

const captureSrp = (session, recorder) => captureResultsPage(session, recorder, { prefer: 'search' });
const capturePlp = (session, recorder) => captureResultsPage(session, recorder, { prefer: 'category' });

/**
 * Turn a search response body into counts + shape. The catalogue data itself
 * (titles, prices, images) is never forwarded — only field names and counts.
 */
function summariseSearchResponse(bodyResult) {
  if (!bodyResult || bodyResult.__error) {
    return { available: false, reason: bodyResult ? bodyResult.__error : 'no body' };
  }
  const raw = bodyResult.base64Encoded ? safeAtob(bodyResult.body) : bodyResult.body;
  if (!raw) return { available: false, reason: 'empty body' };

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      available: true,
      parsed: false,
      byteLength: raw.length,
      note: 'Response was not JSON — possibly an HTML error/challenge page.',
      head: truncate(raw.replace(/\s+/g, ' '), 200)
    };
  }

  const resp = json.response || json.searchMetaData?.response || {};
  const products = resp.products || json.products || [];
  const facets = json.facets || json.facet_counts || json.searchMetaData?.facets || null;

  return {
    available: true,
    parsed: true,
    byteLength: raw.length,
    numberOfProducts: resp.numberOfProducts ?? resp.numFound ?? (Array.isArray(products) ? products.length : null),
    returnedProductCount: Array.isArray(products) ? products.length : 0,
    start: resp.start ?? null,
    topLevelKeys: Object.keys(json).slice(0, 20),
    productFieldNames: Array.isArray(products) && products[0] ? Object.keys(products[0]).slice(0, 40) : [],
    firstProductShape: Array.isArray(products) && products[0] ? shapeOf(products[0], 0, { maxDepth: 2, sampleStrings: false }) : null,
    facetKeys: facets ? Object.keys(facets).slice(0, 20) : null,
    redirect: json.redirect || json.searchMetaData?.redirect || null,
    didYouMean: json.didYouMean || null,
    banner: json.banner ? shapeOf(json.banner, 0, { maxDepth: 2, sampleStrings: false }) : null,
    queryParamsEcho: json.searchMetaData?.queryParams ? redactObject(json.searchMetaData.queryParams) : null,
    errorField: json.error || json.message || null
  };
}

function redactObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 25)) {
    out[k] = /key|token|secret|auth/i.test(k) ? '[redacted]' : truncate(String(v), 120);
  }
  return out;
}

function safeAtob(b64) {
  try {
    return atob(b64);
  } catch {
    return '';
  }
}

/* --------------------------------------------------------------------- */

const STRATEGIES = {
  proxy_access: captureProxy,
  autosuggest_alignment: captureAutosuggest,
  srp_ui: captureSrp,
  plp_ui: capturePlp
};

export async function runStrategy(issueTypeId, session, recorder, options) {
  const type = getIssueType(issueTypeId);
  const fn = STRATEGIES[type.id];
  const context = await fn(session, recorder, options);
  return {
    issueType: type.id,
    captureSummary: recorder.summary(),
    // Validated first, for every issue type — see sdk-assets.js.
    sdkAssets: captureSdkAssets(recorder),
    ...context
  };
}

/* helpers ------------------------------------------------------------- */

function compactRequest(r) {
  return {
    url: r.url,
    method: r.method,
    type: r.type,
    initiator: r.initiator,
    status: r.status,
    failed: r.failed,
    errorText: r.errorText,
    corsError: r.corsError,
    blockedReason: r.blockedReason,
    durationMs: r.durationMs,
    isUnbxd: r.isUnbxd,
    requestHeaders: r.requestHeaders,
    responseHeaders: r.responseHeaders
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url).slice(0, 60);
  }
}

function attrPairs(attributes = []) {
  const out = {};
  for (let i = 0; i < attributes.length; i += 2) {
    const name = attributes[i];
    if (['style', 'class', 'id', 'role', 'aria-expanded', 'hidden', 'data-unbxd-search'].includes(name)) {
      out[name] = truncate(attributes[i + 1], 120);
    }
  }
  return out;
}

function dedupe(list) {
  return [...new Set(list)];
}

function round(n) {
  return typeof n === 'number' ? Math.round(n * 10) / 10 : n;
}
