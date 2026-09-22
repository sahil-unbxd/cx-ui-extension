# AGENTS.md — working on CX Debug Assistant

A Manifest V3 Chrome extension for Unbxd CX engineers. It sits **alongside**
Playwright MCP and Chrome DevTools, it does not replace them: the engineer is
already on the broken page; this captures that page's context and asks a model
for a root cause they can paste into a ticket.

## Flow

```
popup (Debug tab)                 service worker                      provider
  issue type + description  ──▶  capture.start  ──▶ chrome.debugger.attach
                                                     Recorder: network+console
  (engineer reproduces the bug on the page)
  Stop & analyse            ──▶  capture.stop   ──▶ strategy(issueType)  [DOM/CSS, search API]
                                                 ──▶ detach (always)
                                                 ──▶ buildPrompt(template + SKILLS.md + budgeted JSON)
                                                 ──▶ llm/client.complete() ───────────▶ Anthropic / OpenAI
  render answer + copy      ◀──  record (stored as `lastAnalysis`)
```

## Where things live

| Concern | File |
|---|---|
| Issue-type registry (the spine) | `src/shared/issue-types.js` |
| Settings / provider registry | `src/shared/settings.js` |
| CDP attach/detach wrapper | `src/capture/cdp.js` |
| Network + console recording | `src/capture/recorder.js` |
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
  strategy actually captured.
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
