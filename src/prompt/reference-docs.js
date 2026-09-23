/**
 * Selective retrieval over the team's reference docs.
 *
 * The repo ships ~140KB of authoritative material — the SDK config reference,
 * the internal architecture/debugging guide, and the autosuggest SDK
 * reference. That is roughly 35k tokens: far too much to inject, and none of
 * it was reaching the model. Retrieval fixes both halves of that: the answer
 * gets grounded in documented behaviour instead of recalled behaviour, and the
 * prompt only pays for the handful of sections that match the capture.
 *
 * Same discipline as known-issues.js: score on distinctive technical
 * identifiers rather than prose, bias toward precision, and attribute every
 * excerpt to its source file and heading so a reader can check it.
 *
 * `common-issues.md` is deliberately NOT here — it is matched separately by
 * known-issues.js, because a previously-resolved ticket is a different kind of
 * evidence (it short-circuits escalation) from a config reference.
 */

const DOCS = [
  {
    file: 'AUTOSUGGEST_SDK_REFERENCE.md',
    label: 'Autosuggest SDK reference',
    // Only worth retrieving when the capture is actually about autosuggest.
    appliesTo: ['autosuggest_data', 'autosuggest_alignment']
  },
  {
    file: 'unbxd-search-sdk-doc.md',
    label: 'Search SDK configuration reference',
    appliesTo: ['srp_ui', 'plp_ui']
  },
  {
    file: 'INTERNAL_ARCHITECTURE_AND_DEBUGGING_GUIDE.md',
    label: 'Search SDK internal architecture & debugging guide',
    appliesTo: ['srp_ui', 'plp_ui', 'autosuggest_data', 'autosuggest_alignment']
  }
];

const MAX_SECTIONS = 3;
const MAX_SECTION_CHARS = 1100;
const MIN_SCORE = 3;

const cache = new Map();

async function loadSections(doc) {
  if (cache.has(doc.file)) return cache.get(doc.file);
  let text = '';
  try {
    const res = await fetch(chrome.runtime.getURL(doc.file));
    text = await res.text();
  } catch {
    cache.set(doc.file, []);
    return [];
  }
  const sections = splitSections(text).map((s) => ({ ...s, terms: distinctiveTerms(`${s.title}\n${s.body}`) }));
  cache.set(doc.file, sections);
  return sections;
}

/** Splits on `##`/`###` headings, skipping navigation-only sections. */
export function splitSections(markdown) {
  const out = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.*)$/);
    if (m) {
      if (current) out.push(current);
      current = { title: m[2].trim(), body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) out.push(current);
  return out
    .filter((s) => !/^table of contents$/i.test(s.title))
    .map((s) => ({ ...s, body: s.body.trim() }))
    .filter((s) => s.body.length > 80);
}

function normalise(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Config keys, code spans and identifiers — the things a capture can match. */
function distinctiveTerms(text) {
  const terms = new Set();
  for (const m of text.matchAll(/`([^`\n]{3,50})`/g)) terms.add(m[1]);
  for (const m of text.matchAll(/\b([a-z]+[A-Z]\w+|[A-Z]{2,}(?:_[A-Z]+)+|\w+_\w+)\b/g)) terms.add(m[1]);
  return [...new Set([...terms].map(normalise))].filter((t) => t.length >= 4 && !t.startsWith('http'));
}

/**
 * The capture, flattened to searchable text. Weighted toward what actually
 * discriminates: failing checks and live config keys, not the whole payload.
 */
function captureSignals(context, description) {
  const parts = [String(description || '')];
  const push = (v) => typeof v === 'string' && parts.push(v);

  const sd = context && context.selfDebug;
  for (const c of (sd && sd.checks) || []) {
    if (c.status === 'fail' || c.status === 'warn') {
      push(c.id);
      push(c.detail);
    }
  }
  for (const e of (context && context.consoleErrors) || []) push(e.text);

  const options = context?.siteConfig?.liveConfig?.options;
  if (options) push(JSON.stringify(options).slice(0, 4000));
  const asState = context?.selfDebug?.sdkState;
  if (asState) push(JSON.stringify(asState).slice(0, 1500));
  if (context?.searchRequest?.params) push(JSON.stringify(context.searchRequest.params).slice(0, 1200));
  if (context?.autosuggestRequest?.params) push(JSON.stringify(context.autosuggestRequest.params).slice(0, 1200));

  return normalise(parts.join(' \n '));
}

/**
 * @returns {{excerpts: Array<{source:string,title:string,body:string,score:number}>}|null}
 */
export async function retrieveReference(context, description, issueTypeId) {
  const haystack = captureSignals(context, description);
  if (!haystack.trim()) return null;

  const scored = [];
  for (const doc of DOCS) {
    if (issueTypeId && doc.appliesTo && !doc.appliesTo.includes(issueTypeId)) continue;
    for (const section of await loadSections(doc)) {
      const hits = section.terms.filter((t) => haystack.includes(t));
      if (!hits.length) continue;
      // Long identifiers are far more discriminating than short ones.
      const score = hits.reduce((n, t) => n + (t.length >= 12 ? 3 : t.length >= 8 ? 2 : 1), 0);
      if (score < MIN_SCORE) continue;
      scored.push({ source: doc.label, file: doc.file, title: section.title, body: section.body, score, matchedOn: hits.slice(0, 6) });
    }
  }

  if (!scored.length) return null;

  // One excerpt per heading, best first, and never more than a few — this is
  // retrieval to ground an answer, not a documentation dump.
  const excerpts = scored
    .sort((a, b) => b.score - a.score)
    .filter((s, i, arr) => arr.findIndex((o) => o.title === s.title && o.file === s.file) === i)
    .slice(0, MAX_SECTIONS)
    .map((s) => ({ ...s, body: s.body.length > MAX_SECTION_CHARS ? `${s.body.slice(0, MAX_SECTION_CHARS)}\n…[truncated]` : s.body }));

  return { excerpts };
}

/** Rendered into the prompt, with attribution so claims can be checked. */
export function formatReference(reference) {
  if (!reference || !reference.excerpts.length) return '';
  const blocks = reference.excerpts.map(
    (e) => `**${e.title}** — _${e.source}_ (matched on: ${e.matchedOn.join(', ')})\n\n${e.body}`
  );
  return `Documented SDK behaviour relevant to this capture, retrieved from the team's reference docs. This is authoritative — prefer it over recalled behaviour, and cite the heading when you rely on it. If the capture contradicts the documentation, say so explicitly rather than quietly siding with one.\n\n${blocks.join('\n\n---\n\n')}`;
}
