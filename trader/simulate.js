/**
 * What the fly would actually PUT ON, and how fast.
 *
 * THIS IS NOT A BACKTEST AND IT DELIBERATELY REFUSES TO BE ONE. It reports no profit and loss, no
 * return, no Sharpe. Marks never move inside it. The question it answers is the one that can be
 * answered honestly without a fitted assumption anywhere:
 *
 *     Given the decisions this animal actually makes, does the money arithmetic hold — does it fill
 *     its slots quickly, does every cap bind where it should, and does it all scale with equity?
 *
 * A profit figure out of this would be a fabrication: it would need an execution model, a slippage
 * model and a forward return, and each of those is a number somebody chose. Slot counts, notional,
 * and margin are not — they follow from position.js, which is pure and tested.
 *
 * HOW IT RUNS. The fly is expensive (a 250ms pass costs about 7 seconds of CPU), so the decisions
 * are made ONCE against live markets and then replayed at every account size. That is exactly the
 * right experiment for the question: the animal does not know how much money it has — nothing in
 * brain/ ever sees the balance — so the same market gives the same decision on $76 and on $1M, and
 * the ONLY thing that changes is what that decision is worth. If the positions at $1M are not 13,000
 * times the positions at $76, something other than equity is driving size, and that is a bug.
 *
 *     node trader/simulate.js                       # 12 passes, the live account's size and up
 *     node trader/simulate.js --passes 20 --ms 300
 *     node trader/simulate.js --at 5000             # one specific account size
 */
'use strict';

const path = require('path');
const { Brain } = require('../brain/lif.js');
const A = require('../brain/arena.js');
const senses = require('../brain/senses.js');
const { decide } = require('../brain/readout.js');
const lighter = require('./lighter.js');
const position = require('./position.js');

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};

const usd = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US',
  { minimumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });

/** the simulated account: positions only, marks frozen, nothing invented */
function makeAccount(equity) {
  return { equity, collateral: equity, available: equity, unrealized: 0, exposure: 0, positions: [] };
}
function notionalOf(acct, marketId) {
  const p = acct.positions.find((x) => x.marketId === marketId);
  return p ? p.notional : 0;
}
function apply(acct, plan, market) {
  if (!plan.order) return;
  // the order is assumed to fill at the mark. That is the ONE assumption in this file and it is
  // stated rather than buried: it is what makes this a sizing simulation and not an execution one.
  const target = plan.target;
  const i = acct.positions.findIndex((x) => x.marketId === plan.marketId);
  if (Math.abs(target) < 1e-9) {
    if (i >= 0) acct.positions.splice(i, 1);
  } else {
    const row = {
      marketId: plan.marketId, symbol: plan.symbol, sign: Math.sign(target),
      size: Math.abs(target) / plan.mark, entry: plan.mark, notional: target,
      unrealized: 0, realized: 0, liquidation: 0, funding: 0,
      leverage: plan.leverage,
    };
    if (i >= 0) acct.positions[i] = row; else acct.positions.push(row);
  }
  acct.exposure = acct.positions.reduce((s, p) => s + Math.abs(p.notional), 0);
}
function marginOf(acct) {
  // cross margin: each position's initial margin is its notional over the leverage it was opened at
  return acct.positions.reduce((s, p) => s + Math.abs(p.notional) / (p.leverage || 1), 0);
}

async function main() {
  const cfg = require(path.join(__dirname, '..', 'keeper', 'config.json'));
  const exposure = cfg.trade.exposure;
  const passes = arg('passes', 12);
  const ms = arg('ms', 250);
  const one = arg('at', 0);

  console.log('FLYQUANT — what it would put on, and how fast\n');
  console.log('  NOT A BACKTEST. No profit or loss is reported, because none can be computed honestly');
  console.log('  here. Marks are frozen; the only assumption is that an order fills at the mark.\n');

  const brain = Brain.load(path.join(__dirname, '..', 'brain', 'graph'));
  const arena = A.buildArena(brain);
  console.log(`fly: ${brain.n.toLocaleString()} neurons · arena: ${arena.neurons.toLocaleString()} medulla inputs`);
  console.log(`slots ${exposure.slots} × ${exposure.leverage}x · one position ≤ ${(exposure.maxFraction * 100).toFixed(0)}% of equity` +
              ` · the sum ≤ ${exposure.maxTotalFraction}× equity\n`);

  // ── the decisions, made once against live markets ─────────────────────────────────────────────
  const snap = await lighter.snapshot();
  const markets = lighter.toArena(snap, lighter.loadPrevious());
  const seats = A.seatMarkets(markets);
  const bySymbol = new Map(markets.map((m) => [m.symbol, m]));
  const ctx = { depthOf: {} };
  ctx.ambient = senses.ambient(markets, ctx);

  console.log(`making ${passes} decisions against ${markets.length} live markets` +
              ` (${ms}ms each, about ${Math.round(passes * ms * 0.028)}s)\n`);

  const decisions = [];
  let heading = 0;
  for (let k = 0; k < passes; k++) {
    const pass = A.runPass(brain, arena, seats, markets, { ms, seed: k + 1, ctx, heading0: heading });
    heading = pass.heading;
    const d = decide(brain, pass.result);
    if (!pass.chosen) continue;
    decisions.push({ symbol: pass.chosen.symbol, decision: d });
    process.stdout.write(`  ${String(k + 1).padStart(2)}  ${pass.chosen.symbol.padEnd(10)} ` +
      `${d.action.toUpperCase().padEnd(7)} ${(d.size * 100).toFixed(0).padStart(3)}%  ` +
      `appetite ${((d.mood.appetite) * 100).toFixed(0)}%\n`);
  }

  // ── replayed at every account size ────────────────────────────────────────────────────────────
  const sizes = one ? [one] : [76, 1000, 100000, 1000000];
  for (const equity of sizes) {
    const acct = makeAccount(equity);
    console.log(`\n${'─'.repeat(94)}\nON ${usd(equity)}\n`);
    console.log('  pass  market      action        size        notional   slots  exposure    margin   note');

    let refused = 0;
    decisions.forEach((row, k) => {
      const m = bySymbol.get(row.symbol);
      const plan = position.plan({
        account: { ...acct, exposure: acct.positions.reduce((s, p) => s + Math.abs(p.notional), 0) },
        market: { ...m.market, symbol: m.symbol, marketId: m.marketId, mark: m.mark },
        decision: row.decision, chosen: row.symbol, exposure,
      });
      apply(acct, plan, m);
      const note = plan.order ? (plan.slotCapped ? 'slot' : plan.capped ? 'AGGREGATE CAP' : '')
                              : (plan.reason || '');
      if (!plan.order) refused++;
      console.log(
        `  ${String(k + 1).padStart(4)}  ${row.symbol.padEnd(10)}  ` +
        `${(plan.order ? plan.order.side : '—').padEnd(6)} ` +
        `${(row.decision.size * 100).toFixed(0).padStart(4)}%  ` +
        `${usd(plan.target).padStart(12)}  ${String(acct.positions.length).padStart(2)}/${exposure.slots}  ` +
        `${usd(acct.exposure).padStart(11)}  ${usd(marginOf(acct)).padStart(9)}  ${note}`);
    });

    const margin = marginOf(acct);
    const lev = acct.exposure / equity;
    console.log(`\n  ${acct.positions.length} positions · ${usd(acct.exposure)} notional` +
                ` = ${lev.toFixed(2)}× equity · ${usd(margin)} of margin` +
                ` = ${((margin / equity) * 100).toFixed(0)}% of the account · ${refused} passes placed nothing`);

    const biggest = acct.positions.slice().sort((a, z) => Math.abs(z.notional) - Math.abs(a.notional))[0];
    if (biggest) console.log(`  biggest: ${biggest.symbol} ${usd(Math.abs(biggest.notional))}` +
      ` = ${((Math.abs(biggest.notional) / equity) * 100).toFixed(0)}% of equity at ${biggest.leverage}x`);

    // the invariants. If any of these trip, the arithmetic is wrong and it is better to find out here.
    const problems = [];
    if (margin > equity * 1.0001) problems.push(`margin ${usd(margin)} exceeds the account`);
    if (acct.exposure > equity * exposure.maxTotalFraction * 1.0001)
      problems.push(`exposure ${lev.toFixed(2)}x is over the ${exposure.maxTotalFraction}x cap`);
    for (const p of acct.positions) {
      if (Math.abs(p.notional) > equity * exposure.maxFraction * 1.0001)
        problems.push(`${p.symbol} at ${usd(Math.abs(p.notional))} is over the per-position ceiling`);
    }
    console.log(problems.length ? '  BROKEN: ' + problems.join('; ') : '  every cap held');
  }

  // ── does it scale? ───────────────────────────────────────────────────────────────────────────
  if (sizes.length > 1) {
    console.log(`\n${'─'.repeat(94)}\nSCALING\n`);
    console.log('  The animal never sees the balance, so the decisions above are identical at every');
    console.log('  size. Anything that is not exactly proportional is a cap doing its job:\n');
    const base = makeAccount(sizes[0]);
    const rows = sizes.map((equity) => {
      const acct = makeAccount(equity);
      decisions.forEach((row) => {
        const m = bySymbol.get(row.symbol);
        const plan = position.plan({
          account: { ...acct, exposure: acct.positions.reduce((s, p) => s + Math.abs(p.notional), 0) },
          market: { ...m.market, symbol: m.symbol, marketId: m.marketId, mark: m.mark },
          decision: row.decision, chosen: row.symbol, exposure,
        });
        apply(acct, plan, m);
      });
      return { equity, n: acct.positions.length, exposure: acct.exposure, margin: marginOf(acct) };
    });


    console.log('    equity        positions      notional      × equity     margin used');
    for (const r of rows) {
      console.log(`    ${usd(r.equity).padStart(11)}  ${String(r.n).padStart(11)}  ` +
        `${usd(r.exposure).padStart(13)}  ${(r.exposure / r.equity).toFixed(2).padStart(10)}×  ` +
        `${((r.margin / r.equity) * 100).toFixed(0).padStart(12)}%`);
    }
    // PUBLISHED, because the site may only show numbers the keeper produced. The page cannot compute
    // this for itself — a page that can compute its own figures will eventually compute a flattering
    // one — so it reads this file or shows nothing at all.
    try {
      const out = {
        at: Date.now(),
        passes: decisions.length,
        ms,
        slots: exposure.slots,
        leverage: exposure.leverage,
        rows: rows.map((r) => ({
          equity: r.equity,
          positions: r.n,
          notional: Math.round(r.exposure * 100) / 100,
          leverage: Math.round((r.exposure / r.equity) * 100) / 100,
          marginFraction: Math.round((r.margin / r.equity) * 1000) / 1000,
        })),
      };
      require('fs').writeFileSync(path.join(__dirname, '..', 'site', 'scaling.json'),
        JSON.stringify(out, null, 1));
      console.log('\n  written to site/scaling.json');
    } catch (e) { console.error('  could not publish the scaling table:', e.message); }
    void base;
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
