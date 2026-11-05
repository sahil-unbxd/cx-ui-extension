# AGENTS.md — working on CX Debug Assistant

A Manifest V3 Chrome extension for Unbxd CX engineers. It sits **alongside**
Playwright MCP and Chrome DevTools, it does not replace them: the engineer is
already on the broken page; this captures that page's context and asks a model
for a root cause they can paste into a ticket.

## Flow

```
popup (Debug tab)                 service worker                      Gemini
  issue type + description  ──▶  capture.start  ──▶ chrome.debugger.attach
                                                     Recorder: network (always) + console
                                                 ──▶ Page.reload (opt-in, default on)
                                                 ──▶ createAutoStopWatcher()  [results_page / autosuggest_data only]
  (engineer reproduces the bug on the page)
  Stop & analyse ─OR─ auto-stop ──▶  capture.stop  ──▶ captureSdkAssets(recorder)  [every issue type]
                                                 ──▶ strategy(issueType)  [DOM/CSS, or search/category API]
                                                 ──▶ runSelfDebug()  [SRP/PLP/autosuggest-data: ordered pass/fail verdicts]
                                                 ──▶ buildPrompt(template + SKILLS.md + budgeted JSON)
                                                 ──▶ agent mode: runAgentLoop() ⇄ toolbox over LIVE session
                                                     one-shot mode: client.complete()  ──▶ Vertex AI / Gemini API
                                                 ──▶ detach (always, in finally)
  render answer + copy      ◀──  record (stored as `lastAnalysis`)
```

Network recording is unconditional (see the comment on `Recorder` construction
in `service-worker.js`): the `sdkAssets` check — "did search.js/autosuggest.js/
their CSS load?" — runs for every issue type before anything issue-specific,
because a broken SDK bundle explains almost any downstream symptom. Per-type
strategies still decide what, if anything, *beyond* that gets forwarded.

**Auto-stop.** For issue types with a deterministic self-debug procedure
(`capture.selfDebugKind` set — currently `results_page` and
`autosuggest_data`), a watcher (`src/capture/auto-stop.js`) runs alongside the
recorder for the whole capture: on each relevant API response it debounces,
re-runs that issue type's self-debug check via the toolbox, and once the
result is conclusive (any check FAILs, or the terminal check —
`api_results_rendered` / `popular_products_rendered` — reaches a real
pass/fail rather than a skip) it calls the *same* `stopAndAnalyse` a manual
click would, with no popup interaction required — the engineer's description
is snapshotted at `capture.start` time for exactly this reason, since the
popup is normally closed while they're reproducing the issue. The alignment
issue type has no equivalent "we now have the full picture" signal, so no
watcher is created for it; auto-stop is a no-op there regardless of the
setting. See the constraint below before touching this path.

## Where things live

| Concern | File |
|---|---|
| Issue-type registry (the spine) | `src/shared/issue-types.js` |
| Settings (Gemini endpoint, model, key) | `src/shared/settings.js` |
| Canonical Unbxd host/path patterns (API + SDK assets) | `src/shared/unbxd-endpoints.js` |
| CDP attach/detach wrapper | `src/capture/cdp.js` |
| Network + console recording | `src/capture/recorder.js` |
| **Shared "validate first" SDK-asset check (all issue types)** | `src/capture/sdk-assets.js` |
| **Customer config bundle review (SRP/PLP)** | `src/capture/site-config.js` |
| **Self-debug checks (deterministic verdicts)** | `src/capture/self-debug.js` |
| **MCP-style tool surface (agent mode)** | `src/capture/toolbox.js` |
| **Agentic investigation loop** | `src/llm/agent.js` |
| **Auto-stop watcher (no manual "Stop & analyse")** | `src/capture/auto-stop.js` |
| **Per-issue-type capture** | `src/capture/strategies.js` |
| **Redaction (privacy boundary)** | `src/capture/redact.js` |
| **Per-issue-type prompt templates** | `src/prompt/templates.js` |
| Playbook injection from SKILLS.md | `src/prompt/skills.js` |
| Token budgeting / shrinking | `src/prompt/budget.js` |
| Prompt assembly | `src/prompt/builder.js` |
| LLM client (Gemini: Vertex AI or Gemini API) | `src/llm/client.js` |
| Orchestration, session lifecycle | `src/background/service-worker.js` |
| UI (Debug / Settings tabs) | `popup/` |
| Full settings page | `options/` |
| Debugging playbooks (prompt surface) | `SKILLS.md` |
| How the prompt layer reads the markdown docs (swappable loader) | `src/shared/docs.js` |
| **Page inventory: scripts/styles/console errors/failed requests attributed to Unbxd vs customer, platform, competing search apps** | `src/capture/page-inventory.js` |
| **CSS provenance: whose stylesheet hides/moves the widget's elements** | `src/capture/css-provenance.js` |
| **Ownership routing: revert to customer vs internal Jira (deterministic)** | `src/capture/ownership.js` |
| **MCP server for the support team (Playwright, stdio)** | `mcp/` — see `mcp/README.md` |

## Constraints — do not quietly relax these

- **No always-on capture.** The debugger attaches on "Start capture" and detaches
  in a `finally` on stop, cancel, tab close, or a 5-minute hard stop. Never attach
  on install, on navigation, or "just in case". The `REC` badge must reflect reality.
- **Redaction is a privacy boundary, not a token optimisation.** `src/capture/redact.js`
  is the only place that decides what may leave the browser. Response bodies, cookies
  and auth headers never go into a prompt. The SRP strategy is the one place that
  touches a response body, and it forwards counts, field names and shapes — never
  values. If a prompt needs more signal, add a *shape*, not a payload. Token
  budgeting (`budget.js`) runs after redaction and is about cost only.
- **No backend in v1.** BYO key in `chrome.storage.local` (not `sync` — keys must
  not ride the profile to other machines), request goes browser → Google. Do not
  add a proxy, telemetry or remote logging without an explicit decision.
- **The model is Gemini only** (team decision: the company has Gemini Enterprise).
  `client.js` supports two endpoints with the same request body: Vertex AI
  (project + location + Vertex AI API key, or an express-mode key with no project)
  and the Gemini API (AI Studio key). The key goes in the `x-goog-api-key` header,
  never the URL. Two Gemini details that break a tool loop if dropped: the
  model's turn is replayed verbatim (`raw`), because Gemini 3 thought signatures
  live on its function-call parts, and the output budget stays large, because
  thinking tokens count toward it. Both are covered by
  `mcp/test/gemini-client.test.js`. Old Claude/OpenAI settings and keys are
  deleted from storage by the migration in `getSettings()`.
- **Capture strategies stay separated.** An SRP capture must not collect DOM
  geometry; an alignment capture must not collect API payloads. The `capture` flags
  in `issue-types.js` are the contract, and templates must only ask about what their
  strategy actually captured. The one shared exception is `sdkAssets`
  (`src/capture/sdk-assets.js`): a fixed, small "did search.js/autosuggest.js/their
  CSS load?" check that runs for every issue type regardless of these flags — it
  forwards load status/timing for known Unbxd asset URLs only, never page data, so
  it doesn't reopen the per-type boundary. Don't widen it into a general network
  dump for the DOM-only issue type.
- **The self-debug checks are deterministic, and must stay that way.**
  `self-debug.js` answers the questions a CX engineer would otherwise run by
  hand, and the popup shows its verdicts independently of the LLM. Checks are
  ordered upstream-first so `summary.firstFailure` means something; adding one
  in the wrong position breaks that contract. Never assume a parameter name the
  SDK can resolve for you: the page URL's query param comes from
  `getSearchQueryParam()` (`q` by default, often `searchTerm`/`keyword`) and the
  browse param from `getBrowseQueryParam()` (`p`), while the API endpoint itself
  always takes `q`. A check that cannot apply returns `skip`, never `pass` —
  a false pass is worse than no check. There are two self-debug playbooks
  (`runSelfDebug` for results pages, `runAutosuggestSelfDebug` for autosuggest
  data), selected by `capture.selfDebugKind` in `issue-types.js` and both
  reported under the same `context.selfDebug` field so the popup's verdict
  rendering works for either without special-casing. `runAutosuggestSelfDebug`
  is honest about an unresolved question: unlike `window.unbxdSearch`, there is
  no confirmed single global for the autosuggest widget's live instance across
  customer bundles — it tries plausible locations and reports which one (if
  any) worked (`sdkState.locationsTried`) rather than assuming. Don't silently
  "fix" that uncertainty by picking one; if you get a confirmed answer, replace
  the guesswork in `readAutosuggestSdkState` and say so in SKILLS.md.
- **Config review extracts, it never dumps.** `site-config.js` fetches the
  customer's `{siteKey}_search.js` (~350KB minified, SDK library + config +
  their templates) and `_search.css`. The file text must never reach a prompt —
  only named markers and the resolved live config. A real capture serialises to
  ~4KB. If you need a new signal, add a named extraction, not a bigger slice.
  Keep the `liveConfig` (authoritative, read off `window.unbxdSearch.options`)
  versus `bundleMarkers` (regex heuristics over text that also contains the
  SDK's own demo defaults) distinction intact in both the data and the prompt —
  collapsing it is how a model ends up confidently quoting a library default as
  the customer's setting.
- **Only search/category/autosuggest are "the" Unbxd API.** `src/shared/unbxd-endpoints.js`
  is the single source of truth for matching `search.unbxd.io/{apiKey}/{siteKey}/
  {search|category|autosuggest}` and the `libraries.unbxdapi.com` /
  `sandbox.unbxd.io` asset hosts. Every other request the page makes (analytics,
  recs widgets, ads, third-party scripts) is noise and must never be treated as
  "the" search/category call — use `unbxdApiKind()`/`unbxdAssetKind()`/`isUnbxdHost()`
  rather than re-deriving a URL pattern in a strategy.
- **Agent mode holds the debugger open; detach is still non-negotiable.** In
  agent mode the session stays attached *through* the LLM loop so tools observe
  the live page — so the detach moved into a `finally` around the whole analysis
  phase, with `ANALYSIS_GUARD_MS` as the backstop if the loop hangs. Any new code
  path in `stopAndAnalyse` must keep both. The loop is bounded on purpose
  (iteration cap, wall-clock budget, size-capped tool results); those bounds are
  the engineer's token bill, not decoration.
- **Tools inherit the redaction boundary.** `toolbox.js` is a second way out of
  the browser and gets the same rules as the one-shot path: response bodies go
  through `summariseSearchResponse`, never raw; `evaluate_js` refuses cookie
  access and outbound fetches. A new tool that returns something the one-shot
  path would have redacted is a bug, not a feature.
- **Issue type is chosen by the engineer.** No auto-detection in v1. If you add it,
  it must be a suggestion the engineer can override, not a silent switch.
- **Auto-stop must only ever trigger the real `stopAndAnalyse`, never a second
  code path.** `triggerAutoStop` in `service-worker.js` calls the exact same
  function a manual "Stop & analyse" click does — there is no separate
  "auto-completion" flow to keep in sync. The `active.stopping` guard exists
  because a manual click and the watcher's `onReady` can race in principle;
  don't remove it "to simplify" without re-verifying both race directions (a
  test for this exists in the project's manual test notes — rebuild it before
  touching this logic if there isn't an automated one by then). The watcher
  must be disposed in every path that clears `active`
  (`stopAndAnalyse`'s finally, `cancelCapture`) — a live listener on a detached
  session is a leak, and a late `onReady` firing after `active` is null must be
  a no-op (checked via `active.tabId !== tabId`), not a crash.
- **Auto-stop only knows the description as of `capture.start`.** It cannot ask
  a closed popup what the engineer typed since. If this needs to change (e.g.
  polling the popup for a live value with a timeout), say so explicitly in the
  commit — don't silently start dropping edits made mid-recording.

## The MCP server (`mcp/`)

A second front-end over the same capture code, for the support team in Claude
Desktop or Claude Code. It drives its own Playwright browser instead of
`chrome.debugger`. `mcp/src/browser.js` subclasses `CdpSession`, so the recorder,
strategies, self-debug checks, toolbox and redaction are all the *same modules*.
Never fork them into `mcp/`. If the MCP needs different behaviour, add a
parameter (as `buildPrompt`'s `outputContract` and `setDocLoader` do).

What it adds is the routing question support asks on every ticket: is it the
customer's site (revert to them) or ours (internal Jira)? Three modules answer
it. They are session-interface-only, so the extension can adopt them, but today
only the MCP calls them:

- `page-inventory.js` attributes every script, stylesheet, console error and
  failed request to an owner (`classifyAssetOrigin`: Unbxd CDN/module vs
  Shopify theme/app/platform, Magento theme/module/core, same-site, third
  party), and detects the platform, competing search apps and blocked pages.
- `css-provenance.js` reads the matched cascade for the widget's own elements
  and reports which stylesheet wins, and where a customer rule overrides an
  Unbxd rule.
- `ownership.js` is a pure, weighted classifier over all of the above plus
  `selfDebug`. It is unit-tested in `mcp/test/ownership.test.js`.

Constraints specific to this path:

- **Ownership is deterministic and must stay honest, like self-debug.** Absence
  of evidence scores nothing. A customer verdict needs a nameable artefact (a
  script/stylesheet URL and selector, a missing tag, a blocking header). On a
  blocked or error page (`access_blocked`), nothing downstream is scored as a
  finding. That rule exists because the first version blamed a customer for a
  WAF 405 page; the regression test covers it. Unrelated console noise on a busy
  storefront is capped low unless the widget is actually failing.
- **No bot-protection circumvention.** No user-agent spoofing, no stealth flags,
  no `AutomationControlled` tweaks. A blocked page is reported as
  *Need more evidence* with the remedy (visible window, attach to the engineer's
  Chrome, or use the extension).
- **Lifecycle mirrors "no always-on capture".** The browser launches on demand,
  each triage gets a fresh page and recorder, and everything closes on
  `close_browser`, after the idle timeout, or when the client disconnects. When
  attached to the engineer's Chrome (`UNBXD_MCP_CDP_URL`), only pages the server
  opened are touched.
- **stdout is the MCP channel.** Shared code must never `console.log`; the
  server logs to stderr.
- `mcp/` has dependencies (`@modelcontextprotocol/sdk`, `playwright-core`). The
  "no dependencies, no build step" convention still holds for the extension and
  for `src/`. `src/package.json` only marks `src/` as ES modules for Node.

## Adding an issue type

Four edits, all keyed by the same id, plus a heading in `SKILLS.md` that matches
`skillsSection` exactly — see the checklist at the top of `SKILLS.md`. Nothing
else should need to change; if it does, that is a design smell worth fixing.

## Conventions

- Plain ES modules, no build step, no dependencies. `manifest.json` loads the
  service worker as `"type": "module"`; popup and options use `<script type="module">`.
- CDP calls that are nice-to-have go through `session.trySend()` so one unsupported
  domain cannot kill a capture; anything whose failure should abort uses `send()`.
- Errors surface to the engineer as text in the popup status line. Do not swallow
  a provider error into a generic message — the API's own message is the useful part.
- Keep prompt text in `templates.js` and playbook text in `SKILLS.md`. Prompt strings
  do not belong in capture or UI code.

## Testing

`cd mcp && npm test` runs unit tests for attribution, the cascade model and
ownership routing, plus full-pipeline tests in headless Chrome against a fixture
store served by request interception (no network). Run it whenever you touch
`src/capture/` — the extension and the MCP share that code.

The extension itself still has no automated tests. Manual loop: `chrome://extensions` → Developer mode →
"Load unpacked" → this directory. Reload the extension after editing the service
worker. The popup's "Prompt sent to the model" and "Captured context" disclosures
are the debugging surface — check them before blaming the model, and check them
whenever you touch redaction.
