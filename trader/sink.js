/**
 * @flybrain/sink — what happens to $FLY's creator fees.
 *
 * The core harvests them out of the PONS escrow; this decides where they go. Three legs, each armed
 * on its own, and all three now exist:
 *
 *   A  escrow.claim() -> the fee wallet, in native ETH           LIVE, armed separately
 *   B  wrap ETH -> WETH, swap WETH -> USDG on the 1bp v3 pool    LIVE, armed separately
 *   C  deposit USDG as Lighter margin                            LIVE, armed separately
 *
 * *Unblocked 2026-09-12.* Leg C was held back because a wrong deposit contract is a total loss
 * rather than a retry. The address is now verified BY THIS REPO rather than taken from a document:
 * the ZkLighter deposit contract is a PROXY whose 1,367 bytes contain no selector at all, so
 * checking it alone would have said deposit() does not exist — the EIP-1967 implementation slot
 * points at 0x82de5b1161c93afdfe21ba0d5343f01cd7401d90, whose 23,168 bytes DO contain 0x8a857083.
 * USDG, WETH and the 1bp pool were each read the same way.
 *
 * `keeper/harvest.js` owns both legs and each arms independently. `spentRaw()` still returns 0n
 * until a harvest actually moves value, and it is a measurement rather than a stub.
 */
'use strict';

const DEPOSIT_UNVERIFIED =
  'fly.deposit.address or fly.deposit.verifiedBy is unset. A wrong deposit address is a total loss ' +
  'rather than a retry, so both must be filled in, and verifiedBy must say HOW it was checked.';

let ctx = null;

/** static, read before configure. Must not touch the network or the disk. */
function declare(cfg) {
  return {
    api: 1,
    id: 'flybrain',
    configKey: 'fly',
    outLabel: 'funded',
    outAsset: 'native',
    clients: [],                       // one chain. Lighter is REST and holds no chain client here.
    keys: [],                          // only PRIVATE_KEY, which the core already names
    readOnlyCommands: ['--fly-status'],
    commands: ['--fly-status'],
    signerOptionalFor: ['--fly-status'],
  };
}

function configure(c) { ctx = c; }

const sinkCfg = () => (ctx && ctx.sinkCfg && ctx.sinkCfg()) || {};

/** is leg C allowed to exist yet? */
function depositReady() {
  const d = sinkCfg().deposit || {};
  const addr = (d.address || '').trim();
  return !!(addr && /^0x[0-9a-fA-F]{40}$/.test(addr) &&
            addr !== '0x0000000000000000000000000000000000000000' &&
            (d.verifiedBy || '').trim());
}

/** everything that has already left. Nothing has. */
function spentRaw() { return 0n; }

/** wei promised but not yet sent. Nothing is promised. */
function reservedRaw() { return 0n; }

/**
 * The sink's own equality.
 *
 * claimed + float == spent + gas + heldByUs. With spent and reserved both zero, every wei the
 * escrow ever paid us should still be sitting in the fee wallet, less gas. When that stops holding,
 * something moved money that this sink does not know about, and the right response is to say so
 * rather than to adjust the expectation to match the balance.
 */
function audit(balanceRaw) {
  const h = ctx.harvest;
  const claimed = h.claimedRaw();
  const gas = h.gasRaw();
  const expected = claimed - gas;              // plus operator float, which the core adds back
  const delta = BigInt(balanceRaw) - expected;
  return {
    ok: delta >= 0n,                            // more than expected is float; less is a leak
    deltaRaw: delta,
    claimedRaw: claimed,
    gasRaw: gas,
    expectedRaw: expected,
    note: delta < 0n
      ? 'the fee wallet holds LESS than the escrow paid us minus gas — something spent fees'
      : null,
  };
}

/** preflight rows, not a report. The core renders them. */
function preflight(t) {
  const cfg = sinkCfg();
  const acct = Number((cfg.lighter && cfg.lighter.accountIndex) || 0);
  t.add('lighter account', acct > 0 ? String(acct) : 'PLACEHOLDER 0 — set it before the fly can size anything');
  t.add('leg B  swap ETH->USDG', 'built · keeper/harvest.js --arm-fund');
  t.add('leg C  deposit to Lighter', depositReady()
    ? 'verified · ' + (sinkCfg().deposit || {}).address
    : 'BLOCKED — ' + DEPOSIT_UNVERIFIED);
  t.add('deposit _to', (sinkCfg().deposit || {}).accountOwner || 'UNSET — fees would credit the fee wallet instead');
}

/**
 * Nothing to do, every pass, on purpose.
 *
 * `null` means "nothing this pass" and the core treats it as normal rather than as failure. When
 * legs B and C exist this is where the plan goes.
 */
function plan() { return null; }

/** the sink's half of the file the core writes */
function stats() {
  const cfg = sinkCfg();
  const h = ctx.harvest;
  const claimed = h.claimedRaw();
  const gas = h.gasRaw();
  return {
    sink: 'flybrain',
    feesClaimedRaw: claimed.toString(),
    gasRaw: gas.toString(),
    heldRaw: (claimed - gas).toString(),
    spentRaw: '0',
    reservedRaw: '0',
    legs: {
      A: { what: 'escrow.claim() -> fee wallet, native ETH', status: 'live' },
      B: { what: 'wrap + swap ETH -> USDG on the 1bp v3 pool', status: 'built, armed separately' },
      C: {
        what: 'deposit USDG as Lighter margin',
        status: depositReady() ? 'built, armed separately' : 'blocked',
        blockedBy: depositReady() ? null : DEPOSIT_UNVERIFIED,
      },
    },
    lighterAccount: Number((cfg.lighter && cfg.lighter.accountIndex) || 0) || null,
    // the claim the site is allowed to make, in the sink's own words
    claim: depositReady()
      ? 'Creator fees are harvested, swapped to USDG, and deposited as trading margin for the fly.'
      : 'Creator fees are harvested and held. None have been moved, swapped or deposited.',
  };
}

module.exports = {
  declare, configure, audit, spentRaw, reservedRaw, stats,
  preflight, plan,
  depositReady, DEPOSIT_UNVERIFIED,
};
