/** Thin promise wrapper around chrome.debugger.
 *
 *  Attachment is explicit and always paired with a detach: there is no
 *  always-on capture in this extension. A session exists only between the
 *  engineer pressing "Start capture" and "Stop & analyse" (or the timeout).
 */

const VERSION = '1.3';

export class CdpSession {
  constructor(tabId) {
    this.target = { tabId };
    this.attached = false;
    this.listeners = new Set();
    this._onEvent = (source, method, params) => {
      if (source.tabId !== this.target.tabId) return;
      for (const fn of this.listeners) fn(method, params);
    };
    this._onDetach = (source) => {
      if (source.tabId === this.target.tabId) this.attached = false;
    };
  }

  async attach() {
    if (this.attached) return;
    await chrome.debugger.attach(this.target, VERSION);
    this.attached = true;
    chrome.debugger.onEvent.addListener(this._onEvent);
    chrome.debugger.onDetach.addListener(this._onDetach);
  }

  async detach() {
    chrome.debugger.onEvent.removeListener(this._onEvent);
    chrome.debugger.onDetach.removeListener(this._onDetach);
    if (!this.attached) return;
    this.attached = false;
    try {
      await chrome.debugger.detach(this.target);
    } catch {
      /* tab closed or devtools took over; nothing to clean up */
    }
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async send(method, params = {}) {
    if (!this.attached) throw new Error(`CDP session not attached (${method})`);
    return chrome.debugger.sendCommand(this.target, method, params);
  }

  /** Commands that are nice-to-have: a failure must not kill the capture. */
  async trySend(method, params = {}) {
    try {
      return await this.send(method, params);
    } catch (err) {
      return { __error: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Reload the page and resolve once it has loaded (or after `timeoutMs`).
   *
   * Step one of the self-debug procedure: recording only catches what happens
   * inside the capture window, and the SDK bundles plus the first API call
   * normally happen at page load — i.e. before the engineer pressed Start.
   * Reloading makes that evidence present instead of merely "not observed".
   */
  async reload({ timeoutMs = 15000 } = {}) {
    await this.trySend('Page.enable');
    const loaded = new Promise((resolve) => {
      const done = () => {
        this.listeners.delete(onEvent);
        clearTimeout(timer);
        resolve(true);
      };
      const onEvent = (method) => {
        if (method === 'Page.loadEventFired') done();
      };
      const timer = setTimeout(() => {
        this.listeners.delete(onEvent);
        resolve(false);
      }, timeoutMs);
      this.listeners.add(onEvent);
    });

    const res = await this.trySend('Page.reload', { ignoreCache: false });
    if (res && res.__error) return { reloaded: false, error: res.__error };
    const completed = await loaded;
    // Give the SDK a moment to initialise and fire its first call after load.
    await new Promise((r) => setTimeout(r, completed ? 1200 : 400));
    return { reloaded: true, loadEventFired: completed };
  }

  /** Evaluate an expression in the page and return the JSON value. */
  async evaluate(expression) {
    const res = await this.trySend('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res && res.__error) return null;
    return res && res.result ? res.result.value : null;
  }
}
