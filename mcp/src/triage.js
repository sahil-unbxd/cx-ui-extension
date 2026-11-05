/**
 * The triage pipeline: open the customer's page, reproduce, run the shared
 * capture/self-debug code, attribute ownership, and assemble the briefing
 * Claude answers from.
 *
 * Same order as the extension's stopAndAnalyse(), with three differences that
 * come from not having an engineer at the keyboard:
 *   - recording starts before navigation, so "fresh page load" is always true;
 *   - reproduction is scripted (type into the search box, submit a search)
 *     instead of done by hand;
 *   - the model is the MCP client itself, so the result is a briefing, not an
 *     API call. No API key lives in this server.
 */
import { getIssueType } from '../../src/shared/issue-types.js';
import { unbxdApiKind } from '../../src/shared/unbxd-endpoints.js';
import { runStrategy } from '../../src/capture/strategies.js';
import { detectIssueType } from '../../src/capture/detect-issue-type.js';
import { capturePageInventory } from '../../src/capture/page-inventory.js';
import { captureCssProvenance, cssTargetsFor } from '../../src/capture/css-provenance.js';
import { classifyOwnership } from '../../src/capture/ownership.js';
import { buildPrompt } from '../../src/prompt/builder.js';
import { TRIAGE_OUTPUT_CONTRACT } from '../../src/prompt/templates.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AUTOSUGGEST_WORDS = /auto-?suggest|auto ?complete|type ?ahead|suggestion|drop-?down|popular product|top quer|search (box|bar|field|input)|while typing/i;

/* ------------------------------------------------------------------ */
/* Page helpers (also used directly by tools in server.js)              */
/* ------------------------------------------------------------------ */

export async function navigate(run, url, { timeoutMs = 45000 } = {}) {
  const { page } = run;
  let status = null;
  let error = null;
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    status = res ? res.status() : null;
  } catch (err) {
    // A page that never fires "load" (long-polling widgets, stuck pixels) is
    // still usually inspectable — record the error and carry on.
    error = String(err.message || err).split('\n')[0];
  }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  run.navigated = true;
  run.steps.push(`Opened ${url}${status ? ` (HTTP ${status})` : ''}`);
  return { requestedUrl: url, finalUrl: page.url(), status, error };
}

/** Poll the recorder for a completed Unbxd API call of one of `kinds`
 *  that started after request number `since`. */
export async function waitForUnbxdApi(run, kinds, timeoutMs, since = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = run.recorder
      .all()
      .slice(since)
      .find((r) => kinds.includes(unbxdApiKind(r.rawUrl)) && (r.status != null || r.failed));
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

const CHALLENGE_TITLE = /just a moment|attention required|verify (you are|that you are) (a )?human|security check|pardon our interruption/i;

/** Interactive JS challenges often clear on their own in a real browser. */
export async function waitOutChallenge(run) {
  const title = await run.page.title().catch(() => '');
  if (!CHALLENGE_TITLE.test(title)) return false;
  run.steps.push(`Got a bot-protection page ("${title}") — waited for it to clear`);
  await run.page.waitForFunction((re) => !new RegExp(re, 'i').test(document.title), CHALLENGE_TITLE.source, { timeout: 12000 }).catch(() => {});
  await run.page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  return true;
}

const SEARCH_TOGGLES = [
  'summary[aria-label*="search" i]',
  'button[aria-label*="search" i]',
  'a[aria-label*="search" i]',
  '.header__icon--search',
  '.search-toggle',
  '[data-action="toggle-search"]',
  '.block-search .label',
  'label[for="search"]'
];

/** Finds a *visible* search input (themes often ship hidden desktop/mobile
 *  duplicates) and tags it so Playwright can target that exact element. */
const FIND_INPUT = () => {
  const visible = (el) => {
    try {
      if (!el || el.disabled || !el.getClientRects().length) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && el.offsetWidth > 0 && el.offsetHeight > 0;
    } catch {
      return false;
    }
  };
  for (const old of document.querySelectorAll('[data-unbxd-mcp-input]')) old.removeAttribute('data-unbxd-mcp-input');
  const candidates = [];
  try {
    const o = window.unbxdSearch && window.unbxdSearch.options;
    if (o && o.searchBoxEl) candidates.push(o.searchBoxEl);
  } catch {
    /* ignore */
  }
  candidates.push(
    'input.unbxd-as-input', 'input[data-unbxd-search]', 'input#search', 'input[name="q"]', 'input[type="search"]',
    'input[name="query"]', 'input[name="searchTerm"]', 'input[name="keyword"]', 'input[aria-label*="search" i]', 'input[placeholder*="search" i]'
  );
  for (const c of candidates) {
    let nodes = [];
    try {
      nodes = typeof c === 'string' ? [...document.querySelectorAll(c)] : c && c.nodeType === 1 ? [c] : [];
    } catch {
      nodes = [];
    }
    const el = nodes.find(visible);
    if (el) {
      el.setAttribute('data-unbxd-mcp-input', '1');
      return {
        found: true,
        via: typeof c === 'string' ? c : 'unbxdSearch.options.searchBoxEl',
        element: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.name ? `[name="${el.name}"]` : ''}`
      };
    }
  }
  return { found: false };
};

/** A query that will return *something* on this store, taken from its own
 *  navigation (category names) when the support agent didn't give one. */
const PICK_QUERY = () => {
  const stop = /^(home|shop|account|login|log in|sign in|cart|bag|basket|contact|about|help|menu|search|blog|stores?|faq|wishlist|register|new|more|all)$/i;
  const links = [...document.querySelectorAll('header nav a, nav a, [role="navigation"] a')];
  for (const a of links) {
    const t = (a.textContent || '').trim().split(/\s+/)[0] || '';
    if (/^[A-Za-z][A-Za-z-]{3,14}$/.test(t) && !stop.test(t)) return t.toLowerCase();
  }
  return null;
};

export async function typeInSearchBox(run, query, { submit = false } = {}) {
  const { page, session } = run;
  let found = await session.evaluate(`(${FIND_INPUT.toString()})()`);
  if (!found || !found.found) {
    // Search input hidden behind a toggle (Shopify Dawn, many Magento themes).
    for (const sel of SEARCH_TOGGLES) {
      const toggle = page.locator(sel).first();
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click({ timeout: 3000 }).catch(() => {});
        await sleep(700);
        found = await session.evaluate(`(${FIND_INPUT.toString()})()`);
        if (found && found.found) {
          run.steps.push(`Opened the search box via ${sel}`);
          break;
        }
      }
    }
  }
  if (!found || !found.found) {
    return { typed: false, reason: 'No visible search input found on the page (tried the SDK searchBoxEl and common selectors).' };
  }

  const effectiveQuery = query || (await session.evaluate(`(${PICK_QUERY.toString()})()`)) || 'sale';
  const selector = '[data-unbxd-mcp-input="1"]';
  const input = page.locator(selector).first();
  const since = run.recorder.all().length;
  try {
    await input.click({ timeout: 5000 });
    await input.fill('');
    await input.pressSequentially(effectiveQuery, { delay: 110 });
  } catch (err) {
    return { typed: false, selector, element: found.element, reason: `Could not type into ${found.element}: ${String(err.message).split('\n')[0]}` };
  }
  run.steps.push(`Typed "${effectiveQuery}" into the search box (${found.element})`);

  const autosuggestCall = await waitForUnbxdApi(run, ['autosuggest'], 5000, since);
  await sleep(900); // let the dropdown render
  const result = {
    typed: true,
    query: effectiveQuery,
    queryWasGuessed: !query,
    selector,
    element: found.element,
    foundVia: found.via,
    autosuggestCallFired: Boolean(autosuggestCall),
    autosuggestStatus: autosuggestCall ? autosuggestCall.status : null
  };

  if (submit) {
    const beforeSubmit = run.recorder.all().length;
    await input.press('Enter').catch(() => {});
    await sleep(1200);
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const searchCall = await waitForUnbxdApi(run, ['search', 'category'], 8000, beforeSubmit);
    result.submitted = true;
    result.landedOn = page.url();
    result.searchCallFired = Boolean(searchCall);
    run.steps.push(`Pressed Enter → ${page.url()}`);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Triage                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {import('./browser.js').BrowserManager} manager
 * @param {{url?:string, complaint?:string, issue_type?:string, search_query?:string, device?:string, include_screenshot?:boolean}} args
 */
export async function runTriage(manager, args, { maxTokens = 16000 } = {}) {
  const { url, complaint = '', issue_type: requestedType = 'auto', search_query: searchQuery = null, device = 'desktop' } = args;

  let run;
  let nav = null;
  if (url) {
    run = await manager.newRun({ device });
    nav = await navigate(run, url);
    await waitOutChallenge(run);
  } else {
    run = manager.current();
  }
  const { page, session, recorder } = run;

  const wantsAutosuggest =
    requestedType === 'autosuggest_data' || requestedType === 'autosuggest_alignment' || (requestedType === 'auto' && AUTOSUGGEST_WORDS.test(complaint));

  // Let the page's own Unbxd activity land before judging it.
  if (url && !wantsAutosuggest) await waitForUnbxdApi(run, ['search', 'category'], 10000);

  let interaction = { typed: false, reason: 'No search interaction needed for this issue type.' };
  const hasResultsCall = recorder.all().some((r) => ['search', 'category'].includes(unbxdApiKind(r.rawUrl)));
  if (wantsAutosuggest) {
    interaction = await typeInSearchBox(run, searchQuery, { submit: false });
  } else if (searchQuery && !hasResultsCall) {
    // Not on a results page yet: search the way a shopper would.
    interaction = await typeInSearchBox(run, searchQuery, { submit: true });
  }

  // Captured now, while the reproduced state (e.g. an open dropdown) is on screen.
  let screenshot = null;
  if (args.include_screenshot !== false) {
    screenshot = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false }).catch(() => null);
  }

  const detection = requestedType === 'auto' ? await detectIssueType(session, recorder, complaint) : null;
  const typeId = detection ? detection.issueTypeId : getIssueType(requestedType).id;

  const strategyContext = await runStrategy(typeId, session, recorder, {
    description: complaint,
    reloaded: Boolean(run.navigated),
    inputSelector: interaction.typed ? interaction.selector : undefined
  });
  if (detection) strategyContext.detectedIssueType = detection;
  strategyContext.interaction = interaction;

  const inventory = await capturePageInventory(session, recorder);
  const css = await captureCssProvenance(session, cssTargetsFor(typeId, strategyContext), { pageUrl: page.url() });
  const ownership = classifyOwnership({ issueTypeId: typeId, context: strategyContext, inventory, css, interaction, navigation: nav });

  // Ownership first: it is what the answer is organised around, and the
  // budgeter shrinks long arrays, not leading keys.
  const context = {
    ownership,
    reproduction: { steps: [...run.steps], device, navigation: nav, interaction },
    ...strategyContext,
    pageInventory: inventory,
    cssProvenance: css
  };

  const prompt = await buildPrompt({
    issueTypeId: typeId,
    description: complaint,
    context,
    pageUrl: page.url(),
    maxTokens,
    outputContract: TRIAGE_OUTPUT_CONTRACT
  });

  run.lastTriage = {
    at: new Date().toISOString(),
    requestedUrl: url || null,
    pageUrl: page.url(),
    complaint,
    issueTypeId: typeId,
    device,
    context,
    knownIssues: prompt.knownIssues,
    browserVersion: manager.browser ? manager.browser.version() : null
  };

  return { text: formatBriefing(run.lastTriage, prompt), screenshot, lastTriage: run.lastTriage };
}

/* ------------------------------------------------------------------ */

function platformLine(inv) {
  if (!inv || !inv.platform) return 'unknown';
  const p = inv.platform;
  if (p.name === 'shopify') {
    const t = p.theme || {};
    return `Shopify${p.shop ? ` (${p.shop})` : ''}${t.name ? ` · theme "${t.name}"${t.schemaName ? ` (${t.schemaName}${t.schemaVersion ? ` ${t.schemaVersion}` : ''})` : ''}${t.role ? ` [${t.role}]` : ''}` : ''}`;
  }
  if (p.name === 'magento') return `Magento 2${p.theme ? ` · theme ${p.theme}` : ''}`;
  return p.name;
}

export function formatBriefing(last, prompt) {
  const c = last.context;
  const o = c.ownership;
  const first = c.selfDebug && c.selfDebug.summary && c.selfDebug.summary.firstFailure;
  const det = c.detectedIssueType;
  const siteKey = c.siteConfig?.consistency?.liveSiteKey || c.siteConfig?.consistency?.requestSiteKey || null;
  const blocked = o.owner === 'access_blocked';
  // On a blocked/error page every downstream finding was made on the wrong
  // document — don't surface them as leads.
  const known = !blocked && last.knownIssues && last.knownIssues.matches && last.knownIssues.matches[0];

  const head = [
    `# Unbxd UI triage — ${o.decision}`,
    '',
    blocked ? `> **The storefront was not reached.** ${o.evidence[0] ? o.evidence[0].detail : ''} Do not draw conclusions about the customer or Unbxd from this run.\n` : null,
    blocked ? null : `- **Owner:** ${o.ownerLabel} · **confidence ${o.confidence}**${o.runnerUp ? ` (runner-up: ${o.runnerUp.label}, score ${o.runnerUp.score} vs ${o.scores[o.owner] ?? 0})` : ''}`,
    blocked ? null : `- **Summary:** ${o.summary}`,
    `- **Page:** ${last.pageUrl} · ${last.device}`,
    `- **Platform:** ${platformLine(c.pageInventory)}${siteKey ? ` · site key \`${siteKey}\`` : ''}`,
    `- **Issue type:** ${getIssueType(last.issueTypeId).label}${det ? ` (auto-detected, ${det.confidence} confidence)` : ''}`,
    blocked ? null : first ? `- **First failing check:** \`${first.id}\` — ${first.detail}` : '- **First failing check:** none',
    known ? `- **Matches a known issue:** ${known.title}` : null,
    o.caveats.length ? `- **Caveats:** ${o.caveats.join(' ')}` : null,
    `- **Reproduction:** ${c.reproduction.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`,
    '',
    'Follow-up tools work on this same live page: get_request_detail, inspect_element, check_css_overrides, search_bundle, trace_rendered_value, screenshot, interact. Use draft_jira_ticket for a full evidence-backed ticket body.',
    '',
    '---',
    '',
    '## Instructions for the assistant',
    prompt.system,
    '',
    prompt.user
  ];
  return head.filter((l) => l !== null).join('\n');
}
