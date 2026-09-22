# Unbxd Autosuggest JS SDK — Exhaustive Agent Reference

> **Package**: `@unbxd-ui/autosuggest-js-sdk`
> **Current version**: 1.1.2
> **Source**: [github.com/unbxd/autosuggest-js-sdk](https://github.com/unbxd/autosuggest-js-sdk)
> **Docs**: [unbxd.github.io/autosuggest-js-sdk](https://unbxd.github.io/autosuggest-js-sdk/)
> **No jQuery. No external dependencies. Vanilla JS only.**

---

## Table of Contents

1. [Overview & Architecture](#1-overview--architecture)
2. [Installation & Import](#2-installation--import)
3. [Initialization](#3-initialization)
4. [Complete Configuration Reference](#4-complete-configuration-reference)
5. [State Shape](#5-state-shape)
6. [API Endpoints & URL Construction](#6-api-endpoints--url-construction)
7. [Lifecycle Events (onEvent)](#7-lifecycle-events-onevent)
8. [Default Templates & CSS Classes](#8-default-templates--css-classes)
9. [Custom Templates](#9-custom-templates)
10. [Hover Interaction & Search Prefetch](#10-hover-interaction--search-prefetch)
11. [Use Cases & Patterns](#11-use-cases--patterns)
12. [Best Practices](#12-best-practices)
13. [Troubleshooting](#13-troubleshooting)
14. [Internal Architecture (Source Code)](#14-internal-architecture-source-code)
15. [UMD / CDN Usage](#15-umd--cdn-usage)
16. [Integration Checklist](#16-integration-checklist)

---

## 1. Overview & Architecture

The Unbxd Autosuggest JS SDK is a lightweight, framework-agnostic JavaScript library that provides real-time search suggestions as users type. It attaches to any `<input>` element and manages the full lifecycle: listening to input events, debouncing, fetching suggestions from the Unbxd API, rendering a suggestion dropdown, and handling hover/click/keyboard interactions.

### Supported Suggestion Types

| Type | API Config Key | doctype in API response | Description |
|------|---------------|------------------------|-------------|
| In-field suggestions | `inFields` | `IN_FIELD` | Keywords matched against indexed fields (name, category, brand) |
| Keyword suggestions | `keywordSuggestions` | `KEYWORD_SUGGESTION` | Commonly searched keywords |
| Top queries | `topQueries` | `TOP_SEARCH_QUERIES` | Most frequently searched queries site-wide |
| Promoted suggestions | `promotedSuggestions` | `PROMOTED_SUGGESTION` | Merchandising-boosted keywords from Unbxd Console |
| Popular products | `popularProducts` | `POPULAR_PRODUCTS` | Frequently viewed/searched products |
| Trending searches | `trendingSearches` | (separate API call) | Trending queries, shown before user types |

### Architecture Diagram

```
Autosuggest (core orchestrator)
├── ConfigManager      — merges user config with defaults
├── StateManager       — immutable-ish state store (query, response, dom refs)
├── APIService         — builds URLs, fires fetch requests, updates state
├── TemplateService    — resolves template functions (default or custom)
└── DOMService         — creates suggestion box, attaches events, mounts/unmounts
```

### Data Flow

```
User types → DOMService.onInputChange
  → debounce (if configured)
  → Autosuggest.setupAutosuggestion({ query })
    → APIService.fireAutosuggestRequest({ query })
      → fetch autosuggest URL → parse response → sort by doctype → setState
    → Autosuggest.renderSuggestions()
      → TemplateService.getTemplate("autosuggestionBox")(state) → HTML string
      → DOMService.updateSuggestionBoxHTML(html)
      → DOMService.mountAutosuggestionBox()
    → (if prefetch enabled) fire search requests for each suggestion
```

---

## 2. Installation & Import

### npm / Yarn

```bash
npm install @unbxd-ui/autosuggest-js-sdk
# or
yarn add @unbxd-ui/autosuggest-js-sdk
```

### ES Module Import

```js
import { Autosuggest } from "@unbxd-ui/autosuggest-js-sdk";
```

### CommonJS Import

```js
const { Autosuggest } = require("@unbxd-ui/autosuggest-js-sdk");
```

### CSS Import

```js
import "@unbxd-ui/autosuggest-js-sdk/styles.css";
```

Or via HTML link tag:

```html
<link rel="stylesheet" href="https://unpkg.com/@unbxd-ui/autosuggest-js-sdk/dist/autosuggest.css">
```

### UMD / CDN (no bundler)

```html
<script src="https://unpkg.com/@unbxd-ui/autosuggest-js-sdk/dist/index.umd.js"></script>
<script>
  const { Autosuggest } = window.AutosuggestSDK;
</script>
```

### Package Exports

| Export path | Format | File |
|------------|--------|------|
| `"."` (import) | ESM | `dist/index.esm.js` |
| `"."` (require) | CJS | `dist/index.cjs.js` |
| UMD global | UMD (`AutosuggestSDK`) | `dist/index.umd.js` |
| `"./styles.css"` | CSS | `dist/autosuggest.css` |

---

## 3. Initialization

```js
const autosuggest = new Autosuggest({
  siteKey: "your-site-key",
  apiKey: "your-api-key",
  inputBoxConfigs: { ... },
  suggestionBoxConfigs: { ... },
  apiConfigs: { ... },
  onEvent: function({ eventType, query, error }) { ... }
});
```

**CRITICAL**: The DOM element matching `inputBoxConfigs.searchInput` MUST exist in the DOM at the time of initialization. In frameworks (React, Vue, Angular), initialize inside a lifecycle hook (`useEffect`, `mounted`, etc.) after the input has rendered.

### Minimal Configuration

```js
const autosuggest = new Autosuggest({
  siteKey: "your-site-key",
  apiKey: "your-api-key",
  inputBoxConfigs: {
    searchInput: ".search-input"
  }
});
```

---

## 4. Complete Configuration Reference

### Top-Level Properties

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `siteKey` | `string` | **Yes** | `""` | Unbxd site key from the Console dashboard |
| `apiKey` | `string` | **Yes** | `""` | Unbxd API key from the Console dashboard |
| `inputBoxConfigs` | `object` | **Yes** (needs `searchInput`) | see below | Input behavior settings |
| `suggestionBoxConfigs` | `object` | No | see below | Suggestion container & template settings |
| `apiConfigs` | `object` | No | see below | API endpoint & suggestion type counts |
| `onEvent` | `function` | No | console.log | Lifecycle event callback |

### inputBoxConfigs

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `searchInput` | `string` \| `null` | **Yes** | `null` | CSS selector for the search input (e.g. `".search-input"`, `"#search-box"`). SDK calls `document.querySelector()` with this value. |
| `debounceDelay` | `number` | No | `0` | Milliseconds to wait after last keystroke before firing API call. `0` = no debounce. **Recommended: 300–500ms for production.** |
| `minChars` | `number` | No | `3` | Minimum characters before triggering API call. API fires when `input.length >= minChars`. **Recommended: 2–3.** |

### suggestionBoxConfigs

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `containerTag` | `string` | No | `"div"` | HTML tag for the suggestion container element |
| `attributes` | `object` | No | `{ class: "unx-autosuggest-box" }` | HTML attributes applied to the container. Array values are joined with space. |
| `template` | `function` \| `null` | No | `null` (uses default) | Custom template function. When provided, replaces the entire default rendering. See [Custom Templates](#9-custom-templates). |

### apiConfigs

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `apiEndpoint` | `string` | `"https://search.unbxd.io"` | Base URL for Unbxd API. Change only for private cloud / custom routing. |
| `initialRequest` | `boolean` | `false` | When `true`, fires `query=*` autosuggest call on init. Results stored as `initialRequestProducts` in state. |
| `inFields` | `{ count: number }` | `{ count: 2 }` | In-field suggestion count |
| `popularProducts` | `{ count: number, fields: string[] }` | `{ count: 3, fields: [] }` | Popular product count and optional field list. `count` is also used as `rows` for search API calls. `fields` is used for both autosuggest and search API calls. |
| `keywordSuggestions` | `{ count: number }` | `{ count: 2 }` | Keyword suggestion count |
| `topQueries` | `{ count: number }` | `{ count: 2 }` | Top query count |
| `promotedSuggestions` | `{ count: number }` | `{ count: 2 }` | Promoted suggestion count |
| `trendingSearches` | `{ count: number }` | `{ count: 5 }` | Trending search count. Set to `0` to disable. |
| `search` | `{ prefetch: boolean, filterField: string }` | `{ prefetch: false, filterField: "" }` | Controls hover-triggered search. See [Hover Interaction](#10-hover-interaction--search-prefetch). |

### Complete Default Configuration Object

```js
{
  siteKey: "",
  apiKey: "",
  inputBoxConfigs: {
    searchInput: null,
    debounceDelay: 0,
    minChars: 3,
  },
  suggestionBoxConfigs: {
    containerTag: "div",
    attributes: { class: "unx-autosuggest-box" },
    template: null,
  },
  apiConfigs: {
    apiEndpoint: "https://search.unbxd.io",
    initialRequest: false,
    inFields: { count: 2 },
    popularProducts: { count: 3, fields: [] },
    keywordSuggestions: { count: 2 },
    topQueries: { count: 2 },
    promotedSuggestions: { count: 2 },
    trendingSearches: { count: 5 },
    search: { prefetch: false, filterField: "" }
  },
  onEvent: function ({ eventType }) {
    console.log(`Unbxd Running onEvent with ${eventType}`);
  }
}
```

---

## 5. State Shape

The SDK maintains internal state via `StateManager`. The state object has this shape:

```js
{
  query: "",                          // Current search input value (trimmed)
  response: {
    initialRequestProducts: [],       // Products from query=* initial call
    products: [],                     // Raw products array from latest autosuggest response
    trendingSearches: [],             // From separate trending-queries API call
    popularProducts: [],              // Sorted: doctype === "POPULAR_PRODUCTS"
    inFields: [],                     // Sorted: doctype === "IN_FIELD"
    keywordSuggestions: [],           // Sorted: doctype === "KEYWORD_SUGGESTION"
    promotedSuggestions: [],          // Sorted: doctype === "PROMOTED_SUGGESTION"
    topSearchQueries: [],             // Sorted: doctype === "TOP_SEARCH_QUERIES"
    prefetchedSearchResults: {},      // { "query": [...products], "query:filter": [...products] }
  },
  dom: {
    inputBox: null,                   // Reference to the search input DOM element
    autosuggestionBox: null           // Reference to the suggestion container DOM element
  }
}
```

### How Products Are Sorted

The Unbxd autosuggest API returns all suggestions in a single `response.products` array. Each product has a `doctype` field. The SDK's `getSortedProducts()` utility groups them:

```js
// From src/utilities/helpers.js
products.forEach((product) => {
  result[product.doctype]
    ? result[product.doctype].push(product)
    : result[product.doctype] = [product];
});
// Result keys: POPULAR_PRODUCTS, IN_FIELD, KEYWORD_SUGGESTION, PROMOTED_SUGGESTION, TOP_SEARCH_QUERIES
```

### `initialRequestProducts` data shape discrepancy

**IMPORTANT**: The SDK source code (`Autosuggest.js`) treats `initialRequestProducts` as an object with keys like `.popularProducts`, `.topSearchQueries`, etc. However, the **minified/production bundle** stores it as a **flat array** of product objects where each has a `doctype` field.

When overriding `renderSuggestions` or working with initial request data, always handle both shapes:

```js
var ip = state.response.initialRequestProducts;
if (Array.isArray(ip)) {
  // Minified SDK: flat array — sort by doctype
  var sorted = {};
  ip.forEach(function(item) { (sorted[item.doctype] = sorted[item.doctype] || []).push(item); });
  var initialProducts = sorted["POPULAR_PRODUCTS"] || [];
} else if (ip && typeof ip === "object") {
  // Source SDK: structured object
  var initialProducts = ip.popularProducts || [];
}
```

### State Key Convention

- `getState(key)` uses dot notation: `"response.popularProducts"`
- `updateState(keychain, value)` uses double-underscore: `"response__popularProducts"`

---

## 6. API Endpoints & URL Construction

### Autosuggest API

```
GET {apiEndpoint}/{apiKey}/{siteKey}/autosuggest
  ?q={query}
  &version=V2
  &inFields.count={inFields.count}
  &keywordSuggestions.count={keywordSuggestions.count}
  &popularProducts.count={popularProducts.count}
  [&popularProducts.fields={fields.join(',')}]
  &topQueries.count={topQueries.count}
  &promotedSuggestions.count={promotedSuggestions.count}
```

**Example**:
```
https://search.unbxd.io/abc123/ss-site-key/autosuggest?q=shoes&version=V2&inFields.count=2&keywordSuggestions.count=2&popularProducts.count=3&topQueries.count=2&promotedSuggestions.count=2
```

### Trending Searches API

```
GET {apiEndpoint}/{apiKey}/{siteKey}/autosuggest
  ?trending-queries=true
  &q=*
```

### Search API (for hover prefetch / on-hover)

```
GET https://search.unbxd.io/{apiKey}/{siteKey}/search
  ?q={query}
  &rows={popularProducts.count}
  &indent=off
  &facet=off
  &analytics=false
  &redirect=false
  [&fields={popularProducts.fields.join(',')}]
  [&filter={filterField}:"{filterValue}"]
```

### When Each API Is Called

| Trigger | API Called | Condition |
|---------|-----------|-----------|
| SDK init | Autosuggest (`q=*`) | `initialRequest: true` |
| SDK init | Trending Searches | `trendingSearches.count > 0` |
| User types (meets minChars) | Autosuggest (`q={input}`) | Always |
| After autosuggest response | Search (for each suggestion) | `search.prefetch: true` |
| User hovers suggestion | Search (for hovered query) | `search.prefetch: false` (lazy) |
| User hovers suggestion | State lookup (no API) | `search.prefetch: true` (already fetched) |

---

## 7. Lifecycle Events (onEvent)

The `onEvent` callback receives `{ eventType, query?, error? }`.

| Event Name | Extra Fields | When Fired |
|------------|-------------|------------|
| `BEFORE_TRENDING_SEARCHES_API_CALL` | — | Before trending searches fetch |
| `AFTER_TRENDING_SEARCHES_API_CALL` | — | After trending searches response |
| `BEFORE_AUTOSUGGEST_API_CALL` | `query` | Before autosuggest fetch |
| `AFTER_AUTOSUGGEST_API_CALL` | `query` | After autosuggest response |
| `AUTOSUGGEST_QUERY_UPDATED` | `query` | Every time input value changes |
| `INPUT_FOCUS` | — | Search input gains focus |
| `INPUT_BLUR` | — | Search input loses focus |
| `ERROR` | `error` | Any API or DOM error |

### Example

```js
onEvent: function ({ eventType, query, error }) {
  switch (eventType) {
    case "BEFORE_AUTOSUGGEST_API_CALL":
      showSpinner();
      break;
    case "AFTER_AUTOSUGGEST_API_CALL":
      hideSpinner();
      trackSearch(query);
      break;
    case "ERROR":
      reportToSentry(error);
      break;
  }
}
```

---

## 8. Default Templates & CSS Classes

When no custom `template` is provided, the SDK uses built-in HTML templates.

### Default Rendering Logic

1. **No query + trending searches exist** → render trending searches only
2. **Has query + products exist** → render popular products grid + suggestions column
3. **No query + no trending + no initial products** → unmount (hide) the box
4. **Has query + no products** → unmount (hide) the box

### Default HTML Structure

```html
<!-- With query (suggestions + products) -->
<div class="unx-autosuggest-box">
  <!-- Popular products grid -->
  <div class="unx-popular-products">
    <div class="unx-item unx-popular-product">
      <img src="..." />
      <div>Product Title</div>
      <div>$29.99</div>
    </div>
    <!-- ... more products -->
  </div>

  <!-- Suggestions column -->
  <div class="unx-suggestions">
    <div class="unx-infield-suggestions">
      <!-- ::before pseudo "Recent Searches" -->
      <div class="unx-item unx-infield-suggestion" data-doctype="infield_suggestion" data-value="...">
        suggestion text
        <span class="unx-item" data-doctype="infield_suggestion" data-value="query:filter">In Category</span>
      </div>
    </div>
    <div class="unx-keyword-suggestions">
      <!-- ::before pseudo "Suggestions" -->
      <div class="unx-item unx-keyword-suggestion" data-doctype="keyword_suggestion" data-value="...">text</div>
    </div>
    <div class="unx-promoted-suggestions">
      <!-- ::before pseudo "Promoted" -->
      <div class="unx-item unx-promoted-suggestion" data-doctype="promoted_suggestion" data-value="...">text</div>
    </div>
    <div class="unx-top-search-queries">
      <!-- ::before pseudo "Top Queries" -->
      <div class="unx-item unx-top-search-query" data-doctype="top_search_query" data-value="...">text</div>
    </div>
  </div>
</div>

<!-- Without query (trending searches) -->
<div class="unx-autosuggest-box">
  <div class="unx-trending-searches">
    <!-- ::before pseudo "Trending Searches" -->
    <div class="unx-item unx-trending-search">trending term</div>
  </div>
</div>
```

### CSS Class Reference

| Class | Element | Description |
|-------|---------|-------------|
| `unx-autosuggest-box` | Container | Main suggestion box (default class) |
| `unx-popular-products` | Wrapper | Grid container for product cards |
| `unx-popular-product` | Card | Individual product card |
| `unx-suggestions` | Column | Right column with text suggestions |
| `unx-infield-suggestions` | Section | In-field suggestions group |
| `unx-keyword-suggestions` | Section | Keyword suggestions group |
| `unx-promoted-suggestions` | Section | Promoted suggestions group |
| `unx-top-search-queries` | Section | Top queries group |
| `unx-trending-searches` | Section | Trending searches group |
| `unx-trending-search` | Item | Individual trending search pill |
| `unx-item` | Item | Generic suggestion item (used for hover detection) |

### Data Attributes on Suggestion Items

| Attribute | Purpose |
|-----------|---------|
| `data-doctype` | Type identifier: `infield_suggestion`, `keyword_suggestion`, `promoted_suggestion`, `top_search_query` |
| `data-value` | The suggestion value (query text). For in-field with filters: `"query:filterValue"` |

**IMPORTANT for hover**: The DOMService hover handler checks for `class="unx-item"` AND `data-doctype` in `["infield_suggestion", "keyword_suggestion", "promoted_suggestion", "top_search_query"]`. Custom templates MUST include these attributes on hoverable suggestion items for hover-to-search to work.

---

## 9. Custom Templates

### Template Function Signature

```js
suggestionBoxConfigs: {
  template: function (state) {
    // `this` is bound to TemplateService instance
    // `this.getTemplate(name)` returns a built-in sub-template function
    // Must return an HTML string
  }
}
```

### State Object Passed to Template

```js
{
  query: "shoes",
  response: {
    products: [...],                  // Raw products array
    popularProducts: [...],           // Sorted popular products
    inFields: [...],                  // Sorted in-field suggestions
    keywordSuggestions: [...],        // Sorted keyword suggestions
    promotedSuggestions: [...],       // Sorted promoted suggestions
    topSearchQueries: [...],          // Sorted top queries
    trendingSearches: [...],          // Trending searches
    initialRequestProducts: [...],    // Products from initial q=* call
    prefetchedSearchResults: {...}    // Prefetched search results by query
  }
}
```

### Available Sub-Templates via `this.getTemplate(name)`

| Name | Input Key | Description |
|------|-----------|-------------|
| `"popularProducts"` | `{ POPULAR_PRODUCTS: [] }` | Product cards with image, title, price |
| `"inFields"` | `{ IN_FIELD: [] }` | In-field suggestions with optional filter chips |
| `"keywordSuggestions"` | `{ KEYWORD_SUGGESTION: [] }` | Keyword suggestion items |
| `"promotedSuggestions"` | `{ PROMOTED_SUGGESTIONS: [] }` | Promoted suggestion items |
| `"topSearchQueries"` | `{ TOP_SEARCHES: [] }` | Top search query items |
| `"trendingSearches"` | `{ TRENDING_SEARCHES: [] }` | Trending search pills |

### Calling Sub-Templates

```js
// Use .call(this, data) to preserve TemplateService context
const html = this.getTemplate("popularProducts").call(this, {
  POPULAR_PRODUCTS: state.response.popularProducts
});

// Or without .call() for templates that don't use `this`
const html = this.getTemplate("popularProducts")({
  POPULAR_PRODUCTS: state.response.popularProducts
});
```

**Note**: `inFields` template uses `this.configurations` internally, so it MUST be called with `.call(this, ...)`.

### Custom Template Example — Trending + Products Split

```js
function MyTemplate(state) {
  const {
    query,
    response: {
      trendingSearches = [],
      popularProducts = [],
      initialRequestProducts = [],
      inFields = [],
      keywordSuggestions = [],
      promotedSuggestions = [],
      topSearchQueries = []
    } = {}
  } = state;

  // No query: show trending searches + initial products
  if (!query || query.trim().length === 0) {
    const trendingHTML = trendingSearches.length
      ? this.getTemplate("trendingSearches").call(this, { TRENDING_SEARCHES: trendingSearches })
      : "";
    const productsHTML = initialRequestProducts.length
      ? this.getTemplate("popularProducts").call(this, { POPULAR_PRODUCTS: initialRequestProducts })
      : "";
    return `<div class="my-autosuggest-empty">
      <div class="my-trending">${trendingHTML}</div>
      <div class="my-products">${productsHTML}</div>
    </div>`;
  }

  // Has query: show suggestions + products
  const products = popularProducts.length > 0 ? popularProducts : [];
  const productsHTML = this.getTemplate("popularProducts").call(this, { POPULAR_PRODUCTS: products });

  const suggestionsHTML = [
    { title: "In-field", items: inFields, key: "IN_FIELD", template: "inFields" },
    { title: "Keywords", items: keywordSuggestions, key: "KEYWORD_SUGGESTION", template: "keywordSuggestions" },
    { title: "Promoted", items: promotedSuggestions, key: "PROMOTED_SUGGESTIONS", template: "promotedSuggestions" },
    { title: "Top Queries", items: topSearchQueries, key: "TOP_SEARCHES", template: "topSearchQueries" },
  ]
    .filter(s => s.items.length > 0)
    .map(s => this.getTemplate(s.template).call(this, { [s.key]: s.items }))
    .join("");

  return `<div class="my-autosuggest">
    <div class="my-suggestions">${suggestionsHTML}</div>
    <div class="my-products">${productsHTML}</div>
  </div>`;
}
```

### Fully Custom Template (No Sub-Templates)

```js
function FullyCustomTemplate(state) {
  const { query, response: { popularProducts = [], keywordSuggestions = [] } = {} } = state;

  const productsHTML = popularProducts.map(p =>
    `<div class="my-product">
      <img src="${p.imageUrl}" alt="${(p.title || '').replace(/"/g, '&quot;')}" />
      <span>${p.title}</span>
      <span>$${p.price}</span>
    </div>`
  ).join("");

  const suggestionsHTML = keywordSuggestions.map(s =>
    `<div class="unx-item" data-doctype="keyword_suggestion" data-value="${s.autosuggest}">
      ${highlightMatch(s.autosuggest, query)}
    </div>`
  ).join("");

  return `<div class="my-custom-box">
    <div class="my-suggestions-col">${suggestionsHTML}</div>
    <div class="my-products-col">${productsHTML}</div>
  </div>`;
}

function highlightMatch(text, query) {
  if (!query?.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).replace(new RegExp(`(${escaped})`, 'gi'), '<strong>$1</strong>');
}
```

---

## 10. Hover Interaction & Search Prefetch

### How It Works

When a user hovers over a suggestion item (in-field, keyword, promoted, or top query), the SDK can show related products. There are two modes:

#### Mode 1: Prefetch (`search.prefetch: true`)

After each autosuggest API response, the SDK immediately fires search API calls for ALL suggestion items. Results are cached in `state.response.prefetchedSearchResults`. On hover, products are read from cache — no additional API call.

**Pros**: Instant product display on hover.
**Cons**: More upfront API calls.

#### Mode 2: Lazy / On-Hover (`search.prefetch: false`)

Search API is called only when the user actually hovers over a suggestion. Results are cached after first hover.

**Pros**: Fewer API calls.
**Cons**: Slight delay on first hover.

### Filter Field

When `search.filterField` is set (e.g. `"brand"` or `"category"`), in-field suggestions may include filter values. The SDK constructs filtered search URLs like:

```
&filter=brand:"Nike"
```

The `data-value` on in-field items with filters uses the format `"query:filterValue"`.

### Hover Detection Requirements

The DOMService hover handler (`onAutosuggestionBoxHover`) checks:

1. Element has class `unx-item`
2. Element has `data-doctype` matching one of: `infield_suggestion`, `keyword_suggestion`, `promoted_suggestion`, `top_search_query`
3. `data-value` contains the query text (and optionally `:filterValue`)

**If using custom templates, you MUST include these attributes on hoverable items.**

### Popular Products Update on Hover

When hover triggers a product update, only the `.unx-popular-products` section is re-rendered (via `DOMService.updatePopularProductsSection`), not the entire suggestion box. This provides smooth UX.

---

## 11. Use Cases & Patterns

### Use Case 1: Basic Autosuggest (Minimal)

```js
const autosuggest = new Autosuggest({
  siteKey: "your-site-key",
  apiKey: "your-api-key",
  inputBoxConfigs: {
    searchInput: ".search-input",
    debounceDelay: 300,
    minChars: 2,
  }
});
```

### Use Case 2: Initial Request + Trending Searches (Show on Focus)

```js
const autosuggest = new Autosuggest({
  siteKey: "your-site-key",
  apiKey: "your-api-key",
  inputBoxConfigs: {
    searchInput: ".search-input",
    debounceDelay: 300,
    minChars: 2,
  },
  apiConfigs: {
    initialRequest: true,
    trendingSearches: { count: 8 },
    popularProducts: { count: 4, fields: ["title", "imageUrl", "price"] },
  },
  suggestionBoxConfigs: {
    template: function(state) {
      const { query, response: { trendingSearches = [], initialRequestProducts = [], popularProducts = [] } = {} } = state;

      if (!query || query.trim().length === 0) {
        if (trendingSearches.length > 0) {
          return this.getTemplate("trendingSearches").call(this, { TRENDING_SEARCHES: trendingSearches });
        }
        if (initialRequestProducts.length > 0) {
          return this.getTemplate("popularProducts").call(this, { POPULAR_PRODUCTS: initialRequestProducts });
        }
        return "";
      }

      return this.getTemplate("popularProducts").call(this, { POPULAR_PRODUCTS: popularProducts });
    }
  }
});
```

### Use Case 3: Initial Request WITHOUT Trending Searches

```js
apiConfigs: {
  initialRequest: true,
  trendingSearches: { count: 0 },  // disabled
  topQueries: { count: 5 },
  keywordSuggestions: { count: 3 },
  popularProducts: { count: 4, fields: [] },
}
```

### Use Case 4: Full-Featured with Prefetch

```js
const autosuggest = new Autosuggest({
  siteKey: "your-site-key",
  apiKey: "your-api-key",
  inputBoxConfigs: {
    searchInput: ".search-input",
    debounceDelay: 500,
    minChars: 3,
  },
  apiConfigs: {
    apiEndpoint: "https://search.unbxd.io",
    initialRequest: true,
    inFields: { count: 5 },
    popularProducts: { count: 5, fields: ["title", "imageUrl", "price", "productUrl"] },
    keywordSuggestions: { count: 5 },
    topQueries: { count: 5 },
    promotedSuggestions: { count: 5 },
    trendingSearches: { count: 5 },
    search: { prefetch: true, filterField: "category" }
  },
  suggestionBoxConfigs: {
    containerTag: "div",
    attributes: {
      class: ["my-autosuggest-box"],
      "data-testid": "autosuggest"
    },
    template: MyCustomTemplate,
  },
  onEvent: function({ eventType, query, error }) {
    if (eventType === "ERROR") {
      console.error("Autosuggest error:", error);
    }
  }
});
```

### Use Case 5: React Integration

```jsx
import { useEffect, useRef } from "react";
import { Autosuggest } from "@unbxd-ui/autosuggest-js-sdk";
import "@unbxd-ui/autosuggest-js-sdk/styles.css";

function SearchBar({ siteKey, apiKey }) {
  const inputRef = useRef(null);
  const autosuggestRef = useRef(null);

  useEffect(() => {
    if (!inputRef.current) return;

    autosuggestRef.current = new Autosuggest({
      siteKey,
      apiKey,
      inputBoxConfigs: {
        searchInput: "#unbxd-search-input",
        debounceDelay: 300,
        minChars: 2,
      },
      apiConfigs: {
        initialRequest: true,
        trendingSearches: { count: 5 },
        popularProducts: { count: 4, fields: [] },
      },
    });
  }, [siteKey, apiKey]);

  return <input ref={inputRef} id="unbxd-search-input" type="text" placeholder="Search..." />;
}
```

---

## 12. Best Practices

### Performance

| Setting | Recommended | Why |
|---------|------------|-----|
| `debounceDelay` | 300–500ms | Reduces API calls during rapid typing |
| `minChars` | 2–3 | Prevents excessive calls on short input |
| Suggestion counts | Moderate (3–5 per type) | Balances richness with response time |
| `search.prefetch` | `false` for most sites | Reduces upfront API calls; use `true` only if hover UX is critical |

### Template Customization

- Always return a valid HTML string from template functions
- Use `this.getTemplate(name)` to reuse built-in sub-templates
- For hover to work in custom templates, include `class="unx-item"` and `data-doctype` / `data-value` attributes
- For popular products section to update on hover, use the class `unx-popular-products` on the products container

### Error Handling

- Always provide an `onEvent` callback in production
- Check for `eventType === "ERROR"` and log/report errors
- Integrate with error tracking (Sentry, Datadog, etc.)

### API Endpoint

- Use the default `https://search.unbxd.io` unless you have a custom deployment
- Ensure the endpoint is accessible from your domain (no CORS issues)

### DOM Initialization

- Ensure the search input element exists in the DOM before SDK initialization
- In SPAs, initialize in `useEffect` / `mounted` / `ngAfterViewInit`
- If the input is inside a modal/drawer that opens later, initialize after the modal opens

---

## 13. Troubleshooting

### Suggestions Not Showing

1. **Check required config**: `siteKey`, `apiKey`, `inputBoxConfigs.searchInput` must all be set
2. **Check DOM**: The element matching `searchInput` must exist when SDK initializes
3. **Check feed**: Unbxd feed must be uploaded, indexed, and FTU flow completed
4. **Check console**: Look for JS errors
5. **Check network**: Verify autosuggest API requests return 200 with valid JSON
6. **Check minChars**: User must type at least `minChars` characters
7. **Check CORS**: Ensure `search.unbxd.io` is accessible from your domain

### Too Many API Requests

1. Increase `debounceDelay` to 300–500ms
2. Increase `minChars` to 2–3
3. Lower suggestion `count` values
4. Set `search.prefetch: false` if not needed

### Hover Not Updating Products

1. Ensure suggestion items have `class="unx-item"` and `data-doctype` attribute **on every nested child element** (not just the outer wrapper) — SDK uses `event.target.classList.contains("unx-item")`, NOT `closest()`
2. Ensure `data-value` contains the suggestion text
3. Ensure products container has class `unx-popular-products`
4. Check that `search.prefetch` or lazy search is configured
5. If using custom templates, override `renderPopularProductsOnly` to use your custom product builder

### Autosuggest Box Appears Then Immediately Vanishes

This is a race condition between `onInputFocus` (mounts box) and `onDocumentClick` (unmounts box). Common when the search input is inside a `<details>/<summary>` modal:

1. User clicks summary to open modal → input auto-focuses → SDK mounts box
2. Same click event propagates to document → `onDocumentClick` fires → unmounts box

**Fix**: Override `unmountAutosuggestionBox` with a focus-time guard:
```js
var lastFocusTime = 0;
inputBox.addEventListener("focus", function() { lastFocusTime = Date.now(); });
var origUnmount = domService.unmountAutosuggestionBox.bind(domService);
domService.unmountAutosuggestionBox = function() {
  if (Date.now() - lastFocusTime < 200) return;
  origUnmount();
};
```

### Autosuggest Not Working on Mobile (Multiple Inputs)

The site renders 2+ identical `<input>` elements (desktop header + mobile header) with the same selector. `querySelector` always returns the first (desktop) input, which is hidden on mobile.

**Fix**: Use dynamic input rebinding — mark the focused input with a unique data attribute and re-initialize the SDK when a different input gets focus. See `patterns/learned-patterns.md` for the full pattern.

### Trending Searches Not Appearing

1. Ensure `trendingSearches.count > 0`
2. Check network for the trending-queries API call
3. Trending searches show only when query is empty (on focus, before typing)

---

## 14. Internal Architecture (Source Code)

### File Structure

```
src/
├── index.js                          # Entry point: export { Autosuggest }
├── core/
│   └── Autosuggest.js                # Main orchestrator class
├── managers/
│   ├── ConfigManager.js              # Merges user config with defaults via extend()
│   └── StateManager.js               # Immutable-ish state store with dot/underscore key access
├── services/
│   ├── APIService.js                 # URL construction, fetch, state updates
│   ├── DOMService.js                 # DOM creation, event attachment, mount/unmount
│   └── TemplateService.js            # Template resolution and default template
├── templates/
│   ├── InFieldsHTMLTemplate.js       # Default in-field suggestions HTML
│   ├── KeywordSuggestionsHTMLTemplate.js
│   ├── PopularProductsHTMLTemplate.js
│   ├── PromotedSuggestionsHTMLTemplate.js
│   ├── TopSearchQueriesHTMLTemplate.js
│   └── TrendingSearchesHTMLTemplate.js
├── constants/
│   ├── options.js                    # Default configuration object
│   ├── constants.js                  # Config schema (for future validation)
│   └── eventsLib.js                  # Event name constants
├── utilities/
│   ├── debounce.js                   # Simple debounce function
│   ├── extend.js                     # Deep merge (defaults + user config)
│   └── helpers.js                    # getSortedProducts (groups by doctype)
└── styles/
    └── autosuggest.css               # Default styles
```

### Constructor Flow

```
new Autosuggest(configs)
  1. StateManager()               — initialize empty state
  2. ConfigManager({ configs })   — deep merge defaults + user config
  3. APIService({ configurations, setState, getState })
     → fireInitialRequest()       — if initialRequest: true, fire q=* autosuggest
                                  — if trendingSearches.count > 0, fire trending API
  4. TemplateService({ configurations, getState })
     → register built-in templates
     → if custom template provided, bind it as "autosuggestionBox"
  5. DOMService({ configurations, getState, setState, callbacks... })
     → initializeDOM()            — querySelector for input, create suggestion box element
     → attachAutosuggestEvents()  — input, focus, blur, document click, mouseover, keydown
```

### Event Handlers

| Event | Target | Handler | Behavior |
|-------|--------|---------|----------|
| `input` | searchInput | `onInputChange` | Trim, check minChars, debounce, fire autosuggest |
| `focus` | searchInput | `onInputFocus` | Set query in state, render suggestions (shows trending/initial) |
| `blur` | searchInput | `onInputBlur` | Unmount suggestion box |
| `click` | document | `onDocumentClick` | If click outside input+box, unmount |
| `mouseover` | autosuggestionBox | `onAutosuggestionBoxHover` | Check data-doctype, fire/read search, update products |
| `keydown` | searchInput | `onInputKeyDown` | On Enter, unmount suggestion box |

### Config Merge Behavior (extend utility)

- Deep merges objects recursively
- `attributes` key is shallow-merged (spread, not deep)
- User values take priority over defaults
- `null`/`undefined` user values fall back to defaults via `??`

---

## 15. UMD / CDN Usage

For sites without a bundler:

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://unpkg.com/@unbxd-ui/autosuggest-js-sdk/dist/autosuggest.css">
</head>
<body>
  <input type="text" class="search-input" placeholder="Search...">

  <script src="https://unpkg.com/@unbxd-ui/autosuggest-js-sdk/dist/index.umd.js"></script>
  <script>
    const { Autosuggest } = window.AutosuggestSDK;

    const autosuggest = new Autosuggest({
      siteKey: "your-site-key",
      apiKey: "your-api-key",
      inputBoxConfigs: {
        searchInput: ".search-input",
        debounceDelay: 300,
        minChars: 2,
      },
      apiConfigs: {
        initialRequest: true,
        trendingSearches: { count: 5 },
        popularProducts: { count: 4, fields: [] },
      }
    });
  </script>
</body>
</html>
```

---

## 16. Integration Checklist

Use this checklist when building a new autosuggest integration:

### Prerequisites

- [ ] Unbxd account created and site configured
- [ ] Product feed uploaded and indexed
- [ ] FTU flow completed
- [ ] `siteKey` and `apiKey` obtained from Unbxd Console
- [ ] Required feed fields mapped: `title`, `imageUrl`, `price`, `categoryPath`, `uniqueId`, `productUrl`

### Implementation

- [ ] Install package: `npm install @unbxd-ui/autosuggest-js-sdk`
- [ ] Import SDK and CSS
- [ ] Add search `<input>` element to HTML with identifiable selector
- [ ] Initialize `Autosuggest` with required config (`siteKey`, `apiKey`, `searchInput`)
- [ ] Set `debounceDelay` (300–500ms recommended)
- [ ] Set `minChars` (2–3 recommended)
- [ ] Configure suggestion type counts based on UI design
- [ ] Decide on `initialRequest` (true for show-on-focus experience)
- [ ] Decide on `trendingSearches` count (0 to disable)
- [ ] Decide on `search.prefetch` (true for instant hover, false for lazy)
- [ ] Set `search.filterField` if in-field suggestions have filters

### Custom Template (if needed)

- [ ] Create template function receiving `state` object
- [ ] Return valid HTML string
- [ ] Include `class="unx-item"` and `data-doctype`/`data-value` on hoverable items
- [ ] Include `class="unx-popular-products"` on products container for hover updates
- [ ] Use `this.getTemplate(name)` for built-in sub-templates where appropriate

### Styling

- [ ] Import default CSS OR write custom styles
- [ ] Override default classes as needed
- [ ] Use `suggestionBoxConfigs.attributes` to add custom classes
- [ ] Test responsive behavior on mobile

### Production

- [ ] Add `onEvent` callback for error handling
- [ ] Integrate error reporting (Sentry, etc.)
- [ ] Test on staging with real feed data
- [ ] Verify API calls in network tab (correct endpoint, 200 responses)
- [ ] Verify suggestion display for various query lengths
- [ ] Test focus/blur/click-outside behavior
- [ ] Test hover interaction (products update)
- [ ] Test keyboard Enter (closes suggestions)
- [ ] Test on mobile / touch devices

---

## Appendix A: Product Object Shape (from API)

Each product in the autosuggest response has at minimum:

```js
{
  doctype: "POPULAR_PRODUCTS",  // or IN_FIELD, KEYWORD_SUGGESTION, etc.
  autosuggest: "search term",   // the suggestion text
  // For POPULAR_PRODUCTS:
  title: "Product Name",
  imageUrl: "https://...",
  price: 29.99,
  uniqueId: "product-123",
  productUrl: "/product/123",
  // ... other fields from your feed
}
```

For in-field suggestions with filters:

```js
{
  doctype: "IN_FIELD",
  autosuggest: "shoes",
  category_in: ["Running", "Casual"],  // {filterField}_in array
}
```

## Appendix B: Trending Search Object Shape

```js
{
  autosuggest: "trending term"
}
```

## Appendix C: Prefetched Search Results Shape

```js
{
  "shoes": [{ title: "...", imageUrl: "...", price: 29.99, ... }],
  "shoes:Running": [{ ... }],  // with filter
}
```

---

*Generated from official documentation (unbxd.github.io/autosuggest-js-sdk) and source code analysis of @unbxd-ui/autosuggest-js-sdk v1.1.2.*
