# Unbxd Search JS SDK - Complete Configuration Reference

> **SDK Version**: v2.1.14 (Latest as of Feb 2026)
> **Core SDK Version**: v0.5.13
> **CDN**: `https://libraries.unbxdapi.com/search-sdk/v2.1.14/vanillaSearch.min.js`
> **CSS**: `https://libraries.unbxdapi.com/search-sdk/v2.1.14/vanillaSearch.min.css`
> **Source**: https://unbxd.github.io/search-JS-library/

---

## Table of Contents

1. [Installation & Prerequisites](#installation--prerequisites)
2. [Getting Started](#getting-started)
3. [SDK Constructor & Authentication](#sdk-constructor--authentication)
4. [Search Box Configuration](#search-box-configuration)
5. [Products Configuration](#products-configuration)
6. [Facets Configuration](#facets-configuration)
7. [Pagination Configuration](#pagination-configuration)
8. [Page Size Configuration](#page-size-configuration)
9. [Sorting Configuration](#sorting-configuration)
10. [Product View Configuration](#product-view-configuration)
11. [Breadcrumbs Configuration](#breadcrumbs-configuration)
12. [Spell Check Configuration](#spell-check-configuration)
13. [Banners Configuration](#banners-configuration)
14. [Variants Configuration](#variants-configuration)
15. [Swatches Configuration](#swatches-configuration)
16. [No Results Configuration](#no-results-configuration)
17. [Loader Configuration](#loader-configuration)
18. [SEO Friendly URL Configuration](#seo-friendly-url-configuration)
19. [Other/Miscellaneous Configurations](#othermiscellaneous-configurations)
20. [Methods](#methods)
21. [Events](#events)

---

## Installation & Prerequisites

### Prerequisites
- Complete the Self Serve FTU flow for sign up, site creation, feed upload, relevancy, etc.
- Obtain Site Key and API Key from Unbxd dashboard.

### Installation via CDN
```html
<!-- JS -->
<script type="text/javascript" src="https://libraries.unbxdapi.com/search-sdk/v2.1.14/vanillaSearch.min.js"></script>

<!-- CSS (default theme) -->
<link rel="stylesheet" href="https://libraries.unbxdapi.com/search-sdk/v2.1.14/vanillaSearch.min.css">
```

### Installation via NPM
```bash
npm install @unbxd-ui/vanilla-search-library
```

### Browser Support
| IE / Edge | Firefox | Chrome | Safari | iOS Safari |
|-----------|---------|--------|--------|------------|
| IE11*, Edge | last 2 versions | last 2 versions | last 2 versions | last 2 versions |

---

## Getting Started

### Basic SDK Initialization
```javascript
window.unbxdSearch = new UnbxdSearch({
    siteKey: "<your site key>",
    apiKey: "<your API key>",
    searchBoxEl: document.getElementById("unbxdInput"),
    searchButtonEl: document.getElementById("searchBtn"),
    // ... other configurations
});
```

### Minimum Required HTML Structure
```html
<div class="UNX-input-wrapper">
    <input id="unbxdInput" class="UNX-input" type="text"/>
    <button id="searchBtn" class="fa fa-search"></button>
</div>
```

### Key Initialization Steps
1. Change `siteKey` and `apiKey` to your credentials
2. Provide `attributesMap` inside products object (field mapping to your catalog)
3. Provide `productAttributes` array (fields to return from search API)
4. Configure correct query selectors for your website elements
5. Set `productType` to `"SEARCH"` or `"CATEGORY"` based on the page
6. For staging sitekeys, set `searchEndPoint: "https://wingman-argocd.unbxd.io/"`

### Category Page Setup
For category pages, configure `UnbxdAnalyticsConf`:
```javascript
// Using category path
if (location.pathname === "/category-page") {
    window.UnbxdAnalyticsConf = {
        page: 'categoryPath:"LAUNDRY>WASHING MACHINES"',
        page_type: 'BOOLEAN'
    };
    productType = "CATEGORY";
}

// OR using category ID
if (location.pathname === "/category-page") {
    window.UnbxdAnalyticsConf = {
        page: "categoryPathId:categoryId1",
        page_type: 'BOOLEAN'
    };
    productType = "CATEGORY";
}
```

---

## SDK Constructor & Authentication

The SDK is initialized by creating a new `UnbxdSearch` instance. The constructor takes a single configuration object.

### Required Top-Level Parameters

| Config | Type | Required | Description |
|--------|------|----------|-------------|
| `siteKey` | String | Yes | Your Unbxd site key |
| `apiKey` | String | Yes | Your Unbxd API key |
| `searchBoxEl` | Element | Yes | The search input element |
| `searchButtonEl` | Element | No | The search button element |

---

## Search Box Configuration

These are **top-level** configurations passed directly to the `UnbxdSearch` constructor (NOT nested under any config object).

### searchBoxEl
- **Type**: Element
- **Required**: Yes
- **Default**: `null`
- **Description**: The search input HTML element on which to listen to search query changes.
```javascript
searchBoxEl: document.getElementById("unbxdInput")
```

### searchButtonEl
- **Type**: Element
- **Required**: No
- **Default**: `NA`
- **Description**: The search button element. Clicking on this will load results based on the input value in `searchBoxEl`.
```javascript
searchButtonEl: document.getElementById("searchBtn")
```

---

## Products Configuration

All product configs go under the `products` object.

```javascript
products: {
    // product configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `productType` | String | `"SEARCH"` | No | Indicates page type. Values: `"SEARCH"`, `"CATEGORY"`, or `"BROWSE"` |
| `el` | Element | `null` | **Yes** | HTML element to render products in |
| `template` | Function | (see below) | No | Custom template function for product cards |
| `productAttributes` | Array | `["title", "uniqueId", "price", "sku", "imageUrl", "displayPrice", "salePrice", "sortPrice", "productDescription", "unbxd_color_mapping", "colorName", "color"]` | No | Array of fields to return from API |
| `attributesMap` | Object | `{"unxTitle": "title", "unxImageUrl": "imageUrl", "unxPrice": "salePrice", "unxStrikePrice": "displayPrice", "unxId": "uniqueId", "unxDescription": "productDescription"}` | No | Field mapping from catalog to template vars |
| `gridCount` | Number | auto (screen size) | No | Number of columns in grid view |
| `productItemClass` | String | `"product-item"` | No | CSS class for each product card |
| `onProductClick` | Function | `function(product, event) {}` | No | Callback on product click. Receives product object and event. Note: `data-id` must be set in template |
| `defaultImage` | String | `"https://libraries.unbxdapi.com/sdk-assets/defaultImage.svg"` | No | Fallback image URL |
| `tagName` | String | `'div'` | No | HTML tag to wrap each product |
| `htmlAttributes` | Object | `{class: "UNX-search-results-block UNX-result-wrapper"}` | No | Wrapper element attributes |

### Product Template Function

The template function receives 5 parameters:
1. `product` - Product data object (with mapped fields like `unxTitle`, `unxImageUrl`, etc.)
2. `idx` - Index of current product
3. `swatchUI` - Swatch UI object with `btnList` and `imgList`
4. `productViewType` - Either `"GRID"` or `"LIST"`
5. `products` - Config info like `productItemClass`, `defaultImage`

**Returns**: HTML string

### Analytics Data Attributes for Product Template
- `data-prank` - Product rank/index (on parent wrapper)
- `data-id` - Product unique ID (on parent wrapper)
- `data-item='product'` - Mark as product item (on parent wrapper)
- `data-unxCartBtn="addToCart"` - Add to cart button
- `data-unxQtyMinus='qtyMinus'` - Quantity decrease button
- `data-unxQtyPlus='qtyPlus'` - Quantity increase button
- `data-unxQty="qty"` - Quantity input box
- `data-unxPageType="search"` or `data-unxPageType="category"` - Page type

### Product Data Actions
- `changeSwatch` - Action for swatch click element

### Infinite Scroll / Click & Scroll Notes
When using `INFINITE_SCROLL` or `CLICK_N_SCROLL`:
- Add invisible element with class `UNX-pre-loader` ABOVE products container
- Add invisible element with class `UNX-post-loader` BELOW products container
- These must NOT be placed next to each other
- Set CSS `flex-direction: column` on parent
- Each product card parent must include `data-prank=""` attribute

### Product Badging
To display product badges, include `badges_unx` in the `productAttributes` array. This field then becomes available in the product object within the template function.

---

## Facets Configuration

All facet configs go under the `facet` object.

```javascript
facet: {
    // facet configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `facetsEl` | Element | `null` | **Yes** | Element to render facets in |
| `facetTemplate` | Function | (default) | No | Custom template for facet blocks. Params: `facetObj`, `children`, `isExpanded`, `facetSearchTxt`, `facet` |
| `facetItemTemplate` | Function | (default) | No | Custom template for individual facet values. Params: `facet`, `value`, `facetSearchTxt` |
| `facetMultiSelect` | Boolean | `true` | No | Allow multiple facet value selection |
| `facetClass` | String | `"UNX-facets-block"` | No | CSS class for facet items. **Important**: Avoid overriding `UNX-change-facet`. If you must, include `.UNX-change-facet * { pointer-events: none; }` |
| `facetAction` | String | `'click'` | No | Event to trigger facet selection (`'click'` or `'change'`) |
| `selectedFacetClass` | String | `"UNX-selected-facet-btn"` | No | CSS class for selected facet items |
| `selectedFacetsEl` | Element | `null` | No | Separate element for selected facets display |
| `selectedFacetTemplate` | Function | (default) | No | Custom template for selected facets block. Params: `selections`, `facet`, `selectedFacetsConfig` |
| `selectedFacetItemTemplate` | Function | (default) | No | Custom template for each selected facet. Params: `selectedFacet`, `selectedFacetItem`, `facetConfig`, `selectedFacetsConfig` |
| `selectedFacetConfig` | Object | `{tagName: "DIV", htmlAttributes: {class: "UNX-selected-facet-lb"}, events: {}}` | No | Selected facet wrapper configuration |
| `clearAllText` | String | `"Clear All"` | No | Text for clear all button |
| `rangeTemplate` | Function | (default) | No | Custom template for range facets. Params: `range`, `selectedRange`, `facet` |
| `rangeWidgetConfig` | Object | `null` | No | Config for range slider widget (e.g., `{minLabel: "", maxLabel: "", prefix: "$"}`) |
| `facetMultilevel` | Boolean | `true` | No | Enable multilevel category facets |
| `facetMultilevelName` | String | `"Category"` | No | Multilevel field name |
| `multiLevelFacetSelectorClass` | String | `"UNX-multilevel-facet"` | No | CSS class for multilevel facet items |
| `multiLevelFacetTemplate` | Function | (default) | No | Custom template for multilevel facets. Params: `facet`, `selectedCategories`, `facetSearchTxt`, `facetConfig` |
| `facetDepth` | Number | `4` | No | Number of category filter levels |
| `clearFacetsSelectorClass` | String | `"UNX-clear-facet"` | No | CSS class for clear facets button |
| `removeFacetsSelectorClass` | String | `"UNX-remove-facet"` | No | CSS class for remove facet button |
| `onFacetLoad` | Function | `function(facets) {}` | No | Callback after facet selection/deselection |
| `applyMultipleFilters` | Boolean | `false` | No | Apply multiple filters together (shows Apply button) |
| `applyButtonText` | String | `"Apply"` | No | Text for apply button (requires `applyMultipleFilters: true`) |
| `clearButtonText` | String | `"clear"` | No | Text for clear button |
| `isCollapsible` | Boolean | `true` | No | Make facet blocks collapsible |
| `defaultOpen` | String | `"ALL"` | No | Default open state: `"ALL"`, `"FIRST"`, or `"NONE"` |
| `isSearchable` | Boolean | `true` | No | Enable search within each facet block |
| `searchPlaceHolder` | String | `""` | No | Placeholder text for facet search input |
| `enableViewMore` | Boolean | `false` | No | Show view more/less button for facets |
| `viewMoreText` | Array | `["show all", "show less"]` | No | Text for view more/less buttons |
| `viewMoreLimit` | Number | `3` | No | Max facet values shown before "view more" |
| `actionBtnClass` | String | `"UNX-action-item"` | No | CSS class for click-triggerable facet wrapper elements (moved to facet config from v2.1.5) |
| `actionChangeClass` | String | `"UNX-action-change"` | No | CSS class for change/keyup-triggerable elements (moved to facet config from v2.1.5) |
| `tagName` | String | `"DIV"` | No | HTML tag for facet wrapper |
| `htmlAttributes` | Object | `{class: "UNX-facets-results-block"}` | No | Wrapper attributes |

### Facet Types
1. **Text Facets** - Filter by text values (brand, color, etc.)
2. **Range Facets** - Filter by numeric ranges (price, weight, etc.)
3. **Multilevel Facets** - Hierarchical category navigation

### Facet Data Actions (`data-action`)
- `changeFacet` - Select a text facet value
- `deleteFacetValue` - Deselect a text facet value
- `setRange` - Select a range facet
- `applyRange` - Apply multiple range facets at once
- `clearRangeFacets` - Clear all range facets
- `setCategoryFilter` - Select a category filter
- `clearCategoryFilter` - Clear category filter
- `viewMore` - Show all facet values
- `viewLess` - Show fewer facet values

### Facet Actions (`data-facet-action`)
- `changeFacet` - Select text facet
- `deleteFacetValue` - Deselect a facet value
- `deleteFacet` - Remove all selected values for one facet
- `deleteSelectedFacetValue` - Remove a selected facet
- `deleteSelectedRange` - Remove a selected range
- `clearPriceRange` - Clear a range facet
- `clearAllFacets` - Clear all facets
- `applyFacets` - Apply facets (when `applyMultipleFilters: true`)
- `facetOpen` - Expand facet dropdown
- `facetClose` - Collapse facet dropdown
- `searchFacets` - Search within facet values

---

## Pagination Configuration

All pagination configs go under the `pagination` object.

```javascript
pagination: {
    // pagination configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `enabled` | Boolean | `true` | **Yes** | Enable/disable pagination |
| `type` | String | `"CLICK_N_SCROLL"` | No | Pagination type: `"FIXED_PAGINATION"`, `"INFINITE_SCROLL"`, or `"CLICK_N_SCROLL"` |
| `el` | Element | `null` | No | Element to render pagination in |
| `template` | Function | (default) | No | Custom pagination template. Params: `paginationData`, `pagination` |
| `pageClass` | String | `"UNX-page-items"` | No | CSS class for pagination items |
| `selectedPageClass` | String | `"UNX-selected-page-item"` | No | CSS class for selected page |
| `preloaderClass` | String | `""` | No | Custom CSS class for pre-loader element (appended to `UNX-pre-loader`) |
| `postloaderClass` | String | `""` | No | Custom CSS class for post-loader element (appended to `UNX-post-loader`) |
| `onPaginate` | Function | `function(numberOfProducts, start, productsLn, rows, noOfPages, currentPage, isNext, isPrev) {}` | No | Callback on pagination change |
| `pageLimit` | Number | `6` | No | Number of page numbers shown (for `FIXED_PAGINATION`) |
| `infiniteScrollTriggerEl` | Element | `window` | No | Element to detect scroll boundary (for `INFINITE_SCROLL`) |
| `heightDiffToTriggerNextPage` | Number | `100` | No | Pixels from bottom to trigger next page load. Max capped at 1000. Values >300-400 may cause excessive API calls |
| `virtualization` | Boolean | `true` | No | Only render current + buffer pages on DOM (v2.1.2+, `INFINITE_SCROLL` only) |
| `bufferPages` | Number | `1` | No | Pages to prefetch ahead/behind (v2.1.2+, `INFINITE_SCROLL` only) |
| `action` | String | `'click'` | No | Trigger action: `'click'` or `'change'` |
| `tagName` | String | `'div'` | No | HTML wrapper tag |
| `htmlAttributes` | Object | `{class: "UNX-banner-block"}` | No | Wrapper attributes |

### Pagination Data (passed to template)
- `currentPage` - Current page number
- `isNext` - Has next page
- `isPrev` - Has previous page
- `noOfPages` - Total pages
- `productsLn` - Products on current page
- `numberOfProducts` - Total products
- `rows` - Page size

### Page Actions (`data-page-action`)
- `paginate` - Go to specific page (fixed pagination)
- `next` - Go to next page
- `prev` - Go to previous page
- `firstPage` - Go to first page (v2.1.5+)
- `lastPage` - Go to last page (v2.1.5+)

### Infinite Scroll Important Notes
1. Product images MUST have explicit `height` and `width` attributes
2. Parent of pre-loader and post-loader must be top-to-bottom aligned
3. CSS for `.UNX-pre-loader` and `.UNX-post-loader` must include `position: absolute; width: 100%; z-index: -1;`
4. Parent container must have `position: relative`
5. Do NOT modify height CSS of loaders; use `heightDiffToTriggerNextPage` instead

---

## Page Size Configuration

All page size configs go under the `pagesize` object.

```javascript
pagesize: {
    // page size configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `enabled` | Boolean | `true` | No | Enable/disable page size widget |
| `el` | Element | `null` | No | Element to render page size in |
| `pageSize` | Number | `12` | No | Default number of items per page |
| `options` | Array | `[8, 12, 16, 20, 24]` | No | Available page size options. Suggest multiples of grid columns |
| `pageSizeClass` | String | `"UNX-pagesize"` | No | CSS class for page size element |
| `selectedPageSizeClass` | String | `"UNX-selected-pagesize"` | No | CSS class for selected page size |
| `action` | String | `"change"` | No | Trigger action: `"change"` or `"click"` |
| `template` | Function | (default) | No | Custom template. Params: `selected`, `pagesize` |
| `tagName` | String | `"div"` | No | HTML wrapper tag |
| `htmlAttributes` | Object | `{class: "UNX-selected-pagesize"}` | No | Wrapper attributes |

---

## Sorting Configuration

All sorting configs go under the `sort` object.

```javascript
sort: {
    // sorting configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `enabled` | Boolean | `true` | No | Enable/disable sorting |
| `el` | Element | `null` | **Yes** | Element to render sorting in |
| `options` | Array | (see below) | No | Sort options array |
| `sortClass` | String | `"UNX-sort-item"` | No | CSS class for sort items |
| `selectedSortClass` | String | `"UNX-selected-sort"` | No | CSS class for selected sort |
| `template` | Function | (default) | No | Custom template. Params: `selectedSort`, `sortConfig` |
| `action` | String | `"change"` | No | Trigger action: `"click"` or `"change"` |
| `tagName` | String | `"div"` | No | HTML wrapper tag |
| `htmlAttributes` | Object | `{class: "UNX-sort-block-lb"}` | No | Wrapper attributes |

### Default Sort Options
```javascript
options: [
    { value: "price desc", text: "Price High to Low" },
    { value: "price asc", text: "Price Low to High" },
    { value: "rating asc", text: "Rating Low to High" },
    { value: "rating desc", text: "Rating High to Low" }
]
```

Each option object:
- `text` - Display text on UI
- `value` - Parameter sent in API payload

### Sort Data Actions (`data-action`)
- `changeSort` - Change sort selection
- `clearSort` - Reset sort to default (relevancy)

---

## Product View Configuration

All product view configs go under the `productView` object.

```javascript
productView: {
    // product view configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `enabled` | Boolean | `true` | No | Enable/disable product view toggle |
| `el` | Element | `null` | **Yes** | Element to render view toggle in |
| `template` | Function | (default) | No | Custom template. Params: `selectedViewType`, `productViewType` |
| `defaultViewType` | String | `"GRID"` | No | Default view type: `"GRID"` or `"LIST"` |
| `action` | String | `"click"` | No | Trigger action: `"click"` or `"change"` |
| `viewTypeClass` | String | `"UNX-product-view"` | No | CSS class for view type elements |
| `selectedViewTypeClass` | String | `"UNX-selected-product-view"` | No | CSS class for selected view type |
| `tagName` | String | `'div'` | No | HTML wrapper tag |
| `htmlAttributes` | Object | `{class: "product-view-container"}` | No | Wrapper attributes |

### View Actions (`data-view-action`)
- `GRID` - Switch to grid view
- `LIST` - Switch to list view

---

## Breadcrumbs Configuration

Breadcrumbs configuration is minimal and uses the `breadcrumb` object.

```javascript
breadcrumb: {
    el: document.getElementById("breadcrumpContainer")
}
```

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `el` | Element | `null` | No | Element to render breadcrumbs in |

---

## Spell Check Configuration

All spell check configs go under the `spellCheck` object.

```javascript
spellCheck: {
    // spell check configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `enabled` | Boolean | `true` | **Yes** | Enable/disable spell check |
| `el` | Element | `null` | **Yes** | Element to render spell check in |
| `template` | Function | (default) | No | Custom template. Params: `query`, `suggestion`, `pages` |
| `selectorClass` | String | `"UNX-suggestion"` | No | CSS class for spell check |
| `tagName` | String | `'DIV'` | No | HTML wrapper tag |
| `htmlAttributes` | Object | `{class: "UNX-spellcheck-wrapper"}` | No | Wrapper attributes |

### Template Parameters
- `query` - The search query
- `suggestion` - The suggested correction
- `pages` - Object with `{start, productsLn, numberOfProducts}`

### Data Actions
- `getSuggestion` - Trigger spell check suggestion

---

## Banners Configuration

All banner configs go under the `banner` object.

```javascript
banner: {
    // banner configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `enabled` | Boolean | `false` | **Yes** | Enable/disable banners |
| `el` | Element | `null` | **Yes** | Element to render banners in |
| `template` | Function | (default) | No | Custom template. Params: `banners`, `bannerOpts` |
| `openNewTab` | Boolean | `false` | No | Open banner links in new tab |
| `tagName` | String | `'div'` | No | HTML wrapper tag |
| `htmlAttributes` | Object | `{class: "UNX-banner-block"}` | No | Wrapper attributes |

### Banner Object Properties (in template)
- `imageUrl` - Banner image URL
- `landingUrl` - Click destination URL
- `bannerHtml` - Custom HTML banner content

---

## Variants Configuration

All variant configs go under the `variants` object.

```javascript
variants: {
    // variant configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `enabled` | Boolean | `false` | **Yes** | Enable/disable variants |
| `count` | Number | `5` | **Yes** | Number of variants to show per product |
| `groupBy` | String | `"v_colour"` | No | Field name to group variants by (must match catalog field) |
| `attributes` | Array | `["title", "v_imageUrl"]` | No | Fields needed for each variant |
| `mapping` | Object | `{"image_url": "v_imageUrl"}` | No | Catalog-to-variant field mapping |

---

## Swatches Configuration

All swatch configs go under the `swatches` object. **Note**: Requires `variants.count` > 1 and proper `variants.groupBy` + `variants.mapping` config.

```javascript
swatches: {
    // swatch configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `enabled` | Boolean | `false` | **Yes** | Enable/disable swatches |
| `attributesMap` | Object | `{swatchImgs: "unbxd_color_mapping", swatchColors: "color", swatchList: "color"}` | No | Field mapping for swatch attributes |
| `swatchClass` | String | `"UNX-swatch-btn"` | No | CSS class for swatches |
| `template` | Function | (default) | No | Custom template. Params: `swatchData`, `swatches`, `product`. Returns `{btnList, imgList}` |

### Swatch Template Return Value
The template function must return an object:
```javascript
{
    btnList: "<html string for swatch buttons>",
    imgList: "<html string for swatch images>"
}
```

---

## No Results Configuration

All no results configs go under the `noResults` object.

```javascript
noResults: {
    // no results configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `el` | Element | (none) | No | Element to render no results in. If not provided, renders in `searchResultsWrapper` |
| `template` | Function | `function(query) { return 'No Results found ' + query; }` | No | Custom template. Receives the search query as parameter |

---

## Loader Configuration

All loader configs go under the `loader` object.

```javascript
loader: {
    // loader configurations here
}
```

### Configuration Options

| Config | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `el` | Element | `null` | **Yes** | Element to render loader in |
| `template` | Function | `function() { return 'Loading search results....'; }` | No | Custom loader template |

---

## SEO Friendly URL Configuration

All URL configs go under the `url` object. Available from **v2.1.0+**.

```javascript
url: {
    // URL configurations here
}
```

### Top-Level URL Options

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `updateUrls` | Boolean | `true` | Enable/disable browser URL updates on user actions. Deprecated in favor of `url` configs (v2.1.0+) but still supported |
| `hashMode` | Boolean | `false` | Use `#` hash params instead of `?` query params |
| `allowExternalUrlParams` | Boolean | `false` | Retain external (non-SDK) URL params |
| `seoFriendlyUrl` | Boolean | `false` | Enable SEO-friendly URL customization. When `true`, `algo` defaults to `KEY_VALUE_REPLACER` |
| `orderOfQueryParams` | Array | `[]` | Order of params in URL (requires `seoFriendlyUrl: true`) |
| `queryParamSeparator` | String | `"&"` | Separator between query params. Allowed: `&`, `~`, `^`, `,`, `_`, `:`, `;`, `\|`, `$`, `@` |
| `keyValueSeparator` | String | `"="` | Separator between key-value pairs. Allowed: `=`, `:` |

### searchQueryParam (requires `seoFriendlyUrl: true`)

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `addToUrl` | Boolean | `true` | Append search query to URL |
| `algo` | String | `"DEFAULT"` | `"DEFAULT"` or `"KEY_VALUE_REPLACER"` |
| `keyReplacer` | String | `"q"` | Custom key name in URL |

### browseQueryParam (requires `seoFriendlyUrl: true`)

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `addToUrl` | Boolean | `true` | Append browse query to URL |
| `algo` | String | `"DEFAULT"` | `"DEFAULT"` or `"KEY_VALUE_REPLACER"` |
| `keyReplacer` | String | `"p"` | Custom key name in URL |

### pageNoParam (requires `seoFriendlyUrl: true`)

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `addToUrl` | Boolean | `true` | Append page number to URL |
| `algo` | String | `"DEFAULT"` | `"DEFAULT"` or `"KEY_VALUE_REPLACER"` |
| `keyReplacer` | String | `"start"` | Custom key name |
| `usePageNo` | Boolean | `false` | Use page numbers instead of indices |

### pageSizeParam (requires `seoFriendlyUrl: true`)

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `addToUrl` | Boolean | `true` | Append page size to URL |
| `algo` | String | `"DEFAULT"` | `"DEFAULT"` or `"KEY_VALUE_REPLACER"` |
| `keyReplacer` | String | `"rows"` | Custom key name |

### sortParam (requires `seoFriendlyUrl: true`)

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `addToUrl` | Boolean | `true` | Append sort to URL |
| `algo` | String | `"DEFAULT"` | `"DEFAULT"` or `"KEY_VALUE_REPLACER"` |
| `keyReplacer` | String | `"sort"` | Custom key name in URL |
| `valueReplacer` | Object | `{}` | Map sort values to custom URL values. E.g., `{"price desc": "p-desc"}`. On page reload, URL values are correctly mapped back to API sort values (v2.1.14+) |

### pageViewParam (requires `seoFriendlyUrl: true`)

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `addToUrl` | Boolean | `false` | Append view type to URL |
| `algo` | String | `"DEFAULT"` | `"DEFAULT"` or `"KEY_VALUE_REPLACER"` |
| `keyReplacer` | String | `"viewType"` | Custom key name |
| `valueReplacer` | Object | `{}` | Map view values. E.g., `{"GRID": "G", "LIST": "L"}` |

### facetsParam (requires `seoFriendlyUrl: true`)

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `addToUrl` | Boolean | `true` | Append selected facets to URL |
| `algo` | String | `"DEFAULT"` | `"DEFAULT"` or `"KEY_VALUE_REPLACER"` |
| `multiValueSeparator` | String | `","` | Separator for multiple facet values. Allowed: `&`, `~`, `^`, `,`, `-`, `_`, `:`, `;`, `\|`, `$`, `@`. Must differ from `queryParamSeparator` |
| `keyReplacer` | Object | `{}` | Map facet names to custom URL keys. E.g., `{"color_uFilter": "color"}` |
| `valueReplacer` | Object | `{}` | Map facet values to custom URL values. E.g., `{"color_uFilter": {"Black": "blk"}}` |
| `facetsOrderInUrl` | Array | `[]` | Order of facets in URL |
| `rangeFacets` | Array | `[]` | **Required** if range facets exist. E.g., `["price"]` |
| `rangeSeparator` | String | `"-"` | Separator for range values |

### URL Algorithm Options
- `"DEFAULT"` - Uses Unbxd's default URL format
- `"KEY_VALUE_REPLACER"` - Enables custom key/value replacements

### URL State Behavior (v2.1.14+)
When `seoFriendlyUrl` is enabled, the SDK now correctly:
- Removes the last remaining URL parameter (sort, pagination, or page size) when all search inputs and filters are cleared, instead of leaving a stale param in the browser URL.
- Restores the original API sort value from a custom `sortParam.valueReplacer` entry when the page is reloaded with a replaced sort value in the URL.

### Example: Full SEO URL Config
```javascript
url: {
    hashMode: false,
    allowExternalUrlParams: false,
    seoFriendlyUrl: true,
    orderOfQueryParams: ["QUERY", "FILTERS", "PAGE_NUMBER", "PAGE_SIZE", "SORT", "VIEW_TYPE"],
    queryParamSeparator: "&",
    searchQueryParam: {
        addToUrl: true,
        algo: "KEY_VALUE_REPLACER",
        keyReplacer: "query"
    },
    browseQueryParam: {
        addToUrl: true,
        algo: "DEFAULT"
    },
    pageNoParam: {
        addToUrl: true,
        algo: "KEY_VALUE_REPLACER",
        keyReplacer: "page",
        usePageNo: true
    },
    pageSizeParam: {
        addToUrl: true,
        algo: "KEY_VALUE_REPLACER",
        keyReplacer: "count"
    },
    sortParam: {
        addToUrl: true,
        algo: "KEY_VALUE_REPLACER",
        keyReplacer: "sortBy",
        valueReplacer: { "price desc": "p-desc", "price asc": "p-asc" }
    },
    pageViewParam: {
        addToUrl: true,
        algo: "KEY_VALUE_REPLACER",
        keyReplacer: "view"
    },
    facetsParam: {
        addToUrl: true,
        algo: "KEY_VALUE_REPLACER",
        multiValueSeparator: ",",
        keyReplacer: { "color_uFilter": "color", "size_uFilter": "size" },
        valueReplacer: { "color_uFilter": { "Black": "blk" } },
        facetsOrderInUrl: ["color_uFilter", "size_uFilter"],
        rangeFacets: ["price"],
        rangeSeparator: "-"
    }
}
```

---

## Other/Miscellaneous Configurations

These are **top-level** configurations passed directly to the `UnbxdSearch` constructor.

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `unbxdAnalytics` | Boolean | `false` | Fire analytics events from search SDK (requires Unbxd Analytics SDK integration) |
| `extraParams` | Object | `{"version": "V2"}` | Additional parameters sent in search API call. Supports static values or functions for dynamic values. **Do NOT overwrite `version: "V2"`** |
| `debugMode` | Boolean | `true` | Console log config/coding errors in real-time (v2.1.2+) |
| `defaultFilters` | Object | `{}` | Default filter condition applied to all search/category queries |
| `searchEndPoint` | String | `"https://search.unbxd.io"` | Search API endpoint domain. For staging: `"https://wingman-argocd.unbxd.io/"` |
| `browseQueryParam` | String | `"p"` | Query param for category info in search API. `"p"` for categoryPath, `"p-id"` for categoryPathId |

### extraParams Dynamic Values Example
```javascript
extraParams: {
    "version": "V2",
    "uc_param": function() {
        // Custom logic based on dynamic conditions
        return "value";
    },
    "segment": "region_id:101,Customer_type:Gold",
    "location": window.location
}
```

---

## Methods

These are the **only** methods intended for user consumption. Do NOT overwrite internal SDK methods.

### reRender()
Re-renders the page without reloading from server.
```javascript
unbxdSearch.reRender()
```

### updateConfig(config)
Updates SDK configuration at runtime without page reload.
```javascript
unbxdSearch.updateConfig({
    facet: {
        applyMultipleFilters: true
    }
})
```

### getResults(query)
Fetches search results for a given query.
```javascript
unbxdSearch.getResults("dress")
```

### getCategoryPage()
Renders the category page.
```javascript
unbxdSearch.getCategoryPage()
```

### getBrowsePage()
Renders the browse page (resets state and sets `productType` to `"BROWSE"`).
```javascript
unbxdSearch.getBrowsePage()
```

### sdkVersion
Read-only property on the SDK instance containing the loaded library version string.
```javascript
unbxdSearch.sdkVersion // e.g. "2.1.14"
```

### resetAll()
Resets all page elements (query, facets, sort, pagination) to defaults.
```javascript
unbxdSearch.resetAll()
```

### resetFacets()
Resets all selected facets.
```javascript
unbxdSearch.resetFacets()
```

### setPageStart(index)
Sets the starting page number for pagination.
```javascript
unbxdSearch.setPageStart(0)
```

### setRangeSlider(config)
Updates the range filter value.
```javascript
unbxdSearch.setRangeSlider({
    start: 0,
    end: 573,
    facetName: "price",
    gap: 200
})
```

### getCategoryId()
Returns category ID for the current category page. This is a config function.

### setCategoryId(param, self)
Sets the category path variable for category facet navigation.
- `param` - Object with `{level, parent, name, action}`
- `self` - SDK instance

### onQueryRedirect(self, redirect, urlBeforeRedirect)
Handles redirect logic when search API returns redirect info.
- `redirect` - Redirect response: `{type, value}`
- `urlBeforeRedirect` - URL before redirect

### onBackFromRedirect(hashMode)
Handles browser back from redirected URL.

### setRoutingStrategies(locationParam, newUrl, productType, isUnbxdKey, replace)
Custom implementation for browser back/forward navigation.
- `locationParam` - Current location param string
- `newUrl` - New URL string
- `productType` - `"SEARCH"` or `"CATEGORY"`
- `isUnbxdKey` - True if any SDK key is in URL
- `replace` - Whether to replace or push history state

### onEvent(instance, type, state)
Callback for SDK events. See [Events](#events) section.
```javascript
onEvent: function(instance, type, { payload }) {
    // Custom code here
}
```

### onAction(e, ctx)
Callback for facet element handlers (change, keyup, click).
```javascript
onAction: function(e, ctx) {
    console.log(e.target, ctx);
}
```

### onNoUnbxdKeyRouting()
Routing action when URL has no Unbxd key.
```javascript
onNoUnbxdKeyRouting: () => {
    history.go();
}
```

---

## Events

All events are async and caught via the `onEvent` config callback.

```javascript
onEvent: function(instance, type, state) {
    // Handle event based on type
}
```

### Event Types

| Event | Description | State/Payload |
|-------|-------------|---------------|
| `before_initialised` | Fired before SDK initialization completes | `null` |
| `initialised` | Fired after SDK initialization completes | `null` |
| `BEFORE_API_CALL` | Fired before search API call (payload/URL already calculated) | `null` |
| `AFTER_API_CALL` | Fired after successful search API call | `null` |
| `BEFORE_RENDER` | Fired before reRender execution starts | `null` |
| `AFTER_RENDER` | Fired after reRender execution completes | `null` |
| `BEFORE_NO_RESULTS_RENDER` | Fired before zero results UI render | `null` |
| `AFTER_NO_RESULTS_RENDER` | Fired after zero results UI render | `null` |
| `DELETE_FACET` | Fired on facet deletion | `{ facetName }` |
| `FACETS_CLICK` | Fired on facet value change | `{ facetName, facetData }` |
| `CLEAR_SORT` | Fired when sort is cleared | `null` |
| `CHANGE_SORT` | Fired when sort value changes | `{ sort: sortVal }` |
| `PAGE_NEXT` | Fired on next page click | `{ value: next }` |
| `PAGE_PREV` | Fired on previous page click | `{ value: prev }` |
| `CHANGE_INPUT` | Fired on searchbox keydown | `null` |
| `SET_CATEGORY_FILTER` | Fired on category facet click | `dataSet` |
| `DELETE_CATEGORY_FILTER` | Fired on category facet clear | `dataSet` |
| `PAGESIZE_CHANGE` | Fired on page size change | `{ count: val }` |
| `CONFIG_ERROR` | Configuration error occurred | `{ payload }` (error object) |
| `RUNTIME_ERROR` | Runtime error occurred | `{ payload }` (error object) |
| `FETCH_ERROR` | Error after API call | `{ payload }` |

### Example: Scroll to Product After Navigation
```javascript
onEvent: function(instance, type, state) {
    if (type === "AFTER_RENDER") {
        const productId = localStorage.getItem("unx_product_clicked");
        if (productId && document.getElementById(productId)) {
            setTimeout(function() {
                document.getElementById(productId).scrollIntoView({ behavior: "smooth" });
                localStorage.removeItem("unx_product_clicked");
            }, 500);
        }
    }
}
```

---

## Complete Sample Configuration

```javascript
window.unbxdSearch = new UnbxdSearch({
    siteKey: "your-site-key",
    apiKey: "your-api-key",
    searchBoxEl: document.getElementById("unbxdInput"),
    searchButtonEl: document.getElementById("searchBtn"),
    unbxdAnalytics: true,
    debugMode: true,
    searchEndPoint: "https://search.unbxd.io",
    browseQueryParam: "p",
    extraParams: { "version": "V2" },

    setCategoryId: function(param, self) { /* ... */ },

    products: {
        el: document.getElementById("searchResultsWrapper"),
        productType: "SEARCH",
        productItemClass: "product-item",
        attributesMap: {
            unxTitle: "title",
            unxImageUrl: "imageUrl",
            unxPrice: "salePrice",
            unxStrikePrice: "displayPrice",
            unxId: "uniqueId",
            unxDescription: "productDescription"
        },
        productAttributes: ["title", "uniqueId", "price", "imageUrl", "salePrice", "displayPrice"],
        template: function(product, idx, swatchUI, productViewType, products) {
            // Return HTML string
        },
        onProductClick: function(product, event) { /* ... */ }
    },

    facet: {
        facetsEl: document.getElementById("facetsWrapper"),
        selectedFacetsEl: document.getElementById("selectedFacetWrapper"),
        facetMultiSelect: true,
        isCollapsible: true,
        defaultOpen: "ALL",
        isSearchable: true,
        enableViewMore: true,
        viewMoreLimit: 5,
        applyMultipleFilters: false,
        facetMultilevel: true,
        facetMultilevelName: "Category",
        facetDepth: 4,
        facetTemplate: function(facetObj, children, isExpanded, facetSearchTxt, facet) { /* ... */ },
        facetItemTemplate: function(facet, value, facetSearchTxt) { /* ... */ },
        selectedFacetTemplate: function(selections, facet, selectedFacetsConfig) { /* ... */ },
        selectedFacetItemTemplate: function(selectedFacet, selectedFacetItem, facetConfig, selectedFacetsConfig) { /* ... */ },
        rangeTemplate: function(range, selectedRange, facet) { /* ... */ },
        multiLevelFacetTemplate: function(facet, selectedCategories, facetSearchTxt, facetConfig) { /* ... */ }
    },

    pagination: {
        enabled: true,
        type: "FIXED_PAGINATION",
        el: document.getElementById("paginationContainer"),
        pageLimit: 6,
        template: function(paginationData, pagination) { /* ... */ }
    },

    pagesize: {
        enabled: true,
        el: document.getElementById("pageSizeContainer"),
        pageSize: 12,
        options: [8, 12, 16, 20, 24]
    },

    sort: {
        enabled: true,
        el: document.getElementById("sortWrapper"),
        options: [
            { value: "price desc", text: "Price High to Low" },
            { value: "price asc", text: "Price Low to High" }
        ]
    },

    productView: {
        enabled: true,
        el: document.getElementById("productViewTypeContainer"),
        defaultViewType: "GRID"
    },

    breadcrumb: {
        el: document.getElementById("breadcrumbContainer")
    },

    spellCheck: {
        enabled: true,
        el: document.getElementById("didYouMeanWrapper")
    },

    banner: {
        enabled: true,
        el: document.getElementById("bannerContainer"),
        openNewTab: false
    },

    noResults: {
        el: document.getElementById("noResultWrapper")
    },

    loader: {
        el: document.getElementById("loaderEl")
    },

    variants: {
        enabled: false,
        count: 5,
        groupBy: "v_colour",
        attributes: ["title", "v_imageUrl"],
        mapping: { "image_url": "v_imageUrl" }
    },

    swatches: {
        enabled: false,
        attributesMap: {
            swatchImgs: "unbxd_color_mapping",
            swatchColors: "color",
            swatchList: "color"
        }
    },

    url: {
        hashMode: false,
        allowExternalUrlParams: false,
        seoFriendlyUrl: false
    },

    onEvent: function(instance, type, state) { /* ... */ },
    onAction: function(e, ctx) { /* ... */ }
});
```

---

## Version History (Notable Releases)

| Version | Date | Key Changes |
|---------|------|-------------|
| v2.1.14 | Feb 2026 | Fixed SEO URL param cleanup on clear; fixed sort `keyReplacer`/`valueReplacer` round-trip on reload (Core SDK v0.5.13) |
| v2.1.13 | Nov 2025 | Fixed incorrect URL split and append |
| v2.1.12 | Oct 2025 | Pagination `preloaderClass`/`postloaderClass`, enhanced `selectedFacetsTemplate` |
| v2.1.10 | Oct 2024 | Fixed `seoFriendlyUrl` state retention, fixed double-quote facet values |
| v2.1.9 | Jun 2024 | Fixed infinite scroll API loops, removed virtualization |
| v2.1.7 | May 2024 | Fixed `keyValueSeparator`, added `sdkVersion` prototype, fixed back button with infinite scroll |
| v2.1.5 | Mar 2024 | Added `firstPage`/`lastPage` pagination actions, moved `actionBtnClass`/`actionChangeClass` to facet config |
| v2.1.4 | Dec 2023 | New `before_initialised` event |
| v2.1.3 | Dec 2023 | `browseQueryParam` customization (`p` or `p-id`) |
| v2.1.2 | Dec 2023 | Debug Mode, Product Virtualization, `bufferPages` |
| v2.1.1 | Oct 2023 | Dynamic `extraParams` with function values |
| v2.1.0 | Aug 2023 | **SEO Friendly URLs** - major URL customization feature |
| v2.0.40 | Aug 2023 | SEO friendly category URLs, `seoFriendlyUrl` flag |
| v2.0.38 | Jun 2023 | `usePageCount` for page/count URL variables |
| v2.0.34 | Apr 2023 | `unbxd-user-id` and `unbxd-device-type` request headers |
| v2.0.30 | Mar 2023 | Breadcrumbs for category pages |
