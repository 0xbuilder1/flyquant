#!/usr/bin/env node
/**
 * One pass of the fly: look at 57 live markets, decide, reconcile the account to that decision.
 *
 *   node fly.js                      dry run — decides and plans, sends nothing
 *   node fly.js --ms 600 --seed 7    longer pass, a different fly (same seed = same spikes)
 *   node fly.js --broadcast          send, and ONLY if trade.armed is also true in config
 *
 * The market window the fly sees is the gap since the last pass, because most of what it looks at
 * has no historical endpoint — the previous snapshot on disk IS the history.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { Brain } = require('./brain/lif.js');
const A = require('./brain/arena.js');
const { buildArena, seatMarkets, runPass, N_BANDS } = A;
const { decide } = require('./brain/readout.js');
const lighter = require('./trader/lighter.js');
const accountApi = require('./trader/account.js');
const position = require('./trader/position.js');
const orders = require('./trader/order.js');
const publish = require('./trader/publish.js');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);

function loadConfig() {
  const live = path.join(__dirname, 'keeper', 'config.json');
  const example = path.join(__dirname, 'keeper', 'config.example.json');
  const file = fs.existsSync(live) ? live : example;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg._file = path.basename(file);
  return cfg;
}

(async () => {
  const cfg = loadConfig();
  const ms = Number(arg('ms', (cfg.pass && cfg.pass.ms) || 400));
  const seed = Number(arg('seed', 1));
  const broadcast = has('broadcast');

  const t0 = Date.now();
  const brain = Brain.load();
  const arena = buildArena(brain);
  console.log(`fly: ${brain.n.toLocaleString()} neurons, ${brain.targets.length.toLocaleString()} edges · config ${cfg._file}`);
  console.log(`arena: ${N_BANDS} bands, ${arena.neurons.toLocaleString()} medulla inputs (${arena.inputTypes.join(' ')})`);

  // ── what the market looks like ──────────────────────────────────────────────────────────────
  const prev = lighter.loadPrevious();
  const snap = await lighter.snapshot();
  const markets = lighter.toArena(snap, prev);
  const seats = seatMarkets(markets);
  lighter.savePrevious(snap);
  console.log(`lighter: ${markets.length} markets, window ${prev ? Math.round((snap.at - prev.at) / 1000) + 's' : 'none'}`);

  // ── what the account looks like ─────────────────────────────────────────────────────────────
  const accountIndex = Number((cfg.lighter && cfg.lighter.accountIndex) || 0);
  let account = null, accountError = null;
  if (accountIndex > 0) {
    try {
      account = await accountApi.read(accountIndex);
      console.log(`account ${account.index}: equity $${account.equity.toFixed(2)}, ` +
        `${account.positions.length} position${account.positions.length === 1 ? '' : 's'}, ` +
        `exposure $${account.exposure.toFixed(2)}, uPnL $${account.unrealized.toFixed(2)}`);
    } catch (e) {
      accountError = e.message;
      console.log(`account ${accountIndex}: UNREADABLE — ${e.message}`);
    }
  } else {
    accountError = 'lighter.accountIndex is still the placeholder 0 — set it in keeper/config.json';
    console.log(`account: ${accountError}`);
  }

  // which markets the fly has actually faced, and when. Kept on disk so a restart does not make
  // every open position look abandoned and close the whole book at once.
  const seenFile = path.join(__dirname, 'keeper', 'state', 'last-seen.json');
  let lastSeen = {};
  try { lastSeen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch { /* first run */ }

  // ── the fly ─────────────────────────────────────────────────────────────────────────────────
  const ctx = { fundingClampSmall: 0.05, tradesMax: Math.max(...markets.map((m) => m.market.trades), 1) };
  const tRun = Date.now();
  const pass = runPass(brain, arena, seats, markets, { ms, seed, ctx, raster: { capacity: 400000 } });
  const d = decide(brain, pass.result);

  let fired = 0;
  for (let i = 0; i < brain.n; i++) if (pass.result.spikes[i] > 0) fired++;

  console.log(`\nran ${ms}ms of fly time in ${((Date.now() - tRun) / 1000).toFixed(1)}s — ${fired.toLocaleString()} neurons fired`);
  console.log(`turned ${pass.heading >= 0 ? 'right' : 'left'} ${Math.abs(pass.heading).toFixed(1)} bands, facing ` +
    `${pass.chosen ? pass.chosen.symbol : '(nothing)'}`);
  const r = d.rates;
  console.log(`LPLC2 ${r.escape.hz.toFixed(1)}  MN9 ${r.feed.hz.toFixed(1)}  MDN ${r.retreat.hz.toFixed(1)}  ` +
    `DNp09 ${r.freeze.hz.toFixed(1)}  DNa02 ${r.steer.hz.toFixed(1)}   [DNp01 ${r.giantFiber.spikes}]`);
  console.log(`\n  ${d.action.toUpperCase()} ${d.action === 'hold' ? '' : (d.size * 100).toFixed(1) + '% '}` +
    `${pass.chosen ? pass.chosen.symbol : ''}\n  ${d.why}`);

  // ── reconcile the account to what the fly decided ───────────────────────────────────────────
  let plan = null, feedEntry = null;
  const tradeCfg = cfg.trade || {};
  const orderCfg = (marketId) => ({
    accountIndex,
    apiKeyIndex: (cfg.lighter && cfg.lighter.apiKeyIndex) || 4,
    maxNotionalUsd: tradeCfg.maxNotionalUsd || 0,
    maxSlippage: (cfg.lighter && cfg.lighter.maxSlippage),
    sizeDecimals: (markets.find((m) => m.marketId === marketId) || {}).market
      ? markets.find((m) => m.marketId === marketId).market.sizeDecimals : 2,
    armed: !!tradeCfg.armed,
    stateRoot: path.join(__dirname, 'keeper', 'state'),
  });

  if (pass.chosen) {
    lastSeen[pass.chosen.symbol] = Date.now();
    try {
      fs.mkdirSync(path.dirname(seenFile), { recursive: true });
      fs.writeFileSync(seenFile, JSON.stringify(lastSeen));
    } catch (e) { console.error('could not record what was faced:', e.message); }
  }
  if (account && pass.chosen) {
    // Depth for the chosen market, read NOW. One extra request per pass, and the only honest bound
    // on size once the account is large: a cap from a cached book bounds nothing.
    let depth = null;
    try {
      depth = await lighter.depth(pass.chosen.marketId, (cfg.lighter && cfg.lighter.maxSlippage) || 0.005);
      if (depth) {
        console.log(`depth ${pass.chosen.symbol}: $${Math.round(depth.bid).toLocaleString()} bid / ` +
          `$${Math.round(depth.ask).toLocaleString()} ask within ±${(depth.band * 100).toFixed(1)}%, ` +
          `spread ${depth.spreadBps.toFixed(1)}bp`);
      }
    } catch (e) {
      console.log(`depth ${pass.chosen.symbol}: unreadable — ${e.message}`);
    }

    plan = position.plan({
      account,
      market: pass.chosen.market ? { ...pass.chosen.market, mark: pass.chosen.mark } : pass.chosen,
      decision: d,
      chosen: pass.chosen,
      exposure: tradeCfg.exposure,
      depth,
    });

    feedEntry = await orders.execute({
      plan, cfg: orderCfg(pass.chosen.marketId), broadcast,
      context: { seed, heading: pass.heading },
    });

    if (plan.order) {
      console.log(`\nplan: hold $${plan.held.toFixed(2)} → target $${plan.target.toFixed(2)} ` +
        `= ${plan.order.side} ${plan.order.sizeBase} ${plan.symbol} ($${plan.order.notional.toFixed(2)})` +
        (plan.capped ? `  [capped into $${plan.room.toFixed(2)} of book room]` : '') +
        (plan.depthCapped ? `  [CAPPED BY DEPTH: the book only carries $${Math.round(plan.depth.min).toLocaleString()} on its thin side]` : ''));
      console.log(`  ${feedEntry.status.toUpperCase()}${feedEntry.note ? ' — ' + feedEntry.note : ''}` +
        `${feedEntry.txHash ? '\n  ' + feedEntry.verify : ''}`);
    } else {
      console.log(`\nplan: no order — ${plan.reason}`);

      // ── what the fly has stopped looking at ─────────────────────────────────────────────────
      // Only when the fly's own decision produced nothing, so this can never pre-empt it and at
      // most one order leaves per pass. The fly manages one market a pass; the book is not one
      // market, and without this a position it turned away from would simply never be closed.
      const staleMs = Number((tradeCfg.exposure && tradeCfg.exposure.staleAfterMinutes) || 0) * 60000;
      const forgotten = position.stale({ account, lastSeen, staleAfterMs: staleMs });
      if (forgotten.length) {
        const f = forgotten[0];
        const closePlan = position.plan({
          account,
          market: { symbol: f.symbol, marketId: f.marketId, mark: Math.abs(f.notional) / Math.max(f.size, 1e-12),
                    minQuote: 0, minBase: 0, sizeDecimals: 2 },
          decision: { action: 'escape', size: 1,
                      why: f.neverSeen ? 'never faced by the fly' : `not faced for ${Math.round(f.ageMs / 60000)} minutes` },
          exposure: tradeCfg.exposure,
        });
        if (closePlan.order) {
          feedEntry = await orders.execute({
            plan: closePlan, cfg: orderCfg(f.marketId), broadcast,
            context: { seed, reason: 'stale' },
          });
          console.log(`stale: closing ${f.symbol}, ` +
            (f.neverSeen ? 'never faced' : `not faced for ${Math.round(f.ageMs / 60000)}m`) +
            ` — ${feedEntry.status.toUpperCase()}`);
        }
      }
    }
  } else {
    console.log(`\nplan: skipped — ${accountError || 'the fly faced nothing'}`);
  }

  // ── publish ─────────────────────────────────────────────────────────────────────────────────
  const stats = publish.build({
    brain, arena, seats, markets, pass, decision: d,
    meta: {
      cpuMs: Date.now() - tRun, fired,
      windowSeconds: prev ? Math.round((snap.at - prev.at) / 1000) : null,
      nBands: N_BANDS, front: A.FRONT, baseRadius: A.BASE_RADIUS, maxExpansion: A.MAX_EXPANSION,
    },
  });

  stats.account = account ? {
    ...position.book(account),
    index: account.index,
    verify: account.verify,
    error: null,
  } : { error: accountError, index: accountIndex || null, positions: [], verify: accountIndex ? accountApi.verifyAccount(accountIndex) : null };

  stats.trade = {
    armed: !!tradeCfg.armed,
    broadcast,
    live: broadcast && !!tradeCfg.armed,
    maxNotionalUsd: tradeCfg.maxNotionalUsd || 0,
    maxFraction: (tradeCfg.exposure && tradeCfg.exposure.maxFraction) != null ? tradeCfg.exposure.maxFraction : 1,
    limits: tradeCfg.exposure || {},
    plan: plan ? { target: plan.target, held: plan.held, delta: plan.delta, reason: plan.reason } : null,
  };
  stats.feed = orders.recent(path.join(__dirname, 'keeper', 'state'), 30);

  const siteDir = path.join(__dirname, 'site');
  const graphDir = path.join(__dirname, 'brain', 'graph');
  publish.ensureCloud(graphDir, siteDir);
  const act = publish.activityOf(brain, pass.result, graphDir);
  fs.writeFileSync(path.join(siteDir, 'activity.bin'), act.buf);
  stats.pass.placed = act.placed;
  stats.pass.bins = publish.RASTER_BINS;

  publish.write(stats, arg('out', path.join(siteDir, 'stats.json')));
  console.log(`\npublished · total ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    (stats.trade.live ? '' : '  (nothing was sent)'));
})().catch((e) => { console.error('failed:', e.message); process.exitCode = 1; });
