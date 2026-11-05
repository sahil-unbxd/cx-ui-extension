/**
 * Evidence-backed Jira ticket body, built from the last triage.
 *
 * The model writes the narrative (title, root cause, fix); everything a
 * reviewer needs to trust it — environment, repro steps, failing checks, the
 * exact API call, console errors by owner, CSS overrides — comes straight from
 * the captured context, so it is identical in shape on every ticket and never
 * depends on what the model chose to quote.
 *
 * Markdown, because Jira Cloud's editor converts pasted markdown, and the
 * Atlassian MCP server (if the support agent has it connected) accepts it as a
 * description.
 */
import { getIssueType } from '../../src/shared/issue-types.js';

const ICON = { pass: '✅', fail: '❌', warn: '⚠️', skip: '➖' };

export function buildJiraDraft(last, input = {}) {
  if (!last) throw new Error('No triage has run in this session yet. Run triage_ui_issue first.');
  const c = last.context;
  const o = c.ownership;
  const inv = c.pageInventory || {};
  const cons = c.siteConfig?.consistency || {};
  const siteKey = cons.liveSiteKey || cons.requestSiteKey || cons.bundleSiteKey || 'unknown-site';
  const type = getIssueType(last.issueTypeId);
  const req = c.searchRequest || c.autosuggestRequest || null;
  const resp = c.responseSummary || null;

  const title = input.title || `[${siteKey}] ${type.label}: ${o.summary.replace(/^[^:]+:\s*/, '').slice(0, 90)}`;
  const team = input.team || o.team || 'Unbxd CX';
  const severity = input.severity || 'Medium';

  const lines = [];
  const h = (t) => lines.push('', `### ${t}`);

  lines.push(`**Title:** ${title}`);
  lines.push(`**Team:** ${team} · **Severity:** ${severity}${input.severity_reason ? ` — ${input.severity_reason}` : ''}`);
  lines.push(`**Routing (automated):** ${o.decision} · owner: ${o.ownerLabel} · confidence ${o.confidence}${o.runnerUp ? ` · runner-up: ${o.runnerUp.label}` : ''}`);

  h('Customer report');
  lines.push(last.complaint ? `> ${last.complaint.replace(/\n/g, '\n> ')}` : '_No description provided._');

  h('Environment');
  lines.push(`- Site key: \`${siteKey}\``);
  lines.push(`- Platform: ${platformText(inv.platform)}`);
  lines.push(`- Page: ${last.pageUrl}`);
  lines.push(`- Device: ${last.device}${last.browserVersion ? ` · Chrome ${last.browserVersion}` : ''}`);
  lines.push(`- Captured: ${last.at}`);

  h('Steps to reproduce');
  (c.reproduction?.steps || []).forEach((s, i) => lines.push(`${i + 1}. ${s}`));

  if (input.expected || input.actual) {
    h('Expected vs actual');
    if (input.expected) lines.push(`- Expected: ${input.expected}`);
    if (input.actual) lines.push(`- Actual: ${input.actual}`);
  }

  h('Root cause analysis');
  lines.push(input.root_cause || o.summary);

  if (c.selfDebug && c.selfDebug.checks) {
    h('Automated checks (upstream first)');
    lines.push('| | Check | Detail |', '|---|---|---|');
    for (const chk of c.selfDebug.checks) {
      if (chk.status === 'skip') continue;
      lines.push(`| ${ICON[chk.status] || chk.status} | \`${chk.id}\` | ${cell(chk.detail)} |`);
    }
  }

  if (req) {
    h('Unbxd API call');
    lines.push(`- \`${req.method || 'GET'} ${req.url}\``);
    lines.push(`- Status: ${req.failed ? `failed (${req.errorText})` : req.status}${req.durationMs != null ? ` · ${req.durationMs}ms` : ''}`);
    if (resp && resp.parsed) {
      const count = resp.numberOfProducts ?? resp.totalProducts ?? null;
      lines.push(`- Response: ${count != null ? `${count} products` : 'parsed'}${resp.returnedProductCount != null ? `, ${resp.returnedProductCount} returned on this page` : ''}${resp.doctypeCounts ? ` · doctypes ${JSON.stringify(resp.doctypeCounts)}` : ''}`);
    } else if (resp && resp.parsed === false) {
      lines.push(`- Response was not JSON: ${resp.head || ''}`);
    }
  }

  if (c.sdkAssets) {
    h('Unbxd SDK assets');
    lines.push(`- Verdict: ${c.sdkAssets.verdict}`);
    for (const [kind, a] of Object.entries(c.sdkAssets.detected || {})) {
      lines.push(`- ${kind}: ${a.failed ? `FAILED (${a.errorText})` : a.status} — ${a.url}`);
    }
  }

  const errors = inv.consoleErrors || [];
  if (errors.length) {
    h('Console errors (by owner)');
    for (const e of errors.slice(-8)) lines.push(`- [${e.owner}/${e.source}] ${e.text}${e.scriptUrl ? ` — ${e.scriptUrl}` : ''}`);
  }

  const cssFindings = [];
  for (const el of c.cssProvenance?.elements || []) {
    if (el.hiddenBy && el.expectVisible) cssFindings.push(`- ${el.label}: hidden by \`${el.hiddenBy.property}: ${el.hiddenBy.value}\` from ${el.hiddenBy.sheet || el.hiddenBy.source} (${el.hiddenBy.selector || 'n/a'})`);
    for (const ov of el.overrides || []) {
      cssFindings.push(`- ${el.label}: \`${ov.property}\` Unbxd "${ov.unbxdValue}" → "${ov.winningValue}" by ${ov.winnerSheet || ov.winnerSource} (${ov.winnerSelector || 'n/a'})`);
    }
  }
  if (cssFindings.length) {
    h('CSS findings');
    lines.push(...cssFindings.slice(0, 10));
  }

  const competing = (inv.competingSearch || []).filter((x) => x.scriptSrc || x.domMarkerVisible);
  if (competing.length || (inv.nativeSearch || []).some((n) => n.visibleCount > 0)) {
    h('Other search widgets on the page');
    for (const x of competing) lines.push(`- ${x.vendor}${x.scriptSrc ? ` — ${x.scriptSrc}` : ''}`);
    for (const n of inv.nativeSearch || []) if (n.visibleCount > 0) lines.push(`- ${n.what} visible (${n.selector})`);
  }

  const known = last.knownIssues && last.knownIssues.matches;
  if (known && known.length) {
    h('Matches previously-resolved pattern');
    for (const k of known) lines.push(`- **${k.title}** — documented fix: ${k.fix || 'see common-issues.md'}`);
  }

  if (input.fix) {
    h('Suggested fix');
    lines.push(input.fix);
  }

  if (input.notes) {
    h('Notes');
    lines.push(input.notes);
  }

  lines.push('', '_Generated by the Unbxd CX Debug MCP from a live capture. Redacted: no response bodies, cookies or auth headers._');
  return { title, team, severity, markdown: lines.join('\n') };
}

function platformText(p) {
  if (!p) return 'unknown';
  if (p.name === 'shopify') {
    const t = p.theme || {};
    return `Shopify${p.shop ? ` (${p.shop})` : ''}${t.name ? `, theme "${t.name}"${t.id ? ` #${t.id}` : ''}${t.role ? ` [${t.role}]` : ''}` : ''}`;
  }
  if (p.name === 'magento') return `Magento 2${p.theme ? `, theme ${p.theme}` : ''}`;
  return p.name;
}

function cell(text) {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220);
}
