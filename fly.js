#!/usr/bin/env node
/**
 * One pass of the fly, on live Lighter markets. Reads only — nothing here can place an order.
 *
 *   node fly.js              take a snapshot, and decide if there is a previous one to compare to
 *   node fly.js --ms 600     longer pass (more fly time, more CPU, same determinism)
 *   node fly.js --seed 7     a different fly; same seed always gives the same spikes
 *
 * The window the fly sees is the gap between this run and the last one, because most of what it
 * looks at has no historical endpoint. Run it twice a minute apart to give it something to see.
 */
'use strict';

const { Brain } = require('./brain/lif.js');
const A = require('./brain/arena.js');
const { buildArena, seatMarkets, runPass, N_BANDS } = A;
const { decide } = require('./brain/readout.js');
const lighter = require('./trader/lighter.js');
const publish = require('./trader/publish.js');
const path = require('path');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

(async () => {
  const ms = Number(arg('ms', 400));
  const seed = Number(arg('seed', 1));

  const t0 = Date.now();
  const brain = Brain.load();
  const arena = buildArena(brain);
  console.log(`fly: ${brain.n.toLocaleString()} neurons, ${brain.targets.length.toLocaleString()} edges`);
  console.log(`arena: ${N_BANDS} azimuth bands, ${arena.neurons.toLocaleString()} medulla input neurons ` +
              `(${arena.inputTypes.join(' ')}), ${arena.emptyBands} empty`);

  const prev = lighter.loadPrevious();
  const snap = await lighter.snapshot();
  const markets = lighter.toArena(snap, prev);
  const seats = seatMarkets(markets);
  lighter.savePrevious(snap);

  const gap = prev ? ((snap.at - prev.at) / 1000).toFixed(0) + 's' : 'none';
  console.log(`lighter: ${markets.length} active markets, window ${gap}\n`);

  if (!prev) {
    console.log('No previous snapshot, so nothing is falling and the panorama is still.');
    console.log('Snapshot saved. Run again in a minute and the fly will have a window to see.\n');
  }

  const moved = markets.filter((m) => m.moved != null).sort((a, z) => a.moved - z.moved);
  if (moved.length) {
    const fmt = (m) => `${m.symbol} ${(m.moved * 100 >= 0 ? '+' : '')}${(m.moved * 100).toFixed(2)}%`;
    console.log('biggest movers over the window:');
    console.log('  down  ' + moved.slice(0, 4).map(fmt).join('   '));
    console.log('  up    ' + moved.slice(-4).reverse().map(fmt).join('   '));
    const looming = markets.filter((m) => m.fall > 0).sort((a, z) => z.fall - a.fall).slice(0, 4);
    console.log('  looming (share of today\'s range given up): ' +
      (looming.length ? looming.map((m) => `${m.symbol} ${(m.fall * 100).toFixed(0)}%`).join('  ') : 'nothing'));
    console.log();
  }

  const bright = [...markets].sort((a, z) => z.bright - a.bright).slice(0, 5);
  console.log('brightest seats: ' + bright.map((m) => `${m.symbol} ${(m.bright * 100).toFixed(0)}%@${seats.get(m.symbol)}`).join('  '));

  const ctx = {
    // the exchange's own small-funding clamp, which is what makes "how much funding" a fraction
    fundingClampSmall: 0.05,
    tradesMax: Math.max(...markets.map((m) => m.market.trades), 1),
  };

  const tRun = Date.now();
  const pass = runPass(brain, arena, seats, markets, { ms, seed, ctx, raster: { capacity: 400000 } });
  const d = decide(brain, pass.result);

  let fired = 0;
  for (let i = 0; i < brain.n; i++) if (pass.result.spikes[i] > 0) fired++;

  console.log(`\nran ${ms}ms of fly time in ${((Date.now() - tRun) / 1000).toFixed(1)}s — ` +
              `${fired.toLocaleString()} neurons fired`);
  console.log(`turned ${pass.heading >= 0 ? 'right' : 'left'} ${Math.abs(pass.heading).toFixed(1)} bands ` +
              `of ${N_BANDS}, and ended up facing ${pass.chosen ? pass.chosen.symbol : '(nothing)'} ` +
              `(${pass.distance} bands off centre)`);

  if (pass.smelled) {
    console.log('smelled ' + pass.smelledOf + ': ' +
      Object.entries(pass.smelled).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join('  '));
  }
  const lc = (t) => brain.ofType(t).reduce((a, i) => a + pass.result.spikes[i], 0);
  console.log(`optic lobe: Tm2 ${lc('Tm2')}  LC4 ${lc('LC4')}  LPLC2 ${lc('LPLC2')}`);

  const r = d.rates;
  console.log(`\nLPLC2 ${r.escape.hz.toFixed(1)}Hz   MN9 ${r.feed.hz.toFixed(1)}Hz   ` +
              `MDN ${r.retreat.hz.toFixed(1)}Hz   DNp09 ${r.freeze.hz.toFixed(1)}Hz   ` +
              `DNa02 ${r.steer.hz.toFixed(1)}Hz   [DNp01 ${r.giantFiber.spikes} spikes, reported only]`);

  const size = d.action === 'hold' ? '' : `${(d.size * 100).toFixed(1)}% `;
  console.log(`\n  ${d.action.toUpperCase()} ${size}${pass.chosen ? pass.chosen.symbol : ''}`);
  console.log(`  ${d.why}`);
  const stats = publish.build({
    brain, arena, seats, markets, pass, decision: d,
    meta: {
      cpuMs: Date.now() - tRun, fired,
      windowSeconds: prev ? Math.round((snap.at - prev.at) / 1000) : null,
      nBands: N_BANDS, front: A.FRONT, baseRadius: A.BASE_RADIUS, maxExpansion: A.MAX_EXPANSION,
    },
  });
  const siteDir = path.join(__dirname, 'site');
  const graphDir = path.join(__dirname, 'brain', 'graph');
  publish.ensureCloud(graphDir, siteDir);
  const act = publish.activityOf(brain, pass.result, graphDir);
  require('fs').writeFileSync(path.join(siteDir, 'activity.bin'), act.buf);
  stats.pass.placed = act.placed;
  stats.pass.bins = publish.RASTER_BINS;

  const out = arg('out', path.join(siteDir, 'stats.json'));
  publish.write(stats, out);
  console.log(`\npublished ${out}`);
  console.log(`(dry run — nothing can trade yet. total ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
})().catch((e) => { console.error('failed:', e.message); process.exitCode = 1; });
