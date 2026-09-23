/**
 * Traces a value seen in the rendered UI back to the API field that produced it.
 *
 * This answers the question the capture could not previously answer: "this
 * label says '2 for $12' — where does that come from?". The chain has three
 * links and an engineer has to walk all three by hand today:
 *
 *   DOM text ──▶ response field ──▶ attributesMap alias ──▶ template usage
 *
 * The worked example, from a real Lindt Canada SRP:
 *   DOM:      <div class="amasty-label-for-65063"><div class="amlabel-text">2 for $12</div></div>
 *   Response: products[] with uniqueId 65063 → label_product_page_label: "2 for $12"
 *   Config:   attributesMap.unxLabelName → "label_product_page_label"
 *   Template: ${y ? `<div class="amasty-label-for-${s}" style="color: ${v||"#917236"}">…${y}…` : ""}
 *             (y = unxLabelName, v = unxLabelColour, s = uniqueId)
 *
 * Note the element ids in that markup are the product's `uniqueId`, which is
 * why pasting the element is enough to pin the exact product.
 *
 * What leaves the browser: the field name, the product's uniqueId, and the
 * matched value — which is the value the engineer supplied in the first place.
 * Never the whole product, and never unrelated catalogue rows.
 */

const MAX_VALUE_LEN = 120;
const MAX_MATCHES = 12;
const MAX_CANDIDATES = 6;

/**
 * Pulls the strings worth tracing out of whatever the engineer typed.
 *
 * Engineers paste the element, so HTML is handled first: its text nodes are
 * the visible value, and any digits in `…-for-12345` style class names are
 * very likely the product id. Quoted strings are taken as explicit asks.
 */
export function extractCandidateValues(description = '') {
  const text = String(description);
  const out = [];
  const push = (v) => {
    const clean = String(v).replace(/\s+/g, ' ').trim();
    if (clean.length >= 2 && clean.length <= MAX_VALUE_LEN && !out.includes(clean)) out.push(clean);
  };

  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(text);
  if (looksLikeHtml) {
    // Text nodes between tags — the part a shopper actually sees.
    for (const m of text.matchAll(/>([^<>]{2,120})</g)) push(m[1]);
    // Ids embedded in class names (amasty-label-for-65063, product-item-12345).
    for (const m of text.matchAll(/[-_](\d{3,})\b/g)) push(m[1]);
  }

  // Explicitly quoted values. When HTML was pasted, quote-scan only the
  // tag-stripped text — otherwise every class list and inline style comes
  // through as a "candidate" that can never match a catalogue field.
  const quotable = looksLikeHtml ? text.replace(/<[^>]*>/g, ' ') : text;
  for (const m of quotable.matchAll(/["'“”]([^"'“”\n]{2,120})["'“”]/g)) push(m[1]);

  return out
    .filter((v) => !/^(div|span|class|style|true|false|null)$/i.test(v))
    .slice(0, MAX_CANDIDATES);
}

/** Every product field whose value contains `needle` (case-insensitive). */
function matchesIn(products, needle) {
  const found = [];
  const lower = String(needle).toLowerCase();
  products.forEach((product, index) => {
    if (found.length >= MAX_MATCHES) return;
    for (const [field, value] of Object.entries(product)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const asText = String(value);
      if (!asText.toLowerCase().includes(lower)) continue;
      found.push({
        field,
        uniqueId: product.uniqueId ?? product.id ?? null,
        productIndex: index,
        value: asText.length > MAX_VALUE_LEN ? `${asText.slice(0, MAX_VALUE_LEN)}…` : asText,
        exact: asText.trim().toLowerCase() === lower
      });
      if (found.length >= MAX_MATCHES) break;
    }
  });
  return found;
}

/**
 * @param {string} bodyText  raw response body (already fetched by the caller)
 * @param {string[]} values  candidate strings to look for
 * @param {object} [context] { requestedFields, attributesMap } for the extra links
 */
export function traceValuesInResponse(bodyText, values, context = {}) {
  if (!values || !values.length) return null;
  if (!bodyText) return { traced: [], note: 'No response body available to search.' };

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { traced: [], note: 'Response was not JSON, so no field could be traced.' };
  }

  // Search endpoints nest under response.products; autosuggest returns named
  // sections instead, so flatten anything array-shaped that holds objects.
  const pools = [];
  const resp = json.response && typeof json.response === 'object' ? json.response : json;
  if (Array.isArray(resp.products)) pools.push({ pool: 'response.products', items: resp.products });
  for (const [key, val] of Object.entries(resp)) {
    if (key === 'products') continue;
    const items = Array.isArray(val) ? val : Array.isArray(val?.products) ? val.products : null;
    if (items && items.length && typeof items[0] === 'object') pools.push({ pool: key, items });
  }

  const requested = new Set(context.requestedFields || []);
  const mapping = context.attributesMap && typeof context.attributesMap === 'object' ? context.attributesMap : {};
  const aliasOf = (field) => Object.keys(mapping).filter((alias) => mapping[alias] === field);

  const traced = values.map((value) => {
    const hits = [];
    for (const { pool, items } of pools) {
      for (const m of matchesIn(items, value)) hits.push({ ...m, pool });
    }
    const fields = [...new Set(hits.map((h) => h.field))];
    return {
      value,
      found: hits.length > 0,
      fields: fields.map((field) => ({
        field,
        inRequestedFields: requested.size ? requested.has(field) : null,
        mappedToAliases: aliasOf(field),
        matchCount: hits.filter((h) => h.field === field).length,
        example: hits.find((h) => h.field === field)
      })),
      sampleMatches: hits.slice(0, 5)
    };
  });

  return {
    traced,
    howToRead:
      'Each traced value lists the response field(s) whose content contains it. `mappedToAliases` is the attributesMap alias the template reads it through (e.g. label_product_page_label → unxLabelName); an empty list means the template reads the raw field name directly. To see the markup itself, search the bundle for the alias or the field with the search_bundle / trace_rendered_value tool — element ids in customer templates are usually the product uniqueId, so the id in a pasted element pins the exact product.'
  };
}
