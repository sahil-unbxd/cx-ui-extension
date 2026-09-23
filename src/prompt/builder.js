/** Assembles the final prompt: template + SKILLS.md section(s) + engineer's
 *  description + budgeted capture JSON. */
import { getIssueType } from '../shared/issue-types.js';
import { getTemplate, SUPPORT_OUTPUT_CONTRACT } from './templates.js';
import { matchKnownIssues, formatKnownIssues } from './known-issues.js';
import { retrieveReference, formatReference } from './reference-docs.js';
import { getSkillSection } from './skills.js';
import { fitJson, estimateTokens } from './budget.js';

// Must match the heading in SKILLS.md exactly. Unlike a per-type section this
// one is not keyed by `skillsSection` in issue-types.js — it is prepended to
// every prompt, regardless of issue type, because it documents the shared
// `sdkAssets` check (src/capture/sdk-assets.js) that also runs unconditionally.
const SDK_VALIDATION_HEADING = 'SDK Asset Validation (All Issue Types)';
// Injected only for issue types whose capture reviews the customer's config
// bundle (capture.siteConfig) — it documents the `siteConfig` context block.
// Generic on purpose: it covers whichever bundle got reviewed (search.js,
// autosuggest.js, ...), not just SRP/PLP.
const CONFIG_REVIEW_HEADING = 'Config Bundle Review';
// "Where does this rendered value come from?" — applies wherever a response
// and a customer template are both in play (SRP, PLP, autosuggest data).
const VALUE_TRACE_HEADING = 'Tracing a Rendered Value to its API Field';
// The deterministic checks the extension runs on itself before the model sees
// anything (context.selfDebug). Which specific playbook applies depends on
// capture.selfDebugKind, since "results page" and "autosuggest data" run
// different checks over different data.
const SELF_DEBUG_HEADINGS = {
  results_page: 'Self-Debug Procedure (SRP and PLP)',
  autosuggest_data: 'Self-Debug Procedure (Autosuggest Data)'
};

export async function buildPrompt({ issueTypeId, description, context, pageUrl, maxTokens = 16000, audience = 'support' }) {
  const type = getIssueType(issueTypeId);
  const template = getTemplate(type.id);
  // Support gets a ticket and an escalation decision; engineering gets the
  // root-cause write-up. Same evidence, different deliverable.
  const output = audience === 'engineering' ? template.output : SUPPORT_OUTPUT_CONTRACT;

  // Both run before the model and are deterministic: whether this shape of
  // problem is already solved, and what the SDK docs actually say about the
  // config in play. Neither should depend on the model recalling it.
  const known = await matchKnownIssues(context, description);
  const knownBlock = formatKnownIssues(known);
  const reference = await retrieveReference(context, description, type.id);
  const referenceBlock = formatReference(reference);
  const headings = [SDK_VALIDATION_HEADING];
  const selfDebugHeading = type.capture && SELF_DEBUG_HEADINGS[type.capture.selfDebugKind];
  if (selfDebugHeading) headings.push(selfDebugHeading);
  if (type.capture && type.capture.siteConfig) headings.push(VALUE_TRACE_HEADING, CONFIG_REVIEW_HEADING);
  headings.push(type.skillsSection);

  const sections = await Promise.all(headings.map((h) => getSkillSection(h)));
  const skills = sections.filter(Boolean).join('\n\n');

  const header = [
    `Issue type: ${type.label}`,
    `Page: ${pageUrl || 'unknown'}`,
    `Captured: ${new Date().toISOString()}`
  ].join('\n');

  const fixedParts = [
    template.focus,
    skills ? `## Debugging playbook\n${skills}` : '',
    knownBlock,
    referenceBlock,
    `## Reported problem\n${(description || '').trim() || '(none provided)'}`,
    output,
    header
  ];
  const fixedTokens = fixedParts.reduce((n, p) => n + estimateTokens(p), 0);
  const contextBudget = Math.max(1200, maxTokens - fixedTokens - 200);
  const { json, truncated, tokens } = fitJson(context, contextBudget);

  const user = [
    header,
    '',
    `## Reported problem`,
    (description || '').trim() || '(none provided)',
    '',
    knownBlock ? `## Previously-resolved patterns that match this capture\n${knownBlock}\n` : '',
    referenceBlock ? `## Documented SDK behaviour (retrieved reference)\n${referenceBlock}\n` : '',
    `## What to focus on`,
    template.focus,
    '',
    skills ? `## Debugging playbook (team reference material)\n${skills}\n` : '',
    `## ${template.contextLabel}`,
    truncated ? '_Some arrays and strings below were shortened to fit the token budget._' : '',
    '```json',
    json,
    '```',
    '',
    output
  ]
    .filter((p) => p !== '')
    .join('\n');

  return {
    system: template.system,
    user,
    knownIssues: known,
    reference,
    stats: {
      issueType: type.id,
      audience,
      knownIssueMatches: known ? known.matches.length : 0,
      referenceExcerpts: reference ? reference.excerpts.length : 0,
      contextTokens: tokens,
      totalTokens: estimateTokens(user) + estimateTokens(template.system),
      contextTruncated: truncated
    }
  };
}
