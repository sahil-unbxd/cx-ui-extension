/** chrome.storage.local access. The API key never leaves this machine except in
 *  the request to Google. No sync storage: keys must not ride the Chrome
 *  profile to other devices.
 *
 *  The model is Gemini only. Two ways to reach it, same request body:
 *    vertex    Vertex AI on the company's Google Cloud project — the enterprise
 *              path (project ID + region + a Vertex AI API key). With no
 *              project set, the key is used in Vertex AI express mode.
 *    aistudio  The Gemini API with a key from Google AI Studio.
 */

export const GEMINI = {
  label: 'Gemini',
  // Model availability differs by project and region, so the field is free
  // text; these are only suggestions. Check the IDs enabled for your project.
  defaultModel: 'gemini-2.5-pro',
  suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview', 'gemini-3-flash-preview'],
  endpoints: {
    vertex: {
      id: 'vertex',
      label: 'Vertex AI (Google Cloud project)',
      keyPlaceholder: 'Vertex AI API key',
      keysUrl: 'https://console.cloud.google.com/vertex-ai'
    },
    aistudio: {
      id: 'aistudio',
      label: 'Gemini API (Google AI Studio key)',
      keyPlaceholder: 'AIza…',
      keysUrl: 'https://aistudio.google.com/apikey'
    }
  }
};

export const DEFAULT_SETTINGS = {
  model: GEMINI.defaultModel,
  gemini: {
    endpoint: 'vertex',
    apiKey: '',
    project: '',
    // "global" is where new Gemini models usually land first.
    location: 'global'
  },
  captureSeconds: 20,
  // Raised alongside retrieval: the fixed prompt now carries targeted
  // reference excerpts, and the captured context still needs room under it.
  maxPromptTokens: 16000,
  // Who the answer is written for. 'support' gets an escalate/don't-escalate
  // verdict and a ticket draft; 'engineering' gets the root-cause write-up.
  audience: 'support',
  // Agent mode keeps the debugger attached and lets the model investigate with
  // tools instead of answering from one static capture. Off by default: it
  // costs several extra model round-trips, and for routine triage the
  // deterministic checks, known-issue matching and retrieved reference usually
  // settle it. Turn it on for the cases they don't.
  agentMode: false,
  // Auto-stop: for issue types with a deterministic self-debug procedure
  // (results pages, autosuggest data), stop and analyse automatically once
  // the evidence is conclusive — no manual "Stop & analyse" click needed.
  // Has no effect on issue types without one (autosuggest alignment).
  autoStop: true
};

/** Keys from the Claude/OpenAI era. Removed from storage on first read so no
 *  unused third-party secret is left sitting in the profile. */
const RETIRED_KEYS = ['provider', 'apiKeys'];

export async function getSettings() {
  const stored = (await chrome.storage.local.get('settings')).settings || {};
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  settings.gemini = { ...DEFAULT_SETTINGS.gemini, ...(stored.gemini || {}) };
  if (typeof settings.model !== 'string' || !/gemini/i.test(settings.model)) settings.model = GEMINI.defaultModel;

  if (RETIRED_KEYS.some((k) => k in stored)) {
    for (const k of RETIRED_KEYS) delete settings[k];
    await chrome.storage.local.set({ settings });
  }
  return settings;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch, gemini: { ...current.gemini, ...(patch.gemini || {}) } };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** What the LLM client needs to reach Gemini. */
export function geminiConnection(settings) {
  const g = settings.gemini || DEFAULT_SETTINGS.gemini;
  return {
    endpoint: g.endpoint === 'aistudio' ? 'aistudio' : 'vertex',
    apiKey: (g.apiKey || '').trim(),
    project: (g.project || '').trim(),
    location: (g.location || 'global').trim() || 'global'
  };
}

export function isConfigured(settings) {
  return Boolean(geminiConnection(settings).apiKey);
}
