/**
 * The brain suite. It is a BIOLOGY test, not a unit test.
 *
 * The thing that can go wrong here is not an exception — it is a simulation that runs beautifully
 * and is not a fly. So the assertions are published facts about this animal: stimulate the looming
 * detectors and the giant fiber should fire, because that is the escape reflex and it is one of the
 * best-characterised circuits in the insect brain. If that stops holding, something upstream is
 * wrong (a sign flipped, a delay lost, the graph rebuilt with the wrong cut) and no amount of green
 * unit tests would tell you.
 */
'use strict';

const assert = require('assert');
const { Brain } = require('./lif.js');
const P = require('./params.js');

let pass = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('loading graph');
const t0 = Date.now();
const brain = Brain.load();
console.log(`  ${brain.n.toLocaleString()} neurons, ${brain.targets.length.toLocaleString()} edges, ${Date.now() - t0}ms`);

console.log('\ngraph');
ok('the graph is the size the manifest says', () => {
  assert.strictEqual(brain.n, brain.manifest.neurons);
  assert.strictEqual(brain.targets.length, brain.manifest.edges);
});
ok('every channel the product names resolves to real neurons', () => {
  for (const t of ['ORN_DM1', 'ORN_VM2', 'ORN_DA2', 'ORN_DA1', 'LC4', 'LPLC2', 'DNp01', 'DNp09', 'DNa02']) {
    assert.ok(brain.ofType(t).length > 0, t);
  }
});
ok('the giant fiber is a pair', () => assert.strictEqual(brain.ofType('DNp01').length, 2));
ok('inhibition exists and is a minority', () => {
  let inh = 0, exc = 0;
  for (let i = 0; i < brain.n; i++) { if (brain.sign[i] < 0) inh++; else if (brain.sign[i] > 0) exc++; }
  assert.ok(inh > 50000 && inh < exc, `${inh} inhibitory vs ${exc} excitatory`);
});

console.log('\ndynamics');
ok('a silent fly never spikes', () => {
  const r = brain.run({ stim: [], ms: 200, seed: 1 });
  let total = 0; for (let i = 0; i < brain.n; i++) total += r.spikes[i];
  assert.strictEqual(total, 0, `${total} spikes with no input`);
});
ok('a stimulated neuron fires at about the rate it is driven', () => {
  const one = [brain.ofType('DNp01')[0]];
  brain.run({ stim: [{ neurons: one, rateHz: 100 }], ms: 1000, seed: 7 });
  const hz = brain.spikes[one[0]];
  // not exactly 100: the refractory period swallows hits that land inside it
  assert.ok(hz > 60 && hz <= 100, `${hz} Hz from a 100 Hz drive`);
});
ok('the same seed gives the same fly, to the spike', () => {
  const lc = brain.ofType('LC4');
  const a = Uint32Array.from(brain.run({ stim: [{ neurons: lc, rateHz: 150 }], ms: 300, seed: 42 }).spikes);
  const b = Uint32Array.from(brain.run({ stim: [{ neurons: lc, rateHz: 150 }], ms: 300, seed: 42 }).spikes);
  assert.deepStrictEqual(a, b);
});
ok('a different seed gives a different fly', () => {
  const lc = brain.ofType('LC4');
  const a = Uint32Array.from(brain.run({ stim: [{ neurons: lc, rateHz: 150 }], ms: 300, seed: 1 }).spikes);
  const b = Uint32Array.from(brain.run({ stim: [{ neurons: lc, rateHz: 150 }], ms: 300, seed: 2 }).spikes);
  assert.notDeepStrictEqual(a, b);
});

console.log('\nbiology — the escape reflex');
const MS = 1000;
const looming = [...brain.ofType('LC4'), ...brain.ofType('LPLC2')];
const gf = brain.ofType('DNp01');

const t1 = Date.now();
const loom = brain.run({ stim: [{ neurons: looming, rateHz: P.R_POI }], ms: MS, seed: 3 });
const gfLoom = gf.map((i) => loom.spikes[i]);
let activeCount = 0; for (let i = 0; i < brain.n; i++) if (loom.spikes[i] > 0) activeCount++;
console.log(`  ${MS}ms of looming: ${activeCount.toLocaleString()} neurons fired, ${Date.now() - t1}ms of CPU`);
console.log(`  DNp01 (giant fiber): ${gfLoom.join(' and ')} spikes`);

const ctrl = brain.run({ stim: [{ neurons: brain.ofType('ORN_DM1'), rateHz: P.R_POI }], ms: MS, seed: 3 });
const gfCtrl = gf.map((i) => ctrl.spikes[i]);
console.log(`  control (food odour instead): DNp01 ${gfCtrl.join(' and ')} spikes`);

ok('looming drives the giant fiber', () => {
  assert.ok(gfLoom.reduce((a, b) => a + b, 0) > 0,
    'LC4+LPLC2 stimulation produced no DNp01 spikes — the escape pathway is not intact');
});
ok('an unrelated odour does not drive the giant fiber as hard', () => {
  assert.ok(gfLoom.reduce((a, b) => a + b, 0) > gfCtrl.reduce((a, b) => a + b, 0),
    'food odour drives the escape neuron as hard as looming does, so the readout means nothing');
});

console.log(`\n${pass} passed`);
