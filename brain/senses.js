/**
 * The market the fly is facing, as smell.
 *
 * THE DIVISION OF LABOUR, AND WHY IT IS NOT ARBITRARY. The arena is vision: it says WHICH market,
 * and it carries looming, because a collapse is an expanding object. This file is chemical: it says
 * whether the thing being faced is GOOD OR BAD. A fly orients visually and evaluates chemically,
 * and the first version of the arena forgot the second half — it drove everything through the optic
 * lobe and then wondered why MN9, a proboscis motor neuron, never fired. A fly does not extend its
 * proboscis because it saw something across the room.
 *
 * The smell is of WHATEVER IS CURRENTLY IN FRONT. As the fly turns, the smell changes with it. That
 * is a plume: you smell what you are pointed at, and turning toward it is how a fly finds a plume in
 * the first place.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE:
 *
 *   A CHANNEL MAY ONLY CARRY A SIGNAL WHOSE PUBLISHED INNATE VALENCE MATCHES ITS SIGN.
 *
 * Geosmin makes a fly that has never smelled it walk away; that is why DA2 can carry funding. Wiring
 * funding into the food channel would produce a fly that is attracted to the cost of holding, and it
 * would be OUR fly doing that, not a fly.
 *
 * THERE IS NOT ONE TUNED CONSTANT IN THIS FILE, ON PURPOSE. Every channel is a fraction of something
 * the exchange already reports — a share of the day's range, a share of the funding clamp, a share
 * of the busiest market's trade count. A scaling constant is where a "sensory gain" would quietly
 * become a trading parameter fitted to returns, so there is nowhere to put one.
 */
'use strict';

const P = require('./params.js');

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

const CHANNELS = [
  {
    id: 'food',
    types: ['ORN_DM1', 'ORN_VM2'],
    smell: 'food odour',
    // DM1 and VM2 are the apple-cider-vinegar / attractive food-odour glomeruli: innately
    // appetitive, driving approach in a naive fly.
    carries: "the share of today's range gained since the last pass",
    // the exact mirror of the arena's `fall`, which is what makes long and short symmetric
    signal: (m) => clamp01(m.rise),
  },
  {
    id: 'geosmin',
    types: ['ORN_DA2'],
    smell: 'geosmin',
    // DA2 is the dedicated geosmin channel: a hardwired labelled line for "toxic microbial growth"
    // that drives avoidance and overrides attractive odours. The one smell a fly is born knowing to
    // run from, carrying the one number a leveraged holder is born knowing to run from.
    carries: 'funding, against the exchange\'s own small-clamp',
    signal: (m) => clamp01(m.fundingLoad),
  },
  {
    id: 'cVA',
    types: ['ORN_DA1'],
    smell: 'cVA pheromone',
    // DA1 is the pheromone glomerulus: it reports that OTHER FLIES ARE HERE. Social, neither
    // appetitive nor aversive, and it carries the crowd without any claim the crowd is right.
    carries: "trade count against the busiest market's",
    signal: (m) => clamp01(m.crowd),
  },
];

/** derive the chemical view of one market. Every field lands in [0,1] by construction. */
function chemistry(m, ctx) {
  const range = Math.max(m.market.high - m.market.low, 0);
  const rise = m.moved != null && range > 0 && m.moved > 0
    ? (m.mark - m.mark / (1 + m.moved)) / range
    : 0;
  const clampSmall = ctx.fundingClampSmall || 0.05;
  return {
    rise: clamp01(rise),
    fundingLoad: m.market.funding == null ? 0 : clamp01(Math.abs(m.market.funding) / clampSmall),
    crowd: ctx.tradesMax > 0 ? clamp01(m.market.trades / ctx.tradesMax) : 0,
  };
}

/** the market in front -> stimulation, plus what it smelled of, for the ledger and the site */
function smell(brain, m, ctx) {
  const chem = chemistry(m, ctx);
  const stim = [];
  const signals = {};
  for (const ch of CHANNELS) {
    const x = ch.signal(chem);
    signals[ch.id] = x;
    if (x <= 0) continue;
    const neurons = [];
    for (const t of ch.types) neurons.push(...brain.ofType(t));
    stim.push({ neurons, rateHz: x * P.R_POI, channel: ch.id });
  }
  return { stim, signals, chem };
}

/** every neuron this product can stimulate chemically, for preflight and the honesty guard */
function channelReport(brain) {
  return CHANNELS.map((ch) => ({
    id: ch.id,
    smell: ch.smell,
    carries: ch.carries,
    types: ch.types,
    neurons: ch.types.reduce((n, t) => n + brain.ofType(t).length, 0),
  }));
}

module.exports = { CHANNELS, smell, chemistry, channelReport };
