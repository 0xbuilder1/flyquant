/**
 * DOES THE FLY STEER TOWARD ANYTHING, OR IS IT JUST SITTING WHERE IT STARTED?
 *
 * In the backtest it traded XRP 41 times out of 41. That is either fixation — a real fly behaviour —
 * or the steering readout carrying no information at all, and those look identical from the outside.
 * So: put ONE bright market in the arena, once on the left and once on the right, and see which way
 * it turns. A fly that steers turns toward the stripe. A fly whose DNa02 imbalance is noise turns the
 * same way both times, or not at all.
 *
 * This is the same shape as probe-arena.js, and for the same reason: the failure mode is a number
 * that looks plausible and means nothing.
 */
'use strict';

const { Brain } = require('./lif.js');
const A = require('./arena.js');

const brain = Brain.load();
const arena = A.buildArena(brain);
const N = A.N_BANDS, FRONT = A.FRONT;

/** one market, seated exactly where we want it, with nothing else in the arena */
function oneStripe(bandOffset, { bright = 1, ms = 400, seed = 3 } = {}) {
  const markets = [{
    symbol: 'STRIPE', marketId: 0, bright, fall: 0, mark: 100, moved: 0,
    market: { high: 110, low: 90, trades: 100, funding: 0, volume: 1e6 },
  }];
  const seats = new Map([['STRIPE', ((FRONT + bandOffset) % N + N) % N]]);
  const pass = A.runPass(brain, arena, seats, markets, { ms, seed, ctx: null });
  return pass;
}

const OFFSETS = [-24, -12, -6, 6, 12, 24];
console.log(`one bright stripe, moved around the arena. ${N} bands, front = ${FRONT}\n`);
console.log('stripe at      heading after       turned');
let towards = 0, away = 0;
for (const off of OFFSETS) {
  const p = oneStripe(off);
  // a stripe at a NEGATIVE offset sits to the left; turning toward it means a negative heading
  const toward = Math.sign(p.heading) === Math.sign(off) && Math.abs(p.heading) > 0.01;
  const awayFrom = Math.sign(p.heading) === -Math.sign(off) && Math.abs(p.heading) > 0.01;
  if (toward) towards++; if (awayFrom) away++;
  console.log(`  ${String(off).padStart(4)} bands   ${p.heading.toFixed(2).padStart(8)}      ` +
    (toward ? 'TOWARD the stripe' : awayFrom ? 'away from it' : 'barely moved'));
}

console.log(`\ntoward ${towards}/${OFFSETS.length}, away ${away}/${OFFSETS.length}`);

// and the magnitude question: does a brighter stripe turn it harder?
console.log('\nthe same stripe on the right, at different brightness:');
for (const b of [0.2, 0.6, 1.0]) {
  const p = oneStripe(12, { bright: b });
  console.log(`  bright ${(b * 100).toFixed(0).padStart(3)}%   heading ${p.heading.toFixed(2).padStart(7)}`);
}

console.log('\n---');
if (towards >= OFFSETS.length - 1) {
  console.log('THE FLY STEERS. Fixation is then a persistence problem, not a readout problem:');
  console.log('heading resets to zero every pass, so it always starts facing the same seat.');
} else if (towards > away) {
  console.log('Weakly directional — it leans the right way more often than not, but not reliably.');
} else {
  console.log('THE STEERING READOUT CARRIES NO DIRECTION. DNa02 left-right imbalance is noise here,');
  console.log('and the market it "chose" was only ever the one seated in front of it.');
}
