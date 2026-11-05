/**
 * "What else is on this page?" — the evidence that separates an Unbxd problem
 * from a customer-site problem.
 *
 * The self-debug checks answer "is the Unbxd widget healthy?". Support also
 * needs "if not, whose code broke it?", and that needs a map of everything the
 * customer's page loads, attributed to an owner:
 *
 *   unbxd     libraries.unbxdapi.com / sandbox.unbxd.io / search.unbxd.io, or an
 *             Unbxd platform module (Magento `Unbxd_*` static path, an asset
 *             with "unbxd" in its path)
 *   customer  everything else the storefront serves: the theme (Shopify
 *             `/t/{id}/assets/`, Magento `/static/frontend/{Vendor}/{theme}/`),
 *             installed apps/modules, the platform runtime, inline scripts, and
 *             third-party tags the customer added (GTM, chat, reviews…)
 *
 * Third-party tags are "customer" for routing purposes — the customer chose to
 * install them and is the one who can remove them — but the `source` field
 * keeps the distinction so the reply can say "your theme" vs "the Klevu app".
 *
 * Privacy: only asset URLs (redacted), console error text the page itself
 * printed, and platform/theme names. No page data, no cookies, no bodies.
 */
import { unbxdApiKind, unbxdAssetKind, isUnbxdHost } from '../shared/unbxd-endpoints.js';
import { redactUrl, truncate } from './redact.js';

/* ------------------------------------------------------------------ */
/* Origin attribution (pure — unit tested)                              */
/* ------------------------------------------------------------------ */

const MULTI_PART_TLD = /\.(co|com|net|org|gov|ac|edu|ne|or)\.[a-z]{2}$/i;

/** "shop.example.co.uk" → "example.co.uk". Naive on purpose: good enough to
 *  tell the storefront's own hosts from third parties. */
export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  return parts.slice(MULTI_PART_TLD.test(h) ? -3 : -2).join('.');
}

/**
 * Search vendors whose presence next to Unbxd is itself a finding: an old
 * search app that was never uninstalled competes for the same search box and
 * results container. Matched on script host/path and on DOM markers.
 */
export const COMPETING_SEARCH_VENDORS = [
  { vendor: 'Klevu', re: /klevu/i, dom: '[class*="klevu" i], [id*="klevu" i]' },
  { vendor: 'Searchspring', re: /searchspring/i, dom: '[class*="searchspring" i], [id*="searchspring" i]' },
  { vendor: 'Searchanise', re: /searchanise|snize/i, dom: '.snize, [class*="snize-"], [id*="snize"]' },
  { vendor: 'Boost Commerce', re: /boost-?commerce|boost-sd|bc-sf-filter/i, dom: '[class*="boost-sd"], [class*="boost-pfs"], [class*="bc-sf-filter"]' },
  { vendor: 'Algolia', re: /algolia/i, dom: '.aa-Panel, .aa-Autocomplete, .ais-InstantSearch' },
  { vendor: 'Doofinder', re: /doofinder/i, dom: '[class*="doofinder" i], [id*="doofinder" i], .dfd-root' },
  { vendor: 'Findify', re: /findify/i, dom: '[class*="findify" i]' },
  { vendor: 'Fast Simon', re: /instantsearchplus|fastsimon/i, dom: '[class*="isp_"], [id*="isp_"]' },
  { vendor: 'Constructor.io', re: /cnstrc|constructor\.io/i, dom: '[data-cnstrc-search-form], [data-cnstrc-autosuggest]' },
  { vendor: 'Bloomreach', re: /bloomreach|brsearch/i, dom: null },
  { vendor: 'Coveo', re: /coveo/i, dom: '[class*="coveo" i], atomic-search-interface' }
];

/**
 * @returns {{owner:'unbxd'|'customer'|'browser_extension'|'unknown', source:string, host?:string, detail?:string}}
 *   source is one of: unbxd_cdn, unbxd_module, theme, platform, platform_app,
 *   site_module, site, inline, third_party, browser_extension, unknown.
 */
export function classifyAssetOrigin(rawUrl, pageUrl) {
  if (!rawUrl) return { owner: 'unknown', source: 'unknown' };
  let u;
  try {
    u = new URL(rawUrl, pageUrl || undefined);
  } catch {
    return { owner: 'unknown', source: 'unknown' };
  }
  if (/^(chrome|moz|safari)-extension:$/.test(u.protocol)) {
    return { owner: 'browser_extension', source: 'browser_extension' };
  }
  if (!/^https?:$/.test(u.protocol)) return { owner: 'unknown', source: 'unknown' };

  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  if (isUnbxdHost(u.href)) return { owner: 'unbxd', source: 'unbxd_cdn', host };
  if (/unbxd/i.test(path) || /unbxd/i.test(host)) return { owner: 'unbxd', source: 'unbxd_module', host };

  // An error/console entry whose "url" is the page itself came from an inline
  // <script> in the page HTML.
  let pageHost = null;
  try {
    const p = new URL(pageUrl);
    pageHost = p.hostname.toLowerCase();
    if (p.origin === u.origin && p.pathname === u.pathname) return { owner: 'customer', source: 'inline', host };
  } catch {
    /* no page url */
  }

  // Shopify — assets come from cdn.shopify.com or from the store's own /cdn/.
  const shopifyCdn = host === 'cdn.shopify.com' || host.endsWith('.shopifycdn.com') || /^\/cdn\/(shop|shopifycloud)\//.test(path);
  if (shopifyCdn) {
    if (/\/extensions\//.test(path)) return { owner: 'customer', source: 'platform_app', host, detail: 'Shopify app embed' };
    if (/\/t\/\d+\/(assets|compiled_assets)\//.test(path)) return { owner: 'customer', source: 'theme', host, detail: 'Shopify theme asset' };
    if (/shopifycloud|\/s\/trekkie|\/storefront\//.test(path)) return { owner: 'customer', source: 'platform', host, detail: 'Shopify platform runtime' };
    return { owner: 'customer', source: 'platform', host, detail: 'Shopify CDN' };
  }

  // Magento 2 — /static/[versionNNN/]frontend/{Vendor}/{theme}/{locale}/{rest}
  const mage = path.match(/\/static\/(?:version\d+\/)?frontend\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/);
  if (mage) {
    const rest = mage[4];
    const first = rest.split('/')[0];
    const theme = `${mage[1]}/${mage[2]}`;
    if (/^Magento_/.test(first) || /^(mage|requirejs|jquery|knockoutjs|underscore|prototype)\b/.test(rest)) {
      return { owner: 'customer', source: 'platform', host, detail: `Magento core (${first})` };
    }
    if (/^[A-Z][A-Za-z0-9]*_[A-Z][A-Za-z0-9]*$/.test(first)) {
      return { owner: 'customer', source: 'site_module', host, detail: `Magento module ${first} (theme ${theme})` };
    }
    return { owner: 'customer', source: 'theme', host, detail: `Magento theme ${theme}` };
  }
  if (/\/static\/(?:version\d+\/)?_cache\/merged\//.test(path)) {
    return { owner: 'customer', source: 'theme', host, detail: 'Magento merged bundle (theme + modules)' };
  }

  if (pageHost && registrableDomain(host) === registrableDomain(pageHost)) {
    return { owner: 'customer', source: 'site', host };
  }
  return { owner: 'customer', source: 'third_party', host };
}

/* ------------------------------------------------------------------ */
/* In-page probe                                                         */
/* ------------------------------------------------------------------ */

/** Self-contained: runs inside the page via Runtime.evaluate. */
const PAGE_PROBE = (vendorSources) => {
  const vendors = vendorSources.map((v) => ({ vendor: v.vendor, re: new RegExp(v.source, 'i'), dom: v.dom }));
  const visible = (el) => {
    try {
      if (!el || !el.getClientRects().length) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0 && el.offsetWidth > 0 && el.offsetHeight > 0;
    } catch {
      return false;
    }
  };

  const scripts = [...document.querySelectorAll('script')];
  const external = scripts
    .filter((s) => s.src)
    .map((s, index) => ({ src: s.src, index, async: s.async, defer: s.defer, module: s.type === 'module', inHead: Boolean(s.closest('head')) }));
  const inline = scripts.filter((s) => !s.src);
  const inlineUnbxd = inline.filter((s) => /unbxd/i.test((s.textContent || '').slice(0, 30000))).length;
  const styles = [...document.querySelectorAll('link[rel~="stylesheet"][href]')].map((l) => l.href);
  const allSrc = external.map((s) => s.src).concat(styles).join('\n');
  const bodyClass = (document.body && document.body.className) || '';

  /* platform */
  let platform = { name: 'unknown', evidence: [] };
  try {
    const S = window.Shopify;
    if (S && (S.shop || S.theme || S.routes)) {
      platform = {
        name: 'shopify',
        shop: S.shop || null,
        theme: S.theme
          ? { name: S.theme.name || null, id: S.theme.id || null, role: S.theme.role || null, schemaName: S.theme.schema_name || null, schemaVersion: S.theme.schema_version || null }
          : null,
        evidence: ['window.Shopify']
      };
    } else if (
      document.querySelector('script[type="text/x-magento-init"]') ||
      /\/static\/(version\d+\/)?frontend\//.test(allSrc) ||
      (window.require && window.require.s && window.require.s.contexts)
    ) {
      const m = allSrc.match(/\/static\/(?:version\d+\/)?frontend\/([^/]+)\/([^/]+)\//);
      platform = {
        name: 'magento',
        theme: m ? `${m[1]}/${m[2]}` : null,
        pageLayoutClasses: (bodyClass.match(/\b(catalog-category-view|catalogsearch-result-index|catalog-product-view|cms-index-index|page-products|page-layout-[\w-]+)\b/g) || []).slice(0, 5),
        evidence: ['x-magento-init / static frontend path']
      };
    } else if (window.BCData || window.stencilBootstrap) {
      platform = { name: 'bigcommerce', evidence: ['window.BCData'] };
    } else if (/demandware/.test(allSrc)) {
      platform = { name: 'salesforce_commerce_cloud', evidence: ['demandware static path'] };
    } else if (/\bwoocommerce\b/.test(bodyClass)) {
      platform = { name: 'woocommerce', evidence: ['body.woocommerce'] };
    }
  } catch {
    /* ignore */
  }

  /* the platform's own search UI, still active next to Unbxd */
  const nativeSearch = [];
  const nativeCandidates = [
    { platform: 'shopify', what: 'Shopify predictive search', sel: 'predictive-search, [data-predictive-search], #predictive-search, .predictive-search' },
    { platform: 'magento', what: 'Magento quick-search autocomplete', sel: '#search_autocomplete, .search-autocomplete' }
  ];
  for (const c of nativeCandidates) {
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(c.sel)];
    } catch {
      nodes = [];
    }
    if (!nodes.length) continue;
    const vis = nodes.filter(visible);
    nativeSearch.push({
      what: c.what,
      selector: c.sel,
      count: nodes.length,
      visibleCount: vis.length,
      visibleWithContent: vis.some((n) => (n.textContent || '').trim().length > 0)
    });
  }
  try {
    const mageBound = [...document.querySelectorAll('[data-mage-init]')].some((n) => /quickSearch/.test(n.getAttribute('data-mage-init') || ''));
    if (mageBound) nativeSearch.push({ what: 'Magento quickSearch widget bound to the search input', selector: '[data-mage-init*="quickSearch"]', count: 1, visibleCount: null });
  } catch {
    /* ignore */
  }

  /* other search vendors */
  const competing = [];
  for (const v of vendors) {
    const viaScript = external.find((s) => v.re.test(s.src));
    let viaDom = null;
    try {
      viaDom = v.dom ? document.querySelector(v.dom) : null;
    } catch {
      viaDom = null;
    }
    if (viaScript || viaDom) {
      competing.push({ vendor: v.vendor, scriptSrc: viaScript ? viaScript.src : null, domMarkerVisible: viaDom ? visible(viaDom) : false });
    }
  }

  /* could we see the real page at all? */
  const title = (document.title || '').slice(0, 140);
  const challenge =
    /just a moment|attention required|access denied|verify (you are|that you are) (a )?human|are you a robot|captcha|request blocked|pardon our interruption|security check/i.test(title) ||
    Boolean(document.querySelector('#challenge-form, #cf-challenge-running, .cf-browser-verification, [id^="px-captcha"], iframe[src*="captcha"], #sec-if-container'));
  // WAF/CDN error documents ("405 Not allowed", "403 Forbidden", "502 Bad Gateway").
  const errorPage = /^\s*(4\d\d|5\d\d)\b|\b(forbidden|not allowed|too many requests|bad gateway|service unavailable|gateway time-?out)\b/i.test(title);
  // A storefront always loads scripts and styles; a bare document is an
  // error/block page whatever its title says.
  const bareDocument = !document.querySelector('script[src], link[rel~="stylesheet"]') && (document.body ? document.body.innerText.length < 2000 : true);
  const passwordPage = location.pathname === '/password' || Boolean(document.querySelector('form[action$="/password"] input[type="password"]'));
  const maintenance = /maintenance|we.?ll be back|temporarily unavailable/i.test(title);

  return {
    url: location.href.slice(0, 300),
    title,
    platform,
    scripts: external,
    inlineScriptCount: inline.length,
    inlineScriptsMentioningUnbxd: inlineUnbxd,
    stylesheets: styles,
    styleTagCount: document.querySelectorAll('style').length,
    nativeSearch,
    competing,
    access: { challenge, passwordPage, maintenance, errorPage, bareDocument }
  };
};

const BLOCKED_REMEDY =
  'Usually bot protection reacting to an automated browser. Re-run in the visible browser (unset UNBXD_MCP_HEADLESS), attach to your own Chrome (UNBXD_MCP_CDP_URL), or use the CX Debug Assistant extension.';

/* ------------------------------------------------------------------ */
/* Public entry point                                                    */
/* ------------------------------------------------------------------ */

const MAX_LIST = 12;

export async function capturePageInventory(session, recorder) {
  const vendorSources = COMPETING_SEARCH_VENDORS.map((v) => ({ vendor: v.vendor, source: v.re.source, dom: v.dom }));
  const raw = await session.evaluate(`(${PAGE_PROBE.toString()})(${JSON.stringify(vendorSources)})`);
  if (!raw) {
    return { available: false, reason: 'Could not evaluate in the page (navigation in progress or the page blocked evaluation).' };
  }
  const pageUrl = raw.url;

  /* scripts & stylesheets by owner/source */
  const tally = (urls) => {
    const bySource = {};
    const thirdPartyHosts = {};
    for (const url of urls) {
      const o = classifyAssetOrigin(url, pageUrl);
      bySource[o.source] = (bySource[o.source] || 0) + 1;
      if (o.source === 'third_party' && o.host) thirdPartyHosts[o.host] = (thirdPartyHosts[o.host] || 0) + 1;
    }
    return {
      total: urls.length,
      bySource,
      topThirdPartyHosts: Object.entries(thirdPartyHosts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([host, count]) => ({ host, count }))
    };
  };

  const scriptUrls = raw.scripts.map((s) => s.src);
  const unbxdScripts = raw.scripts
    .filter((s) => classifyAssetOrigin(s.src, pageUrl).owner === 'unbxd')
    .map((s) => ({
      url: redactUrl(s.src),
      kind: unbxdAssetKind(s.src),
      position: `${s.index + 1} of ${raw.scripts.length} external scripts`,
      inHead: s.inHead,
      async: s.async,
      defer: s.defer
    }));
  const unbxdStyles = raw.stylesheets.filter((h) => classifyAssetOrigin(h, pageUrl).owner === 'unbxd').map(redactUrl);
  const themeAssets = [...raw.scripts.map((s) => s.src), ...raw.stylesheets]
    .map((url) => ({ url, o: classifyAssetOrigin(url, pageUrl) }))
    .filter((x) => x.o.source === 'theme' || x.o.source === 'site_module' || x.o.source === 'platform_app')
    .slice(0, MAX_LIST)
    .map((x) => ({ url: redactUrl(x.url), source: x.o.source, detail: x.o.detail || null }));

  /* console errors, attributed to the script that raised them */
  const entries = [
    ...recorder.pageErrors.map((e) => ({ ...e, kind: 'exception' })),
    ...recorder.consoleEntries.filter((e) => e.level === 'error').map((e) => ({ ...e, kind: 'console.error' }))
  ];
  const consoleErrors = entries.map((e) => {
    const o = classifyAssetOrigin(e.url, pageUrl);
    return {
      kind: e.kind,
      owner: o.owner,
      source: o.source,
      detail: o.detail || null,
      scriptUrl: e.url || null,
      text: truncate(e.text, 240),
      mentionsUnbxd: /unbxd|\bUNX|unbxdSearch|autosuggest/i.test(e.text || '')
    };
  });
  const consoleByOwner = {};
  for (const e of consoleErrors) consoleByOwner[e.owner] = (consoleByOwner[e.owner] || 0) + 1;

  /* failed requests, attributed */
  const failedRequests = recorder.problems().map((r) => {
    const o = classifyAssetOrigin(r.rawUrl, pageUrl);
    return {
      url: r.url,
      owner: o.owner,
      source: o.source,
      apiKind: unbxdApiKind(r.rawUrl),
      assetKind: unbxdAssetKind(r.rawUrl),
      type: r.type,
      status: r.status,
      errorText: r.errorText,
      blockedReason: r.blockedReason,
      corsError: r.corsError
    };
  });
  const failedByOwner = {};
  for (const f of failedRequests) failedByOwner[f.owner] = (failedByOwner[f.owner] || 0) + 1;

  const access = raw.access || {};
  const blockedReason = access.challenge
    ? `The page served a bot-protection / challenge page ("${raw.title}") instead of the storefront. ${BLOCKED_REMEDY}`
    : access.passwordPage
      ? 'The store is password-protected (Shopify /password page). Enter the storefront password with the interact tool, then re-run.'
      : access.errorPage
        ? `The page is an error document ("${raw.title}"), not the storefront. ${BLOCKED_REMEDY}`
        : access.bareDocument
          ? `The page loaded no scripts or stylesheets ("${raw.title}") — an error or block page, not the storefront. ${BLOCKED_REMEDY}`
          : access.maintenance
            ? `The page looks like a maintenance page ("${raw.title}").`
            : null;

  return {
    available: true,
    pageUrl: redactUrl(pageUrl),
    title: raw.title,
    platform: raw.platform,
    access: { blocked: Boolean(blockedReason), reason: blockedReason },
    unbxdIntegration: {
      scriptTags: unbxdScripts,
      stylesheets: unbxdStyles,
      inlineSnippetsMentioningUnbxd: raw.inlineScriptsMentioningUnbxd,
      note: 'scriptTags lists every Unbxd <script> in the DOM with its position — two tags of the same kind means the widget is included twice (theme + app, or a duplicated snippet).'
    },
    scripts: tally(scriptUrls),
    stylesheets: { ...tally(raw.stylesheets), styleTags: raw.styleTagCount },
    themeAndAppAssets: themeAssets,
    inlineScriptCount: raw.inlineScriptCount,
    nativeSearch: raw.nativeSearch,
    competingSearch: raw.competing.map((c) => ({ ...c, scriptSrc: c.scriptSrc ? redactUrl(c.scriptSrc) : null })),
    consoleErrors: consoleErrors.slice(-20),
    consoleErrorsByOwner: consoleByOwner,
    failedRequests: failedRequests.slice(0, 20),
    failedRequestsByOwner: failedByOwner,
    howToRead:
      'owner "customer" covers everything the storefront serves that is not Unbxd: theme, installed apps/modules, platform runtime, inline scripts and third-party tags. source narrows it down — name the specific scriptUrl/stylesheet when telling the customer what to change.'
  };
}
