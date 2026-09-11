/**
 * The market, as smells.
 *
 * Four channels. Each one is a named glomerulus or visual projection type whose INNATE valence is
 * published, carrying a market quantity whose sign matches that valence.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE, and the only one that matters here:
 *
 *   A CHANNEL MAY ONLY CARRY A SIGNAL WHOSE PUBLISHED INNATE VALENCE MATCHES ITS SIGN.
 *
 * Geosmin makes a fly that has never smelled it walk away; that is why DA2 can carry a rug signal.
 * Putting the rug signal into the food channel would produce a fly that buys rugs, and it would be
 * OUR fly doing it, not a fly.
 *
 * THERE IS NOT ONE TUNED CONSTANT IN THIS FILE, ON PURPOSE. Every channel is driven by a quantity
 * that is already a fraction of something the chain reports — a share of flow, a share of swaps, a
 * fraction of liquidity withdrawn, a fraction of price lost. A scaling constant is where a "sensory
 * gain" would quietly become a trading parameter fitted to returns, so there is nowhere to put one.
 * The only free choice is the observation window, which lives in the config and is published.
 *
 * Money arrives here as BigInt raw units and stays integer until the last line of each channel,
 * where it becomes a firing rate. A float may describe a neuron. It may never describe a balance.
 */
'use strict';

const P = require('./params.js');

/** integer fraction -> [0,1] float, without ever putting money in a double.
    Numerator and denominator are wei; the ratio is dimensionless and safe. */
function frac(num, den) {
  if (den <= 0n) return 0;
  if (num <= 0n) return 0;
  if (num >= den) return 1;
  return Number((num * 1000000n) / den) / 1000000;
}

/**
 * The channels, with what each one is and why it may carry what it carries.
 *
 * `hz` is the Poisson rate injected into every neuron of the listed types, capped at the rate Shiu
 * et al. stimulate with. A channel at 0 Hz is a smell that is not there.
 */
const CHANNELS = [
  {
    id: 'food',
    types: ['ORN_DM1', 'ORN_VM2'],
    smell: 'food odour',
    // DM1 and VM2 are the apple-cider-vinegar / attractive food-odour glomeruli: innately
    // appetitive, driving approach in a naive fly.
    carries: 'buying in the window, against the depth of the pool it arrived in',
    // CONCENTRATION, NOT RATIO. An ORN's firing rate encodes how much odorant is present, and the
    // first version of this line used buy/(buy+sell) — which reads 50% on a coin with 0.01 ETH of
    // volume either way and had the fly buying something nobody was trading. A faint smell is
    // faint. Scaling against pool depth also makes it self-normalising across coins: the same ether
    // of buying is a strong smell in a thin pool and a weak one in a deep pool, which is true.
    signal: (o) => frac(o.buyRaw, o.buyRaw + o.liqNow),
  },
  {
    id: 'geosmin',
    types: ['ORN_DA2'],
    smell: 'geosmin',
    // DA2 is the dedicated geosmin channel: a hardwired, labelled line for "toxic microbial
    // growth" that drives avoidance and overrides attractive odours. The one smell a fly is born
    // knowing to run from, carrying the one signal a holder is born knowing to run from.
    carries: 'the fraction of pool liquidity withdrawn in the window',
    signal: (o) => frac(o.liqPrev > o.liqNow ? o.liqPrev - o.liqNow : 0n, o.liqPrev),
  },
  {
    id: 'cVA',
    types: ['ORN_DA1'],
    smell: 'cVA pheromone',
    // DA1 is the pheromone glomerulus: it reports that OTHER FLIES ARE HERE, and it is social
    // rather than appetitive or aversive. It carries the crowd and nothing about whether the crowd
    // is right.
    carries: "this coin's share of swaps across every listed coin",
    signal: (o) => frac(BigInt(o.swaps), BigInt(o.swapsAll)),
  },
  {
    id: 'looming',
    types: ['LC4', 'LPLC2'],
    smell: 'an object expanding on the eye',
    // LC4 and LPLC2 are looming-sensitive visual projection neurons converging on the giant fiber.
    // This is the one channel that is not a metaphor: a price collapsing IS an object getting
    // bigger, fast, and the fraction of the mark lost in the window is its angular expansion.
    carries: 'the fraction of the mark lost in the window',
    signal: (o) => frac(o.markPrev > o.markNow ? o.markPrev - o.markNow : 0n, o.markPrev),
  },
];

/**
 * An observation of one coin, over one window, turned into stimulation.
 *
 * obs = {
 *   buyRaw, sellRaw   wei of quote bought / sold in the window   (BigInt)
 *   liqPrev, liqNow   pool liquidity at each end of the window   (BigInt)
 *   markPrev, markNow the V4 mark at each end of the window      (BigInt, X18)
 *   swaps, swapsAll   swap counts, this coin and every listed coin (Number)
 * }
 *
 * Returns { stim, signals } — stim for Brain.run, signals for the ledger and the site, so that
 * what the fly smelled is recorded next to what the fly did.
 */
function smell(brain, obs) {
  const stim = [];
  const signals = {};
  for (const ch of CHANNELS) {
    const x = ch.signal(obs);
    signals[ch.id] = x;
    if (x <= 0) continue;
    const neurons = [];
    for (const t of ch.types) neurons.push(...brain.ofType(t));
    stim.push({ neurons, rateHz: x * P.R_POI, channel: ch.id });
  }
  return { stim, signals };
}

/** every neuron this product can stimulate, for the preflight and the honesty guard */
function channelReport(brain) {
  return CHANNELS.map((ch) => ({
    id: ch.id,
    smell: ch.smell,
    carries: ch.carries,
    types: ch.types,
    neurons: ch.types.reduce((n, t) => n + brain.ofType(t).length, 0),
  }));
}

module.exports = { CHANNELS, smell, channelReport, frac };
