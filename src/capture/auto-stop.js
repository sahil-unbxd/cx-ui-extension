/**
 * Watches a live capture for the moment there is enough evidence to stop
 * without the engineer clicking "Stop & analyse" — for the issue types that
 * have a deterministic self-debug procedure: SRP/PLP results pages and
 * autosuggest data. The alignment issue type has no equivalent "we now have
 * the full picture" signal (a layout mismatch doesn't resolve to a terminal
 * check the way an API→DOM chain does), so this watcher is only created for
 * `selfDebugKind` results_page / autosuggest_data — see service-worker.js.
 *
 * Design: event-driven and debounced, not a busy poll. Each time the
 * relevant Unbxd API call (search/category, or autosuggest) finishes
 * loading, wait a short settle window for the DOM to re-render, then run the
 * *same* self-debug check the one-shot path runs — via the toolbox, so there
 * is exactly one implementation of each check, never a second copy that could
 * drift from it. If the result is conclusive, `onReady` fires exactly once.
 *
 * "Conclusive" is deliberately not "everything passed": any FAIL anywhere in
 * the check set is conclusive on its own (a root cause was found — no reason
 * to keep recording), and so is the terminal check (the one that needs the
 * full API-response-to-DOM picture: api_results_rendered /
 * popular_products_rendered) reaching a real pass/fail rather than a skip. A
 * WARN elsewhere (e.g. a duplicate API call) doesn't block stopping — it is
 * still in the evidence the model sees, it just isn't itself a reason to keep
 * the debugger attached.
 */
import { createToolbox } from './toolbox.js';
import { unbxdApiKind } from '../shared/unbxd-endpoints.js';

const SETTLE_MS = 800;

const CONFIG_BY_KIND = {
  results_page: { apiKinds: ['search', 'category'], probeTool: 'run_self_debug', terminalCheckId: 'api_results_rendered' },
  autosuggest_data: { apiKinds: ['autosuggest'], probeTool: 'run_autosuggest_self_debug', terminalCheckId: 'popular_products_rendered' }
};

export function createAutoStopWatcher({ session, recorder, selfDebugKind, onReady }) {
  const config = CONFIG_BY_KIND[selfDebugKind];
  if (!config) return null; // this issue type has no conclusive procedure to watch for

  const toolbox = createToolbox({ session, recorder });
  let settleTimer = null;
  let probing = false;
  let fired = false;

  async function probe() {
    if (fired || probing) return;
    probing = true;
    try {
      const result = await toolbox.run(config.probeTool, {});
      if (fired) return; // disposed, or another probe already concluded, while this one was in flight
      if (isConclusive(result, config.terminalCheckId)) {
        fired = true;
        onReady(result);
      }
    } catch {
      /* a probe failure isn't fatal — recording continues and the next relevant event retries */
    } finally {
      probing = false;
    }
  }

  const off = session.on((method, params) => {
    if (fired || method !== 'Network.loadingFinished') return;
    const req = recorder.all().find((r) => r.requestId === params.requestId);
    if (!req || !config.apiKinds.includes(unbxdApiKind(req.rawUrl))) return;
    // Debounced: a burst of rapid calls (autosuggest firing on every
    // keystroke) collapses into one probe after things settle, not one per call.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(probe, SETTLE_MS);
  });

  return {
    dispose() {
      fired = true; // stop any in-flight or pending probe from acting after disposal
      clearTimeout(settleTimer);
      off();
    }
  };
}

function isConclusive(selfDebugResult, terminalCheckId) {
  if (!selfDebugResult || !selfDebugResult.summary || !Array.isArray(selfDebugResult.checks)) return false;
  if (selfDebugResult.summary.firstFailure) return true;
  const terminal = selfDebugResult.checks.find((c) => c.id === terminalCheckId);
  return Boolean(terminal && terminal.status !== 'skip');
}
