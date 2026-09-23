/**
 * Matches a capture against `common-issues.md` — the team's log of patterns
 * from already-resolved tickets.
 *
 * This is the highest-leverage step for a support user: if the capture matches
 * a documented pattern, the answer is "apply the known fix", not "escalate to
 * engineering". The file is maintained after every resolved ticket.
 *
 * Matching is deterministic and runs before the model, for two reasons: it
 * costs nothing, and a known-pattern hit should not depend on whether the
 * model happened to recall it. Only the top matches are injected, not the
 * whole 23KB file.
 *
 * Bias: precision over recall. A wrong "this is a known issue" sends support
 * down a documented path that doesn't apply, which is worse than saying
 * nothing — so the score threshold is deliberately high and matching leans on
 * distinctive technical identifiers (`addToUrl`, `FIXED_PAGINATION`,
 * `'el' is not a valid DOM selector`) rather than ordinary prose overlap.
 */

let cache = null;

async function loadPatterns() {
  if (cache) return cache;
  const res = await fetch(chrome.runtime.getURL('common-issues.md'));
  cache = parsePatterns(await res.text());
  return cache;
}

/** Sections that document the format itself rather than a real pattern. */
const NON_PATTERN_HEADINGS = /^\[|^What it looked like|^Short descriptive title/i;

export function parsePatterns(markdown) {
  const patterns = [];
  let category = null;
  let current = null;

  const flush = () => {
    if (current && !NON_PATTERN_HEADINGS.test(current.title)) patterns.push(current);
    current = null;
  };

  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      flush();
      category = line.slice(3).trim();
      continue;
    }
    if (line.startsWith('### ')) {
      flush();
      current = { title: line.slice(4).trim(), category, body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  flush();

  return patterns.map((p) => ({
    ...p,
    body: p.body.trim(),
    symptoms: field(p.body, 'Symptoms'),
    rootCause: field(p.body, 'Root cause') || field(p.body, 'Root cause possibilities'),
    fix: field(p.body, 'Fix') || field(p.body, 'Fix options'),
    realCase: field(p.body, 'Real case'),
    terms: distinctiveTerms(`${p.title} ${p.body}`)
  }));
}

function field(body, label) {
  const re = new RegExp(`\\*\\*${label}[^*]*:?\\*\\*:?\\s*([\\s\\S]*?)(?=\\n\\*\\*|\\n---|$)`, 'i');
  const m = body.match(re);
  return m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 600) : null;
}

/**
 * The tokens worth matching on: code identifiers, config keys, error strings.
 * Ordinary English is dropped — "products not rendering" overlaps with nearly
 * every capture and would match everything.
 */
function distinctiveTerms(text) {
  const terms = new Set();
  // Backticked code spans, and quoted phrases (pattern titles quote the
  // literal console text, e.g. "el is not a valid DOM selector").
  for (const m of text.matchAll(/`([^`]{3,60})`/g)) terms.add(m[1]);
  for (const m of text.matchAll(/["“”]([^"“”\n]{6,60})["“”]/g)) terms.add(m[1]);
  // camelCase / snake_case / CONSTANT_CASE identifiers.
  for (const m of text.matchAll(/\b([a-z]+[A-Z]\w+|[A-Z]{2,}(?:_[A-Z]+)+|\w+_\w+)\b/g)) terms.add(m[1]);
  return [...terms].map(normalise).filter((t) => t.length >= 4 && !t.startsWith('http'));
}

/**
 * Punctuation is where literal matching breaks: the log line reads
 * `pagination: 'el' is not a valid DOM selector` while the pattern documents
 * it as `products.el is not a valid DOM selector`. Collapsing everything
 * non-alphanumeric to single spaces lets the distinctive middle of the phrase
 * match without inventing a fuzzy matcher.
 */
function normalise(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Builds the searchable text of a capture: what the user typed, what the
 * checks concluded, what the console said, and which config keys are live.
 */
function captureSignals(context, description) {
  const parts = [String(description || '')];
  const push = (v) => {
    if (typeof v === 'string') parts.push(v);
  };

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
  if (context?.searchRequest?.params) push(JSON.stringify(context.searchRequest.params).slice(0, 1500));
  if (context?.renderedPage) push(JSON.stringify(context.renderedPage).slice(0, 1000));

  return normalise(parts.join(' \n '));
}

const MIN_SCORE = 2;
const MAX_MATCHES = 3;

export async function matchKnownIssues(context, description) {
  let patterns;
  try {
    patterns = await loadPatterns();
  } catch {
    return null; // the file is optional — never break a capture over it
  }
  if (!patterns.length) return null;

  const haystack = captureSignals(context, description);
  if (!haystack.trim()) return null;

  const scored = patterns
    .map((p) => {
      const hits = p.terms.filter((t) => haystack.includes(t));
      // Distinct identifiers carry the signal; longer ones are more specific.
      const score = hits.reduce((n, t) => n + (t.length >= 10 ? 2 : 1), 0);
      return { pattern: p, hits, score };
    })
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES);

  if (!scored.length) return null;

  return {
    matches: scored.map(({ pattern, hits, score }) => ({
      title: pattern.title,
      category: pattern.category,
      score,
      matchedOn: hits.slice(0, 8),
      symptoms: pattern.symptoms,
      rootCause: pattern.rootCause,
      fix: pattern.fix,
      realCase: pattern.realCase
    })),
    note:
      'Matched from common-issues.md by shared technical identifiers, not by the model. A match means this shape of problem has been resolved before — confirm the symptoms genuinely line up with this capture before treating it as the answer, and say so if they do not.'
  };
}

/** Rendered into the prompt. Kept compact — it is paid for on every request. */
export function formatKnownIssues(known) {
  if (!known || !known.matches.length) return '';
  const lines = known.matches.map((m, i) => {
    const bits = [`${i + 1}. **${m.title}**${m.category ? ` _(${m.category})_` : ''} — matched on: ${m.matchedOn.join(', ')}`];
    if (m.symptoms) bits.push(`   - Symptoms: ${m.symptoms}`);
    if (m.rootCause) bits.push(`   - Root cause: ${m.rootCause}`);
    if (m.fix) bits.push(`   - Documented fix: ${m.fix}`);
    if (m.realCase) bits.push(`   - Previously seen as: ${m.realCase}`);
    return bits.join('\n');
  });
  return `These previously-resolved patterns from the team's common-issues log share technical identifiers with this capture:\n\n${lines.join('\n\n')}\n\n${known.note}`;
}
