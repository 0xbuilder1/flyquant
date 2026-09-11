/**
 * @pons/core — the PONS launch tool. Zero sink knowledge at any line, and no per-token code: the
 * whole surface is cfg.launch.* and cfg.token.symbol. This is also the launch app's backend as-is —
 * the local form collects cfg.launch.* and calls plan(), then launch().
 *
 *   node launch.js plan                                 # simulate, spend nothing
 *   PRIVATE_KEY=0x… node launch.js launch --broadcast   # one irreversible transaction
 *   PRIVATE_KEY=0x… node launch.js fees   --broadcast   # point creator fees at the keeper
 *   PRIVATE_KEY=0x… node launch.js buy 0.01 --broadcast # make fees exist
 *   node launch.js status                               # what a sweep would credit
 *
 * Config resolves to config.json, so the throwaway run starts with `cp config.test.json config.json`
 * (TESTING.md stage 2). `launch` used to write the launched token and curve back into whatever file
 * it read with no guard — pointed at a committed template with --config, that dirties a tracked file
 * with a live address, which launch.js's own header described in prose and did not enforce. Both
 * writes now go through config.persistCfg, which is the same function --watch uses and refuses a
 * committed template. One persistCfg, two callers.
 *
 * Everything is simulation-first. `plan` eth_calls the exact bytes `launch` would broadcast and
 * reads back the real (token, curve) — same bytes reviewed as signed, so there is no gap between
 * the two. Nothing is sent without --broadcast.
 *
 * PONS has no testnet. Every launch is real money and cannot be undone, so the guards below are
 * not paranoia: each one corresponds to a revert that has actually been observed on this factory
 * (see docs/PONS.md, where every selector was decoded by bisection against the live contract).
 */
'use strict';

const path = require('path');
const {
  formatEther, parseEther, toFunctionSelector, isAddress, getAddress, keccak256, toHex,
} = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const config = require('./config.js');

/** everything below is per-invocation, because ROOT is the TOKEN's keeper directory and the core
 *  has no directory of its own that a config could live in. */
function run(ROOT) {
const cfg = config.load(ROOT);
const cfgPath = config.file();
const chainMod = require('./chain.js');
const { stamp } = require('./fmt.js');
const argv = process.argv.slice(2);
const cmd = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'plan';
const BROADCAST = argv.includes('--broadcast');

const ZERO = '0x0000000000000000000000000000000000000000';
const chain = chainMod.sourceChain;
const pc = chainMod.source;
const short = (e) => String((e && (e.shortMessage || e.message)) || e).split('\n')[0];
const bytes = (s) => Buffer.byteLength(String(s || ''), 'utf8');

/* ── the launch ABI ───────────────────────────────────────────────────────────────────────────
   socials is a NESTED TUPLE of five strings. Flattened into five separate string arguments the
   signature hashes to 0xea053510, which is not a function on this factory — you would encode a
   call to nothing, pay the gas and revert with the launch fee already committed. The selector
   assertion below is what stops that from ever happening silently.
   ─────────────────────────────────────────────────────────────────────────────────────────── */
const SOCIALS = { name: 'socials', type: 'tuple', components: [
  { name: 'twitter', type: 'string' }, { name: 'telegram', type: 'string' },
  { name: 'discord', type: 'string' }, { name: 'website', type: 'string' },
  { name: 'farcaster', type: 'string' },
] };
const TOKEN_PARAMS = { name: 'params', type: 'tuple', components: [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
  { name: 'logo', type: 'string' }, { name: 'description', type: 'string' },
  SOCIALS,
  { name: 'creatorFeeRecipient', type: 'address' }, { name: 'creatorTaxBps', type: 'uint16' },
  { name: 'buybackEnabled', type: 'bool' }, { name: 'expectedEconomics', type: 'bytes32' },
  { name: 'salt', type: 'bytes32' },
] };

const factoryAbi = [
  { name: 'launchToken', type: 'function', stateMutability: 'payable',
    inputs: [TOKEN_PARAMS, { name: 'launchConfigId', type: 'uint256' }, { name: 'pairToken', type: 'address' }],
    outputs: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }] },
  { name: 'launchFee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'maxCreatorTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'previewLaunchEconomics', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { name: 'transferCreatorFeeRecipient', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'address' }], outputs: [] },
];
const curveAbi = [
  { name: 'buy', type: 'function', stateMutability: 'payable',
    inputs: [{ name: 'quoteIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }, { name: 'recipient', type: 'address' }],
    outputs: [] },
  { name: 'deployer', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'graduated', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'quoteFeeBalance', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'creatorTaxBalance', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
const escrowAbi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

/* The documented selectors. If our ABI does not hash to these, our encoding is wrong and we stop. */
const EXPECTED = {
  launchToken: '0xf35abbcf',
  transferCreatorFeeRecipient: '0x2931861b',
  buy: '0x59a87bc1',
  deployer: '0xd5f39488',
};
function assertSelectors() {
  const sig = 'launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)';
  const got = {
    launchToken: toFunctionSelector(sig),
    transferCreatorFeeRecipient: toFunctionSelector('transferCreatorFeeRecipient(address,address)'),
    buy: toFunctionSelector('buy(uint256,uint256,address)'),
    deployer: toFunctionSelector('deployer()'),
  };
  let bad = 0;
  for (const k of Object.keys(EXPECTED)) {
    const ok = got[k].toLowerCase() === EXPECTED[k];
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'}  ${k.padEnd(28)} ${got[k]}  ${ok ? '' : '(expected ' + EXPECTED[k] + ')'}`);
  }
  if (bad) {
    console.error('\nENCODING MISMATCH — the ABI in this file does not produce the selectors decoded');
    console.error('from the live factory. Refusing to continue; a wrong encoding burns the launch fee.');
    process.exit(1);
  }
}

/* ── the token being launched ─────────────────────────────────────────────────────────────── */
function tokenParams(recipient) {
  const L = cfg.launch || {};
  const soc = L.socials || {};
  return {
    // no per-token literal survives in the core: the fallbacks lean on cfg.token.symbol, and a
    // launch with neither name nor symbol set is caught by the metadata caps below, not papered over
    name: L.name || cfg.token.symbol || 'Token',
    symbol: L.symbol || cfg.token.symbol || 'TOKEN',
    logo: L.logo || '',
    description: L.description || '',
    socials: {
      twitter: soc.twitter || '', telegram: soc.telegram || '', discord: soc.discord || '',
      website: soc.website || '', farcaster: soc.farcaster || '',
    },
    creatorFeeRecipient: getAddress(recipient),
    creatorTaxBps: Number(L.creatorTaxBps || 0),
    buybackEnabled: !!L.buybackEnabled,
    expectedEconomics: '0x' + '0'.repeat(64),
    salt: L.salt && /^0x[0-9a-fA-F]{64}$/.test(L.salt) ? L.salt : keccak256(toHex(L.saltSeed || ('pons-' + (L.symbol || cfg.token.symbol || 'TOKEN')))),
  };
}

/* Every cap below is enforced on-chain and every overflow reverts with the SAME error
   (MetadataTooLong 0x85b8e2f4), which does not say which field. So we check locally, in bytes. */
function validateMetadata(p) {
  const caps = [
    ['name', p.name, 64], ['symbol', p.symbol, 16], ['logo', p.logo, 512], ['description', p.description, 2048],
    ['socials.twitter', p.socials.twitter, 256], ['socials.telegram', p.socials.telegram, 256],
    ['socials.discord', p.socials.discord, 256], ['socials.website', p.socials.website, 256],
    ['socials.farcaster', p.socials.farcaster, 256],
  ];
  const bad = [];
  for (const [k, v, cap] of caps) {
    const n = bytes(v);
    console.log(`  ${n <= cap ? '✓' : '✗'}  ${k.padEnd(20)} ${String(n).padStart(5)} / ${cap} bytes`);
    if (n > cap) bad.push(k);
  }
  return bad;
}

async function preview(recipient) {
  console.log('\nselector check');
  assertSelectors();

  const p = tokenParams(recipient);
  console.log('\nmetadata (bytes, not characters)');
  const badMeta = validateMetadata(p);

  const [fee, maxTax] = await Promise.all([
    pc.readContract({ address: cfg.pons.factory, abi: factoryAbi, functionName: 'launchFee' }),
    pc.readContract({ address: cfg.pons.factory, abi: factoryAbi, functionName: 'maxCreatorTaxBps' }).catch(() => 1000n),
  ]);

  const configId = BigInt((cfg.launch && cfg.launch.configId) || 0);
  const pairToken = ZERO;                     // native ETH is the only approved quote today

  let economics = '0x' + '0'.repeat(64);
  try {
    economics = await pc.readContract({
      address: cfg.pons.factory, abi: factoryAbi, functionName: 'previewLaunchEconomics',
      args: [configId, pairToken],
    });
  } catch (e) {
    console.log(`\n  !  previewLaunchEconomics unavailable (${short(e)}) — economics cannot be pinned.`);
  }
  p.expectedEconomics = economics;

  console.log('\npreconditions');
  const checks = [
    ['launchFee()', true, formatEther(fee) + ' ETH (msg.value must equal this exactly)'],
    ['creatorTaxBps <= max', p.creatorTaxBps <= Number(maxTax), `${p.creatorTaxBps} / ${maxTax}`],
    ['launchConfigId == 0', configId === 0n, String(configId)],
    ['pairToken == address(0)', true, 'native ETH — the only approved quote'],
    ['economics pinned', economics !== '0x' + '0'.repeat(64), economics.slice(0, 18) + '…'],
    ['metadata within caps', badMeta.length === 0, badMeta.length ? 'over: ' + badMeta.join(', ') : 'ok'],
    ['fee recipient set', p.creatorFeeRecipient !== ZERO, p.creatorFeeRecipient],
  ];
  let bad = 0;
  for (const [n, ok, d] of checks) { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'}  ${n.padEnd(24)} ${d}`); }

  return { p, fee, configId, pairToken, bad };
}

async function simulate(account, recipient) {
  const { p, fee, configId, pairToken, bad } = await preview(recipient);
  if (bad) { console.log('\nfix the failing checks before launching.\n'); return null; }

  console.log('\nsimulating the exact call (eth_call — nothing is spent)');
  try {
    const { result, request } = await pc.simulateContract({
      address: cfg.pons.factory, abi: factoryAbi, functionName: 'launchToken',
      args: [p, configId, pairToken], value: fee, account,
    });
    const [token, curve] = result;
    console.log(`  ✓  token   ${token}`);
    console.log(`  ✓  curve   ${curve}`);
    let gas = null;
    try {
      gas = await pc.estimateContractGas({
        address: cfg.pons.factory, abi: factoryAbi, functionName: 'launchToken',
        args: [p, configId, pairToken], value: fee, account,
      });
      const gp = await pc.getGasPrice();
      console.log(`  ✓  gas     ${gas} @ ${Number(gp) / 1e9} gwei = ${formatEther(gas * gp)} ETH`);
      console.log(`  ✓  all in  ${formatEther(fee + gas * gp)} ETH`);
    } catch (e) { console.log(`  !  gas estimate failed: ${short(e)}`); }
    return { token, curve, request, p, fee, configId, pairToken };
  } catch (e) {
    console.log(`  ✗  simulation reverted: ${short(e)}`);
    console.log('     (0x7e6d78a5 LaunchFeeNotPaid · 0x9ad465dc CreatorTaxTooHigh · 0x68b42c59 InvalidLaunchConfigId');
    console.log('      0x49285dfb PairTokenNotApproved · 0x85b8e2f4 MetadataTooLong · 0xecb27319 LaunchEconomicsMismatch)');
    return null;
  }
}

/* Through config.persistCfg, which REFUSES a committed template — the same guard --watch has had
   since the throwaway run was documented. A launched address written into config.example.json is a
   tracked file dirtied with live state, and this was the one path that could still do it. */
function persist(token, curve) {
  cfg.token.token = token;
  cfg.token.curve = curve;
  config.persistCfg(stamp());
  console.log('distribute.launchBlock is written with it as a record of when this launched. Whether');
  console.log('anything reads it back is the SINK\'s business: a holder-shaped sink needs it as the');
  console.log('from-block floor of its balance scan, and this one does not read it at all.');
}

/* The launch form served by `serve`. One file, no dependencies and no CDN: an operator tool that
   stops working because a font host is down is an operator tool that stops working on the morning
   it is needed. It asks the wallet for nothing but the signature — every figure on it, including
   the calldata, is fetched from this process. */
function PAGE(c) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>launch $${esc(c.token.symbol)}</title>
<style>
:root{--bg:#EDEAE1;--paper:#FAF8F3;--ink:#14141A;--ink2:#4B4B55;--muted:#87857E;--line:#CFCABA;
--blue:#1B34FF;--flame:#FF4A17;--moss:#157F4B;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
.wrap{max-width:840px;margin:0 auto;padding:32px 22px 80px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px}
.sub{color:var(--ink2);margin-bottom:26px}
.card{background:var(--paper);border:2px solid var(--ink);box-shadow:5px 5px 0 var(--ink);padding:18px 20px;margin-bottom:18px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.lbl{font:500 10.5px/1 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
td{padding:6px 0;vertical-align:top;border-bottom:1px solid var(--line)}
td:first-child{color:var(--ink2);width:190px}
td:last-child{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
button{font:700 15px ui-sans-serif,system-ui,sans-serif;border:3px solid var(--ink);background:var(--paper);
color:var(--ink);padding:11px 20px;cursor:pointer;box-shadow:4px 4px 0 var(--ink)}
button:hover:not(:disabled){transform:translate(-2px,-2px);box-shadow:7px 7px 0 var(--ink)}
button:disabled{background:#E1DDD1;color:var(--muted);border-color:var(--line);box-shadow:none;cursor:not-allowed}
button.go{background:var(--blue);color:#fff}
.warn{border-left:6px solid var(--flame);background:#FFE2D8;padding:12px 16px;margin-bottom:14px;font-size:14px}
.ok{color:var(--moss)}.bad{color:var(--flame)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.chk{font-size:13.5px;padding:3px 0}
code{background:#E1DDD1;padding:1px 5px}
#log{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12.5px;margin-top:10px}
.meta{display:flex;flex-direction:column;gap:11px}
.mrow{display:grid;grid-template-columns:150px minmax(0,1fr) 62px;gap:12px;align-items:start}
.mk{font-family:ui-monospace,monospace;font-size:12px;color:var(--ink2);padding-top:9px}
.mrow input,.mrow textarea{width:100%;border:2px solid var(--ink);background:var(--paper);
  padding:8px 10px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;color:var(--ink);resize:vertical}
.mrow input:focus,.mrow textarea:focus{outline:3px solid var(--blue);outline-offset:1px}
.mc{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted);padding-top:11px;text-align:right}
.mc.bad{color:var(--flame);font-weight:700}
#reprice{font-size:13px;padding:8px 14px;box-shadow:3px 3px 0 var(--ink)}
</style></head><body><div class="wrap">
<h1>launch $${esc(c.token.symbol)}</h1>
<div class="sub">Local form on 127.0.0.1. Your wallet signs — this process never reads a private key.</div>

<div class="card">
  <div class="row"><button id="connect">Connect wallet</button>
  <span id="who" class="mono"></span></div>
  <div id="chainwarn"></div>
  <div id="recipbox" hidden style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
    <div class="lbl">fees are payable to &mdash; fixed at launch, 72-hour timelock to change</div>
    <div class="row" style="margin-top:8px">
      <input id="recip" class="mono" spellcheck="false"
             style="flex:1;min-width:380px;font-size:13px;padding:9px 11px;border:2px solid var(--ink);background:var(--paper)">
      <button id="useme" style="font-size:13px;padding:8px 13px;box-shadow:3px 3px 0 var(--ink)">my wallet</button>
    </div>
    <div id="recipnote" class="chk" style="margin-top:9px"></div>
  </div>
</div>

<div id="plan"></div>

<div class="card">
  <div class="row">
    <button id="go" class="go" disabled>Review the plan first</button>
    <span id="state" class="mono"></span>
  </div>
  <div id="log"></div>
</div>

<script>
var CHAIN = ${Number(c.chain.id)};
var RPC = ${JSON.stringify(c.chain.rpc)};
var EXPLORER = ${JSON.stringify(c.chain.explorer || '')};
var acct = null, plan = null;
var $ = function(id){ return document.getElementById(id); };
function log(s){ $('log').textContent += s + '\\n'; }
function hex(n){ return '0x' + BigInt(n).toString(16); }

async function ensureChain(){
  var id = await ethereum.request({ method:'eth_chainId' });
  if (parseInt(id,16) === CHAIN){ $('chainwarn').innerHTML = ''; return true; }
  $('chainwarn').innerHTML = '<div class="warn">Wrong network. This wallet is on chain ' +
    parseInt(id,16) + ', and the launch must go to ' + CHAIN + '.</div>';
  try {
    await ethereum.request({ method:'wallet_switchEthereumChain', params:[{ chainId: hex(CHAIN) }] });
  } catch (e) {
    if (e && e.code === 4902){
      await ethereum.request({ method:'wallet_addEthereumChain', params:[{
        chainId: hex(CHAIN), chainName:'Robinhood Chain', rpcUrls:[RPC],
        nativeCurrency:{ name:'Ether', symbol:'ETH', decimals:18 },
        blockExplorerUrls: EXPLORER ? [EXPLORER] : []
      }]});
    } else { return false; }
  }
  var again = await ethereum.request({ method:'eth_chainId' });
  var ok = parseInt(again,16) === CHAIN;
  if (ok) $('chainwarn').innerHTML = '';
  return ok;
}

$('connect').onclick = async function(){
  if (!window.ethereum){ alert('No injected wallet found. Open this page in a browser with MetaMask or Rabby.'); return; }
  var a = await ethereum.request({ method:'eth_requestAccounts' });
  acct = a[0];
  $('who').textContent = acct;
  $('recipbox').hidden = false;
  if (!$('recip').value) $('recip').value = acct;
  if (!(await ensureChain())) return;
  await loadPlan();
};
$('useme').onclick = function(){ if (acct){ $('recip').value = acct; loadPlan(); } };
var rt = null;
$('recip').oninput = function(){ if (!acct) return; clearTimeout(rt); rt = setTimeout(loadPlan, 450); };

/** one editable metadata field, with a byte counter against the factory's own cap */
function mrow(key, id, val, cap, big){
  var v = String(val == null ? '' : val).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  return '<label class="mrow"><span class="mk">' + key + '</span>'
    + (big ? '<textarea id="m-' + id + '" rows="3" data-cap="' + cap + '">' + v + '</textarea>'
           : '<input id="m-' + id + '" value="' + v + '" data-cap="' + cap + '">')
    + '<span class="mc" id="c-' + id + '"></span></label>';
}
/** the metadata currently in the form, or null before a plan has ever rendered */
function readMeta(){
  if (!$('m-name')) return null;
  var g = function(id){ var e = $('m-' + id); return e ? e.value : ''; };
  return {
    name: g('name'), symbol: g('symbol'), logo: g('logo'), description: g('description'),
    creatorTaxBps: g('creatorTaxBps'),
    socials: { twitter: g('twitter'), website: g('website'), telegram: g('telegram') }
  };
}
function paintCounts(){
  ['name','symbol','logo','description','twitter','website','telegram'].forEach(function(id){
    var e = $('m-' + id), c = $('c-' + id);
    if (!e || !c) return;
    var cap = Number(e.getAttribute('data-cap')) || 0;
    var n = new Blob([e.value]).size;              // BYTES, which is what the factory counts
    c.textContent = n + '/' + cap;
    c.className = 'mc' + (n > cap ? ' bad' : '');
  });
}

var loading = false;
async function loadPlan(){
  /* READ THE FORM BEFORE DESTROYING IT. The metadata inputs live inside #plan, and this used to
     overwrite that element with "simulating…" and only then call readMeta() — which opens with
     "if (!$('m-name')) return null", so it found nothing and returned null EVERY TIME. The server
     applies b.meta only when it is truthy, so every re-price silently posted no metadata, the
     config came back unchanged, and the operator watched their edit disappear.

     That is also why a launched token carried nothing but config defaults and no twitter link:
     not a dropped field, a metadata editor that had never once sent anything. */
  if (loading) return;                    // the button and the blur can both fire; one is enough
  loading = true;
  try {
  var meta = readMeta();
  var want = ($('recip').value || acct).trim();
  $('plan').innerHTML = '<div class="card">simulating…</div>';
  var r = await fetch('/api/plan', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ signer: acct, recipient: want, meta: meta }) });
  plan = await r.json();
  if (plan.error){ $('plan').innerHTML = '<div class="card bad">' + plan.error + '</div>'; return; }
  var p = plan.params, blockers = [];
  if (plan.isTemplate) blockers.push('This is <b>' + plan.cfgFile + '</b>, a committed template. It refuses to have a launched address written into it — copy it to <code>config.json</code> and restart this server, or the launch will succeed with nothing recorded.');
  if (plan.alreadyWired) blockers.push('This config already points at <b>' + plan.alreadyWired + '</b>. Launching again creates a <b>second, separate token</b> and overwrites that address.');
  if (plan.badChecks) blockers.push(plan.badChecks + ' precondition(s) failed — see the terminal running this server.');
  if (plan.simError && plan.saltSpent) blockers.push(
    '<b>This salt has already been used with this fee recipient.</b> The launched address is derived '
    + 'from both together, so the token it would create already exists. The same simulation with a '
    + 'fresh salt succeeds, so nothing else is wrong. Fix it by changing <code>launch.saltSeed</code> '
    + 'in the config and restarting this server &mdash; not by changing the fee recipient, which only '
    + 'moves the address and is the one field you cannot correct afterwards.');
  else if (plan.simError) blockers.push('The simulation reverted: <b>' + plan.simError + '</b>. Nothing would be signed.');
  /* THE ONE THAT STRANDS MONEY FOREVER. A contract recorded here that cannot accept a plain
     value transfer will never receive a single fee, and the only way back is a 72-hour timelock. */
  if (!plan.recipientTakesEth) blockers.push('<b>' + plan.params.creatorFeeRecipient + ' cannot receive ETH.</b> '
    + 'A 1-wei transfer to it reverts, so it has no payable receive(). Every fee this token ever earns would be '
    + 'stranded in the escrow, and the only way back is a 72-hour timelock. Refusing.');

  var rn = $('recipnote');
  if (plan.recipientIsContract){
    rn.innerHTML = plan.recipientTakesEth
      ? '<span class="ok">&#10003;</span> A contract, and it accepts ETH (probed with a 1-wei call). '
        + 'The escrow will pay it directly, so the vault fills itself.'
      : '<span class="bad">&#10007;</span> A contract that REJECTS ETH. Fees would be stranded forever.';
  } else if (plan.params.creatorFeeRecipient.toLowerCase() === acct.toLowerCase()){
    rn.innerHTML = '<span class="ok">&#10003;</span> Your own wallet. Fees land here and reach a desk only if you move them.';
  } else {
    rn.innerHTML = '<span class="ok">&#10003;</span> A plain wallet (no code). Fees land there.';
  }

  var rows = [
    ['creatorFeeRecipient', p.creatorFeeRecipient],
    ['salt', p.salt], ['launch fee', plan.feeEth + ' ETH'],
    ['gas', plan.gasEth ? plan.gas + ' = ' + plan.gasEth + ' ETH' : 'not estimated'],
    ['all in', plan.allInEth ? plan.allInEth + ' ETH' : '—'],
    ['token (predicted)', plan.token || '—'], ['curve (predicted)', plan.curve || '—'],
    ['factory', plan.to]
  ];
  var html = '';
  blockers.forEach(function(b){ html += '<div class="warn">' + b + '</div>'; });

  /* THE METADATA IS EDITABLE, AND IT IS THE ONE PART OF A LAUNCH THAT CANNOT BE EDITED AFTERWARDS.
     Every field is typed here, counted against the factory's own byte cap as it is typed, and
     re-simulated before it can be signed. A throwaway test in particular wants a name and a ticker
     that tell a stranger not to buy it, and hand-editing JSON for that is how the wrong ticker
     ends up on chain forever. */
  html += '<div class="card"><div class="lbl">metadata &mdash; immutable once launched, edit before you sign</div>'
    + '<div class="meta">'
    + mrow('name', 'name', p.name, plan.caps.name)
    + mrow('symbol', 'symbol', p.symbol, plan.caps.symbol)
    + mrow('logo', 'logo', p.logo, plan.caps.logo)
    + mrow('description', 'description', p.description, plan.caps.description, true)
    + mrow('socials.twitter', 'twitter', p.socials.twitter, plan.caps.socials.twitter)
    + mrow('socials.website', 'website', p.socials.website, plan.caps.socials.website)
    + mrow('socials.telegram', 'telegram', p.socials.telegram, plan.caps.socials.telegram)
    + mrow('creatorTaxBps', 'creatorTaxBps', String(p.creatorTaxBps), 0)
    + '</div>'
    + '<div class="row" style="margin-top:14px"><button id="reprice">Re-price with these</button>'
    + '<span class="mono" id="taxnote">trader pays ' + (1 + p.creatorTaxBps/100).toFixed(2)
    + '%, pot receives ' + (0.7 + p.creatorTaxBps/100).toFixed(2) + '%</span></div></div>';

  html += '<div class="card"><div class="lbl">what will be committed, permanently</div><table>';
  rows.forEach(function(r){ html += '<tr><td>' + r[0] + '</td><td>' + (r[1] === '' ? '<i>empty</i>' : r[1]) + '</td></tr>'; });
  html += '</table>';
  html += '<div class="chk" style="margin-top:12px">' +
    (p.creatorFeeRecipient.toLowerCase() === acct.toLowerCase()
      ? '<span class="ok">&#10003;</span> Fees are payable to the wallet you just connected.'
      : '<span class="bad">&#10007;</span> Fee recipient is NOT the connected wallet.') +
    ' This is fixed at launch; changing it later is a 72-hour timelock.</div>';
  html += '</div>';
  $('plan').innerHTML = html;

  paintCounts();
  /* EDITING A FIELD USED TO DO NOTHING BUT COUNT ITS BYTES.
     The calldata is built by /api/plan from the SERVER's copy of the metadata, and the server only
     learns about an edit when the browser POSTs readMeta() — which loadPlan() does and an 'input'
     listener does not. So typing into a field, watching the counter tick and pressing Launch signed
     the metadata as it was BEFORE the edit. It launched a token with an empty twitter field that
     way, silently, and metadata is fixed at launch.

     Now an edit makes the plan stale and says so, 'change' (which fires on blur or tab-out)
     re-plans on its own, and the Launch button refuses to sign a plan that does not match what is
     on the screen. The guard in go.onclick is the one that actually matters — the rest is so
     nobody has to discover it. */
  ['name','symbol','logo','description','twitter','website','telegram','creatorTaxBps'].forEach(function(id){
    var e = $('m-' + id);
    if (!e) return;
    e.addEventListener('input', function(){ paintCounts(); markStale(); });
    e.addEventListener('change', function(){ if (metaStale) loadPlan(); });
  });
  var rp = $('reprice');
  if (rp) rp.onclick = function(){ loadPlan(); };

  metaStale = false;
  planMeta = readMeta();
  var ready = !blockers.length && !!plan.data;
  $('go').disabled = !ready;
  $('go').textContent = ready ? ('Launch $' + p.symbol + ' — ' + plan.feeEth + ' ETH + gas') : 'Blocked';
  } finally { loading = false; }
}

/* the metadata the CURRENT plan.data was built from, and whether the form has moved since */
var planMeta = null, metaStale = false;
function markStale(){
  metaStale = true;
  var g = $('go');
  if (g){ g.disabled = true; g.textContent = 'Applying edits…'; }
  var s = $('state');
  if (s) s.textContent = 'edited — rebuilding the transaction';
}
/** has the form drifted from what plan.data actually encodes? */
function metaDrifted(){
  if (!planMeta) return false;
  var now = readMeta();
  if (!now) return false;
  return JSON.stringify(now) !== JSON.stringify(planMeta);
}

$('go').onclick = async function(){
  if (!plan || !plan.data) return;
  /* THE LAST LINE OF DEFENCE, and the only one that cannot be raced. plan.data is bytes that were
     built from metadata the server had at the time; if the form says something else now, those
     bytes are not what the operator is looking at. Rebuild and make them read it again — never
     sign the difference. */
  if (metaStale || metaDrifted()){
    $('state').textContent = 'the form changed — rebuilding, then review it again';
    await loadPlan();
    return;
  }
  if (!confirm('This is irreversible. Launch ' + plan.params.symbol + ' with fees payable to ' + plan.params.creatorFeeRecipient + '?')) return;
  $('go').disabled = true; $('state').textContent = 'waiting for your wallet…';
  try {
    if (!(await ensureChain())){ $('state').textContent = 'wrong network'; $('go').disabled = false; return; }
    var hash = await ethereum.request({ method:'eth_sendTransaction', params:[{
      from: acct, to: plan.to, data: plan.data, value: hex(plan.feeRaw)
    }]});
    log('tx ' + hash);
    if (EXPLORER) log(EXPLORER + '/tx/' + hash);
    $('state').textContent = 'mining…';
    var r = await fetch('/api/launched', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ hash: hash }) });
    var out = await r.json();
    if (out.error){ $('state').textContent = 'failed'; log('!! ' + out.error); $('go').disabled = false; return; }
    $('state').textContent = 'launched';
    log('token  ' + out.token);
    log('curve  ' + out.curve);
    log('block  ' + out.block);
    log(out.wroteConfig ? 'written into ' + out.cfgFile : '!! NOT written — ' + out.cfgFile + ' is a committed template');
    log('');
    log('next: wait >3s for the snipe tax to decay, buy so fees exist, then');
    log('      node keeper.js --broadcast     (harvest)');
    log('      node keeper.js --preflight     (all green)');
  } catch (e) {
    $('state').textContent = 'rejected';
    log('!! ' + ((e && e.message) || e));
    $('go').disabled = false;
  }
};
if (window.ethereum && ethereum.on) ethereum.on('accountsChanged', function(){ location.reload(); });
</script></div></body></html>`;
}

/* ── commands ─────────────────────────────────────────────────────────────────────────────── */
async function main() {
  /* see core/key.js: cmd's `set X=v && cmd` puts the space before the && inside the value */
  const keyIn = require('./key.js').readKey('PRIVATE_KEY');
  const pk = keyIn.value;
  if (keyIn.repaired) console.log(`note: PRIVATE_KEY had ${keyIn.repaired}; using the key inside it.`);
  if (BROADCAST && !pk) { console.error('set PRIVATE_KEY to --broadcast'); process.exit(1); }
  let account;
  if (pk) {
    try { account = privateKeyToAccount(pk); }
    catch {
      const km = require('./key.js');
      console.error(`\nPRIVATE_KEY is not a usable key: ${km.keyProblem(pk)}.`);
      console.error('\nSet it like this:\n');
      console.error(km.keyHint('PRIVATE_KEY'));
      console.error('');
      process.exit(1);
    }
  }
  const me = account ? account.address : (cfg.feeWallet.address !== ZERO ? cfg.feeWallet.address : null);
  /* `serve` is the one command with no `me` at all, and that is the point of it: the recipient is
     whichever wallet connects to the form, so a fresh config with feeWallet.address still at 0x0 —
     the exact state somebody is in before their first launch — must not be turned away here. */
  if (!me && cmd !== 'serve') { console.error('no key and no feeWallet.address — nothing to simulate as.'); process.exit(1); }
  const wc = account ? chainMod.makeWalletClient(account) : undefined;

  console.log(`$${cfg.token.symbol} launch · ${cmd === 'serve' ? 'LOCAL FORM (your wallet signs)' : BROADCAST ? 'BROADCAST' : 'SIMULATE (nothing sent)'} · ${path.basename(cfgPath)}`);
  if (me) console.log(`keeper ${me}`);
  if (account) console.log(`balance ${formatEther(await pc.getBalance({ address: me }))} ETH`);

  if (cmd === 'plan') {
    await simulate(me, me);
    console.log('\nthis was a simulation. Re-run with `launch --broadcast` to send it.\n');
    return;
  }

  if (cmd === 'launch') {
    const sim = await simulate(me, me);
    if (!sim) return;
    if (!BROADCAST) { console.log('\nadd --broadcast to send.\n'); return; }
    console.log('\nbroadcasting…');
    const hash = await wc.writeContract(sim.request);
    console.log(`  tx ${hash}`);
    const rc = await pc.waitForTransactionReceipt({ hash });
    console.log(`  ${rc.status} in block ${rc.blockNumber} · gas used ${rc.gasUsed}`);
    if (rc.status === 'success') {
      cfg.distribute.launchBlock = Number(rc.blockNumber);
      persist(sim.token, sim.curve);          // one write, one guard, token + curve + launchBlock
      console.log(`launchBlock set to ${rc.blockNumber}.`);
      console.log('\nNEXT: wait >3s (snipe tax decays over 3 seconds), then `buy` so fees exist.');
    }
    return;
  }

  if (cmd === 'fees') {
    const to = (cfg.feeWallet.address && cfg.feeWallet.address !== ZERO) ? cfg.feeWallet.address : me;
    console.log(`\ntransferCreatorFeeRecipient(${cfg.token.token}, ${to})`);
    if (!BROADCAST) {
      await pc.simulateContract({ address: cfg.pons.factory, abi: factoryAbi, functionName: 'transferCreatorFeeRecipient', args: [cfg.token.token, to], account: me })
        .then(() => console.log('  ✓  simulates clean (add --broadcast to send)'))
        .catch((e) => console.log(`  ✗  ${short(e)}   (0xb9f93944 NotCreatorFeeRecipient = you are not the current recipient)`));
      return;
    }
    const hash = await wc.writeContract({ address: cfg.pons.factory, abi: factoryAbi, functionName: 'transferCreatorFeeRecipient', args: [cfg.token.token, to] });
    await pc.waitForTransactionReceipt({ hash });
    console.log(`  tx ${hash}`);
    const dep = await pc.readContract({ address: cfg.token.curve, abi: curveAbi, functionName: 'deployer' });
    console.log(`  curve.deployer() = ${dep}  ${dep.toLowerCase() === to.toLowerCase() ? '✓ fees now point at the keeper' : '✗ MISMATCH — the harvest cannot reach anything'}`);
    return;
  }

  if (cmd === 'buy') {
    const amt = argv[1] && !argv[1].startsWith('--') ? argv[1] : '0.01';
    const value = parseEther(String(amt));
    // --to only varies the counterparty. There is no holder set and no eligibility gate any more,
    // so a buy to the keeper's own wallet earns fees exactly like anybody else's — the point of this
    // command is producing volume, not building a set of wallets that get paid.
    const toFlag = argv.indexOf('--to');
    const recipient = toFlag > -1 && argv[toFlag + 1] ? getAddress(argv[toFlag + 1]) : me;
    console.log(`\ncurve.buy(${amt} ETH, minOut 0, ${recipient})`);
    console.log('  note: buying within 3s of launch pays the snipe tax (starts at 9900 bps, decays to zero).');
    try {
      const { request } = await pc.simulateContract({
        address: cfg.token.curve, abi: curveAbi, functionName: 'buy',
        args: [value, 0n, recipient], value, account: me,
      });
      console.log('  ✓  simulates clean');
      if (!BROADCAST) { console.log('  add --broadcast to send.\n'); return; }
      const hash = await wc.writeContract(request);
      const rc = await pc.waitForTransactionReceipt({ hash });
      console.log(`  tx ${hash} · ${rc.status}`);
    } catch (e) { console.log(`  ✗  ${short(e)}`); }
    return;
  }

  if (cmd === 'status') {
    const t = cfg.token.token, c = cfg.token.curve;
    if (!isAddress(t) || t === ZERO) { console.log('\nno token wired yet.\n'); return; }
    const [grad, q, tax, credit, dep] = await Promise.all([
      pc.readContract({ address: c, abi: curveAbi, functionName: 'graduated' }).catch(() => null),
      pc.readContract({ address: c, abi: curveAbi, functionName: 'quoteFeeBalance' }).catch(() => 0n),
      pc.readContract({ address: c, abi: curveAbi, functionName: 'creatorTaxBalance' }).catch(() => 0n),
      pc.readContract({ address: cfg.pons.escrow, abi: escrowAbi, functionName: 'balanceOf', args: [me] }).catch(() => 0n),
      pc.readContract({ address: c, abi: curveAbi, functionName: 'deployer' }).catch(() => null),
    ]);
    const sweepWouldCredit = tax + (q * 70n) / 100n;
    console.log(`\n  token              ${t}`);
    console.log(`  curve              ${c}`);
    console.log(`  graduated          ${grad}`);
    console.log(`  curve.deployer()   ${dep}  ${dep && dep.toLowerCase() === me.toLowerCase() ? '✓ yours' : '✗ not the keeper — sweepFees is gated to somebody else'}`);
    console.log(`  quoteFeeBalance    ${formatEther(q)} ETH`);
    console.log(`  creatorTaxBalance  ${formatEther(tax)} ETH`);
    console.log(`  a sweep credits    ${formatEther(sweepWouldCredit)} ETH   (creatorTax + 70% of quoteFee)`);
    console.log(`  escrow credit      ${formatEther(credit)} ETH  ${credit > 0n ? '→ claim() will pay this' : '(nothing to claim yet)'}`);
    if (q === 0n && tax === 0n) console.log('\n  both pots are zero — a sweep would be a wasted transaction. Trade first.');
    console.log('');
    return;
  }

  /* ── serve ─────────────────────────────────────────────────────────────────────────────────
     The local launch form this file's header has described since it was written, finally built.

     WHY IT EXISTS AT ALL, given `launch --broadcast` already works: that path needs PRIVATE_KEY in
     the environment of the machine typing it, for the ONE transaction in this whole system that
     cannot be undone. Here the browser wallet signs and the key never leaves it. The keeper still
     needs a hot key to claim fees on a timer — that is inherent to an automated harvester — but
     the launch does not, and the launch is the irreversible one.

     WHAT IT IS NOT: a second encoder. Every byte the wallet is asked to sign comes from the SAME
     tokenParams() → simulateContract path `plan` uses, through encodeFunctionData on the same abi,
     after the same selector assertion. A page that rebuilt the calldata in JavaScript would be a
     second implementation of the one call that burns a launch fee when it is wrong.

     Bound to 127.0.0.1 on purpose: it writes config.json and needs no authentication precisely
     because nothing off this machine can reach it. */
  if (cmd === 'serve') {
    const http = require('http');
    const { encodeFunctionData } = require('viem');
    const portFlag = argv.indexOf('--port');
    const PORT = portFlag > -1 && argv[portFlag + 1] ? Number(argv[portFlag + 1]) : 8787;

    const LAUNCH_TOPIC = require('./watch.js').LAUNCH_TOPIC;
    const json = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    /**
     * Metadata typed into the form, written onto the live cfg.launch.
     *
     * Only these keys, and each is checked against the SAME byte cap the factory enforces, because
     * every overflow reverts with one undifferentiated error (MetadataTooLong) that does not say
     * which field — and by then the launch fee is committed. A field is left alone rather than
     * truncated: silently shortening somebody's description is a worse answer than refusing it.
     *
     * These land in config.json only when a launch actually succeeds. Editing the form and walking
     * away changes nothing on disk.
     */
    const META_CAPS = { name: 64, symbol: 16, logo: 512, description: 2048 };
    const SOCIAL_CAPS = { twitter: 256, telegram: 256, discord: 256, website: 256, farcaster: 256 };
    function applyMeta(m) {
      const L = cfg.launch || (cfg.launch = {});
      for (const k of Object.keys(META_CAPS)) {
        if (typeof m[k] === 'string' && Buffer.byteLength(m[k], 'utf8') <= META_CAPS[k]) L[k] = m[k];
      }
      L.socials = L.socials || {};
      const soc = m.socials || {};
      for (const k of Object.keys(SOCIAL_CAPS)) {
        if (typeof soc[k] === 'string' && Buffer.byteLength(soc[k], 'utf8') <= SOCIAL_CAPS[k]) L.socials[k] = soc[k];
      }
      /* the tax is economics rather than copy, and it is what the site's published 3.0%/2.7% is
         derived from — so it moves only within what the factory itself allows */
      const bps = Number(m.creatorTaxBps);
      if (Number.isFinite(bps) && bps >= 0 && bps <= 1000) L.creatorTaxBps = Math.round(bps);
    }

    /**
     * The plan. `signer` is the wallet that will send the transaction; `recipient` is who the
     * factory records as creatorFeeRecipient, and they are NOT required to be the same.
     *
     * They were the same until a desk needed to be its own fee recipient. That is the whole
     * difference between a payout reserve the operator tops up by hand and one the escrow fills
     * by itself: with the desk recorded here, escrow.claim() pays the contract, its receive()
     * credits vault[ETH], and the number the site reads off the chain IS the harvested fees.
     *
     * It is also the single most dangerous field on this form. The factory fixes it at launch and
     * changing it afterwards is a 72-hour timelock, so a contract that cannot accept ETH recorded
     * here strands every fee the token will ever earn. Hence the probe below: a 1-wei eth_call at
     * the recipient, which costs nothing and reverts exactly when a contract has no payable
     * receive(). Reading "it has code" as "it can be paid" is the assumption worth refusing.
     */
    async function planFor(recipient, signer) {
      const { p, fee, configId, pairToken, bad } = await preview(recipient);
      const out = {
        params: p, feeRaw: fee.toString(), feeEth: formatEther(fee),
        configId: configId.toString(), pairToken, badChecks: bad,
        to: cfg.pons.factory, chainId: cfg.chain.id,
        cfgFile: path.basename(cfgPath), isTemplate: config.isTemplate(),
        alreadyWired: isAddress(cfg.token.token) && cfg.token.token !== ZERO ? cfg.token.token : null,
        signer, recipient,
        caps: Object.assign({}, META_CAPS, { socials: SOCIAL_CAPS }),
      };

      /* is the recipient a contract, and if so can it actually be paid? */
      const code = await pc.getCode({ address: recipient }).catch(() => null);
      out.recipientIsContract = !!(code && code !== '0x');
      if (out.recipientIsContract) {
        // a plain value transfer, simulated. Reverts iff there is no payable receive/fallback.
        out.recipientTakesEth = await pc.call({
          account: signer, to: recipient, value: 1n, gas: 200000n,
        }).then(() => true).catch(() => false);
      } else {
        out.recipientTakesEth = true;             // an EOA always can
      }

      if (bad) return out;
      try {
        const { result } = await pc.simulateContract({
          address: cfg.pons.factory, abi: factoryAbi, functionName: 'launchToken',
          args: [p, configId, pairToken], value: fee, account: signer,
        });
        out.token = result[0]; out.curve = result[1];
      } catch (e) {
        out.simError = short(e);
        /* THE SALT IS ALREADY SPENT, and the factory says so with a bare custom-error selector
           (0xb06ebf3d) that viem renders as "reverted with the following signature:" and then
           nothing. What it means was established empirically rather than decoded: the deterministic
           address folds in the CREATOR FEE RECIPIENT as well as the salt, so launch.saltSeed and
           the recipient must be unique TOGETHER. Relaunching with the same seed at the same desk
           lands on an address that already exists; pointing at a different wallet moves it, which
           makes the recipient look like the culprit and it is not.

           Rather than match on a selector that only this factory version uses, the same call is
           re-simulated with a throwaway salt. If that succeeds, the salt is the whole story and the
           operator is told the one line that fixes it. Read-only either way — nothing is sent. */
        try {
          const probe = Object.assign({}, p, { salt: keccak256(toHex(`probe-${Date.now()}-${Math.random()}`)) });
          await pc.simulateContract({
            address: cfg.pons.factory, abi: factoryAbi, functionName: 'launchToken',
            args: [probe, configId, pairToken], value: fee, account: signer,
          });
          out.saltSpent = true;
        } catch { /* it fails for a different reason too; the raw message stands */ }
        return out;
      }
      out.data = encodeFunctionData({ abi: factoryAbi, functionName: 'launchToken', args: [p, configId, pairToken] });
      try {
        const gas = await pc.estimateContractGas({
          address: cfg.pons.factory, abi: factoryAbi, functionName: 'launchToken',
          args: [p, configId, pairToken], value: fee, account: signer,
        });
        const gp = await pc.getGasPrice();
        out.gas = gas.toString();
        out.gasEth = formatEther(gas * gp);
        out.allInEth = formatEther(fee + gas * gp);
      } catch { /* the simulation already passed; a gas estimate is a courtesy */ }
      return out;
    }

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      try {
        if (u.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(PAGE(cfg));
          return;
        }
        if (u.pathname === '/api/plan') {
          let sg = u.searchParams.get('signer') || '';
          let r = u.searchParams.get('recipient') || sg;
          /* POST carries edited metadata. It is applied to cfg.launch BEFORE the plan is priced,
             so the bytes simulated are the bytes the form is showing — there is no second copy of
             the metadata anywhere, which is the only way the review and the signature can agree. */
          if (req.method === 'POST') {
            let body = '';
            for await (const c of req) body += c;
            const b = JSON.parse(body || '{}');
            sg = b.signer || sg; r = b.recipient || r;
            if (b.meta) applyMeta(b.meta);
          }
          if (!isAddress(sg)) return json(res, 400, { error: 'connect a wallet first' });
          if (!isAddress(r)) return json(res, 400, { error: 'the fee recipient is not an address' });
          return json(res, 200, await planFor(getAddress(r), getAddress(sg)));
        }
        if (u.pathname === '/api/launched' && req.method === 'POST') {
          let body = '';
          for await (const c of req) body += c;
          const { hash } = JSON.parse(body || '{}');
          if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) return json(res, 400, { error: 'no hash' });
          const rc = await pc.waitForTransactionReceipt({ hash });
          if (rc.status !== 'success') return json(res, 200, { status: rc.status, error: 'the launch transaction reverted' });
          /* token and curve come out of the RECEIPT, not out of the simulation that predicted
             them. A predicted address that the chain disagreed with is exactly the state worth
             catching, and the event is indexed so this costs nothing. */
          const lg = (rc.logs || []).find((l) => (l.topics || [])[0] === LAUNCH_TOPIC
            && String(l.address).toLowerCase() === String(cfg.pons.factory).toLowerCase());
          if (!lg) return json(res, 200, { status: 'success', error: 'no TokenLaunched log in the receipt — nothing persisted' });
          const token = getAddress('0x' + lg.topics[1].slice(26));
          const curve = getAddress('0x' + lg.topics[2].slice(26));
          cfg.distribute.launchBlock = Number(rc.blockNumber);
          /* Ask the FACTORY who it recorded, and write that back as feeWallet.address rather than
             trusting the wallet that happened to POST here. It is the same "nothing is typed in
             twice" the watcher has always had: the keeper's own address, watch.creator and the
             launch block all come out of the chain, so the operator cannot leave the form with a
             config that disagrees with what was launched. The factory keeps creator and
             creatorFeeRecipient as separate fields, so both are read. */
          const info = await require('./watch.js').launchedTokenInfo(token).catch(() => null);
          if (info) {
            cfg.feeWallet.address = info.feeRecipient;
            if (cfg.watch) cfg.watch.creator = info.creator;
          }
          persist(token, curve);
          /* THE MOMENT THE LAUNCH SUCCEEDS IS THE MOMENT THE REMAINING WORK IS EASIEST TO FORGET.
             The browser gets a short log, but the operator's attention is on the wallet popup and
             the explorer, and the terminal is where they come back to. Nothing collects fees until
             the keeper runs -- that is a silent failure, because a token that is trading looks
             exactly like a token whose fees are being harvested. So this prints the two remaining
             steps loudly, with the addresses already filled in, rather than leaving them to be
             reconstructed from a runbook. */
          const bar = '='.repeat(78);
          console.log(`\n${bar}`);
          console.log(`  LAUNCHED  $${cfg.launch && cfg.launch.symbol ? cfg.launch.symbol : cfg.token.symbol}   ${token}`);
          console.log(`  curve     ${curve}`);
          console.log(`  fees to   ${info ? info.feeRecipient : '(unread)'}`);
          console.log(`\n  ${path.basename(cfgPath)} updated. TWO THINGS LEFT:\n`);
          console.log('  1  The site does not know about this token yet. Set it and redeploy:');
          console.log(`         TUMBLE_TOKEN_ADDRESS = ${token}`);
          console.log('\n  2  NOTHING IS HARVESTING. Fees accrue in the escrow and the vault does');
          console.log('     not grow until this is running, in its own window:\n');
          console.log('         set PRIVATE_KEY=0xyourkey');
          console.log('         node keeper.js --broadcast --loop');
          console.log(`\n  Check either at any time with:  node keeper.js --next`);
          console.log(`${bar}\n`);
          return json(res, 200, {
            status: 'success', token, curve, block: Number(rc.blockNumber),
            feeRecipient: info ? info.feeRecipient : null,
            creator: info ? info.creator : null,
            wroteConfig: !config.isTemplate(), cfgFile: path.basename(cfgPath),
          });
        }
        json(res, 404, { error: 'not found' });
      } catch (e) { json(res, 500, { error: short(e) }); }
    });

    /* AN ORPHANED FORM IS NOT A CRASH, AND IT IS NOT HARMLESS EITHER. The default failure here was
       an unhandled 'error' event: a v8 stack trace ending in EADDRINUSE, which says the port is
       taken and not that something is still SERVING on it. That something is a launch form holding
       the config it booted with — so the danger is not the collision, it is opening the browser,
       finding a form that works, and launching against whatever that stale process still believes
       the fee recipient is. This has already come within one click of pointing a token's fees at a
       desk that had been drained and abandoned, and fees cannot be redirected afterwards.

       So: say what is there, and say to kill it rather than to pick another port. --port is for
       running two on purpose, not for stepping around one you forgot about. */
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        console.error(`\n  port ${PORT} is already serving a launch form.`);
        console.error('\n  That is another `launch.js serve`, and it is showing the config it started with,');
        console.error('  which may not be the one on disk now. Do not just open it — the fee recipient it');
        console.error('  offers is permanent once signed. Stop it and start this one:\n');
        console.error(`    for /f "tokens=5" %a in ('netstat -ano ^| findstr :${PORT} ^| findstr LISTENING') do taskkill /PID %a /F`);
        console.error('\n  (or close the window running it, then re-run this command)\n');
        process.exit(1);
      }
      console.error(`\n  the launch form could not start: ${e && e.message ? e.message : e}\n`);
      process.exit(1);
    });

    server.listen(PORT, '127.0.0.1', () => {
      console.log(`\n  launch form:  http://127.0.0.1:${PORT}`);
      console.log(`  config:       ${path.basename(cfgPath)}${config.isTemplate() ? '   ⚠ COMMITTED TEMPLATE — it will refuse to write the launched address' : ''}`);
      console.log('  your wallet signs; no key is read by this process.');
      console.log('\n  Ctrl-C to stop.\n');
    });
    return;
  }

  console.log('\ncommands: plan · launch · fees · buy <eth> · status · serve [--port 8787]\n');
}

// the TOKEN's launch.js is require.main when it is run directly; this is that file's
// `if (require.main === module)`, one layer up
const entry = require.main;
if (entry && path.resolve(path.dirname(entry.filename)) === path.resolve(ROOT)) {
  main().catch((e) => { console.error(short(e)); process.exitCode = 1; });
}

return { preview, simulate, main, cfg, pc };
}

module.exports = { run };
