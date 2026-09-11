/**
 * What the site is allowed to know.
 *
 * One writer, one file. The page reads stats.json and NOTHING else — no API key reaches a browser,
 * no endpoint is called from the client, and the site cannot show a number the keeper did not
 * publish. That is the same arrangement every other product in this family uses, and the reason is
 * the same: a page that can compute its own figures will eventually compute a flattering one.
 *
 * EVERY FIELD HERE IS SOMETHING THE PASS ACTUALLY PRODUCED. In particular `giantFiber` is published
 * even though nothing is decided by it, because the honest claim — that DNp01 sits at noise and the
 * escape readout therefore reads LPLC2 — is only checkable if the number is on the page.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TAPE = 40;          // decisions kept on the page
const RASTER_BINS = 30;   // time bins for the population traces
const RASTER_DOTS = 1800; // individual spikes drawn in the raster strip

/** per-population spikes per time bin, plus a thinned dot raster, from a finished pass */
function rasterOf(brain, result, pops) {
  const bins = RASTER_BINS;
  const stepsPerBin = Math.max(1, Math.ceil(result.steps / bins));
  const traces = {};
  const member = new Map();
  for (const [name, type] of Object.entries(pops)) {
    traces[name] = new Array(bins).fill(0);
    for (const i of brain.ofType(type)) member.set(i, name);
  }

  const dots = [];
  const r = result.raster;
  if (r) {
    const stride = Math.max(1, Math.floor(r.t.length / RASTER_DOTS));
    for (let k = 0; k < r.t.length; k++) {
      const bin = Math.min(bins - 1, Math.floor(r.t[k] / stepsPerBin));
      const name = member.get(r.i[k]);
      if (name) traces[name][bin]++;
      if (k % stride === 0 && dots.length < RASTER_DOTS) {
        dots.push([Math.round((r.t[k] / result.steps) * 1000) / 1000, r.i[k], name || '']);
      }
    }
  }
  return { bins, traces, dots, truncated: !!(r && r.truncated) };
}

/**
 * The point cloud's activity for this pass, aligned to cloud-index.bin.
 *
 * Two bytes per placed neuron: how much it fired, and WHEN IT FIRST FIRED. The second byte is what
 * lets the page animate the pass instead of showing a still — activity visibly spreads from the
 * optic lobe inward, because that is the order it actually happened in.
 */
function activityOf(brain, result, graphDir) {
  const idx = new Int32Array(fs.readFileSync(path.join(graphDir, 'cloud-index.bin')).slice().buffer);
  const bins = RASTER_BINS;
  const stepsPerBin = Math.max(1, Math.ceil(result.steps / bins));
  const out = new Uint8Array(idx.length * 2);

  const firstStep = new Int32Array(brain.n).fill(-1);
  const r = result.raster;
  if (r) for (let k = r.t.length - 1; k >= 0; k--) firstStep[r.i[k]] = r.t[k];

  for (let k = 0; k < idx.length; k++) {
    const n = idx[k];
    out[k * 2] = Math.min(255, brain.spikes ? result.spikes[n] : 0);
    out[k * 2 + 1] = firstStep[n] >= 0 ? Math.min(bins - 1, Math.floor(firstStep[n] / stepsPerBin)) : 255;
  }
  return { buf: out, placed: idx.length };
}

function build({ brain, arena, seats, markets, pass, decision, meta }) {
  const g = brain.manifest;
  const r = decision.rates;

  const rows = markets
    .map((m) => ({
      symbol: m.symbol,
      seat: seats.get(m.symbol),
      bright: Math.round(m.bright * 1000) / 1000,
      fall: Math.round(m.fall * 1000) / 1000,
      moved: m.moved == null ? null : Math.round(m.moved * 1e6) / 1e6,
      mark: m.mark,
      volume: m.market.volume,
    }))
    .sort((a, z) => a.seat - z.seat);

  return {
    generatedAt: new Date().toISOString(),
    brain: {
      dataset: g.dataset,
      attribution: g.attribution,
      neurons: g.neurons,
      edges: g.edges,
      synapses: g.synapses,
      minWeight: g.minWeight,
      excitatory: g.excitatory,
      inhibitory: g.inhibitory,
      silentPresynaptic: g.silentPresynaptic,
      distinctTypes: g.distinctTypes,
      columns: g.columns,
      retinotopicNeurons: g.retinotopicNeurons,
      placedNeurons: g.placedNeurons,
    },
    arena: {
      bands: meta.nBands,
      front: meta.front,
      baseRadius: meta.baseRadius,
      maxExpansion: meta.maxExpansion,
      inputTypes: arena.inputTypes,
      inputNeurons: arena.neurons,
    },
    pass: {
      at: Date.now(),
      ms: pass.result.ms,
      seed: pass.result.seed,
      cpuMs: meta.cpuMs,
      fired: meta.fired,
      windowSeconds: meta.windowSeconds,
      heading: Math.round(pass.heading * 100) / 100,
      chosen: pass.chosen ? pass.chosen.symbol : null,
      distance: pass.distance,
      smelledOf: pass.smelledOf,
      smelled: pass.smelled,
      action: decision.action,
      size: Math.round(decision.size * 10000) / 10000,
      why: decision.why,
      rates: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, {
        type: v.type, neurons: v.neurons, spikes: v.spikes, hz: Math.round(v.hz * 100) / 100,
      }])),
      optic: {
        Tm2: brain.ofType('Tm2').reduce((a, i) => a + pass.result.spikes[i], 0),
        LC4: brain.ofType('LC4').reduce((a, i) => a + pass.result.spikes[i], 0),
        LPLC2: brain.ofType('LPLC2').reduce((a, i) => a + pass.result.spikes[i], 0),
      },
      markets: rows,
      trace: pass.trace.map((t) => ({ ms: Math.round(t.ms), heading: Math.round(t.heading * 100) / 100 })),
      raster: rasterOf(brain, pass.result, {
        LC4: 'LC4', LPLC2: 'LPLC2', MN9: 'MN9', MDN: 'MDN', DNp09: 'DNp09', DNa02: 'DNa02',
      }),
    },
  };
}

/** write it, keeping a rolling tape of what the fly has decided before */
function write(stats, file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  let tape = [];
  try { tape = JSON.parse(fs.readFileSync(file, 'utf8')).tape || []; } catch { /* first run */ }
  tape.unshift({
    at: stats.pass.at,
    action: stats.pass.action,
    size: stats.pass.size,
    symbol: stats.pass.chosen,
    why: stats.pass.why,
    seed: stats.pass.seed,
    mn9: stats.pass.rates.feed.hz,
    mdn: stats.pass.rates.retreat.hz,
    lplc2: stats.pass.rates.escape.hz,
    heading: stats.pass.heading,
  });
  stats.tape = tape.slice(0, TAPE);

  // write beside, then rename: a browser polling this file must never read half of it
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stats));
  fs.renameSync(tmp, file);
  return file;
}

/** copy the static cloud next to the page, once, so the site is self-contained */
function ensureCloud(graphDir, siteDir) {
  for (const f of ['cloud-xyz.bin', 'cloud-index.bin']) {
    const dst = path.join(siteDir, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(graphDir, f), dst);
  }
}

module.exports = { build, write, activityOf, ensureCloud, TAPE, RASTER_BINS };
