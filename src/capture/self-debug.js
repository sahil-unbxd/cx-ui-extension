/**
 * The extension's self-debug procedure: the checks a CX engineer would
 * otherwise run by hand in DevTools, executed automatically and turned into
 * pass/fail verdicts.
 *
 * The point is that the extension reaches a diagnosis itself rather than
 * shipping raw data and hoping the model spots the same thing. Each check is
 * ordered so that the FIRST failure is the most upstream cause — everything
 * after it is likely a downstream symptom. `summary.firstFailure` is what the
 * prompt is told to lead with.
 *
 * Checks run against the live SDK instance wherever possible. The SDK exposes
 * the resolvers we need as methods (`getSearchQueryParam`, `getBrowseQueryParam`,
 * `getProductType`, `getCategoryId`), so the query param name is *read*, never
 * assumed to be "q" — customers rename it via `url.searchQueryParam.keyReplacer`
 * to `searchTerm`, `keyword`, `query` and so on.
 */

const PASS = 'pass';
const FAIL = 'fail';
const WARN = 'warn';
const SKIP = 'skip';

/** Reads what only the running SDK can tell us. */
export async function readSdkDebugState(session) {
  const fn = () => {
    const instances =
      window.unbxdSearchInstances && typeof window.unbxdSearchInstances === 'object'
        ? Object.keys(window.unbxdSearchInstances)
        : [];
    const inst =
      (window.unbxdSearch && window.unbxdSearch.options && window.unbxdSearch) ||
      (instances.length && window.unbxdSearchInstances[instances[0]]) ||
      null;

    const call = (name) => {
      try {
        return inst && typeof inst[name] === 'function' ? inst[name]() : null;
      } catch (e) {
        return { __error: String((e && e.message) || e).slice(0, 140) };
      }
    };

    const conf = window.UnbxdAnalyticsConf || null;
    const urlParams = {};
    try {
      for (const [k, v] of new URLSearchParams(location.search)) urlParams[k] = String(v).slice(0, 200);
    } catch {
      /* ignore */
    }

    let searchBoxValue = null;
    try {
      const el = inst && inst.options && inst.options.searchBoxEl;
      const node = typeof el === 'string' ? document.querySelector(el) : el;
      if (node && 'value' in node) searchBoxValue = String(node.value).slice(0, 200);
    } catch {
      /* ignore */
    }

    return {
      instanceFound: Boolean(inst && inst.options),
      // Resolved by the SDK itself — never assume "q"/"p".
      searchQueryParamName: call('getSearchQueryParam'),
      browseQueryParamName: call('getBrowseQueryParam'),
      productType: call('getProductType'),
      categoryId: call('getCategoryId'),
      sdkQueryParams: call('getQueryParams'),
      userInput: inst && inst.state ? inst.state.userInput || null : null,
      searchBoxValue,
      analyticsConf: conf
        ? {
            present: true,
            page: typeof conf.page === 'string' ? conf.page.slice(0, 300) : conf.page || null,
            page_type: conf.page_type || null
          }
        : { present: false },
      pageUrlParams: urlParams,
      pathname: location.pathname.slice(0, 200)
    };
  };

  return (await session.evaluate(`(${fn.toString()})()`)) || { instanceFound: false, unavailable: true };
}

/* ------------------------------------------------------------------ */

export async function runSelfDebug(session, input) {
  const {
    sdkAssets,
    siteConfig,
    searchRequest,
    responseSummary,
    renderedPage,
    apiCallCounts,
    reloaded
  } = input;

  const sdk = await readSdkDebugState(session);
  const checks = [];
  const add = (id, title, status, detail, evidence) => checks.push({ id, title, status, detail, evidence });

  /* 1 — capture covered a full page load -------------------------------- */
  add(
    'fresh_page_load',
    'Capture covered a full page load',
    reloaded ? PASS : WARN,
    reloaded
      ? 'The page was reloaded at the start of the capture, so asset and first-API-call evidence is complete.'
      : 'The page was not reloaded during capture. Assets and the initial API call may have happened before recording started — absent evidence here is not proof of absence.',
    { reloaded: Boolean(reloaded) }
  );

  /* 2 — SDK bundles loaded ---------------------------------------------- */
  const assetVerdict = sdkAssets ? sdkAssets.verdict : 'not_observed';
  add(
    'sdk_assets_loaded',
    'search.js / autosuggest.js / CSS loaded',
    assetVerdict === 'loaded' ? PASS : assetVerdict === 'not_observed' ? WARN : FAIL,
    assetVerdict === 'loaded'
      ? 'All observed Unbxd bundles returned a success status.'
      : (sdkAssets && sdkAssets.note) || 'No Unbxd SDK assets were observed.',
    { verdict: assetVerdict, detected: sdkAssets ? Object.keys(sdkAssets.detected || {}) : [] }
  );

  /* 3 — SDK actually initialised ---------------------------------------- */
  const live = (siteConfig && siteConfig.liveConfig) || {};
  add(
    'sdk_initialised',
    'SDK instance exists on the page',
    sdk.instanceFound || live.instanceFound ? PASS : FAIL,
    sdk.instanceFound || live.instanceFound
      ? `Instance found (${(live.instanceKeys || []).join(', ') || 'window.unbxdSearch'}).`
      : live.reason || 'No initialised UnbxdSearch instance — the page-type detection condition likely never matched.',
    { instanceKeys: live.instanceKeys || [], bodyClasses: renderedPage ? renderedPage.bodyClasses : null }
  );

  /* 4 — page type matches the endpoint that fired ------------------------ */
  const productType = sdk.productType || (live.options && live.options.productType) || null;
  const apiType = searchRequest ? searchRequest.apiType : null;
  const expectedApi = productType === 'SEARCH' ? 'search' : productType ? 'category' : null;
  add(
    'page_type_matches_endpoint',
    'productType matches the endpoint called',
    !productType || !apiType ? SKIP : expectedApi === apiType ? PASS : FAIL,
    !productType || !apiType
      ? 'No productType or no captured API call to compare.'
      : expectedApi === apiType
        ? `productType ${productType} correctly drove the /${apiType} endpoint.`
        : `productType is ${productType} but the page called /${apiType}. A category page running as SEARCH is why a PLP shows search results.`,
    { productType, apiType, expectedApi }
  );

  /* 5 — the query actually sent to the API ------------------------------ */
  checks.push(queryCheck(sdk, searchRequest, productType));

  /* 6 — browse/category target ------------------------------------------ */
  checks.push(browseCheck(sdk, searchRequest, productType));

  /* 7 — attribute mapping vs what the catalogue returned ----------------- */
  checks.push(attributeMappingCheck(live, searchRequest, responseSummary));

  /* 8 — config selectors resolve ---------------------------------------- */
  const broken = (live.selectorChecks || []).filter((s) => s.matchCount === 0 || s.matchCount === -2);
  add(
    'config_selectors_resolve',
    'Config element selectors match the DOM',
    (live.selectorChecks || []).length === 0 ? SKIP : broken.length === 0 ? PASS : FAIL,
    broken.length
      ? `${broken.length} config selector(s) match nothing on this page: ${broken.map((b) => `${b.configPath} → "${b.selector}"`).join('; ')}.`
      : 'Every config element selector resolves.',
    { broken }
  );

  /* 9 — API result count vs what the DOM shows -------------------------- */
  checks.push(apiVsDomCheck(responseSummary, renderedPage));

  /* 10 — one API call per page load ------------------------------------- */
  const totalCalls = apiCallCounts ? (apiCallCounts.search || 0) + (apiCallCounts.category || 0) : 0;
  add(
    'single_api_call',
    'One search/category call per page load',
    !totalCalls ? SKIP : totalCalls === 1 ? PASS : WARN,
    totalCalls > 1
      ? `${totalCalls} search/category calls fired. Double initialisation, a duplicate script tag, or a manual getResults()/getCategoryPage() on top of the automatic one. On a PLP the second, unfiltered call can overwrite URL filters.`
      : 'Single call, as expected.',
    { apiCallCounts, duplicateAssetKinds: siteConfig && siteConfig.assetUrls ? siteConfig.assetUrls.duplicateKinds : [] }
  );

  /* 11 — site key agreement --------------------------------------------- */
  const cons = (siteConfig && siteConfig.consistency) || {};
  add(
    'site_key_consistent',
    'Site key agrees across bundle, config and request',
    cons.allMatch === null || cons.allMatch === undefined ? SKIP : cons.allMatch ? PASS : FAIL,
    cons.allMatch === false ? cons.hint : 'Bundle, running config and API request use the same site key.',
    { bundleSiteKey: cons.bundleSiteKey, liveSiteKey: cons.liveSiteKey, requestSiteKey: cons.requestSiteKey }
  );

  const failures = checks.filter((c) => c.status === FAIL);
  const warnings = checks.filter((c) => c.status === WARN);

  return {
    sdkState: sdk,
    checks,
    summary: {
      failed: failures.length,
      warned: warnings.length,
      passed: checks.filter((c) => c.status === PASS).length,
      skipped: checks.filter((c) => c.status === SKIP).length,
      // Checks are ordered upstream-first, so the first failure is the most
      // likely root cause and everything after it may be a consequence.
      firstFailure: failures.length ? { id: failures[0].id, title: failures[0].title, detail: failures[0].detail } : null,
      allFailedIds: failures.map((c) => c.id)
    }
  };
}

/* ------------------------------------------------------------------ */
/* Individual checks                                                    */
/* ------------------------------------------------------------------ */

/**
 * Did the API receive the query the shopper actually typed?
 *
 * Two different param names are in play and conflating them is the classic
 * mistake: the PAGE URL uses the configurable name (`url.searchQueryParam.
 * keyReplacer` — "q" by default, often "searchTerm"/"keyword"/"query"), while
 * the Unbxd API endpoint itself always takes `q`.
 */
function queryCheck(sdk, searchRequest, productType) {
  const base = { id: 'search_query_reaches_api', title: 'The typed query reached the API as q=' };
  if (productType && productType !== 'SEARCH') {
    return { ...base, status: SKIP, detail: 'Not a search page.', evidence: { productType } };
  }
  if (!searchRequest) {
    return { ...base, status: SKIP, detail: 'No search request captured.', evidence: {} };
  }

  const paramName = typeof sdk.searchQueryParamName === 'string' ? sdk.searchQueryParamName : 'q';
  const urlValue = sdk.pageUrlParams ? sdk.pageUrlParams[paramName] : undefined;
  const apiValue = searchRequest.params ? searchRequest.params.q : undefined;
  const typed = sdk.userInput || sdk.searchBoxValue || null;

  const evidence = {
    pageUrlParamName: paramName,
    resolvedFrom: typeof sdk.searchQueryParamName === 'string' ? 'sdk.getSearchQueryParam()' : 'default "q" (SDK method unavailable)',
    pageUrlValue: urlValue ?? null,
    apiQValue: apiValue ?? null,
    searchBoxOrState: typed
  };

  if (apiValue === undefined) {
    return { ...base, status: FAIL, detail: 'The search call carried no q parameter at all.', evidence };
  }
  const expected = urlValue ?? typed;
  if (!expected) {
    return {
      ...base,
      status: WARN,
      detail: `API sent q="${apiValue}" but there is nothing to compare it against (no "${paramName}" in the page URL and no search box value).`,
      evidence
    };
  }
  if (apiValue === expected) {
    return { ...base, status: PASS, detail: `Page URL "${paramName}=${expected}" reached the API as q=${apiValue}.`, evidence };
  }
  if (apiValue === '*' && expected) {
    return {
      ...base,
      status: FAIL,
      detail: `The page asked for "${expected}" (URL param "${paramName}") but the API was called with q=* — the match-all query. The query never reached the SDK: check that the configured searchQueryParam ("${paramName}") is the param the site actually puts the term in.`,
      evidence
    };
  }
  return {
    ...base,
    status: FAIL,
    detail: `Query mismatch: page has "${paramName}=${expected}" but the API was called with q="${apiValue}".`,
    evidence
  };
}

/**
 * For browse/category pages the target category comes from
 * `window.UnbxdAnalyticsConf.page` (the default `getCategoryId()` reads exactly
 * that), and it must be what the `p=` parameter carries.
 */
function browseCheck(sdk, searchRequest, productType) {
  const base = { id: 'browse_target_matches_analytics_conf', title: 'p= matches window.UnbxdAnalyticsConf.page' };
  const isBrowse = productType === 'CATEGORY' || productType === 'BROWSE' || (searchRequest && searchRequest.apiType === 'category');
  if (!isBrowse) {
    return { ...base, status: SKIP, detail: 'Not a browse/category page.', evidence: { productType } };
  }

  const conf = sdk.analyticsConf || { present: false };
  const browseParamName = typeof sdk.browseQueryParamName === 'string' ? sdk.browseQueryParamName : 'p';
  const apiP = searchRequest && searchRequest.params ? searchRequest.params.p : undefined;
  const evidence = {
    analyticsConfPresent: conf.present,
    analyticsConfPage: conf.page ?? null,
    analyticsConfPageType: conf.page_type ?? null,
    sdkCategoryId: sdk.categoryId ?? null,
    apiPValue: apiP ?? null,
    pageUrlBrowseParamName: browseParamName,
    pageUrlBrowseValue: sdk.pageUrlParams ? sdk.pageUrlParams[browseParamName] ?? null : null
  };

  if (!conf.present) {
    return {
      ...base,
      status: FAIL,
      detail:
        'window.UnbxdAnalyticsConf is not set. The default getCategoryId() reads UnbxdAnalyticsConf.page, so the category the page should query is undefined — and browse analytics cannot fire either.',
      evidence
    };
  }
  if (apiP === undefined) {
    return { ...base, status: FAIL, detail: 'The category call carried no p parameter.', evidence };
  }

  const normalise = (v) => {
    if (v == null) return '';
    let s = String(v);
    try {
      s = decodeURIComponent(s);
    } catch {
      /* already decoded */
    }
    return s.replace(/\s+/g, '').replace(/["']/g, '');
  };

  const confPage = normalise(conf.page);
  const sent = normalise(apiP);
  if (!confPage) {
    return { ...base, status: WARN, detail: 'UnbxdAnalyticsConf exists but .page is empty.', evidence };
  }
  if (sent === confPage || sent.includes(confPage) || confPage.includes(sent)) {
    return { ...base, status: PASS, detail: `p= matches UnbxdAnalyticsConf.page ("${conf.page}").`, evidence };
  }
  return {
    ...base,
    status: FAIL,
    detail: `The category call asked for p="${apiP}" but UnbxdAnalyticsConf.page is "${conf.page}". The PLP is querying a different category than the page represents — check setCategoryId/getCategoryId and when UnbxdAnalyticsConf is assigned relative to SDK init.`,
    evidence
  };
}

/**
 * Attribute mapping: every field the config maps or requests should exist in
 * the products the catalogue returned. A mapped field that isn't in the
 * response is the usual reason a grid renders blank tiles or broken images.
 */
function attributeMappingCheck(live, searchRequest, responseSummary) {
  const base = { id: 'attribute_mapping_matches_response', title: 'Mapped attributes exist in the API response' };
  const returned = responseSummary && responseSummary.productFieldNames ? responseSummary.productFieldNames : null;
  if (!returned || !returned.length) {
    return {
      ...base,
      status: SKIP,
      detail: 'No product field names in the response to compare against (empty result set or unparsed response).',
      evidence: {}
    };
  }

  const products = (live.options && live.options.products) || {};
  const mapped = new Set();
  const map = products.attributesMap;
  if (map && typeof map === 'object') {
    for (const v of Object.values(map)) if (typeof v === 'string' && v) mapped.add(v);
  }
  const attrs = products.productAttributes || products.fields;
  if (Array.isArray(attrs)) {
    for (const a of attrs) {
      if (typeof a === 'string') mapped.add(a);
      else if (a && typeof a === 'object' && typeof a.name === 'string') mapped.add(a.name);
    }
  }

  // Fields the request explicitly asked the API for.
  const requested = [];
  const fieldsParam = searchRequest && searchRequest.params ? searchRequest.params.fields : null;
  if (typeof fieldsParam === 'string') {
    for (const f of fieldsParam.split(',')) {
      const t = f.trim();
      if (t) requested.push(t);
    }
  }

  const returnedSet = new Set(returned);
  const missingMapped = [...mapped].filter((f) => !returnedSet.has(f));
  const missingRequested = requested.filter((f) => !returnedSet.has(f));

  const evidence = {
    mappedFields: [...mapped].slice(0, 30),
    requestedFields: requested.slice(0, 40),
    returnedFields: returned.slice(0, 40),
    missingMapped,
    missingRequested: missingRequested.slice(0, 20)
  };

  if (!mapped.size && !requested.length) {
    return { ...base, status: SKIP, detail: 'No attributesMap/productAttributes/fields to check.', evidence };
  }
  if (missingMapped.length) {
    return {
      ...base,
      status: FAIL,
      detail: `Config maps ${missingMapped.length} field(s) the catalogue did not return: ${missingMapped.join(', ')}. The template will read undefined for these — the usual cause of blank tiles or placeholder images. Either the field name is wrong in attributesMap or it is missing from the fields= list / the catalogue.`,
      evidence
    };
  }
  if (missingRequested.length) {
    return {
      ...base,
      status: WARN,
      detail: `The request asked for ${missingRequested.length} field(s) absent from the returned products: ${missingRequested.slice(0, 8).join(', ')}. Usually a catalogue/indexing gap rather than a config bug.`,
      evidence
    };
  }
  return { ...base, status: PASS, detail: 'Every mapped and requested field is present in the returned products.', evidence };
}

function apiVsDomCheck(responseSummary, renderedPage) {
  const base = { id: 'api_results_rendered', title: 'API results actually rendered' };
  if (!responseSummary || !responseSummary.parsed || !renderedPage) {
    return { ...base, status: SKIP, detail: 'No parsed response or no DOM snapshot.', evidence: {} };
  }
  const returned = responseSummary.returnedProductCount || 0;
  const counts = renderedPage.domProductNodeCounts || {};
  const domMax = Math.max(0, ...Object.values(counts).filter((n) => typeof n === 'number'));
  const evidence = {
    returnedProductCount: returned,
    numberOfProducts: responseSummary.numberOfProducts,
    domProductNodeCounts: counts,
    visibleNoResultsText: renderedPage.visibleNoResultsText
  };

  if (returned === 0) {
    return {
      ...base,
      status: WARN,
      detail: 'The API returned zero products — this is a data/query problem, not a rendering one. Check the query and browse checks above before the template.',
      evidence
    };
  }
  if (domMax === 0) {
    return {
      ...base,
      status: FAIL,
      detail: `The API returned ${returned} products but no product-like nodes are in the DOM. Rendering/templating problem: check config selectors and attribute mapping above, and the console for a template error.`,
      evidence
    };
  }
  return { ...base, status: PASS, detail: `API returned ${returned} products and the DOM has product nodes (max selector count ${domMax}).`, evidence };
}
