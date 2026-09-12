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
const senses = require('./brain/senses.js');
const { buildArena, seatMarkets, runPass, N_BANDS } = A;
const { decide } = require('./brain/readout.js');
const lighter = require('./trader/lighter.js');
const accountApi = require('./trader/account.js');
const position = require('./trader/position.js');
const orders = require('./trader/order.js');
const publish = require('./trader/publish.js');
const equity = require('./trader/equity.js');

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
  //
  // WARMUP, so the fly can act on its FIRST pass instead of its second.
  //
  // The window the fly sees is the gap between snapshots, so with nothing on disk every market is
  // motionless, nothing smells of anything and the fly has no reason to do a thing. That is correct
  // behaviour and it costs a whole pass interval. On a cold start we take a snapshot, wait, and take
  // another, which buys a real window in seconds rather than minutes — the fly is then deciding on
  // actual movement the first time it opens its eyes.
  let prev = lighter.loadPrevious();
  const warmup = Number(arg('warmup', 0));
  if (!prev && warmup > 0) {
    console.log(`cold start: taking a snapshot, waiting ${warmup}s for a window, then looking`);
    prev = await lighter.snapshot();
    lighter.savePrevious(prev);
    await new Promise((r) => setTimeout(r, warmup * 1000));
  }
  const snap = await lighter.snapshot();
  let markets = lighter.toArena(snap, prev);
  let seats = seatMarkets(markets);
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

  // the fly's heading carries between passes, the way a tethered animal's does. Resetting it every
  // pass meant it always woke facing the same seat and had one pass to turn off it.
  const headFile = path.join(__dirname, 'keeper', 'state', 'heading.json');
  let heading0 = 0;
  try { heading0 = Number(JSON.parse(fs.readFileSync(headFile, 'utf8')).heading) || 0; } catch { /* first run */ }

  // ── the fly ─────────────────────────────────────────────────────────────────────────────────
  //
  // What the channels normalise against is the UNIVERSE AS IT STANDS THIS PASS, not a ceiling. Each
  // market is felt as its standing among its 56 peers, the way the antennal lobe scales a glomerulus
  // by the whole population's input. There is no maximum here to pick and therefore none to fit.
  // ── EVERY BOOK, EVERY PASS, AND THIS IS NOT AN OPTIMISATION ─────────────────────────────────
  //
  // Johnston's organ is the ONLY channel that drives MDN. brain/probe-bias.js measures it directly:
  // driven alone, wind puts MDN at 55.8Hz and the fly SHORTS 94%, while food, geosmin, cVA, heat and
  // humidity all drive MN9 and the fly goes long. The short side of this animal hangs entirely on
  // whether it can feel the order book.
  //
  // And it could not. The keeper used to remember only the book of the market the fly had just
  // faced, so 52 of the 57 markets had no wind at all — and 88% of every decision ever recorded was
  // LONG. That is not the animal being bullish. It is the animal deaf in the one sense that argues
  // the other way, which at ten slots and ten times leverage is a levered long-only book wearing a
  // fly costume.
  //
  // So every book is read every pass. It is 57 requests against an endpoint that answers in
  // milliseconds, once every few minutes, and it is the difference between a fly that can disagree
  // with a market and one that cannot.
  // ── CLEAR THE BOOK BEFORE ASKING THE FLY WHAT IT WANTS ──────────────────────────────────────
  //
  // A post-only order cannot be given an expiry short enough to die before the next pass -- the
  // exchange refuses 170s -- so leftover intent is cleared by cancelling instead. position.js counts
  // POSITIONS and never sees a resting order, so one left over from an earlier pass is exposure no
  // cap is aware of.
  //
  // Only when actually live: a dry pass has nothing resting, and a cancel is a signed request that
  // should not be spent proving that.
  // ── FLATTEN: CLOSE EVERYTHING, NOW ──────────────────────────────────────────────────────────
  //
  //     node fly.js --flatten              say what it would close
  //     node fly.js --flatten --broadcast  close it
  //
  // Two jobs, and the second is why it exists at all.
  //
  // It is the panic button. Every other way out of a position goes through the animal -- it escapes
  // on looming, or it re-targets, or staleAfterMinutes eventually closes what it stopped facing --
  // and all of those take a pass and none of them can be asked for. An operator who wants out does
  // not want to wait for a fly to agree.
  //
  // And it is the only cheap way to TEST the exit path. Exits are always market orders, which is
  // exactly the class of order that was silently unfillable until the ideal_price fix, so the exit
  // path has never actually run. Waiting 30 minutes for staleAfterMinutes to prove it is a long time
  // to not know.
  //
  // It drives the SAME escape plan the stale close uses -- position.plan with action 'escape', which
  // targets zero and is reduce-only. If it works here it works there. Nothing about it is a special
  // case, which is the point: a panic button with its own code path is a panic button nobody has
  // tested.
  if (has('flatten')) {
    const open = ((account && account.positions) || []).filter((p) => Math.abs(p.notional) > 0);
    if (!account) { console.log(`cannot flatten: ${accountError}`); return; }
    if (!open.length) { console.log('nothing open — already flat'); return; }
    console.log(`\nflatten: ${open.length} position${open.length === 1 ? '' : 's'} to close\n`);

    const tradeCfg2 = cfg.trade || {};
    const oCfg = (marketId) => {
      const m = markets.find((x) => x.marketId === marketId);
      return {
        accountIndex,
        apiKeyIndex: (cfg.lighter && cfg.lighter.apiKeyIndex) || 4,
        maxNotionalUsd: tradeCfg2.maxNotionalUsd || 0,
        maxNotionalFractionOfEquity: tradeCfg2.maxNotionalFractionOfEquity || 0,
        maxSlippage: (cfg.lighter && cfg.lighter.maxSlippage),
        sizeDecimals: m && m.market ? m.market.sizeDecimals : 2,
        priceDecimals: m && m.market ? m.market.priceDecimals : 6,
        expirySeconds: Number(tradeCfg2.expirySeconds) || 600,
        armed: !!tradeCfg2.armed,
        stateRoot: path.join(__dirname, 'keeper', 'state'),
      };
    };

    for (const pos of open) {
      const m = markets.find((x) => x.marketId === pos.marketId);
      const mark = m ? m.mark : Math.abs(pos.notional) / Math.max(pos.size, 1e-12);
      const plan = position.plan({
        account,
        market: {
          symbol: pos.symbol, marketId: pos.marketId, mark,
          minQuote: 0, minBase: 0,
          sizeDecimals: m && m.market ? m.market.sizeDecimals : 2,
          priceDecimals: m && m.market ? m.market.priceDecimals : 6,
        },
        decision: { action: 'escape', size: 1, why: 'flattened by the operator' },
        exposure: tradeCfg2.exposure,
      });
      if (!plan.order) { console.log(`  ${pos.symbol}: nothing to send — ${plan.reason}`); continue; }
      const entry = await orders.execute({
        plan, cfg: oCfg(pos.marketId), broadcast,
        context: { seed: 0, reason: 'flatten' },
      });
      console.log(`  ${pos.symbol.padEnd(8)} ${plan.order.side} ${plan.order.sizeBase} ` +
        `($${Math.abs(pos.notional).toFixed(2)} ${pos.sign > 0 ? 'long' : 'short'}) -> ` +
        `${entry.status.toUpperCase()}${entry.note ? ' — ' + entry.note : ''}`);
    }
    console.log(`\n${broadcast ? 'sent. check the explorer:' : 'dry run — add --broadcast to send. account:'}` +
      ` https://robinhoodchain.lighter.xyz/explorer/accounts/${accountIndex}`);
    return;
  }

  if (broadcast && (cfg.trade || {}).armed) {
    const c = await orders.cancelAll({
      accountIndex,
      apiKeyIndex: (cfg.lighter && cfg.lighter.apiKeyIndex) || 4,
    });
    console.log(c.ok ? 'cleared any resting orders' : `could not clear resting orders: ${c.error}`);
  }

  const tBooks = Date.now();
  const depthOf = {};
  const CONCURRENCY = 8;
  const queue = [...markets];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const m = queue.pop();
      try {
        const d = await lighter.depth(m.marketId);
        // AN EMPTY BOOK IS RECORDED, NOT SKIPPED. "We read it and there is nothing there" and "we
        // never managed to read it" are different facts and only one of them is grounds for taking a
        // market out of the panorama. Storing the zero keeps that distinction: senses already treat
        // bid+ask of zero as no wind, and the universe filter needs to see it to act on it.
        if (d) depthOf[m.symbol] = { bid: d.bid, ask: d.ask, spreadBps: d.spreadBps, at: Date.now() };
      } catch (e) { /* one unreadable book must not cost the pass */ }
    }
  }));
  const booksMs = Date.now() - tBooks;
  console.log(`books: ${Object.keys(depthOf).length}/${markets.length} read in ${(booksMs / 1000).toFixed(1)}s` +
    ` — the only channel that can make it short`);

  const ctx = { depthOf };
  // ── WHAT THIS DESK CAN ACTUALLY OPERATE IN ──────────────────────────────────────────────────
  //
  // Four of the 57 have NO BOOK AT ALL within half a percent of mid -- RGTI, AI, WULF and USO were
  // showing $0 on their thin side with half-spreads of 151, 117, 79 and 55 basis points. They are
  // not wide markets, they are absent ones. The fly turning to one costs a whole pass and produces
  // either a refusal or a resting order in a book nothing trades against.
  //
  // THIS IS THE DESK'S DECISION, NOT THE ANIMAL'S, and the distinction is the reason it lives here
  // rather than in brain/. Nothing about the fly changed: it still sees a panorama and still turns
  // by the same asymmetry. What changed is which markets the desk is willing to put in front of it,
  // on exactly the same grounds as the depth cap -- a size you can enter and cannot leave is a trap,
  // and a market with no book is that trap with the size set to everything.
  //
  // The floor is a dollar figure and it is measured live, so a market that comes back to life is
  // back in the panorama on the next pass without anybody editing anything. At 0 the filter is off
  // and all 57 are seated, which is the behaviour this had before.
  const minBook = Number((cfg.trade && cfg.trade.exposure && cfg.trade.exposure.minBookUsd) || 0);
  if (minBook > 0) {
    const before = markets.length;
    const dropped = [];
    markets = markets.filter((m) => {
      const d = depthOf[m.symbol];
      // never seen is never excluded: a book we failed to read is not a book we know is empty
      if (!d) return true;
      const thin = Math.min(d.bid, d.ask);
      if (thin >= minBook) return true;
      dropped.push(`${m.symbol} ($${Math.round(thin)})`);
      return false;
    });
    if (dropped.length) {
      console.log(`universe: ${markets.length}/${before} markets — no book to trade against in ` +
        dropped.join(', '));
      seats = seatMarkets(markets);
    }
  }

  ctx.ambient = senses.ambient(markets, ctx);
  try {
    const bf = path.join(__dirname, 'keeper', 'state', 'books.json');
    fs.mkdirSync(path.dirname(bf), { recursive: true });
    fs.writeFileSync(bf, JSON.stringify(depthOf));
  } catch (e) { console.error('could not record the books:', e.message); }
  const tRun = Date.now();
  const pass = runPass(brain, arena, seats, markets, { ms, seed, ctx, heading0, raster: { capacity: 400000 } });
  try {
    fs.mkdirSync(path.dirname(headFile), { recursive: true });
    // wrap it: heading is an AZIMUTH, not an odometer. Left unwrapped it reached 326 bands on a
    // 72-band arena inside a few passes — harmless for choosing a market, since that is taken modulo
    // the arena anyway, but it prints nonsense and grows without bound.
    const wrapped = ((pass.heading % N_BANDS) + N_BANDS) % N_BANDS;
    fs.writeFileSync(headFile, JSON.stringify({ heading: wrapped, at: Date.now() }));
  } catch (e) { console.error('could not record the heading:', e.message); }
  const d = decide(brain, pass.result);

  let fired = 0;
  for (let i = 0; i < brain.n; i++) if (pass.result.spikes[i] > 0) fired++;

  console.log(`\nran ${ms}ms of fly time in ${((Date.now() - tRun) / 1000).toFixed(1)}s — ${fired.toLocaleString()} neurons fired`);
  console.log(`turned ${pass.heading >= 0 ? 'right' : 'left'} ${Math.abs(pass.heading).toFixed(1)} bands, facing ` +
    `${pass.chosen ? pass.chosen.symbol : '(nothing)'}`);
  const r = d.rates;
  console.log(`LPLC2 ${r.escape.hz.toFixed(1)}  MN9 ${r.feed.hz.toFixed(1)}  MDN ${r.retreat.hz.toFixed(1)}  ` +
    `DNp09 ${r.freeze.hz.toFixed(1)}  DNa02 ${r.steer.hz.toFixed(1)}   [DNp01 ${r.giantFiber.spikes}]`);
  console.log(`mood: octopamine ${d.mood.octopamineHz.toFixed(1)}Hz vs serotonin ${d.mood.serotoninHz.toFixed(1)}Hz` +
    `  ->  appetite ${(d.mood.appetite * 100).toFixed(0)}%, patience ${(d.mood.patience * 100).toFixed(0)}%` +
    `   [dopamine ${d.mood.dopamineHz.toFixed(1)}Hz, read but not acted on]`);
  console.log(`\n  ${d.action.toUpperCase()} ${d.action === 'hold' ? '' : (d.size * 100).toFixed(1) + '% '}` +
    `${pass.chosen ? pass.chosen.symbol : ''}\n  ${d.why}`);

  // ── reconcile the account to what the fly decided ───────────────────────────────────────────
  let plan = null, feedEntry = null;
  const tradeCfg = cfg.trade || {};
  const orderCfg = (marketId) => ({
    accountIndex,
    apiKeyIndex: (cfg.lighter && cfg.lighter.apiKeyIndex) || 4,
    maxNotionalUsd: tradeCfg.maxNotionalUsd || 0,
    // WITHOUT THIS THE SIGNER'S BACKSTOP IS DISABLED. It reads the fraction, not the dollar cap,
    // and a field that is not forwarded here arrives as 0, which means "no ceiling".
    maxNotionalFractionOfEquity: tradeCfg.maxNotionalFractionOfEquity || 0,
    maxSlippage: (cfg.lighter && cfg.lighter.maxSlippage),
    sizeDecimals: (markets.find((m) => m.marketId === marketId) || {}).market
      ? markets.find((m) => m.marketId === marketId).market.sizeDecimals : 2,
    priceDecimals: (markets.find((m) => m.marketId === marketId) || {}).market
      ? markets.find((m) => m.marketId === marketId).market.priceDecimals : 6,
    // NOT DERIVED FROM THE PASS INTERVAL ANY MORE. This was everySeconds - 10 = 170s, chosen so an
    // unfilled order died before the next pass; the exchange answers `21711 invalid expiry` to it
    // and accepts 600s. The dying-on-its-own trick is therefore unavailable, and the cancel sweep
    // above does that job instead.
    expirySeconds: Number(tradeCfg.expirySeconds) || 600,
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
        (plan.order.execution === 'post-only'
          ? `  RESTING at ${plan.order.limitPrice} (crossing would cost ${plan.crossCostBps}bp, over the ${plan.takerMaxBps}bp line)`
          : `  CROSSING (${plan.target === 0 ? 'an exit always crosses' : `${plan.crossCostBps}bp, under the ${plan.takerMaxBps}bp line`})`) +
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
    brain, arena, seats, markets, pass, decision: d, ctx,
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

  // one point per pass, appended. The site's curve is this file and nothing else.
  const stateRoot = path.join(__dirname, 'keeper', 'state');
  if (account) equity.record(account, stateRoot);
  stats.equityCurve = equity.series(stateRoot, 600);

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

  // ── THE LIGHTS, UPLOADED BEFORE THE NUMBERS THAT POINT AT THEM ──────────────────────────────
  //
  // activity.bin is two bytes per neuron: how often it spiked and the bin it first spiked in. It is
  // what makes the animal on the page light up with THIS pass rather than with whatever was
  // committed to git, and at 273KB it is far too big to commit 480 times a day.
  //
  // It goes up FIRST, and its URL is then carried inside stats.json. That ordering is the whole
  // trick: the page learns where the current activity lives from the same file it already polls, so
  // nothing has to be configured twice and a half-finished upload can never leave the page pointing
  // at lights that do not exist yet.
  const tUp = Date.now();
  try {
    const blob = require('./core/publish.js');
    const url = await blob.publishFile('activity.bin', Buffer.from(act.buf), 'application/octet-stream');
    console.log(`  activity.bin (${(act.buf.length / 1024).toFixed(0)}KB) up in ${((Date.now() - tUp) / 1000).toFixed(1)}s`);
    // A PRIVATE BLOB'S URL IS NOT A URL THE PAGE CAN USE. Handing it one would point the browser at
    // something that answers 401 forever. Only a public blob's url is published; with a private
    // store the field stays absent and the page reads /api/activity, which has the token.
    if (url && blob.blobAccess() === 'public') stats.activityUrl = url;
  } catch (e) {
    console.error('could not publish the activity (the page will use the committed one):', e.message);
  }
  stats.pass.placed = act.placed;
  stats.pass.bins = publish.RASTER_BINS;

  publish.write(stats, arg('out', path.join(siteDir, 'stats.json')));

  // ── AND UP TO THE SITE, IF THE OPERATOR HAS CONFIGURED IT ───────────────────────────────────
  //
  // The keeper runs on a machine; the page runs on Vercel. A file written locally every few minutes
  // cannot be committed and redeployed each time, so it goes to Blob under a stable pathname and
  // /api/stats hands the browser whatever is there now.
  //
  // ENTIRELY OPTIONAL, AND IT MAY NEVER BREAK A PASS. With no BLOB_READ_WRITE_TOKEN it does nothing
  // and says nothing; if the upload fails the pass has still done its job, which is to decide and,
  // where armed, to trade. Publishing is the last thing that happens for exactly that reason.
  const tStats = Date.now();
  try {
    const url = await require('./core/publish.js').publishStats(stats, console.log);
    if (url) console.log(`  stats.json up in ${((Date.now() - tStats) / 1000).toFixed(1)}s` +
      ` — the page sees this pass within its poll interval`);
  } catch (e) {
    console.error('could not publish stats (the pass itself was fine):', e.message);
  }
  console.log(`\npublished · total ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    (stats.trade.live ? '' : '  (nothing was sent)'));
})().catch((e) => { console.error('failed:', e.message); process.exitCode = 1; });
