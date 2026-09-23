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

This file is not the only prompt input. Two other sources are retrieved at
runtime and need no code change to improve:

- **`common-issues.md`** — previously-resolved ticket patterns, matched by
  `src/prompt/known-issues.js`. A match tells support to apply the documented
  fix instead of escalating, so adding entries here directly reduces escalations.
- **The SDK reference docs** (`AUTOSUGGEST_SDK_REFERENCE.md`,
  `unbxd-search-sdk-doc.md`, `INTERNAL_ARCHITECTURE_AND_DEBUGGING_GUIDE.md`) —
  indexed by `src/prompt/reference-docs.js`, which injects only the few
  sections matching a capture. Prefer documented behaviour from these over
  anything restated here; where this file and a reference disagree, the
  reference wins and this file should be corrected.

Several sections below are **not** tied to a single issue type, and their
headings are hardcoded in `src/prompt/builder.js`. Rename them there too if you
rename them here:

- **"SDK Asset Validation (All Issue Types)"** — prepended to every prompt.
- **"Config Bundle Review"** — added for any issue type whose
  `capture.siteConfig` is true.
- **"Self-Debug Procedure (SRP and PLP)"** / **"Self-Debug Procedure
  (Autosuggest Data)"** — added based on `capture.selfDebugKind`
  (`'results_page'` / `'autosuggest_data'`). Each documents the checks its own
  `src/capture/self-debug.js` function runs; both land in the same
  `context.selfDebug` field, which is why the popup can render either one's
  verdicts with the same code.

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

## Self-Debug Procedure (SRP and PLP)

The extension runs this procedure itself before the model sees anything, and
reports the result as `context.selfDebug`. Each check is a deterministic
pass/fail — **lead with them.** They are ordered upstream-first, so
`selfDebug.summary.firstFailure` is the most likely root cause and later
failures are often just its consequences. Do not restate a check as your own
deduction; cite its `id` and quote its evidence.

### Step 0 — did the capture see a full page load?
`fresh_page_load`. The SDK bundles and the first API call happen at page load.
If the engineer did not tick "Reload the page when capture starts", that
evidence may be missing rather than absent — never conclude "the SDK did not
load" from a capture with `reloaded: false`; ask for a recapture with reload on.

### Step 1 — bundles and initialisation
`sdk_assets_loaded`, then `sdk_initialised`. If the SDK never initialised,
compare the page-detection condition against `renderedPage.bodyClasses`
(Magento: `catalog-category-view`; Shopify: `template-collection`). Stop here —
nothing downstream is meaningful.

**Do not over-read `sdk_initialised`.** It is an upstream check, so a false
failure makes every later check look like its consequence and produces a
confidently wrong answer. Three rules, learned from a real miss:

- **`constructorOnWindow: false` means nothing.** Customer bundles keep the
  `UnbxdSearch` constructor module-scoped — it appears zero times on `window`
  in the shipped Lindt bundles while instances run normally. Never cite it as
  evidence the SDK failed. Read `instanceFound` / `sdkReady` instead.
- **Status `skip` with `probeUnavailable: true` is not a failure.** It means
  the extension could not evaluate in the page at all. Say the check was
  inconclusive and what to recapture — never report "the SDK is missing".
- **Initialisation is deferred.** Bundles construct instances inside
  `setTimeout` after building config in a `createSearchConfig()` factory
  (Lindt: 100ms for the instance, 1000ms for tab listeners). The extension
  waits for an instance before probing and reports `sdkReady.waitedMs`. If a
  capture still shows none, cross-check the console: SDK-emitted errors such as
  `'el' is not a valid DOM selector` prove the SDK *did* run and contradict an
  "SDK never initialised" reading. Trust the contradiction.

### Step 2 — is the page running as the right type?
`page_type_matches_endpoint` compares `getProductType()` with the endpoint that
actually fired. `SEARCH` on a category page is why a PLP shows search results.

### Step 3 — did the shopper's query reach the API?
`search_query_reaches_api`. Two different parameter names are involved and
confusing them is the classic mistake:

- **The page URL** uses a *configurable* name, resolved from
  `url.searchQueryParam.keyReplacer` — `q` by default, but customers rename it
  to `searchTerm`, `keyword`, `query`, … The check reads the real name by
  calling the SDK's own `getSearchQueryParam()`; never assume `q`.
- **The Unbxd API endpoint always takes `q`** (`/search?q=red`).

So the check is: the value of the configured URL param must arrive as the API's
`q`. `q=*` (match-all) while the URL carries a real term means the query never
reached the SDK — almost always because the configured `searchQueryParam` is
not the param the site actually puts the term in.

### Step 4 — is a browse page asking for the right category?
`browse_target_matches_analytics_conf`. For CATEGORY/BROWSE the target comes
from `window.UnbxdAnalyticsConf.page` — the SDK's default `getCategoryId()`
returns exactly `encodeURIComponent(window.UnbxdAnalyticsConf.page)`, and
`setCategoryId()` writes it back as `categoryPath:"A>B>C"`. That value must be
what the `p=` parameter carries (the browse param name is itself configurable
via `url.browseQueryParam.keyReplacer`, default `p`). Two failure modes:
`UnbxdAnalyticsConf` missing entirely (category undefined, and browse analytics
dead too), or `p=` pointing at a different category than the page represents —
usually `UnbxdAnalyticsConf` being assigned after SDK init rather than before.

### Step 5 — attribute mapping
`attribute_mapping_matches_response` diffs the fields the config maps
(`products.attributesMap` values, `productAttributes`) and the fields the
request asked for (`fields=`) against the field names actually present on the
returned products. A mapped field missing from the response means the template
reads `undefined` — blank tiles, placeholder images. `missingMapped` is a
config bug (wrong field name, or absent from `fields=`); `missingRequested`
alone is usually a catalogue/indexing gap.

### Step 6 — rendering
`config_selectors_resolve`, then `api_results_rendered`. A config selector with
`matchCount: 0` is the usual cause of an empty grid; the entry's `configPath`
is the exact key to fix. Products returned but no DOM nodes = rendering
problem; zero returned = go back to steps 3–4.

`api_results_rendered` is the **terminal check**: it needs the full request →
response → DOM picture, so its being the extension's auto-stop trigger too
(`src/capture/auto-stop.js`) — once it (or any earlier check) reaches a real
pass/fail, the capture stops itself without the engineer clicking anything.

### Step 7 — hygiene
`single_api_call` (double init, duplicate script tag, or a manual
`getResults()`/`getCategoryPage()` on top of the automatic one) and
`site_key_consistent`.

### How to answer with this
Name the first failing check and quote its evidence values in **Evidence**. If
every check passes and the engineer still reports a problem, say so plainly —
the fault is then in something not covered here (catalogue content, ranking
config, or a symptom that needs a different issue type — and say which).

---

## Self-Debug Procedure (Autosuggest Data)

Runs for the Autosuggest Data issue type and reports as `context.selfDebug`,
same shape and same rule as the results-page procedure above: lead with
`selfDebug.summary.firstFailure`, cite check ids and evidence, don't re-derive
what a check already answered.

This is a **different symptom class from Autosuggest Alignment.** Alignment is
"the box is in the wrong place"; this is "the box is empty or wrong" — no DOM
geometry is captured here, and no API data is captured for alignment. If an
engineer describes a positioning problem, they picked the wrong issue type;
say so rather than trying to answer it from this context.

### The checks, in order
1. **`fresh_page_load`** — same caveat as the results-page procedure: without a
   reload, "bundle not observed" is not proof it's missing.
2. **`autosuggest_bundle_loaded`** — from the shared `sdkAssets` check
   (`autosuggest.js`/`autosuggest.css`, or a combined `sdk.js`/`sdk.css` that
   serves both widgets from one file). `FAIL` only on an outright load failure;
   "not observed" is a `WARN`, since the capture may simply not have caught it.
3. **`autosuggest_api_triggered`** — did typing in the search box fire the
   `/autosuggest` call at all? If not, nothing below matters: check the
   input-event binding, the minimum-character threshold, and any debounce.
4. **`popular_products_requested`** — the single most common root cause for
   "no popular products": `popularProducts.count` in the actual request. Zero
   or absent means the widget configuration never asks the API for this data —
   full stop, regardless of what the catalogue contains. (The same pattern
   applies to `keywordSuggestions.count` / `topQueries.count` if the engineer's
   description is about those instead; read the request params directly.)
5. **`popular_products_returned`** — count requested vs. count actually in
   `responseSummary.sections.popularProducts`. A gap here, with a count > 0
   requested, points first at `popularProducts.filter` — read its value
   (`responseSummary.requestedPopularProductsFilter`) and consider whether it
   excludes every product for the current catalogue/market/locale (a common
   pattern: a market filter like `available_markets:AU` evaluated on a site
   visited from the wrong region, or simply misconfigured for this catalogue).
   `responseSummary.parsed: false` means the response wasn't JSON at all —
   usually an HTML error or bot-challenge page from a CDN/WAF. Report that as a
   network/access problem (quote the status and any edge headers such as
   `cf-ray` or `server`), not as a config problem.
6. **`popular_products_rendered`** — only reached once the API is confirmed to
   return products: does `rendered.popularProductNodeCounts` show anything
   inside the dropdown? A `FAIL` here is a template/container-selector problem
   in `autosuggest.js`, not a data problem — don't conflate the two.

`popular_products_rendered` is the **terminal check** — the auto-stop watcher
(`src/capture/auto-stop.js`) treats it, or any earlier FAIL, as "conclusive"
and stops the capture on its own, no manual "Stop & analyse" needed.

### Autosuggest is a different SDK from search
Per `AUTOSUGGEST_SDK_REFERENCE.md`, autosuggest is **not** the vanilla search
widget and does not use its shapes. Getting this wrong sends you looking for
config that was never there:

- Constructed as `new Autosuggest({...})` from **`window.AutosuggestSDK`** — not
  `UnbxdSearch`, and not under `window.unbxdSearch`.
- Config is `siteKey`, `apiKey`, **`inputBoxConfigs`**, **`suggestionBoxConfigs`**,
  **`apiConfigs`** — there is no `options.products`/`attributesMap` here.
- State is read with `getState("response.popularProducts")` (dot notation);
  writes use double underscores (`response__popularProducts`).
- `sdkState.configs` surfaces the fields that decide whether a call fires at
  all: `inputBoxConfigs.searchInput` (+ how many elements it matches),
  `minChars` (default **3**), `debounceDelay` (default **0**), and
  `apiConfigs.popularProducts.count` (default **3**).

### The response shape (authoritative)
The API returns **one flat `response.products[]` array**, not named sections.
Every item carries a **`doctype`**, and the SDK's `getSortedProducts()` groups
them:

| doctype | Becomes |
|---|---|
| `POPULAR_PRODUCTS` | popular products |
| `KEYWORD_SUGGESTION` | keyword suggestions |
| `IN_FIELD` | in-field suggestions |
| `PROMOTED_SUGGESTION` | promoted suggestions |
| `TOP_SEARCH_QUERIES` | top queries |

`responseSummary.doctypeCounts` is the authoritative breakdown and
`responseShape` says which shape was seen. **A non-zero `POPULAR_PRODUCTS`
count with an empty popular-products section means a parsing problem, not an
API one** — say that rather than reporting "the API returned no popular
products". (One known inconsistency: the source SDK treats
`initialRequestProducts` as a keyed object while the minified bundle stores a
flat array; both are handled.)

### Documented root causes for "suggestions not showing"
From the reference's troubleshooting section — check these before theorising:

1. `siteKey`, `apiKey` and `inputBoxConfigs.searchInput` must all be set.
2. **The input element must already exist when the SDK initialises.** On
   React/Vue/Angular sites it must be constructed in a lifecycle hook after
   render — this is the most common integration failure.
3. The shopper must type at least `minChars` characters before any call fires.
4. Feed uploaded, indexed and FTU flow completed.
5. CORS: `search.unbxd.io` reachable from the customer's domain.
6. **Two identical inputs** (desktop + mobile headers sharing a selector):
   `querySelector` binds the first, which is hidden on mobile — so autosuggest
   silently does nothing on phones. Check `sdkState.configs.searchInputMatches`
   — anything above 1 makes this the prime suspect.
7. **Box appears then vanishes instantly**: a race between `onInputFocus`
   mounting it and `onDocumentClick` unmounting it, classic when the input sits
   inside a `<details>`/modal. That is a known pattern with a documented
   focus-time guard, not a data problem.

---

## Tracing a Rendered Value to its API Field

Applies to SRP, PLP and Autosuggest-data captures. The question is: *"this
thing on screen says X — where does X come from?"* Engineers usually ask it by
pasting the element. Answer it by walking the chain, never by guessing from
field names:

```
DOM text  ──▶  response field  ──▶  attributesMap alias  ──▶  template in the bundle
```

### What the capture gives you
`context.valueTrace` is present whenever the description contained a pasted
element or a quoted value. For each candidate it lists the response `field(s)`
whose content contains that value, with the matching product's `uniqueId`,
whether the field was in the request's `fields=` list, and
`mappedToAliases` — the `attributesMap` alias the template reads it through.
In agent mode, `trace_rendered_value` does the same on demand and additionally
returns the bundle snippets that render it.

### How to read it
1. **Start from the id in the element.** Customer templates interpolate the
   product's `uniqueId` into class names, so
   `class="amasty-label-for-65063"` pins the product — look at that product's
   fields, not the whole result set.
2. **Find the field carrying the value**, then the alias. An empty
   `mappedToAliases` means the template reads the raw response field directly;
   that is common and not a fault.
3. **Read the template.** `search_bundle` on the alias or field name shows the
   markup. Most tile fields are rendered conditionally —
   `${alias ? `<div …>${alias}</div>` : ""}` — so an absent or empty field
   produces *no element at all*, not an empty one. "The label is missing" and
   "the label is wrong" are therefore different bugs with different evidence.
4. **A value with no matching response field is produced client-side** — a
   template literal, a hard-coded fallback, or another script on the page
   (Magento/Amasty plugins re-render their own labels). Say so plainly instead
   of inventing a field.

### Worked example (Lindt Canada, real)
The element
`<div class="amasty-label-container amasty-label-for-65063" style="color: #917236;"><div class="amlabel-text">2 for $12</div></div>`
resolves as:

- **Response** — product `uniqueId: 65063` has `label_product_page_label: "2 for $12"`. (Nine of twelve products on that query carry the same label; others differ — `2 for $10`, `2 For $16` — so the value is per-product catalogue data, not a template constant.)
- **Config** — `attributesMap.unxLabelName → "label_product_page_label"`, `attributesMap.unxLabelColour → "label_product_page_colour"`.
- **Template** — ``${y ? `<div class="amasty-label-container amasty-label-container-${s}-cat amasty-label-for-${s}" style="color: ${v||"#917236"};"><div class="amlabel-text">${y}</div></div>` : ""}`` where `y` = `unxLabelName`, `v` = `unxLabelColour`, `s` = `uniqueId`.
- **The colour is a fallback.** `label_product_page_colour` is absent from every product in that response, so `v` is undefined and the template's own `#917236` is used — which is exactly the inline colour in the DOM. Do not report a missing colour field as the cause of a *correct-looking* label; it is working as written.

So "where does 2 for $12 come from" answers as: the `label_product_page_label`
field on that product, read through the `unxLabelName` alias, rendered by the
label block in `{siteKey}_search.js`. To change it, change the catalogue field;
to change when it appears, change the template's condition.

### Fix pattern to suggest
Name the field, the alias and the file. If the value is wrong, the fix is
catalogue-side (the field's value) or console-side (which field feeds it) —
not the template. If the element is missing entirely, check whether the field
is empty for that product and whether it is in the request's `fields=` list; a
field not requested is never returned, which reads identically to "empty" in
the DOM.

---

## Config Bundle Review

SRP, PLP and Autosuggest-data captures additionally include `siteConfig`, a
review of whichever customer bundle is relevant — `{siteKey}_search.js` /
`_search.css` for SRP/PLP, `{siteKey}_autosuggest.js` / `_autosuggest.css` for
autosuggest data issues. Most tickets in any of these three types are resolved
here rather than in the API response alone.

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

## Autosuggest Data Issues

Distinct from **Autosuggest Alignment Issues** above: this is "the dropdown is
in the right place but is empty or shows the wrong thing", not "the dropdown is
mispositioned". Picking the wrong one of the two gets the wrong capture
strategy — this type captures the API call and the config bundle, never DOM
geometry.

### Symptoms to recognise
- Popular products section is empty when the customer expects it to show items.
- Keyword suggestions or top queries missing, or showing stale/irrelevant terms.
- The dropdown opens (so it's not an alignment problem) but only shows some
  sections and not others — e.g. keyword suggestions appear but popular
  products don't.
- Works for some queries/markets/locales and not others.

### What context to capture
The actual `autosuggest` call (`capture.searchApi`, `capture.network`,
`capture.console`, `capture.siteConfig`) — reference shape confirmed from a
real production request:

```
https://search.unbxd.io/{apiKey}/{siteKey}/autosuggest?q=*&topQueries.count=5
  &keywordSuggestions.count=6&popularProducts.count=4&promotedSuggestion.count=0
  &popularProducts.fields=title,price,imageUrl,productUrl,...
  &popularProducts.filter=available_markets:AU&variants=true
```

Capture: the request params exactly as sent (the `*.count` and `*.filter`
values are the ones that matter), response section counts and shape (never
product values), whether the dropdown rendered product-like nodes, and a
review of the `{siteKey}_autosuggest.js` / `_autosuggest.css` bundle (same
`siteConfig` mechanism as SRP/PLP — see "Config Bundle Review"). No DOM
geometry, no box models.

### Common root causes, most likely first
1. **`popularProducts.count` (or the equivalent for the missing section) is 0
   or absent in the request** — the widget config never asks the API for that
   data. Nothing about the catalogue or the API matters until this is fixed.
   This is the most common cause of exactly "autosuggest isn't showing popular
   products" and is the first thing `popular_products_requested` in the
   self-debug procedure checks.
2. **`popularProducts.filter` excludes everything for this catalogue/market** —
   e.g. a market/locale filter (`available_markets:AU`) that doesn't match the
   catalogue being queried, or a stale filter left over from a copy-pasted
   config. Count requested, count returned is 0.
3. **Autosuggest API never triggers** — event binding, minimum-character
   threshold, or debounce prevents the call from firing at all. Distinguish
   from (1)/(2) by checking whether the request exists at all first.
4. **`autosuggest.js` (or the combined bundle) didn't load** — check
   `sdkAssets` before anything else; see the shared SDK Asset Validation
   section. A widget that never loaded can't have a "normal" version of this bug.
5. **API returns products, dropdown shows nothing** — a rendering/template
   problem in `autosuggest.js`: wrong container selector, a template function
   error (check `consoleErrors`), or a field the template reads that the
   response doesn't have. Confirm the API side first — don't guess at a
   template bug when the real problem is (1) or (2).
6. **Right section, wrong scope** — keyword suggestions and top queries work
   but popular products specifically don't (or vice versa): each section has
   its own independent `*.count`/`*.filter` params, so check the one that's
   actually broken rather than assuming a config problem in general.

### Fix pattern to suggest
Name the exact request param and its value (`popularProducts.count=0` →
`popularProducts.count=4`, or the filter value to relax/correct), say the
change belongs in the customer's `{siteKey}_autosuggest.js` widget config
(CX engineer edits and redeploys the bundle), and state what the engineer
should see after the change (e.g. "N popular products in the dropdown for a
match-all query"). If the cause is catalogue/indexing (the filter is correct
but the catalogue genuinely has no matching products for this market), say so
plainly instead of proposing a config change that won't fix anything.

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
4. **Response not JSON** — an HTML challenge or error page came back; `parsed: false`. Treat it as a network/access problem: quote the status code and any edge headers (`cf-ray`, `server`, `x-cache`) as evidence, and say whether it looks like a CDN/WAF block rather than an SDK bug.
5. **Race / stale render** — multiple `search`/`category` calls in the window (`otherSearchCalls`) and the UI shows an earlier one's data; typical after fast facet clicks.
6. **Pagination/offset bug** — `start` in the request does not match the page the UI believes it is on.
7. **Zero results are correct** — the catalogue genuinely has no match. Check `didYouMean`/`redirect` before blaming the integration.
8. **Right data, wrong endpoint conflated** — an SRP built from `category` behaves differently from one built on `search` (different param shape, e.g. `p=` vs `q=`); check `searchRequest.apiType` before assuming the wrong root cause category.

### Tabbed storefronts (several calls are normal)
Some SRPs are tabbed — products / recipes / articles — with **one SDK instance
per tab**, each firing its own call to the same endpoint, distinguished only by
`filter=contentType:"…"`. Lindt Canada runs three (`product`, `recipe`,
`other`).

- `allApiCalls[]` lists every captured call with its `filter` and which was
  treated as primary. **Distinct `contentType` filters are by design, not
  double initialisation** — don't report them as a duplicate-call bug. Only
  repeated calls with the *same* filter are a duplication smell.
- The primary call is matched to the tab the page is on (`pageTab`, from a
  `/tab/<name>` path segment or a `tab=` query param; the default tab usually
  carries neither). If `pageTab` is null and several tabs fired, say which call
  you analysed and that the engineer may have meant another tab.
- Counts from the wrong tab are the classic false alarm: the recipes tab
  legitimately returns zero products.

### Price rendering
Price is the most common "wrong value on the tile" ticket, and it needs four
things compared — `siteConfig.priceConfig` lays them out:

| Stage | Where |
|---|---|
| Requested | `priceConfig.requestedPriceFields` — price fields in the request's `fields=` list |
| Returned | `responseSummary.productFieldNames` — what the catalogue actually populated |
| Configured | `priceConfig.configuredPriceMappings` — `attributesMap` entries involving price |
| Drawn | `priceConfig.priceRendererInBundle` + `rendererReadsKnownFields` — what the customer's render function touches |

Read them in that order, and mind the gap between *mapped* and *read*:

- **Requested but not returned** is a catalogue/indexing gap, not a config bug.
  Lindt Canada requests seven price fields (`price`, `displayPrice`,
  `salePrice`, `sortPrice`, `specialPrice`, `originalPrice`,
  `layaMemberPrice`) and the catalogue populates two — `price` and
  `originalPrice`. Five are absent on every product. Worth reporting; by itself
  it breaks nothing.
- **Mapped but not returned is not automatically the bug.** Lindt maps
  `unxStrikePrice → discountPrice`, a field that exists nowhere in the
  catalogue, and the site still prices correctly: its template calls
  `renderProductPrice(unxPrice, specialPrice, originalPrice, uniqueId)` and
  reads `originalPrice` straight off the product, ignoring the mapping. Blaming
  that mapping would be a confident wrong answer — which is why
  `attribute_mapping_matches_response` is a WARN, not a FAIL. Check
  `priceRendererInBundle` and whether prices actually render first.
- **A strike-through / "was" price that never appears** usually means the field
  feeding it is empty, not that the renderer is broken: these renderers
  typically draw two prices only when both parse as numbers and differ
  (Lindt: `price 185` vs `originalPrice 188` → both render).
- **Mind the units.** Values arrive as plain numbers, with currency and
  decimals applied by a formatter in the bundle (`formatCanadianPrice` →
  `"$" + Number(v).toFixed(2)`). "Price shows as 188 instead of $1.88" is a
  formatter/units question, not an API one.

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
