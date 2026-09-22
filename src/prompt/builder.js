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

export async function buildPrompt({ issueTypeId, description, context, pageUrl, maxTokens = 12000 }) {
  const type = getIssueType(issueTypeId);
  const template = getTemplate(type.id);
  const [sdkValidation, typeSkills] = await Promise.all([
    getSkillSection(SDK_VALIDATION_HEADING),
    getSkillSection(type.skillsSection)
  ]);
  const skills = [sdkValidation, typeSkills].filter(Boolean).join('\n\n');

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
