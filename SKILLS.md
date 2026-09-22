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

The one section below that is **not** tied to an issue type is
"SDK Asset Validation (All Issue Types)" — its heading is hardcoded in
`src/prompt/builder.js` (`SDK_VALIDATION_HEADING`) and it is prepended to every
prompt regardless of which issue type is selected. Rename it there too if you
rename it here.

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
State the API-versus-UI verdict in the first sentence and quote the two numbers that prove it. For API-side causes, give the corrected request params and say which side owns the change (storefront integration code versus Unbxd console configuration). For UI-side causes, name the specific response field the template should read. For races, recommend sequencing/aborting stale requests rather than debouncing alone. If the evidence cannot separate the two, say exactly which additional capture would (for example: re-run the query in an incognito window, or capture with a facet applied).

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
