import { PROVIDERS, getSettings, saveSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';

const $ = (id) => document.getElementById(id);

function fillSelect(sel, values) {
  sel.innerHTML = '';
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = typeof v === 'string' ? v : v.id;
    opt.textContent = typeof v === 'string' ? v : v.label;
    sel.append(opt);
  }
}

async function render() {
  const s = await getSettings();
  fillSelect($('provider'), Object.values(PROVIDERS));
  $('provider').value = s.provider;
  renderModels(s.model);
  $('key-claude').value = s.apiKeys.claude || '';
  $('key-openai').value = s.apiKeys.openai || '';
  $('max-tokens').value = s.maxPromptTokens;
}

function renderModels(current) {
  const provider = PROVIDERS[$('provider').value];
  fillSelect($('model'), provider.models);
  $('model').value = provider.models.includes(current) ? current : provider.defaultModel;
}

$('provider').addEventListener('change', () => renderModels($('model').value));

$('save').addEventListener('click', async () => {
  await saveSettings({
    provider: $('provider').value,
    model: $('model').value,
    apiKeys: { claude: $('key-claude').value.trim(), openai: $('key-openai').value.trim() },
    maxPromptTokens: Number($('max-tokens').value) || DEFAULT_SETTINGS.maxPromptTokens
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
