/**
 * "Validate first": before reasoning about any specific symptom, check whether
 * the Unbxd widget's own script/style bundles actually loaded. A blocked or
 * 404'd search.js/autosuggest.js/*.css explains almost any downstream symptom
 * (broken search, misaligned autosuggest, missing SRP UI) more directly than
 * the issue-specific signal does — so this runs unconditionally, for every
 * issue type, and is merged into every capture's context (see
 * runStrategy() in strategies.js).
 *
 * This only reports load status/timing for a fixed, known set of Unbxd asset
 * URLs (see src/shared/unbxd-endpoints.js) — never page data — so it does not
 * reopen the "no API payloads for alignment issues" boundary.
 */
import { unbxdAssetKind } from '../shared/unbxd-endpoints.js';

const EXPECTED_KINDS = ['search.js', 'autosuggest.js', 'search.css', 'autosuggest.css', 'sdk.js', 'sdk.css'];

export function captureSdkAssets(recorder) {
  const detected = {};
  for (const r of recorder.all()) {
    const kind = unbxdAssetKind(r.rawUrl);
    if (!kind) continue;
    // Last sighting wins (a page can re-request the same bundle).
    detected[kind] = {
      url: r.url,
      status: r.status,
      failed: r.failed,
      errorText: r.errorText,
      mimeType: r.mimeType,
      fromCache: r.fromCache,
      durationMs: r.durationMs
    };
  }

  const seen = Object.keys(detected);
  const loadedOk = seen.filter((k) => {
    const a = detected[k];
    return !a.failed && typeof a.status === 'number' && a.status < 400;
  });
  const broken = seen.filter((k) => !loadedOk.includes(k));

  let verdict;
  let note;
  if (seen.length === 0) {
    verdict = 'not_observed';
    note =
      'No Unbxd SDK script/style request (libraries.unbxdapi.com or sandbox.unbxd.io) was seen during the capture window. Either the widget is not installed on this page, or the capture started after it had already loaded — this by itself is not proof the SDK is broken.';
  } else if (broken.length === 0) {
    verdict = 'loaded';
  } else if (loadedOk.length === 0) {
    verdict = 'load_failed';
    note = 'Every observed Unbxd SDK asset failed to load or returned an error status — treat this as the likely root cause before considering anything issue-specific.';
  } else {
    verdict = 'partially_loaded';
    note = `${broken.join(', ')} failed to load while ${loadedOk.join(', ')} succeeded — a partial load can explain a feature-specific symptom (e.g. broken alignment but working search).`;
  }

  return { detected, expectedKinds: EXPECTED_KINDS, verdict, note };
}
