/**
 * What the fly decided, read off its motor output.
 *
 * MaleCNS types 480 distinct descending neurons — the whole channel from brain to body. This file
 * reads five of them, and every one is a published behaviour rather than a chosen abstraction:
 *
 *   DNp01  the giant fiber       escape. One spike and the animal is already leaving.
 *   MN9    proboscis extension   feeding. Shiu et al.'s own readout for "this is food".
 *   MDN    the moonwalker        backward walking. Away, deliberately, not in a panic.
 *   DNp09                        stopping. The fly freezes and does nothing.
 *   DNa02  steering              which way. Its left-right imbalance picks the coin.
 *
 * THE ESCAPE RULE IS ALL-OR-NONE AND THAT IS NOT A SIMPLIFICATION. The giant fiber is the textbook
 * single-spike trigger: it does not vote, it does not scale, and a fly does not partially jump. So
 * a single DNp01 spike sells the whole position, and no other channel can outvote it. If that ever
 * becomes a weighted term because it was selling too often, the honest thing is to say the fly is
 * being overruled — not to quietly make the giant fiber negotiable.
 *
 * Everything else is a RATE over the run, never a spike. One spike in a 165,836-neuron network is
 * noise; a rate is a decision.
 */
'use strict';

const P = require('./params.js');

// The most any neuron can fire, set by the refractory period alone: 1000/2.2ms. Sizes are quoted
// as a fraction of this, so there is no scaling constant anywhere in the file.
const MAX_HZ = 1000 / P.T_RFC;

const READOUT = [
  { id: 'escape', type: 'DNp01', behaviour: 'escape reflex', means: 'sell the position, all of it' },
  { id: 'feed', type: 'MN9', behaviour: 'proboscis extension', means: 'buy, sized by rate' },
  { id: 'retreat', type: 'MDN', behaviour: 'backward walking', means: 'reduce the position' },
  { id: 'freeze', type: 'DNp09', behaviour: 'stopping', means: 'do nothing this pass' },
  { id: 'steer', type: 'DNa02', behaviour: 'steering', means: 'which coin the pass is about' },
];

function rates(brain, result) {
  const out = {};
  for (const r of READOUT) {
    const n = brain.ofType(r.type);
    out[r.id] = {
      type: r.type,
      neurons: n.length,
      spikes: n.map((i) => result.spikes[i]),
      hz: brain.rateOf(n, result.ms),
    };
  }
  return out;
}

/**
 * rates -> an intent the trader can act on, or refuse to.
 *
 * Returns { action, size, why, rates } where action is one of:
 *   'escape'  sell everything held of this coin
 *   'buy'     buy, size = fraction of the book the trader is allowed to commit
 *   'reduce'  sell that fraction of the position
 *   'hold'    nothing
 *
 * `size` is a FRACTION, never an amount. This file has no idea how much money exists and must not:
 * turning a fraction into wei is the trader's job, under the ceiling, and keeping that boundary is
 * what stops a brain bug from becoming a spend bug.
 */
function decide(brain, result) {
  const r = rates(brain, result);

  if (r.escape.spikes.some((s) => s > 0)) {
    return {
      action: 'escape', size: 1, rates: r,
      why: `DNp01 fired (${r.escape.spikes.join('+')} spikes) — the giant fiber is all-or-none`,
    };
  }

  const feed = r.feed.hz / MAX_HZ;
  const retreat = r.retreat.hz / MAX_HZ;
  const freeze = r.freeze.hz / MAX_HZ;

  // Stopping beats moving. A fly that is freezing is not walking somewhere, and the ambiguous case
  // — everything firing at once — should resolve to doing nothing rather than to doing both.
  if (freeze >= feed && freeze >= retreat) {
    return { action: 'hold', size: 0, rates: r, why: `DNp09 dominant at ${r.freeze.hz.toFixed(1)}Hz` };
  }

  if (feed > retreat) {
    return {
      action: 'buy', size: feed - retreat, rates: r,
      why: `MN9 at ${r.feed.hz.toFixed(1)}Hz against MDN at ${r.retreat.hz.toFixed(1)}Hz`,
    };
  }
  if (retreat > feed) {
    return {
      action: 'reduce', size: retreat - feed, rates: r,
      why: `MDN at ${r.retreat.hz.toFixed(1)}Hz against MN9 at ${r.feed.hz.toFixed(1)}Hz`,
    };
  }
  return { action: 'hold', size: 0, rates: r, why: 'no descending neuron fired' };
}

/** the readout table, for the preflight, the site and the honesty guard */
function readoutReport(brain) {
  return READOUT.map((r) => ({ ...r, neurons: brain.ofType(r.type).length }));
}

module.exports = { READOUT, MAX_HZ, rates, decide, readoutReport };
