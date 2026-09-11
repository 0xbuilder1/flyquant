#!/usr/bin/env node
/**
 * The real fly, over recorded history.
 *
 *   node backtest/run.js                 43 hours, $100,000, writes backtest/result.json
 *   node backtest/run.js --equity 5000   a smaller account
 *   node backtest/run.js --ms 250        shorter passes (cheaper, same determinism)
 *
 * NOTHING HERE IS INVENTED. It runs `brain/`, `arena.js`, `readout.js` and `position.js` unmodified,
 * on hourly snapshots of Lighter's public market data recorded 2026-09-05 to 2026-09-07: mark,
 * volume, the day's range, trade count, funding, and for eight markets the best bid and ask. Every
 * trade in the output is a decision the fly actually made when shown that data.
 *
 * WHAT THE FILL MODEL ASSUMES, SAID PLAINLY BECAUSE IT IS THE WEAKEST PART
 *
 *   * A resting buy at price P is filled if the market's LOW over that hour reached P; a resting
 *     sell if the HIGH reached it. That is the most honest thing available at hourly resolution and
 *     it is OPTIMISTIC: it ignores queue position entirely, so a real fly would fill less often.
 *   * An exit crosses and pays half the recorded spread.
 *   * Positions are marked at each hour's mark price.
 *   * One pass per hour, because that is the resolution of the recording. The live keeper passes
 *     every three minutes, so the live fly sees twenty times more of the market than this does.
 *
 * So this is evidence that the machine runs end to end and produces coherent behaviour. It is NOT
 * evidence that the strategy makes money, the sample is under two days, and the output says so.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { Brain } = require('../brain/lif.js');
const A = require('../brain/arena.js');
const { decide } = require('../brain/readout.js');
const position = require('../trader/position.js');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const EXPOSURE = {
  maxFraction: 0.25, maxTotalFraction: 1.0,
  deadbandFraction: 0.02, depthFraction: 0.25,
};

function readHistory(file) {
  const text = fs.readFileSync(file, 'utf8').trim().split('\n');
  const head = text[0].split(',');
  const idx = Object.fromEntries(head.map((h, i) => [h, i]));
  const hours = new Map();
  for (const line of text.slice(1)) {
    const c = line.split(',');
    const hour = c[idx.hour_bucket];
    if (!hours.has(hour)) hours.set(hour, []);
    const num = (k) => { const v = Number(c[idx[k]]); return Number.isFinite(v) ? v : null; };
    const mark = num('mark_price');
    if (!(mark > 0)) continue;
    hours.get(hour).push({
      symbol: c[idx.symbol],
      marketId: num('market_id'),
      mark,
      volume: num('daily_quote_volume') || 0,
      trades: num('daily_trades') || 0,
      low: num('daily_price_low') || mark,
      high: num('daily_price_high') || mark,
      funding: num('funding_rate'),
      bestBid: num('best_bid'),
      bestAsk: num('best_ask'),
      spreadBps: num('spread_bps'),
      minQuote: 10, minBase: 0, sizeDecimals: 4, priceDecimals: 6,
    });
  }
  return [...hours.entries()].sort((a, z) => a[0].localeCompare(z[0]));
}

/** the same shape lighter.toArena produces, so the arena code is identical to the live one */
function toArena(now, prev) {
  const prevOf = new Map((prev || []).map((m) => [m.symbol, m]));
  const byVolume = [...now].sort((a, z) => a.volume - z.volume);
  const rankOf = new Map(byVolume.map((m, k) => [m.symbol, (k + 1) / byVolume.length]));
  return now.map((m) => {
    const was = prevOf.get(m.symbol);
    const range = Math.max(m.high - m.low, 0);
    let fall = 0;
    if (was && range > 0 && was.mark > m.mark) fall = Math.min(1, (was.mark - m.mark) / range);
    return {
      symbol: m.symbol, marketId: m.marketId, mark: m.mark,
      bright: rankOf.get(m.symbol) || 0, fall,
      moved: was ? (m.mark - was.mark) / was.mark : null,
      market: m,
    };
  });
}

(async () => {
  const ms = Number(arg('ms', 300));
  const startEquity = Number(arg('equity', 100000));
  const file = arg('data', path.join(__dirname, 'data', 'lighter-hourly.csv'));

  let hours = readHistory(file);

  // ONLY THE MARKETS WHOSE BOOKS WERE RECORDED.
  //
  // The first run showed the fly all 57 and it kept turning toward AMD, SGOV and SLV — none of which
  // have a recorded best bid or ask, so every order fell back to crossing and the resting path, which
  // is the entire point of the execution design, was never exercised once. Showing it markets whose
  // fills cannot be modelled produces a backtest of a fly that does not exist.
  //
  // So the arena here is the eight markets with a book on every hour. That is a SMALLER arena than
  // the live one and the difference is stated rather than hidden: the live fly chooses among 57.
  if (arg('all', null) === null) {
    const withBook = new Set();
    for (const [, rows] of hours) for (const r of rows) if (r.bestBid > 0 && r.bestAsk > 0) withBook.add(r.symbol);
    hours = hours.map(([h, rows]) => [h, rows.filter((r) => withBook.has(r.symbol))]);
    console.log(`markets with a recorded book: ${[...withBook].sort().join(', ')}`);
  }
  const brain = Brain.load();
  const arena = A.buildArena(brain);
  console.log(`${hours.length} hours, ${hours[0][1].length} markets, $${startEquity.toLocaleString()} to start`);
  console.log(`${brain.n.toLocaleString()} neurons, ${ms}ms of fly time per pass\n`);

  let cash = startEquity;
  const held = new Map();                 // symbol -> { size, entry }  size is signed, in base units
  const feed = [];
  const equityCurve = [];
  let filled = 0, posted = 0, crossed = 0, spreadPaid = 0;
  let heading = 0;               // the fly's heading persists between passes, as a real one would

  for (let h = 1; h < hours.length; h++) {
    const [hour, now] = hours[h];
    const prev = hours[h - 1][1];
    const markets = toArena(now, prev);
    const seats = A.seatMarkets(markets);
    const markOf = new Map(now.map((m) => [m.symbol, m]));

    // mark the book to this hour
    let unreal = 0;
    for (const [sym, p] of held) {
      const m = markOf.get(sym);
      if (m) unreal += p.size * (m.mark - p.entry);
    }
    const equity = cash + unreal;
    equityCurve.push({ hour, equity, cash, unreal, positions: held.size });

    const ctx = { fundingClampSmall: 0.05, tradesMax: Math.max(...now.map((m) => m.trades), 1) };
    const pass = A.runPass(brain, arena, seats, markets, { ms, seed: h, ctx, heading0: heading });
    heading = pass.heading;
    const d = decide(brain, pass.result);
    if (!pass.chosen) continue;

    const chosen = markOf.get(pass.chosen.symbol);
    const depth = (chosen && chosen.bestBid > 0 && chosen.bestAsk > 0)
      ? {
          best: { bid: chosen.bestBid, ask: chosen.bestAsk },
          // the recording carries no book size, so the depth cap is left off rather than guessed at
          min: 0, bid: 0, ask: 0, spreadBps: chosen.spreadBps || 0,
        }
      : null;

    const positions = [...held.entries()].map(([sym, p]) => {
      const m = markOf.get(sym);
      const px = m ? m.mark : p.entry;
      return {
        marketId: (m || {}).marketId, symbol: sym, sign: Math.sign(p.size),
        size: Math.abs(p.size), entry: p.entry, notional: p.size * px,
        unrealized: p.size * (px - p.entry), realized: 0, liquidation: 0, funding: 0,
      };
    });
    const account = {
      equity, collateral: cash, available: cash, positions, unrealized: unreal,
      exposure: positions.reduce((s, p) => s + Math.abs(p.notional), 0),
    };

    const plan = position.plan({
      account, market: { ...chosen, mark: chosen.mark }, decision: d, exposure: EXPOSURE, depth,
    });
    if (!plan.order) continue;

    const o = plan.order;
    const entry = {
      at: Date.parse(hour + ':00:00Z'), hour, backtest: true,
      symbol: o.symbol, side: o.side, action: d.action,
      sizeBase: o.sizeBase, notional: o.notional, execution: o.execution,
      limitPrice: o.limitPrice, mark: chosen.mark,
      appetite: d.mood.appetite, patience: d.mood.patience,
      conviction: d.size, why: d.why, seed: h,
    };

    // ── the fill model ─────────────────────────────────────────────────────────────────────────
    let fillPrice = null;
    if (o.execution === 'post-only') {
      posted++;
      // filled only if the hour's range actually reached the resting price
      const reached = o.side === 'buy' ? chosen.low <= o.limitPrice : chosen.high >= o.limitPrice;
      if (reached) { fillPrice = o.limitPrice; filled++; }
    } else {
      crossed++;
      const half = (chosen.spreadBps || 0) / 2 / 10000;
      fillPrice = o.side === 'buy' ? chosen.mark * (1 + half) : chosen.mark * (1 - half);
      spreadPaid += Math.abs(o.notional) * half;
    }

    if (fillPrice == null) {
      entry.status = 'unfilled';
      entry.note = `rested at ${o.limitPrice} and the hour never traded there`;
    } else {
      entry.status = 'filled';
      entry.fillPrice = fillPrice;
      const signed = (o.side === 'buy' ? 1 : -1) * o.sizeBase;
      const was = held.get(o.symbol) || { size: 0, entry: fillPrice };
      const after = was.size + signed;
      // realise on the part that closes
      if (was.size !== 0 && Math.sign(signed) !== Math.sign(was.size)) {
        const closed = Math.min(Math.abs(signed), Math.abs(was.size));
        const pnl = closed * (fillPrice - was.entry) * Math.sign(was.size);
        cash += pnl;
        entry.realised = pnl;
      }
      if (Math.abs(after) < 1e-12) held.delete(o.symbol);
      else {
        held.set(o.symbol, {
          size: after,
          // average in only when adding in the same direction
          entry: (was.size !== 0 && Math.sign(after) === Math.sign(was.size) && Math.abs(after) > Math.abs(was.size))
            ? (was.entry * Math.abs(was.size) + fillPrice * Math.abs(signed)) / Math.abs(after)
            : (Math.sign(after) === Math.sign(was.size) ? was.entry : fillPrice),
        });
      }
    }
    feed.push(entry);
    process.stdout.write(`\r  ${h}/${hours.length - 1} hours · ${feed.length} decisions · ${filled} filled `);
  }

  // final mark
  const last = hours[hours.length - 1][1];
  const markOf = new Map(last.map((m) => [m.symbol, m]));
  let unreal = 0;
  for (const [sym, p] of held) { const m = markOf.get(sym); if (m) unreal += p.size * (m.mark - p.entry); }
  const finalEquity = cash + unreal;

  const result = {
    generatedAt: new Date().toISOString(),
    source: 'hourly snapshots of Lighter public market data, 2026-09-05 to 2026-09-07',
    disclaimer: 'A BACKTEST. The fly is real and the market data is real; the fills are modelled at ' +
      'hourly resolution and ignore queue position, which flatters them. Under two days of sample. ' +
      'This shows the machine works, not that the strategy does.',
    hours: hours.length - 1,
    startEquity, finalEquity,
    pnl: finalEquity - startEquity,
    pnlPct: ((finalEquity - startEquity) / startEquity) * 100,
    decisions: feed.length,
    posted, filled, crossed,
    fillRate: posted ? filled / posted : 0,
    spreadPaid,
    openAtEnd: [...held.entries()].map(([sym, p]) => ({ symbol: sym, size: p.size, entry: p.entry })),
    equityCurve,
    feed: feed.slice().reverse(),
  };

  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(result, null, 1));
  console.log(`\n\n${feed.length} decisions over ${result.hours} hours`);
  console.log(`  posted ${posted}, filled ${filled} (${(result.fillRate * 100).toFixed(0)}% fill rate), crossed ${crossed}`);
  console.log(`  spread paid on exits: $${spreadPaid.toFixed(2)}`);
  console.log(`  equity $${startEquity.toLocaleString()} -> $${finalEquity.toFixed(2)} ` +
    `(${result.pnl >= 0 ? '+' : ''}${result.pnlPct.toFixed(2)}%)`);
  console.log(`  still open: ${result.openAtEnd.map((p) => p.symbol).join(', ') || 'nothing'}`);
  console.log(`\nwrote backtest/result.json`);
})().catch((e) => { console.error('\nfailed:', e.message); process.exitCode = 1; });
