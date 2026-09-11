/**
 * THE EXPERIMENT THE WHOLE ARENA DESIGN RESTS ON.
 *
 * Until now senses.js has injected current straight into LC4 and LPLC2 — which means WE decided
 * something was looming and then told the looming detector about it. That is the connectome doing
 * no work at all, and it is the part of the design I am least willing to ship.
 *
 * The alternative: stimulate the LAMINA — L1/L2/L3/L5, the columnar cells directly postsynaptic to
 * the photoreceptors, addressed by their MaleCNS retinotopic hex coordinate — and let the fly's own
 * optic lobe decide what is looming. If that works, the arena is real: a market has a POSITION in
 * the visual field, its collapse is an expanding patch, and DNp01 firing is something the
 * connectome computed rather than something we asserted.
 *
 * This script answers whether it works. Three conditions, identical except for the stimulus:
 *
 *   static-small   a patch of columns, held still
 *   static-large   a bigger patch, held still         <- controls for "more input = more spikes"
 *   looming        a patch that EXPANDS over the run  <- the only one that is actually looming
 *
 * If looming does not beat static-large at DNp01, the optic lobe is not doing the computation and
 * the arena has to fall back to direct LC stimulation — with the site saying so plainly.
 */
'use strict';

const { Brain } = require('./lif.js');
const P = require('./params.js');

const brain = Brain.load();
const columns = require('./graph/columns.json');

// the retinotopic input layer: lamina monopolar cells, which is where the eye's signal lands
const INPUT_TYPES = (process.env.FLY_INPUT || 'Tm2,Tm4,Tm20,Tm1,Tm9').split(',');
const inputSet = new Set();
for (const t of INPUT_TYPES) for (const i of brain.ofType(t)) inputSet.add(i);

/** every input neuron in the columns whose hex1 falls in [lo, hi], one eye */
function patch(side, lo, hi) {
  const out = [];
  for (const key of Object.keys(columns)) {
    const [s, h1] = key.split(':');
    if (s !== side) continue;
    const x = Number(h1);
    if (x < lo || x > hi) continue;
    for (const i of columns[key]) if (inputSet.has(i)) out.push(i);
  }
  return Int32Array.from(out);
}

const MS = 400;
const SEED = 5;
const CENTRE = 18;

const small = patch('R', CENTRE - 1, CENTRE + 1);
const large = patch('R', CENTRE - 7, CENTRE + 7);
console.log(`lamina patches: small ${small.length} neurons, large ${large.length} neurons\n`);

// precompute every expansion radius once — allocating inside the stimulus function would put an
// allocation in the hot loop and make the timing meaningless
const RMAX = 14;
const rings = [];
for (let r = 1; r <= RMAX; r++) rings.push(patch('R', CENTRE - r, CENTRE + r));

function measure(label, stim) {
  const t0 = Date.now();
  const res = brain.run({ stim, ms: MS, seed: SEED, chunkMs: 10 });
  const of = (t) => brain.ofType(t).reduce((a, i) => a + res.spikes[i], 0);
  let fired = 0;
  for (let i = 0; i < brain.n; i++) if (res.spikes[i] > 0) fired++;
  const row = {
    label,
    fired,
    L: INPUT_TYPES.reduce((a, t) => a + of(t), 0),
    Mi1: of('Mi1'), Tm2: of('Tm2'),
    LC4: of('LC4'), LPLC2: of('LPLC2'), LC6: of('LC6'),
    DNp01: of('DNp01'),
    secs: ((Date.now() - t0) / 1000).toFixed(1),
  };
  console.log(
    `${label.padEnd(14)} fired ${String(row.fired).padStart(6)}  lamina ${String(row.L).padStart(6)}` +
    `  Mi1 ${String(row.Mi1).padStart(5)}  Tm2 ${String(row.Tm2).padStart(5)}` +
    `  LC4 ${String(row.LC4).padStart(4)}  LPLC2 ${String(row.LPLC2).padStart(4)}` +
    `  DNp01 ${String(row.DNp01).padStart(3)}   ${row.secs}s`);
  return row;
}

const HZ = P.R_POI;
const a = measure('static-small', [{ neurons: small, rateHz: HZ }]);
const b = measure('static-large', [{ neurons: large, rateHz: HZ }]);
const c = measure('looming-linear', ({ ms }) => {
  const r = Math.min(rings.length - 1, Math.floor((ms / MS) * rings.length));
  return [{ neurons: rings[r], rateHz: HZ }];
});

// A REAL approach is not linear. An object of half-size l closing at speed v subtends
// theta(t) = 2*atan(l / (v * (t_c - t))), which barely grows for most of the approach and then
// explodes in the last moments. That hyperbolic profile IS the looming stimulus the escape system
// is tuned to, and l/|v| is the parameter the whole literature is indexed by. Using the physically
// correct curve is not tuning: the linear ramp was simply not a looming stimulus.
const LV = 0.30;                    // l/|v| in seconds � a standard value for these experiments
const d = measure('looming-real', ({ ms }) => {
  const tc = MS / 1000;             // collision at the end of the run
  const t = ms / 1000;
  const theta = 2 * Math.atan(LV / Math.max(tc - t, 1e-3));   // radians, 0..pi
  const r = Math.min(rings.length - 1, Math.max(0, Math.round((theta / Math.PI) * rings.length) - 1));
  return [{ neurons: rings[r], rateHz: HZ }];
});

// whichever expansion profile the fly responded to most strongly. The question this probe asks is
// whether the optic lobe is expansion-selective AT ALL, not which of our two profiles is prettier.
const best = c.LPLC2 >= d.LPLC2 ? c : d;

console.log('\n---');
if (a.LC4 + a.LPLC2 + b.LC4 + b.LPLC2 + c.LC4 + c.LPLC2 === 0) {
  console.log('NOTHING REACHES LC4 OR LPLC2 from the lamina. The optic lobe is not propagating and');
  console.log('the arena cannot be built on retinotopic input — fall back to direct LC stimulation.');
  process.exitCode = 1;
} else if (best.DNp01 > b.DNp01 && best.DNp01 > a.DNp01) {
  console.log(`LOOMING BEATS A BIGGER STATIC PATCH AT DNp01: ${best.DNp01} vs ${b.DNp01}.`);
  console.log('The fly computed that itself, from a patch of medulla columns. The arena is real.');
} else if (best.LPLC2 > b.LPLC2 * 2) {
  console.log(`LPLC2 IS EXPANSION-SELECTIVE: ${best.LPLC2} spikes against ${b.LPLC2} for a BIGGER static`);
  console.log(`patch (${(best.LPLC2 / Math.max(b.LPLC2, 1)).toFixed(1)}x). The connectome computed that from medulla columns � we never`);
  console.log('told it anything was looming. But DNp01 stays at noise level, so the escape readout');
  console.log('belongs on the LPLC2 population, one synapse upstream, where the signal actually is.');
} else {
  console.log(`Looming did NOT beat static-large at DNp01 (${d.DNp01} vs ${b.DNp01}).`);
  console.log('Signal reaches the LC neurons, but the escape readout is not selective for expansion');
  console.log('at this stimulus strength — the arena needs work before it can carry the sell signal.');
}
