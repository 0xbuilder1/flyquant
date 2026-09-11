/**
 * core/key.js — the environment is not a clean channel.
 *
 * Every case here is a real way an operator's key arrives damaged, and the damage is invisible:
 * a trailing space and a correct key look identical on screen, and the library's complaint names
 * a type rather than a mistake.
 */
'use strict';

const assert = require('assert');
const { readKey, keyProblem, keyHint } = require('./key.js');

let pass = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); pass++; }
  catch (e) { console.log(`  ✗  ${name}\n       ${e.message}`); process.exitCode = 1; }
}
function section(s) { console.log(`\n${s}`); }

const K = '0x' + 'a'.repeat(64);
const set = (v) => { if (v === undefined) delete process.env.TESTKEY; else process.env.TESTKEY = v; };

section('what cmd.exe does to a key');
t('`set K=0x.. && cmd` leaves a trailing space, and it is removed', () => {
  set(K + ' ');
  const r = readKey('TESTKEY');
  assert.strictEqual(r.value, K);
  assert.strictEqual(r.repaired, 'surrounding whitespace');
});
t('a leading space is removed too', () => {
  set(' ' + K);
  assert.strictEqual(readKey('TESTKEY').value, K);
});
t('quotes left in the value are removed', () => {
  set('"' + K + '"');
  const r = readKey('TESTKEY');
  assert.strictEqual(r.value, K);
  assert.strictEqual(r.repaired, 'surrounding quotes');
});
t('single quotes too', () => {
  set("'" + K + "'");
  assert.strictEqual(readKey('TESTKEY').value, K);
});

section('a clean key is not touched, and absence is not a value');
t('a good key passes through with repaired = null', () => {
  set(K);
  const r = readKey('TESTKEY');
  assert.strictEqual(r.value, K);
  assert.strictEqual(r.repaired, null);
});
t('unset reads as undefined, not as an empty string', () => {
  set(undefined);
  assert.strictEqual(readKey('TESTKEY').value, undefined);
});
t('empty reads as undefined', () => {
  set('');
  assert.strictEqual(readKey('TESTKEY').value, undefined);
});

section('what is NOT repaired — a wrong key must still fail');
/* The whole value of this module is that it removes transport damage and nothing else. A key
   with a digit missing is a DIFFERENT key, and silently doing anything with it would be worse
   than the error it replaces. */
t('a key with a character missing is left exactly as it is', () => {
  const short = '0x' + 'a'.repeat(63);
  set(short);
  assert.strictEqual(readKey('TESTKEY').value, short);
});
t('internal whitespace is not stripped', () => {
  const split = '0x' + 'a'.repeat(32) + ' ' + 'a'.repeat(32);
  set(split);
  assert.strictEqual(readKey('TESTKEY').value, split, 'only the ends are trimmed');
});
t('no 0x prefix is not invented', () => {
  set('a'.repeat(64));
  assert.strictEqual(readKey('TESTKEY').value, 'a'.repeat(64));
});

section('the diagnosis says which mistake it was');
t('too short says how short', () => {
  assert.match(keyProblem('0x' + 'a'.repeat(63)), /63 hex digits long, not 64/);
});
t('too long says how long', () => {
  assert.match(keyProblem('0x' + 'a'.repeat(65)), /65 hex digits long, not 64/);
});
t('no prefix says so', () => {
  assert.match(keyProblem('abcd'), /does not start with 0x/);
});
t('non-hex says so', () => {
  assert.match(keyProblem('0x' + 'z'.repeat(64)), /not hex digits/);
});
t('empty says so', () => {
  assert.match(keyProblem(''), /empty/);
});
t('a well-formed key reports no shape problem', () => {
  assert.match(keyProblem(K), /right shape/);
});

section('the hint is for the platform the operator is on');
t('the hint names the variable and a working spelling', () => {
  const h = keyHint('PRIVATE_KEY');
  assert.ok(h.includes('PRIVATE_KEY'), 'names the variable');
  assert.ok(process.platform === 'win32' ? /set "/.test(h) : /export /.test(h),
    'gives a spelling that works on this platform');
});

set(undefined);
console.log(`\n${pass} checks passed\n`);
