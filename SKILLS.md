# CX Debugging Skills

Reference material for the CX Debug Assistant. The section matching the selected
issue type is injected verbatim into the LLM prompt (see `src/prompt/skills.js`),
so this file is **prompt surface, not documentation**: write it for a model that
has the captured context and nothing else.

## How to add an issue type

1. Add a `## <Heading>` section below, using the four sub-headings in the template
   at the bottom of this file. Keep it under ~400 words — it is paid for on every
   request.
2. Add an entry to `ISSUE_TYPES` in `src/shared/issue-types.js` whose
   `skillsSection` is exactly this heading.
3. Add a capture strategy in `src/capture/strategies.js` keyed by the same id.
4. Add a prompt template in `src/prompt/templates.js` keyed by the same id.

Section headings are matched case-insensitively but otherwise exactly. Renaming a
heading without updating `skillsSection` silently drops the playbook from the
prompt.

Two sections below are **not** tied to a single issue type, and their headings
are hardcoded in `src/prompt/builder.js`. Rename them there too if you rename
them here:

- **"SDK Asset Validation (All Issue Types)"** — prepended to every prompt.
- **"Config Bundle Review (SRP and PLP)"** — added for any issue type whose
  `capture.siteConfig` is true.

---

## SDK Asset Validation (All Issue Types)

This is step zero, for every issue type, before anything issue-specific: the
captured context always includes an `sdkAssets` block (see
`src/capture/sdk-assets.js`) reporting whether the Unbxd widget's own bundles
were observed loading successfully —

- `search.js` / `autosuggest.js` (and their `.css`) — served from
  `https://libraries.unbxdapi.com/{siteKey}_search.js` (production) or
  `https://sandbox.unbxd.io/{siteKey}_search.js` (sandbox/dev), e.g.
  `https://libraries.unbxdapi.com/ss-unbxd-auk-prod-lindt61661738153147_search.js`.
- `sdk.js` / `sdk.css` — the combined/versioned bundle, e.g.
  `https://libraries.unbxdapi.com/search-sdk/v2.1.14/vanillaSearch.min.js`.

### Symptoms to recognise
- Any symptom at all — this is a gate, not a specific symptom. Check it first.
- Console shows the widget's global (`UnbxdSearch`, `unbxdAutosuggest`, etc.) is undefined.
- Autosuggest/search/category features are all silently inert, not just visually wrong.

### What context to capture
`sdkAssets.verdict`: `loaded` | `partially_loaded` | `load_failed` | `not_observed`, plus per-asset `status`/`failed`/`errorText`/`mimeType`/`fromCache`/`durationMs` for whichever of the kinds above were seen. Load status and timing only — never the bundle's own contents.

### Common root causes, most likely first
1. **`load_failed` or a specific asset missing from `detected`** — the bundle 404'd, was blocked, or the page never requested it (wrong integration snippet, wrong site key in the URL, or the widget script tag was removed/misplaced). Treat this as the root cause and stop here before reasoning about the issue-specific symptom — a page that never loaded `search.js` cannot have a "real" autosuggest alignment bug, only the absence of the widget.
2. **`partially_loaded`** — e.g. `search.js` loaded but `search.css` failed (or vice versa): explains a feature that "half-works" (JS runs, but positioning/appearance defaults because no styles applied), or the reverse.
3. **Correct kind loaded from the wrong host** — `sandbox.unbxd.io` in a production ticket, or a stale cached copy (`fromCache: true` with an old `durationMs`) — points at an environment/deploy mismatch rather than a code bug.
4. **`not_observed`** — inconclusive by itself; the capture window may simply have started after the page finished loading. Don't treat this as proof of breakage — say so and suggest recapturing with a full page reload during the capture.

### Fix pattern to suggest
If any expected asset is missing or failed, say so as the first line of the answer and recommend fixing the integration snippet / site key / environment before investigating the issue-specific symptom further — the rest of the capture is likely a downstream effect. Only proceed to the issue type's own playbook once `sdkAssets.verdict` is `loaded` (or the failure is explicitly ruled out as unrelated, e.g. a different host's asset was blocked while all Unbxd assets loaded fine).

---

## Config Bundle Review (SRP and PLP)

SRP and PLP captures additionally include `siteConfig`, a review of the
customer's `{siteKey}_search.js` / `_search.css` bundle. Most SRP/PLP tickets
are resolved here rather than in the API response.

**Read `siteConfig.liveConfig`, not the bundle text.** That bundle is the whole
vanilla search library *plus* the customer's config *plus* their template
functions (~350KB minified), and the config is usually assembled at runtime by
a `createSearchConfig()` factory. `liveConfig.options` is the resolved config
read off the live instance (`window.unbxdSearch.options`) and is authoritative.
`bundleReview[].bundleMarkers` are regex counts over that minified text — which
includes the SDK's own demo defaults — so they are only good for:
`builtForSiteKey`/`builtForApiKey` (which site and environment the bundle was
built for), `instantiations` (how many `new UnbxdSearch(` the file contains),
and file facts (bytes, `lastModified`). Never quote a marker count as if it
were the customer's setting.

### The three checks that resolve most tickets

1. **`liveConfig.selectorChecks[].matchCount === 0`** — a config element
   selector that matches nothing on the page. Each entry carries the dotted
   `configPath` (`products.el`, `facet.facetsEl`, `pagination.el`,
   `searchBoxEl`…), which is the exact key to quote in the fix. This is the
   single most common cause of an empty grid or a dead module, and it usually
   means the customer's theme changed a container class, or the SDK script ran
   before the DOM existed (also shows up as `... el is not a valid DOM
   selector` in `consoleErrors`). `matchCount: -2` means the selector string is
   not valid CSS at all.
2. **`siteConfig.consistency.allMatch === false`** — the site key differs
   between the bundle it was built for, the running config and the actual API
   request. Wrong environment or wrong catalogue; nothing downstream will make
   sense until it is fixed.
3. **`liveConfig.instanceFound === false`** — the SDK never initialised on this
   page. Check `bundleMarkers.instantiations` and the page-detection condition
   against `renderedPage.bodyClasses` (Magento: `body.catalog-category-view`;
   Shopify: `template-collection`).

### Config keys that are usually the root cause
| Symptom | Key to check |
|---|---|
| Empty product grid, no console errors | `products.el` (selectorChecks), `products.attributesMap`, `productAttributes` vs `responseSummary.productFieldNames` |
| Broken/placeholder images | `attributesMap` image field name, and whether the API field is an array the template treats as a string |
| PLP shows search results | `productType` (must be `CATEGORY`), `browseQueryParam`, the `setCategoryId` logic |
| Back button loops on PLP | `pagination.type: FIXED_PAGINATION` + `url.pageSizeParam.addToUrl` / `pageNoParam.addToUrl` |
| Customer's own URL params vanish | `url.allowExternalUrlParams` (default `false` strips them) |
| SDK writes `?` but site uses `#` | `url.hashMode` |
| Price/range facet renders as a text facet | `url.facetsParam.rangeFacets` missing the field |
| Facets all expanded, not collapsible | `facet.isCollapsible`, `facet.defaultOpen` |
| Wrong page count / hundreds of pages | `pagination.pageSize` vs the `rows` actually sent, `pageNoParam.usePageNo` |
| Infinite scroll never fires | `pagination.infiniteScrollTriggerEl`, `heightDiffToTriggerNextPage`, an `overflow:hidden` products container |
| 2–3 API calls per page load | duplicate script tags (`assetUrls.duplicateKinds`), `bundleMarkers.instantiations > 1`, or a manual `getResults()`/`getCategoryPage()` on top of the automatic one (`apiCallCounts`) |
| Analytics events missing | `unbxdAnalytics`, `liveConfig.analyticsConfPresent` |

### CSS review
`bundleReview[].cssMarkers.riskyWidgetRules` lists rules in `_search.css` whose
selector mentions `UNX`/`unbxd` and whose body contains `display:none`,
`visibility:hidden`, `opacity:0`, `height:0`, `position`, `z-index` or
`overflow`. When the API returned products and `selectorChecks` are clean but
nothing is visible, this is where to look next.

### Fix pattern to suggest
Name the config key path and the exact value change (`pagination.pageSizeParam.addToUrl: true → false`), say the change belongs in the customer's `{siteKey}_search.js` (the CX engineer edits and redeploys the bundle; it is not an Unbxd console setting unless the key is catalogue-side), and note any behaviour the change alters. Then write the **Fix prompt** section addressed to a coding agent with that same file, key path and target value spelled out.

---

## Proxy / VPN / Access Issues

### Symptoms to recognise
- Requests to the Unbxd API host fail while the customer's own assets load fine (or the reverse).
- Browser console shows `ERR_NAME_NOT_RESOLVED`, `ERR_CONNECTION_TIMED_OUT`, `ERR_TUNNEL_CONNECTION_FAILED`, `ERR_CERT_AUTHORITY_INVALID`, or `net::ERR_BLOCKED_BY_CLIENT`.
- "No 'Access-Control-Allow-Origin' header" errors, or a CORS error code on a request that works in curl.
- HTTP 403 / 451 / 429 with an HTML body from an edge (Cloudflare, Akamai, AWS WAF) rather than JSON from the API.
- The issue follows the engineer, not the site: it reproduces for one person on VPN and nobody else.

### What context to capture
Network metadata only (`capture.network`, `capture.console`): failed and >=400 requests with their `errorText`, `corsErrorStatus`, `blockedReason`, status, timing, remote IP, the CORS / edge / cache headers, and an `isUnbxd` tag on each (any `*.unbxd.io` / `*.unbxdapi.com` host). Plus `unbxdFailureScope` (`unbxd_only` / `mixed` / `unbxd_unaffected` / `none`) and the browser environment (`origin`, `navigator.onLine`, time zone, languages) because time zone and language are the cheapest available proxy for apparent geography. No DOM, no response bodies.

### Common root causes, most likely first
1. **Engineer-side proxy or VPN** — corporate proxy or split-tunnel VPN dropping the API host. Signature: `unbxdFailureScope: mixed` or the failure isn't isolated to Unbxd at all — non-Unbxd hosts fail too; DNS failure, timeout or TLS-interception error; not reproducible off-VPN.
2. **Edge geo/bot block on the customer's CDN** — 403/451/429 with an edge header (`cf-ray`, `server: AkamaiGHost`, `x-cache`) and an HTML body. Often correlates with an unusual exit-node country.
3. **Genuine CORS misconfiguration on the Unbxd API** — signature: `unbxdFailureScope: unbxd_only` (only `search.unbxd.io`/`libraries.unbxdapi.com` calls fail, the rest of the site loads fine), preflight `OPTIONS` returns 4xx, or the response lacks `access-control-allow-origin` for this exact origin. Reproducible for everyone on that origin, not just this engineer.
4. **Rate limiting** — 429 plus `retry-after`, clustered in time.
5. **TLS interception** — cert errors on every HTTPS host; the proxy's root CA is not in the OS trust store.
6. **Not a network problem at all** — request succeeded with 200 and the failure is downstream. Say so rather than forcing a proxy story. If `sdkAssets.verdict` is `load_failed`, prefer that over inventing a proxy story — it is the more specific signal.

### Fix pattern to suggest
Name the boundary first: engineer's machine, customer's edge, or API config. Then: retry off VPN / on a different network to split (1) from (2)-(4); compare the same request via curl from outside the corporate network; if CORS, give the exact header the origin needs and say it is a change on the API/CDN side, not in the storefront JS; if edge/geo, ask the customer's team to allowlist the Unbxd API path or the tester's egress range. Never recommend disabling browser security flags.

---

## Autosuggest Alignment Issues

### Symptoms to recognise
- Dropdown appears offset horizontally or vertically from the search input.
- Dropdown is clipped, cut off at a container edge, or scrolls away from its input.
- Dropdown renders behind the header, a banner or a sticky element.
- Dropdown is much wider or narrower than the input.
- Correct on desktop, wrong on mobile widths, or wrong only after scrolling.

### What context to capture
Layout only (`capture.domGeometry`, `capture.console`): CDP box models for the anchor input and the dropdown, a fixed list of computed properties (`position`, `top/left/right/bottom`, `width`/`min-width`/`max-width`, `margin`, `box-sizing`, `z-index`, `overflow*`, `transform`, `direction`, `display`, `visibility`), the computed `relativeOffset` between the two boxes, the viewport, and the chain of ancestors that clip (`overflow != visible`) or create a stacking context (`position != static`, `transform`, `filter`, `will-change`, `contain`). No API payloads, no product/search data. (Network *is* recorded in the background for the shared `sdkAssets` check above — that's the one exception — but this strategy never forwards request/response data beyond it.)

### Common root causes, most likely first
0. **`autosuggest.css` (or the combined `sdk.css`) failed to load or is `not_observed`** — check `sdkAssets` before anything below. Without the stylesheet the dropdown renders with browser/host-site default styles, which looks exactly like an offset/z-index bug but isn't one — no amount of CSS-selector fixing in the widget will help until the asset itself loads.
1. **Dropdown is `position: absolute` but its nearest positioned ancestor is not the input's wrapper** — the offset equals the distance to whatever ancestor is positioned. Signature: non-zero `dxLeft`/`dyTopToInputBottom` with `position: absolute` and a positioned ancestor further up than expected.
2. **A clipping ancestor** — an ancestor with `overflow: hidden|auto|scroll` cuts the dropdown. Signature: `clipsChild: true` in the ancestor chain and a dropdown box extending past that ancestor.
3. **Stacking context trap** — the dropdown's `z-index` is high but an ancestor with `transform`/`filter`/`will-change`/`position` created a stacking context, so it can never rise above a sibling of that ancestor. Signature: `createsStackingContext: true` above the dropdown, and the overlapping element sits outside that subtree.
4. **`position: fixed` inside a transformed ancestor** — the transform makes the ancestor the containing block, so "fixed" coordinates are relative to it, not the viewport.
5. **Width mismatch** — dropdown width set independently of the input (`width: 100%` against a different parent, or a fixed px width); `widthDelta` is non-zero and `box-sizing` differs between the two.
6. **Stale coordinates** — the dropdown is positioned once with JS from `getBoundingClientRect()` and not recomputed on scroll/resize; correct before scrolling, wrong after.
7. **Host-site CSS overriding the widget** — a site rule with higher specificity on a generic class name.

### Fix pattern to suggest
Fix the containing block before touching offsets: give the input's immediate wrapper `position: relative` and make the dropdown its absolutely-positioned child, so the dropdown inherits the input's width via `width: 100%` and `box-sizing: border-box`. If a clipping ancestor cannot be changed, portal the dropdown to `document.body` and position it from the input's rect, recomputed on `scroll`/`resize`. For stacking issues, raise or neutralise the ancestor that creates the context — raising the dropdown's own `z-index` will not work. Prefer a scoped CSS fix in the customer's stylesheet over patching the widget, and give the exact selector and declarations.

---

## SRP (Search Results Page) UI Issues

### Symptoms to recognise
- Zero results for a query that should match, or a result count that disagrees with what is rendered.
- Wrong products, wrong order, duplicates, or stale results after a facet/sort change.
- Facets, banners, spell-correct or redirect behaviour missing.
- Pagination showing the wrong page or repeating page 1.
- Product tiles rendering with blank fields or placeholder images.

### What context to capture
The actual `search` or `category` call made by the page — and **only** those two Unbxd endpoints (`capture.searchApi`, `capture.network`, `capture.console`):

- `search`: `https://search.unbxd.io/{apiKey}/{siteKey}/search?q=...&rows=...&start=...`
- `category`: `https://search.unbxd.io/{apiKey}/{siteKey}/category?p=category_handle_uFilter%3A%22...%22&...`

Everything else the page calls — analytics beacons, recommendation widgets, ad pixels, third-party scripts, even the `autosuggest` endpoint — is ignored; it is never the "search request" in this capture (`otherSearchCalls`/`searchRequest.apiType` are `search`/`category` only). Capture: request URL with secrets redacted, `apiType`, the full param map (`q` or `p`, filters, `start`, `rows`, sort, catalogue/site identifiers), status, timing; and from the response **counts and shape only** — `numberOfProducts`, returned product count, `start`, top-level keys, product field names, first-product shape, facet keys, `redirect`, `didYouMean`, any error field. Plus what the DOM actually rendered (product-node counts, "no results" text, title). Never the catalogue values themselves, and no DOM geometry.

### The first question to answer
Compare `responseSummary.returnedProductCount` with `renderedPage.domProductNodeCounts`:
- API returned **> 0**, DOM shows **0 or fewer** → rendering/templating problem (client side).
- API returned **0** → data/query problem; go to the request params.
- API call **absent or failed** → integration/network problem; treat like an access issue.
- Counts match but the content is wrong → ranking, relevance or field-mapping configuration.

### Common root causes, most likely first
1. **Query/params wrong** — a stray filter, an encoded `q`, wrong `start`/`rows` arithmetic, or a variant/child filter excluding everything. Zero results with a plausible-looking query. For `category`, check the `p=category_handle_uFilter:"..."` value is the handle the page actually intends.
2. **Wrong catalogue, site key or environment** — the `{apiKey}/{siteKey}` path segments point at staging/another catalogue/sandbox, or `searchRequest.url`'s host isn't `search.unbxd.io` at all (see the SDK-asset host-mismatch cause above — the same wrong-environment pattern shows up here); field names in the response differ from what the template expects.
3. **Template/field-mapping mismatch** — API returns products, DOM shows blanks or nothing; `productFieldNames` does not contain the fields the storefront template reads.
4. **Response not JSON** — an HTML challenge or error page came back; `parsed: false`. Escalate to the access playbook.
5. **Race / stale render** — multiple `search`/`category` calls in the window (`otherSearchCalls`) and the UI shows an earlier one's data; typical after fast facet clicks.
6. **Pagination/offset bug** — `start` in the request does not match the page the UI believes it is on.
7. **Zero results are correct** — the catalogue genuinely has no match. Check `didYouMean`/`redirect` before blaming the integration.
8. **Right data, wrong endpoint conflated** — an SRP built from `category` behaves differently from one built on `search` (different param shape, e.g. `p=` vs `q=`); check `searchRequest.apiType` before assuming the wrong root cause category.

### Fix pattern to suggest
State the API-versus-UI verdict in the first sentence and quote the two numbers that prove it. For API-side causes, give the corrected request params and say which side owns the change (storefront integration code versus Unbxd console configuration). For UI-side causes, name the specific response field the template should read, and the config key (`attributesMap`, `productAttributes`, `products.el`) that needs changing in `{siteKey}_search.js`. For races, recommend sequencing/aborting stale requests rather than debouncing alone. If the evidence cannot separate the two, say exactly which additional capture would (for example: re-run the query in an incognito window, or capture with a facet applied).

---

## PLP (Category / Browse Page) Issues

A PLP is driven by the `category` endpoint
(`https://search.unbxd.io/{apiKey}/{siteKey}/category?p=category_handle_uFilter%3A%22...%22&...`)
and by a different part of the config than search. Most PLP tickets are config,
URL-state or page-type-detection problems, not API problems — check those before
comparing counts.

### Symptoms to recognise
- Category page shows generic search results, or "no results", instead of the category's products.
- The SDK does not fire at all on category pages (works on search).
- Filters passed in the URL (`filter=brand_uFilter:"X"`) are stripped after load; no facets show as selected; unfiltered results render.
- Browser back button is stuck in a loop; the URL gains `?rows=…&page=…` immediately on load.
- Pagination shows the wrong number of pages, or infinite scroll never triggers.
- Two or three `category` calls fire on a single page load.

### What context to capture
Same as SRP (`capture.searchApi`, `capture.network`, `capture.console`, `capture.siteConfig`), but the `category` endpoint wins when a page fired both, and additionally: the page's URL/history state (`renderedPage.urlParams`, `urlHasFilterParam`, `urlHasSdkPaginationParams`, `historyLength`, `bodyClasses`) and `apiCallCounts`. Response data stays counts-and-shape only; no DOM geometry.

### The order to check things
1. **Page type** — `liveConfig.options.productType` and `liveConfig.state.productTypeOption` must be `CATEGORY`; `searchRequest.apiType` says which endpoint actually fired.
2. **Did the SDK initialise at all** — `liveConfig.instanceFound`; if false, compare the page-detection condition with `renderedPage.bodyClasses`.
3. **URL state** — a filter in `urlParams` that is absent from `searchRequest.params` means it was dropped after load.
4. **Then** the ordinary API-versus-UI count comparison, exactly as for SRP.

### Common root causes, most likely first
1. **`productType` is `SEARCH` on a category page** — or `setCategoryId` isn't extracting the category path. The page renders search results or nothing. Check `browseQueryParam` too.
2. **Page-type detection misses** — the init condition never matches, so the SDK doesn't run on PLPs at all (`instanceFound: false`). Platform-specific: Magento checks `body.catalog-category-view`, Shopify checks for a `template-collection` class.
3. **`getCategoryPage()` double-fire drops URL filters** — the constructor's `bindEvents` already calls `renderFromUrl()` when URL params exist, and the customer's init script calls `getCategoryPage()` on top of it. The second, unfiltered call wins. Signature: `urlHasFilterParam: true`, the filter missing from `searchRequest.params`, and `apiCallCounts.category > 1`.
4. **Back-button loop (`FIXED_PAGINATION` + `addToUrl`)** — with `pagination.type: FIXED_PAGINATION`, the SDK appends `rows`/`page` via `pushState` on load, creating a duplicate history entry; Back returns to the original URL and re-triggers it. `replaceState` is only used for `INFINITE_SCROLL`/`CLICK_N_SCROLL`. Signature: `urlHasSdkPaginationParams: true` plus those config values, and a grown `historyLength`.
5. **Customer URL params stripped** — `url.allowExternalUrlParams: false` (the default) removes UTM/tracking/custom params when the SDK rewrites the URL.
6. **Pagination maths wrong** — `pagination.pageSize` disagrees with the `rows` actually sent, or `pageNoParam.usePageNo` is set for start-index pagination (or vice versa).
7. **Infinite scroll never triggers** — `infiniteScrollTriggerEl` points at `window` while the real scroller is a container, `heightDiffToTriggerNextPage` is mis-sized, or the products container has `overflow: hidden`.
8. **Empty grid from a selector or field mismatch** — identical to SRP: a `selectorChecks` entry with `matchCount: 0`, or `attributesMap` fields the catalogue doesn't return.

### Fix pattern to suggest
Say which of the four checks above failed, and quote its value. Most PLP fixes are a single config key in `{siteKey}_search.js` — give the key path and the before/after value (`url.pageSizeParam.addToUrl: true → false`). For the `getCategoryPage()` double-fire, the fix is to guard the manual call rather than remove it: only call it when the URL carries no SDK state, since `renderFromUrl()` already handles that case. Say explicitly whether the change is in the customer's bundle (CX engineer redeploys it) or in the Unbxd console (catalogue/config side).

---

## Template for new issue types

```markdown
## <Issue type name>

### Symptoms to recognise
- ...

### What context to capture
<Which capture flags, what specifically, and what must NOT be captured.>

### Common root causes, most likely first
1. **<Cause>** — <signature in the captured data>.

### Fix pattern to suggest
<What the answer should recommend, and who owns the change.>
```
