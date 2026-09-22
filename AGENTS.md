# AGENTS.md — working on CX Debug Assistant

A Manifest V3 Chrome extension for Unbxd CX engineers. It sits **alongside**
Playwright MCP and Chrome DevTools, it does not replace them: the engineer is
already on the broken page; this captures that page's context and asks a model
for a root cause they can paste into a ticket.

## Flow

```
popup (Debug tab)                 service worker                      provider
  issue type + description  ──▶  capture.start  ──▶ chrome.debugger.attach
                                                     Recorder: network (always) + console
                                                 ──▶ Page.reload (opt-in, default on)
  (engineer reproduces the bug on the page)
  Stop & analyse            ──▶  capture.stop   ──▶ captureSdkAssets(recorder)  [every issue type]
                                                 ──▶ strategy(issueType)  [DOM/CSS, or search/category API]
                                                 ──▶ runSelfDebug()  [SRP/PLP: ordered pass/fail verdicts]
                                                 ──▶ buildPrompt(template + SKILLS.md + budgeted JSON)
                                                 ──▶ agent mode: runAgentLoop() ⇄ toolbox over LIVE session
                                                     one-shot mode: client.complete()  ──▶ Anthropic / OpenAI
                                                 ──▶ detach (always, in finally)
  render answer + copy      ◀──  record (stored as `lastAnalysis`)
```

Network recording is unconditional (see the comment on `Recorder` construction
in `service-worker.js`): the `sdkAssets` check — "did search.js/autosuggest.js/
their CSS load?" — runs for every issue type before anything issue-specific,
because a broken SDK bundle explains almost any downstream symptom. Per-type
strategies still decide what, if anything, *beyond* that gets forwarded.

## Where things live

| Concern | File |
|---|---|
| Issue-type registry (the spine) | `src/shared/issue-types.js` |
| Settings / provider registry | `src/shared/settings.js` |
| Canonical Unbxd host/path patterns (API + SDK assets) | `src/shared/unbxd-endpoints.js` |
| CDP attach/detach wrapper | `src/capture/cdp.js` |
| Network + console recording | `src/capture/recorder.js` |
| **Shared "validate first" SDK-asset check (all issue types)** | `src/capture/sdk-assets.js` |
| **Customer config bundle review (SRP/PLP)** | `src/capture/site-config.js` |
| **Self-debug checks (deterministic verdicts)** | `src/capture/self-debug.js` |
| **MCP-style tool surface (agent mode)** | `src/capture/toolbox.js` |
| **Agentic investigation loop** | `src/llm/agent.js` |
| **Per-issue-type capture** | `src/capture/strategies.js` |
| **Redaction (privacy boundary)** | `src/capture/redact.js` |
| **Per-issue-type prompt templates** | `src/prompt/templates.js` |
| Playbook injection from SKILLS.md | `src/prompt/skills.js` |
| Token budgeting / shrinking | `src/prompt/budget.js` |
| Prompt assembly | `src/prompt/builder.js` |
| LLM client (both providers) | `src/llm/client.js` |
| Orchestration, session lifecycle | `src/background/service-worker.js` |
| UI (Debug / Settings tabs) | `popup/` |
| Full settings page | `options/` |
| Debugging playbooks (prompt surface) | `SKILLS.md` |

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
  not ride the profile to other machines), request goes browser → provider. Do not
  add a proxy, telemetry or remote logging without an explicit decision.
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

No automated tests in v1. Manual loop: `chrome://extensions` → Developer mode →
"Load unpacked" → this directory. Reload the extension after editing the service
worker. The popup's "Prompt sent to the model" and "Captured context" disclosures
are the debugging surface — check them before blaming the model, and check them
whenever you touch redaction.
