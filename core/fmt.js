/**
 * @pons/core — formatting, and the one log format every module shares.
 *
 * `s` is a timestamp passed PER CALL rather than taken here, so a whole pass shares one stamp and
 * its lines group visually in a loop that runs every minute.
 */
'use strict';

const path = require('path');
const { formatUnits } = require('viem');
const cfg = require('./config.js').current();

const ZERO = '0x0000000000000000000000000000000000000000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String((e && (e.shortMessage || e.message)) || e).split('\n')[0];
const stamp = () => new Date().toISOString().slice(11, 19);
const now = () => new Date().toISOString();
const lc = (a) => String(a || '').toLowerCase();
const quoteIsNative = () => !cfg.quote || !cfg.quote.asset || cfg.quote.asset === 'native' || lc(cfg.quote.asset) === ZERO;
const qDec = () => (quoteIsNative() ? 18 : (cfg.quote.decimals || 18));
const qSym = () => (quoteIsNative() ? 'ETH' : (cfg.quote.symbol || 'TOKEN'));
const fq = (v) => formatUnits(v, qDec());
const { isAddress } = require('viem');
const wired = () => isAddress(String(cfg.token.token || '')) && lc(cfg.token.token) !== ZERO;
const outDir = () => path.join(require('./config.js').root(), (cfg.output && cfg.output.dir) || 'state');

function log(s, msg) { console.log(`[${s}] ${msg}`); }

/**
 * The OUT asset's formatter, beside fq().
 *
 * The core has exactly one denomination today, the quote asset's, and every sink in the repo pays
 * in it. A sink whose out-asset is a 6-decimal token would render 1 unit as 0.000000000001 in every
 * log line, batch file, stats.json and site — silently, and consistently, so nothing would ever look
 * wrong. declare().outAsset is what says otherwise, and these two read it.
 */
function outAssetOf(decl) {
  const a = decl && decl.outAsset;
  if (!a || a === 'native') return null;
  return a;
}
function makeOut(decl) {
  const a = outAssetOf(decl);
  return {
    fOut: (v) => (a ? formatUnits(v, a.decimals != null ? a.decimals : 18) : fq(v)),
    outSym: () => (a ? (a.symbol || 'TOKEN') : qSym()),
  };
}

module.exports = {
  ZERO, sleep, short, stamp, now, lc, quoteIsNative, qDec, qSym, fq, wired, outDir, log, makeOut,
};
