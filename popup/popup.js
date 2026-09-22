import { ISSUE_TYPE_LIST, DEFAULT_ISSUE_TYPE, getIssueType } from '../src/shared/issue-types.js';
import { PROVIDERS, getSettings, saveSettings } from '../src/shared/settings.js';

const $ = (id) => document.getElementById(id);
const state = { tabId: null, recording: false, ticker: null };

/* ---------- tabs ---------- */
function showTab(name) {
  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.tab === name);
  }
  $('panel-debug').hidden = name !== 'debug';
  $('panel-settings').hidden = name !== 'settings';
}
document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((el) =>
  el.addEventListener('click', (e) => {
    e.preventDefault();
    showTab(el.dataset.goto);
  })
);

/* ---------- messaging ---------- */
async function send(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res) throw new Error('Background worker did not respond.');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

/* ---------- debug tab ---------- */
function renderIssueTypes(selected) {
  const sel = $('issue-type');
  sel.innerHTML = '';
  for (const t of ISSUE_TYPE_LIST) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    sel.append(opt);
  }
  sel.value = selected || DEFAULT_ISSUE_TYPE;
  onIssueTypeChange();
}

function onIssueTypeChange() {
  const type = getIssueType($('issue-type').value);
  $('issue-hint').textContent = type.hint;
  $('selector-overrides').hidden = !type.capture.domGeometry;
  // Auto-stop only means anything for issue types with a deterministic
  // self-debug procedure (results pages, autosuggest data) — hide the
  // control entirely rather than show a toggle that does nothing.
  $('auto-stop-row').hidden = !type.capture.selfDebugKind;
  chrome.storage.local.set({ lastIssueType: type.id });
}
$('issue-type').addEventListener('change', onIssueTypeChange);

// Toggling in the popup is a real preference change, not a per-run override.
$('agent-mode').addEventListener('change', () => {
  saveSettings({ agentMode: $('agent-mode').checked }).catch(() => {});
});
$('auto-stop').addEventListener('change', () => {
  saveSettings({ autoStop: $('auto-stop').checked }).catch(() => {});
});

function setRecording(on, startedAt, autoStopArmed = false) {
  state.recording = on;
  $('start').hidden = on;
  $('stop').hidden = !on;
  $('cancel').hidden = !on;
  $('issue-type').disabled = on;
  clearInterval(state.ticker);
  if (on) {
    const t0 = startedAt || Date.now();
    const suffix = autoStopArmed ? ' — will stop itself once the evidence is conclusive' : '';
    const tick = () => setStatus(
      `Recording — reproduce the issue on the page${suffix}. (${Math.round((Date.now() - t0) / 1000)}s)`,
      'recording'
    );
    tick();
    state.ticker = setInterval(tick, 1000);
  }
}

$('start').addEventListener('click', async () => {
  try {
    const type = getIssueType($('issue-type').value);
    const autoStopArmed = Boolean(type.capture.selfDebugKind) && $('auto-stop').checked;
    await send({
      type: 'capture.start',
      tabId: state.tabId,
      issueTypeId: $('issue-type').value,
      reload: $('reload-on-start').checked,
      description: $('description').value
    });
    $('result').hidden = true;
    setRecording(true, Date.now(), autoStopArmed);
  } catch (err) {
    setStatus(String(err.message), 'error');
  }
});

$('cancel').addEventListener('click', async () => {
  await send({ type: 'capture.cancel' }).catch(() => {});
  setRecording(false);
  setStatus('Capture cancelled. Nothing was sent.');
});

$('stop').addEventListener('click', async () => {
  const stop = $('stop');
  stop.disabled = true;
  clearInterval(state.ticker);
  setStatus($('agent-mode').checked
    ? 'Capturing context, then investigating with tools…'
    : 'Capturing context and asking the model…');
  try {
    const record = await send({
      type: 'capture.stop',
      issueTypeId: $('issue-type').value,
      description: $('description').value,
      agentMode: $('agent-mode').checked,
      options: {
        inputSelector: $('input-selector').value.trim() || null,
        dropdownSelector: $('dropdown-selector').value.trim() || null
      }
    });
    setRecording(false);
    renderResult(record);
    setStatus('');
  } catch (err) {
    setRecording(false);
    setStatus(String(err.message), 'error');
  } finally {
    stop.disabled = false;
  }
});

/* ---------- live investigation trace ---------- */
// The service worker streams tool calls while the model investigates, so the
// engineer can watch it work instead of staring at a spinner.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'agent.step') {
    const step = msg.step;
    if (step.type === 'tool_start') {
      setStatus(`Investigating — ${step.name}(${summariseArgs(step.input)})`);
    } else if (step.type === 'thought' && step.text) {
      setStatus(`Investigating — ${step.text.slice(0, 120)}`);
    }
    return;
  }
  // The background stopped and analysed on its own — this popup never sent
  // capture.stop, so it would otherwise sit showing "Recording…" forever.
  if (msg.type === 'capture.autostopped' && state.recording) {
    setRecording(false);
    renderResult(msg.record);
    setStatus('Stopped automatically — the evidence was conclusive.');
    return;
  }
  if (msg.type === 'capture.autostop-error' && state.recording) {
    setRecording(false);
    setStatus(`Auto-stopped, but analysis failed: ${msg.error}`, 'error');
  }
});

function summariseArgs(input) {
  if (!input || !Object.keys(input).length) return '';
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
    .join(', ')
    .slice(0, 80);
}

function renderTrace(agent) {
  const box = $('trace-box');
  const list = $('trace');
  list.textContent = '';
  const steps = (agent && agent.steps) || [];
  const toolSteps = steps.filter((s) => s.type === 'tool');
  if (!toolSteps.length) {
    box.hidden = true;
    return;
  }
  $('trace-count').textContent = String(toolSteps.length);
  for (const s of steps) {
    const row = document.createElement('div');
    row.className = 'trace-step';
    if (s.type === 'tool') {
      const name = document.createElement('code');
      name.textContent = s.name;
      const args = document.createElement('span');
      args.className = 'args';
      args.textContent = ` ${summariseArgs(s.input)}`;
      row.append(name, args);
    } else {
      row.textContent = s.text;
    }
    list.append(row);
  }
  box.hidden = false;
}

/** Splits the model's "**Fix prompt**" section out of the answer so it can be
 *  copied on its own — it is addressed to a coding agent, not to the ticket. */
function splitFixPrompt(answer = '') {
  const match = answer.match(/\*\*Fix prompt\*\*\s*\n?([\s\S]*)$/i);
  if (!match) return { body: answer, fixPrompt: '' };
  return {
    body: answer.slice(0, match.index).trimEnd(),
    fixPrompt: match[1].trim()
  };
}

/** The extension's own checks, shown above the model's answer — these are
 *  deterministic, so the engineer can trust them independently of the LLM. */
function renderVerdicts(context) {
  const box = $('verdicts');
  box.textContent = '';
  const checks = context && context.selfDebug ? context.selfDebug.checks : null;
  if (!checks || !checks.length) {
    box.hidden = true;
    return;
  }
  for (const c of checks) {
    if (c.status === 'skip') continue;
    const row = document.createElement('div');
    row.className = 'verdict-row';
    const tag = document.createElement('span');
    tag.className = `tag ${c.status}`;
    tag.textContent = c.status.toUpperCase();
    const text = document.createElement('span');
    text.textContent = c.status === 'pass' ? c.title : `${c.title} — ${c.detail}`;
    row.append(tag, text);
    box.append(row);
  }
  box.hidden = !box.childElementCount;
}

function renderResult(record) {
  $('result').hidden = false;
  renderVerdicts(record.context);
  renderTrace(record.agent);
  const { body, fixPrompt } = splitFixPrompt(record.answer || '');
  $('answer').textContent = body || '(empty response)';
  $('fix-prompt').textContent = fixPrompt;
  $('fix-prompt-box').hidden = !fixPrompt;
  $('sent-prompt').textContent = record.prompt;
  $('captured').textContent = JSON.stringify(record.context, null, 2);
  const usage = record.usage
    ? `${record.usage.input_tokens ?? record.usage.prompt_tokens ?? '?'} in / ${
        record.usage.output_tokens ?? record.usage.completion_tokens ?? '?'} out`
    : `~${record.stats.totalTokens} est. tokens`;
  const agentBit = record.agent ? ` · ${record.agent.iterations} step${record.agent.iterations === 1 ? '' : 's'}` : '';
  $('result-meta').textContent = `${record.model} · ${usage}${agentBit}`;
}

function wireCopy(buttonId, getText) {
  $(buttonId).addEventListener('click', async () => {
    await navigator.clipboard.writeText(getText());
    $(buttonId).textContent = 'Copied';
    setTimeout(() => ($(buttonId).textContent = 'Copy'), 1200);
  });
}

// "Copy" gives the ticket-ready analysis; "Copy" on the fix prompt gives just
// the agent instructions, which is what gets pasted somewhere else entirely.
wireCopy('copy', () => $('answer').textContent);
wireCopy('copy-fix', () => $('fix-prompt').textContent);

/* ---------- settings tab ---------- */
function renderProviderOptions(settings) {
  const providerSel = $('provider');
  providerSel.innerHTML = '';
  for (const p of Object.values(PROVIDERS)) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    providerSel.append(opt);
  }
  providerSel.value = settings.provider;
  renderModels(settings);
  $('api-key').value = settings.apiKeys[settings.provider] || '';
  $('max-tokens').value = settings.maxPromptTokens;
}

function renderModels(settings) {
  const provider = PROVIDERS[$('provider').value];
  const modelSel = $('model');
  modelSel.innerHTML = '';
  for (const m of provider.models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modelSel.append(opt);
  }
  modelSel.value = provider.models.includes(settings.model) ? settings.model : provider.defaultModel;
  $('api-key').placeholder = provider.keyPlaceholder;
  $('key-help').innerHTML = `— <a class="link" href="${provider.keysUrl}" target="_blank">get one</a>`;
}

$('provider').addEventListener('change', async () => {
  const settings = await getSettings();
  renderModels(settings);
  $('api-key').value = settings.apiKeys[$('provider').value] || '';
});

$('save').addEventListener('click', async () => {
  const settings = await getSettings();
  const provider = $('provider').value;
  await saveSettings({
    provider,
    model: $('model').value,
    apiKeys: { ...settings.apiKeys, [provider]: $('api-key').value.trim() },
    maxPromptTokens: Number($('max-tokens').value) || settings.maxPromptTokens
  });
  $('settings-status').textContent = 'Saved.';
  setTimeout(() => ($('settings-status').textContent = ''), 1500);
  refreshKeyWarning();
});

$('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

async function refreshKeyWarning() {
  const settings = await getSettings();
  const missing = !settings.apiKeys[settings.provider];
  $('key-warning').hidden = !missing;
  $('key-warning-provider').textContent = PROVIDERS[settings.provider].label;
  $('start').disabled = missing;
}

/* ---------- init ---------- */
(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab ? tab.id : null;

  const settings = await getSettings();
  renderProviderOptions(settings);
  // Reflect the stored preference rather than the HTML default, so a choice
  // made on the options page actually holds.
  $('agent-mode').checked = settings.agentMode !== false;
  $('auto-stop').checked = settings.autoStop !== false;

  const stored = await chrome.storage.local.get(['lastIssueType', 'lastAnalysis', 'lastAutoStopError']);
  renderIssueTypes(stored.lastIssueType);
  await refreshKeyWarning();

  const status = await send({ type: 'capture.status' }).catch(() => ({ recording: false }));
  if (status.recording) {
    $('issue-type').value = status.issueTypeId;
    onIssueTypeChange();
    const type = getIssueType(status.issueTypeId);
    const autoStopArmed = Boolean(type.capture.selfDebugKind) && settings.autoStop !== false;
    setRecording(true, Date.now() - status.elapsedMs, autoStopArmed);
  } else if (stored.lastAnalysis) {
    renderResult(stored.lastAnalysis);
    const when = new Date(stored.lastAnalysis.createdAt).toLocaleTimeString();
    setStatus(
      stored.lastAnalysis.autoStopped
        ? `Stopped itself and analysed automatically at ${when}.`
        : `Showing the previous analysis (${when}).`
    );
  } else if (stored.lastAutoStopError && Date.now() - stored.lastAutoStopError.at < 10 * 60 * 1000) {
    // Auto-stop fired while the popup was closed and the analysis call
    // itself failed (e.g. bad key) — nothing else could have shown this.
    setStatus(`The capture stopped automatically, but analysis failed: ${stored.lastAutoStopError.message}`, 'error');
  }
  chrome.storage.local.remove('lastAutoStopError');

  if (!tab || /^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    $('start').disabled = true;
    setStatus('Open the site you are debugging in this tab — the debugger cannot attach to browser pages.', 'error');
  }
})();
