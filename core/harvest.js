/**
 * @pons/core — money IN. Identical whatever the sink does with it afterwards.
 *
 * "Never pay out anything the market did not earn" is the first rule of every one of these projects,
 * and until harvest.json existed it was enforced only by convention: the pot was simply whatever
 * native balance sat in the keeper, so gas float — or the operator's own money — would have gone out
 * as if it were fees. harvest.json makes it arithmetic instead of a promise. Only what the escrow
 * actually paid can ever reach a sink.
 */
'use strict';

const path = require('path');
const { formatEther } = require('viem');
const cfg = require('./config.js').current();
const { DRY } = require('./config.js');
const { lc, log, fq, qSym, quoteIsNative, outDir } = require('./fmt.js');
const { readLedgerJson, writeJson } = require('./io.js');
const { source: pc } = require('./chain.js');
const { curveAbi, escrowAbi } = require('./abis.js');
const { launchedTokenInfo } = require('./watch.js');

let lastClaim = 0;
let lastRecipientCheck = 0;
let feesRedirected = false;
let decl = null;

/** the sink's declaration, bound once at composition — see sink.js for why this is not config */
function bind(d) { decl = d; }

/**
 * The address the escrow is SUPPOSED to be paying, which is not always this keeper.
 *
 * Every sink until the short desk wanted the fees in the keeper's own wallet, and for those this
 * returns exactly what it always did. A sink that declares an address wants them somewhere else —
 * and the difference between "the fees go to a contract we chose" and "somebody moved our fee
 * stream" is the whole point of the check below, so it has to be able to tell them apart.
 */
function expectedRecipient(addr) {
  const d = decl && decl.feeRecipient;
  const want = typeof d === 'function' ? d() : d;
  return want || addr;
}
/** true when the fees are payable somewhere this keeper cannot claim from */
function payableElsewhere(addr) {
  return lc(expectedRecipient(addr)) !== lc(addr);
}

function harvestFile() { return path.join(outDir(), 'harvest.json'); }
function readHarvest() { return readLedgerJson(harvestFile(), {}); }
function redirected() { return feesRedirected; }

/**
 * meta is optional and carries the claim's own receipt: the hash a batch will cite, and the gas it
 * burned. The gas matters because it comes out of the same balance the sink spends — leave it out of
 * the ledger and the sink's own equality (claimed + float == out + gas + residual) cannot close. A
 * 1-arg call is unchanged.
 */
function recordClaim(amount, meta) {
  if (amount <= 0n) return;
  const h = readLedgerJson(harvestFile(), { claimedTotal: '0', claims: 0 });
  h.claimedTotal = (BigInt(h.claimedTotal || '0') + amount).toString();
  h.claims = (h.claims || 0) + 1;
  if (meta) {
    h.gasRaw = (BigInt(h.gasRaw || '0') + BigInt(meta.gasRaw || 0)).toString();
    h.pendingClaims = (h.pendingClaims || []).concat([{
      hash: meta.hash, block: meta.block, amountRaw: amount.toString(), at: new Date().toISOString(),
    }]).slice(-500);
  }
  h.updatedAt = new Date().toISOString();
  writeJson(harvestFile(), h);
}

/**
 * Gas the keeper burned on a transaction that is NOT a claim — the curve sweep, a reverted claim,
 * a claim whose receipt we only found afterwards. It comes out of the same balance the sink spends,
 * so leaving it out breaks the sink's equality in the halting direction: residual drops, nothing
 * else moves, and the next batch refuses to open forever. Every wei of gas that leaves this wallet
 * lands in harvest.json, whatever the transaction was for.
 */
async function recordGas(rc, s, what) {
  if (!rc || !BigInt(rc.gasUsed || 0n)) return 0n;
  const gasUsed = BigInt(rc.gasUsed);
  /* 4663's receipt shape is UNVERIFIED, which is exactly why the charity sink's finaliseSweep has a
     three-tier ladder for the same number — and this function had one tier. A receipt with no
     effectiveGasPrice made `spent` zero and the early return threw the figure away silently: the wei
     still left the wallet, so claimed + float - (out + gas + residual) reads positive by it, the
     sink halts on "the three-bucket audit does not close", and resolving a batch explicitly refuses
     to touch gasRaw. No batch would ever run again. So the transaction is asked, and the last tier is
     the FEE CAP — overstating gas can only make the delta negative, which reports and blocks nothing,
     while understating it is the direction that halts the keeper forever. */
  let spent = gasUsed * BigInt(rc.effectiveGasPrice || 0n);
  let src = 'receipt';
  if (spent <= 0n && rc.transactionHash) {
    const tx = await Promise.resolve()
      .then(() => pc.getTransaction({ hash: rc.transactionHash })).catch(() => null);
    if (tx) {
      const price = tx.effectiveGasPrice != null ? tx.effectiveGasPrice
        : tx.gasPrice != null ? tx.gasPrice
          : tx.maxFeePerGas != null ? tx.maxFeePerGas : null;
      if (price != null) {
        spent = gasUsed * BigInt(price);
        src = tx.effectiveGasPrice != null || tx.gasPrice != null ? 'transaction' : 'fee cap (unverified, deliberately high)';
      }
    }
  }
  if (spent <= 0n) {
    if (s) {
      log(s, `!! ${what} mined and burned gas this node will not price (${rc.transactionHash || 'no hash'}).`);
      log(s, '   it is NOT in harvest.json, so the three-bucket audit will read short by it and the next batch will refuse to open.');
    }
    return 0n;
  }
  const h = readLedgerJson(harvestFile(), { claimedTotal: '0', claims: 0 });
  h.gasRaw = (BigInt(h.gasRaw || '0') + spent).toString();
  h.updatedAt = new Date().toISOString();
  writeJson(harvestFile(), h);
  if (s) log(s, `gas ${formatEther(spent)} ETH recorded for ${what}${src === 'receipt' ? '' : ` (from the ${src})`}`);
  return spent;
}

/**
 * The fee recipient can be moved out from under us at any time by whoever currently holds it
 * (factory.transferCreatorFeeRecipient). If that happens the escrow pays somebody else, balanceOf
 * reads zero forever, and NOTHING else in the keeper looks wrong — so it is checked on the claim
 * cadence and hard-blocks the harvest rather than warning once at launch.
 */
async function feeRecipientOk(addr, s) {
  const gap = (cfg.loop && cfg.loop.claimIntervalMs) || 60000;
  if (Date.now() - lastRecipientCheck < gap) return !feesRedirected;
  lastRecipientCheck = Date.now();
  const info = await launchedTokenInfo(cfg.token.token).catch(() => null);
  if (!info) return !feesRedirected;                       // unreadable factory: leave the last verdict standing
  const want = expectedRecipient(addr);
  feesRedirected = lc(info.feeRecipient) !== lc(want);
  if (feesRedirected) {
    log(s, `!! creatorFeeRecipient is ${info.feeRecipient}, NOT ${lc(want) === lc(addr) ? 'this keeper' : want} — fees are being paid to somebody else.`);
    log(s, '   harvest blocked. Fix it from the current recipient: factory.transferCreatorFeeRecipient(token, recipient).');
  }
  return !feesRedirected;
}

/**
 * What a transaction actually moved, when the transaction does not carry the figure.
 *
 * Read the balance before, read it after, and bank the SMALLER of what was promised and what
 * moved — overstating would let non-fee value out as if the market had earned it, and the operator
 * would only find out when the audit halted after it had already gone.
 *
 * The re-read is the part that is not obvious. A `latest` balance served by a replica that has not
 * seen the transaction's block reads the OLD number, so `measured` comes out as roughly the gas
 * alone. Banking that writes the whole claim down to a few thousand wei — and the escrow credit is
 * already spent on-chain, so it can never be re-claimed: those fees leave the ceiling forever,
 * showing up only as "undeclared float", which halts nothing and is therefore never noticed. Before
 * believing a figure SMALLER than expected, ask for the balance at the receipt's own block height.
 *
 * @param {object} client   the chain client the asset lives on
 * @param {string} holder   the wallet whose balance moved
 * @param {null|object} asset  null for the native asset; {address} for an ERC-20
 * @param {object} rc       the receipt, for its blockNumber
 * @param {{before: bigint, expected: bigint, gasSpent?: bigint}} o
 */
async function measureDelta(client, holder, asset, rc, o) {
  const read = async (blockNumber) => {
    const at = blockNumber != null ? { blockNumber } : {};
    if (!asset) return client.getBalance(Object.assign({ address: holder }, at));
    const { erc20Abi } = require('./abis.js');
    return client.readContract(Object.assign({
      address: asset.address, abi: erc20Abi, functionName: 'balanceOf', args: [holder],
    }, at));
  };
  const gasSpent = o.gasSpent || 0n;
  const after = await Promise.resolve().then(() => read(null)).catch(() => null);
  if (after === null) return { banked: o.expected, measured: null, after: null };
  let measured = after - o.before + gasSpent;
  if (measured < o.expected && rc && rc.blockNumber != null) {
    const atBlock = await Promise.resolve().then(() => read(rc.blockNumber)).catch(() => null);
    if (atBlock !== null) measured = atBlock - o.before + gasSpent;
  }
  const banked = measured < o.expected ? measured : o.expected;
  return { banked, measured, after };
}

async function harvest(wc, addr, s) {
  const curve = cfg.token.curve;
  const escrow = cfg.pons.escrow;

  if (!(await feeRecipientOk(addr, s))) return 0n;

  /* The money-in leg belongs to whoever the escrow pays. When a sink has declared that this is a
     contract, claiming from here would sign a transaction that can only ever move zero — the
     escrow credits msg.sender, and msg.sender would be the keeper. The sink does its own
     money-in in that case, and the core's job shrinks to having proved the recipient above. */
  if (payableElsewhere(addr)) return 0n;

  let grad = null, pending = 0n;
  try {
    const [g, q, t] = await Promise.all([
      pc.readContract({ address: curve, abi: curveAbi, functionName: 'graduated' }).catch(() => null),
      pc.readContract({ address: curve, abi: curveAbi, functionName: 'quoteFeeBalance' }).catch(() => 0n),
      pc.readContract({ address: curve, abi: curveAbi, functionName: 'creatorTaxBalance' }).catch(() => 0n),
    ]);
    grad = g;
    pending = (t || 0n) + ((q || 0n) * 70n) / 100n;
  } catch { /* curve not wired yet */ }

  // Pre-graduation sweep is best-effort; post-graduation it reverts AlreadyGraduated and PONS's
  // own operator sweeps the v4 pool into the same escrow instead. Claiming always works.
  if (!DRY && grad !== true && pending > 0n) {
    let h = null;
    try {
      h = await wc.writeContract({ address: curve, abi: curveAbi, functionName: 'sweepFees', args: [0n] });
      const rc = await pc.waitForTransactionReceipt({ hash: h });
      // this burns gas whether it succeeds or reverts, and that gas leaves the same wallet the sink
      // spends from. Unrecorded, it opened a permanent positive delta on the very first pass.
      await recordGas(rc, s, 'curve.sweepFees()');
      if (rc.status === 'success') log(s, `swept curve fees (~${fq(pending)} ${qSym()})`);
    } catch {
      // the send may still have made it: look the receipt up before giving up on its gas
      if (h) {
        const rc = await pc.getTransactionReceipt({ hash: h }).catch(() => null);
        if (rc) await recordGas(rc, s, 'curve.sweepFees() (receipt found after an error)');
      }
    }
  }

  if (quoteIsNative()) {
    const credit = await pc.readContract({ address: escrow, abi: escrowAbi, functionName: 'balanceOf', args: [addr] }).catch(() => 0n);
    if (credit <= 0n) return 0n;
    if (DRY) { log(s, `[dry] would claim ${formatEther(credit)} ETH from escrow`); return credit; }
    let sent = null;
    try {
      const balanceBefore = await pc.getBalance({ address: addr });
      const h = sent = await wc.writeContract({ address: escrow, abi: escrowAbi, functionName: 'claim', args: [] });
      // A reverted claim still returns a receipt — viem only throws on submission — so the status
      // has to be read. Banking a failed claim would credit fees the escrow never paid, let the
      // operator's gas float leave as an outflow, and then record the same credit again next pass
      // because it is still sitting in the escrow. harvest.json is the sole basis for every figure
      // the site publishes, so this is the difference between a receipt and a lie.
      const rc = await pc.waitForTransactionReceipt({ hash: h });
      const gasSpent = BigInt(rc.gasUsed || 0n) * BigInt(rc.effectiveGasPrice || 0n);
      // a reverted claim credits nothing, but it still BURNED gas out of this wallet
      if (rc.status !== 'success') { await recordGas(rc, s, 'a reverted claim()'); log(s, `claim reverted (${h}) — no credit recorded.`); return 0n; }

      // balanceOf is what the escrow says it owes; the balance delta is what it actually paid.
      // Bank the smaller of the two — see measureDelta, which is this block and is now shared with
      // every sink whose outcome is a quantity the transaction does not carry.
      const m = await measureDelta(pc, addr, null, rc, { before: balanceBefore, expected: credit, gasSpent });
      let banked = credit;
      if (m.after !== null) {
        if (m.measured !== credit) {
          log(s, `!! escrow said ${formatEther(credit)} ETH but the wallet moved ${formatEther(m.measured)} — banking the smaller.`);
          if (m.measured < credit) {
            log(s, `   ${formatEther(credit - m.measured)} ETH of that claim is outside the ceiling until you can explain it —`);
            log(s, `   check ${h} against the escrow before assuming the node was simply behind.`);
          }
        }
        banked = m.banked;
      }
      if (banked <= 0n) { await recordGas(rc, s, 'a claim that paid nothing'); return 0n; }
      recordClaim(banked, {
        hash: h,
        block: rc.blockNumber != null ? Number(rc.blockNumber) : null,
        gasRaw: gasSpent.toString(),
      });
      log(s, `claimed ${formatEther(banked)} ETH`);
      return banked;
    } catch (e) {
      // writeContract may have succeeded with waitForTransactionReceipt throwing after it: the tx
      // can still mine, so its gas is chased down by hash rather than written off.
      if (sent) {
        const rc = await pc.getTransactionReceipt({ hash: sent }).catch(() => null);
        if (rc) await recordGas(rc, s, `claim ${sent} (receipt found after an error)`);
      }
      log(s, `claim failed: ${require('./fmt.js').short(e)}`);
      return 0n;
    }
  }

  // Token-quoted: no cheap credit getter exists, so we attempt on an interval and treat the
  // revert as "nothing accrued yet".
  const gap = (cfg.loop && cfg.loop.claimIntervalMs) || 60000;
  if (Date.now() - lastClaim < gap) return 0n;
  lastClaim = Date.now();
  if (DRY) { log(s, `[dry] would call claimToken(${cfg.quote.asset})`); return 0n; }
  try {
    const h = await wc.writeContract({ address: escrow, abi: escrowAbi, functionName: 'claimToken', args: [cfg.quote.asset] });
    const rc = await pc.waitForTransactionReceipt({ hash: h });
    await recordGas(rc, s, 'claimToken()');     // native gas, whatever the quote asset is
    if (rc.status === 'success') log(s, `claimed ${qSym()} fees`);
    // deliberately NOT recorded: there is no credit getter on this path, so the amount is unknown,
    // and the ledger is denominated in the native asset the sink spends. The token path is not the
    // launched configuration — native ETH is — and it must never invent a figure to look complete.
  } catch { /* NoBalance — nothing yet */ }
  return 0n;
}

module.exports = {
  bind, harvestFile, readHarvest, recordClaim, recordGas, feeRecipientOk, harvest, measureDelta,
  redirected, expectedRecipient, payableElsewhere,
};
