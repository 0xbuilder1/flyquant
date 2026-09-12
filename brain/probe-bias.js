/**
 * WHY IS IT ALWAYS LONG?
 *
 * 88% of recorded decisions are LONG, with a median feed drive of 22.9Hz against a median retreat
 * drive of 2.9Hz. Before that is accepted as "what the animal does" and levered ten times, it has to
 * be separated from the alternative: that our STIMULUS cannot reach the retreat pathway at all, so
 * the fly is not choosing to go long, it is simply unable to express anything else.
 *
 * That is not a hypothetical failure mode in this repo. It has happened twice. Stimulating the
 * lamina showed the fly darkness because L1 is inhibited by photoreceptors. Steering read off two
 * neurons and turned out to be noise. Both looked like behaviour and were wiring.
 *
 * THE EXPERIMENT. Drive one channel at a time, at full rate, with nothing else on, and read MN9
 * (feed, long) against MDN (retreat, short). If the aversive channels — geosmin especially, the one
 * smell a fly is born fleeing — move MDN, then the pathway works and the long bias is a property of
 * the animal under these inputs. If NOTHING moves MDN, the short side is disconnected and every
 * "decision" this product has ever made was a foregone conclusion.
 *
 *     node brain/probe-bias.js
 */
'use strict';

const path = require('path');
const { Brain } = require('./lif.js');
const { CHANNELS } = require('./senses.js');
const { decide } = require('./readout.js');
const P = require('./params.js');

const MS = 300;

function run(brain, stimSpec, seed = 1) {
  const stim = () => stimSpec.map(({ types, rate }) => {
    const neurons = [];
    for (const t of types) { try { neurons.push(...brain.ofType(t)); } catch (e) { /* absent */ } }
    return { neurons, rateHz: rate };
  }).filter((x) => x.neurons.length);
  const result = brain.run({ stim, ms: MS, seed, chunkMs: 20 });
  return decide(brain, result);
}

function main() {
  const brain = Brain.load(path.join(__dirname, 'graph'));
  console.log(`fly: ${brain.n.toLocaleString()} neurons\n`);
  console.log('One channel at a time, driven at full rate, nothing else on.\n');
  console.log('  channel      MN9 (long)   MDN (short)   verdict');

  const rows = [];
  for (const ch of CHANNELS) {
    const d = run(brain, [{ types: ch.types, rate: P.R_POI }]);
    const mn9 = d.rates.feed.hz, mdn = d.rates.retreat.hz;
    rows.push({ id: ch.id, mn9, mdn });
    console.log(`  ${ch.id.padEnd(12)} ${mn9.toFixed(1).padStart(7)}Hz ${mdn.toFixed(1).padStart(11)}Hz   ` +
      `${d.action.toUpperCase()} ${(d.size * 100).toFixed(0)}%`);
  }

  // and the visual escape channel, which is the other thing that can close a position
  console.log('');
  const anyMdn = rows.some((r) => r.mdn > 0);
  const aversive = rows.filter((r) => ['geosmin', 'heat', 'humidity'].includes(r.id));
  const aversiveMovesMdn = aversive.some((r) => r.mdn > 0);

  console.log('  ── VERDICT ' + '─'.repeat(70));
  if (!anyMdn) {
    console.log('  NO CHANNEL DRIVES MDN AT ALL. The short side is disconnected from every sensory');
    console.log('  input this product has. The fly cannot go short, and the 88% long is an artifact');
    console.log('  of the wiring we built, not a decision the animal made. DO NOT LEVER THIS.');
  } else if (!aversiveMovesMdn) {
    console.log('  MDN fires, but NOT from the aversive channels. Whatever is driving the retreat');
    console.log('  pathway, it is not the signals we chose to mean "bad" — so the short side exists');
    console.log('  but is not connected to the thing it is supposed to represent.');
  } else {
    console.log('  The aversive channels DO drive MDN. The retreat pathway is reachable and the long');
    console.log('  bias is a property of the animal under these inputs, not a disconnected wire.');
  }

  // how asymmetric is the pathway itself, independent of any stimulus?
  const mn9n = brain.ofType('MN9').length, mdnn = brain.ofType('MDN').length;
  console.log(`\n  MN9 is ${mn9n} neurons, MDN is ${mdnn}. Presynaptic partners:`);
  for (const [name, idx] of [['MN9', brain.ofType('MN9')], ['MDN', brain.ofType('MDN')]]) {
    let inEdges = 0, inWeight = 0;
    const set = new Set(idx);
    for (let i = 0; i < brain.n; i++) {
      for (let k = brain.offsets[i]; k < brain.offsets[i + 1]; k++) {
        if (set.has(brain.targets[k])) { inEdges++; inWeight += brain.weights[k]; }
      }
    }
    console.log(`    ${name}: ${inEdges.toLocaleString()} incoming edges, ${inWeight.toLocaleString()} synapses`);
  }
}

main();
