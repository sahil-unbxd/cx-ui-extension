/** Orchestrates one capture session at a time.
 *
 *  Lifecycle: popup sends `capture.start` -> debugger attaches and the recorder
 *  runs while the engineer reproduces the issue -> `capture.stop` runs the
 *  issue-type strategy, detaches, builds the prompt and calls the model.
 *  The debugger is never attached outside that window.
 */
import { CdpSession } from '../capture/cdp.js';
import { Recorder } from '../capture/recorder.js';
import { runStrategy } from '../capture/strategies.js';
import { buildPrompt } from '../prompt/builder.js';
import { complete } from '../llm/client.js';
import { getIssueType } from '../shared/issue-types.js';
import { getSettings } from '../shared/settings.js';

const HARD_STOP_MS = 5 * 60 * 1000; // never hold the debugger longer than this

/** @type {{tabId:number, issueTypeId:string, session:CdpSession, recorder:Recorder, startedAt:number, timer:any}|null} */
let active = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // async response
});

async function handle(msg) {
  switch (msg.type) {
    case 'capture.start':
      return startCapture(msg);
    case 'capture.stop':
      return stopAndAnalyse(msg);
    case 'capture.cancel':
      return cancelCapture();
    case 'capture.status':
      return status();
    default:
      throw new Error(`Unknown message: ${msg.type}`);
  }
}

function status() {
  if (!active) return { recording: false };
  return {
    recording: true,
    tabId: active.tabId,
    issueTypeId: active.issueTypeId,
    elapsedMs: Date.now() - active.startedAt,
    summary: active.recorder.summary()
  };
}

async function startCapture({ tabId, issueTypeId }) {
  if (active) await cancelCapture();

  const type = getIssueType(issueTypeId);
  const session = new CdpSession(tabId);
  await session.attach();

  const recorder = new Recorder(session, {
    // Network is recorded for every issue type, not just the ones whose
    // capture.network flag is set: the "validate first" SDK-asset check
    // (search.js/autosuggest.js/their CSS — see sdk-assets.js) runs
    // unconditionally and needs it. Per-type strategies still decide what,
    // if anything, beyond that gets forwarded into the prompt.
    network: true,
    console: type.capture.console
  });
  await recorder.start();

  active = {
    tabId,
    issueTypeId: type.id,
    session,
    recorder,
    startedAt: Date.now(),
    timer: setTimeout(() => {
      // Safety net: a forgotten session must not keep the debugger banner up.
      cancelCapture().catch(() => {});
    }, HARD_STOP_MS)
  };

  await setBadge(tabId, 'REC');
  return { recording: true, issueTypeId: type.id, hardStopMs: HARD_STOP_MS };
}

async function stopAndAnalyse({ description, issueTypeId, options }) {
  if (!active) throw new Error('No capture is running. Press "Start capture" first.');
  const { session, recorder, tabId } = active;
  const typeId = issueTypeId || active.issueTypeId;

  let context;
  try {
    recorder.stop();
    context = await runStrategy(typeId, session, recorder, options || {});
  } finally {
    clearTimeout(active.timer);
    await session.detach();
    await setBadge(tabId, '');
    active = null;
  }

  const settings = await getSettings();
  const pageUrl = await tabUrl(tabId);
  const prompt = await buildPrompt({
    issueTypeId: typeId,
    description,
    context,
    pageUrl,
    maxTokens: settings.maxPromptTokens
  });

  const apiKey = settings.apiKeys[settings.provider];
  const answer = await complete({
    provider: settings.provider,
    model: settings.model,
    apiKey,
    system: prompt.system,
    user: prompt.user
  });

  const record = {
    createdAt: Date.now(),
    issueTypeId: typeId,
    pageUrl,
    description,
    stats: prompt.stats,
    provider: answer.provider,
    model: answer.model,
    usage: answer.usage,
    answer: answer.text,
    context,
    prompt: prompt.user
  };
  await chrome.storage.local.set({ lastAnalysis: record });
  return record;
}

async function cancelCapture() {
  if (!active) return { recording: false };
  clearTimeout(active.timer);
  active.recorder.stop();
  await active.session.detach();
  await setBadge(active.tabId, '');
  active = null;
  return { recording: false };
}

async function tabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url;
  } catch {
    return null;
  }
}

async function setBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' });
  } catch {
    /* tab may already be gone */
  }
}

// If the debugged tab goes away, drop the session rather than leaking it.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (active && active.tabId === tabId) cancelCapture().catch(() => {});
});
