/**
 * Canonical Unbxd endpoint/asset host+path patterns, shared by every capture
 * strategy. "Which network noise matters" is answered once here instead of
 * being re-guessed per issue type or per strategy.
 *
 * Reference shapes (2026-09, confirmed against live traffic):
 *   search      https://search.unbxd.io/{apiKey}/{siteKey}/search?q=...
 *   category    https://search.unbxd.io/{apiKey}/{siteKey}/category?p=...
 *   autosuggest https://search.unbxd.io/{apiKey}/{siteKey}/autosuggest?q=...
 *   SDK JS/CSS  https://libraries.unbxdapi.com/{siteKey}_search.js  (+ _autosuggest.js/.css)
 *               https://sandbox.unbxd.io/{siteKey}_search.js        (dev/sandbox variant)
 *               https://libraries.unbxdapi.com/search-sdk/{ver}/vanillaSearch.min.js (+ .css)
 */

const API_HOST = /(^|\.)search\.unbxd\.io$/i;
const API_PATH = /^\/[^/]+\/[^/]+\/(search|category|autosuggest)(?:\/|$)/i;

/** 'search' | 'category' | 'autosuggest' | null — the ONLY Unbxd API calls a
 *  capture strategy should ever forward. Analytics beacons, recommendation
 *  widgets, tracking pixels and everything else on *.unbxd.io are noise here. */
export function unbxdApiKind(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!API_HOST.test(u.hostname)) return null;
    const m = u.pathname.match(API_PATH);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

const ASSET_HOSTS = [/(^|\.)libraries\.unbxdapi\.com$/i, /(^|\.)sandbox\.unbxd\.io$/i];

/** 'search.js' | 'autosuggest.js' | 'search.css' | 'autosuggest.css'
 *  | 'sdk.js' | 'sdk.css' | null — the widget's own script/style bundles. */
export function unbxdAssetKind(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!ASSET_HOSTS.some((h) => h.test(u.hostname))) return null;
    const file = (u.pathname.split('/').pop() || '').toLowerCase();
    const isJs = /\.js(?:\?|$)/.test(file) || /\.js$/.test(u.pathname);
    const isCss = /\.css(?:\?|$)/.test(file) || /\.css$/.test(u.pathname);
    if (!isJs && !isCss) return null;
    if (file.includes('autosuggest')) return isJs ? 'autosuggest.js' : 'autosuggest.css';
    if (file.includes('search')) return isJs ? 'search.js' : 'search.css';
    // Unversioned/combined bundle (e.g. vanillaSearch.min.js) still counts —
    // 'search' happens to appear in "vanillaSearch" too via the checks above,
    // this branch only catches names that match neither substring.
    return isJs ? 'sdk.js' : 'sdk.css';
  } catch {
    return null;
  }
}

const UNBXD_HOST = /(^|\.)unbxd\.io$|(^|\.)unbxdapi\.com$/i;

/** True for any Unbxd-owned host (API, assets, or otherwise) — used by the
 *  proxy/access strategy to separate "just Unbxd is unreachable" from
 *  "everything on this page is unreachable". */
export function isUnbxdHost(rawUrl) {
  try {
    return UNBXD_HOST.test(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}
