/**
 * Who owns this bug? — the routing decision support actually has to make.
 *
 * Support's question is not "what is the root cause" in the abstract; it is
 * "do I send this back to the customer, or raise an internal Jira?". This turns
 * the evidence the capture already gathered into that decision, deterministically
 * and before any model sees it, the same way self-debug.js turns raw captures
 * into pass/fail verdicts.
 *
 * Inputs (all optional — missing evidence lowers confidence, never invents it):
 *   context.selfDebug     ordered pass/fail checks (self-debug.js)
 *   context.sdkAssets     did the Unbxd bundles load (sdk-assets.js)
 *   context.searchRequest / autosuggestRequest / responseSummary
 *   inventory             page-inventory.js — scripts, console errors and failed
 *                         requests attributed to Unbxd vs customer, platform,
 *                         competing search apps, access blocks
 *   css                   css-provenance.js — whose stylesheet hides/moves the
 *                         widget's elements
 *   interaction           what the triage did on the page (typed a query…)
 *
 * Method: every piece of evidence adds a weighted signal to one owner; the
 * highest total wins; confidence comes from the absolute score and the margin
 * over the runner-up. The first failing self-debug check (the most upstream
 * one) gets a bonus, preserving that module's upstream-first contract.
 *
 * Rules this keeps, same as self-debug.js:
 *   - A check that could not apply contributes nothing. Absence of evidence is
 *     never scored as a finding.
 *   - Customer attribution must point at something nameable (a script URL, a
 *     stylesheet + selector, a missing tag). "Their JS is probably bad" is not
 *     a signal.
 *   - The output is a suggestion with its evidence attached. The support agent
 *     (and the model) can overrule it, and the runner-up is always reported.
 */

export const OWNERS = {
  unbxd_api: {
    label: 'Unbxd Search API',
    side: 'unbxd',
    route: 'raise_internal_jira',
    team: 'Unbxd Search API / Platform'
  },
  unbxd_sdk: {
    label: 'Unbxd SDK library or CDN (bundles failing to load, SDK library errors)',
    side: 'unbxd',
    route: 'raise_internal_jira',
    team: 'Unbxd SDK / Platform'
  },
  unbxd_config: {
    label: "The site's Unbxd SDK config and templates ({siteKey}_search.js / _autosuggest.js / .css)",
    side: 'unbxd',
    route: 'raise_internal_jira',
    team: 'Unbxd CX / Integration (config change)'
  },
  catalogue_data: {
    label: 'Catalogue / feed data or merchandising (the API answered correctly for the data it has)',
    side: 'shared',
    route: 'raise_internal_jira',
    team: 'Unbxd Catalogue / Merchandising — check the Unbxd console first'
  },
  customer_site_code: {
    label: "The customer's website code (theme JS, installed apps/modules, page template, server headers)",
    side: 'customer',
    route: 'revert_to_customer',
    team: null
  },
  customer_site_css: {
    label: "The customer's website CSS (theme styles overriding the Unbxd widget)",
    side: 'customer',
    route: 'revert_to_customer',
    team: null
  },
  access_blocked: {
    label: 'The page could not be inspected (bot protection, password page, maintenance)',
    side: 'unknown',
    route: 'need_more_evidence',
    team: null
  },
  not_reproduced: {
    label: 'Not reproduced — every check passed and nothing points at a fault',
    side: 'none',
    route: 'need_more_evidence',
    team: null
  }
};

export const ROUTES = {
  revert_to_customer: 'Revert to customer',
  raise_internal_jira: 'Raise internal Jira',
  need_more_evidence: 'Need more evidence'
};

/** Per self-debug check: owner/weight for each status. Order mirrors the
 *  checks themselves. Checks with conditional ownership are handled below. */
const CHECK_RULES = {
  sdk_initialised: { fail: [['unbxd_config', 6]] },
  page_type_matches_endpoint: { fail: [['unbxd_config', 7]] },
  search_query_reaches_api: { fail: [['unbxd_config', 6]] },
  config_selectors_resolve: { fail: [['unbxd_config', 5]] },
  site_key_consistent: { fail: [['unbxd_config', 7]] },
  popular_products_requested: { fail: [['unbxd_config', 6]] },
  popular_products_returned: { fail: [['catalogue_data', 4], ['unbxd_config', 2]], warn: [['unbxd_api', 3]] },
  popular_products_rendered: { fail: [['unbxd_config', 5]] }
};

const CAVEATS = {
  config_selectors_resolve:
    'A config selector that matches nothing is usually fixed in the Unbxd config — but if the customer recently changed their theme/markup, the container may have been removed on their side. Ask whether the theme changed before deciding.',
  search_query_reaches_api:
    "Fixed in the config's searchQueryParam — unless the customer's own search form was changed to submit a different parameter name, in which case it is theirs.",
  analytics_conf_missing:
    'window.UnbxdAnalyticsConf is set by the page template. On app/module integrations (Unbxd Shopify app, Unbxd Magento module) the app sets it — confirm which before reverting to the customer.',
  asset_404:
    'A 404 on an Unbxd bundle is either a missing deployment (Unbxd) or a wrong URL/site key in the script tag the customer added (customer). Compare the URL against the site key before routing.'
};

export function classifyOwnership({ issueTypeId, context = {}, inventory = null, css = null, interaction = null, navigation = null } = {}) {
  const signals = [];
  const caveats = new Set();
  const add = (owner, weight, signal, detail) => {
    if (weight > 0 && OWNERS[owner]) signals.push({ owner, weight: round1(weight), signal, detail: String(detail || '').slice(0, 500) });
  };

  const checks = (context.selfDebug && context.selfDebug.checks) || [];
  const failing = checks.filter((c) => c.status === 'fail');
  const isAutosuggest = issueTypeId === 'autosuggest_data' || issueTypeId === 'autosuggest_alignment';

  /* 0 — could we see the real page at all? ---------------------------- */
  if (inventory && inventory.access && inventory.access.blocked) {
    add('access_blocked', 12, 'page.access', inventory.access.reason);
  } else if (navigation && typeof navigation.status === 'number' && navigation.status >= 400) {
    // The document itself was refused. Whatever the checks below find, they
    // found it on an error page, not on the customer's storefront.
    add(
      'access_blocked',
      12,
      'page.http_status',
      navigation.status === 404
        ? `The page returned HTTP 404 — check the URL with the customer.`
        : `The page returned HTTP ${navigation.status} to the inspecting browser, so the storefront was never seen. Usually bot protection reacting to an automated browser — re-run in the visible browser or attached to your own Chrome.`
    );
  }

  /* 1 — Unbxd bundles and API reachability ----------------------------- */
  assetAndRequestSignals({ context, inventory, add, caveats });

  /* 2 — API call health ------------------------------------------------ */
  apiHealthSignals({ context, add });

  /* 3 — self-debug verdicts -------------------------------------------- */
  for (const c of checks) checkSignals({ check: c, context, inventory, interaction, add, caveats });
  const first = failing[0];
  if (first) {
    const primary = primaryOwnerForCheck(first);
    if (primary) add(primary, 2, `firstFailure:${first.id}`, `Most upstream failing check: ${first.title}`);
  }

  /* 4 — console errors, attributed by the script that raised them ------ */
  const cssHidesWidget = Boolean(css && (css.elements || []).some((e) => e.expectVisible && e.hiddenBy && e.hiddenBy.owner === 'customer'));
  const widgetFailing = failing.length > 0 || cssHidesWidget;
  consoleSignals({ inventory, widgetFailing, add });

  /* 5 — competing / native search -------------------------------------- */
  searchConflictSignals({ inventory, isAutosuggest, interaction, add });

  /* 6 — CSS provenance ------------------------------------------------- */
  cssSignals({ css, issueTypeId, add, caveats });

  /* 7 — alignment geometry --------------------------------------------- */
  if (issueTypeId === 'autosuggest_alignment') alignmentSignals({ context, css, add, caveats });

  /* tally ---------------------------------------------------------------- */
  const scores = {};
  for (const s of signals) scores[s.owner] = round1((scores[s.owner] || 0) + s.weight);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  let owner;
  let confidence;
  const [topOwner, topScore = 0] = ranked[0] || [];
  const runnerUp = ranked[1] ? { owner: ranked[1][0], label: OWNERS[ranked[1][0]].label, score: ranked[1][1] } : null;

  if (scores.access_blocked) {
    owner = 'access_blocked';
    confidence = 'high';
  } else if (!topOwner || topScore < 3) {
    owner = 'not_reproduced';
    const ran = checks.filter((c) => c.status !== 'skip').length;
    confidence = ran >= 4 && !failing.length ? 'medium' : 'low';
    if (!ran) caveats.add('No self-debug checks could run on this page — "not reproduced" here means "not enough evidence", not "working".');
  } else {
    owner = topOwner;
    const margin = topScore - (runnerUp ? runnerUp.score : 0);
    confidence = topScore >= 8 && margin >= 4 ? 'high' : topScore >= 4 && margin >= 2 ? 'medium' : 'low';
  }

  const meta = OWNERS[owner];
  const evidence = signals
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10);
  const lead = evidence.find((s) => s.owner === owner);
  const sideScores = {};
  for (const [o, sc] of Object.entries(scores)) sideScores[OWNERS[o].side] = round1((sideScores[OWNERS[o].side] || 0) + sc);

  if (owner === 'catalogue_data') {
    caveats.add('If the product data itself is missing or wrong in the customer\'s Shopify/Magento admin, revert to the customer; if it is correct there but not in Unbxd, raise it with the catalogue team.');
  }
  if (owner === 'not_reproduced') {
    caveats.add('Ask the customer for: exact page URL, the query/category, device + browser, a screenshot or screen recording, and when it happened. Then re-run triage with that.');
  }

  return {
    owner,
    ownerLabel: meta.label,
    side: meta.side,
    route: meta.route,
    decision: meta.team ? `${ROUTES[meta.route]} → ${meta.team}` : ROUTES[meta.route],
    team: meta.team,
    confidence,
    summary: lead ? `${meta.label}: ${lead.detail}` : meta.label,
    runnerUp,
    scores,
    sideScores,
    evidence,
    caveats: [...caveats],
    howToRead:
      'Deterministic suggestion from weighted evidence. Each evidence row names the owner it points at and why. Agree with it only when the evidence supports it; when confidence is low, present the runner-up as a real possibility.'
  };
}

/* ------------------------------------------------------------------ */
/* Signal builders                                                       */
/* ------------------------------------------------------------------ */

function assetAndRequestSignals({ context, inventory, add, caveats }) {
  const failed = (inventory && inventory.failedRequests) || [];

  for (const f of failed) {
    if (f.owner !== 'unbxd') continue;
    const what = f.assetKind ? `Unbxd ${f.assetKind}` : f.apiKind ? `Unbxd ${f.apiKind} API call` : 'Unbxd request';
    const err = String(f.errorText || '');
    if (f.blockedReason === 'csp') {
      add('customer_site_code', 8, 'request.blocked.csp', `${what} was blocked by the site's Content-Security-Policy (${f.url}). The customer's server/theme headers must allow Unbxd hosts.`);
    } else if (f.blockedReason === 'mixed-content') {
      add('customer_site_code', 6, 'request.blocked.mixed', `${what} was blocked as mixed content — the customer's page includes it over http:// (${f.url}).`);
    } else if (/ERR_BLOCKED_BY_CLIENT/.test(err)) {
      caveats.add(`${what} was blocked by a browser extension/ad-blocker in the inspecting browser — not a site bug. Re-run in a clean profile.`);
    } else if (f.assetKind) {
      if (f.status === 404) {
        add('unbxd_sdk', 6, 'asset.404', `${what} returned 404 (${f.url}).`);
        caveats.add(CAVEATS.asset_404);
      } else if (f.status === 403) {
        add('unbxd_sdk', 5, 'asset.403', `${what} returned 403 (${f.url}).`);
      } else {
        add('unbxd_sdk', 8, 'asset.failed', `${what} failed to load: ${f.status || err || 'network error'} (${f.url}).`);
      }
    } else if (f.apiKind) {
      if (f.corsError) {
        add('unbxd_api', 4, 'api.cors', `${what} failed CORS (${f.corsError}).`);
      } else if (f.status === 401 || f.status === 403) {
        add('unbxd_config', 4, 'api.auth', `${what} returned ${f.status} — the API key / site key in the config is likely wrong or disabled.`);
        add('unbxd_api', 2, 'api.auth', `${what} returned ${f.status} — or the key was disabled on the platform side.`);
      } else if (f.status === 400) {
        add('unbxd_config', 4, 'api.400', `${what} returned 400 — the config built an invalid request.`);
      } else if (f.status === 429) {
        add('unbxd_api', 6, 'api.429', `${what} was rate-limited (429).`);
      } else if (f.status >= 500 || !f.status) {
        add('unbxd_api', 9, 'api.5xx', `${what} failed: ${f.status || err || 'network error'} (${f.url}).`);
      }
    }
  }

  // No Unbxd script on the page at all.
  const assets = context.sdkAssets;
  const integ = inventory && inventory.unbxdIntegration;
  // Only meaningful on a real storefront page: an error/block page has no
  // scripts at all, and "no Unbxd tag" there says nothing about the customer.
  const realPage = Boolean(inventory && inventory.scripts && inventory.scripts.total >= 3);
  if (realPage && assets && assets.verdict === 'not_observed' && integ && !integ.scriptTags.length && !integ.inlineSnippetsMentioningUnbxd) {
    add('customer_site_code', 6, 'integration.missing', 'No Unbxd <script> tag or inline Unbxd snippet exists on this page — the integration snippet is not in this page template.');
    caveats.add('On app/module integrations the Unbxd app injects the scripts — if the app is installed, check it is enabled for this page type before reverting to the customer.');
  }

  // The same bundle included twice.
  const dupes = (context.siteConfig && context.siteConfig.assetUrls && context.siteConfig.assetUrls.duplicateKinds) || [];
  const tagKinds = integ ? integ.scriptTags.map((t) => t.kind).filter(Boolean) : [];
  const dupTags = tagKinds.filter((k, i) => tagKinds.indexOf(k) !== i);
  if (dupes.length || dupTags.length) {
    add('customer_site_code', 3, 'integration.duplicate', `The Unbxd bundle is included more than once (${[...new Set([...dupes, ...dupTags])].join(', ')}) — typically the theme and an app both add it, or the snippet is pasted twice.`);
  }
}

function apiHealthSignals({ context, add }) {
  const req = context.searchRequest || context.autosuggestRequest || null;
  const resp = context.responseSummary || null;
  if (!req) return;
  if (resp && resp.available && resp.parsed === false) {
    add('unbxd_api', 5, 'api.non_json', `The ${req.apiType || 'autosuggest'} API answered with non-JSON (${resp.head || 'HTML'}) — an error or challenge page instead of results.`);
  }
  if (resp && resp.errorField) {
    add('unbxd_api', 5, 'api.error_field', `The API response carries an error: ${String(resp.errorField).slice(0, 160)}.`);
  }
  if (typeof req.durationMs === 'number' && req.durationMs > 3000 && !req.failed) {
    add('unbxd_api', 2, 'api.slow', `The API call took ${req.durationMs}ms.`);
  }
}

function primaryOwnerForCheck(check) {
  const rule = CHECK_RULES[check.id];
  if (rule && rule[check.status] && rule[check.status][0]) return rule[check.status][0][0];
  if (check.id === 'api_results_rendered') return 'unbxd_config';
  if (check.id === 'browse_target_matches_analytics_conf') {
    return check.evidence && check.evidence.analyticsConfPresent === false ? 'customer_site_code' : 'unbxd_config';
  }
  if (check.id === 'autosuggest_api_triggered') return 'unbxd_config';
  return null;
}

function checkSignals({ check: c, context, inventory, interaction, add, caveats }) {
  const ev = c.evidence || {};
  const rule = CHECK_RULES[c.id];
  if (rule && rule[c.status]) {
    for (const [owner, weight] of rule[c.status]) add(owner, weight, `check:${c.id}`, c.detail);
    if (CAVEATS[c.id]) caveats.add(CAVEATS[c.id]);
    return;
  }

  switch (c.id) {
    case 'browse_target_matches_analytics_conf':
      if (c.status !== 'fail') return;
      if (ev.analyticsConfPresent === false) {
        add('customer_site_code', 5, `check:${c.id}`, c.detail);
        caveats.add(CAVEATS.analytics_conf_missing);
      } else {
        add('unbxd_config', 4, `check:${c.id}`, c.detail);
        add('customer_site_code', 2, `check:${c.id}`, 'UnbxdAnalyticsConf.page is assigned by the page template — the template may be setting the wrong category value.');
      }
      return;

    case 'attribute_mapping_matches_response':
      if (c.status !== 'warn') return;
      if ((ev.missingRequested || []).length) add('catalogue_data', 2, `check:${c.id}`, `Requested fields missing from the catalogue response: ${ev.missingRequested.slice(0, 6).join(', ')}.`);
      if ((ev.missingMapped || []).length) add('unbxd_config', 1, `check:${c.id}`, `Config maps fields the catalogue does not return: ${ev.missingMapped.slice(0, 6).join(', ')}.`);
      return;

    case 'api_results_rendered':
      if (c.status === 'fail') {
        add('unbxd_config', 4, `check:${c.id}`, c.detail);
      } else if (c.status === 'warn' && ev.returnedProductCount === 0) {
        add('catalogue_data', 5, `check:${c.id}`, `The API returned 0 products for this request (numberOfProducts ${ev.numberOfProducts ?? 0}).`);
      }
      return;

    case 'single_api_call':
      if (c.status === 'warn') add('unbxd_config', 2, `check:${c.id}`, c.detail);
      return;

    case 'autosuggest_api_triggered':
      if (c.status !== 'fail') return;
      if (interaction && interaction.typed) {
        add('unbxd_config', 4, `check:${c.id}`, `Typed "${interaction.query}" into ${interaction.selector} and no autosuggest API call fired.`);
      } else {
        caveats.add('No autosuggest call was recorded, but the triage could not type into a search box, so that is not evidence of a fault. Re-run with search_query, or type with the interact tool.');
      }
      return;

    default:
      return;
  }
}

function consoleSignals({ inventory, widgetFailing, add }) {
  const errors = (inventory && inventory.consoleErrors) || [];
  if (!errors.length) return;

  const customer = errors.filter((e) => e.owner === 'customer');
  const customerTouchingUnbxd = customer.filter((e) => e.mentionsUnbxd);
  const unbxdConfigErrors = errors.filter((e) => e.owner === 'unbxd' && !/search-sdk|vanillaSearch|autosuggest-sdk/i.test(e.scriptUrl || ''));
  const unbxdLibraryExceptions = errors.filter((e) => e.owner === 'unbxd' && e.kind === 'exception' && /search-sdk|vanillaSearch|autosuggest-sdk/i.test(e.scriptUrl || ''));

  if (customerTouchingUnbxd.length) {
    const e = customerTouchingUnbxd[0];
    add('customer_site_code', 3, 'console.customer_touching_unbxd', `A customer script references the Unbxd widget and throws: "${e.text}" (${e.scriptUrl || e.source}).`);
  }
  const plain = customer.filter((e) => !e.mentionsUnbxd && e.kind === 'exception');
  if (plain.length) {
    const weight = widgetFailing ? Math.min(4.5, plain.length * 1.5) : Math.min(1, plain.length * 0.5);
    const e = plain[0];
    add('customer_site_code', weight, 'console.customer_exceptions', `${plain.length} uncaught error(s) from the customer's scripts, e.g. "${e.text}" (${e.scriptUrl || e.source}${e.detail ? `, ${e.detail}` : ''}).`);
  }
  if (unbxdConfigErrors.length) {
    const e = unbxdConfigErrors[0];
    add('unbxd_config', Math.min(4, unbxdConfigErrors.length * 2), 'console.unbxd_bundle_errors', `${unbxdConfigErrors.length} error(s) raised from the site's Unbxd bundle, e.g. "${e.text}" (${e.scriptUrl}).`);
  }
  if (unbxdLibraryExceptions.length) {
    const e = unbxdLibraryExceptions[0];
    add('unbxd_sdk', Math.min(3, unbxdLibraryExceptions.length * 1.5), 'console.unbxd_library_exceptions', `${unbxdLibraryExceptions.length} uncaught error(s) inside the Unbxd SDK library, e.g. "${e.text}" (${e.scriptUrl}).`);
  }
}

function searchConflictSignals({ inventory, isAutosuggest, interaction, add }) {
  if (!inventory) return;
  for (const c of inventory.competingSearch || []) {
    const active = Boolean(c.scriptSrc) || c.domMarkerVisible;
    if (!active) continue;
    add(
      'customer_site_code',
      isAutosuggest ? 5 : 3,
      'conflict.competing_search_app',
      `${c.vendor} is still installed on the page${c.scriptSrc ? ` (${c.scriptSrc})` : ''}${c.domMarkerVisible ? ' and its UI is visible' : ''} — a second search app competes for the same search box/results.`
    );
  }
  for (const n of inventory.nativeSearch || []) {
    const visible = n.visibleCount > 0 && n.visibleWithContent !== false;
    if (!isAutosuggest) continue;
    if (visible) {
      add('customer_site_code', 5, 'conflict.native_search_visible', `${n.what} is visible (${n.selector}) — the theme's own search dropdown is still enabled next to Unbxd.`);
    } else if (n.visibleCount === null && interaction && interaction.typed) {
      add('customer_site_code', 2, 'conflict.native_search_bound', `${n.what} — the platform's own autocomplete is wired to the search input and may intercept typing.`);
    }
  }
}

function cssSignals({ css, issueTypeId, add }) {
  if (!css || !css.elements) return;
  const alignment = issueTypeId === 'autosuggest_alignment';
  let hiddenWeight = 0;
  for (const el of css.elements) {
    if (!el.found || !el.expectVisible || !el.hiddenBy) continue;
    const h = el.hiddenBy;
    const where = `${h.property}: ${h.value}${h.important ? ' !important' : ''} from ${h.sheet || h.source}${h.selector ? ` (selector ${h.selector})` : ''}`;
    if (h.owner === 'customer' && hiddenWeight < 8) {
      // An element that should be showing, hidden by a named rule in a named
      // customer file, is as conclusive as this evidence gets.
      hiddenWeight += 8;
      add('customer_site_css', 8, 'css.hidden_by_customer', `${el.label} should be visible but is hidden by ${where}.`);
    } else if (h.owner === 'unbxd') {
      add('unbxd_config', 4, 'css.hidden_by_unbxd', `${el.label} should be visible but is hidden by Unbxd CSS: ${where}.`);
    }
  }

  const overrides = [];
  for (const el of css.elements) {
    for (const o of el.overrides || []) if (o.winnerOwner === 'customer') overrides.push({ el, o });
  }
  if (overrides.length) {
    const per = alignment ? 2.5 : 1;
    const cap = alignment ? 7.5 : 3;
    const top = overrides
      .slice(0, 3)
      .map(({ el, o }) => `${el.label}: ${o.property} "${o.unbxdValue}" (Unbxd) overridden to "${o.winningValue}" by ${o.winnerSheet || o.winnerSource}${o.winnerSelector ? ` [${o.winnerSelector}]` : ''}`)
      .join('; ');
    add('customer_site_css', Math.min(cap, overrides.length * per), 'css.customer_overrides_unbxd', `Customer CSS overrides Unbxd's own rules — ${top}.`);
  }

  if (alignment) {
    const clippers = css.elements.filter((e) => e.found && e.role === 'ancestor' && e.computed && /hidden|clip|auto|scroll/.test(`${e.computed['overflow-x']} ${e.computed['overflow-y']}`));
    const customerClip = clippers.find((e) => (e.customerLayoutRules || []).some((r) => /overflow/.test(r.property)) || (e.overrides || []).some((o) => /overflow/.test(o.property)));
    if (customerClip) {
      const rule = (customerClip.customerLayoutRules || []).find((r) => /overflow/.test(r.property)) || {};
      add('customer_site_css', 4, 'css.customer_clipping_ancestor', `An ancestor of the dropdown clips it: overflow ${customerClip.computed['overflow-x']}/${customerClip.computed['overflow-y']} from ${rule.sheet || 'customer CSS'}${rule.selector ? ` (selector ${rule.selector})` : ''}.`);
    }
    const reroot = css.elements.find((e) => e.found && e.role === 'ancestor' && e.computed && e.computed.transform && e.computed.transform !== 'none' && (e.customerLayoutRules || []).some((r) => r.property === 'transform'));
    if (reroot) {
      const rule = reroot.customerLayoutRules.find((r) => r.property === 'transform');
      add('customer_site_css', 3, 'css.customer_transform_ancestor', `An ancestor has transform: ${reroot.computed.transform} from ${rule.sheet || 'customer CSS'}${rule.selector ? ` (selector ${rule.selector})` : ''} — this re-roots the dropdown's positioning.`);
    }
  }
}

function alignmentSignals({ context, css, add, caveats }) {
  const off = context.relativeOffset;
  if (!context.dropdown || !off) {
    caveats.add('The autosuggest dropdown was not on screen when the layout was captured — type a query (search_query) so it opens, then re-run.');
    return;
  }
  const misaligned = Math.abs(off.dxLeft || 0) > 4 || Math.abs(off.dyTopToInputBottom || 0) > 6 || Math.abs(off.widthDelta || 0) > 8;
  if (!misaligned) return;
  const customerCss = css && (css.elements || []).some((e) => (e.overrides || []).some((o) => o.winnerOwner === 'customer') || (e.role === 'ancestor' && (e.customerLayoutRules || []).length));
  const desc = `Dropdown is offset from its input by dx=${off.dxLeft}px, dy=${off.dyTopToInputBottom}px, width delta ${off.widthDelta}px.`;
  add('unbxd_config', customerCss ? 1.5 : 3, 'geometry.offset', `${desc}${customerCss ? '' : ' No customer CSS overrides it, so the widget\'s own CSS/positioning is the likely source.'}`);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
