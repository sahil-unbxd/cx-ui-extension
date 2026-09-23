/** Assembles the final prompt: template + SKILLS.md section(s) + engineer's
 *  description + budgeted capture JSON. */
import { getIssueType } from '../shared/issue-types.js';
import { getTemplate } from './templates.js';
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

export async function buildPrompt({ issueTypeId, description, context, pageUrl, maxTokens = 12000 }) {
  const type = getIssueType(issueTypeId);
  const template = getTemplate(type.id);
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
    `## Engineer's description of the problem\n${(description || '').trim() || '(none provided)'}`,
    template.output,
    header
  ];
  const fixedTokens = fixedParts.reduce((n, p) => n + estimateTokens(p), 0);
  const contextBudget = Math.max(1200, maxTokens - fixedTokens - 200);
  const { json, truncated, tokens } = fitJson(context, contextBudget);

  const user = [
    header,
    '',
    `## Engineer's description of the problem`,
    (description || '').trim() || '(none provided)',
    '',
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
    template.output
  ]
    .filter((p) => p !== '')
    .join('\n');

  return {
    system: template.system,
    user,
    stats: {
      issueType: type.id,
      contextTokens: tokens,
      totalTokens: estimateTokens(user) + estimateTokens(template.system),
      contextTruncated: truncated
    }
  };
}
