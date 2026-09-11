/**
 * What the fly decided, read off its motor output.
 *
 * MaleCNS types 480 distinct descending neurons — the whole channel from brain to body. This file
 * reads five populations, and every one is a published behaviour rather than a chosen abstraction:
 *
 *   LPLC2  looming detector      escape. Expansion-selective, and it drives the giant fiber.
 *   MN9    proboscis extension   feeding. Shiu et al.'s own readout for "this is food".
 *   MDN    the moonwalker        backward walking. Away, deliberately, not in a panic.
 *   DNp09                        stopping. The fly freezes and does nothing.
 *   DNa02  steering              which way — read in arena.js, because it steers DURING the pass.
 *
 * WHY ESCAPE READS LPLC2 AND NOT THE GIANT FIBER. DNp01 is the textbook all-or-none escape trigger
 * and it was the obvious readout, but on retinotopic input it never leaves noise — 3 to 7 spikes
 * whether or not anything is looming (brain/probe-arena.js). LPLC2, one synapse upstream and the
 * published looming-sensitive driver of that same escape, fires 5.7x harder at an expanding patch
 * than at a BIGGER static one. Reading DNp01 anyway would mean reporting a number that is not a
 * signal. DNp01 is still reported, so anyone can watch it stay at noise.
 *
 * THE COST OF THAT MOVE, STATED RATHER THAN BURIED: escape is no longer all-or-none. A population
 * rate competes with the other channels instead of overriding them. The page must say so.
 *
 * Everything here is a RATE over the pass, never a spike. One spike in a 165,836-neuron network is
 * noise; a rate is a decision.
 */
'use strict';

const P = require('./params.js');

// The most any neuron can fire, set by the refractory period alone: 1000/2.2ms. Every channel is
// quoted as a fraction of this, so the four compete on one scale and no weighting constant exists.
const MAX_HZ = 1000 / P.T_RFC;

const READOUT = [
  { id: 'escape', type: 'LPLC2', behaviour: 'looming detection', means: 'close the position' },
  { id: 'feed', type: 'MN9', behaviour: 'proboscis extension', means: 'go long, sized by rate' },
  { id: 'retreat', type: 'MDN', behaviour: 'backward walking', means: 'go short, sized by rate' },
  { id: 'freeze', type: 'DNp09', behaviour: 'stopping', means: 'do nothing this pass' },
  { id: 'steer', type: 'DNa02', behaviour: 'steering', means: 'which market (read in the arena)' },
  { id: 'giantFiber', type: 'DNp01', behaviour: 'escape reflex', means: 'reported, not acted on' },
];

function rates(brain, result) {
  const out = {};
  for (const r of READOUT) {
    const n = brain.ofType(r.type);
    out[r.id] = {
      type: r.type,
      neurons: n.length,
      spikes: n.reduce((a, i) => a + result.spikes[i], 0),
      hz: brain.rateOf(n, result.ms),
    };
  }
  return out;
}

/**
 * rates -> an intent the trader can act on, or refuse to.
 *
 * action is one of 'long' | 'short' | 'escape' | 'hold'. Winner-take-all across four channels on
 * one normalised scale: whichever behaviour the fly is doing hardest is the one that happens.
 *
 * `size` is a FRACTION, never an amount. This file has no idea how much money exists and must not:
 * turning a fraction into a position is the trader's job, under the ceiling, and keeping that
 * boundary is what stops a brain bug from becoming a spend bug.
 */
function decide(brain, result) {
  const r = rates(brain, result);
  const escape = r.escape.hz / MAX_HZ;
  const feed = r.feed.hz / MAX_HZ;
  const retreat = r.retreat.hz / MAX_HZ;
  const freeze = r.freeze.hz / MAX_HZ;

  const top = Math.max(escape, feed, retreat, freeze);
  if (top <= 0) return { action: 'hold', size: 0, rates: r, why: 'no descending neuron fired' };

  // Stopping beats moving on a tie. The ambiguous case — everything firing at once — should resolve
  // to doing nothing rather than to doing both.
  if (freeze === top) {
    return { action: 'hold', size: 0, rates: r, why: `DNp09 dominant at ${r.freeze.hz.toFixed(1)}Hz` };
  }
  if (escape === top) {
    return {
      action: 'escape', size: 1, rates: r,
      why: `LPLC2 at ${r.escape.hz.toFixed(1)}Hz — something is looming`,
    };
  }
  // CONVICTION IS THE NORMALISED DIFFERENCE, not the raw gap.
  //
  // The first version returned feed-retreat as a fraction of MAX_HZ, the refractory ceiling. No
  // neuron in this network goes near 454Hz — MN9 runs at 12-20 — so every position came out at 2-5%
  // of equity and the fly could not have traded a real account if it wanted to. That was an artefact
  // of the denominator, not a judgement the fly was making.
  //
  // (winner - loser) / (winner + loser) spans the full range with no constant: one channel firing
  // alone is total conviction, two firing equally is none. How much money total conviction is worth
  // is the OPERATOR's risk budget and lives in config, which is the boundary that matters — a brain
  // parameter may never be tuned for returns, a position limit is nothing but.
  const conviction = (a, b) => (a + b > 0 ? (a - b) / (a + b) : 0);

  if (feed === top) {
    return {
      action: 'long', size: conviction(feed, retreat), rates: r,
      why: `MN9 at ${r.feed.hz.toFixed(1)}Hz against MDN at ${r.retreat.hz.toFixed(1)}Hz`,
    };
  }
  return {
    action: 'short', size: conviction(retreat, feed), rates: r,
    why: `MDN at ${r.retreat.hz.toFixed(1)}Hz against MN9 at ${r.feed.hz.toFixed(1)}Hz`,
  };
}

/** the readout table, for the preflight, the site and the honesty guard */
function readoutReport(brain) {
  return READOUT.map((r) => ({ ...r, neurons: brain.ofType(r.type).length }));
}

module.exports = { READOUT, MAX_HZ, rates, decide, readoutReport };
