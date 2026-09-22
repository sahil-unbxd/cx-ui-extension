# Common Issues — Known Patterns

> **Living document.** This file is automatically updated after every resolved ticket (Step 9 of the ticket-resolver workflow).
> Check this FIRST when triaging a new ticket — if the symptoms match, you can skip most of the investigation and jump to the fix.
>
> **Structure:** Patterns are grouped by category. Each entry has symptoms, root cause, fix, and a real-case reference.
> **Maintenance:** After resolving a ticket, either update an existing entry or add a new one. See the template at the bottom.

---

## URL / Navigation

### Back button infinite loop (FIXED_PAGINATION + addToUrl)

**Symptoms:** Browser back button doesn't work on PLPs/category pages. User gets stuck in a loop. URL shows appended params like `?rows=100&page=1` immediately after page load.

**Root cause:** When `pagination.type` is `FIXED_PAGINATION` and `pageSizeParam.addToUrl: true` / `pageNoParam.addToUrl: true`, the SDK appends params like `?rows=100&page=1` on initial load via `history.pushState()`. This creates a duplicate history entry. Pressing Back navigates to the original URL, which re-triggers the SDK to push the params again.

**Mechanism:** In the core SDK, `setRoutingStrategies` uses `replaceState` only for `INFINITE_SCROLL` / `CLICK_N_SCROLL` when the page param changes. For `FIXED_PAGINATION`, it always uses `pushState`.

**Fix options:**
1. **Config change** (recommended) — Set `pageSizeParam.addToUrl: false` and optionally `pageNoParam.addToUrl: false`. Removes the params from the URL entirely. No functional impact.
2. **Override `setRoutingStrategies`** — Override the method in the customer config to use `replaceState` when `!isUnbxdKey` or `replace` is true. Keeps params in URL but avoids the duplicate history entry.

**SDK version(s) affected:** All versions through v2.1.7 (core SDK behavior).

**Platform(s):** All (observed on Magento).

**Reference:** `search-JS-library/docs/Methods.md` → `setRoutingStrategies` section.

**Real case:** CSLIVE-6508 (Hudson's Furniture, Magento, SDK v2.1.7)

---

### URL params lost on navigation (allowExternalUrlParams)

**Symptoms:** Customer's own URL parameters (UTM tags, tracking params, custom filters) disappear after SDK initializes.

**Root cause:** `url.allowExternalUrlParams` is `false` (default). The SDK strips all non-SDK params when it rewrites the URL.

**Fix:** Set `url.allowExternalUrlParams: true`.

---

### Hash vs query param mismatch

**Symptoms:** SDK writes `?` params but the site expects `#` hash params, or vice versa.

**Root cause:** `url.hashMode` doesn't match the site's routing strategy.

**Fix:** Set `url.hashMode: true` for hash-based SPAs, `false` for standard sites.

---

### URL filter params dropped on category page load (getCategoryPage double-fire)

**Symptoms:** Filters passed via URL parameters (e.g., `filter=brand_uFilter:"Alphamega"`) are not retained after page load on category/PLP pages. The URL initially contains the filter, but after the SDK initializes, the `filter=` param is stripped from the URL, no facets appear as selected in the UI, and the page displays unfiltered category results instead of the filtered subset.

**Root cause:** The SDK constructor's `bindEvents` calls `renderFromUrl()` when URL params exist — this correctly parses the `filter` param and sets `state.selectedFacets`. However, the customer's inline init script calls `getCategoryPage()` immediately after constructing the SDK:

```javascript
setUnbxdSearch();
if (isBrowse)
    window.unbxdSearch.getCategoryPage();
```

`getCategoryPage()` fires a fresh category browse API call that does not carry the filter state set by `renderFromUrl()`. The second API response overwrites the first, and `setUrl()` rewrites the browser URL based on the new (filterless) state, dropping the `filter=` param entirely.

**Key indicators:**
- `facetsParam.algo` is `"DEFAULT"` (uses `filter=` param format)
- `seoFriendlyUrl: false` (SDK uses legacy `DEFAULT` algo for facets)
- `getCategoryPage()` is called explicitly after SDK construction
- `getQueryParams()` correctly parses the filter from the original URL, but the state is overwritten before the response arrives

**Fix options:**
1. **Guard `getCategoryPage()` with a URL state check** (recommended) — Only call `getCategoryPage()` when the URL has no pre-applied filters:
   ```javascript
   setUnbxdSearch();
   if (isBrowse) {
       const qp = window.unbxdSearch.getQueryParams();
       if (!qp || !qp.filter) {
           window.unbxdSearch.getCategoryPage();
       }
   }
   ```
   `renderFromUrl()` (already called inside the constructor) handles the case when filters exist in the URL.

2. **Broader guard checking any SDK-managed params** — If the URL might also carry sort or non-zero pagination:
   ```javascript
   setUnbxdSearch();
   if (isBrowse) {
       const urlParams = new URLSearchParams(window.location.search);
       const hasUrlState = urlParams.has('filter') || urlParams.has('sort') || Number(urlParams.get('start')) > 0;
       if (!hasUrlState) {
           window.unbxdSearch.getCategoryPage();
       }
   }
   ```

**SDK version(s) affected:** All versions (core `bindEvents` + `renderFromUrl` behavior). The issue is in the customer init code, not the SDK itself.

**Platform(s):** Dynamicweb / Custom (server-rendered category path in inline script). Same pattern can occur on any platform where `getCategoryPage()` is manually called after SDK construction.

**Real case:** Alphamega (alphamega.com.cy, Dynamicweb CMS, SDK v2 via `unbxdSearch_v2.js`)

---

## Products / Rendering

### "el is not a valid DOM selector" for multiple modules

**Symptoms:** Console errors like `products.el is not a valid DOM selector`, `facet.facetsEl is not a valid DOM selector`. Multiple SDK modules fail.

**Root cause:** Almost always a timing issue — the SDK script runs before the page DOM has rendered. Common on React/SPA sites, or when the SDK script is loaded in `<head>` without `defer`.

**Fix options:**
1. Move the SDK `<script>` tag to before `</body>` or add `defer`.
2. For SPA sites, use the retry/poll initialization pattern (see `shared/initialization.md` → Pattern G).
3. Verify selectors exist on the page using `browser_evaluate`.

---

### Products not rendering (empty grid)

**Symptoms:** Product grid container exists but no products appear. No console errors.

**Root cause possibilities:**
- `productAttributes` array is missing fields that the `template` function references.
- `attributesMap` maps to wrong field names (doesn't match catalog).
- API returns products but the template function has a JS error (check console).
- `products.el` selector points to the wrong container.

**Diagnosis:** Use `browser_evaluate` to call `window.unbxdSearch.getResponseObj()` and check if products exist in the API response.

---

### Wrong images / broken image URLs

**Symptoms:** Product images show as broken or show the default placeholder.

**Root cause:** The `imageUrl` field name in `attributesMap` doesn't match the actual catalog field, or the field returns an array but the template expects a string.

**Fix:** Check the API response for the actual image field name and structure. Update `attributesMap` accordingly. If the field is an array, use `product.imageUrl[0]` or `product.imageUrl` in the template.

---

## Facets / Filters

### Range facet slider not appearing

**Symptoms:** Price or other range facets show as text facets instead of sliders.

**Root cause:** The facet field name is missing from `url.facetsParam.rangeFacets` array. Without this, the SDK treats it as a text facet.

**Fix:** Add the field name to `rangeFacets: ["price"]` (or whatever the range field is called).

**Also check:** noUiSlider library must be included in `config.json` libraries.

---

### Facets not collapsible / all open

**Symptoms:** All facets are expanded and can't be collapsed.

**Root cause:** `facet.isCollapsible` is `false` or not set.

**Fix:** Set `facet.isCollapsible: true` and `facet.defaultOpen: "ALL"` (or `"FIRST"` or `"NONE"`).

---

### Selected facets not clearing

**Symptoms:** Clicking "Clear All" or individual facet remove buttons does nothing.

**Root cause:** The `data-facet-action` or `data-facet-name` attributes are missing or incorrect in the `selectedFacetItemTemplate`.

**Fix:** Check the template against `components/facets.md` for required data attributes.

---

## Pagination

### Wrong page count / too many pages

**Symptoms:** Pagination shows incorrect number of pages, or shows hundreds of pages.

**Root cause:** Mismatch between `pagesize.pageSize` in config and what the API returns. Or `pageNoParam.usePageNo` is wrong — using start indices instead of page numbers.

**Fix:** Verify `pageSize` matches the `rows` parameter sent to the API. Check `usePageNo` setting.

---

### Infinite scroll not triggering

**Symptoms:** User scrolls to bottom but no new products load.

**Root cause possibilities:**
- `pagination.infiniteScrollTriggerEl` is set to `window` but the scrollable container is a different element.
- `pagination.heightDiffToTriggerNextPage` is too small or too large.
- The products container has `overflow: hidden` cutting off the scroll detection.

---

## Category / Browse Pages

### Category page shows search results instead of category products

**Symptoms:** Category page loads but shows generic search results or "no results."

**Root cause:** `products.productType` is set to `"SEARCH"` instead of `"CATEGORY"`, or `setCategoryId` function is not correctly extracting the category path.

**Fix:** Verify `productType` is `"CATEGORY"` on category pages. Check `setCategoryId` function logic and `browseQueryParam` config.

---

### Category page not initializing

**Symptoms:** SDK doesn't fire on category pages at all.

**Root cause:** Page type detection logic doesn't recognize the page as a category page. Common on Magento (body class check) or Shopify (template check).

**Fix:** Check the initialization condition. For Magento, look for `body.catalog-category-view`. For Shopify, look for `body` classes containing `template-collection`.

---

## Performance

### Multiple API calls on page load

**Symptoms:** Network tab shows 2-3 Unbxd API calls on initial load instead of 1.

**Root cause:** SDK initializes multiple times (script loaded twice), or `getResults()`/`getCategoryPage()` is called manually in addition to the automatic call.

**Fix:** Check for duplicate script tags. Check if `onEvent` or custom code calls `getResults()` unnecessarily. For category pages, guard `getCategoryPage()` with a URL state check — if URL params exist, `renderFromUrl()` (called inside the constructor) already handles the request:

```javascript
const qp = unbxdSearch.getQueryParams();
const hasUrlState = qp && Object.keys(qp).length > 0;
if (!hasUrlState && !unbxdSearch.state.isLoading) {
    unbxdSearch.getCategoryPage();
}
```

**Real case:** CSLIVE-6543 (Unique Vintage, Shopify, SDK v2.1.10)

---

### Mobile Safari crash / page freeze with image carousels

**Symptoms:** Mobile iOS Safari tab crashes or freezes on collection/category pages. Page becomes unresponsive. Especially severe with higher page sizes (24-48 products). Customer reports "site crashing on mobile."

**Root cause:** Compounding image loading issues that exceed iOS Safari's per-tab memory limit (~120-200 MB):

1. **All carousel images load eagerly** — When the product template generates `<img>` tags with both `srcset` and `data-srcset` set to the same value, AND uses lazysizes classes (`lazyload`/`lazyautosizes`), the Shopify theme's lazysizes library processes the images and changes `loading="lazy"` to `loading="eager"`. This causes ALL images (including hidden carousel slides) to download and decode immediately.

2. **Too many carousel slides per product** — Each product card renders 4-5 image slides, but only 1 is visible. With 48 products × 4.5 slides = ~214 images, of which 165 are hidden but still eagerly loaded.

3. **Oversized srcset widths** — The Shopify theme may add srcset entries up to 3840px. On mobile with `sizes: 100vw`, the browser selects unnecessarily large images.

4. **Massive DOM** — 48 product cards with full slideshow components (arrows, containers, slides) creates 11,000+ DOM nodes.

**Key diagnostic checks:**
```javascript
// Check if all images are loading eagerly (should see lazy ones)
() => {
  const imgs = document.querySelectorAll('.unx-products img');
  const eager = [...imgs].filter(i => i.getAttribute('loading') !== 'lazy').length;
  const total = imgs.length;
  const hiddenSlideImgs = document.querySelectorAll('slideshow-slide[aria-hidden="true"] img');
  let ram = 0;
  imgs.forEach(i => { if (i.complete && i.naturalWidth > 0) ram += i.naturalWidth * i.naturalHeight * 4; });
  return { total, eager, hiddenLoaded: hiddenSlideImgs.length, estimatedRAM_MB: (ram/1024/1024).toFixed(1) };
}
```

**Fix options:**
1. **Fix `createImage` function** — For the first (visible) image: use `srcset` directly with `loading="eager"`. For subsequent carousel images: use `srcset` (NOT `data-srcset`) with `loading="lazy"`. Remove lazysizes classes (`lazyload`, `lazyautosizes`, `lazyloaded`) and `data-sizes="auto"` to prevent the theme's lazysizes from overriding the loading behavior. **CRITICAL: Never use `data-srcset` with native `loading="lazy"` — see the "Blurry images" pattern below.**
2. **Limit carousel slides** — On mobile, render only the first image (no carousel). On desktop, cap at 2-3 slides instead of all images.
3. **Optimize srcset widths** — Mobile: `[240, 352]`. Desktop: `[240, 352, 832]`. Remove 1200px+ widths that are never needed for grid card thumbnails.
4. **Fix `sizes` attribute** — Use `50vw` on mobile (2-column grid), not `100vw`. This prevents the browser from selecting oversized srcset entries.

**SDK version(s) affected:** All versions (issue is in the customer template code, not the SDK core).

**Platform(s):** Shopify (themes using Web Components for slideshow + lazysizes library).

**Real case:** CSLIVE-6543 (Unique Vintage, Shopify, SDK v2.1.10) — 48 products × 4.5 slides = 213 images, 148 MB estimated RAM, all loading eagerly.

---

### Blurry / low-resolution images on scroll (data-srcset with native lazy loading)

**Symptoms:** Product images appear blurry or pixelated as the user scrolls down the page. Images above the fold look fine, but all lazy-loaded images below the fold render at very low resolution (e.g., 240px wide). Customer reports "images become blurry when scrolling." May look acceptable on mobile but very obviously blurry on desktop.

**Root cause:** The `createImage` function (or product template) uses `data-srcset` instead of `srcset` on lazy-loaded images. `data-srcset` is a **non-standard** HTML attribute — the browser completely ignores it. It was designed for **JavaScript-based lazy loaders** (lazysizes, lozad, vanilla-lazyload) that swap `data-srcset` → `srcset` via JS when the element enters the viewport.

When using **native `loading="lazy"`**, the browser handles lazy loading internally. It reads standard `srcset` and `sizes` attributes to select the best image source. Since `data-srcset` is invisible to the browser, it falls back to the `src` attribute — which is typically set to the smallest/cheapest resolution (e.g., `?width=240`) as a placeholder. The result: every lazy-loaded image displays at 240px regardless of viewport or device pixel ratio.

**Key diagnostic check:**
```javascript
() => {
  const imgs = document.querySelectorAll('.unx-products img[loading="lazy"]');
  const usingDataSrcset = [...imgs].filter(i => 
    i.hasAttribute('data-srcset') && !i.hasAttribute('srcset')
  ).length;
  const usingSrcset = [...imgs].filter(i => i.hasAttribute('srcset')).length;
  return { 
    totalLazy: imgs.length, 
    brokenDataSrcset: usingDataSrcset, 
    correctSrcset: usingSrcset,
    verdict: usingDataSrcset > 0 ? 'BUG: data-srcset without srcset = blurry images' : 'OK'
  };
}
```

**The rule:**
| Lazy loading method | Use `srcset` | Use `data-srcset` |
|---------------------|-------------|-------------------|
| Native `loading="lazy"` | YES — browser reads it | NO — browser ignores it, images load at `src` fallback resolution |
| JS-based (lazysizes, lozad) | NO — would cause eager load | YES — JS swaps to `srcset` on scroll |

**Fix:**
Change `data-srcset` to `srcset` on all images that use `loading="lazy"`. Keep `loading="lazy"` and `fetchpriority="low"` for below-the-fold images. The browser will defer downloading AND pick the correct high-res source from `srcset` when it does load.

```javascript
// WRONG — blurry images
return `<img src="${fallbackSrc}" data-srcset="${srcSet}" loading="lazy" sizes="${sizes}" />`;

// CORRECT — full quality, still lazy-loaded
return `<img src="${fallbackSrc}" srcset="${srcSet}" loading="lazy" sizes="${sizes}" />`;
```

**Above-fold images** should use `loading="eager"` + `fetchpriority="high"` + `srcset` (never `data-srcset`).

**When you WOULD use `data-srcset`:** Only if the site uses a JavaScript-based lazy loader (lazysizes, lozad, vanilla-lazyload) that explicitly swaps `data-srcset` → `srcset`. In that case, DO NOT also set `loading="lazy"` — let the JS library handle it entirely. Mixing both approaches causes conflicts.

**SDK version(s) affected:** All versions (issue is in customer template code, not SDK core).

**Platform(s):** All — any integration using `createImage` or similar helper that generates `<img>` tags with responsive srcset.

**Real case:** Unique Vintage (Shopify, SDK v2.1.10) — Customer reported "images become blurry as you scroll down the page." All lazy images were using `data-srcset` + `loading="lazy"` + `src="?width=240"`. Fix: changed `data-srcset` to `srcset`.

---

### Blurry images on mobile Retina devices (insufficient srcset widths)

**Symptoms:** Images look fine on desktop but appear blurry/soft on mobile phones — especially on iPhones (2x/3x Retina). The customer reports "image quality is completely messed up on mobile" even though `srcset` is correctly used (not `data-srcset`). The issue may not be visible in Playwright because Playwright defaults to `devicePixelRatio: 1`.

**Root cause:** The `productImageSizes` array for mobile doesn't contain entries large enough to satisfy high-DPR (device pixel ratio) screens. The browser selects srcset entries based on `sizes` attribute * devicePixelRatio:

| `sizes` attr | Viewport | DPR | Needed image width | Minimum srcset entry |
|---|---|---|---|---|
| `50vw` | 375px | 1x | 188px | 240w (OK) |
| `50vw` | 375px | 2x | 375px | 375w (often missing) |
| `50vw` | 375px | 3x | 563px | 540w or 720w (often missing) |
| `50vw` | 414px (iPhone Plus) | 3x | 621px | 720w (often missing) |

If `productImageSizes` is `[240, 352]` for mobile, the browser can only serve 352px max — which is blurry at 2x (need 375px) and very blurry at 3x (need 563px).

**Key diagnostic — must run on BOTH desktop and mobile viewports:**
```javascript
() => {
  const img = document.querySelector('.unx-products img');
  if (!img) return 'No Unbxd images found';
  const srcsetWidths = (img.getAttribute('srcset') || '').split(',').map(s => parseInt(s.trim().split(' ').pop()));
  const maxSrcset = Math.max(...srcsetWidths);
  const sizesVal = img.getAttribute('sizes') || '';
  const displayWidth = img.offsetWidth;
  const needed2x = displayWidth * 2;
  const needed3x = displayWidth * 3;
  return {
    viewport: window.innerWidth,
    dpr: window.devicePixelRatio,
    srcsetWidths,
    maxSrcsetWidth: maxSrcset,
    displayWidth,
    needed_2x: needed2x,
    needed_3x: needed3x,
    covers_2x: maxSrcset >= needed2x,
    covers_3x: maxSrcset >= needed3x,
    verdict: maxSrcset < needed2x ? 'BLURRY on 2x devices' : maxSrcset < needed3x ? 'BLURRY on 3x devices' : 'OK'
  };
}
```

**Fix:** Ensure `productImageSizes` includes entries large enough for 3x DPR:

```javascript
// WRONG — blurry on Retina mobile
const productImageSizes = isMobileContainer ? [240, 352] : [240, 352, 832];

// CORRECT — sharp on all devices
const productImageSizes = isMobileContainer ? [240, 375, 540, 720] : [240, 352, 540, 832];
```

**The formula:** max srcset width >= ceil(display_width * 3). For a 2-column mobile grid at 375px viewport (`50vw` = 188px), you need at least `188 * 3 = 564px`, so 540w + 720w covers both 2x and 3x.

**IMPORTANT:** Playwright runs with `devicePixelRatio: 1` by default, so blurry-on-Retina bugs are **invisible** in automated testing. Always manually calculate whether the srcset widths cover 2x and 3x DPR for the given `sizes` attribute and viewport.

**SDK version(s) affected:** All versions (issue is in customer template code).

**Platform(s):** All — any integration with responsive `srcset` images.

**Real case:** Unique Vintage (Shopify, SDK v2.1.10) — Mobile `productImageSizes` was `[240, 352]` with `sizes="50vw"`. On iPhone (2x/3x DPR), browser could only serve 352px for a slot needing 375–563px. Fix: changed to `[240, 375, 540, 720]`.

---

## Analytics

### Analytics events not firing

**Symptoms:** Unbxd dashboard shows no search/click/cart events.

**Root cause possibilities:**
- `unbxdAnalytics: false` in config.
- UA library (`uaLibrary.js`) not loaded.
- `UnbxdAnalyticsConf` not set (required for the UA library to know the page type).
- `onProductClick` not calling `localStorage.setItem("unx_product_clicked", product.uniqueId)`.

---

## False Positives / Not SDK Issues

> Issues that looked like Unbxd SDK bugs but turned out to be caused by something else.
> Documenting these saves investigation time on future tickets with similar symptoms.

_(No entries yet — add here when a ticket turns out to not be an SDK issue.)_

---

## Adding New Patterns

**When:** After every resolved ticket (Step 9 of the workflow). This is mandatory, not optional.

**Where:** Add under the matching category section above. If no category fits, create a new `##` section.

**Template:**

```markdown
### [Short descriptive title]

**Symptoms:** [What the customer reports or what you observe on the live site]

**Root cause:** [Technical explanation — SDK component, config property, mechanism]

**Fix options:**
1. [Primary fix — usually config change]
2. [Alternative fix if applicable]

**SDK version(s) affected:** [e.g., v2.1.7, all versions, fixed in v2.2.0]

**Platform(s):** [Magento / Shopify / BigCommerce / All]

**Real case:** [Jira key] ([Customer name], [platform], SDK [version])
```

**For false positives:**

```markdown
### [What it looked like]

**Symptoms:** [What was reported]

**Actual cause:** [What was really happening — third-party script, customer code, platform bug, etc.]

**How to identify:** [Quick check to rule out SDK involvement]

**Real case:** [Jira key]
```
