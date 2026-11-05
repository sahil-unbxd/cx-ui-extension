import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAssetOrigin, registrableDomain } from '../../src/capture/page-inventory.js';
import { resolveCascade, hidesElement, attributeDeclaration } from '../../src/capture/css-provenance.js';

const SHOP = 'https://www.example-store.com/search?q=boots';
const MAGE = 'https://shop.example.co.uk/catalogsearch/result/?q=boots';

test('registrableDomain handles plain and multi-part TLDs', () => {
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('static.shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('Unbxd hosts and Unbxd module paths are owned by Unbxd', () => {
  assert.equal(classifyAssetOrigin('https://libraries.unbxdapi.com/acme_search.js', SHOP).owner, 'unbxd');
  assert.equal(classifyAssetOrigin('https://search.unbxd.io/k/s/search?q=x', SHOP).owner, 'unbxd');
  const mod = classifyAssetOrigin('https://shop.example.co.uk/static/version123/frontend/Acme/theme/en_GB/Unbxd_Search/js/init.js', MAGE);
  assert.equal(mod.owner, 'unbxd');
  assert.equal(mod.source, 'unbxd_module');
});

test('Shopify theme, app embed and platform assets are customer-side, with the right source', () => {
  const theme = classifyAssetOrigin('https://www.example-store.com/cdn/shop/t/12/assets/theme.js?v=1', SHOP);
  assert.deepEqual([theme.owner, theme.source], ['customer', 'theme']);
  const legacyTheme = classifyAssetOrigin('https://cdn.shopify.com/s/files/1/0001/0002/t/7/assets/global.js', SHOP);
  assert.equal(legacyTheme.source, 'theme');
  const app = classifyAssetOrigin('https://cdn.shopify.com/extensions/0a1b2c/1.0.0/assets/reviews.js', SHOP);
  assert.deepEqual([app.owner, app.source], ['customer', 'platform_app']);
  const platform = classifyAssetOrigin('https://www.example-store.com/cdn/shopifycloud/storefront/assets/x.js', SHOP);
  assert.equal(platform.source, 'platform');
});

test('Magento core, third-party modules and theme files are told apart', () => {
  const base = 'https://shop.example.co.uk/static/version1700000000/frontend/Acme/luma-child/en_GB/';
  assert.equal(classifyAssetOrigin(`${base}Magento_Search/js/form-mini.js`, MAGE).source, 'platform');
  assert.equal(classifyAssetOrigin(`${base}mage/cookies.js`, MAGE).source, 'platform');
  const mod = classifyAssetOrigin(`${base}Amasty_Label/js/label.js`, MAGE);
  assert.deepEqual([mod.owner, mod.source], ['customer', 'site_module']);
  assert.equal(classifyAssetOrigin(`${base}js/theme.js`, MAGE).source, 'theme');
});

test('same-site, inline and third-party scripts', () => {
  assert.equal(classifyAssetOrigin('https://assets.example-store.com/app.js', SHOP).source, 'site');
  assert.equal(classifyAssetOrigin(SHOP, SHOP).source, 'inline');
  const gtm = classifyAssetOrigin('https://www.googletagmanager.com/gtm.js?id=GTM-X', SHOP);
  assert.deepEqual([gtm.owner, gtm.source], ['customer', 'third_party']);
  assert.equal(classifyAssetOrigin('chrome-extension://abc/content.js', SHOP).owner, 'browser_extension');
  assert.equal(classifyAssetOrigin('', SHOP).owner, 'unknown');
});

/* ---------------------------------------------------------------- */

const rule = (styleSheetId, selector, props, origin = 'regular') => ({
  rule: { styleSheetId, origin, selectorList: { text: selector }, style: { cssProperties: props } }
});

test('resolveCascade: later rule wins, !important beats later normal, style attribute beats rules', () => {
  const matched = {
    matchedCSSRules: [
      rule('ua', 'div', [{ name: 'display', value: 'block' }], 'user-agent'),
      rule('unbxd', '.UNX-results', [{ name: 'display', value: 'grid' }, { name: 'width', value: '100%' }]),
      // CDP's real shape: the value carries the !important suffix too.
      rule('theme', '.collection .UNX-results', [{ name: 'display', value: 'none !important', important: true }]),
      rule('later', '#main .UNX-results', [{ name: 'display', value: 'flex' }])
    ],
    inlineStyle: { cssProperties: [{ name: 'width', value: '300px' }] }
  };
  const c = resolveCascade(matched);
  assert.equal(c.display.winner.value, 'none');
  assert.equal(c.display.winner.styleSheetId, 'theme');
  assert.equal(c.display.declared.length, 4);
  assert.equal(c.width.winner.kind, 'style-attribute');
  assert.equal(c.width.winner.value, '300px');
});

test('resolveCascade ignores disabled and unparsed declarations', () => {
  const c = resolveCascade({
    matchedCSSRules: [
      rule('a', '.x', [{ name: 'opacity', value: '1' }]),
      rule('b', '.x', [{ name: 'opacity', value: '0', disabled: true }, { name: 'opacity', value: 'zero', parsedOk: false }])
    ]
  });
  assert.equal(c.opacity.winner.value, '1');
});

test('hidesElement', () => {
  assert.ok(hidesElement('display', 'none'));
  assert.ok(hidesElement('visibility', 'hidden'));
  assert.ok(hidesElement('opacity', '0'));
  assert.ok(hidesElement('max-height', '0px'));
  assert.ok(!hidesElement('display', 'block'));
  assert.ok(!hidesElement('opacity', '0.5'));
});

test('attributeDeclaration maps a stylesheet to its owner', () => {
  const sheets = new Map([
    ['u', { styleSheetId: 'u', sourceURL: 'https://libraries.unbxdapi.com/acme_search.css' }],
    ['t', { styleSheetId: 't', sourceURL: 'https://www.example-store.com/cdn/shop/t/3/assets/base.css' }],
    ['i', { styleSheetId: 'i', sourceURL: SHOP, isInline: true }]
  ]);
  assert.equal(attributeDeclaration({ kind: 'rule', styleSheetId: 'u' }, sheets, SHOP).owner, 'unbxd');
  const theme = attributeDeclaration({ kind: 'rule', styleSheetId: 't' }, sheets, SHOP);
  assert.deepEqual([theme.owner, theme.source], ['customer', 'theme']);
  assert.equal(attributeDeclaration({ kind: 'rule', styleSheetId: 'i' }, sheets, SHOP).source, 'inline-style-tag');
  assert.equal(attributeDeclaration({ kind: 'style-attribute' }, sheets, SHOP).owner, 'unknown');
  assert.equal(attributeDeclaration({ kind: 'user-agent' }, sheets, SHOP).owner, 'browser_default');
});
