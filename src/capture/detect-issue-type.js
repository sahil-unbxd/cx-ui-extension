/**
 * Works out which issue type a capture actually is.
 *
 * Support users don't think in "SRP UI" vs "PLP" vs "Autosuggest data" — they
 * think "prices look wrong" or "the dropdown is empty". Making them classify
 * correctly before the tool will help them is the wrong way round, and getting
 * it wrong silently runs the wrong capture strategy.
 *
 * This runs at *stop* time rather than start, which is possible because
 * network and console are recorded for every type and the type-specific work
 * (DOM geometry vs API vs config review) all happens after the recording
 * window closes. So the user can just describe the problem and press Start.
 *
 * It is a suggestion, not a silent switch: the chosen type and the reasoning
 * are reported in the capture, and an explicit pick always wins.
 */
import { unbxdApiKind } from '../shared/unbxd-endpoints.js';

/** Words that point at a symptom class, weighted below hard evidence. */
const DESCRIPTION_HINTS = [
  // Stems, not whole words: support writes "misaligned", "overlapping",
  // "clipped" — none of which match a \b-anchored "align"/"overlap"/"clip".
  { type: 'autosuggest_alignment', re: /(align|position|offset|overlap|clip|cut ?off|behind|z-?index|misplace|shift|too (wide|narrow)|off.?screen)/i, weight: 3 },
  { type: 'autosuggest_data', re: /\b(autosuggest|auto ?complete|type ?ahead|suggestion|popular product|top quer|keyword suggestion)\b/i, weight: 3 },
  { type: 'plp_ui', re: /\b(category|categories|plp|browse|collection page|listing page)\b/i, weight: 2 },
  { type: 'srp_ui', re: /\b(search result|srp|search page|query|searched for|no results|zero results)\b/i, weight: 2 },
  { type: 'srp_ui', re: /\b(price|label|badge|tile|image|swatch|rating|sort|facet|filter|pagination)\b/i, weight: 1 }
];

/**
 * @returns {{issueTypeId:string, confidence:'high'|'medium'|'low', reason:string, signals:object}}
 */
export async function detectIssueType(session, recorder, description = '') {
  const kinds = recorder.all().map((r) => unbxdApiKind(r.rawUrl)).filter(Boolean);
  const counts = {
    search: kinds.filter((k) => k === 'search').length,
    category: kinds.filter((k) => k === 'category').length,
    autosuggest: kinds.filter((k) => k === 'autosuggest').length
  };

  // Is an autosuggest dropdown actually on screen? That separates "the
  // dropdown is in the wrong place" from "the dropdown has the wrong data".
  const page = (await session.evaluate(`(() => {
    try {
      const sels = ['.unbxd-as-wrapper','.unbxd-as-maincontent','.unx-autosuggest-box','[class*="autosuggest" i]','[class*="autocomplete" i]','[role="listbox"]'];
      let el = null;
      for (const s of sels) { try { el = document.querySelector(s); } catch {} if (el) break; }
      return {
        dropdownPresent: Boolean(el),
        dropdownVisible: el ? (el.offsetWidth > 0 && el.offsetHeight > 0) : false,
        looksLikeCategory: /\\/(category|categories|collection|c\\/|shop)\\//i.test(location.pathname),
        looksLikeSearch: /search|catalogsearch|\\bq=/i.test(location.pathname + location.search)
      };
    } catch { return null; }
  })()`)) || {};

  const score = { srp_ui: 0, plp_ui: 0, autosuggest_data: 0, autosuggest_alignment: 0 };
  const reasons = [];

  // Evidence from the network is the strongest signal.
  if (counts.category > 0) {
    score.plp_ui += 5;
    reasons.push(`${counts.category} category API call(s) captured`);
  }
  if (counts.search > 0) {
    score.srp_ui += 5;
    reasons.push(`${counts.search} search API call(s) captured`);
  }
  if (counts.autosuggest > 0) {
    score.autosuggest_data += 4;
    score.autosuggest_alignment += 2;
    reasons.push(`${counts.autosuggest} autosuggest API call(s) captured`);
  }
  if (page.dropdownVisible) {
    score.autosuggest_alignment += 2;
    score.autosuggest_data += 1;
    reasons.push('an autosuggest dropdown is visible on the page');
  }
  if (page.looksLikeCategory) {
    score.plp_ui += 2;
    reasons.push('the URL looks like a category/browse page');
  }
  if (page.looksLikeSearch) {
    score.srp_ui += 2;
    reasons.push('the URL looks like a search results page');
  }

  for (const hint of DESCRIPTION_HINTS) {
    if (hint.re.test(description)) {
      score[hint.type] += hint.weight;
      reasons.push(`the description uses ${hint.type.replace(/_/g, ' ')} wording`);
    }
  }

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = ranked[0];
  const [, runnerUpScore] = ranked[1] || [null, 0];

  // Nothing to go on: fall back to the most common ticket type rather than
  // guessing something exotic, and be explicit that confidence is low.
  if (topScore === 0) {
    return {
      issueTypeId: 'srp_ui',
      confidence: 'low',
      reason: 'No API calls or page signals were captured, so the type could not be detected — defaulted to SRP. If that is wrong, pick the type explicitly and recapture.',
      signals: { counts, page }
    };
  }

  const margin = topScore - runnerUpScore;
  const confidence = margin >= 3 ? 'high' : margin >= 1 ? 'medium' : 'low';

  return {
    issueTypeId: topType,
    confidence,
    reason: `Detected as ${topType} because ${reasons.slice(0, 3).join('; ')}.${
      confidence === 'low' ? ' The runner-up scored nearly as high, so treat the classification as uncertain.' : ''
    }`,
    signals: { counts, page, scores: Object.fromEntries(ranked) }
  };
}
