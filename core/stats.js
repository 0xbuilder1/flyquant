/**
 * @pons/core — stats.json, and the SINGLE writer of it.
 *
 * There used to be two. The keeper's own updateStats() merged identity over the sink's numbers, and
 * the sink's updateDonationStats() re-required publish.js by relative path and published again by
 * itself. That cost a real incident: on a fresh state directory the sink-side publisher ran before
 * the first loop pass and produced a feed with NO token in it, which the site reads as "Not
 * launched" while real money was moving — so the sink had to republish identity fields it does not
 * own, and the two merges could disagree about which of them won.
 *
 * Now: the core writes identity, the sink's stats(prev) is merged over it, feesRedirected is written
 * over the top (it is core state the sink cannot see), one writeJson, one publish. ctx.stats.write
 * is callable from anywhere in a sink's money path, and it is the only way to write this file.
 *
 * The file is WRITE-ONLY to a sink. ctx exposes no reader for it, because a published file must
 * never be an input to the ceiling: a half-written stats.json read leniently and subtracted from a
 * spending limit would have raised that limit by the whole lifetime total.
 */
'use strict';

const path = require('path');
const cfg = require('./config.js').current();
const { qSym, log, stamp, outDir } = require('./fmt.js');
const { readJson, writeJson } = require('./io.js');
const { publishStats } = require('./publish.js');
const { redirected } = require('./harvest.js');

let sink = null;
function bind(s) { sink = s; }

function statsFile() { return path.join(outDir(), (cfg.output && cfg.output.statsFile) || 'stats.json'); }

/* Identity and accounting the core owns; every figure about what the money DID comes from
   sink.stats(prev), which counts only what a receipt can back. There is deliberately no lives field
   and no unit count anywhere in here: a keeper-side number of that kind would read as a measurement. */
function write() {
  const file = statsFile();
  const prev = readJson(file, {});

  const payload = Object.assign({}, prev, {
    symbol: cfg.token.symbol,
    quoteSymbol: qSym(),
    token: cfg.token.token,
    curve: cfg.token.curve,
    chainId: cfg.chain.id,
  }, sink.stats(prev), {
    feesRedirected: redirected(),
    updatedAt: new Date().toISOString(),
  });

  writeJson(file, payload);
  // fire-and-forget: a publishing failure must never interrupt or fail a payment
  publishStats(payload, (m) => log(stamp(), m)).catch(() => {});
  return payload;
}

module.exports = { bind, write, statsFile };
