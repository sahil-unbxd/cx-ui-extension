/** Records network + console events for the lifetime of one capture session.
 *
 *  Only metadata is retained. Response bodies are fetched lazily and only for
 *  the search API call of an SRP capture (see strategies.js), never in bulk.
 */
import { redactHeaders, redactUrl, truncate } from './redact.js';

const MAX_REQUESTS = 400;
const MAX_CONSOLE = 120;

export class Recorder {
  constructor(session, { network = true, console: wantConsole = true } = {}) {
    this.session = session;
    this.want = { network, console: wantConsole };
    this.requests = new Map(); // requestId -> record
    this.consoleEntries = [];
    this.pageErrors = [];
    this.startedAt = Date.now();
    this.off = null;
  }

  async start() {
    const s = this.session;
    if (this.want.network) {
      await s.trySend('Network.enable', { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 });
    }
    if (this.want.console) {
      await s.trySend('Runtime.enable');
      await s.trySend('Log.enable');
    }
    this.off = s.on((method, params) => this._handle(method, params));
  }

  stop() {
    if (this.off) this.off();
    this.off = null;
  }

  _handle(method, params) {
    switch (method) {
      case 'Network.requestWillBeSent': {
        if (this.requests.size >= MAX_REQUESTS) return;
        this.requests.set(params.requestId, {
          requestId: params.requestId,
          url: redactUrl(params.request.url),
          rawUrl: params.request.url,
          method: params.request.method,
          type: params.type,
          initiator: params.initiator && params.initiator.type,
          requestHeaders: redactHeaders(params.request.headers),
          hasPostData: Boolean(params.request.hasPostData),
          startedAt: params.timestamp,
          status: null,
          statusText: null,
          responseHeaders: null,
          mimeType: null,
          fromCache: false,
          failed: false,
          errorText: null,
          corsError: null,
          blockedReason: null,
          durationMs: null
        });
        break;
      }
      case 'Network.responseReceived': {
        const rec = this.requests.get(params.requestId);
        if (!rec) return;
        rec.status = params.response.status;
        rec.statusText = params.response.statusText;
        rec.mimeType = params.response.mimeType;
        rec.fromCache = Boolean(params.response.fromDiskCache);
        rec.remoteIPAddress = params.response.remoteIPAddress || null;
        rec.responseHeaders = redactHeaders(params.response.headers);
        rec.durationMs = Math.round((params.timestamp - rec.startedAt) * 1000);
        break;
      }
      case 'Network.loadingFailed': {
        const rec = this.requests.get(params.requestId);
        if (!rec) return;
        rec.failed = true;
        rec.errorText = params.errorText;
        rec.blockedReason = params.blockedReason || null;
        rec.corsError = params.corsErrorStatus ? params.corsErrorStatus.corsError : null;
        rec.durationMs = Math.round((params.timestamp - rec.startedAt) * 1000);
        break;
      }
      case 'Runtime.consoleAPICalled': {
        if (!['error', 'warning', 'assert'].includes(params.type)) return;
        this._pushConsole({
          level: params.type,
          source: 'console',
          text: truncate((params.args || []).map(argToText).join(' '), 400),
          url: firstFrameUrl(params.stackTrace)
        });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        this.pageErrors.push({
          level: 'error',
          source: 'exception',
          text: truncate(
            (d.exception && (d.exception.description || d.exception.value)) || d.text || 'Uncaught error',
            600
          ),
          url: d.url || firstFrameUrl(d.stackTrace),
          line: d.lineNumber
        });
        if (this.pageErrors.length > MAX_CONSOLE) this.pageErrors.shift();
        break;
      }
      case 'Log.entryAdded': {
        const e = params.entry || {};
        if (!['error', 'warning'].includes(e.level)) return;
        this._pushConsole({
          level: e.level,
          source: e.source,
          text: truncate(e.text, 400),
          url: e.url ? redactUrl(e.url) : null
        });
        break;
      }
      default:
        break;
    }
  }

  _pushConsole(entry) {
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > MAX_CONSOLE) this.consoleEntries.shift();
  }

  all() {
    return [...this.requests.values()];
  }

  /** Requests that failed outright, were blocked, or returned >= 400. */
  problems() {
    return this.all().filter((r) => r.failed || (r.status != null && r.status >= 400));
  }

  summary() {
    const all = this.all();
    const byStatus = {};
    for (const r of all) {
      const k = r.failed ? `failed:${r.errorText || 'unknown'}` : String(r.status ?? 'pending');
      byStatus[k] = (byStatus[k] || 0) + 1;
    }
    return {
      durationMs: Date.now() - this.startedAt,
      totalRequests: all.length,
      byStatus,
      consoleErrors: this.consoleEntries.filter((c) => c.level === 'error').length + this.pageErrors.length,
      consoleWarnings: this.consoleEntries.filter((c) => c.level === 'warning').length
    };
  }
}

function argToText(arg) {
  if (!arg) return '';
  if ('value' in arg && typeof arg.value !== 'object') return String(arg.value);
  return arg.description || arg.className || arg.type || '';
}

function firstFrameUrl(stackTrace) {
  const frame = stackTrace && stackTrace.callFrames && stackTrace.callFrames[0];
  return frame ? redactUrl(frame.url) : null;
}
