/**
 * @pons/sink-shortdesk — the mark, and the size the mark can carry.
 *
 * A short has to be priced against something, and the one thing on this chain that cannot be
 * argued with is the pool the token actually trades in. Every mark here is Uniswap V4's own
 * `slot0.sqrtPriceX96`, read out of the PoolManager with `extsload`. There is no oracle, no price
 * feed and no off-chain quote anywhere in this file — which is also why a market quoted in another
 * memecoin is refused rather than converted: converting would mean inventing a rate, and an
 * invented rate IS a price feed however it is spelled.
 *
 * THE MATH IS INTEGER, ALL OF IT. A mark is carried as X18 (wei of quote per whole token) and never
 * as a JavaScript number, because a float in the money path is a rounding error that compounds over
 * every position and settles into somebody's payout. Floats appear exactly once, in fmtMark(), and
 * that is for printing.
 *
 * This module NEVER constructs a chain client — assertSink() reads its source and would refuse it.
 * The reader is handed in from ctx.clients.source, which is what makes the fake-chain suite able to
 * intercept every network call in here.
 */
'use strict';

const Q96 = 2n ** 96n;
const E18 = 10n ** 18n;

/* Uniswap V4 keeps `mapping(PoolId => Pool.State) _pools` at storage slot 6, and `liquidity` sits
   three words into that struct. The slot for a given pool is keccak256(abi.encode(poolId, 6)) — it
   is precomputed per market in the config rather than derived here, so this file needs no hashing
   and the operator can check each one against a block explorer by eye. */
const EXTSLOAD = '0x1e2eaeaf';
const LIQ_OFFSET = 3n;

function slotPlus(slot, n) {
  return '0x' + (BigInt(slot) + n).toString(16).padStart(64, '0');
}

/** integer sqrt, Newton's method — used to price a move without ever touching Math.sqrt */
function isqrt(n) {
  if (n < 0n) throw new Error('isqrt of a negative');
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

/**
 * price of one whole token, in wei of the quote asset.
 *
 * Uniswap's sqrtPriceX96 encodes currency1-per-currency0 in RAW units. Which side is the tradeable
 * token decides whether we invert, and the decimals of the two sides decide the scaling — get
 * either wrong and the mark is off by orders of magnitude while still looking like a plausible
 * number, which is the failure mode worth being loud about.
 */
function markX18(sqrtPriceX96, m) {
  const sp = BigInt(sqrtPriceX96);
  if (sp <= 0n) throw new Error(`${m.sym}: pool reports sqrtPriceX96 = 0, so it has never been initialised`);
  const d0 = BigInt(m.decimals0 == null ? 18 : m.decimals0);
  const d1 = BigInt(m.decimals1 == null ? 18 : m.decimals1);

  if (m.base === 1) {
    // token is currency1, quote is currency0: price = (Q96/sqrtP)^2, scaled by 10^d1 / 10^d0
    return (Q96 * Q96 * E18 * 10n ** d1) / (sp * sp * 10n ** d0);
  }
  // token is currency0, quote is currency1: price = (sqrtP/Q96)^2
  return (sp * sp * E18 * 10n ** d0) / (Q96 * Q96 * 10n ** d1);
}

/** which side of the pair is the quote, and how many decimals it carries */
function quoteDecimals(m) {
  const d = m.base === 1 ? m.decimals0 : m.decimals1;
  return BigInt(d == null ? 18 : d);
}

/**
 * quote-side depth of the pool at the current mark, NORMALISED TO 18 DECIMALS.
 *
 * L / sqrt(P) is the currency0 side; L * sqrt(P) is the currency1 side. Whichever of those is the
 * QUOTE is the number a position can be sized against, because it is the side a seller pushing the
 * price around has to move through.
 *
 * It comes back scaled to 18 decimals rather than in the quote token's own units, because USDG has
 * six and everything else here has eighteen — and a depth in native units printed through an
 * 18-decimal formatter reported a million dollars of liquidity as 0.0000011. Every figure the desk
 * carries is 18-decimal from here on, and toQuoteRaw() below is the ONLY place it converts back.
 */
function depthRaw(sqrtPriceX96, liquidity, m) {
  const sp = BigInt(sqrtPriceX96), L = BigInt(liquidity);
  if (sp <= 0n || L <= 0n) return 0n;
  const native = m.base === 1 ? (L * Q96) / sp : (L * sp) / Q96;
  return native * 10n ** (18n - quoteDecimals(m));
}

/**
 * 18-decimal amount back into the quote token's own units, for an actual transfer.
 * This is the one conversion point in the whole desk; everything upstream of it is X18.
 */
function toQuoteRaw(x18, m) {
  return BigInt(x18) / 10n ** (18n - quoteDecimals(m));
}

/**
 * THE CAP, and it is derived rather than chosen.
 *
 * Moving a constant-product mark down by 10% takes a known slice of the pool's depth going through
 * it, and whoever pushes it eats the pool's fee plus roughly half the slippage on the whole slice.
 * A stake is safe to write only while a 10% move pays the holder LESS than causing that move costs
 * them. Everything below is bps integer math:
 *
 *   push = depth × (1 − 1/√(1/0.9))        ≈ 5.13% of depth
 *   cost = push × (poolFee + halfSlippage)  halfSlippage = 500 bps
 *   cap  = cost ÷ 10%                       so 0.10 × cap == cost
 *
 * A sink that let an operator type this number in by hand would eventually have one typed in wrong,
 * and the wrong direction is silent: too large a cap only shows up as a loss after somebody has
 * already taken it.
 */
const MOVE_BPS = 1000n;          // the 10% move the cap is solved against
const HALF_SLIP_BPS = 500n;      // the pusher eats about half of that move on the way through
const BPS = 10000n;

function capRaw(depth, poolFeeBps) {
  if (depth <= 0n) return 0n;
  /* push fraction = 1 − 1/√(1/0.9) = 1 − √0.9, in bps.
     √0.9 in bps is isqrt(0.9 × BPS × BPS) = isqrt(9000 × 10000) = 9486. Dividing by BPS after the
     root instead of scaling before it truncates 9486 to 94 and hands back a cap nineteen times too
     large — and too large is the silent direction, because it only shows up as a loss after
     somebody has already taken the position. */
  const sqrt09 = isqrt((BPS - MOVE_BPS) * BPS);               // √0.9 in bps ≈ 9486
  const pushBps = BPS - sqrt09;
  const push = (depth * pushBps) / BPS;
  const cost = (push * (BigInt(poolFeeBps) + HALF_SLIP_BPS)) / BPS;
  return (cost * BPS) / MOVE_BPS;
}

/**
 * read one market's live state. `read` is a function the sink hands in, wrapping ctx.clients.source
 * — this module is deliberately incapable of reaching the network on its own.
 */
async function readMarket(read, m) {
  const s0 = await read(m.slot0);
  const lq = await read(slotPlus(m.slot0, LIQ_OFFSET));
  if (!s0 || s0 === '0x') throw new Error(`${m.sym}: PoolManager returned nothing for slot0`);
  const raw = BigInt(s0);
  const sqrtP = raw & ((1n << 160n) - 1n);
  let tick = (raw >> 160n) & 0xffffffn;
  if (tick >= 0x800000n) tick -= 0x1000000n;
  const lpFeePips = Number((raw >> 208n) & 0xffffffn);
  const liquidity = lq && lq !== '0x' ? BigInt(lq) & ((1n << 128n) - 1n) : 0n;

  const mark = markX18(sqrtP, m);
  const depth = depthRaw(sqrtP, liquidity, m);
  /* V4 fees are in pips (1e6 = 100%); the cap math wants bps. TRUNCATE, do not round: the
     contract does integer division and the contract is what actually gates an open. Rounding
     here made the keeper quote a cap 0.18% above the one the chain would accept, so the site
     would have offered a stake the desk then refused. */
  const poolFeeBps = Math.floor(lpFeePips / 100);
  return {
    sym: m.sym, quote: m.quote, cfg: m,
    sqrtPriceX96: sqrtP, tick, liquidity,
    quoteDecimals: Number(quoteDecimals(m)),
    markX18: mark, depthRaw: depth,          // both 18-decimal
    poolFeeBps, capRaw: capRaw(depth, poolFeeBps),
  };
}

/** printing only — the one place a float is allowed, and it never feeds a payout */
function fmtMark(x18, places) {
  const n = Number(x18) / 1e18;
  if (!isFinite(n) || n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toFixed(places == null ? 6 : places);
  return n.toPrecision(places == null ? 6 : places);
}

module.exports = {
  Q96, E18, EXTSLOAD, slotPlus, isqrt,
  markX18, depthRaw, capRaw, quoteDecimals, toQuoteRaw, readMarket, fmtMark,
};
