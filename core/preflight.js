/* ═══════════════════════════════════════════════════════════════════════════════════════════
   PREFLIGHT — prove every address is what we think it is, before any money moves
   ═══════════════════════════════════════════════════════════════════════════════════════════
   The core owns the frame and the rows that are true of every PONS token. The sink adds ROWS, not a
   report: add(name, ok, detail) and whyNotAddr are handed to it and everything is rendered through
   one report(). The evidence that this is the right shape is historical rather than guessed — the
   holder sink's whole preflight was these rows plus exactly two of its own, and the charity sink's
   is these rows plus nineteen.
   ═══════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { formatEther, formatUnits, parseEther, isAddress } = require('viem');
const cfg = require('./config.js').current();
const { DRY } = require('./config.js');
const { lc, short, stamp, log, quoteIsNative, wired, ZERO } = require('./fmt.js');
const { source: pc } = require('./chain.js');
const { curveAbi, escrowAbi, erc20Abi } = require('./abis.js');
const { launchedTokenInfo } = require('./watch.js');
const ceiling = require('./ceiling.js');

let sink = null;
function bind(s) { sink = s; }

async function preflight(addr, accounts) {
  const s = stamp();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  /* "unset" for a field that visibly contains an address sends the operator back to a config key
     they can see is filled in, and they conclude the tool cannot read its own config. A one-nibble
     truncation from a bad paste is the likeliest way to mis-enter an address, so say which it is. */
  const whyNotAddr = (v, unsetMsg) => {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return unsetMsg;
    if (lc(raw) === ZERO) return `all-zero placeholder — ${unsetMsg}`;
    const hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
    return `"${raw}" is not an address (${hex.length} hex chars after 0x, need 40)`;
  };

  try {
    const id = await pc.getChainId();
    add('chain id', id === cfg.chain.id, `${id} (expected ${cfg.chain.id})`);
  } catch (e) { add('chain id', false, short(e)); }

  if (!wired()) {
    /* This check short-circuits everything below it, so its one line is the whole report. A
       mis-pasted token lands here too, and calling that "unset" — then reassuring the operator that
       no token exists yet — is the wrong diagnosis on the wrong side of a paid-for launch. Say
       which of the two it is, and only offer the reassurance to the one it is true of. */
    const raw = String(cfg.token.token == null ? '' : cfg.token.token).trim();
    const blank = !raw || lc(raw) === ZERO;
    add('token wired', false, blank
      ? 'config.token.token is unset — nothing else can be checked'
      : `${whyNotAddr(raw, '')} — config.token.token, and nothing else can be checked`);
    const ok = report(s, checks);
    // On a clone that has not launched yet this is the EXPECTED result, not a broken checkout: the
    // token address does not exist until the launch does. Saying so here stops a first-time operator
    // reading "do not broadcast" as a fault to debug before they have anything to debug.
    if (blank) {
      log(s, '   before a launch this is expected — there is no token address yet.');
      log(s, '   it goes green once --watch (or launch.js) has written token/curve into a config you own.');
    } else {
      log(s, '   that field is filled in, so this is a typo and not a missing launch — fix the address.');
    }
    return ok;
  }

  try {
    const [sym, dec, sup] = await Promise.all([
      pc.readContract({ address: cfg.token.token, abi: erc20Abi, functionName: 'symbol' }),
      pc.readContract({ address: cfg.token.token, abi: erc20Abi, functionName: 'decimals' }),
      pc.readContract({ address: cfg.token.token, abi: erc20Abi, functionName: 'totalSupply' }),
    ]);
    add('token responds', true, `${sym} · ${dec} dp · supply ${formatUnits(sup, dec)}`);
    add('token symbol matches config', lc(sym) === lc(cfg.token.symbol), `${sym} vs ${cfg.token.symbol}`);
  } catch (e) { add('token responds', false, short(e)); }

  try {
    const dep = await pc.readContract({ address: cfg.token.curve, abi: curveAbi, functionName: 'deployer' });
    add('curve.deployer() == keeper', lc(dep) === lc(addr), `${dep} vs keeper ${addr}`);
  } catch (e) { add('curve.deployer()', false, short(e)); }

  // The current creatorFeeRecipient, not the one at launch. factory.transferCreatorFeeRecipient is
  // callable by whoever holds it, so this can change under us at any time — and if it does, the
  // escrow simply pays somebody else and the harvest quietly reaches nothing.
  try {
    const info = await launchedTokenInfo(cfg.token.token);
    add('creatorFeeRecipient == keeper', !!info && lc(info.feeRecipient) === lc(addr),
      info ? `${info.feeRecipient} vs keeper ${addr}` : 'factory.getLaunchedToken returned nothing');
  } catch (e) { add('creatorFeeRecipient == keeper', false, short(e)); }

  try {
    const grad = await pc.readContract({ address: cfg.token.curve, abi: curveAbi, functionName: 'graduated' });
    add('curve.graduated()', true, grad ? 'yes — fees arrive via the v4 pool sweep' : 'no — still on the bonding curve');
  } catch (e) { add('curve.graduated()', false, short(e)); }

  if (quoteIsNative()) {
    try {
      const credit = await pc.readContract({ address: cfg.pons.escrow, abi: escrowAbi, functionName: 'balanceOf', args: [addr] });
      add('escrow credit readable', true, `${formatEther(credit)} ETH waiting`);
    } catch (e) { add('escrow credit readable', String(short(e)).includes('NoBalance'), `${short(e)} (NoBalance is normal at zero)`); }
  } else {
    add('quote asset is a contract', isAddress(cfg.quote.asset), `${cfg.quote.asset} — claimToken(0x32f289cf) path`);
  }

  // everything the sink wants proved before it is armed — rows, rendered by the same report()
  if (sink.preflight) await sink.preflight({ add, whyNotAddr, addr, dry: DRY, accounts: accounts || {} });

  try {
    const bal = await pc.getBalance({ address: addr });
    const a = await sink.audit(bal);
    add('ledger closes (claimed + float == out + gas + residual)', a.deltaRaw <= 0n, `delta ${a.deltaRaw} wei`);
    // whatever is NOT claimed fees is the operator's own float, and the next claim needs gas
    const flat = parseEther(String(cfg.distribute.gasReserveEth || 0.02));
    const spare = bal > ceiling.donatable() ? bal - ceiling.donatable() : 0n;
    add('gas float above distribute.gasReserveEth', spare >= flat,
      `${formatEther(spare)} of non-fee ETH vs ${formatEther(flat)} reserve`);
  } catch (e) { add('ledger closes', false, short(e)); }

  return report(s, checks);
}

function report(s, checks) {
  console.log('');
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'}  ${c.name.padEnd(34)} ${c.detail}`);
  const bad = checks.filter((c) => !c.ok);
  console.log('');
  log(s, bad.length ? `${bad.length} check(s) failed — do not broadcast until these are green.` : 'all checks green.');
  return bad.length === 0;
}

module.exports = { bind, preflight, report };
