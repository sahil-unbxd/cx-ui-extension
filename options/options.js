import { GEMINI, getSettings, saveSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';

const $ = (id) => document.getElementById(id);

async function render() {
  const s = await getSettings();

  const endpointSel = $('endpoint');
  endpointSel.innerHTML = '';
  for (const e of Object.values(GEMINI.endpoints)) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.label;
    endpointSel.append(opt);
  }
  endpointSel.value = s.gemini.endpoint;
  $('project').value = s.gemini.project || '';
  $('location').value = s.gemini.location || 'global';
  $('api-key').value = s.gemini.apiKey || '';

  const list = $('model-list');
  list.innerHTML = '';
  for (const m of GEMINI.suggestedModels) {
    const opt = document.createElement('option');
    opt.value = m;
    list.append(opt);
  }
  $('model').value = s.model;

  $('max-tokens').value = s.maxPromptTokens;
  $('agent-mode').checked = s.agentMode !== false;
  $('auto-stop').checked = s.autoStop !== false;
  renderEndpoint();
}

/** Project/location only apply to Vertex AI. */
function renderEndpoint() {
  const endpoint = GEMINI.endpoints[$('endpoint').value];
  $('vertex-fields').hidden = endpoint.id !== 'vertex';
  $('api-key').placeholder = endpoint.keyPlaceholder;
  $('key-help').innerHTML = `<a class="link" href="${endpoint.keysUrl}" target="_blank">get one</a>`;
}

$('endpoint').addEventListener('change', renderEndpoint);

$('save').addEventListener('click', async () => {
  await saveSettings({
    model: $('model').value.trim() || GEMINI.defaultModel,
    gemini: {
      endpoint: $('endpoint').value,
      project: $('project').value.trim(),
      location: $('location').value.trim() || 'global',
      apiKey: $('api-key').value.trim()
    },
    maxPromptTokens: Number($('max-tokens').value) || DEFAULT_SETTINGS.maxPromptTokens,
    agentMode: $('agent-mode').checked,
    autoStop: $('auto-stop').checked
  });
  $('status').textContent = 'Saved.';
  setTimeout(() => ($('status').textContent = ''), 1500);
});

$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove(['settings', 'lastAnalysis']);
  await render();
  $('status').textContent = 'Cleared.';
});

render();
