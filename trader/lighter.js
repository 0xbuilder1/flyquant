/**
 * Lighter, read-only. Everything the fly can see, and nothing that can move money.
 *
 * Deliberately split from the signer: this module has no key, no POST and no side effect beyond a
 * file write, so the whole market-data path can be exercised, tested and left running with nothing
 * armed. Placing an order lives in trader/signer.py, which is the only thing in the repo that can
 * lose money, and it is a separate process for that reason.
 *
 * THE TWO QUANTITIES THE ARENA NEEDS, AND WHY EACH IS BOUNDED WITHOUT A CONSTANT
 *
 *   bright = the market's RANK by 24h quote volume, over 57                 -> [0,1]
 *   fall   = mark lost since the last snapshot / today's high-low range    -> [0,1]
 *
 * `fall` is scale-free on purpose. A tenth of a percent means something different on BTC than on
 * PONS, but "we just gave up a third of today's entire range" means the same thing on both, and it
 * needs no per-market calibration to say so. The alternative — a tuned threshold per market — is
 * exactly the sort of dial that becomes a trading parameter.
 *
 * THE WINDOW IS THE GAP BETWEEN PASSES. There is no historical endpoint for most of this, so the
 * previous snapshot on disk IS the history. With no previous snapshot nothing is falling, the fly
 * sees a still panorama, and that is reported rather than filled in.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HOST = 'https://api.rh.lighter.xyz';

async function get(pathname) {
  const res = await fetch(`${HOST}/api/v1/${pathname}`, {
    headers: { 'user-agent': 'flybrain/1.0' },
  });
  if (!res.ok) throw new Error(`lighter ${pathname}: HTTP ${res.status}`);
  return res.json();
}

/** every active perp market, with the fields the arena and the ledger need */
async function snapshot() {
  const [details, funding] = await Promise.all([
    get('orderBookDetails'),
    get('funding-rates').catch(() => null),     // funding is nice to have, never load-bearing
  ]);

  const fundingOf = new Map();
  for (const f of (funding && (funding.funding_rates || funding.fundingRates)) || []) {
    if (f.market_id != null) fundingOf.set(Number(f.market_id), Number(f.rate));
  }

  const markets = [];
  for (const m of details.order_book_details || []) {
    if (m.status !== 'active') continue;
    const mark = Number(m.mark_price);
    if (!(mark > 0)) continue;
    markets.push({
      symbol: m.symbol,
      marketId: Number(m.market_id),
      mark,
      index: Number(m.index_price) || mark,
      volume: Number(m.daily_quote_token_volume) || 0,
      trades: Number(m.daily_trades_count) || 0,
      low: Number(m.daily_price_low) || mark,
      high: Number(m.daily_price_high) || mark,
      openInterest: Number(m.open_interest) || 0,
      funding: fundingOf.has(Number(m.market_id)) ? fundingOf.get(Number(m.market_id)) : null,
      // what the fly can actually be shown about size limits, carried so the trader never has to
      // guess and never has to hardcode
      minBase: Number(m.min_base_amount) || 0,
      minQuote: Number(m.min_quote_amount) || 0,
      sizeDecimals: Number(m.supported_size_decimals) || 0,
      priceDecimals: Number(m.supported_price_decimals) || 0,
      maintenanceMarginFraction: Number(m.maintenance_margin_fraction) || 0,
      minInitialMarginFraction: Number(m.min_initial_margin_fraction) || 0,
    });
  }
  if (!markets.length) throw new Error('lighter returned no active markets');
  return { at: Date.now(), markets };
}

/** turn a snapshot, plus the previous one, into what the arena shows the fly */
function toArena(now, prev) {
  const prevOf = new Map();
  for (const m of (prev && prev.markets) || []) prevOf.set(m.symbol, m);
  // Brightness is RANK, not ratio. BTC does 80x the volume of the median market, so vol/volMax
  // leaves fifty of the fifty-seven effectively invisible — a fly that cannot see most of its
  // universe is not trading a wide universe. Rank is bounded by construction, needs no constant,
  // and keeps the ordering while making the panorama actually visible.
  const byVolume = [...now.markets].sort((a, z) => a.volume - z.volume);
  const rankOf = new Map();
  byVolume.forEach((m, k) => rankOf.set(m.symbol, (k + 1) / byVolume.length));

  return now.markets.map((m) => {
    const was = prevOf.get(m.symbol);
    const range = Math.max(m.high - m.low, 0);
    let fall = 0;
    if (was && range > 0 && was.mark > m.mark) fall = Math.min(1, (was.mark - m.mark) / range);
    return {
      symbol: m.symbol,
      marketId: m.marketId,
      bright: rankOf.get(m.symbol) || 0,
      fall,
      mark: m.mark,
      moved: was ? (m.mark - was.mark) / was.mark : null,
      market: m,
    };
  });
}

function statePath(root) {
  return path.join(root || path.join(__dirname, '..', 'keeper', 'state'), 'lighter-snapshot.json');
}

function loadPrevious(root) {
  try { return JSON.parse(fs.readFileSync(statePath(root), 'utf8')); }
  catch { return null; }
}

function savePrevious(snap, root) {
  const p = statePath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(snap));
}

module.exports = { HOST, get, snapshot, toArena, loadPrevious, savePrevious, statePath };
