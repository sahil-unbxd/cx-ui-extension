/**
 * Single source of truth for the issue types the extension supports.
 *
 * Adding a new issue type means:
 *   1. an entry here,
 *   2. a capture strategy in src/capture/strategies.js keyed by the same id,
 *   3. a prompt template in src/prompt/templates.js keyed by the same id,
 *   4. a section in SKILLS.md with the same `skillsSection` heading.
 * Nothing else should need to change.
 *
 * The `capture` flags below describe what each strategy forwards into the
 * prompt beyond the shared, unconditional "validate first" SDK-asset check
 * (src/capture/sdk-assets.js), which runs for every issue type regardless of
 * these flags — see the comment on Recorder construction in
 * src/background/service-worker.js.
 */
export const ISSUE_TYPES = {
  autosuggest_alignment: {
    id: 'autosuggest_alignment',
    label: 'Autosuggest alignment issue',
    hint: 'Dropdown offset, clipped, behind other content, wrong width.',
    skillsSection: 'Autosuggest Alignment Issues',
    capture: {
      network: false,
      console: true,
      domGeometry: true,
      searchApi: false
    }
  },
  autosuggest_data: {
    id: 'autosuggest_data',
    label: 'Autosuggest data issue (no/wrong suggestions)',
    hint: 'Popular products, keyword suggestions or top queries missing/empty/wrong — not a positioning issue.',
    skillsSection: 'Autosuggest Data Issues',
    capture: {
      network: true,
      console: true,
      domGeometry: false,
      searchApi: true,
      // Reviews the customer's {siteKey}_autosuggest.js/.css config bundle.
      siteConfig: true,
      // Which self-debug playbook/heading builder.js injects (see below).
      selfDebugKind: 'autosuggest_data'
    }
  },
  srp_ui: {
    id: 'srp_ui',
    label: 'SRP (search results) UI issue',
    hint: 'Wrong / missing / duplicated results,tag issue , correct price issue , facets, banners, pagination.',
    skillsSection: 'SRP (Search Results Page) UI Issues',
    capture: {
      network: true,
      console: true,
      domGeometry: false,
      searchApi: true,
      // Reviews the customer's {siteKey}_search.js/.css config bundle.
      siteConfig: true,
      selfDebugKind: 'results_page'
    }
  },
  plp_ui: {
    id: 'plp_ui',
    label: 'PLP / category page issue',
    hint: 'Category page empty or showing search results, filters dropped from URL, back-button loop, pagination.',
    skillsSection: 'PLP (Category / Browse Page) Issues',
    capture: {
      network: true,
      console: true,
      domGeometry: false,
      searchApi: true,
      siteConfig: true,
      selfDebugKind: 'results_page'
    }
  }
};

export const ISSUE_TYPE_LIST = Object.values(ISSUE_TYPES);

export const DEFAULT_ISSUE_TYPE = 'srp_ui';

export function getIssueType(id) {
  return ISSUE_TYPES[id] || ISSUE_TYPES[DEFAULT_ISSUE_TYPE];
}
