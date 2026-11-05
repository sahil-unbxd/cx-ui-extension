import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOwnership } from '../../src/capture/ownership.js';

/* Minimal builders for the shapes the capture code produces. */
const check = (id, status, detail = `${id} ${status}`, evidence = {}) => ({ id, title: id, status, detail, evidence });
const selfDebug = (checks) => ({ checks, summary: {} });
const healthyInventory = (extra = {}) => ({
  available: true,
  access: { blocked: false, reason: null },
  unbxdIntegration: { scriptTags: [{ kind: 'search.js', url: 'https://libraries.unbxdapi.com/acme_search.js' }], inlineSnippetsMentioningUnbxd: 1 },
  consoleErrors: [],
  failedRequests: [],
  competingSearch: [],
  nativeSearch: [],
  ...extra
});
const allPass = [
  check('fresh_page_load', 'pass'),
  check('sdk_assets_loaded', 'pass'),
  check('sdk_initialised', 'pass'),
  check('page_type_matches_endpoint', 'pass'),
  check('search_query_reaches_api', 'pass'),
  check('config_selectors_resolve', 'pass'),
  check('api_results_rendered', 'pass')
];

test('everything healthy → not reproduced, ask for more evidence', () => {
  const o = classifyOwnership({ issueTypeId: 'srp_ui', context: { selfDebug: selfDebug(allPass), sdkAssets: { verdict: 'loaded' } }, inventory: healthyInventory() });
  assert.equal(o.owner, 'not_reproduced');
  assert.equal(o.route, 'need_more_evidence');
  assert.equal(o.confidence, 'medium');
});

test('a bot-protection page wins over everything else', () => {
  const o = classifyOwnership({
    issueTypeId: 'srp_ui',
    context: { selfDebug: selfDebug([check('sdk_initialised', 'fail')]) },
    inventory: healthyInventory({ access: { blocked: true, reason: 'challenge page' } })
  });
  assert.equal(o.owner, 'access_blocked');
  assert.equal(o.route, 'need_more_evidence');
});

test('regression: a WAF 405 document must not be blamed on the customer', () => {
  // Real case (Lindt Canada, headless): the page answered "405 Not allowed",
  // had no scripts, and the first version routed it as "integration snippet
  // missing → revert to customer" with medium confidence.
  const blockedPage = healthyInventory({
    unbxdIntegration: { scriptTags: [], inlineSnippetsMentioningUnbxd: 0 },
    scripts: { total: 0, bySource: {} }
  });
  const context = { sdkAssets: { verdict: 'not_observed' }, selfDebug: selfDebug([check('sdk_assets_loaded', 'warn'), check('sdk_initialised', 'fail')]) };
  const o = classifyOwnership({ issueTypeId: 'srp_ui', context, inventory: blockedPage, navigation: { status: 405 } });
  assert.equal(o.owner, 'access_blocked');
  assert.equal(o.route, 'need_more_evidence');
  assert.ok(!o.evidence.some((e) => e.signal === 'integration.missing'));
});

test('regression: no Unbxd tag on a page with no scripts at all is not evidence', () => {
  const bare = healthyInventory({ unbxdIntegration: { scriptTags: [], inlineSnippetsMentioningUnbxd: 0 }, scripts: { total: 0, bySource: {} } });
  const o = classifyOwnership({ issueTypeId: 'srp_ui', context: { sdkAssets: { verdict: 'not_observed' } }, inventory: bare });
  assert.ok(!o.evidence.some((e) => e.signal === 'integration.missing'));
  // …while on a real storefront page it is.
  const real = healthyInventory({ unbxdIntegration: { scriptTags: [], inlineSnippetsMentioningUnbxd: 0 }, scripts: { total: 42, bySource: { theme: 30 } } });
  const o2 = classifyOwnership({ issueTypeId: 'srp_ui', context: { sdkAssets: { verdict: 'not_observed' } }, inventory: real });
  assert.equal(o2.owner, 'customer_site_code');
});

test('Unbxd search API 503 → internal Jira to the API team, high confidence', () => {
  const o = classifyOwnership({
    issueTypeId: 'srp_ui',
    context: { searchRequest: { apiType: 'search', status: 503, failed: false }, responseSummary: { available: true, parsed: false, head: '<html>Service Unavailable' } },
    inventory: healthyInventory({ failedRequests: [{ owner: 'unbxd', apiKind: 'search', status: 503, url: 'https://search.unbxd.io/k/s/search?q=x' }] })
  });
  assert.equal(o.owner, 'unbxd_api');
  assert.equal(o.route, 'raise_internal_jira');
  assert.equal(o.confidence, 'high');
});

test('PLP running as SEARCH (page type mismatch) → Unbxd config', () => {
  const checks = [
    check('sdk_initialised', 'pass'),
    check('page_type_matches_endpoint', 'fail', 'productType is SEARCH but the page called /search on a category page'),
    check('api_results_rendered', 'pass')
  ];
  const o = classifyOwnership({ issueTypeId: 'plp_ui', context: { selfDebug: selfDebug(checks) }, inventory: healthyInventory() });
  assert.equal(o.owner, 'unbxd_config');
  assert.equal(o.route, 'raise_internal_jira');
  assert.match(o.team, /Integration/);
});

test('API returned products but the theme CSS hides the grid → customer CSS, revert to customer', () => {
  const css = {
    elements: [
      {
        label: 'results container (products.el → #unbxd-grid)',
        found: true,
        expectVisible: true,
        hiddenBy: { property: 'display', value: 'none', important: true, owner: 'customer', source: 'theme', sheet: 'https://store.com/cdn/shop/t/4/assets/base.css', selector: '.template-search #unbxd-grid' },
        overrides: [{ property: 'display', unbxdValue: 'grid', winningValue: 'none', winnerOwner: 'customer', winnerSource: 'theme', winnerSheet: 'https://store.com/cdn/shop/t/4/assets/base.css', winnerSelector: '.template-search #unbxd-grid' }]
      }
    ]
  };
  const checks = [check('sdk_initialised', 'pass'), check('config_selectors_resolve', 'pass'), check('api_results_rendered', 'pass')];
  const o = classifyOwnership({ issueTypeId: 'srp_ui', context: { selfDebug: selfDebug(checks) }, inventory: healthyInventory(), css });
  assert.equal(o.owner, 'customer_site_css');
  assert.equal(o.route, 'revert_to_customer');
  assert.ok(o.evidence.some((e) => /base\.css/.test(e.detail)), 'evidence must name the stylesheet');
});

test('CSP blocks the Unbxd bundle → customer site code', () => {
  const o = classifyOwnership({
    issueTypeId: 'srp_ui',
    context: { sdkAssets: { verdict: 'load_failed' }, selfDebug: selfDebug([check('sdk_assets_loaded', 'fail'), check('sdk_initialised', 'fail')]) },
    inventory: healthyInventory({
      failedRequests: [{ owner: 'unbxd', assetKind: 'search.js', blockedReason: 'csp', errorText: 'net::ERR_BLOCKED_BY_CLIENT', url: 'https://libraries.unbxdapi.com/acme_search.js' }]
    })
  });
  assert.equal(o.owner, 'customer_site_code');
  assert.equal(o.route, 'revert_to_customer');
});

test('autosuggest: Shopify predictive search still visible next to Unbxd → customer site code', () => {
  const checks = [check('autosuggest_bundle_loaded', 'pass'), check('autosuggest_api_triggered', 'pass'), check('popular_products_requested', 'pass'), check('popular_products_returned', 'pass'), check('popular_products_rendered', 'pass')];
  const o = classifyOwnership({
    issueTypeId: 'autosuggest_data',
    context: { selfDebug: selfDebug(checks) },
    inventory: healthyInventory({ nativeSearch: [{ what: 'Shopify predictive search', selector: 'predictive-search', count: 1, visibleCount: 1, visibleWithContent: true }] }),
    interaction: { typed: true, query: 'boot', selector: '#Search' }
  });
  assert.equal(o.owner, 'customer_site_code');
});

test('autosuggest: popularProducts.count not requested → Unbxd config', () => {
  const checks = [check('autosuggest_api_triggered', 'pass'), check('popular_products_requested', 'fail', 'popularProducts.count is "absent" in the request')];
  const o = classifyOwnership({ issueTypeId: 'autosuggest_data', context: { selfDebug: selfDebug(checks) }, inventory: healthyInventory(), interaction: { typed: true, query: 'boot', selector: '#q' } });
  assert.equal(o.owner, 'unbxd_config');
});

test('no autosuggest call is NOT scored when the triage never typed', () => {
  const checks = [check('autosuggest_api_triggered', 'fail')];
  const o = classifyOwnership({ issueTypeId: 'autosuggest_data', context: { selfDebug: selfDebug(checks) }, inventory: healthyInventory(), interaction: { typed: false } });
  assert.equal(o.owner, 'not_reproduced');
  assert.ok(o.caveats.some((c) => /could not type/.test(c)));
});

test('zero results for the query → catalogue/merchandising, with the revert caveat', () => {
  const checks = [check('search_query_reaches_api', 'pass'), check('api_results_rendered', 'warn', 'zero', { returnedProductCount: 0, numberOfProducts: 0 })];
  const o = classifyOwnership({ issueTypeId: 'srp_ui', context: { selfDebug: selfDebug(checks) }, inventory: healthyInventory() });
  assert.equal(o.owner, 'catalogue_data');
  assert.ok(o.caveats.some((c) => /revert to the customer/.test(c)));
});

test('customer console noise alone does not make it the customer\'s fault', () => {
  const o = classifyOwnership({
    issueTypeId: 'srp_ui',
    context: { selfDebug: selfDebug(allPass) },
    inventory: healthyInventory({
      consoleErrors: [
        { kind: 'exception', owner: 'customer', source: 'third_party', text: 'ga is not defined', scriptUrl: 'https://www.google-analytics.com/x.js', mentionsUnbxd: false },
        { kind: 'exception', owner: 'customer', source: 'theme', text: 'Cannot read properties of null', scriptUrl: 'https://store.com/cdn/shop/t/1/assets/theme.js', mentionsUnbxd: false }
      ]
    })
  });
  assert.equal(o.owner, 'not_reproduced');
});

test('competing search app installed → customer site code, naming the vendor', () => {
  const checks = [check('sdk_initialised', 'pass'), check('api_results_rendered', 'fail', 'API returned 24 products but no product-like nodes are in the DOM')];
  const o = classifyOwnership({
    issueTypeId: 'srp_ui',
    context: { selfDebug: selfDebug(checks) },
    inventory: healthyInventory({ competingSearch: [{ vendor: 'Klevu', scriptSrc: 'https://js.klevu.com/core/v2/klevu.js', domMarkerVisible: true }] })
  });
  // Rendering failed AND a second search app is live: both sides score; the
  // runner-up must be reported so support sees the ambiguity.
  assert.ok(['customer_site_code', 'unbxd_config'].includes(o.owner));
  assert.ok(o.runnerUp);
  assert.ok(o.evidence.some((e) => /Klevu/.test(e.detail)));
});
