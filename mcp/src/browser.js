/**
 * The browser the MCP server drives, and the adapter that lets the extension's
 * capture code run against it unchanged.
 *
 * Everything under src/capture/ talks to a `session` with the CdpSession
 * interface (send / trySend / evaluate / on / reload). In the extension that is
 * chrome.debugger; here it is a Playwright CDP session on a page Playwright
 * opened. Subclassing CdpSession keeps reload()/evaluate()/trySend() identical,
 * so the recorder, strategies, self-debug checks and toolbox are the same code
 * in both front-ends — and so is the redaction boundary.
 *
 * Lifecycle mirrors the extension's "no always-on capture" rule: the browser is
 * launched on the first tool call that needs it, each triage gets a fresh page
 * and recorder, and everything is closed on close_browser, after an idle
 * timeout, or when the MCP client disconnects. When attached to the engineer's
 * own Chrome (UNBXD_MCP_CDP_URL), only pages this server opened are touched.
 */
import { chromium, devices } from 'playwright-core';
import { CdpSession } from '../../src/capture/cdp.js';
import { Recorder } from '../../src/capture/recorder.js';
import { unbxdApiKind, unbxdAssetKind } from '../../src/shared/unbxd-endpoints.js';

/** Every CDP event the shared capture code listens for. Playwright's CDP
 *  session has no "all events" hook, so they are forwarded by name. */
const FORWARDED_EVENTS = [
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFailed',
  'Network.loadingFinished',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Log.entryAdded',
  'Page.loadEventFired',
  'Page.frameNavigated',
  'CSS.styleSheetAdded'
];

export class PlaywrightCdpSession extends CdpSession {
  constructor(page) {
    super(null);
    this.page = page;
    this.cdp = null;
    this.forwarders = [];
  }

  async attach() {
    if (this.attached) return;
    this.cdp = await this.page.context().newCDPSession(this.page);
    for (const event of FORWARDED_EVENTS) {
      const handler = (params) => {
        for (const fn of this.listeners) fn(event, params);
      };
      this.cdp.on(event, handler);
      this.forwarders.push([event, handler]);
    }
    this.attached = true;
  }

  async detach() {
    if (!this.cdp) return;
    for (const [event, handler] of this.forwarders) this.cdp.off(event, handler);
    this.forwarders = [];
    this.attached = false;
    try {
      await this.cdp.detach();
    } catch {
      /* page already closed */
    }
    this.cdp = null;
  }

  async send(method, params = {}) {
    if (!this.attached) throw new Error(`CDP session not attached (${method})`);
    return this.cdp.send(method, params);
  }
}

/**
 * The extension's Recorder stops recording at 400 requests, which is fine for
 * a short capture window but not for a session the support agent keeps
 * interacting with: a heavy storefront can pass 400 on load alone, and then the
 * search call they trigger next would silently go unrecorded. This evicts the
 * oldest non-Unbxd request instead, so Unbxd API/asset evidence always lands.
 */
const MAX_REQUESTS = 400;
const isUnbxdEvidence = (r) => Boolean(unbxdApiKind(r.rawUrl) || unbxdAssetKind(r.rawUrl));

export class RollingRecorder extends Recorder {
  _handle(method, params) {
    if (method === 'Network.requestWillBeSent' && this.requests.size >= MAX_REQUESTS && !this.requests.has(params.requestId)) {
      for (const [id, r] of this.requests) {
        if (!isUnbxdEvidence(r)) {
          this.requests.delete(id);
          break;
        }
      }
    }
    super._handle(method, params);
  }
}

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const MOBILE = devices['Pixel 7'] || { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 };

export class BrowserManager {
  constructor({ headless = false, channel = 'chrome', executablePath = null, cdpUrl = null, idleMs = 10 * 60 * 1000, log = () => {} } = {}) {
    this.opts = { headless, channel, executablePath, cdpUrl, idleMs };
    this.log = log;
    this.browser = null;
    this.contexts = new Map();
    this.run = null;
    this.idleTimer = null;
  }

  get mode() {
    return this.opts.cdpUrl ? 'attached-to-your-chrome' : this.opts.headless ? 'headless' : 'visible-window';
  }

  async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.contexts.clear();
    const { cdpUrl, headless, channel, executablePath } = this.opts;
    if (cdpUrl) {
      this.browser = await chromium.connectOverCDP(cdpUrl);
      this.log(`Attached to Chrome at ${cdpUrl}`);
      return this.browser;
    }
    const launch = { headless };
    if (executablePath) launch.executablePath = executablePath;
    else if (channel) launch.channel = channel;
    try {
      this.browser = await chromium.launch(launch);
    } catch (err) {
      if (executablePath || !channel) throw err;
      // Installed Chrome not found — fall back to Playwright's own Chromium.
      this.log(`Could not launch channel "${channel}" (${String(err.message).split('\n')[0]}); trying bundled Chromium.`);
      try {
        this.browser = await chromium.launch({ headless });
      } catch (err2) {
        throw new Error(
          `Could not start a browser. Install Google Chrome, or run "npx playwright install chromium" in the mcp/ folder, or set UNBXD_MCP_EXECUTABLE_PATH. (${String(err2.message).split('\n')[0]})`
        );
      }
    }
    this.browser.on('disconnected', () => {
      this.browser = null;
      this.run = null;
      this.contexts.clear();
    });
    this.log(`Launched browser (${this.mode})`);
    return this.browser;
  }

  async contextFor(device) {
    const browser = await this.ensureBrowser();
    if (this.opts.cdpUrl) {
      // The engineer's own profile: reuse its default context so their
      // sign-ins (e.g. a password-protected store) apply.
      return browser.contexts()[0] || browser.newContext();
    }
    if (!this.contexts.has(device)) {
      this.contexts.set(device, await browser.newContext(device === 'mobile' ? { ...MOBILE } : { ...DESKTOP }));
    }
    return this.contexts.get(device);
  }

  /** A fresh page + recorder. The previous run's page is closed first. */
  async newRun({ device = 'desktop' } = {}) {
    await this.closeRun();
    const context = await this.contextFor(device);
    const page = await context.newPage();
    if (this.opts.cdpUrl && device === 'mobile') {
      await page.setViewportSize({ width: MOBILE.viewport.width, height: MOBILE.viewport.height });
    }
    const session = new PlaywrightCdpSession(page);
    await session.attach();
    const recorder = new RollingRecorder(session, { network: true, console: true });
    await recorder.start();
    await session.trySend('Page.enable');
    this.run = { page, session, recorder, device, startedAt: Date.now(), navigated: false, steps: [], toolbox: null, lastTriage: null };
    this.touch();
    return this.run;
  }

  current() {
    if (!this.run || this.run.page.isClosed()) {
      throw new Error('No page is open. Call triage_ui_issue or open_page with a URL first.');
    }
    this.touch();
    return this.run;
  }

  async closeRun() {
    const run = this.run;
    this.run = null;
    if (!run) return;
    run.recorder.stop();
    await run.session.detach();
    await run.page.close().catch(() => {});
  }

  async close() {
    clearTimeout(this.idleTimer);
    await this.closeRun();
    if (!this.browser) return;
    const b = this.browser;
    this.browser = null;
    this.contexts.clear();
    // For an attached Chrome this only disconnects; the engineer's tabs stay.
    await b.close().catch(() => {});
    this.log('Browser closed');
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.log('Idle timeout — closing browser');
      this.close().catch(() => {});
    }, this.opts.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }
}
