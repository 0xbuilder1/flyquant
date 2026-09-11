/* ═══════════════════════════════════════════════════════════════════════════════════════════
   READING A PRIVATE KEY OUT OF THE ENVIRONMENT
   ═══════════════════════════════════════════════════════════════════════════════════════════
   cmd.exe's `set VAR=value && command` puts everything up to the `&&` into the variable, SPACE
   INCLUDED. The key is then 67 characters, viem says "invalid private key, expected hex or 32
   bytes, got string", and nothing anywhere names the space — which is invisible, in a value
   nobody can paste into a search box, on the one platform where that idiom is the natural way to
   set a variable and run a command on one line.

   Quotation marks are stripped for the same reason: `set "VAR=0x.."` is the correct cmd spelling
   and some shells keep the quotes in the value, and `export VAR='0x..'` typed into the wrong
   shell does it too.

   Whitespace and quotes are never part of a key, so removing them cannot change WHICH key is
   meant. Nothing else is touched: this repairs damage in transit, it does not guess at a
   malformed key — a key with a character missing must still fail, loudly.

   No dependencies on purpose. fmt.js reads the config at module load, so anything that wants to
   explain a bad key BEFORE the config is resolved cannot live there.
   ═══════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

/** @returns {{value: string|undefined, raw: string|undefined, repaired: string|null}} */
function readKey(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') return { value: undefined, raw, repaired: null };
  const value = String(raw).trim().replace(/^["']+|["']+$/g, '');
  const repaired = value === raw
    ? null
    : (/^\s|\s$/.test(raw) ? 'surrounding whitespace' : 'surrounding quotes');
  return { value, raw, repaired };
}

/** why a key that has already been cleaned is still not a key — one line, for an operator */
function keyProblem(value) {
  if (!value) return 'it is empty';
  if (!value.startsWith('0x')) return `it does not start with 0x (it starts "${value.slice(0, 4)}")`;
  const hex = value.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(hex)) return 'it contains characters that are not hex digits';
  if (hex.length !== 64) return `it is ${hex.length} hex digits long, not 64`;
  return 'it is the right shape but the library rejected it';
}

/** the advice that actually fixes it, on the platform the operator is on */
function keyHint(name) {
  return process.platform === 'win32'
    ? `      cmd:         set "${name}=0x..."      (the quotes matter with &&)\n`
      + `      PowerShell:  $env:${name} = "0x..."`
    : `      export ${name}=0x...`;
}

module.exports = { readKey, keyProblem, keyHint };
