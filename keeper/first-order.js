#!/usr/bin/env node
/**
 * ONE order. Deliberately, small, and watched.
 *
 *   node keeper/first-order.js                         show what it would send, send nothing
 *   set LIGHTER_API_KEY=...
 *   node keeper/first-order.js --broadcast --i-mean-it send exactly one order
 *
 * WHY THIS EXISTS RATHER THAN JUST ARMING THE LOOP.
 *
 * The signer's live path has never executed. Not once. `create_order` with POST_ONLY, the tuple the
 * SDK returns instead of raising, the nonce, the expiry, the integer scaling of price and size — all
 * of it is written against verified signatures and NONE of it has met the exchange. The first
 * contact with reality should be one order, at a size that does not matter, with a human reading the
 * output — not the first tick of an unattended loop that will place another one three minutes later
 * whatever happened.
 *
 * It runs the real fly and sends the real plan. The only thing it adds is a hard clamp and a second
 * switch: --broadcast is not enough, --i-mean-it is also required, because this is the one command
 * in the repo whose whole purpose is to spend money.
 *
 * After this succeeds once, delete nothing and change nothing — just run the loop.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { Brain } = require('../brain/lif.js');
const A = require('../brain/arena.js');
const { decide } = require('../brain/readout.js');
const lighter = require('../trader/lighter.js');
const accountApi = require('../trader/account.js');
const position = require('../trader/position.js');
const orders = require('../trader/order.js');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);

(async () => {
  const cfgFile = path.join(__dirname, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const clamp = Number(arg('max', 12));
  const ms = Number(arg('ms', 350));
  const live = has('broadcast') && has('i-mean-it');

  const accountIndex = Number(cfg.lighter.accountIndex || 0);
  if (!(accountIndex > 0)) { console.error('lighter.accountIndex is not set'); process.exit(1); }

  console.log(`FIRST ORDER · account ${accountIndex} · clamped to $${clamp} · ${live ? 'WILL SEND' : 'dry'}\n`);

  const account = await accountApi.read(accountIndex);
  console.log(`equity $${account.equity.toFixed(2)}, ${account.positions.length} positions`);
  if (account.equity <= 0) { console.error('no equity'); process.exit(1); }

  // a real window, the same warmup the loop uses on a cold start
  let prev = lighter.loadPrevious();
  if (!prev) {
    console.log('cold: snapshot, wait 20s, snapshot');
    prev = await lighter.snapshot();
    lighter.savePrevious(prev);
    await new Promise((r) => setTimeout(r, 20000));
  }
  const snap = await lighter.snapshot();
  const markets = lighter.toArena(snap, prev);
  lighter.savePrevious(snap);

  const brain = Brain.load();
  const arena = A.buildArena(brain);
  const seats = A.seatMarkets(markets);
  const ctx = { fundingClampSmall: 0.05, tradesMax: Math.max(...markets.map((m) => m.market.trades), 1) };
  const pass = A.runPass(brain, arena, seats, markets, { ms, seed: Date.now() % 100000, ctx });
  const d = decide(brain, pass.result);

  console.log(`\nthe fly faced ${pass.chosen ? pass.chosen.symbol : 'nothing'} and said ` +
    `${d.action.toUpperCase()}${d.action === 'hold' ? '' : ' ' + (d.size * 100).toFixed(0) + '%'}` +
    ` at appetite ${(d.mood.appetite * 100).toFixed(0)}%`);
  if (!pass.chosen || d.action === 'hold') { console.log('nothing to send. Run it again.'); return; }

  const depth = await lighter.depth(pass.chosen.marketId, cfg.lighter.maxSlippage || 0.005);
  if (depth) {
    console.log(`book: $${Math.round(depth.bid)} bid / $${Math.round(depth.ask)} ask, spread ${depth.spreadBps.toFixed(1)}bp`);
  }

  const plan = position.plan({
    account, market: { ...pass.chosen.market, mark: pass.chosen.mark },
    decision: d, exposure: cfg.trade.exposure, depth,
  });
  if (!plan.order) { console.log(`no order: ${plan.reason}`); return; }

  // THE CLAMP. Not a policy, a seatbelt for the one command that exists to spend money for the
  // first time. If the fly wants more than this, it gets this.
  if (plan.order.notional > clamp) {
    const scale = clamp / plan.order.notional;
    const step = Math.pow(10, -(pass.chosen.market.sizeDecimals || 0));
    plan.order.sizeBase = Math.floor((plan.order.sizeBase * scale) / step) * step;
    plan.order.notional = plan.order.sizeBase * plan.order.mark;
    console.log(`clamped from the fly's size down to $${plan.order.notional.toFixed(2)}`);
    if (plan.order.sizeBase <= 0 || plan.order.notional < (pass.chosen.market.minQuote || 10)) {
      console.log(`clamping puts it under the market's $${pass.chosen.market.minQuote} minimum — raise --max`);
      return;
    }
  }

  const o = plan.order;
  console.log(`\n  ${o.side.toUpperCase()} ${o.sizeBase} ${o.symbol}  $${o.notional.toFixed(2)}`);
  console.log(`  ${o.execution === 'post-only' ? `RESTING at ${o.limitPrice} — cannot cross` : 'CROSSING'}`);
  console.log(`  ${d.why}`);

  const entry = await orders.execute({
    plan,
    cfg: {
      accountIndex,
      apiKeyIndex: cfg.lighter.apiKeyIndex || 4,
      maxNotionalUsd: clamp,                       // the signer refuses above this too
      maxSlippage: cfg.lighter.maxSlippage,
      sizeDecimals: pass.chosen.market.sizeDecimals,
      priceDecimals: pass.chosen.market.priceDecimals,
      // 0 = the SDK's own default expiry. The signature covers this field, so for the FIRST order
      // nothing about it is guessed; the loop uses a short expiry so unfilled orders die on their own.
      expirySeconds: Number(arg('expiry', 0)),
      armed: live,
      stateRoot: path.join(__dirname, 'state'),
    },
    broadcast: live,
    context: { first: true },
  });

  console.log(`\n  ${entry.status.toUpperCase()}${entry.note ? ' — ' + entry.note : ''}`);
  if (entry.txHash) {
    console.log(`  tx ${entry.txHash}`);
    console.log(`  ${entry.verify}`);
    console.log(`\n  it is resting. Watch the account: ${accountApi.verifyAccount(accountIndex)}`);
  } else if (!live) {
    console.log('\n  add --broadcast --i-mean-it (and set LIGHTER_API_KEY) to actually send this.');
  }
})().catch((e) => { console.error('failed:', e.message); process.exitCode = 1; });
