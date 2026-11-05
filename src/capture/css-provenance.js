/**
 * "Whose CSS is this?" for the Unbxd widget's own elements.
 *
 * A grid that renders but is invisible, a dropdown pushed off its input, tiles
 * squashed into one column — the computed style says *what* happened, but
 * support needs *who did it*: the Unbxd stylesheet, or a rule in the customer's
 * theme that out-specifies it. This reads the matched cascade over CDP
 * (CSS.getMatchedStylesForNode), picks the winning declaration for a small set
 * of layout/visibility properties, and attributes each winner to the stylesheet
 * URL it came from (see classifyAssetOrigin in page-inventory.js).
 *
 * The cascade model is deliberately simple — rules in matched order, !important
 * beats normal, the style attribute beats rules — which is what decides the
 * cases that come up in practice. Cascade layers and @scope are not modelled;
 * the `note` in the output says so rather than overclaiming.
 *
 * Privacy: selectors, property names/values and stylesheet URLs only.
 */
import { classifyAssetOrigin } from './page-inventory.js';
import { redactUrl, truncate } from './redact.js';

/** Properties that can hide, displace or clip a widget element. */
export const WATCHED_PROPERTIES = [
  'display', 'visibility', 'opacity', 'position', 'top', 'left', 'right', 'bottom',
  'width', 'min-width', 'max-width', 'height', 'max-height', 'overflow-x', 'overflow-y',
  'z-index', 'transform', 'float', 'clip-path', 'pointer-events'
];

/** Does this winning declaration make the element invisible on its own? */
export function hidesElement(property, value) {
  const v = String(value || '').trim().toLowerCase();
  if (property === 'display') return v === 'none';
  if (property === 'visibility') return v === 'hidden' || v === 'collapse';
  if (property === 'opacity') return Number.parseFloat(v) === 0;
  if (property === 'height' || property === 'max-height') return /^0(px|em|rem|%)?$/.test(v);
  if (property === 'clip-path') return /inset\(\s*(50|100)%/.test(v);
  return false;
}

/**
 * Pure: given CDP's getMatchedStylesForNode result, the winning declaration
 * per watched property and every declaration that lost to it.
 *
 * @param {object} matched  CSS.getMatchedStylesForNode result
 * @returns {Record<string, {winner: object, declared: object[]}>}
 */
export function resolveCascade(matched) {
  const out = {};
  const consider = (name, decl) => {
    if (!WATCHED_PROPERTIES.includes(name)) return;
    // CDP reports an important declaration's value as "none !important"
    // (as well as important:true). Keep the bare value so comparisons work.
    decl.value = String(decl.value).replace(/\s*!\s*important\s*$/i, '');
    const slot = (out[name] ||= { winner: null, declared: [] });
    slot.declared.push(decl);
    // Later in matched order wins at equal importance; !important beats normal.
    if (!slot.winner || decl.important || !slot.winner.important) slot.winner = decl;
  };

  for (const match of (matched && matched.matchedCSSRules) || []) {
    const rule = match.rule || {};
    const selector = (rule.selectorList && rule.selectorList.text) || null;
    for (const p of (rule.style && rule.style.cssProperties) || []) {
      if (p.disabled || p.parsedOk === false || !p.value) continue;
      consider(p.name, {
        value: p.value,
        important: Boolean(p.important),
        kind: rule.origin === 'user-agent' ? 'user-agent' : 'rule',
        styleSheetId: rule.styleSheetId || null,
        selector
      });
    }
  }
  const inline = matched && matched.inlineStyle;
  for (const p of (inline && inline.cssProperties) || []) {
    if (p.disabled || p.parsedOk === false || !p.value) continue;
    consider(p.name, { value: p.value, important: Boolean(p.important), kind: 'style-attribute', styleSheetId: null, selector: null });
  }
  return out;
}

/** Attributes one declaration to an owner via its stylesheet header. */
export function attributeDeclaration(decl, sheets, pageUrl) {
  if (!decl) return null;
  if (decl.kind === 'user-agent') return { owner: 'browser_default', source: 'user-agent' };
  if (decl.kind === 'style-attribute') {
    // Set by JavaScript or by the markup. The autosuggest SDK positions its
    // dropdown this way, so this is never evidence against the customer alone.
    return { owner: 'unknown', source: 'style-attribute', detail: 'inline style="" — set by markup or by a script (the Unbxd autosuggest SDK positions its dropdown this way)' };
  }
  const header = sheets.get(decl.styleSheetId);
  if (!header) return { owner: 'unknown', source: 'unknown-stylesheet' };
  if (header.isConstructed) return { owner: 'unknown', source: 'constructed-stylesheet', detail: 'created from JavaScript' };
  if (header.isInline || !header.sourceURL || header.sourceURL === pageUrl) {
    // A <style> block in the page HTML: the customer's markup (themes inline
    // critical CSS). Overrides written there are still the customer's rules.
    return { owner: 'customer', source: 'inline-style-tag', sheet: 'inline <style> in the page HTML' };
  }
  const o = classifyAssetOrigin(header.sourceURL, pageUrl);
  return { ...o, sheet: redactUrl(header.sourceURL) };
}

/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectStyleSheets(session) {
  const sheets = new Map();
  const off = session.on((method, params) => {
    if (method === 'CSS.styleSheetAdded' && params && params.header) sheets.set(params.header.styleSheetId, params.header);
  });
  await session.trySend('DOM.enable');
  // Re-enabling makes Chrome replay styleSheetAdded for every existing sheet,
  // even if another strategy already enabled the CSS domain.
  await session.trySend('CSS.disable');
  await session.trySend('CSS.enable');
  await sleep(200);
  off();
  return sheets;
}

async function nodeIdFor(session, expression) {
  const res = await session.trySend('Runtime.evaluate', { expression, returnByValue: false });
  const obj = res && res.result;
  if (!obj || res.__error || obj.subtype !== 'node' || !obj.objectId) return null;
  const req = await session.trySend('DOM.requestNode', { objectId: obj.objectId });
  session.trySend('Runtime.releaseObject', { objectId: obj.objectId });
  return req && !req.__error ? req.nodeId : null;
}

/**
 * @param {object} session  CdpSession-compatible
 * @param {Array<{label:string, expression:string, expectVisible?:boolean, role?:string}>} targets
 *   expression must evaluate to an Element (or null).
 */
export async function captureCssProvenance(session, targets, { pageUrl } = {}) {
  if (!targets || !targets.length) return { elements: [], note: 'No widget elements to inspect.' };
  const sheets = await collectStyleSheets(session);
  // DOM.requestNode needs the document to have been requested first.
  await session.trySend('DOM.getDocument', { depth: 0 });
  const href = pageUrl || (await session.evaluate('location.href'));

  const elements = [];
  for (const t of targets.slice(0, 8)) {
    const nodeId = await nodeIdFor(session, t.expression);
    if (!nodeId) {
      elements.push({ label: t.label, role: t.role || 'element', found: false });
      continue;
    }
    const matched = await session.trySend('CSS.getMatchedStylesForNode', { nodeId });
    const computedRes = await session.trySend('CSS.getComputedStyleForNode', { nodeId });
    if (matched.__error) {
      elements.push({ label: t.label, role: t.role || 'element', found: true, error: matched.__error });
      continue;
    }
    const computed = {};
    for (const p of (computedRes && computedRes.computedStyle) || []) {
      if (WATCHED_PROPERTIES.includes(p.name)) computed[p.name] = p.value;
    }

    const cascade = resolveCascade(matched);
    let hiddenBy = null;
    const overrides = [];
    const nonUnbxdLayoutWinners = [];
    for (const [property, { winner, declared }] of Object.entries(cascade)) {
      const who = attributeDeclaration(winner, sheets, href);
      const winnerInfo = { property, value: truncate(winner.value, 80), important: winner.important, selector: truncate(winner.selector, 140), ...who };

      if (!hiddenBy && hidesElement(property, winner.value) && hidesElement(property, computed[property] ?? winner.value)) {
        hiddenBy = winnerInfo;
      }
      if (who && who.owner !== 'unbxd' && who.owner !== 'browser_default') {
        // Did an Unbxd stylesheet declare this property and lose?
        const unbxdLoser = declared.find((d) => d !== winner && (attributeDeclaration(d, sheets, href) || {}).owner === 'unbxd' && d.value !== winner.value);
        if (unbxdLoser) {
          overrides.push({
            property,
            unbxdValue: truncate(unbxdLoser.value, 80),
            unbxdSelector: truncate(unbxdLoser.selector, 140),
            winningValue: winnerInfo.value,
            winnerOwner: who.owner,
            winnerSource: who.source,
            winnerSheet: who.sheet || who.detail || null,
            winnerSelector: winnerInfo.selector,
            winnerImportant: winner.important
          });
        } else if (who.owner === 'customer' && nonUnbxdLayoutWinners.length < 8) {
          nonUnbxdLayoutWinners.push(winnerInfo);
        }
      }
    }

    const cs = computed;
    elements.push({
      label: t.label,
      role: t.role || 'element',
      expectVisible: Boolean(t.expectVisible),
      found: true,
      computed: pick(cs, ['display', 'visibility', 'opacity', 'position', 'width', 'height', 'overflow-x', 'overflow-y', 'z-index', 'transform']),
      hidden: hidesElement('display', cs.display) || hidesElement('visibility', cs.visibility) || hidesElement('opacity', cs.opacity),
      hiddenBy,
      overrides: overrides.slice(0, 8),
      customerLayoutRules: nonUnbxdLayoutWinners
    });
  }

  const sheetOwners = {};
  for (const h of sheets.values()) {
    const owner = h.isInline ? 'customer' : h.isConstructed ? 'unknown' : classifyAssetOrigin(h.sourceURL, href).owner;
    sheetOwners[owner] = (sheetOwners[owner] || 0) + 1;
  }

  return {
    elements,
    stylesheetsByOwner: sheetOwners,
    note:
      'overrides = an Unbxd stylesheet declared the property but a non-Unbxd rule won the cascade (the customer CSS to change, with its selector and file). hiddenBy = the declaration that makes the element invisible. Cascade is modelled as matched order + !important + style attribute; @layer/@scope are not modelled, so confirm a surprising result with inspect_element.'
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/* ------------------------------------------------------------------ */
/* Which elements to inspect, per issue type                            */
/* ------------------------------------------------------------------ */

const AUTOSUGGEST_DROPDOWNS = [
  '.unbxd-as-wrapper', '.unbxd-as-maincontent', '.unbxd-autosuggest', '[class*="autosuggest" i]', '[class*="autocomplete" i]', '[role="listbox"]'
];

const firstOf = (selectors) =>
  `(() => { for (const s of ${JSON.stringify(selectors)}) { try { const el = document.querySelector(s); if (el) return el; } catch {} } return null; })()`;

/** Nearest ancestors that clip (overflow) or re-root positioning (transform). */
export const clippingAncestor = (baseExpr, nth) => `(() => {
  let el = ${baseExpr};
  let found = 0;
  while (el && (el = el.parentElement)) {
    const cs = getComputedStyle(el);
    const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    const reroots = cs.transform !== 'none' || cs.filter !== 'none' || cs.contain !== 'none';
    if (clips || reroots) { if (found === ${nth}) return el; found += 1; }
    if (el === document.body) break;
  }
  return null;
})()`;

/**
 * Builds the element list from what the capture already resolved (live config
 * selectors, the alignment strategy's chosen selectors), so the inspected
 * elements are the widget's real containers rather than guesses.
 */
export function cssTargetsFor(issueTypeId, context = {}) {
  const targets = [];
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;

  if (issueTypeId === 'autosuggest_alignment' || issueTypeId === 'autosuggest_data') {
    const used = context.selectorsUsed || {};
    const dropdown = used.dropdown ? q(used.dropdown) : firstOf(AUTOSUGGEST_DROPDOWNS);
    const typedAndReturned = Boolean(context.interaction && context.interaction.typed);
    targets.push({ label: `autosuggest dropdown${used.dropdown ? ` (${used.dropdown})` : ''}`, expression: dropdown, expectVisible: typedAndReturned, role: 'dropdown' });
    const input = used.input || (context.interaction && context.interaction.selector) || null;
    if (input) targets.push({ label: `search input (${input})`, expression: q(input), expectVisible: true, role: 'input' });
    for (let i = 0; i < 3; i += 1) {
      targets.push({ label: `dropdown clipping/positioning ancestor #${i + 1}`, expression: clippingAncestor(dropdown, i), role: 'ancestor' });
    }
    return targets;
  }

  // Results pages: the config's own containers, products first.
  const checks = (context.siteConfig && context.siteConfig.liveConfig && context.siteConfig.liveConfig.selectorChecks) || [];
  const resolved = checks.filter((c) => c.matchCount > 0 && typeof c.selector === 'string' && !c.selector.startsWith('['));
  const rank = (p) => (/^products\./.test(p) ? 0 : /facet/i.test(p) ? 1 : /pagination|sort|pagesize/i.test(p) ? 2 : 3);
  resolved.sort((a, b) => rank(a.configPath) - rank(b.configPath));

  const returned = (context.responseSummary && context.responseSummary.returnedProductCount) || 0;
  const productsCheck = resolved.find((c) => /^products\.el$/.test(c.configPath)) || resolved.find((c) => /^products\./.test(c.configPath));
  if (productsCheck) {
    const container = q(productsCheck.selector);
    targets.push({ label: `results container (${productsCheck.configPath} → ${productsCheck.selector})`, expression: container, expectVisible: returned > 0, role: 'container' });
    targets.push({
      label: 'first product tile',
      expression: `(() => { const c = ${container}; if (!c) return null; return c.querySelector('[class*="product" i], [data-product-id], [class*="UNX" i], li') || c.firstElementChild; })()`,
      expectVisible: returned > 0,
      role: 'tile'
    });
    targets.push({ label: 'results container clipping ancestor', expression: clippingAncestor(container, 0), role: 'ancestor' });
  }
  for (const c of resolved.filter((r) => r !== productsCheck).slice(0, 3)) {
    targets.push({ label: `${c.configPath} → ${c.selector}`, expression: q(c.selector), expectVisible: false, role: 'container' });
  }
  if (!targets.length) {
    targets.push({ label: 'Unbxd results root (heuristic)', expression: firstOf(['#unbxd_main', '[id*="unbxd" i]', '[class*="unbxd" i]', '[class*="UNX" i]']), expectVisible: returned > 0, role: 'container' });
  }
  return targets;
}
