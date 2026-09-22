# CX Debug Assistant

Chrome extension (MV3) for Unbxd CX engineers. Describe a site issue in the popup,
let the extension capture the relevant page context over CDP, and get a likely root
cause plus a recommended fix you can paste into a ticket.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this directory.
3. Open the popup → **Settings** tab → pick a provider (Claude by default) and paste
   your API key. Keys live in `chrome.storage.local` on this machine only.

## Use

1. Open the page you are debugging.
2. Popup → **Debug** tab → pick the issue type and describe the problem.
3. **Start capture** → reproduce the issue on the page (search, type in autosuggest,
   click a facet) → **Stop & analyse**.
4. Read the analysis, hit **Copy**, paste into the ticket. For SRP/PLP issues the
   answer also ends with a **Fix prompt** — its own copy button — written for an AI
   coding agent with the customer's integration repo open.

Chrome shows a "CX Debug Assistant started debugging this browser" banner while a
capture is running. That banner disappearing means the capture has ended.

## What leaves your browser

Redacted metadata only: request URLs with secret params stripped, a safe subset of
headers, status codes, console errors, and — per issue type — box models/computed
styles or search-response counts and field names. Never response bodies, cookies or
auth headers. See the Options page and `AGENTS.md` for the full boundary.

## Issue types

| Type | Captures |
|---|---|
| Proxy / VPN / access | failed + blocked requests, CORS/DNS/TLS/geo signatures, browser environment |
| Autosuggest alignment | box models and computed styles of the dropdown and its anchor input, clipping/stacking ancestors |
| SRP UI | the `search` API request params and response counts/shape, what the DOM rendered, plus a review of the site's `{siteKey}_search.js` / `_search.css` config bundle |
| PLP / category | the `category` API call, the page's URL/history state (dropped filters, back-button loop), plus the same config-bundle review |

Playbooks per type live in [SKILLS.md](SKILLS.md); the codebase guide for agents is
[AGENTS.md](AGENTS.md).
