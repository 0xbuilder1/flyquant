/**
 * From what the fly wants to what the account should hold. The money arithmetic, and nothing else.
 *
 * This module is PURE — no network, no key, no clock. Everything it needs is passed in and
 * everything it returns is a plan. That is what makes it the one part of the trader with a test
 * that can prove it, and it is why the sizing lives here rather than inside the code that signs.
 *
 * THE FLY SETS A TARGET EXPOSURE. THE TRADER RECONCILES TO IT.
 *
 * The readout gives a fraction in [0,1] and a direction. That fraction times equity is the notional
 * the account SHOULD hold in the market the fly turned toward. What it actually holds is read from
 * Lighter. The difference is the order. Nothing else decides a size.
 *
 * Three things fall out of that and none of them needed a special case:
 *
 *   IT ADDS TO POSITIONS AS CAPITAL ARRIVES. Target is a fraction of equity, so a deposit — or a
 *   harvest landing, or an open position gaining — raises every target, and the next pass buys the
 *   difference. Growth compounds into size without a single line about deposits.
 *
 *   IT TRIMS WHEN CAPITAL LEAVES. Exactly the same subtraction with the sign reversed.
 *
 *   IT FLIPS. A short target against a long position is one order through zero, because a signed
 *   target minus a signed position is a signed delta.
 *
 * THE MINIMUM TRADE IS THE EXCHANGE'S OWN, NOT OURS. Lighter publishes min_quote_amount and
 * min_base_amount per market; a delta below either is not a small trade, it is a rejected one. No
 * threshold in this file was chosen by us, which also means trade frequency is a consequence of how
 * much capital is in the account rather than a dial we tuned to look busy.
 */
'use strict';

/**
 * What crossing would actually cost, in basis points from mid, by filling the order against the
 * real ladder.
 *
 * Walk the levels on the side being taken, accumulate size and cost until the order is filled, and
 * compare the volume-weighted average price to mid. That difference IS the cost — no model, no
 * assumption about how depth is distributed.
 *
 * Returns Infinity when the book cannot fill the order at all, which correctly makes it
 * unaffordable to cross and sends it to rest instead. Returns 0 with no ladder, so a market whose
 * book could not be read is not falsely accused of being expensive.
 */
function walkBook(depth, side, baseSize) {
  if (!depth || !depth.levels || !(baseSize > 0)) return 0;
  const levels = side === 'buy' ? depth.levels.ask : depth.levels.bid;
  if (!levels || !levels.length) return 0;
  const mid = depth.mid;
  if (!(mid > 0)) return 0;

  let filled = 0, cost = 0;
  for (const [price, size] of levels) {
    const take = Math.min(size, baseSize - filled);
    if (take <= 0) break;
    filled += take;
    cost += take * price;
    if (filled >= baseSize) break;
  }
  if (filled <= 0) return Infinity;
  // not enough book to fill it: crossing is not really on offer at any sensible price
  if (filled < baseSize * 0.999) return Infinity;

  const avg = cost / filled;
  const bps = ((avg / mid) - 1) * 10000;
  return side === 'buy' ? bps : -bps;          // both directions cost a POSITIVE number of bps
}

/** what the account currently holds in one market, signed. Long positive, short negative. */
function currentNotional(account, marketId) {
  const p = (account.positions || []).find((x) => x.marketId === marketId);
  return p ? p.notional : 0;
}

/**
 * decision + account + market -> an order, or a reason there is none.
 *
 * The policy numbers all live in config, and there are four: maxFraction (a position's ceiling as a
 * fraction of equity), slots and leverage (how the account is divided and how hard each slot is
 * levered), and maxTotalFraction (the sum). At maxFraction 1, slots 1 and leverage 1 the fly can
 * never hold more notional than the account is worth. Raising any of them is the operator taking
 * leverage on deliberately, and every one of them scales WITH equity rather than being a dollar
 * figure — an account that doubles simply takes positions twice the size, with nothing to change.
 */
function plan({ account, market, decision, chosen, exposure = {}, depth = null }) {
  // THE FLY SETS THE AMOUNT; THE OPERATOR SETS THE CEILING.
  //
  // maxFraction used to BE the size whenever conviction was total. It is now a bound the fly moves
  // inside: its own arousal-to-calm balance (octopamine against serotonin) says how much of the
  // allowance to take. A fully convinced but unaroused fly takes a small position; a fully convinced
  // and flooded one takes the whole allowance. Neither is a number anybody typed.
  const ceiling = exposure.maxFraction == null ? 1 : Number(exposure.maxFraction);
  const appetite = decision.mood && Number.isFinite(decision.mood.appetite) ? decision.mood.appetite : 1;
  const maxFraction = ceiling * appetite;
  const equity = Number(account.equity) || 0;
  const mark = Number(market.mark) || 0;
  const marketId = market.marketId;
  const held = currentNotional(account, marketId);

  const base = {
    symbol: market.symbol, marketId, mark, equity, held,
    action: decision.action, size: decision.size, maxFraction, ceiling, appetite,
  };

  if (!(equity > 0)) return { ...base, order: null, reason: 'the account has no equity' };
  if (!(mark > 0)) return { ...base, order: null, reason: 'no mark for this market' };

  let target;
  if (decision.action === 'escape') target = 0;
  else if (decision.action === 'long') target = +decision.size * equity * maxFraction;
  else if (decision.action === 'short') target = -decision.size * equity * maxFraction;
  else return { ...base, target: held, order: null, reason: 'the fly is holding' };

  // ── THE MARGIN SLOT ─────────────────────────────────────────────────────────────────────────
  //
  // The account is meant to carry `slots` positions at once, so each one is allowed ONE SLOT'S WORTH
  // OF MARGIN — equity/slots — and its notional is that margin times the leverage the market will
  // actually give it. At 10 slots and 10x that is a full equity's notional per position and ten
  // positions before the account is committed, which is the point of it.
  //
  // MARGIN, NOT NOTIONAL, IS WHAT DIVIDES EVENLY. Nine of the 57 markets refuse 10x: PONS, CASHCAT,
  // AI and ANSEM cap at 3x, six more at 5x. Budgeting a fixed NOTIONAL per slot would silently
  // demand three slots' margin for a PONS position and the tenth order would simply be rejected by
  // the exchange with the account apparently under its cap. Budgeting margin instead means a 3x
  // market gets 0.3x equity of notional off the same slot and ten positions always fit.
  //
  // The leverage ceiling is the EXCHANGE'S OWN, read from the market: minInitialMarginFraction is in
  // hundredths of a percent, so 1000 is 10% initial margin and therefore 10x. Nothing here is a
  // number chosen to improve returns; it is the exchange's limit and the operator's slot count.
  // slots UNSET means the operator has not divided the account, so there is no count to enforce and
  // one position may be the whole allowance — the behaviour before slots existed, preserved exactly.
  const slotsDeclared = exposure.slots != null;
  const slots = slotsDeclared ? Math.max(1, Number(exposure.slots)) : 1;
  const wanted = exposure.leverage == null ? 1 : Number(exposure.leverage);
  const imf = Number(market.minInitialMarginFraction) || 0;
  const marketMaxLeverage = imf > 0 ? 10000 / imf : wanted;
  const leverage = Math.max(1, Math.min(wanted, marketMaxLeverage));
  const slotMargin = equity / slots;
  const slotNotional = slotMargin * leverage;
  let slotCapped = false;
  if (Math.abs(target) > slotNotional) { target = Math.sign(target) * slotNotional; slotCapped = true; }

  // ── THERE ARE ONLY `slots` SLOTS ────────────────────────────────────────────────────────────
  //
  // Sizing each position at one slot's margin bounds how BIG each one is and says nothing at all
  // about HOW MANY there are. trader/simulate.js caught this immediately: twelve decisions opened
  // twelve positions on a ten-slot account and put 91% of the balance into margin, and the
  // thirteenth would simply have been rejected by the exchange with the account apparently inside
  // every cap it knew about.
  //
  // So a market the account is not already in needs a free slot. With each slot bounded at
  // equity/slots of margin and at most `slots` of them open, total margin can never exceed the
  // account — by construction rather than by a limit that happens to bind.
  //
  // A FULL BOOK REFUSES RATHER THAN EVICTING. Choosing which existing position to close in order to
  // make room would be the keeper overriding the fly about what to hold, which is exactly the
  // decision this product gives to the animal. It does not deadlock: staleAfterMinutes closes
  // positions the fly has stopped facing, so slots free themselves.
  //
  // ADDING TO A POSITION THE ACCOUNT ALREADY HAS IS ALWAYS ALLOWED, and so is reducing one. This
  // bounds how many markets are held, never what may be done in a market already held.
  const openCount = (account.positions || []).filter((p) => Math.abs(p.notional) > 0).length;
  if (slotsDeclared && held === 0 && target !== 0 && openCount >= slots) {
    return { ...base, target: 0, order: null, slots, openCount,
             reason: `all ${slots} slots are full — nothing is held in ${market.symbol} and there is no room to open one` };
  }

  // ── THE AGGREGATE CAP ───────────────────────────────────────────────────────────────────────
  // maxFraction is PER MARKET. The fly picks a different market most passes and never revisits the
  // old one, so without this the account ends up holding a quarter of itself in each of a dozen
  // markets — measured at 1.96x equity over a simulated day, which is leverage nobody asked for and
  // the exact shape of an unnoticed blow-up. The cap is on the SUM, and the new target is scaled
  // down to fit rather than refused, because refusing would leave the fly unable to act at all once
  // it was full.
  const maxTotal = exposure.maxTotalFraction == null ? 1 : Number(exposure.maxTotalFraction);
  const otherExposure = (account.positions || [])
    .filter((p) => p.marketId !== marketId)
    .reduce((s, p) => s + Math.abs(p.notional), 0);
  const room = Math.max(0, equity * maxTotal - otherExposure);
  let capped = false;
  if (Math.abs(target) > room) { target = Math.sign(target) * room; capped = true; }

  // ── THE DEPTH CAP ───────────────────────────────────────────────────────────────────────────
  // The bound that only exists once the account is large. A 25% position on $100,000 is $25,000 —
  // 4% of BTC's book and 147% of PONS's, which eats the entire visible book. ANSEM is 2,271% and
  // CASHCAT 5,749%. Equity says nothing about whether a market can absorb the order.
  //
  // Capped against the THINNER SIDE, because escape dumps the whole position in one order and a
  // size you can enter but cannot leave is a trap. Read live in the same pass: a cap from stale
  // depth bounds nothing, and too large is the direction that stays silent until after the fill.
  //
  // AN EXIT IS NEVER CAPPED. If the fly is already too big for the book, refusing to shrink it
  // because the book is thin would trap it in exactly the position the cap exists to prevent. The
  // cap bounds what may be OPENED; it never bounds what may be closed.
  let depthCapped = false;
  const depthFraction = exposure.depthFraction == null ? 0.25 : Number(exposure.depthFraction);
  const usable = depth && depth.min > 0 && decision.action !== 'escape' ? depth.min * depthFraction : null;
  if (usable != null && Math.abs(target) > usable) {
    target = Math.sign(target) * usable;
    depthCapped = true;
  }

  const delta = target - held;
  const minQuote = Number(market.minQuote) || 0;
  const minBase = Number(market.minBase) || 0;
  const sizeBase = Math.abs(delta) / mark;

  // ── CROSS UNLESS CROSSING IS EXPENSIVE ──────────────────────────────────────────────────────
  //
  // Lighter charges zero maker AND zero taker fee, so crossing costs exactly one thing: the spread
  // it walks through. On a tight, deep market that is a fraction of a basis point, and paying it
  // buys certainty — the fly's decision actually HAPPENS instead of resting in a queue hoping the
  // market comes back to it. The first live order proved that cost is real: it rested at the touch,
  // was accepted, and simply did not fill.
  //
  // So the cost is measured by WALKING THE BOOK, not approximated:
  //
  //     fill the order level by level, take the volume-weighted average price it would actually
  //     get, and the distance from mid to that average IS the cost of crossing.
  //
  // The first version of this used `(notional / depth) * band_bps`, which is linear and therefore
  // the wrong SHAPE. Real books are not evenly dense: an order that fits inside the touch costs
  // nothing at all, while one that walks five levels costs much more than its share of the band.
  // The ladder is already fetched every pass, so there is no reason to model what can be measured.
  //
  // takerMaxBps is the OPERATOR's line and lives in config beside the other numbers that are policy
  // rather than measurement. Above it the order rests post-only and accepts that it may not fill.
  const isExit = target === 0;
  const canRest = !isExit && !!(depth && depth.best);
  const side = delta > 0 ? 'buy' : 'sell';
  const crossCostBps = walkBook(depth, side, Math.abs(delta) / mark);
  const takerMaxBps = exposure.takerMaxBps == null ? 6 : Number(exposure.takerMaxBps);
  // an exit always crosses; otherwise cross while it is cheap, rest when it is not
  const maker = canRest && crossCostBps > takerMaxBps;

  const out = { ...base, target, delta, sizeBase, capped, depthCapped, maker, room, otherExposure,
              leverage, marketMaxLeverage, slots, slotMargin, slotNotional, slotCapped,
              crossCostBps: Math.round(crossCostBps * 100) / 100, takerMaxBps,
              depth: depth ? { min: depth.min, bid: depth.bid, ask: depth.ask, spreadBps: depth.spreadBps } : null };

  if (delta === 0) return { ...out, order: null, reason: 'already at target' };
  if (Math.abs(delta) < minQuote) {
    return { ...out, order: null, reason: `delta $${Math.abs(delta).toFixed(2)} is under the market minimum $${minQuote}` };
  }

  // ── THE DEADBAND ────────────────────────────────────────────────────────────────────────────
  // Conviction swings 44%-100% pass to pass on the same market, and re-targeting every swing turned
  // over 133x the account in a simulated day — $331/day of slippage on $5,000, which bleeds the
  // account out regardless of whether the fly is right. The exchange's $10 minimum is a floor for a
  // $10 account and nothing at all for a real one, so the deadband is a fraction of EQUITY and
  // scales with it. Closing a position is exempt: getting out is never something to defer.
  //
  // ONLY A FULL EXIT IS EXEMPT. The first version exempted any reduction — `|target| < |held|` —
  // which sounded like prudence and was actually a hole: conviction drifting 1.0 to 0.95 is a
  // reduction, so every downward wobble traded anyway and half the churn walked straight through
  // the band. A 2% trim is churn whichever direction it points. Getting out completely is not.
  //
  // AND IT ONLY APPLIES TO ORDERS THAT CROSS. The deadband exists to stop the fly paying the spread
  // over and over on noise. A post-only order does not pay the spread — it is PAID the spread — so
  // there is nothing to protect it from, and blocking it would be the keeper overriding the fly for
  // no benefit at all. Oscillation on resting orders is not churn; buying at the bid and selling at
  // the ask is the market maker's whole business. So a maker order goes through at any size the
  // exchange will accept, and the fly gets its full resolution back.
  const deadband = (exposure.deadbandFraction == null ? 0.02 : Number(exposure.deadbandFraction)) * equity;
  const closing = target === 0;
  if (!maker && !closing && Math.abs(delta) < deadband) {
    return { ...out, order: null,
      reason: `delta $${Math.abs(delta).toFixed(2)} is inside the $${deadband.toFixed(2)} deadband` };
  }
  if (sizeBase < minBase) {
    return { ...out, order: null, reason: `size ${sizeBase.toFixed(4)} is under the market minimum ${minBase}` };
  }

  // Round the base size DOWN to the market's own precision. Rounding up could put the order above
  // the target, and a size that overshoots on every pass ratchets exposure up over time.
  const step = Math.pow(10, -(Number(market.sizeDecimals) || 0));
  const rounded = Math.floor(sizeBase / step) * step;
  if (!(rounded >= minBase)) {
    return { ...out, order: null, reason: `size rounds to ${rounded} at this market's precision, under its ${minBase} minimum` };
  }

  // WHEN IT DOES REST, it rests at the touch on its own side: a buy joins the bid, a sell joins the
  // ask. Never inside the touch — that is a worse price for us and buys nothing but queue position.
  //
  // AND THE FLY CHOOSES HOW HARD TO ASK. A calm (serotonergic) fly rests BEHIND the touch: a better
  // price, and a smaller chance of being filled at all. An aroused one sits right at it and takes
  // what is there. The unit is the spread itself, so there is no constant here either — patience 0
  // is the touch, patience 1 is one full spread behind it.
  const patience = decision.mood && Number.isFinite(decision.mood.patience) ? decision.mood.patience : 0;
  const spread = maker ? Math.max(depth.best.ask - depth.best.bid, 0) : 0;
  const px = Number(market.priceDecimals) || 6;
  const limitPrice = maker
    ? Number((side === 'buy'
        ? depth.best.bid - patience * spread
        : depth.best.ask + patience * spread).toFixed(px))
    : null;

  return {
    ...out,
    maker,
    order: {
      marketId,
      symbol: market.symbol,
      side,
      isAsk: delta < 0,
      sizeBase: Number(rounded.toFixed(Number(market.sizeDecimals) || 0)),
      notional: Math.abs(delta),
      mark,
      // how it goes to the exchange: a resting post-only limit, or a crossing market order
      execution: maker ? 'post-only' : 'market',
      limitPrice,
      patience,
      spreadBps: depth ? depth.spreadBps : null,
      // closing toward zero never increases risk, and marking it lets the exchange refuse anything
      // that would accidentally open the other side
      reduceOnly: Math.abs(target) < Math.abs(held) && Math.sign(target || held) === Math.sign(held),
      why: decision.why,
    },
    reason: null,
  };
}

/**
 * Positions the fly has stopped looking at.
 *
 * THE FLY ONLY MANAGES WHAT IT IS FACING. It turns toward one market a pass and sets a target there;
 * every other position simply stays, forever, with no exit — escape closes the market in front of it
 * and nothing else. Over a day that silently accumulated eleven open markets in simulation. So a
 * position nobody has looked at for `staleAfterMs` is closed.
 *
 * This is an operator risk rule and it is not dressed up as biology. It exists because the decision
 * mechanism is single-target and the book is not.
 */
function stale({ account, lastSeen = {}, now = Date.now(), staleAfterMs }) {
  if (!staleAfterMs) return [];
  return (account.positions || [])
    .map((p) => ({
      ...p,
      neverSeen: !lastSeen[p.symbol],
      // a position the fly has NEVER faced is maximally stale, which is right, but dating it from
      // the epoch reports an age in the tens of millions of minutes
      ageMs: lastSeen[p.symbol] ? now - lastSeen[p.symbol] : Infinity,
    }))
    .filter((p) => p.ageMs >= staleAfterMs)
    .sort((a, z) => z.ageMs - a.ageMs);
}

/** what the whole book looks like, for the ledger and the page */
function book(account) {
  const positions = account.positions || [];
  return {
    equity: account.equity,
    collateral: account.collateral,
    available: account.available,
    unrealized: account.unrealized,
    exposure: account.exposure,
    utilisation: account.equity > 0 ? account.exposure / account.equity : 0,
    count: positions.length,
    positions: positions.map((p) => ({
      symbol: p.symbol, marketId: p.marketId,
      side: p.sign > 0 ? 'long' : 'short',
      size: p.size, entry: p.entry, notional: p.notional,
      unrealized: p.unrealized, liquidation: p.liquidation, funding: p.funding,
    })),
  };
}

module.exports = { plan, book, stale, currentNotional };
