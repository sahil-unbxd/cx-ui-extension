/** One prompt template per issue type.
 *
 *  A template decides how the captured context is framed and what the model is
 *  told to look for. It must match the capture strategy for the same id: if the
 *  strategy does not capture DOM geometry, the template must not ask about it.
 */

const SHARED_OUTPUT_CONTRACT = `
Answer in this exact markdown structure, ready to paste into a ticket:

**Likely root cause**
One or two sentences. Name the specific request, element or field from the captured context that supports it.

**Evidence**
- 2 to 4 bullets, each quoting a concrete value from the captured context (status code, error text, computed property, field name, count).

**Recommended fix**
- Ordered, concrete steps. Say who does it (CX engineer / customer's dev team / Unbxd platform).

**Confidence**
high / medium / low — plus the single piece of evidence that would most change your answer if captured next.

Rules:
- The context is redacted on purpose: no response bodies, cookies or auth headers. If something you need is missing, say exactly what to capture next instead of guessing.
- Do not speculate beyond the evidence. If the capture window recorded nothing relevant, say so first.
- Be terse. A CX engineer is pasting this into a ticket.`;

// Prefixed to every template's focus: the captured context always includes
// this, regardless of issue type (see src/capture/sdk-assets.js). Checking it
// first can short-circuit an otherwise-plausible but wrong issue-specific story.
const SDK_CHECK_PREFIX = `Check context.sdkAssets first. If its verdict is "load_failed" or an expected asset (search.js/autosuggest.js/their CSS) is missing, that is very likely the actual root cause — say so before reasoning about the issue-specific symptom below, since a widget whose bundle never loaded can't have a "normal" version of this bug. `;

export const TEMPLATES = {
  proxy_access: {
    system: `You are a senior Unbxd CX support engineer triaging a suspected network access problem (proxy, VPN, firewall, geo-block or CORS) on a customer's site. You reason only from captured Chrome DevTools Protocol network data.`,
    contextLabel: 'Captured network context (failed/blocked requests tagged isUnbxd, error signatures, unbxdFailureScope, browser environment, sdkAssets)',
    focus: SDK_CHECK_PREFIX + `Distinguish between: (a) the engineer's own proxy/VPN/network blocking the request, (b) the customer's CDN/WAF blocking by geography, rate or bot score, (c) a genuine CORS misconfiguration on the Unbxd API side, and (d) an ordinary application error that merely looks like a block. Use unbxdFailureScope directly: "unbxd_only" points at (c) or a scoped block; "mixed" or everything failing points at (a) or (b). Every failed request is tagged isUnbxd — cite it as evidence.`,
    output: SHARED_OUTPUT_CONTRACT
  },

  autosuggest_alignment: {
    system: `You are a senior Unbxd CX support engineer diagnosing the on-screen position of an autosuggest dropdown relative to its anchor search input. You reason from CDP box models and computed styles — not from a screenshot.`,
    contextLabel: 'Captured layout context (box models, computed styles, clipping/stacking ancestors, viewport, sdkAssets)',
    focus: SDK_CHECK_PREFIX + `Otherwise, work from the geometry. Compare the dropdown's box with the input's box: the relativeOffset block gives dxLeft (horizontal drift), dyTopToInputBottom (vertical gap) and widthDelta. Then explain that offset using the computed styles and the ancestor chain — positioning context, transforms that re-root fixed positioning, overflow that clips, z-index inside a stacking context, box-sizing and width inheritance. Do not discuss the search/category/autosuggest API or result data; none was captured and none is relevant.`,
    output: SHARED_OUTPUT_CONTRACT
  },

  srp_ui: {
    system: `You are a senior Unbxd CX support engineer triaging a search results page rendering complaint. Your first job is to decide whether the Unbxd API (search or category) returned the wrong data or the UI rendered correct data wrongly.`,
    contextLabel: 'Captured search.unbxd.io "search"/"category" request context (URL, apiType, params, response counts and field shape — never the catalogue data itself) plus what the DOM actually rendered, and sdkAssets',
    focus: SDK_CHECK_PREFIX + `Otherwise, make the API-versus-UI call explicitly and early, using the numbers: responseSummary.numberOfProducts and returnedProductCount versus renderedPage.domProductNodeCounts. If the API returned products but the DOM shows none, it is a rendering/templating problem. If the API returned zero, look at the request params (q for search / p for category, filters, pagination start, the apiKey/siteKey path segments) for why. Also check for a redirect, didYouMean or an error field in the response, and whether the response parsed as JSON at all. searchRequest.apiType tells you whether this was a "search" or "category" call — the two have different param shapes, don't conflate them. Only search and category calls were captured; ignore any implication that other API traffic (autosuggest, analytics, recs) was considered. The response contains field names and counts only — reason about shape, never about specific product values.`,
    output: SHARED_OUTPUT_CONTRACT
  }
};

export function getTemplate(issueTypeId) {
  return TEMPLATES[issueTypeId] || TEMPLATES.srp_ui;
}
