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
const { plan, book, stale } = require('./position.js');

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

console.log('\nthe three limits that only matter with real money');
const SCALE = { maxFraction: 0.25, maxTotalFraction: 1.0, deadbandFraction: 0.02, takerMaxBps: 6 };

ok('the aggregate cap bounds the SUM, not just each market', () => {
  // 95% of equity is already committed elsewhere; a fresh 25% target must not take it to 120%
  const p = plan({ account: account(1000, [pos(2, 950, 'HYPE')]), market: MARKET, decision: LONG, exposure: SCALE });
  assert.strictEqual(p.target, 50, 'the target must be scaled into the remaining room');
  assert.strictEqual(p.capped, true);
});
ok('a full book scales a new target to zero rather than refusing forever', () => {
  const p = plan({ account: account(1000, [pos(2, 1000, 'HYPE')]), market: MARKET, decision: LONG, exposure: SCALE });
  assert.strictEqual(p.target, 0);
});
ok('total exposure can never exceed maxTotalFraction x equity, over any number of markets', () => {
  let held = [];
  for (let k = 0; k < 20; k++) {
    const p = plan({ account: account(1000, held), market: { ...MARKET, marketId: k, symbol: 'M' + k },
                     decision: LONG, exposure: SCALE });
    if (p.order) held = [...held.filter((x) => x.marketId !== k), pos(k, p.target, 'M' + k)];
  }
  const total = held.reduce((s, x) => s + Math.abs(x.notional), 0);
  assert.ok(total <= 1000 + 1e-6, `${total} exceeded equity across ${held.length} markets`);
});
ok('the deadband refuses a small rebalance on a big account', () => {
  // conviction drifts 1.0 -> 0.95: a $12.50 change on $1,000 — over the $10 exchange minimum, but
  // well inside the 2% deadband, and this is the churn that ate $331/day in simulation
  const fine = { ...MARKET, minBase: 0.01, sizeDecimals: 2 };
  const p = plan({ account: account(1000, [pos(44, 250)]), market: fine,
                   decision: { action: 'long', size: 0.95, why: '' }, exposure: SCALE });
  assert.strictEqual(p.order, null);
  assert.match(p.reason, /deadband/);
});
ok('the deadband NEVER blocks getting out', () => {
  const p = plan({ account: account(1000, [pos(44, 250)]), market: MARKET, decision: ESCAPE, exposure: SCALE });
  assert.ok(p.order, 'escape must never be deferred by a deadband');
  assert.strictEqual(p.target, 0);
});
ok('the deadband scales with the account rather than being a dollar rule', () => {
  // THE SAME $25 MOVE, on two very different accounts. On $1,000 the band is $20 and $25 clears it;
  // on $100,000 the band is $2,000 and the identical order is noise. A fixed dollar threshold could
  // not tell those apart, which is the whole reason this is a fraction of equity.
  const fine = { ...MARKET, minBase: 0.01, sizeDecimals: 2 };
  const small = plan({ account: account(1000, [pos(44, 250)]), market: fine,
                       decision: { action: 'long', size: 0.9, why: '' }, exposure: SCALE });
  const big = plan({ account: account(100000, [pos(44, 25000)]), market: fine,
                     decision: { action: 'long', size: 0.999, why: '' }, exposure: SCALE });
  assert.strictEqual(Math.round(small.delta), -25);
  assert.ok(small.order, '$25 on a $1,000 account is outside its $20 band');
  assert.strictEqual(Math.round(big.delta), -25);
  assert.strictEqual(big.order, null, 'the same $25 on $100,000 is inside its $2,000 band');
});
// depth measured live on 2026-09-11, quote within +/-0.5% of mid
const DEEP = { min: 570008, bid: 570008, ask: 583515, spreadBps: 1 };   // BTC
const THIN = { min: 16991, bid: 64960, ask: 16991, spreadBps: 8 };      // PONS
const DUST = { min: 435, bid: 2881, ask: 435, spreadBps: 40 };          // CASHCAT

ok('a deep book does not bind a $25,000 target', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: DEEP });
  assert.strictEqual(p.target, 25000);
  assert.strictEqual(p.depthCapped, false);
});
ok('a thin book caps the target to a quarter of its THINNER side', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: THIN });
  assert.strictEqual(p.depthCapped, true);
  assert.strictEqual(p.target, 16991 * 0.25);
  assert.ok(p.target < 25000 * 0.18, 'PONS must take far less than the equity-derived size');
});
ok('a market with almost no book gets almost no position', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: DUST });
  assert.strictEqual(p.target, 435 * 0.25);
  assert.ok(p.target < 120, `${p.target} is still too large for a $435 book`);
});
ok('the cap is the thinner side, not the side being traded', () => {
  // PONS: $64,960 of bids but only $16,991 of asks. Buying uses the asks; the cap must still be
  // taken against the min, because the EXIT will need the other side.
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: THIN });
  assert.strictEqual(p.target, Math.min(THIN.bid, THIN.ask) * 0.25);
});
ok('AN ESCAPE IS NEVER DEPTH-CAPPED', () => {
  // already oversized for the book; refusing to shrink because the book is thin would trap the fly
  // in exactly the position the cap exists to prevent
  const p = plan({ account: account(100000, [pos(44, 40000)]), market: MARKET,
                   decision: ESCAPE, exposure: SCALE, depth: DUST });
  assert.strictEqual(p.target, 0);
  assert.strictEqual(p.depthCapped, false);
  assert.ok(p.order, 'the exit must be placeable');
});
ok('no depth reading means no depth cap, and the other caps still apply', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: null });
  assert.strictEqual(p.depthCapped, false);
  assert.strictEqual(p.target, 25000);
});

console.log('\nmaker or taker — where the losses are allowed to come from');
// Both fixtures carry a real LADDER, because the cost of crossing is now measured by walking it
// rather than modelled from a total. A fixture without levels would cost nothing to cross and every
// maker test would silently become a taker test — which is exactly what happened first time.
const PLENTY = 1e9;                               // enough size that one level fills any test order

// TIGHT: the touch is 1.5bp from mid, so crossing is cheap and the keeper crosses.
const TOUCH = {
  min: 570008, bid: 570008, ask: 583515, spreadBps: 3.1, band: 0.005,
  mid: 0.6485, best: { bid: 0.6484, ask: 0.6486 },
  levels: { bid: [[0.6484, PLENTY]], ask: [[0.6486, PLENTY]] },
};
// WIDE: the touch is 7.7bp from mid, over the 6bp line, so it rests instead.
const WIDE = {
  min: 570008, bid: 570008, ask: 583515, spreadBps: 15.4, band: 0.005,
  mid: 0.6485, best: { bid: 0.6480, ask: 0.6490 },
  levels: { bid: [[0.6480, PLENTY]], ask: [[0.6490, PLENTY]] },
};

ok('an opening order rests post-only when crossing is expensive', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: WIDE });
  assert.strictEqual(p.maker, true);
  assert.strictEqual(p.order.execution, 'post-only');
});
ok('a BUY posts at the bid, not the ask — crossing is the thing being avoided', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: WIDE });
  assert.strictEqual(p.order.side, 'buy');
  assert.strictEqual(p.order.limitPrice, 0.648, 'a buy that posts at the ask has paid the spread');
});
ok('a SELL posts at the ask', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: SHORT, exposure: SCALE, depth: WIDE });
  assert.strictEqual(p.order.side, 'sell');
  assert.strictEqual(p.order.limitPrice, 0.649);
});
ok('AN ESCAPE CROSSES — an exit that might not fill is not an exit', () => {
  const p = plan({ account: account(100000, [pos(44, 20000)]), market: MARKET,
                   decision: ESCAPE, exposure: SCALE, depth: TOUCH });
  assert.strictEqual(p.maker, false);
  assert.strictEqual(p.order.execution, 'market');
});
ok('no book reading falls back to crossing, rather than posting a price it cannot see', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: null });
  assert.strictEqual(p.maker, false);
  assert.strictEqual(p.order.execution, 'market');
  assert.strictEqual(p.order.limitPrice, null);
});
ok('THE DEADBAND DOES NOT BLOCK A MAKER ORDER — the fly keeps its full resolution', () => {
  // a $250 tweak on $100,000: far inside the $2,000 deadband, and it goes through anyway because a
  // resting order pays no spread and there is nothing to protect it from
  const fine = { ...MARKET, minBase: 0.01, sizeDecimals: 2 };
  const p = plan({ account: account(100000, [pos(44, 25000)]), market: fine,
                   decision: { action: 'long', size: 0.99, why: '' }, exposure: SCALE, depth: WIDE });
  assert.ok(p.order, 'a maker order must not be deadbanded');
  assert.strictEqual(p.order.execution, 'post-only');
  assert.strictEqual(Math.round(p.delta), -250);
});
ok('the deadband STILL blocks a taker order of the same size', () => {
  const fine = { ...MARKET, minBase: 0.01, sizeDecimals: 2 };
  const p = plan({ account: account(100000, [pos(44, 25000)]), market: fine,
                   decision: { action: 'long', size: 0.99, why: '' }, exposure: SCALE, depth: null });
  assert.strictEqual(p.order, null);
  assert.match(p.reason, /deadband/);
});

console.log('\nthe fly choosing for itself');
const mood = (appetite) => ({ appetite, patience: 1 - appetite, octopamineHz: 0, serotoninHz: 0, dopamineHz: 0 });

ok('appetite decides how much of the allowance is taken', () => {
  const hungry = plan({ account: account(100000), market: MARKET, exposure: SCALE, depth: TOUCH,
                        decision: { ...LONG, mood: mood(1) } });
  const calm = plan({ account: account(100000), market: MARKET, exposure: SCALE, depth: TOUCH,
                      decision: { ...LONG, mood: mood(0.25) } });
  assert.strictEqual(hungry.target, 25000, 'a flooded fly takes the whole allowance');
  assert.strictEqual(calm.target, 6250, 'a calm one takes a quarter of it');
});
ok('the operator ceiling still binds whatever the fly wants', () => {
  const p = plan({ account: account(100000), market: MARKET, exposure: SCALE, depth: TOUCH,
                   decision: { ...LONG, mood: mood(1) } });
  assert.ok(p.target <= 100000 * SCALE.maxFraction, 'the fly must not exceed the ceiling');
  assert.strictEqual(p.ceiling, 0.25);
});
ok('an unaroused fly takes no position at all', () => {
  const p = plan({ account: account(100000), market: MARKET, exposure: SCALE, depth: TOUCH,
                   decision: { ...LONG, mood: mood(0) } });
  assert.strictEqual(p.target, 0);
});
ok('patience rests the order BEHIND the touch, for a better price', () => {
  // bid 0.6480 / ask 0.6490, spread 0.0010
  const impatient = plan({ account: account(100000), market: MARKET, exposure: SCALE, depth: WIDE,
                           decision: { ...LONG, mood: mood(1) } });
  const patient = plan({ account: account(100000), market: MARKET, exposure: SCALE, depth: WIDE,
                         decision: { ...LONG, mood: mood(0.5) } });
  assert.strictEqual(impatient.order.limitPrice, 0.648, 'an aroused fly sits at the touch');
  assert.ok(patient.order.limitPrice < 0.648, 'a calm one bids lower and may not get filled');
  assert.strictEqual(patient.order.limitPrice, 0.6475);
});
ok('a patient SELL rests above the ask, not below it', () => {
  const p = plan({ account: account(100000), market: MARKET, exposure: SCALE, depth: WIDE,
                   decision: { ...SHORT, mood: mood(0.5) } });
  assert.ok(p.order.limitPrice > 0.649, 'a patient sell must ask MORE, not less');
  assert.strictEqual(p.order.limitPrice, 0.6495);
});
ok('no mood at all falls back to the full allowance and the touch', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: WIDE });
  assert.strictEqual(p.target, 25000);
  assert.strictEqual(p.order.limitPrice, 0.648);
});

ok('a TIGHT book is crossed, not rested in', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: TOUCH });
  assert.strictEqual(p.maker, false, 'cheap to cross means cross');
  assert.strictEqual(p.order.execution, 'market');
  assert.ok(p.crossCostBps <= SCALE.takerMaxBps, `${p.crossCostBps}bp should be under the threshold`);
});
ok('a WIDE book is rested in, not crossed', () => {
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: WIDE });
  assert.strictEqual(p.maker, true);
  assert.strictEqual(p.order.execution, 'post-only');
  assert.ok(p.crossCostBps > SCALE.takerMaxBps);
});
ok('a big order in a thin book prices ITSELF out of crossing', () => {
  // the touch is cheap, but there is almost nothing at it: the order walks into progressively
  // worse levels and the AVERAGE fill is what makes crossing unaffordable
  const thin = { ...TOUCH, bid: 400, ask: 400, min: 400,
    levels: { bid: [[0.6484, 20], [0.6470, 20], [0.6300, PLENTY]],
              ask: [[0.6486, 20], [0.6500, 20], [0.6700, PLENTY]] } };
  const p = plan({ account: account(100000), market: MARKET, decision: LONG, exposure: SCALE, depth: thin });
  assert.strictEqual(p.maker, true, 'impact should push it over the threshold on its own');
  assert.ok(p.crossCostBps > SCALE.takerMaxBps);
});
ok('AN EXIT CROSSES EVEN WHEN CROSSING IS EXPENSIVE', () => {
  const p = plan({ account: account(100000, [pos(44, 20000)]), market: MARKET,
                   decision: ESCAPE, exposure: SCALE, depth: WIDE });
  assert.strictEqual(p.maker, false, 'an exit that might not fill is not an exit');
  assert.strictEqual(p.order.execution, 'market');
});

ok('a position the fly stopped looking at goes stale', () => {
  const now = 1000000000;
  const s = stale({
    account: account(1000, [pos(44, 250), pos(2, 100, 'HYPE')]),
    lastSeen: { PONS: now - 1000, HYPE: now - 60 * 60 * 1000 },
    now, staleAfterMs: 30 * 60 * 1000,
  });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].symbol, 'HYPE');
});
ok('nothing is stale when staleAfterMs is unset', () => {
  assert.strictEqual(stale({ account: account(1000, [pos(44, 250)]), lastSeen: {} }).length, 0);
});

console.log('\nthe book');
ok('utilisation and exposure add up', () => {
  const b = book(account(1000, [pos(44, 250), pos(2, -150, 'HYPE')]));
  assert.strictEqual(b.exposure, 400);
  assert.strictEqual(b.utilisation, 0.4);
  assert.strictEqual(b.positions.length, 2);
  assert.strictEqual(b.positions[1].side, 'short');
});


// ── MARGIN SLOTS AND LEVERAGE ───────────────────────────────────────────────────────────────────
//
// The account is divided into slots of MARGIN, and each slot's notional is its margin times whatever
// leverage that market allows. These tests exist because the obvious alternative — a fixed notional
// per slot — silently overcommits margin on the nine markets that refuse 10x, and the symptom is the
// exchange rejecting the tenth order while the account looks well inside its own cap.
console.log('margin slots');

// 10x is available here (1000 hundredths of a percent = 10% initial margin)
const TEN_X = { ...MARKET, minInitialMarginFraction: 1000 };
// PONS's real limit: 3333 = 33.33% initial margin = 3x
const THREE_X = { ...MARKET, minInitialMarginFraction: 3333 };
const SLOTS = { maxFraction: 1, maxTotalFraction: 10, slots: 10, leverage: 10 };

ok('ten slots at 10x makes one position a full equity of notional', () => {
  const p = plan({ account: account(1000), market: TEN_X, decision: LONG, exposure: SLOTS });
  assert.strictEqual(p.slotMargin, 100);
  assert.strictEqual(p.leverage, 10);
  assert.strictEqual(p.target, 1000);
});

ok('a market that only allows 3x gets 3x off the SAME slot of margin, not 10x', () => {
  const p = plan({ account: account(1000), market: THREE_X, decision: LONG, exposure: SLOTS });
  assert.strictEqual(p.slotMargin, 100);
  assert.ok(Math.abs(p.marketMaxLeverage - 3.0003) < 0.001, `got ${p.marketMaxLeverage}`);
  assert.ok(Math.abs(p.target - 300.03) < 0.01, `got ${p.target}`);
  assert.ok(p.slotCapped, 'the slot should have bound it');
});

ok('ten slots always fit, whatever mix of markets the fly picked', () => {
  // the worst case for margin: every slot in a market that refuses leverage
  let margin = 0;
  for (let i = 0; i < 10; i++) {
    const p = plan({ account: account(1000), market: THREE_X, decision: LONG,
                     exposure: { ...SLOTS, maxTotalFraction: 100 } });
    margin += Math.abs(p.target) / p.leverage;
  }
  assert.ok(margin <= 1000 + 1e-6, `ten slots wanted $${margin.toFixed(2)} of margin on $1000`);
});

ok('the slot scales with equity and nothing else — a doubled account doubles the position', () => {
  const a = plan({ account: account(1000), market: TEN_X, decision: LONG, exposure: SLOTS });
  const b = plan({ account: account(2000), market: TEN_X, decision: LONG, exposure: SLOTS });
  assert.strictEqual(b.target, a.target * 2);
});

ok('conviction and appetite still move inside the slot', () => {
  const full = plan({ account: account(1000), market: TEN_X, decision: LONG, exposure: SLOTS });
  const half = plan({ account: account(1000), market: TEN_X, decision: HALF, exposure: SLOTS });
  assert.strictEqual(half.target, full.target / 2);
});

ok('a mood with no appetite takes no slot at all', () => {
  const p = plan({ account: account(1000), market: TEN_X, exposure: SLOTS,
                   decision: { action: 'long', size: 1, why: 'test', mood: { appetite: 0 } } });
  assert.strictEqual(p.target, 0);
});

ok('leverage unset is leverage 1 — the old behaviour, exactly', () => {
  const p = plan({ account: account(1000), market: TEN_X, decision: LONG, exposure: { maxFraction: 1 } });
  assert.strictEqual(p.target, 1000);
  assert.strictEqual(p.leverage, 1);
});

ok('a full book refuses a NEW market rather than overcommitting margin', () => {
  // ten markets already held, and the fly turns to an eleventh
  const full = [];
  for (let i = 0; i < 10; i++) full.push(pos(100 + i, 100, 'M' + i));
  const p = plan({ account: account(1000, full), market: TEN_X, decision: LONG, exposure: SLOTS });
  assert.strictEqual(p.order, null);
  assert.strictEqual(p.target, 0);
  assert.ok(/slots are full/.test(p.reason), p.reason);
});

ok('a full book still lets the fly add to a market it already holds', () => {
  const full = [pos(44, 100)];                       // PONS, the market under test
  for (let i = 0; i < 9; i++) full.push(pos(100 + i, 100, 'M' + i));
  const p = plan({ account: account(1000, full), market: TEN_X, decision: LONG, exposure: SLOTS });
  assert.ok(p.order, p.reason);
  assert.ok(p.target > 100, `should have added, went to ${p.target}`);
});

ok('a full book never blocks an exit', () => {
  const full = [pos(44, 500)];
  for (let i = 0; i < 9; i++) full.push(pos(100 + i, 100, 'M' + i));
  const p = plan({ account: account(1000, full), market: TEN_X, decision: ESCAPE, exposure: SLOTS });
  assert.strictEqual(p.target, 0);
  assert.ok(p.order.reduceOnly);
});

ok('margin can never exceed the account, whatever the fly chooses', () => {
  // every decision goes to a DIFFERENT market, the way the fly actually behaves
  const acct = account(1000, []);
  for (let k = 0; k < 40; k++) {
    const mkt = { ...(k % 3 ? TEN_X : THREE_X), marketId: 200 + k, symbol: 'X' + k };
    const p = plan({ account: { ...acct, exposure: acct.positions.reduce((s, q) => s + Math.abs(q.notional), 0) },
                     market: mkt, decision: LONG, exposure: SLOTS });
    if (!p.order) continue;
    acct.positions.push({ marketId: mkt.marketId, symbol: mkt.symbol, sign: Math.sign(p.target),
      size: Math.abs(p.target)/p.mark, entry: p.mark, notional: p.target, unrealized: 0,
      realized: 0, liquidation: 0, funding: 0, lev: p.leverage });
  }
  assert.ok(acct.positions.length <= SLOTS.slots, `opened ${acct.positions.length} in ${SLOTS.slots} slots`);
  const margin = acct.positions.reduce((s, q) => s + Math.abs(q.notional)/q.lev, 0);
  assert.ok(margin <= 1000 + 1e-6, `margin reached $${margin.toFixed(2)} on $1000`);
});

ok('an exit is never blocked by the slot', () => {
  const held = [pos(44, 5000)];
  const p = plan({ account: account(1000, held), market: TEN_X, decision: ESCAPE, exposure: SLOTS });
  assert.strictEqual(p.target, 0);
  assert.strictEqual(p.order.side, 'sell');
  assert.ok(p.order.reduceOnly);
});

ok('a market that publishes no margin fraction falls back to the operator leverage, not Infinity', () => {
  const p = plan({ account: account(1000), market: MARKET, decision: LONG, exposure: SLOTS });
  assert.strictEqual(p.leverage, 10);
  assert.ok(Number.isFinite(p.target));
});

console.log(`\n${pass} passed`);
