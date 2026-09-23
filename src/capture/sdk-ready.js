/**
 * Waits for the Unbxd SDK to finish initialising before anything probes it.
 *
 * Why this exists: customer bundles initialise on timers, not synchronously.
 * The Lindt Canada bundle builds its config in `window.createSearchConfig()`,
 * constructs instances inside a `setTimeout(…, 100)` after
 * `createRequiredDOMElements()`, and wires tab listeners in a
 * `setTimeout(…, 1000)`. A single probe fired right after the search response
 * lands can easily run before `window.unbxdSearch` is assigned, and the
 * extension then reports "SDK never initialised" — a false negative that
 * poisons the whole self-debug chain, because `sdk_initialised` is an upstream
 * check and everything after it reads as its consequence.
 *
 * Two rules this encodes, both learned from real shipped bundles:
 *   - `window.UnbxdSearch` (the constructor) is NOT a reliable signal. Customer
 *     bundles keep it module-scoped: it appears zero times on `window` in the
 *     Lindt bundles while instances are very much alive. Look for *instances*.
 *   - Instances may live only under `window.unbxdSearchInstances` (keyed per
 *     tab: products/recipes/other), with `window.unbxdSearch` pointing at
 *     whichever tab is current — and that pointer is reassigned on tab switch.
 */

const DEFAULT_TIMEOUT_MS = 3000;
const POLL_MS = 250;

/** Kept tiny on purpose: it runs repeatedly. */
const PROBE = `(() => {
  try {
    const named = (window.unbxdSearchInstances && typeof window.unbxdSearchInstances === 'object')
      ? Object.keys(window.unbxdSearchInstances)
      : [];
    const direct = Boolean(window.unbxdSearch && window.unbxdSearch.options);
    const anyNamed = named.some((k) => {
      const i = window.unbxdSearchInstances[k];
      return Boolean(i && i.options);
    });
    return { ok: true, ready: direct || anyNamed, direct, namedKeys: named };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
  }
})()`;

/**
 * Polls until an initialised instance appears or the deadline passes.
 *
 * @returns {{ready:boolean, probeFailed:boolean, waitedMs:number, namedKeys:string[], reason?:string}}
 *   `probeFailed` means we could not evaluate in the page at all — that is NOT
 *   the same as "the SDK is absent", and callers must not report it as such.
 */
export async function waitForSdkReady(session, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  let last = null;

  while (Date.now() - startedAt < timeoutMs) {
    const res = await session.evaluate(PROBE);
    last = res;
    if (res && res.ok && res.ready) {
      return { ready: true, probeFailed: false, waitedMs: Date.now() - startedAt, namedKeys: res.namedKeys || [] };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (!last || last.ok !== true) {
    return {
      ready: false,
      probeFailed: true,
      waitedMs: Date.now() - startedAt,
      namedKeys: [],
      reason: last && last.error
        ? `Page evaluation failed: ${last.error}`
        : 'Could not evaluate in the page (no result from Runtime.evaluate). This says nothing about whether the SDK initialised.'
    };
  }

  return {
    ready: false,
    probeFailed: false,
    waitedMs: Date.now() - startedAt,
    namedKeys: last.namedKeys || [],
    reason: `No initialised instance after ${Math.round(timeoutMs / 1000)}s (checked window.unbxdSearch and window.unbxdSearchInstances).`
  };
}
