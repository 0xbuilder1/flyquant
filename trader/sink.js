/**
 * @flybrain/sink — what happens to $FLY's creator fees.
 *
 * The core harvests them out of the PONS escrow; this decides where they go. The intended path is
 * three legs and only the first of them is live:
 *
 *   A  escrow.claim() -> the keeper wallet, in native ETH        LIVE (the core does this)
 *   B  wrap ETH -> WETH, swap WETH -> USDG on the 1bp v3 pool    NOT BUILT, disarmed
 *   C  deposit USDG as Lighter margin                            BLOCKED, see below
 *
 * LEG C IS BLOCKED ON AN ADDRESS NOBODY HAS VERIFIED, AND THAT IS WHY THIS SINK SPENDS NOTHING.
 * A wrong deposit contract is not a bug that costs a retry, it is a total loss, and the deposit
 * address for Lighter on 4663 has not been read from an official source. Until `fly.deposit.address`
 * is set AND `fly.deposit.verifiedBy` says how it was checked, this sink accumulates and reports.
 * That is a deliberate, safe resting state rather than an unfinished one: fees pile up in the fee
 * wallet, the ledger stays closed, and nothing can go to the wrong place.
 *
 * SO `spentRaw()` IS 0n, HONESTLY. It is not a stub. Nothing has left, so nothing is spent, and the
 * ceiling therefore reports the entire harvest as free capacity — which is true.
 */
'use strict';

const DEPOSIT_UNVERIFIED =
  'fly.deposit.address is unset or unverified. The Lighter deposit contract on 4663 has not been ' +
  'read from an official source, and a wrong deposit address is a total loss rather than a retry. ' +
  'Set both address and verifiedBy before arming anything.';

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
  t.add('leg B  swap ETH->USDG', 'not built');
  t.add('leg C  deposit to Lighter', depositReady() ? 'address set' : 'BLOCKED — ' + DEPOSIT_UNVERIFIED);
  t.add('fees leave the wallet', 'no — this sink accumulates and reports');
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
      B: { what: 'wrap + swap ETH -> USDG on the 1bp v3 pool', status: 'not built' },
      C: {
        what: 'deposit USDG as Lighter margin',
        status: depositReady() ? 'address set, not built' : 'blocked',
        blockedBy: depositReady() ? null : DEPOSIT_UNVERIFIED,
      },
    },
    lighterAccount: Number((cfg.lighter && cfg.lighter.accountIndex) || 0) || null,
    // the claim the site is allowed to make, in the sink's own words
    claim: 'Creator fees are harvested and held. None have been moved, swapped or deposited.',
  };
}

module.exports = {
  declare, configure, audit, spentRaw, reservedRaw, stats,
  preflight, plan,
  depositReady, DEPOSIT_UNVERIFIED,
};
