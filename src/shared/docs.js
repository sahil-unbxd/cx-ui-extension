/**
 * How the prompt layer reads the team's markdown (SKILLS.md, common-issues.md,
 * the SDK references).
 *
 * In the extension those files ship inside the package and are fetched via
 * chrome.runtime.getURL. The MCP server (mcp/) runs the same prompt code under
 * Node, where there is no `chrome` and fetch() cannot read file:// URLs, so it
 * installs its own loader with setDocLoader(). One loader, swapped at startup —
 * not a second copy of the matching/retrieval logic.
 */

let loader = async (name) => {
  const res = await fetch(chrome.runtime.getURL(name));
  return res.text();
};

/** @param {(name: string) => Promise<string>} fn */
export function setDocLoader(fn) {
  loader = fn;
}

/** @param {string} name  repo-relative file name, e.g. "SKILLS.md" */
export function loadDoc(name) {
  return loader(name);
}
