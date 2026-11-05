# Unbxd CX Debug MCP

An MCP server for the Unbxd support team. Paste the customer's complaint and the page URL into
Claude. Claude opens the storefront in a real browser, reproduces the issue and tells you **whose
problem it is**:

| Decision | When | What you get |
|---|---|---|
| ↩️ **Revert to customer** | Their theme JS/CSS, an installed app or module, a competing search app, a missing integration snippet, a CSP header blocking Unbxd | A reply you can send, naming the exact file, selector or app |
| 🎫 **Raise internal Jira** → team | Unbxd config (`{siteKey}_search.js`), Unbxd search API, SDK/CDN, catalogue/merchandising | A ticket draft with environment, repro steps, check results, the API call and evidence |
| 🔍 **Need more evidence** | Not reproduced, bot protection, password page | Exactly what to ask the customer for |

It works on Shopify, Magento 2 and any other storefront running the Unbxd SDK. The server holds
no API key and calls no model. Claude is the model, and the server supplies the evidence.

## Setup (once)

Requirements: Node 20+ and Google Chrome.

```bash
cd mcp
npm install
```

**Claude Desktop.** Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "unbxd-cx-debug": {
      "command": "/usr/local/bin/node",
      "args": ["/ABSOLUTE/PATH/TO/cx-ui-extension/mcp/src/server.js"]
    }
  }
}
```

Use the absolute path from `which node`. Claude Desktop does not see nvm's `PATH`.

**Claude Code**:

```bash
claude mcp add unbxd-cx-debug -s user -- node /ABSOLUTE/PATH/TO/cx-ui-extension/mcp/src/server.js
```

## Use

Use the **triage** prompt (Claude Desktop: the `+` menu; Claude Code: `/mcp__unbxd-cx-debug__triage`),
or just ask:

> Customer ticket for https://www.example.com/search?q=boots — "prices on the search page show
> $0.00 for some products". Triage it.

> Autosuggest on https://shop.example.co.uk/ doesn't show popular products when typing "sofa". Mobile.

Claude calls `triage_ui_issue`, may check a few things on the live page, then answers in four
parts: **Decision**, **Why** (evidence), **Reply to customer**, and **Internal Jira draft**. Ask
for `draft_jira_ticket` to get the full evidence-backed ticket body.

Tips:
- Paste the complaint verbatim, including any HTML or quoted value the customer sent. Quoted
  values are traced back to the API field that produced them.
- For autosuggest issues, give the term the customer typed.
- For multi-step issues (applying a facet, pagination, the back button), ask Claude to use
  `interact`, then re-run the triage without a URL.
- A Chrome window opens while it works. Leave it alone; it closes itself after 10 idle minutes,
  or when you ask Claude to close the browser.

## What it checks

1. **Unbxd SDK bundles**: did `{siteKey}_search.js`, `_autosuggest.js` and their CSS load, and
   if not, was it a 404/5xx (Unbxd) or the customer's CSP header (customer)?
2. **The deterministic self-debug checks** from the CX Debug Assistant extension: SDK
   initialised, page type vs endpoint, the typed query reaching the API as `q=`, the category
   reaching it as `p=`, attribute mapping, config selectors resolving, API results vs rendered
   DOM, duplicate calls, site-key consistency. The autosuggest variant checks whether the call
   fired, whether popular products were requested, returned and rendered.
3. **Page inventory**: platform and theme (Shopify theme name and role; Magento vendor/theme),
   every script and stylesheet attributed to Unbxd, theme, app/module, platform or third party,
   console errors attributed to the script that threw them, and failed requests by owner.
4. **CSS provenance**: for the widget's own elements, which stylesheet wins each
   layout/visibility property, and where a customer rule overrides Unbxd's CSS (file + selector).
5. **Conflicts**: competing search apps (Klevu, Searchspring, Boost, Searchanise, Algolia…)
   and the platform's own predictive search still active next to Unbxd.
6. **Known issues** from `common-issues.md`, plus the matching playbook from `SKILLS.md`.

These feed `src/capture/ownership.js`, a deterministic, weighted classifier that produces the
decision, a confidence level, the runner-up and the evidence. Claude may overrule it, but must
say which evidence wins.

## Tools

| Tool | Purpose |
|---|---|
| `triage_ui_issue` | Start here. Opens, reproduces, checks, routes. Omit `url` to re-analyse the open page. |
| `open_page`, `interact`, `type_in_search_box` | Reproduce multi-step flows (facets, sort, pagination, back button, password pages). |
| `screenshot` | Viewport, full page or one element. |
| `get_page_inventory`, `check_css_overrides` | Customer-vs-Unbxd attribution for scripts, errors and CSS. |
| `draft_jira_ticket` | Evidence-backed ticket body from the last triage. |
| `list_network_requests`, `get_request_detail`, `get_console_errors`, `get_sdk_config`, `search_bundle`, `inspect_element`, `trace_rendered_value`, `run_self_debug`, `run_autosuggest_self_debug`, `evaluate_js`, `set_viewport`, `reload_page` | The extension's agent-mode toolbox, unchanged. |
| `close_browser` | Close the browser now. |

The playbooks (`SKILLS.md`, `common-issues.md`, SDK references) are also exposed as MCP resources.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `UNBXD_MCP_HEADLESS` | off | `1` for no visible window. Many storefronts serve bot-protection pages to headless browsers; the triage then reports *Need more evidence* rather than guessing. |
| `UNBXD_MCP_CDP_URL` | unset | Attach to your own Chrome (start it with `--remote-debugging-port=9222`, then set `http://localhost:9222`). Uses your profile and sign-ins; only tabs the server opens are touched. |
| `UNBXD_MCP_BROWSER_CHANNEL` | `chrome` | Set it empty to use Playwright's Chromium (`npx playwright install chromium`). |
| `UNBXD_MCP_EXECUTABLE_PATH` | unset | Explicit browser binary. |
| `UNBXD_MCP_IDLE_MINUTES` | `10` | Close the browser after this much inactivity. |
| `UNBXD_MCP_MAX_TOKENS` | `16000` | Size budget for the triage briefing. Captured context shrinks first; the playbook stays. |

In Claude Desktop, put these under `"env": { … }` in the server entry. In Claude Code, pass
`-e NAME=value` to `claude mcp add`.

## What leaves the browser

The same boundary as the extension (`src/capture/redact.js`), because it is the same code: URLs
with secret parameters stripped, a safe subset of headers, status codes, console error text,
response **counts and field names** (never response bodies), extracted config values (never the
bundle text), and stylesheet/script URLs. Two things are new: the screenshot (`include_screenshot`,
default on, and the `screenshot` tool) and the page title. Both show what any visitor to that
public page sees. No cookies or auth headers are ever read; `evaluate_js` refuses `document.cookie`
and outbound fetches.

The server never tries to get past bot protection: no user-agent spoofing, no stealth flags. If a
site blocks the automated browser, use the visible window, attach to your own Chrome, or use the
CX Debug Assistant extension.

## Development

```bash
npm test          # unit tests + full-pipeline tests in headless Chrome against a fixture store (no network)
npm run smoke -- <results-page-url> <page-with-search-box-url> <query>   # end-to-end over MCP stdio, live site
```

Shared code lives in `../src` and is imported directly; there is no copy and no build step.
`mcp/src/browser.js` adapts Playwright to the `CdpSession` interface the capture code expects.
New evidence modules (`page-inventory.js`, `css-provenance.js`, `ownership.js`) live in
`../src/capture/` so the extension can adopt them too.
