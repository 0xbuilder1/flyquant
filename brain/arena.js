/**
 * The arena. 57 markets, one fly, one pass.
 *
 * The fly is tethered at the centre of a panorama. Every market has a fixed seat at an azimuth, all
 * of them are in the visual field at once, and the fly turns. Whatever it ends up facing is what it
 * trades. This is the standard Drosophila flight-simulator paradigm and MaleCNS makes it literal:
 * every columnar optic-lobe neuron carries a retinotopic hex coordinate, giving 36 azimuth bands
 * per eye and 1,769 addressable columns.
 *
 * WHAT A MARKET LOOKS LIKE TO THE FLY
 *
 *   brightness   how hard its band is driven — the market's 24h volume against the busiest market
 *   expansion    its patch GROWS across the pass when the price is falling — a looming object
 *
 * Those are the only two, and both are naturally bounded fractions, so there is no gain constant
 * anywhere in this file to quietly fit to returns. A fly fixates small bright stripes and flees
 * expanding ones; both behaviours are published, and they are opposite, which is exactly what makes
 * the arena able to express "that one" and "not that one" with one mechanism.
 *
 * WE ENTER AT THE MEDULLA. Stimulating the lamina does nothing, because Mi1 <- L1 is 141,873
 * synapses at sign negative: L1 is glutamatergic, photoreceptors are histaminergic and inhibit it,
 * so injecting current into L1 shows the fly DARKNESS. Tm1/Tm2/Tm4/Tm9/Tm20 are retinotopic AND are
 * LC4's own excitatory inputs, and from there the looming selectivity is the connectome's own: an
 * expanding patch fires LPLC2 5.7x harder than a BIGGER static one. See brain/probe-arena.js.
 */
'use strict';

const P = require('./params.js');
const { smell } = require('./senses.js');

// retinotopic, excitatory, and direct inputs to the looming detectors
const INPUT_TYPES = ['Tm1', 'Tm2', 'Tm4', 'Tm9', 'Tm20'];

const BANDS_PER_EYE = 36;
const N_BANDS = BANDS_PER_EYE * 2;
// Straight ahead. The two eyes' hex1=1 edges meet here — a CONVENTION about the lattice's polarity,
// published rather than derived, because the annotation does not carry an axis direction.
const FRONT = BANDS_PER_EYE;
const MAX_EXPANSION = 6;          // bands a fully looming market grows to either side
// An object has WIDTH. A market lighting a single column is below the acuity at which this fly
// detects objects at all — the smallest patch that ever moved LC4 in probe-arena.js was three bands
// — so every market is at least an object and not a line. This is a statement about the arena's
// geometry, not a gain: it does not scale with anything and cannot be fitted to returns.
const BASE_RADIUS = 1;

/**
 * Build the arena once: 72 azimuth bands, each the medulla input neurons sitting at that hex1.
 * Bands run left eye outer -> front -> right eye outer, so band index IS azimuth order.
 */
function buildArena(brain) {
  const columns = require('./graph/columns.json');
  const input = new Set();
  for (const t of INPUT_TYPES) for (const i of brain.ofType(t)) input.add(i);

  const bands = [];
  for (let b = 0; b < N_BANDS; b++) bands.push([]);
  for (const key of Object.keys(columns)) {
    const [side, h1] = key.split(':');
    const x = Number(h1);
    if (!(x >= 1 && x <= BANDS_PER_EYE)) continue;
    // left eye: hex1 1 is nearest the front, so it sits just left of centre
    const b = side === 'L' ? FRONT - x : (side === 'R' ? FRONT + x - 1 : -1);
    if (b < 0 || b >= N_BANDS) continue;
    for (const i of columns[key]) if (input.has(i)) bands[b].push(i);
  }

  const empty = bands.filter((x) => !x.length).length;
  if (empty > N_BANDS / 4) throw new Error(`${empty} of ${N_BANDS} arena bands have no input neurons`);
  return {
    bands: bands.map((x) => Int32Array.from(x)),
    neurons: bands.reduce((a, x) => a + x.length, 0),
    emptyBands: empty,
    inputTypes: INPUT_TYPES,
  };
}

/**
 * Seat the markets. By market_id, ascending, spread evenly over the 72 bands — arbitrary but FIXED
 * and published, so the map can be checked and a replay lands in the same seats. Seating by
 * anything meaningful (volume, correlation) would make the fly's choice partly our choice, because
 * we would be deciding what sits next to what.
 */
function seatMarkets(markets) {
  const sorted = [...markets].sort((a, z) => a.marketId - z.marketId);
  const seats = new Map();
  for (let k = 0; k < sorted.length; k++) {
    seats.set(sorted[k].symbol, Math.round((k * N_BANDS) / sorted.length) % N_BANDS);
  }
  return seats;
}

/**
 * One pass. Closed loop: every chunk the arena rotates by however much the fly has just turned, so
 * the fly can FIXATE something rather than being read off once at the end.
 *
 * markets: [{ symbol, marketId, bright, fall }] with bright and fall already in [0,1].
 */
function marketAtFront(markets, seats, heading) {
  let best = null, bestDist = Infinity;
  for (const m of markets) {
    const seat = seats.get(m.symbol);
    if (seat == null) continue;
    const shown = ((seat - Math.round(heading)) % N_BANDS + N_BANDS) % N_BANDS;
    let d = Math.abs(shown - FRONT);
    d = Math.min(d, N_BANDS - d);
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return best;
}

function runPass(brain, arena, seats, markets, { ms = 400, seed = 1, chunkMs = 20, ctx = null } = {}) {
  const dna02 = brain.ofType('DNa02');
  const left = dna02.filter((i) => brain.side[i] === 1);
  const right = dna02.filter((i) => brain.side[i] === 2);
  if (!left.length || !right.length) throw new Error('DNa02 does not have a left and a right');

  // Full deflection sweeps the whole panorama in one pass, which is what sets the turn gain — not a
  // constant anybody chose. A neuron cannot fire faster than one spike per refractory period, so
  // the largest imbalance a chunk can show is known in advance.
  const maxPerChunk = (chunkMs / P.T_RFC) * Math.max(left.length, right.length);
  const chunks = Math.max(1, Math.round(ms / chunkMs));
  const bandsPerChunk = N_BANDS / chunks;

  let heading = 0;                      // in bands, + is a rightward turn
  let lastL = 0, lastR = 0;
  let lastFront = null, lastSignals = null;
  const trace = [];

  const stim = ({ ms: t, spikes }) => {
    if (spikes) {
      let l = 0, r = 0;
      for (const i of left) l += spikes[i];
      for (const i of right) r += spikes[i];
      const dl = l - lastL, dr = r - lastR;
      lastL = l; lastR = r;
      heading += ((dr - dl) / maxPerChunk) * bandsPerChunk;
      trace.push({ ms: t, heading, dl, dr });
    }
    const frac = ms > 0 ? t / ms : 0;
    const out = [];
    for (const m of markets) {
      const seat = seats.get(m.symbol);
      if (seat == null) continue;
      // the seat drifts across the eye as the fly turns
      const shown = ((seat - Math.round(heading)) % N_BANDS + N_BANDS) % N_BANDS;
      // a falling market expands across the pass; a steady one stays a point
      const radius = BASE_RADIUS + Math.floor(m.fall * MAX_EXPANSION * frac);
      const neurons = [];
      for (let d = -radius; d <= radius; d++) {
        const b = ((shown + d) % N_BANDS + N_BANDS) % N_BANDS;
        for (const i of arena.bands[b]) neurons.push(i);
      }
      if (!neurons.length || m.bright <= 0) continue;
      out.push({ neurons, rateHz: m.bright * P.R_POI });
    }

    // and the fly smells whatever it is currently pointed at. This is what gives the chemical
    // readouts — MN9, MDN — anything to fire from: vision says WHICH, chemistry says GOOD OR BAD.
    if (ctx) {
      const front = marketAtFront(markets, seats, heading);
      if (front) {
        lastFront = front;
        const { stim: chem, signals } = smell(brain, front, ctx);
        lastSignals = signals;
        for (const c of chem) out.push(c);
      }
    }
    return out;
  };

  const result = brain.run({ stim, ms, seed, chunkMs });

  // what the fly ended up facing
  const chosen = marketAtFront(markets, seats, heading);
  let bestDist = Infinity;
  if (chosen) {
    const shown = ((seats.get(chosen.symbol) - Math.round(heading)) % N_BANDS + N_BANDS) % N_BANDS;
    bestDist = Math.min(Math.abs(shown - FRONT), N_BANDS - Math.abs(shown - FRONT));
  }

  return {
    result, chosen, distance: bestDist, heading, turned: Math.abs(heading), trace,
    smelled: lastSignals, smelledOf: lastFront ? lastFront.symbol : null,
  };
}

module.exports = {
  buildArena, seatMarkets, runPass, marketAtFront,
  INPUT_TYPES, N_BANDS, FRONT, MAX_EXPANSION, BASE_RADIUS,
};
