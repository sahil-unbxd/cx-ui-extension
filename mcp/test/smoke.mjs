/**
 * End-to-end smoke test: talks to the server exactly as Claude does (MCP over
 * stdio) and runs real triages against a live storefront.
 *
 *   node test/smoke.mjs [results-page-url] [page-with-search-box-url] [query]
 *
 * Headless by default here; the server itself defaults to a visible window.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [srpUrl = 'https://www.lindt.ca/en/catalogsearch/result/?q=lindor', homeUrl = 'https://www.lindt.ca/en/', query = 'lindor'] = process.argv.slice(2);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, '..', 'src', 'server.js')],
  env: { ...process.env, UNBXD_MCP_HEADLESS: process.env.UNBXD_MCP_HEADLESS ?? '1' },
  stderr: 'inherit'
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const show = (label, res, lines = 18) => {
  const textPart = res.content.find((c) => c.type === 'text');
  const images = res.content.filter((c) => c.type === 'image').length;
  const body = textPart ? textPart.text : '';
  console.log(`\n===== ${label}${res.isError ? ' [ERROR]' : ''} — ${body.length} chars (~${Math.ceil(body.length / 3.6)} tokens), ${images} image(s)`);
  console.log(body.split('\n').slice(0, lines).join('\n'));
  return body;
};

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);
const { prompts } = await client.listPrompts();
console.log(`prompts: ${prompts.map((p) => p.name).join(', ')}`);
const { resources } = await client.listResources();
console.log(`resources: ${resources.map((r) => r.name).join(', ')}`);

const t0 = Date.now();
const srp = await client.callTool({
  name: 'triage_ui_issue',
  arguments: { url: srpUrl, complaint: 'Customer says the search results page shows the wrong prices for some chocolates.' }
}, undefined, { timeout: 180000 });
const srpText = show(`SRP triage (${Math.round((Date.now() - t0) / 1000)}s)`, srp, 16);
const ctxStart = srpText.indexOf('```json');
if (ctxStart > 0) {
  const ctx = JSON.parse(srpText.slice(ctxStart + 7, srpText.indexOf('```', ctxStart + 7)));
  console.log('\nownership.evidence:', JSON.stringify(ctx.ownership.evidence, null, 1).slice(0, 1500));
  console.log('\npageInventory.platform:', JSON.stringify(ctx.pageInventory?.platform));
  console.log('pageInventory.consoleErrorsByOwner:', JSON.stringify(ctx.pageInventory?.consoleErrorsByOwner), 'failedRequestsByOwner:', JSON.stringify(ctx.pageInventory?.failedRequestsByOwner));
  console.log('cssProvenance:', JSON.stringify((ctx.cssProvenance?.elements || []).map((e) => ({ label: e.label, found: e.found, hidden: e.hidden, overrides: (e.overrides || []).length, customerRules: (e.customerLayoutRules || []).length }))));
  console.log('cssProvenance.stylesheetsByOwner:', JSON.stringify(ctx.cssProvenance?.stylesheetsByOwner));
}

show('draft_jira_ticket', await client.callTool({ name: 'draft_jira_ticket', arguments: { title: 'Smoke test ticket', severity: 'Low' } }), 30);

const t1 = Date.now();
const as = await client.callTool({
  name: 'triage_ui_issue',
  arguments: { url: homeUrl, complaint: 'Autosuggest dropdown does not show popular products when typing.', search_query: query }
}, undefined, { timeout: 180000 });
show(`Autosuggest triage (${Math.round((Date.now() - t1) / 1000)}s)`, as, 14);

show('get_page_inventory', await client.callTool({ name: 'get_page_inventory', arguments: {} }), 25);
show('run_autosuggest_self_debug (toolbox)', await client.callTool({ name: 'run_autosuggest_self_debug', arguments: {} }), 12);
show('check_css_overrides', await client.callTool({ name: 'check_css_overrides', arguments: { selector: 'input[data-unbxd-mcp-input="1"]', ancestors: 1 } }), 30);

await client.callTool({ name: 'close_browser', arguments: {} });
await client.close();
console.log('\nsmoke: done');
