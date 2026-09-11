/**
 * core/launch.js — the form the operator actually signs from.
 *
 * The form is a template literal inside a Node file, and both bugs this file exists to catch came
 * from that arrangement rather than from the logic:
 *
 *   · a backtick typed into a COMMENT closed the literal and turned the whole module into a
 *     syntax error. Twice. Nothing imports launch.js during a normal test run, so the suite
 *     stayed green while the launch tool would not start at all.
 *
 *   · loadPlan() overwrote the panel containing the metadata inputs and only then called
 *     readMeta(), which opens by checking for one of those inputs and returns null when it is
 *     gone. So every re-price posted no metadata, the operator's edits vanished on screen, and a
 *     token was launched carrying nothing but config defaults -- no twitter link, permanently,
 *     because metadata is fixed at launch.
 *
 * Neither needs a chain, a wallet or a server to catch.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); pass++; }
  catch (e) { console.log(`  ✗  ${name}\n       ${e.message}`); process.exitCode = 1; }
}
function section(s) { console.log(`\n${s}`); }

const SRC = fs.readFileSync(path.join(__dirname, 'launch.js'), 'utf8');

section('the module still loads');
t('launch.js parses — a stray backtick in a comment would fail here', () => {
  /* require() is the check. It is cheap, and it is the thing that was missing: the suite never
     loaded this file, so a syntax error in it shipped twice. */
  delete require.cache[require.resolve('./launch.js')];
  require('./launch.js');
});

section('the form template literal is intact');
/* The literal runs from the doctype to </html>`. A backtick inside it ends it early, and whatever
   follows is parsed as code -- which is exactly how "an `input` listener" became a syntax error. */
const open = SRC.indexOf('return `<!doctype html>');
const close = SRC.indexOf('</body></html>`;', open);
t('the form literal is found', () => {
  assert.ok(open > 0, 'template opener moved — update this test');
  assert.ok(close > open, 'template closer moved — update this test');
});
t('no stray backtick inside it', () => {
  const body = SRC.slice(open + 'return `'.length, close);
  const stray = body.split('`').length - 1;
  assert.strictEqual(stray, 0,
    `${stray} backtick(s) inside the form template. A backtick closes the literal; the rest of the `
    + 'file is then parsed as JavaScript. Use quotes in comments here.');
});

section('the form reads itself before it destroys itself');
t('loadPlan calls readMeta() BEFORE overwriting #plan', () => {
  const body = SRC.slice(open, close);
  const fn = body.indexOf('async function loadPlan()');
  assert.ok(fn > 0, 'loadPlan moved — update this test');
  const scope = body.slice(fn, fn + 1600);
  const read = scope.indexOf('readMeta()');
  const wipe = scope.indexOf("$('plan').innerHTML");
  assert.ok(read > -1, 'loadPlan no longer reads the form');
  assert.ok(wipe > -1, 'loadPlan no longer repaints the panel');
  assert.ok(read < wipe,
    'loadPlan overwrites #plan before reading it. The metadata inputs live inside #plan and '
    + 'readMeta() returns null once they are gone, so every edit is silently discarded and the '
    + 'launch carries config defaults.');
});

section('the metadata the operator sees is the metadata that gets signed');
t('the launch button refuses to sign a form that has drifted', () => {
  const body = SRC.slice(open, close);
  assert.ok(/metaStale \|\| metaDrifted\(\)/.test(body),
    'go.onclick no longer checks whether the form matches plan.data — the calldata is built from '
    + 'the server copy, so without this an edit can be visible on screen and absent from the bytes');
});
t('readMeta sends every editable social field', () => {
  const body = SRC.slice(open, close);
  const m = body.match(/socials:\s*\{([^}]*)\}/);
  assert.ok(m, 'readMeta no longer sends socials');
  for (const k of ['twitter', 'website', 'telegram']) {
    assert.ok(m[1].includes(k + ':'), `readMeta drops ${k}`);
  }
});

console.log(`\n${pass} checks passed\n`);
