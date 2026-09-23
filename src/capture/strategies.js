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
import { runSelfDebug, runAutosuggestSelfDebug } from './self-debug.js';
import { extractCandidateValues, traceValuesInResponse } from './value-trace.js';

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

/** The `contentType:"x"` value a tabbed storefront filters by. */
function filterValueOf(rawUrl) {
  try {
    const f = new URL(rawUrl).searchParams.get('filter');
    if (!f) return null;
    const m = f.match(/contentType\s*:\s*"?([\w-]+)"?/i);
    return m ? m[1] : f.slice(0, 80);
  } catch {
    return null;
  }
}

/**
 * Chooses which captured call the analysis is about.
 *
 * Tabbed storefronts construct one SDK instance per tab and fire one call each
 * on load — Lindt runs products/recipes/other, split only by
 * `filter=contentType:"…"` on otherwise identical requests. Taking the last
 * call would analyse whichever tab happened to fire last rather than the one
 * the engineer is looking at, so match the page's own tab when we can tell.
 * The tab comes from the URL: Lindt uses a `/tab/<name>` path segment and
 * drops the query param for the default tab, so both shapes are checked.
 */
function pickPrimaryCall(candidates, pageTab) {
  if (!candidates.length) return null;
  const tab = (pageTab && (pageTab.queryTab || pageTab.pathTab)) || null;
  if (tab) {
    // "products" tab ↔ contentType:"product": tolerate the plural/singular gap.
    const singular = tab.replace(/s$/, '');
    const match = candidates.find((r) => {
      const v = filterValueOf(r.rawUrl);
      return v && (v === tab || v === singular || v.replace(/s$/, '') === singular);
    });
    if (match) return match;
  }
  return candidates[candidates.length - 1];
}

async function captureResultsPage(session, recorder, options = {}) {
  const { prefer, includeSiteConfig = true, reloaded = false } = options;
  const all = recorder.all().filter((r) => srpApiKind(r));
  const preferred = prefer ? all.filter((r) => srpApiKind(r) === prefer) : [];
  const candidates = preferred.length ? preferred : all;
  const pageTab = await session.evaluate(`(() => {
    try {
      const m = location.pathname.match(/\\/tab\\/([a-z0-9_-]+)/i);
      return { pathTab: m ? m[1] : null, queryTab: new URLSearchParams(location.search).get('tab') };
    } catch { return null; }
  })()`);
  const primary = pickPrimaryCall(candidates, pageTab);

  let response = null;
  let valueTrace = null;
  if (primary) {
    const body = await session.trySend('Network.getResponseBody', { requestId: primary.requestId });
    response = summariseSearchResponse(body);
    // "Where does this rendered value come from?" — engineers paste the
    // element, so trace anything quotable in their description back to the
    // response field that produced it.
    const candidates = extractCandidateValues(options.description);
    if (candidates.length) {
      const raw = body && !body.__error ? (body.base64Encoded ? safeAtob(body.body) : body.body) : '';
      valueTrace = traceValuesInResponse(raw, candidates, {
        requestedFields: (redactedParams(primary.rawUrl).fields || '').split(',').map((f) => f.trim()).filter(Boolean),
        attributesMap: null
      });
    }
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

  const searchRequest = primary
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
    : null;

  const apiCallCounts = {
    search: all.filter((r) => srpApiKind(r) === 'search').length,
    category: all.filter((r) => srpApiKind(r) === 'category').length,
    note: 'More than one call per page load points at double initialisation or a manual getResults()/getCategoryPage() on top of the automatic one — OR a tabbed storefront running one instance per tab. Check allApiCalls[].filter first: distinct contentType filters mean separate tabs, which is by design.'
  };

  // Every captured call with the filter that distinguishes it, so a tabbed
  // page reads as "three tabs" rather than "three mystery duplicate calls".
  const allApiCalls = all.map((r) => ({
    apiType: srpApiKind(r),
    filter: filterValueOf(r.rawUrl),
    status: r.status,
    isPrimary: primary ? r.requestId === primary.requestId : false
  }));

  const siteConfig = includeSiteConfig ? await captureSiteConfig(session, recorder, { includeCss: true }) : undefined;

  // The trace ran before the live config was read, so fill in the alias link
  // now that attributesMap is known — that is the step that turns
  // "label_product_page_label" into "the template reads it as unxLabelName".
  if (valueTrace && valueTrace.traced && siteConfig) {
    const map = siteConfig.liveConfig?.options?.products?.attributesMap;
    if (map && typeof map === 'object') {
      for (const t of valueTrace.traced) {
        for (const f of t.fields || []) {
          f.mappedToAliases = Object.keys(map).filter((alias) => map[alias] === f.field);
        }
      }
    }
  }

  // The self-debug pass runs last: it reads the live SDK and turns everything
  // above into ordered pass/fail verdicts, so the model leads with a diagnosis
  // instead of re-deriving one from raw data.
  const selfDebug = await runSelfDebug(session, {
    sdkAssets: captureSdkAssets(recorder),
    siteConfig,
    searchRequest,
    responseSummary: response,
    renderedPage: rendered,
    apiCallCounts,
    reloaded
  });

  return {
    selfDebug,
    searchRequest,
    searchRequestFound: Boolean(primary),
    valueTrace,
    pageTab,
    allApiCalls,
    apiCallCounts,
    otherSearchCalls: candidates
      .slice(0, -1)
      .map((r) => ({ url: r.url, apiType: srpApiKind(r), status: r.status }))
      .slice(-5),
    responseSummary: response,
    renderedPage: rendered,
    siteConfig,
    failedRequests: recorder.problems().slice(0, 8).map(compactRequest),
    consoleErrors: [...recorder.consoleEntries, ...recorder.pageErrors]
      .filter((c) => c.level === 'error')
      .slice(-10)
  };
}

const captureSrp = (session, recorder, options = {}) =>
  captureResultsPage(session, recorder, { prefer: 'search', reloaded: options.reloaded, description: options.description });
const capturePlp = (session, recorder, options = {}) =>
  captureResultsPage(session, recorder, { prefer: 'category', reloaded: options.reloaded, description: options.description });

/**
 * Turn a search response body into counts + shape. The catalogue data itself
 * (titles, prices, images) is never forwarded — only field names and counts.
 */
export function summariseSearchResponse(bodyResult) {
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
/* Autosuggest data (popular products / keyword suggestions missing)       */
/* --------------------------------------------------------------------- */

/**
 * Sections of the autosuggest response, keyed by the request param prefix
 * that controls them (popularProducts.count, keywordSuggestions.count, etc.
 * — confirmed from a real production request; see SKILLS.md). We have not
 * captured a live autosuggest *response* to pin down its exact JSON shape, so
 * this stays tolerant of a few plausible shapes per section (a bare array, an
 * object with .products, an object with .suggestions) and always reports
 * topLevelKeys/responseKeys too — read those directly if a section here comes
 * back empty when it shouldn't.
 */
/**
 * Doctype values the autosuggest API uses. Per AUTOSUGGEST_SDK_REFERENCE.md §5,
 * the API returns **one flat `response.products[]` array** and the SDK's
 * `getSortedProducts()` groups it by each item's `doctype` — there are no
 * named sections in the payload. Reading it as named sections (as this once
 * did) reports zero popular products on a response that is full of them.
 */
const DOCTYPE_SECTIONS = {
  POPULAR_PRODUCTS: 'popularProducts',
  KEYWORD_SUGGESTION: 'keywordSuggestions',
  IN_FIELD: 'inFields',
  PROMOTED_SUGGESTION: 'promotedSuggestions',
  TOP_SEARCH_QUERIES: 'topQueries'
};

/** Legacy/structured shape, kept as a fallback — the reference notes the
 *  source SDK and the minified bundle disagree about `initialRequestProducts`,
 *  so both shapes are handled rather than assuming one. */
const NAMED_SECTIONS = ['popularProducts', 'keywordSuggestions', 'topQueries', 'promotedSuggestion', 'inFields'];

export function summariseAutosuggestResponse(bodyResult, requestedParams = {}) {
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

  const resp = json.response && typeof json.response === 'object' ? json.response : json;
  const sections = {};
  let shape = 'unknown';

  // Primary: the documented flat array grouped by doctype.
  const flat = Array.isArray(resp.products) ? resp.products : null;
  const doctypeCounts = {};
  if (flat) {
    shape = 'flat products[] grouped by doctype (documented shape)';
    for (const item of flat) {
      const dt = item && item.doctype ? String(item.doctype) : 'UNKNOWN';
      doctypeCounts[dt] = (doctypeCounts[dt] || 0) + 1;
    }
    for (const [doctype, key] of Object.entries(DOCTYPE_SECTIONS)) {
      const items = flat.filter((i) => i && i.doctype === doctype);
      if (!items.length && !(doctype in doctypeCounts)) continue;
      sections[key] = {
        present: true,
        via: `doctype ${doctype}`,
        count: items.length,
        sampleShape: items[0] ? shapeOf(items[0], 0, { maxDepth: 2, sampleStrings: false }) : null
      };
    }
  }

  // Fallback: a structured object with named sections.
  for (const name of NAMED_SECTIONS) {
    if (sections[name]) continue;
    const val = resp[name] ?? json[name];
    if (val === undefined) continue;
    const list = Array.isArray(val) ? val : Array.isArray(val?.products) ? val.products : null;
    if (shape === 'unknown') shape = 'named sections (non-standard / structured shape)';
    sections[name] = {
      present: true,
      via: 'named section',
      count: Array.isArray(list) ? list.length : typeof val?.numberOfProducts === 'number' ? val.numberOfProducts : null,
      sampleShape: list && list[0] ? shapeOf(list[0], 0, { maxDepth: 2, sampleStrings: false }) : null
    };
  }

  return {
    available: true,
    parsed: true,
    byteLength: raw.length,
    responseShape: shape,
    totalProducts: flat ? flat.length : null,
    doctypeCounts,
    topLevelKeys: Object.keys(json).slice(0, 20),
    responseKeys: resp !== json ? Object.keys(resp).slice(0, 20) : null,
    sections,
    requestedPopularProductsCount: requestedParams['popularProducts.count'] ?? null,
    requestedPopularProductsFilter: requestedParams['popularProducts.filter'] ?? null,
    errorField: json.error || json.message || null,
    note: 'Per AUTOSUGGEST_SDK_REFERENCE.md, the API returns a single response.products[] array; doctypeCounts is the authoritative breakdown. POPULAR_PRODUCTS present with a zero popularProducts section would mean a parsing problem here, not an API one.'
  };
}

async function captureAutosuggestData(session, recorder, options = {}) {
  const candidates = recorder.all().filter((r) => unbxdApiKind(r.rawUrl) === 'autosuggest');
  const primary = candidates[candidates.length - 1] || null;

  let response = null;
  let requestedParams = {};
  let valueTrace = null;
  if (primary) {
    requestedParams = redactedParams(primary.rawUrl);
    const body = await session.trySend('Network.getResponseBody', { requestId: primary.requestId });
    response = summariseAutosuggestResponse(body, requestedParams);
    const candidates = extractCandidateValues(options.description);
    if (candidates.length) {
      const raw = body && !body.__error ? (body.base64Encoded ? safeAtob(body.body) : body.body) : '';
      valueTrace = traceValuesInResponse(raw, candidates, { requestedFields: [], attributesMap: null });
    }
  }

  // Scope the DOM check to the autosuggest dropdown when we can find it —
  // reusing the alignment strategy's own candidate selectors — so a product
  // grid elsewhere on the page (e.g. a "popular now" widget) doesn't produce
  // a false PASS.
  const rendered = await session.evaluate(`(() => {
    const dropdownSelectors = ${JSON.stringify(DROPDOWN_CANDIDATES)};
    let dropdown = null;
    for (const sel of dropdownSelectors) {
      try { dropdown = document.querySelector(sel); } catch { dropdown = null; }
      if (dropdown) break;
    }
    const scope = dropdown || document;
    const count = (sel) => { try { return scope.querySelectorAll(sel).length; } catch { return 0; } };
    const productish = ['[class*="product" i]', '[class*="popular" i]', '[data-product-id]', '[class*="UNX" i]'];
    const counts = {};
    for (const sel of productish) counts[sel] = count(sel);
    return {
      dropdownFound: Boolean(dropdown),
      dropdownVisible: dropdown ? dropdown.offsetWidth > 0 && dropdown.offsetHeight > 0 : false,
      popularProductNodeCounts: counts
    };
  })()`);

  const siteConfig = await captureSiteConfig(session, recorder, { includeCss: true });

  const autosuggestRequest = primary
    ? {
        url: primary.url,
        method: primary.method,
        params: requestedParams,
        status: primary.status,
        failed: primary.failed,
        errorText: primary.errorText,
        durationMs: primary.durationMs,
        responseHeaders: primary.responseHeaders
      }
    : null;

  const selfDebug = await runAutosuggestSelfDebug(session, {
    sdkAssets: captureSdkAssets(recorder),
    autosuggestRequest,
    responseSummary: response,
    rendered,
    reloaded: options.reloaded
  });

  return {
    selfDebug,
    valueTrace,
    autosuggestRequest,
    autosuggestRequestFound: Boolean(primary),
    responseSummary: response,
    rendered,
    siteConfig,
    failedRequests: recorder.problems().slice(0, 8).map(compactRequest),
    consoleErrors: [...recorder.consoleEntries, ...recorder.pageErrors].filter((c) => c.level === 'error').slice(-10)
  };
}

/* --------------------------------------------------------------------- */

const STRATEGIES = {
  autosuggest_alignment: captureAutosuggest,
  autosuggest_data: captureAutosuggestData,
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
    // Computed here rather than expected on the record: it tells the model
    // whether a failing request was Unbxd's own host or the customer's, which
    // is the first split when failedRequests is non-empty.
    isUnbxd: isUnbxdHost(r.rawUrl),
    requestHeaders: r.requestHeaders,
    responseHeaders: r.responseHeaders
  };
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


function round(n) {
  return typeof n === 'number' ? Math.round(n * 10) / 10 : n;
}
