// npm run test:skins -w @chatward/client (run from packages/client, so the relative paths resolve)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { lintCss } from './lint';

const SKIN = ":root[data-skin='x']";

test('blocks hiding, disabling and reordering action elements', () => {
  for (const declaration of ['display: none', 'visibility: hidden', 'pointer-events: none', 'opacity: 0', 'order: 3']) {
    const findings = lintCss(`${SKIN} button.icon { ${declaration}; }`);
    assert.equal(findings.length, 1, declaration);
  }
});

test('catches action elements named by role, data-action, input and list selectors', () => {
  const css = [
    `${SKIN} [role="menuitem"] { display: none; }`,
    `${SKIN} [data-action='x'] { visibility: hidden; }`,
    `${SKIN} input, .panel { pointer-events: none; }`,
    `${SKIN} .icon { order: -1 !important; }`,
  ].join('\n');
  assert.equal(lintCss(css).length, 4);
});

test('leaves panel layout and the rest of a skin alone', () => {
  const css = `${SKIN} .cw-shell { grid-template-columns: auto 1fr; grid-template-areas: 'main servers'; }
    ${SKIN} .cw-main { color: red; order: 0; }
    ${SKIN} [data-region='members'] { opacity: 0.5; }`;
  assert.deepEqual(lintCss(css), []);
});

test('reads rules inside @media and @import preludes', () => {
  const css = `@import url(x.css);
    @media (min-width: 900px) {
      ${SKIN} button { display: none; }
    }`;
  const findings = lintCss(css);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].selector, `${SKIN} button`);
});

test('ignores commented-out rules and reports the rule line', () => {
  const css = `/* ${SKIN} button { display: none; } */
    .cw-main { color: red; }

    ${SKIN} button { display: none; }`;
  const findings = lintCss(css);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
});

test('the deliberately broken skin is flagged', () => {
  const css = fs.readFileSync(path.resolve('test/skins/broken/hides-action.css'), 'utf8');
  assert.equal(lintCss(css).length, 1);
});

test('every shipped skin passes the lint', () => {
  const dirs = ['src/renderer/src/skins', 'test/skins/fixtures'].filter((dir) => fs.existsSync(dir));
  const files = dirs.flatMap((dir) => fs.readdirSync(dir, { recursive: true }).map(String)
    .filter((file) => file.endsWith('.css')).map((file) => path.join(dir, file)));
  assert.ok(files.length > 0, 'no skin CSS found to lint');
  for (const file of files) assert.deepEqual(lintCss(fs.readFileSync(file, 'utf8')), [], file);
});
