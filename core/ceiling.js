/**
 * @pons/core — THE CEILING. There is exactly one, and it lives here.
 *
 *   donatable() = claimed + declaredFloat − gas − spent − reserved
 *
 * claimed and gas are harvest.json's, which is core. The other three terms are the sink's, because
 * only the sink knows what "already left" and "promised but not yet sent" mean in its own shape:
 * for the charity sink, spent is the swept-plus-gas high-water mark and reserved is what a dead
 * holder-payout ledger still owes; for a holder sink, spent is its published sent total and reserved
 * is the sum of its accruals.
 *
 * The core owning the subtraction is the whole point. The keeper used to delegate its own first rule
 * to the sink's donatable(), which meant the sink could quietly widen it — and the out-bucket is a
 * framework-level concept, not a union of whichever names the sink written second happened to know.
 * `legacyAccruedRaw` in the charity sink IS the holder sink's ledger being subtracted, on a wallet
 * upgraded mid-life; a core that did not own this could not have expressed that.
 */
'use strict';

const { DRY } = require('./config.js');
const { readHarvest } = require('./harvest.js');

const big = (v) => BigInt(v || '0');
let sink = null;

function bind(s) { sink = s; }

function donatable() {
  const h = readHarvest();
  const v = big(h.claimedTotal)
    + (sink.declaredFloatRaw ? sink.declaredFloatRaw() : 0n)
    - big(h.gasRaw)
    - (sink.spentRaw ? sink.spentRaw() : 0n)
    - (sink.reservedRaw ? sink.reservedRaw() : 0n);
  return v > 0n ? v : 0n;
}

/**
 * The same ceiling, plus the dry-run courtesy of showing what the claim in flight would enable.
 * There is exactly ONE ceiling in this keeper so that two code paths can never each spend the same
 * claimed wei; this is that function, and a sink may read it but never define one of its own.
 */
function feesAvailable(pendingCredit) {
  const avail = donatable() + (DRY ? (pendingCredit || 0n) : 0n);
  return avail > 0n ? avail : 0n;
}

module.exports = { bind, donatable, feesAvailable };
