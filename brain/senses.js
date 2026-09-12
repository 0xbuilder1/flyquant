/**
 * The market the fly is facing, as sensation.
 *
 * THE DIVISION OF LABOUR. The arena is vision: it says WHICH market, and it carries looming, because
 * a collapse is an expanding object. This file is everything else the animal has — smell, wind,
 * temperature, humidity — and it says what the thing being faced IS LIKE. A fly orients visually and
 * evaluates with the rest of its body.
 *
 * Six channels now, not three. The exchange publishes open interest, funding, basis, depth on both
 * sides and a day's range, and a fly that only smelled two of those was ignoring most of what it had
 * been given. None of this is claimed to be edge. It is more of the world reaching the animal.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE, and it is the only one that matters here:
 *
 *   A CHANNEL MAY ONLY CARRY A SIGNAL WHOSE PUBLISHED INNATE VALENCE MATCHES ITS SIGN.
 *
 * Geosmin makes a fly that has never smelled it walk away. Johnston's organ is how a fly knows which
 * way the wind blows, and it walks into it. Thermoreceptors drive it off a surface that is too warm.
 * Each row below pairs a market quantity with a modality that already responds to that shape of
 * thing — and putting a cost signal into the food channel would produce a fly attracted to expense,
 * which would be OUR fly, not a fly.
 *
 * NOT ONE TUNED CONSTANT, ON PURPOSE. Every channel is a rank among the markets the exchange is
 * currently reporting. A scaling constant is where a "sensory gain" quietly becomes a trading
 * parameter fitted to returns, so there is nowhere to put one.
 *
 * AND THE RANK IS THE WHOLE REASON THIS WORKS — read this before changing a normaliser.
 *
 * The first version of these channels divided each quantity by its largest value in the universe, or
 * by the exchange's own clamp. Measured across all 57 markets, that gives:
 *
 *   open interest   median 5.1e5 against a 5.5e7 maximum   ->  0.9%
 *   funding         median 3.2e-5 against a 0.05 clamp     ->  0.06%
 *   day's range     median 4.8e-2 against a 0.46 maximum   ->  10%
 *
 * So 56 of the 57 markets smelled of nothing and one smelled of everything. It is the SAME
 * denominator mistake that made every position 2-5% of equity before conviction was fixed, and that
 * left steering as noise before the turn was divided by what actually fired: dividing by a ceiling
 * that nothing goes near.
 *
 * A fly does not have this problem, and the reason is published. The antennal lobe performs DIVISIVE
 * NORMALISATION: the local-neuron network scales each glomerulus by the total input across all of
 * them, so a projection neuron reports how strong its channel is RELATIVE TO THE WHOLE POPULATION
 * rather than in absolute units, and the transformation re-centres itself as the ambient distribution
 * moves (Olsen & Wilson 2008; Olsen, Bhandawat & Wilson 2010). It is why a fly can smell a faint
 * odour in clean air and still discriminate against a strong background.
 *
 * Each channel is therefore the fraction of the universe currently BELOW this market on that
 * quantity. Bounded by construction, spans the full range, has no constant, and is invariant to
 * whatever units the exchange happens to publish in — which also means a channel cannot be quietly
 * rescaled, because there is no scale left to touch.
 */
'use strict';

const P = require('./params.js');

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * Divisive normalisation across the population: the share of the universe strictly below x.
 *
 * Strictly below, so that everything tied at the bottom — every market that did not rise, every one
 * whose book has never been read — reads exactly zero and is genuinely not smelled. The top of the
 * distribution reads (n-1)/n rather than 1, which is right: being the strongest of 57 is not the same
 * claim as being at a maximum.
 */
function rank(sorted, x) {
  if (!sorted || !sorted.length || !Number.isFinite(x)) return 0;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
  return lo / sorted.length;
}

const CHANNELS = [
  {
    id: 'food',
    types: ['ORN_DM1', 'ORN_VM2'],
    sense: 'smell · food odour',
    // DM1 and VM2 are the apple-cider-vinegar glomeruli: innately appetitive, driving approach in a
    // fly that has never encountered them before.
    carries: "ground gained since the last pass, against every other market",
    signal: (m) => clamp01(m.rise),
  },
  {
    id: 'geosmin',
    types: ['ORN_DA2'],
    sense: 'smell · geosmin',
    // DA2 is the dedicated geosmin channel — a hardwired labelled line for "toxic microbial growth"
    // that drives avoidance and overrides attractive odours. The one smell a fly is born knowing to
    // run from, carrying the one number that says a market's price has come unmoored from its index.
    carries: 'how far the mark has pulled off its index, against every other market',
    signal: (m) => clamp01(m.basis),
  },
  {
    id: 'cVA',
    types: ['ORN_DA1'],
    sense: 'smell · cVA pheromone',
    // DA1 is the pheromone glomerulus. It reports that OTHER FLIES ARE HERE and nothing about
    // whether they are right — which is exactly what open interest is.
    carries: 'open interest, against every other market',
    signal: (m) => clamp01(m.crowd),
  },
  {
    id: 'wind',
    types: ['JO-EV1', 'JO-EV2', 'JO-EV3', 'JO-EV6', 'JO-ED2_a', 'JO-ED2_c'],
    sense: "hearing · Johnston's organ",
    // The antennal mechanoreceptor. Its static-deflection cells are how a fly knows which way the
    // air is moving, and a fly walks INTO wind — anemotaxis is one of the most reliable behaviours
    // in the animal. The order book leans the same way: more resting bids than asks is flow from one
    // side, and it is the closest thing an exchange has to a prevailing wind.
    carries: 'how lopsided its book is, against every other market',
    signal: (m) => clamp01(m.imbalance),
  },
  {
    id: 'heat',
    types: ['TRN_VP2', 'TRN_VP3a'],
    sense: 'temperature',
    // Thermoreceptors drive a fly off a surface that is too warm. Funding is the same shape of
    // signal: not a danger, a discomfort that accrues the entire time the position is held, and the
    // longer you sit the more it costs.
    carries: 'funding, against every other market',
    signal: (m) => clamp01(m.fundingLoad),
  },
  {
    id: 'humidity',
    types: ['HRN_VP4', 'HRN_VP1d'],
    sense: 'hygrosensation',
    // Hygroreceptors report moisture, and a fly avoids extremes of it. Carried here by how wide the
    // day has been relative to the price — the market's own restlessness, which is neither good nor
    // bad but is something the animal can feel.
    carries: "how wide its day has been, against every other market",
    signal: (m) => clamp01(m.volatility),
  },
];

/**
 * What the exchange said about ONE market, in the exchange's own units. Not yet sensation.
 *
 * Every quantity here is published, or a ratio of published numbers. Nothing is scaled, because the
 * scaling is the population's job and happens in ambient() below.
 */
function raw(m, ctx) {
  const mk = m.market || {};
  const range = Math.max(mk.high - mk.low, 0);
  const mark = m.mark || mk.mark || 0;
  const d = ctx && ctx.depthOf ? ctx.depthOf[m.symbol] : null;

  return {
    // ground gained since the last pass, as a share of the day's range. Only upward: a market that
    // fell does not smell of food, it is seen to loom in the arena instead.
    rise: m.moved != null && range > 0 && m.moved > 0 ? (mark - mark / (1 + m.moved)) / range : 0,
    // the mark against the index it settles toward, as a share of the day's range — a premium that is
    // a rounding error on a wide day is not the same premium on a still one
    basis: (mk.index > 0 && range > 0) ? Math.abs(mark - mk.index) / range : 0,
    crowd: (mk.openInterest || 0) * mark,                    // open interest, in dollars
    fundingLoad: mk.funding == null ? 0 : Math.abs(mk.funding),
    volatility: mark > 0 ? range / mark : 0,
    // Bid-versus-ask depth, from the last time this market's book was read.
    //
    // It cannot be read DURING the pass: the fly chooses which market it is facing while the pass is
    // running, and a book is an async fetch. So the keeper remembers the last book it pulled for each
    // market and the fly feels that — the wind as last measured, which for a market it faced a few
    // minutes ago is a real reading, and for one it has never faced is simply no wind at all.
    imbalance: d && d.bid + d.ask > 0 ? Math.abs(d.bid - d.ask) / (d.bid + d.ask) : 0,
  };
}

// the quantities that get normalised across the population
const QUANTITIES = ['rise', 'basis', 'crowd', 'fundingLoad', 'volatility', 'imbalance'];

/**
 * The ambient distribution: every quantity, sorted, across every market on offer this pass.
 *
 * This is the antennal lobe's denominator. It is rebuilt every pass from the universe as it stands,
 * so the fly's sensitivity follows the market rather than a number written down by us.
 */
function ambient(markets, ctx) {
  const out = {};
  for (const q of QUANTITIES) out[q] = [];
  for (const m of markets) {
    const r = raw(m, ctx);
    for (const q of QUANTITIES) if (Number.isFinite(r[q])) out[q].push(r[q]);
  }
  for (const q of QUANTITIES) out[q].sort((a, z) => a - z);
  return out;
}

/** one market as the animal feels it: each channel's standing in the ambient distribution */
function chemistry(m, ctx) {
  const r = raw(m, ctx);
  const amb = (ctx && ctx.ambient) || null;
  const out = {};
  // With no population to compare against there is no sensation to report. Silence is the honest
  // answer rather than a guess, and it only happens on a pass handed a single market.
  for (const q of QUANTITIES) out[q] = amb ? clamp01(rank(amb[q], r[q])) : 0;
  out.raw = r;
  return out;
}

/** the market in front -> stimulation, plus what it sensed, for the ledger and the site */
function smell(brain, m, ctx) {
  const chem = chemistry(m, ctx);
  const stim = [];
  const signals = {};
  for (const ch of CHANNELS) {
    const x = ch.signal(chem);
    signals[ch.id] = x;
    if (x <= 0) continue;
    const neurons = [];
    for (const t of ch.types) {
      // a channel naming a type this graph does not carry is a config bug, not a silent zero
      try { neurons.push(...brain.ofType(t)); } catch (e) { /* type absent from this build */ }
    }
    if (!neurons.length) continue;
    stim.push({ neurons, rateHz: x * P.R_POI, channel: ch.id });
  }
  return { stim, signals, chem };
}

/** every neuron this product can stimulate chemically, for preflight and the honesty guard */
function channelReport(brain) {
  return CHANNELS.map((ch) => {
    let n = 0;
    for (const t of ch.types) { try { n += brain.ofType(t).length; } catch (e) { /* absent */ } }
    return { id: ch.id, sense: ch.sense, carries: ch.carries, types: ch.types, neurons: n };
  });
}

module.exports = { CHANNELS, smell, chemistry, channelReport, ambient, raw, rank, QUANTITIES };
