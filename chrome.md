# Playwright vs Chrome Extension: Site Analyzer Technology Choice

## Context

For the Semi-Auto Config Generator, we need a browser-based tool that can:

1. Navigate to a customer's website (search/category pages)
2. Analyze the DOM structure to detect elements (search box, product grid, facets, pagination, sort, etc.)
3. Run analysis at **two viewport widths** (desktop 1440px + mobile 375px) to detect responsive layout differences
4. Take screenshots of specific areas for visual context
5. Present findings to the integration engineer for **element-by-element interactive confirmation**
6. Integrate with the Cursor agent skill that orchestrates the full config generation workflow
7. Integrate with Grunt tasks for the automated analysis path

We evaluated two approaches: **Playwright** (via Cursor's built-in browser tools) and a **custom Chrome Extension** (Manifest V3).

---

## Capability Comparison

### 1. Navigate to Customer URL

- **Playwright**: `browser_navigate(url)` -- one call, trivial.
- **Chrome Extension**: `chrome.tabs.create({ url })` -- also trivial.
- **Verdict**: Tie.

### 2. Execute JavaScript in Page Context (Heuristic Detection)

Both approaches can run arbitrary JS in the page to detect elements, extract selectors, check for platform indicators (`Shopify.theme`, Magento body classes, etc.).

- **Playwright**: `browser_evaluate({ function: '...' })` -- equivalent to `page.evaluate()`.
- **Chrome Extension**: Content scripts or `chrome.scripting.executeScript()`.
- **Verdict**: Tie.

### 3. Multi-Viewport Analysis (Desktop + Mobile)

This is critical -- we need to resize the viewport and re-run all heuristics to detect elements that move or disappear on mobile (e.g., facets moving into a drawer, sort dropdown hidden on mobile).

- **Playwright**: `browser_resize({ width: 375, height: 812 })` -- one API call, viewport changes immediately, CSS media queries re-evaluate, DOM re-renders. Works flawlessly.
- **Chrome Extension**: `window.resizeTo()` is restricted in Chrome (can't resize below minimum, doesn't work on non-popup windows). The alternative is `chrome.debugger.sendCommand('Emulation.setDeviceMetricsOverride', ...)` which requires the `debugger` permission (shows a scary warning bar to users: "This extension is debugging this browser") and is unreliable across Chrome versions. CSS viewport override injection is another option but doesn't trigger real responsive layout.
- **Verdict**: **Playwright wins decisively.** Multi-viewport analysis is a core requirement and Chrome Extension makes it unreliable and complex.

### 4. Screenshots

- **Playwright**: `browser_take_screenshot()` -- supports full-page screenshots and element-level screenshots. Trivial.
- **Chrome Extension**: `chrome.tabs.captureVisibleTab()` captures only the visible viewport. Full-page screenshots require scrolling + stitching. Element-specific screenshots need canvas workarounds.
- **Verdict**: **Playwright wins.** More capable, less code.

### 5. DOM / Accessibility Tree Access

- **Playwright**: `browser_snapshot()` returns the full accessibility tree (the same tree assistive technologies see). This is particularly useful for identifying interactive elements (buttons, inputs, links, checkboxes) which maps directly to what we need to detect (search inputs, filter checkboxes, pagination links, sort dropdowns). `browser_evaluate()` also provides raw DOM access.
- **Chrome Extension**: Content scripts have full DOM access. No built-in accessibility tree API -- you'd need to build your own traversal logic.
- **Verdict**: **Playwright wins.** The accessibility tree snapshot is more useful for our heuristic detection than raw DOM alone.

### 6. Interactive Confirmation with the User (THE Critical Differentiator)

Our workflow requires presenting each detected/missing element to the integration engineer and asking them to accept, provide a custom selector, mark as existing, or skip. This happens for ~16 elements, potentially with desktop/mobile variants.

- **Playwright (via Cursor)**: The Cursor agent browses the site, detects elements, then **in the same chat conversation** asks:
  ```
  MISSING ELEMENT: Sort Wrapper (sort.el)
    Desktop: Create <div class="unbxd-sort-wrapper"> inserted after ".filter-form-content"
    Mobile:  Create <div class="unbxd-sort-wrapper"> appended to ".mobile-filter-drawer"

    [1] Accept both placements
    [2] Provide different placement
    [3] Already exists (give selector)
    [4] Skip
  ```
  The user replies in chat. The agent processes the response and moves to the next element. **One tool, one conversation, seamless.**

- **Chrome Extension**: You'd need to build a **separate UI** -- a popup, side panel, or full-page tab -- for the interactive confirmation loop. The user would have to:
  1. Open Chrome
  2. Click the extension icon
  3. Step through each element in the extension UI
  4. Switch back to Cursor for config generation

  The Cursor agent **cannot call Chrome extension APIs directly**. You'd need to build a communication bridge (WebSocket server, Native Messaging host, or file-based handoff) to pass the confirmed analysis back to Cursor. This adds substantial complexity and fragility.

- **Verdict**: **Playwright wins decisively.** The extension approach would split the workflow into two disconnected tools and require significant bridge engineering.

### 7. Cursor Agent Skill Integration (Layer 3)

- **Playwright**: **Native.** Cursor's agent tools (`browser_navigate`, `browser_snapshot`, `browser_evaluate`, `browser_resize`, `browser_take_screenshot`) ARE Playwright under the hood. The skill file calls them directly with zero glue code.
- **Chrome Extension**: The Cursor agent has no way to invoke extension APIs. You'd need to build one of:
  - A WebSocket server that the extension connects to and the agent calls via HTTP
  - A Native Messaging host that bridges extension <-> local process <-> file
  - The extension writes a `site-analysis.json` to disk and the agent reads it (loses interactivity)
  All options add complexity, latency, and failure points.
- **Verdict**: **Playwright wins decisively.**

### 8. Grunt Task Integration (Layer 1 Automated Path)

- **Playwright**: `lib/siteAnalyzer.js` uses the `playwright` npm package directly. `grunt analyze --url=... --customer=...` spawns the script. Natural Node.js integration.
- **Chrome Extension**: Extensions cannot be invoked from Node.js or Grunt. You'd need a separate headless analysis tool for the automated path anyway, defeating the purpose of choosing an extension.
- **Verdict**: **Playwright wins.**

### 9. Auth-Protected Customer Sites

- **Playwright**: Cursor opens a **real Chromium browser window** (not headless). The user can manually navigate to the login page, enter credentials, and then tell the agent to proceed with analysis. Not as seamless as auto-auth, but functional.
- **Chrome Extension**: Runs in the user's actual Chrome browser with all existing sessions and cookies. If the user is already logged into the customer's site, the extension can analyze immediately. **Best possible auth handling.**
- **Verdict**: **Chrome Extension wins.** This is its strongest advantage.

### 10. Bot Detection Bypass

- **Playwright**: Cursor's Playwright uses real Chromium (not headless), so it passes most fingerprint checks. Some aggressive anti-bot systems (Cloudflare Bot Management, Akamai Bot Manager) may still detect the Playwright automation flags (`navigator.webdriver = true`). Stealth plugins exist but aren't guaranteed.
- **Chrome Extension**: Zero bot detection risk -- it IS the user's real browser with real user behavior patterns.
- **Verdict**: **Chrome Extension wins**, but the margin is small -- most customer e-commerce sites (Shopify, Magento, BigCommerce) do NOT have aggressive anti-bot that would block non-headless Playwright.

### 11. Distribution and Maintenance

- **Playwright**: Zero distribution needed. It's an npm dependency (`playwright`) installed with the project. Works on any machine with Node.js.
- **Chrome Extension**: Needs to be either:
  - Published to Chrome Web Store (review process, update cycles)
  - Distributed as an unpacked extension (manual installation per machine, requires developer mode)
  Ongoing maintenance for Chrome API changes, Manifest V3 updates, etc.
- **Verdict**: **Playwright wins.**

---

## Summary

| Capability | Playwright | Chrome Extension | Winner |
|---|---|---|---|
| Navigate URL | Trivial | Trivial | Tie |
| Execute JS in page | Trivial | Trivial | Tie |
| Multi-viewport resize | One API call | Needs debugger API, unreliable | **Playwright** |
| Screenshots | Full-page + element-level | Visible viewport only | **Playwright** |
| DOM / accessibility access | Excellent (a11y tree) | Good (no a11y tree) | **Playwright** |
| Interactive confirmation | Same Cursor conversation | Separate UI + bridge needed | **Playwright** |
| Cursor agent integration | Native (zero glue) | Needs WebSocket/file bridge | **Playwright** |
| Grunt task integration | Natural Node.js | Not possible without bridge | **Playwright** |
| Auth-protected sites | Manual login in browser | Uses existing session | **Extension** |
| Bot detection bypass | Real Chromium, rare issues | Zero risk | **Extension** |
| Distribution / maintenance | Zero (npm dep) | Chrome Web Store or sideload | **Playwright** |

**Score: Playwright 8, Chrome Extension 2, Tie 2**

---

## Decision: Playwright

The two areas where a Chrome Extension wins -- auth-protected sites and bot detection -- are **edge cases** for our workflow:

- **Auth**: Most customer search and category pages are public. When they aren't, the user can log in manually through the Playwright-controlled browser window that Cursor opens.
- **Bot detection**: Shopify, Magento, and BigCommerce storefronts generally don't block non-headless Playwright. The few that do can be handled by the user navigating manually and letting the agent take snapshots afterward.

Meanwhile, a Chrome Extension would **fundamentally break the core design** of the config generator:

1. The entire Layer 3 workflow -- where the agent browses, proposes selectors, asks the user to confirm element-by-element, and generates the config -- all happens in **one Cursor conversation**. A Chrome Extension would split this into two disconnected tools.
2. Multi-viewport analysis (desktop + mobile), which is a core requirement for device-aware element placement, is unreliable with Chrome Extension APIs.
3. The effort to build, distribute, and maintain a Chrome Extension **plus** a communication bridge to Cursor would far exceed the value of the two edge cases it addresses.

**The existing plan proceeds with Playwright via Cursor's built-in browser tools. No changes needed.**

---

## Addendum (2026-09-22): capability rows re-tested against `chrome.debugger`

Added after building the CX Debug Assistant in this repo, which is a Manifest V3
extension that uses `chrome.debugger` (CDP). **The decision above still stands for
the Semi-Auto Config Generator** — see "What does not change". But three capability
rows were scored against the wrong API surface and should not be cited as evidence
in future decisions.

The comparison evaluated the extension using `chrome.tabs` / `chrome.scripting`.
Those are indeed limited. `chrome.debugger` exposes the Chrome DevTools Protocol —
**the same protocol Playwright drives underneath**. Once an extension takes the
`debugger` permission, the capability gap in rows 3, 4 and 5 closes:

| Row | Original verdict | Re-tested with CDP |
|---|---|---|
| 3. Multi-viewport resize | "needs debugger API, unreliable" | `Emulation.setDeviceMetricsOverride` — this is exactly what Playwright's `browser_resize` calls. Same mechanism, same reliability. Verified working in `src/capture/toolbox.js` (`set_viewport`). |
| 4. Screenshots | "visible viewport only" | `Page.captureScreenshot` with `captureBeyondViewport: true` gives full-page; `clip` gives element-level. The visible-viewport limit belongs to `chrome.tabs.captureVisibleTab()`, which is a different API. |
| 5. DOM / accessibility tree | "no built-in accessibility tree API" | `Accessibility.getFullAXTree` returns the same tree `browser_snapshot()` does. |

Row 3's stated cost is real but is a one-time UX cost, not a reliability one: the
`debugger` permission shows Chrome's "extension is debugging this browser" banner
for as long as the session is attached. That is a legitimate reason to prefer
Playwright for an unattended tool; it is not a reason to call the capability
unreliable.

### What does not change

Rows 6, 7, 8 and 11 — interactive confirmation in the Cursor conversation, native
agent-tool integration, Grunt/Node invocation, and distribution — are integration
arguments, not capability ones, and they are correct. An extension still cannot be
called from a Cursor skill or a Grunt task without a bridge. For a workflow whose
core loop is "agent proposes, engineer confirms, agent generates config, all in one
conversation", **Playwright remains the right choice.**

### Where the extension does win

Row 9 (auth) and row 10 (bot detection) were scored correctly but rated as edge
cases. For *live customer debugging* — as opposed to config generation — they are
the whole point: the engineer is already on the broken page, logged in, behind the
customer's VPN, with their own session. Reproducing that in Playwright is the
expensive part.

That is the split worth remembering: **Playwright for building configs
(unattended, scriptable, conversation-native); the extension for debugging live
sites (authenticated, real session, real user).** The two tools do not compete.

One further note: "the Cursor agent cannot call Chrome extension APIs" (row 7) is
true, but the inverse is now false. The extension in this repo runs its own
MCP-style tool loop internally (`src/capture/toolbox.js` +
`src/llm/agent.js`): the model calls tools over the live CDP session and
iterates. That removes the need for a bridge *for debugging*, though not for the
config generator's confirm-with-the-engineer loop, which still needs to happen
where the engineer already is.
