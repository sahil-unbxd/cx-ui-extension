/** chrome.storage.local access. The API key never leaves this machine except in
 *  the request to the provider the engineer chose. No sync storage: keys must
 *  not ride the Chrome profile to other devices. */

export const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude (Anthropic)',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    keyPlaceholder: 'sk-ant-...',
    keysUrl: 'https://console.anthropic.com/settings/keys'
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4.1',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
    keyPlaceholder: 'sk-...',
    keysUrl: 'https://platform.openai.com/api-keys'
  }
};

export const DEFAULT_SETTINGS = {
  provider: 'claude',
  model: PROVIDERS.claude.defaultModel,
  apiKeys: { claude: '', openai: '' },
  captureSeconds: 20,
  maxPromptTokens: 12000,
  // Agent mode keeps the debugger attached and lets the model investigate with
  // tools instead of answering from one static capture.
  agentMode: true,
  // Auto-stop: for issue types with a deterministic self-debug procedure
  // (results pages, autosuggest data), stop and analyse automatically once
  // the evidence is conclusive — no manual "Stop & analyse" click needed.
  // Has no effect on issue types without one (proxy/access, alignment).
  autoStop: true
};

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  settings.apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(settings.apiKeys || {}) };
  return settings;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function hasActiveKey() {
  const s = await getSettings();
  return Boolean(s.apiKeys[s.provider]);
}
