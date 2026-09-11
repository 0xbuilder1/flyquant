/**
 * The fly's Lighter account, read only.
 *
 * Every endpoint here is PUBLIC and unauthenticated — an account's collateral and positions are
 * readable by index by anyone, and so are the fills. That is deliberate and it is the whole basis of
 * the site's claim: the page does not ask you to believe a number the keeper published, it gives you
 * the URL that proves it. No API key is used in this file and none is needed.
 *
 *   account?by=index&value=N   collateral, positions, margin requirements
 *   recentTrades?market_id=N   fills, each with a tx_hash
 *   tx?by=hash&value=H         that fill's transaction, with the account and market on it
 *
 * EQUITY IS total_asset_value, NOT collateral. Collateral is what was deposited; asset value is what
 * it is worth now, with open positions marked. Sizing off collateral would keep sizing off a number
 * that stopped being true the moment the first position moved.
 */
'use strict';

const HOST = 'https://api.rh.lighter.xyz';

async function get(pathname) {
  const res = await fetch(`${HOST}/api/v1/${pathname}`, { headers: { 'user-agent': 'flybrain/1.0' } });
  if (!res.ok) throw new Error(`lighter ${pathname.split('?')[0]}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.code && j.code !== 200 && j.code !== 0) throw new Error(`lighter ${pathname.split('?')[0]}: ${j.message || j.code}`);
  return j;
}

/** the URL anybody can open to check a fill, or the account itself */
const verifyTx = (hash) => `${HOST}/api/v1/tx?by=hash&value=${hash}`;
const verifyAccount = (index) => `${HOST}/api/v1/account?by=index&value=${index}`;

/**
 * Account state as the trader needs it.
 *
 * Returns equity, free collateral, and one row per OPEN position with its signed notional — signed
 * because a short is a negative exposure and every piece of arithmetic downstream is a subtraction.
 */
async function read(index) {
  const j = await get(`account?by=index&value=${index}`);
  const a = (j.accounts || [])[0];
  if (!a) throw new Error(`no lighter account at index ${index}`);

  const positions = (a.positions || [])
    .filter((p) => Number(p.position) !== 0)
    .map((p) => ({
      marketId: Number(p.market_id),
      symbol: p.symbol,
      sign: Number(p.sign),                         // +1 long, -1 short
      size: Number(p.position),
      entry: Number(p.avg_entry_price),
      notional: Number(p.sign) * Number(p.position_value),
      unrealized: Number(p.unrealized_pnl),
      realized: Number(p.realized_pnl),
      liquidation: Number(p.liquidation_price),
      funding: Number(p.total_funding_paid_out),
      initialMarginFraction: Number(p.initial_margin_fraction),
    }));

  return {
    index: Number(a.account_index != null ? a.account_index : a.index),
    l1: a.l1_address,
    collateral: Number(a.collateral),
    available: Number(a.available_balance),
    equity: Number(a.total_asset_value),
    maintenanceRequirement: Number(a.cross_maintenance_margin_requirement || 0),
    initialRequirement: Number(a.cross_initial_margin_requirement || 0),
    positions,
    unrealized: positions.reduce((s, p) => s + p.unrealized, 0),
    exposure: positions.reduce((s, p) => s + Math.abs(p.notional), 0),
    verify: verifyAccount(index),
  };
}

/**
 * Our own fills on a market, newest first.
 *
 * recentTrades is the whole book's tape, so we filter to the trades this account was a side of.
 * Every row keeps its tx_hash, which is what the feed links to.
 */
async function fills(accountIndex, marketId, limit = 50) {
  const j = await get(`recentTrades?market_id=${marketId}&limit=${limit}`);
  const mine = [];
  for (const t of j.trades || []) {
    const isAsk = Number(t.ask_account_id) === Number(accountIndex);
    const isBid = Number(t.bid_account_id) === Number(accountIndex);
    if (!isAsk && !isBid) continue;
    mine.push({
      tradeId: t.trade_id_str || String(t.trade_id),
      txHash: t.tx_hash,
      verify: verifyTx(t.tx_hash),
      marketId: Number(t.market_id),
      side: isBid ? 'buy' : 'sell',
      size: Number(t.size),
      price: Number(t.price),
      usd: Number(t.usd_amount),
      at: Number(t.timestamp),
      block: Number(t.block_height),
    });
  }
  return mine;
}

module.exports = { HOST, get, read, fills, verifyTx, verifyAccount };
