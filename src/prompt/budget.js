/** Token budgeting.
 *
 *  Budgeting is about cost and latency. It is NOT what keeps secrets out of the
 *  prompt — src/capture/redact.js does that, before anything reaches here.
 */

/** Cheap heuristic; good enough to keep a prompt inside a budget. */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 3.6);
}

/**
 * Serialise a context object to JSON that fits `maxTokens`, shrinking in
 * defined steps rather than blindly cutting the tail (which would produce
 * invalid JSON and hide the most recent — most relevant — events).
 */
export function fitJson(context, maxTokens) {
  const attempts = [
    { arrayLimit: Infinity, stringLimit: Infinity },
    { arrayLimit: 12, stringLimit: 400 },
    { arrayLimit: 6, stringLimit: 200 },
    { arrayLimit: 3, stringLimit: 120 },
    { arrayLimit: 1, stringLimit: 80 }
  ];

  let last = '';
  for (const opts of attempts) {
    last = JSON.stringify(shrink(context, opts), null, 1);
    if (estimateTokens(last) <= maxTokens) {
      return { json: last, truncated: opts.arrayLimit !== Infinity, tokens: estimateTokens(last) };
    }
  }
  // Hard stop: keep valid-looking JSON and say plainly that it was cut.
  const hardLimit = Math.floor(maxTokens * 3.6);
  return {
    json: `${last.slice(0, hardLimit)}\n… [context truncated to fit the token budget]`,
    truncated: true,
    tokens: maxTokens
  };
}

function shrink(value, opts) {
  const { arrayLimit, stringLimit } = opts;
  if (Array.isArray(value)) {
    const kept = value.slice(0, arrayLimit === Infinity ? value.length : arrayLimit).map((v) => shrink(v, opts));
    const dropped = value.length - kept.length;
    if (dropped > 0) kept.push(`… ${dropped} more omitted`);
    return kept;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const shrunk = shrink(v, opts);
      // Drop empties: they cost tokens and tell the model nothing.
      if (shrunk === null || shrunk === '' || (Array.isArray(shrunk) && !shrunk.length)) continue;
      out[k] = shrunk;
    }
    return out;
  }
  if (typeof value === 'string' && stringLimit !== Infinity && value.length > stringLimit) {
    return `${value.slice(0, stringLimit)}…`;
  }
  return value;
}
