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

/** what the account currently holds in one market, signed. Long positive, short negative. */
function currentNotional(account, marketId) {
  const p = (account.positions || []).find((x) => x.marketId === marketId);
  return p ? p.notional : 0;
}

/**
 * decision + account + market -> an order, or a reason there is none.
 *
 * exposure.maxFraction is the only policy number, it lives in config, and at its default of 1 the
 * fly can never hold more notional than the account is worth — no leverage, whatever the exchange
 * would allow. Raising it is the operator taking leverage on deliberately.
 */
function plan({ account, market, decision, chosen, exposure = {}, depth = null }) {
  const maxFraction = exposure.maxFraction == null ? 1 : Number(exposure.maxFraction);
  const equity = Number(account.equity) || 0;
  const mark = Number(market.mark) || 0;
  const marketId = market.marketId;
  const held = currentNotional(account, marketId);

  const base = {
    symbol: market.symbol, marketId, mark, equity, held,
    action: decision.action, size: decision.size, maxFraction,
  };

  if (!(equity > 0)) return { ...base, order: null, reason: 'the account has no equity' };
  if (!(mark > 0)) return { ...base, order: null, reason: 'no mark for this market' };

  let target;
  if (decision.action === 'escape') target = 0;
  else if (decision.action === 'long') target = +decision.size * equity * maxFraction;
  else if (decision.action === 'short') target = -decision.size * equity * maxFraction;
  else return { ...base, target: held, order: null, reason: 'the fly is holding' };

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

  const out = { ...base, target, delta, sizeBase, capped, depthCapped, room, otherExposure,
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
  const deadband = (exposure.deadbandFraction == null ? 0.02 : Number(exposure.deadbandFraction)) * equity;
  const closing = target === 0;
  if (!closing && Math.abs(delta) < deadband) {
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

  return {
    ...out,
    order: {
      marketId,
      symbol: market.symbol,
      side: delta > 0 ? 'buy' : 'sell',
      isAsk: delta < 0,
      sizeBase: Number(rounded.toFixed(Number(market.sizeDecimals) || 0)),
      notional: Math.abs(delta),
      mark,
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
