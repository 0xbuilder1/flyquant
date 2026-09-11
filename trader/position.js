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
function plan({ account, market, decision, chosen, exposure = {} }) {
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

  const delta = target - held;
  const minQuote = Number(market.minQuote) || 0;
  const minBase = Number(market.minBase) || 0;
  const sizeBase = Math.abs(delta) / mark;

  const out = { ...base, target, delta, sizeBase };

  if (delta === 0) return { ...out, order: null, reason: 'already at target' };
  if (Math.abs(delta) < minQuote) {
    return { ...out, order: null, reason: `delta $${Math.abs(delta).toFixed(2)} is under the market minimum $${minQuote}` };
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

module.exports = { plan, book, currentNotional };
