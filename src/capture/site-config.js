/**
 * Reviews the customer's Unbxd config bundle — the `{siteKey}_search.js` /
 * `_search.css` pair served from libraries.unbxdapi.com (or sandbox.unbxd.io).
 *
 * Why this is not just "grep the file": that bundle ships the whole vanilla
 * search library *plus* the customer's config *plus* their template functions
 * (~350KB minified), and the config is usually built at runtime by a
 * `createSearchConfig()`-style factory. Regexing the text mostly surfaces SDK
 * defaults (the library's own demo siteKey is in there). So:
 *
 *   liveConfig    — authoritative. The resolved `options` off the live
 *                   instance (window.unbxdSearch / unbxdSearchInstances),
 *                   plus whether each element selector actually resolves.
 *   bundleMarkers — weak signals the live object can't give: which site/env
 *                   the bundle was built for, how many instances it creates,
 *                   file size/age. Labelled as heuristics on purpose.
 *
 * Only extracted values are forwarded — never the bundle text itself.
 */
import { unbxdAssetKind, unbxdApiKind } from '../shared/unbxd-endpoints.js';
import { truncate } from './redact.js';

const MAX_FETCH_BYTES = 3_000_000;

/** Top-level `options` keys worth reading. Everything else on the instance is
 *  library internals or customer template code. Ordered roughly by how often
 *  they turn out to be the root cause (see SKILLS.md / common-issues.md). */
const CONFIG_KEYS = [
  'siteKey', 'apiKey', 'searchEndPoint', 'productType', 'searchPath',
  'searchBoxEl', 'searchButtonEl', 'searchQueryParam', 'defaultSearchQuery',
  'browseQueryParam', 'categoryId', 'productId',
  'products', 'pagination', 'pagesize', 'facet', 'sort', 'breadcrumb',
  'loader', 'banner', 'spellCheck', 'url', 'variants', 'productView',
  'unbxdAnalytics', 'onEvent'
];

export async function captureSiteConfig(session, recorder, { includeCss = true } = {}) {
  const assetUrls = await discoverAssetUrls(session, recorder);
  const liveConfig = await readLiveConfig(session);
  const bundleReview = await reviewBundles(assetUrls, { includeCss });

  return {
    assetUrls,
    liveConfig,
    bundleReview,
    consistency: checkConsistency(liveConfig, bundleReview, recorder),
    note: 'liveConfig is the resolved runtime config and is authoritative. bundleMarkers are regex heuristics over a minified bundle that also contains the SDK library itself — treat them as weak signals, and never contradict liveConfig with them.'
  };
}

/* ------------------------------------------------------------------ */
/* 1. Which bundles is this page actually using?                        */
/* ------------------------------------------------------------------ */

async function discoverAssetUrls(session, recorder) {
  const fromDom = (await session.evaluate(`(() => {
    const out = [];
    for (const s of document.querySelectorAll('script[src]')) out.push(s.src);
    for (const l of document.querySelectorAll('link[rel="stylesheet"][href]')) out.push(l.href);
    return out.slice(0, 300);
  })()`)) || [];

  const fromNetwork = recorder.all().map((r) => r.rawUrl);

  const seen = new Map();
  for (const url of [...fromDom, ...fromNetwork]) {
    const kind = unbxdAssetKind(url);
    if (!kind || seen.has(url)) continue;
    seen.set(url, { url, kind, source: fromDom.includes(url) ? 'dom' : 'network' });
  }
  const found = [...seen.values()];

  // Two script tags for the same bundle is itself a known root cause
  // ("Multiple API calls on page load" / double initialisation).
  const duplicates = found.filter((a, i) => found.findIndex((b) => b.kind === a.kind) !== i).map((a) => a.kind);

  return { found, duplicateKinds: [...new Set(duplicates)] };
}

/* ------------------------------------------------------------------ */
/* 2. The resolved runtime config (authoritative)                       */
/* ------------------------------------------------------------------ */

async function readLiveConfig(session) {
  // Built as a string so it can run inside the page. Self-contained on purpose:
  // it cannot close over anything in this module.
  const fn = (keys) => {
    const MAX_STR = 140;
    const MAX_ARR = 25;
    const selectorChecks = [];

    const describeEl = (el) => {
      try {
        const cls = (el.className && String(el.className).trim().split(/\s+/).slice(0, 3).join('.')) || '';
        return {
          __element: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`,
          connected: el.isConnected
        };
      } catch {
        return { __element: 'unreadable' };
      }
    };

    const looksLikeSelector = (key, value) =>
      /el$|El$|selector/i.test(key) && typeof value === 'string' && value.length > 0 && value.length < 200;

    // `path` is the dotted config path ("products.el"), which is what the
    // engineer has to go and edit — a bare "el" would be ambiguous across
    // products/facet/pagination/sort.
    const ser = (value, depth, key, path) => {
      if (value == null) return value === null ? null : undefined;
      const t = typeof value;
      if (t === 'function') {
        const src = Function.prototype.toString.call(value);
        return `[function ${value.name || 'anonymous'}: ${src.length} chars]`;
      }
      if (t === 'string') {
        if (looksLikeSelector(key, value)) {
          let matches = -1;
          try {
            matches = document.querySelectorAll(value).length;
          } catch {
            matches = -2; // invalid selector syntax
          }
          selectorChecks.push({ configPath: path, selector: value, matchCount: matches });
        }
        return value.length > MAX_STR ? value.slice(0, MAX_STR) + '…' : value;
      }
      if (t === 'number' || t === 'boolean') return value;
      if (t !== 'object') return String(t);

      if (typeof Element !== 'undefined' && value instanceof Element) {
        selectorChecks.push({ configPath: path, selector: '[live element reference]', matchCount: value.isConnected ? 1 : 0 });
        return describeEl(value);
      }
      if (typeof NodeList !== 'undefined' && value instanceof NodeList) {
        return { __nodeList: value.length };
      }
      if (Array.isArray(value)) {
        if (depth <= 0) return `array(${value.length})`;
        const kept = value.slice(0, MAX_ARR).map((v, i) => ser(v, depth - 1, key, `${path}[${i}]`));
        if (value.length > MAX_ARR) kept.push(`… ${value.length - MAX_ARR} more`);
        return kept;
      }
      if (depth <= 0) return 'object';
      const out = {};
      for (const k of Object.keys(value).slice(0, 40)) {
        let v;
        try {
          v = ser(value[k], depth - 1, k, `${path}.${k}`);
        } catch {
          v = '[unreadable]';
        }
        if (v !== undefined) out[k] = v;
      }
      return out;
    };

    const instances = window.unbxdSearchInstances && typeof window.unbxdSearchInstances === 'object'
      ? Object.keys(window.unbxdSearchInstances)
      : [];
    const instance =
      (window.unbxdSearch && window.unbxdSearch.options && window.unbxdSearch) ||
      (instances.length && window.unbxdSearchInstances[instances[0]]) ||
      null;

    const result = {
      constructorPresent: typeof window.UnbxdSearch === 'function',
      instanceFound: Boolean(instance && instance.options),
      instanceKeys: instances,
      instanceCount: instances.length || (window.unbxdSearch ? 1 : 0),
      analyticsConfPresent: typeof window.UnbxdAnalyticsConf !== 'undefined',
      options: null,
      selectorChecks: [],
      state: null
    };

    if (!instance || !instance.options) {
      result.reason = window.UnbxdSearch
        ? 'UnbxdSearch constructor exists but no initialised instance was found on window (window.unbxdSearch / window.unbxdSearchInstances) — the SDK may not have initialised on this page type.'
        : 'No UnbxdSearch constructor on window — the search bundle did not execute (check sdkAssets) or this page does not initialise it.';
      return result;
    }

    const opts = {};
    for (const k of keys) {
      if (k in instance.options) {
        try {
          opts[k] = ser(instance.options[k], 3, k, k);
        } catch {
          opts[k] = '[unreadable]';
        }
      }
    }
    result.options = opts;
    result.selectorChecks = selectorChecks;

    // A little live state: which page type the SDK thinks it is on, and
    // whether it currently holds results. Cheap, and it settles a lot of
    // "is it the API or the UI" arguments.
    try {
      const resp = typeof instance.getResponseObj === 'function' ? instance.getResponseObj() : null;
      const prods = (resp && (resp.response ? resp.response.products : resp.products)) || null;
      result.state = {
        productTypeOption: instance.options.productType || null,
        productsInLastResponse: Array.isArray(prods) ? prods.length : null,
        numberOfProducts: resp && resp.response ? resp.response.numberOfProducts : null,
        isLoading: instance.state ? Boolean(instance.state.isLoading) : null,
        selectedFacetCount:
          instance.state && instance.state.selectedFacets ? Object.keys(instance.state.selectedFacets).length : null
      };
    } catch (e) {
      result.state = { error: String(e && e.message ? e.message : e).slice(0, 160) };
    }

    return result;
  };

  const out = await session.evaluate(`(${fn.toString()})(${JSON.stringify(CONFIG_KEYS)})`);
  return out || { instanceFound: false, reason: 'Runtime.evaluate returned nothing (page may have navigated during capture).' };
}

/* ------------------------------------------------------------------ */
/* 3. Static bundle markers (weak signals)                              */
/* ------------------------------------------------------------------ */

async function reviewBundles({ found }, { includeCss }) {
  const reviews = [];
  for (const asset of found) {
    const isCss = asset.kind.endsWith('.css');
    if (isCss && !includeCss) continue;
    reviews.push(await reviewOne(asset, isCss));
  }
  return reviews;
}

async function reviewOne(asset, isCss) {
  let text = '';
  let fetchInfo;
  try {
    const res = await fetch(asset.url, { credentials: 'omit', cache: 'no-store' });
    fetchInfo = { status: res.status, ok: res.ok, lastModified: res.headers.get('last-modified') };
    if (res.ok) {
      text = await res.text();
      if (text.length > MAX_FETCH_BYTES) text = text.slice(0, MAX_FETCH_BYTES);
    }
  } catch (err) {
    return { url: asset.url, kind: asset.kind, fetchError: String(err && err.message ? err.message : err) };
  }

  const base = {
    url: asset.url,
    kind: asset.kind,
    source: asset.source,
    ...fetchInfo,
    bytes: text.length,
    minified: text.length > 0 && text.split('\n').length < text.length / 400
  };

  return isCss ? { ...base, cssMarkers: cssMarkers(text) } : { ...base, bundleMarkers: jsMarkers(text) };
}

function jsMarkers(js) {
  const count = (re) => (js.match(re) || []).length;
  const grab = (re) => {
    const m = js.match(re);
    return m ? m[1] : null;
  };

  return {
    builtForSiteKey: grab(/function\s+getSiteName\s*\(\s*\)\s*\{\s*return\s*["']([^"']+)["']/),
    builtForApiKey: grab(/function\s+getApiKey\s*\(\s*\)\s*\{\s*return\s*["']([^"']+)["']/),
    sdkVersion: grab(/["']?version["']?\s*[:=]\s*["'](\d+\.\d+\.\d+)["']/),
    instantiations: count(/new\s+UnbxdSearch\s*\(/g),
    hasConfigFactory: /createSearchConfig|getSearchConfig/.test(js),
    // Pagination/url flags: present in BOTH the customer config and the SDK
    // defaults inside this bundle, so these are counts, not settings. Read
    // liveConfig.options.pagination / .url for the values that actually apply.
    paginationTypeMentions: {
      FIXED_PAGINATION: count(/FIXED_PAGINATION/g),
      INFINITE_SCROLL: count(/INFINITE_SCROLL/g),
      CLICK_N_SCROLL: count(/CLICK_N_SCROLL/g)
    },
    addToUrlTrueMentions: count(/addToUrl\s*:\s*(?:!0|true)/g),
    addToUrlFalseMentions: count(/addToUrl\s*:\s*(?:!1|false)/g),
    mentionsAnalytics: /unbxdAnalytics|UnbxdAnalyticsConf/.test(js),
    platformHints: ['Magento', 'Shopify', 'Salesforce', 'BigCommerce', 'SFCC']
      .filter((p) => new RegExp(p, 'i').test(js))
      .slice(0, 3)
  };
}

/** CSS rules that can hide or displace widget output — the "API returned data
 *  but nothing is visible" class of root cause. */
function cssMarkers(css) {
  const risky = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  let ruleCount = 0;
  while ((m = ruleRe.exec(css)) !== null) {
    ruleCount += 1;
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const body = m[2];
    if (!/UNX|unbxd/i.test(selector)) continue;
    const hits = body.match(
      /(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|position\s*:\s*[a-z]+|z-index\s*:\s*-?\d+|overflow[a-z-]*\s*:\s*[a-z]+|height\s*:\s*0)/gi
    );
    if (hits && risky.length < 25) {
      risky.push({ selector: truncate(selector, 120), declarations: [...new Set(hits.map((h) => h.replace(/\s+/g, '')))] });
    }
  }
  return { ruleCount, riskyWidgetRules: risky };
}

/* ------------------------------------------------------------------ */
/* 4. Does the bundle, the live config and the actual API call agree?   */
/* ------------------------------------------------------------------ */

function checkConsistency(liveConfig, bundleReview, recorder) {
  const jsReview = bundleReview.find((b) => b.bundleMarkers);
  const bundleSiteKey = jsReview && jsReview.bundleMarkers ? jsReview.bundleMarkers.builtForSiteKey : null;
  const liveSiteKey = liveConfig && liveConfig.options ? liveConfig.options.siteKey : null;

  let requestSiteKey = null;
  let requestHost = null;
  for (const r of recorder.all()) {
    if (!unbxdApiKind(r.rawUrl)) continue;
    try {
      const u = new URL(r.rawUrl);
      const parts = u.pathname.split('/').filter(Boolean);
      requestSiteKey = parts[1] || null;
      requestHost = u.host;
    } catch {
      /* ignore */
    }
  }

  const known = [bundleSiteKey, liveSiteKey, requestSiteKey].filter(Boolean);
  const allMatch = known.length > 1 ? known.every((k) => k === known[0]) : null;

  return {
    bundleSiteKey,
    liveSiteKey,
    requestSiteKey,
    requestHost,
    allMatch,
    hint:
      allMatch === false
        ? 'The site key differs between the bundle, the running config and the API call — a wrong environment/catalogue is a strong root-cause candidate.'
        : undefined
  };
}
