/**
 * A fake Shopify storefront with a fake Unbxd integration, served entirely
 * through request interception — no real network, no real customer site.
 *
 * Scenarios:
 *   healthy           everything works
 *   theme_hides_grid  the theme's base.css hides the Unbxd results grid
 *   api_500           search.unbxd.io answers 500
 */
export const STORE = 'https://fixture-store.test';
const SITE_KEY = 'fixture-site';
const API_KEY = 'k123';
const UNBXD_JS = `https://libraries.unbxdapi.com/${SITE_KEY}_search.js`;
const UNBXD_CSS = `https://libraries.unbxdapi.com/${SITE_KEY}_search.css`;
const THEME_CSS = `${STORE}/cdn/shop/t/7/assets/base.css`;
const THEME_JS = `${STORE}/cdn/shop/t/7/assets/theme.js`;

const page = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>Search: boots – Fixture Store</title>
<link rel="stylesheet" href="${THEME_CSS}">
<link rel="stylesheet" href="${UNBXD_CSS}">
<script>window.Shopify = { shop: 'fixture-store.myshopify.com', routes: { root: '/' }, theme: { name: 'Dawn', id: 7, role: 'main', schema_name: 'Dawn', schema_version: '15.0.0' } };</script>
<script src="${THEME_JS}"></script>
<script src="${UNBXD_JS}"></script>
</head>
<body class="template-search">
  <header><nav><a href="/collections/boots">Boots</a><a href="/collections/sandals">Sandals</a></nav>
  <form action="/search"><input type="search" name="q" value="boots" aria-label="Search"></form></header>
  <main><div id="unbxd-grid"></div><div id="unbxd-pagination"></div></main>
</body></html>`;

const THEME_CSS_BODY = {
  healthy: 'body { font-family: sans-serif; } .header { padding: 8px; }',
  theme_hides_grid: 'body { font-family: sans-serif; }\n.template-search #unbxd-grid { display: none !important; }',
  api_500: 'body { font-family: sans-serif; }'
};

// A miniature "SDK + customer config" bundle with the same globals and
// resolver methods the real one exposes (see self-debug.js).
const UNBXD_JS_BODY = `(function () {
  function getSiteName() { return "${SITE_KEY}"; }
  function getApiKey() { return "${API_KEY}"; }
  var q = new URLSearchParams(location.search).get('q') || '';
  var options = {
    siteKey: getSiteName(), apiKey: getApiKey(), productType: 'SEARCH',
    searchBoxEl: 'input[name="q"]',
    products: { el: '#unbxd-grid', attributesMap: { unxTitle: 'title', unxPrice: 'price', unxImageUrl: 'imageUrl' } },
    pagination: { el: '#unbxd-pagination', type: 'FIXED_PAGINATION' }
  };
  var last = null;
  window.unbxdSearch = {
    options: options,
    state: { userInput: q },
    getSearchQueryParam: function () { return 'q'; },
    getBrowseQueryParam: function () { return 'p'; },
    getProductType: function () { return 'SEARCH'; },
    getCategoryId: function () { return null; },
    getResponseObj: function () { return last; }
  };
  fetch('https://search.unbxd.io/' + getApiKey() + '/' + getSiteName() + '/search?q=' + encodeURIComponent(q) + '&rows=12&start=0&fields=title,price,imageUrl,uniqueId')
    .then(function (r) { if (!r.ok) throw new Error('Unbxd search failed: ' + r.status); return r.json(); })
    .then(function (json) {
      last = json;
      document.querySelector(options.products.el).innerHTML = json.response.products
        .map(function (p) { return '<div class="UNX-product product-tile" id="p-' + p.uniqueId + '">' + p.title + ' – $' + p.price + '</div>'; })
        .join('');
    })
    .catch(function (e) { console.error(e.message); });
})();`;

const UNBXD_CSS_BODY = '#unbxd-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; } .UNX-product { padding: 8px; }';

const SEARCH_RESPONSE = JSON.stringify({
  searchMetaData: { status: 0, queryParams: { q: 'boots', rows: '12' } },
  response: {
    numberOfProducts: 3,
    start: 0,
    products: [
      { uniqueId: '101', title: 'Trail Boot', price: 120, imageUrl: 'https://img.test/1.jpg' },
      { uniqueId: '102', title: 'City Boot', price: 99, imageUrl: 'https://img.test/2.jpg' },
      { uniqueId: '103', title: 'Rain Boot', price: 45, imageUrl: 'https://img.test/3.jpg' }
    ]
  }
});

/** Body for a URL, or null if the fixture doesn't serve it. */
export function fixtureResponse(url, scenario) {
  const u = new URL(url);
  if (u.origin === STORE && u.pathname === '/search') return { status: 200, contentType: 'text/html', body: page() };
  if (url.startsWith(THEME_CSS)) return { status: 200, contentType: 'text/css', body: THEME_CSS_BODY[scenario] };
  if (url.startsWith(THEME_JS)) return { status: 200, contentType: 'application/javascript', body: 'document.documentElement.classList.add("js");' };
  if (url.startsWith(UNBXD_JS)) return { status: 200, contentType: 'application/javascript', body: UNBXD_JS_BODY };
  if (url.startsWith(UNBXD_CSS)) return { status: 200, contentType: 'text/css', body: UNBXD_CSS_BODY };
  if (u.hostname === 'search.unbxd.io') {
    return scenario === 'api_500'
      ? { status: 500, contentType: 'text/html', body: '<html><body>Internal Server Error</body></html>', headers: { 'access-control-allow-origin': '*' } }
      : { status: 200, contentType: 'application/json', body: SEARCH_RESPONSE, headers: { 'access-control-allow-origin': '*' } };
  }
  return null;
}

/** Serve the fixture to a Playwright context; abort everything else. */
export async function installFixtureStore(context, scenario) {
  await context.unroute('**/*').catch(() => {});
  await context.route('**/*', (route) => {
    const res = fixtureResponse(route.request().url(), scenario);
    if (!res) return route.abort();
    return route.fulfill({ status: res.status, contentType: res.contentType, body: res.body, headers: res.headers });
  });
}

/** The capture code fetches the bundle from Node too (site-config.js) —
 *  keep that off the network as well. */
export function installFixtureFetch(scenario) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const res = fixtureResponse(url, scenario);
    if (res) return new Response(res.body, { status: res.status, headers: { 'content-type': res.contentType } });
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

export const FIXTURE_URL = `${STORE}/search?q=boots`;
