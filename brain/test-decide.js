/**
 * The whole loop, on synthetic markets: smell -> 165,836 neurons -> a decision.
 *
 * This is the suite that can tell you the product does not work. The brain suite proves the
 * simulation is a fly; this one asks whether a fly, shown a market, does anything USEFUL — and a
 * fly that escapes in every scenario or holds in every scenario is a fly with a wallet and no
 * product. The scenarios below are deliberately extreme, because the first thing worth knowing is
 * whether the readout separates them at all.
 *
 * The numbers it prints are not assertions about profit and must never become any. They are the
 * evidence for one claim only: DIFFERENT MARKETS PRODUCE DIFFERENT BEHAVIOUR.
 */
'use strict';

const { Brain } = require('./lif.js');
const { smell } = require('./senses.js');
const { decide } = require('./readout.js');

const E = (n) => BigInt(Math.round(n * 1e18));
const MS = 500;
const SEED = 11;

const SCENARIOS = [
  {
    name: 'healthy — buyers, liquidity steady, price up',
    obs: { buyRaw: E(8), sellRaw: E(2), liqPrev: E(100), liqNow: E(105),
           markPrev: E(0.001), markNow: E(0.0012), swaps: 80, swapsAll: 200 },
  },
  {
    name: 'crash — price down 40% in the window',
    obs: { buyRaw: E(1), sellRaw: E(9), liqPrev: E(100), liqNow: E(98),
           markPrev: E(0.001), markNow: E(0.0006), swaps: 120, swapsAll: 200 },
  },
  {
    name: 'rug — 60% of pool liquidity withdrawn',
    obs: { buyRaw: E(3), sellRaw: E(7), liqPrev: E(100), liqNow: E(40),
           markPrev: E(0.001), markNow: E(0.00095), swaps: 40, swapsAll: 200 },
  },
  {
    name: 'dead — nobody is trading it',
    obs: { buyRaw: E(0.01), sellRaw: E(0.01), liqPrev: E(100), liqNow: E(100),
           markPrev: E(0.001), markNow: E(0.001), swaps: 1, swapsAll: 200 },
  },
  {
    name: 'mania — everyone is here and buying',
    obs: { buyRaw: E(50), sellRaw: E(10), liqPrev: E(100), liqNow: E(140),
           markPrev: E(0.001), markNow: E(0.003), swaps: 180, swapsAll: 200 },
  },
];

const brain = Brain.load();
console.log(`${brain.n.toLocaleString()} neurons, ${brain.targets.length.toLocaleString()} edges, ${MS}ms per scenario, seed ${SEED}\n`);

const seen = new Set();
for (const s of SCENARIOS) {
  const { stim, signals } = smell(brain, s.obs);
  const t0 = Date.now();
  const result = brain.run({ stim, ms: MS, seed: SEED });
  const d = decide(brain, result);

  let fired = 0;
  for (let i = 0; i < brain.n; i++) if (result.spikes[i] > 0) fired++;

  const sig = Object.entries(signals).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join('  ');
  console.log(s.name);
  console.log(`  smelled   ${sig}`);
  console.log(`  fired     ${fired.toLocaleString()} neurons in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  DNp01 ${d.rates.escape.spikes.join('/')}   MN9 ${d.rates.feed.hz.toFixed(0)}Hz   ` +
              `MDN ${d.rates.retreat.hz.toFixed(0)}Hz   DNp09 ${d.rates.freeze.hz.toFixed(0)}Hz`);
  console.log(`  DECIDED   ${d.action.toUpperCase()} ${d.action === 'hold' ? '' : (d.size * 100).toFixed(1) + '% '}— ${d.why}\n`);
  seen.add(d.action);
}

console.log(`distinct behaviours across ${SCENARIOS.length} scenarios: ${[...seen].join(', ')}`);
if (seen.size < 2) {
  console.log('\nTHE FLY DOES THE SAME THING WHATEVER IT IS SHOWN. That is not a product yet.');
  process.exitCode = 1;
}
