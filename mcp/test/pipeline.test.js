/**
 * Full triage pipeline in real (headless) Chrome against a fixture store:
 * CDP capture → strategy → self-debug → page inventory → CSS provenance →
 * ownership → briefing. No real network (see fixture-store.js).
 *
 * Skips itself when no Chrome/Chromium can be launched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setDocLoader } from '../../src/shared/docs.js';
import { BrowserManager } from '../src/browser.js';
import { runTriage } from '../src/triage.js';
import { buildJiraDraft } from '../src/report.js';
import { installFixtureStore, installFixtureFetch, FIXTURE_URL } from './fixture-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
setDocLoader((name) => readFile(path.join(ROOT, name), 'utf8'));

const manager = new BrowserManager({ headless: true, channel: process.env.UNBXD_MCP_BROWSER_CHANNEL ?? 'chrome' });
let available = true;

before(async () => {
  try {
    await manager.ensureBrowser();
  } catch {
    available = false;
  }
});
after(() => manager.close());

async function triage(scenario, args = {}) {
  const context = await manager.contextFor('desktop');
  await installFixtureStore(context, scenario);
  const restore = installFixtureFetch(scenario);
  try {
    return await runTriage(manager, { url: FIXTURE_URL, complaint: 'Search results page shows nothing for boots.', include_screenshot: false, ...args });
  } finally {
    restore();
  }
}

test('healthy store → every check passes, not reproduced', async (t) => {
  if (!available) return t.skip('no browser');
  const { lastTriage: last } = await triage('healthy');
  const c = last.context;
  assert.equal(last.issueTypeId, 'srp_ui');
  assert.equal(c.pageInventory.platform.name, 'shopify');
  assert.equal(c.pageInventory.platform.theme.name, 'Dawn');
  assert.equal(c.sdkAssets.verdict, 'loaded');
  const failed = c.selfDebug.checks.filter((x) => x.status === 'fail').map((x) => x.id);
  assert.deepEqual(failed, [], `unexpected failures: ${failed.join(', ')}`);
  assert.equal(c.responseSummary.returnedProductCount, 3);
  assert.equal(c.ownership.owner, 'not_reproduced');
});

test('theme CSS hides the Unbxd grid → customer CSS, names base.css and the selector', async (t) => {
  if (!available) return t.skip('no browser');
  const { lastTriage: last, text } = await triage('theme_hides_grid');
  const c = last.context;
  const container = c.cssProvenance.elements.find((e) => e.role === 'container');
  assert.ok(container && container.found, 'results container inspected');
  assert.equal(container.hiddenBy && container.hiddenBy.owner, 'customer');
  assert.match(container.hiddenBy.sheet, /base\.css/);
  assert.match(container.hiddenBy.selector, /template-search/);
  assert.ok(container.overrides.some((o) => o.property === 'display' && o.unbxdValue === 'grid'), 'Unbxd display:grid overridden');
  assert.equal(c.ownership.owner, 'customer_site_css');
  assert.equal(c.ownership.route, 'revert_to_customer');
  assert.equal(c.ownership.confidence, 'high');
  assert.match(text, /Revert to customer/);
});

test('Unbxd API 500 → internal Jira to the API team', async (t) => {
  if (!available) return t.skip('no browser');
  const { lastTriage: last } = await triage('api_500');
  const c = last.context;
  assert.equal(c.searchRequest.status, 500);
  assert.equal(c.ownership.owner, 'unbxd_api');
  assert.equal(c.ownership.route, 'raise_internal_jira');
  const draft = buildJiraDraft(last, { severity: 'High' });
  assert.match(draft.markdown, /search\.unbxd\.io/);
  assert.match(draft.markdown, /Status: 500/);
  assert.match(draft.markdown, /fixture-site/);
});
