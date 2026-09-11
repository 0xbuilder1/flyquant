/**
 * The money arithmetic. This is the suite that has to be right.
 *
 * position.js is pure, so every one of these runs with no network, no key and no account — which is
 * the entire reason the sizing was put in its own module. A funded account is needed to place an
 * order; it is not needed to prove the order would be the right size, and waiting for one before
 * testing this is how a sizing bug reaches a real balance.
 */
'use strict';

const assert = require('assert');
const { plan, book } = require('./position.js');

let pass = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// PONS's real numbers, from orderBookDetails
const MARKET = { symbol: 'PONS', marketId: 44, mark: 0.65, minQuote: 10, minBase: 20, sizeDecimals: 1 };
const account = (equity, positions = []) => ({ equity, collateral: equity, available: equity, positions,
  unrealized: 0, exposure: positions.reduce((s, p) => s + Math.abs(p.notional), 0) });
const pos = (marketId, notional, symbol = 'PONS') => ({
  marketId, symbol, sign: Math.sign(notional), size: Math.abs(notional) / 0.65,
  entry: 0.65, notional, unrealized: 0, realized: 0, liquidation: 0, funding: 0 });

const LONG = { action: 'long', size: 1, why: 'test' };
const HALF = { action: 'long', size: 0.5, why: 'test' };
const SHORT = { action: 'short', size: 1, why: 'test' };
const ESCAPE = { action: 'escape', size: 1, why: 'test' };
const HOLD = { action: 'hold', size: 0, why: 'test' };
const EXP = { maxFraction: 0.25 };

console.log('sizing');
ok('a fully convinced fly targets the operator risk budget, not the whole account', () => {
  const p = plan({ account: account(1000), market: MARKET, decision: LONG, exposure: EXP });
  assert.strictEqual(p.target, 250);
  assert.strictEqual(p.order.side, 'buy');
});
ok('half conviction is half the budget', () => {
  const p = plan({ account: account(1000), market: MARKET, decision: HALF, exposure: EXP });
  assert.strictEqual(p.target, 125);
});
ok('a short target is negative and sells', () => {
  const p = plan({ account: account(1000), market: MARKET, decision: SHORT, exposure: EXP });
  assert.strictEqual(p.target, -250);
  assert.strictEqual(p.order.side, 'sell');
  assert.strictEqual(p.order.isAsk, true);
});
ok('maxFraction 1.0 never exceeds equity — no leverage by default', () => {
  const p = plan({ account: account(1000), market: MARKET, decision: LONG, exposure: { maxFraction: 1 } });
  assert.strictEqual(p.target, 1000);
});

console.log('\nnew capital becomes position size');
ok('a bigger account buys the difference, without a word about deposits', () => {
  const held = [pos(44, 250)];
  // the same fly, the same conviction, after the account doubled
  const p = plan({ account: account(2000, held), market: MARKET, decision: LONG, exposure: EXP });
  assert.strictEqual(p.target, 500);
  assert.strictEqual(p.delta, 250);
  assert.strictEqual(p.order.side, 'buy');
});
ok('a shrinking account trims by the same subtraction', () => {
  const p = plan({ account: account(400, [pos(44, 250)]), market: MARKET, decision: LONG, exposure: EXP });
  assert.strictEqual(p.target, 100);
  assert.strictEqual(p.delta, -150);
  assert.strictEqual(p.order.side, 'sell');
  assert.strictEqual(p.order.reduceOnly, true, 'trimming toward zero must be reduce-only');
});
ok('already at target places nothing', () => {
  const p = plan({ account: account(1000, [pos(44, 250)]), market: MARKET, decision: LONG, exposure: EXP });
  assert.strictEqual(p.order, null);
  assert.match(p.reason, /already at target|under the market minimum/);
});

console.log('\nreversals and exits');
ok('long to short is ONE order straight through zero', () => {
  const p = plan({ account: account(1000, [pos(44, 250)]), market: MARKET, decision: SHORT, exposure: EXP });
  assert.strictEqual(p.target, -250);
  assert.strictEqual(p.delta, -500, 'the delta must cross zero in a single order');
  assert.strictEqual(p.order.reduceOnly, false, 'a flip is not reduce-only');
});
ok('escape targets exactly zero and is reduce-only', () => {
  const p = plan({ account: account(1000, [pos(44, 250)]), market: MARKET, decision: ESCAPE, exposure: EXP });
  assert.strictEqual(p.target, 0);
  assert.strictEqual(p.order.side, 'sell');
  assert.strictEqual(p.order.reduceOnly, true);
});
ok('escape on a short buys back to zero', () => {
  const p = plan({ account: account(1000, [pos(44, -250)]), market: MARKET, decision: ESCAPE, exposure: EXP });
  assert.strictEqual(p.target, 0);
  assert.strictEqual(p.order.side, 'buy');
});
ok('holding changes nothing at all', () => {
  const p = plan({ account: account(1000, [pos(44, 250)]), market: MARKET, decision: HOLD, exposure: EXP });
  assert.strictEqual(p.order, null);
  assert.strictEqual(p.target, 250, 'a hold must leave the position where it is');
});

console.log('\nthe exchange\'s limits, not ours');
ok('a delta under the market minimum is refused, not rounded up', () => {
  const p = plan({ account: account(20), market: MARKET, decision: LONG, exposure: EXP });
  assert.strictEqual(p.order, null);
  assert.match(p.reason, /under the market minimum/);
});
ok('size rounds DOWN to the market precision, never up', () => {
  const p = plan({ account: account(1000), market: { ...MARKET, sizeDecimals: 1 }, decision: LONG, exposure: EXP });
  const exact = 250 / 0.65;                     // 384.615...
  assert.ok(p.order.sizeBase <= exact, `${p.order.sizeBase} overshot ${exact}`);
  assert.strictEqual(p.order.sizeBase, 384.6);
});
ok('an empty account plans nothing rather than dividing by zero', () => {
  const p = plan({ account: account(0), market: MARKET, decision: LONG, exposure: EXP });
  assert.strictEqual(p.order, null);
  assert.match(p.reason, /no equity/);
});
ok('a market with no mark plans nothing', () => {
  const p = plan({ account: account(1000), market: { ...MARKET, mark: 0 }, decision: LONG, exposure: EXP });
  assert.strictEqual(p.order, null);
});
ok('positions in OTHER markets do not move this target', () => {
  const p = plan({ account: account(1000, [pos(2, 400, 'HYPE')]), market: MARKET, decision: LONG, exposure: EXP });
  assert.strictEqual(p.held, 0, 'held must be this market only');
  assert.strictEqual(p.target, 250);
});

console.log('\nthe book');
ok('utilisation and exposure add up', () => {
  const b = book(account(1000, [pos(44, 250), pos(2, -150, 'HYPE')]));
  assert.strictEqual(b.exposure, 400);
  assert.strictEqual(b.utilisation, 0.4);
  assert.strictEqual(b.positions.length, 2);
  assert.strictEqual(b.positions[1].side, 'short');
});

console.log(`\n${pass} passed`);
