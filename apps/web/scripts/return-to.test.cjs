const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
function load(relative) {
  const filename = path.resolve(__dirname, '../app', relative);
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const localRequire = (name) => {
    if (name === '../leads/lead-query') return load('leads/lead-query.ts');
    throw new Error(`Unexpected dependency: ${name}`);
  };
  vm.runInNewContext(code, { exports, require: localRequire, URL, URLSearchParams }, { filename });
  return exports;
}
const { sanitizeAppReturnTo, loginHref } = load('lib/return-to.ts');
const origin = 'https://panel.example.test';
test('login retains submission and commission workspace context', () => {
  for (const target of ['/submissions/11111111-1111-4111-8111-111111111111', '/tools/commission-comparison', '/tools/oc-policy-verification?step=results']) {
    assert.equal(sanitizeAppReturnTo(target, origin), target);
    assert.equal(loginHref(target, origin), '/?returnTo=' + encodeURIComponent(target));
  }
});
test('login rejects external, unregistered and nested redirect targets', () => {
  for (const target of ['https://evil.test/', '//evil.test/', '/\\evil.test/', '/tools/unknown', '/submissions/not-a-uuid', '/dashboard?returnTo=//evil.test/']) {
    assert.equal(sanitizeAppReturnTo(target, origin), null, target);
    assert.equal(loginHref(target, origin), '/');
  }
});
