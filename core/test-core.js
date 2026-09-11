/**
 * @pons/core — the core's own suite.
 *
 *   node test-core.js
 *
 * The sinks' suites prove the money. This proves the half that is identical whatever the money does,
 * and every case in it is a bug that has actually been paid for once:
 *
 *   THE CONFIG.    A mistyped --config or a trailing comma must name the file and the fix, not exit
 *                  through Node's own handler with a stack trace into node:fs.
 *   THE TEMPLATE.  A committed config is never written back. --watch and launch.js are two callers
 *                  of one persistCfg for exactly this reason.
 *   THE READERS.   readJson cannot tell "never existed" from "half-written". readLedgerJson can, and
 *                  it is not overridable at the seam.
 *   THE GAS.       Every wei that leaves the wallet reaches harvest.json, through three tiers,
 *                  because understating it is the direction that halts the keeper forever.
 *   THE CEILING.   claimed + float − gas − spent − reserved, owned by the core and composed from the
 *                  sink's three terms.
 *   THE LOCK.      Two keepers over one state directory is two batches on consecutive nonces.
 *   THE WATCHER.   getLaunchedToken's word layout, decoded rather than assumed.
 *   THE CLIENT.    An unset rpc must still CONSTRUCT — the placeholder is what makes a keeper that
 *                  is not wired yet patchable by a test, and a connection error at runtime.
 *   THE CONTRACT.  A sink that is wrong fails on the first line of the process.
 *
 * No network, no key, nothing broadcast.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, 'state-test', 'cfgroot');
const OUT = path.join(ROOT, 'state');
const CONFIG_JS = path.join(__dirname, 'config.js').replace(/\\/g, '/');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'}  ${name}${detail ? `   ${detail}` : ''}`);
  if (!ok) failures++;
}
const quietLog = console.log;
function hush(fn) { console.log = () => {}; try { return fn(); } finally { console.log = quietLog; } }
async function hushAsync(fn) { console.log = () => {}; try { return await fn(); } finally { console.log = quietLog; } }

const TEMPLATE = {
  chain: { id: 4663, name: 'Robinhood Chain', rpc: '', explorer: 'https://explorer.invalid' },
  pons: { factory: '0x' + '11'.repeat(20), escrow: '0x' + '22'.repeat(20) },
  launch: { name: 'Test', symbol: 'TEST', creatorTaxBps: 200, socials: {} },
  token: { token: '0x' + '33'.repeat(20), curve: '0x' + '44'.repeat(20), symbol: 'TEST', decimals: 18 },
  feeWallet: { address: '0x' + '55'.repeat(20) },
  quote: { asset: 'native', symbol: 'ETH', decimals: 18 },
  distribute: { verified: false, gasReserveEth: 0.02, launchBlock: 0 },
  loop: { intervalMs: 60000, claimIntervalMs: 30000 },
  output: { dir: 'state', statsFile: 'stats.json' },
  watch: { creator: '0x' + '66'.repeat(20) },
  fake: {},
};

fs.rmSync(path.join(__dirname, 'state-test'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(TEMPLATE, null, 2));
fs.writeFileSync(path.join(ROOT, 'config.example.json'), JSON.stringify(TEMPLATE, null, 2));
fs.writeFileSync(path.join(ROOT, 'broken.json'), '{ "chain": { "id": 4663, } }');
fs.writeFileSync(path.join(ROOT, 'runner.js'),
  `require(${JSON.stringify(CONFIG_JS)}).load(__dirname); console.log('LOADED');\n`);
fs.writeFileSync(path.join(ROOT, 'persist.js'),
  `const c = require(${JSON.stringify(CONFIG_JS)});\n`
  + "const cfg = c.load(__dirname); cfg.token.token = '0xdead'; c.persistCfg('test');\n");

function child(script, args) {
  try {
    return { out: execFileSync(process.execPath, [path.join(ROOT, script)].concat(args || []),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '', code: 0 };
  } catch (e) {
    return { out: String(e.stdout || ''), err: String(e.stderr || ''), code: e.status };
  }
}

(async () => {
  /* ── 1. the config, and the two hand-typed error branches ───────────────────────────────────
     These run in a CHILD process on purpose: both end in process.exit(1) at module scope, which is
     the whole point of them. They sit outside main()'s catch so a first-run mistake — and both of
     these are first-run mistakes — never reaches Node's own handler. */
  console.log('\nthe config says what is wrong and how to fix it');
  {
    const ok = child('runner.js');
    check('a config that is there simply loads', /LOADED/.test(ok.out), `exit ${ok.code}`);

    const missing = child('runner.js', ['--config', path.join(ROOT, 'nope.json')]);
    check('a mistyped --config names the file it could not find',
      missing.code === 1 && /no config at/.test(missing.err) && /nope\.json/.test(missing.err),
      missing.err.split('\n')[0]);
    check('...and the fix, rather than a stack trace into node:fs',
      /cp config\.example\.json config\.json/.test(missing.err) && !/node:fs/.test(missing.err));

    const broken = child('runner.js', ['--config', path.join(ROOT, 'broken.json')]);
    check('a trailing comma is reported as invalid JSON, by file name',
      broken.code === 1 && /broken\.json is not valid JSON/.test(broken.err), broken.err.split('\n')[0]);
    check('...and it names the usual cause', /trailing comma or an unquoted key/.test(broken.err));
  }

  /* ── 2. the template refusal — one persistCfg, two callers ─────────────────────────────── */
  console.log('\na committed config is never written back');
  {
    const tpl = child('persist.js', ['--config', path.join(ROOT, 'config.example.json')]);
    const after = fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8');
    check('a committed template refuses the write',
      /not writing config\.example\.json/.test(tpl.out) && !/0xdead/.test(after),
      'copy it to config.json and re-run');
    check('...and prints what it would have written, so nothing is lost',
      /token 0xdead/.test(tpl.out) && /launchBlock/.test(tpl.out));

    const jsonPath = path.join(ROOT, 'config.json');
    const before = fs.readFileSync(jsonPath, 'utf8');
    child('persist.js');
    check('a config.json you own IS written back',
      /0xdead/.test(fs.readFileSync(jsonPath, 'utf8')), 'that is the file --watch and launch.js are for');
    fs.writeFileSync(jsonPath, before);
  }

  /* ── everything below shares one loaded config, the way a keeper does ────────────────────── */
  const config = require('./config.js');
  config.load(ROOT);
  const io = require('./io.js');
  const chain = require('./chain.js');
  const harvest = require('./harvest.js');
  const ceiling = require('./ceiling.js');
  const watch = require('./watch.js');
  const lock = require('./lock.js');
  const sinkApi = require('./sink.js');

  /* ── 3. two readers, because a missing file and a corrupt one are different facts ────────── */
  console.log('\ntwo readers, because a missing file and a corrupt one are different facts');
  {
    io.ensureDir();
    const p = path.join(OUT, 'ledger.json');
    check('a missing file reads as the fallback under both readers',
      io.readJson(p, { fresh: true }).fresh === true && io.readLedgerJson(p, { fresh: true }).fresh === true);

    fs.writeFileSync(p, '{"claimedTotal":"12');
    check('the lenient reader hands a truncated ledger back as empty — which is the whole problem',
      io.readJson(p, { fresh: true }).fresh === true, 'seq 0, out 0, batch ids reused over real receipts');
    let threw = '';
    try { io.readLedgerJson(p, { fresh: true }); } catch (e) { threw = e.message; }
    check('the strict reader refuses, and names the file',
      /ledger\.json is corrupt/.test(threw) && /refusing to read it as an empty ledger/.test(threw),
      threw.split('(')[0].trim());
    fs.unlinkSync(p);

    const deep = path.join(OUT, 'batches', 'batch-0001.json');
    io.writeJson(deep, { id: '0001' }, { mkdir: true });
    check('writeJson({mkdir:true}) creates the document\'s own directory, temp-and-rename intact',
      fs.existsSync(deep) && !fs.existsSync(`${deep}.tmp`) && io.readJson(deep, {}).id === '0001');
  }

  /* ── 4. recordGas — three tiers, and the last one is the fee cap ─────────────────────────── */
  console.log('\nevery wei of gas reaches harvest.json, through three tiers');
  {
    fs.rmSync(harvest.harvestFile(), { force: true });
    const G = 21000n;

    const v1 = await harvest.recordGas({ gasUsed: G, effectiveGasPrice: 2n, transactionHash: '0x1' }, null, 'tier 1');
    check('tier 1: the receipt prices it', v1 === G * 2n, `${v1} wei`);

    chain.source.getTransaction = async () => ({ gasPrice: 3n });
    const v2 = await harvest.recordGas({ gasUsed: G, transactionHash: '0x2' }, null, 'tier 2');
    check('tier 2: a receipt with no effectiveGasPrice asks the TRANSACTION', v2 === G * 3n, `${v2} wei`);

    chain.source.getTransaction = async () => ({ maxFeePerGas: 9n });
    const v3 = await harvest.recordGas({ gasUsed: G, transactionHash: '0x3' }, null, 'tier 3');
    check('tier 3: neither answers, so the FEE CAP is used — deliberately high', v3 === G * 9n,
      'overstating reports nothing; understating halts the keeper forever');

    chain.source.getTransaction = async () => null;
    const v4 = await hushAsync(() => harvest.recordGas({ gasUsed: G, transactionHash: '0x4' }, 'test', 'unpriceable'));
    check('a figure nothing can price is NOT invented', v4 === 0n,
      '0 wei, and the log says the audit will read short by it');

    const h = io.readLedgerJson(harvest.harvestFile(), {});
    check('all three tiers accumulate into one gasRaw',
      BigInt(h.gasRaw) === G * 2n + G * 3n + G * 9n, `${h.gasRaw} wei`);
    check('a receipt that burned no gas at all is a no-op',
      (await harvest.recordGas({ gasUsed: 0n }, null, 'nothing')) === 0n);
  }

  /* ── 5. the ceiling ───────────────────────────────────────────────────────────────────────── */
  console.log('\nthere is ONE ceiling, and the core owns the subtraction');
  {
    fs.rmSync(harvest.harvestFile(), { force: true });
    const E = (n) => BigInt(Math.round(n * 1e9)) * 10n ** 9n;
    const stub = { spentRaw: () => 0n, reservedRaw: () => 0n, declaredFloatRaw: () => 0n };
    ceiling.bind(stub);

    check('with nothing claimed, nothing is distributable — a funded wallet is NOT a pot',
      ceiling.donatable() === 0n);
    harvest.recordClaim(E(1), { hash: '0x' + 'aa'.repeat(32), block: 1, gasRaw: E(0.01).toString() });
    check('claimed, less the gas that claim burned', ceiling.donatable() === E(0.99), `${ceiling.donatable()}`);

    stub.spentRaw = () => E(0.4);
    check('what has already left is subtracted by the SINK\'s own term', ceiling.donatable() === E(0.59));
    stub.reservedRaw = () => E(0.09);
    check('and so is what is promised but not yet sent', ceiling.donatable() === E(0.5),
      'a wallet upgraded mid-life can still owe a deleted sink\'s ledger');
    stub.declaredFloatRaw = () => E(0.25);
    check('declared float is the one permission to send non-fee value, and it WIDENS the ceiling',
      ceiling.donatable() === E(0.75));
    stub.spentRaw = () => E(99);
    check('the ceiling never goes negative', ceiling.donatable() === 0n);
    stub.spentRaw = () => 0n; stub.reservedRaw = () => 0n; stub.declaredFloatRaw = () => 0n;

    check('a dry run may show the claim in flight, but donatable() itself is unmoved',
      ceiling.feesAvailable(E(2)) === E(0.99) + E(2) && ceiling.donatable() === E(0.99),
      'this process has no --broadcast, so DRY is true');
  }

  /* ── 6. the lock ──────────────────────────────────────────────────────────────────────────── */
  console.log('\none keeper at a time, per state directory');
  {
    fs.rmSync(lock.lockPath(), { force: true });
    check('the first keeper takes the lock', hush(() => lock.acquireLock('test')) === true);
    check('the lock file names the pid that holds it', io.readJson(lock.lockPath(), {}).pid === process.pid);
    check('a second keeper is refused rather than racing a nonce',
      hush(() => lock.acquireLock('test')) === false,
      'two keepers sign two batches on consecutive nonces and both can mine');
    fs.rmSync(lock.lockPath(), { force: true });
    check('and it goes again once a stale lock is removed', hush(() => lock.acquireLock('test')) === true);
    fs.rmSync(lock.lockPath(), { force: true });
  }

  /* ── 7. the watcher's decode ──────────────────────────────────────────────────────────────── */
  console.log('\ngetLaunchedToken, decoded rather than assumed');
  {
    const TOKEN = '0x' + '33'.repeat(20);
    const CURVE = '0x' + '44'.repeat(20);
    const CREATOR = '0x' + '66'.repeat(20);
    const RECIP = '0x' + '77'.repeat(20);
    const w = (hex) => hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const words = [w(TOKEN), w(CURVE), w(CREATOR), w(RECIP), w('0'), w('0'), w('0'), w('0'), w('c8')];
    chain.source.call = async () => ({ data: '0x' + words.join('') });
    const info = await watch.launchedTokenInfo(TOKEN);
    check('word0 token · word1 curve · word2 creator · word3 the CURRENT feeRecipient',
      info.token === TOKEN && info.curve === CURVE && info.creator === CREATOR && info.feeRecipient === RECIP,
      info.feeRecipient);
    check('word8 is creatorTaxBps', info.creatorTaxBps === 200, `${info.creatorTaxBps} bps`);

    chain.source.call = async () => ({ data: '0x' + words.map(() => w('0')).join('') });
    check('a zeroed struct is NOT a launched token', (await watch.launchedTokenInfo(TOKEN)) === null);
    chain.source.call = async () => ({ data: '0x' });
    check('an empty return is not one either', (await watch.launchedTokenInfo(TOKEN)) === null);
  }

  /* ── 8. an unwired client still constructs ────────────────────────────────────────────────── */
  console.log('\na chain that is not configured yet must still be a client');
  {
    let built = null, threw = '';
    try { built = chain.makePublicClient({ chainId: 999, label: 'unset', rpc: null }); }
    catch (e) { threw = (e && e.message) || String(e); }
    check('makePublicClient with no rpc CONSTRUCTS rather than throwing', !!built && !threw,
      'http("") falls back to chain.rpcUrls.default, and an empty default array throws at request time');
    built.getChainId = async () => 999;
    check('...so a test can patch it', (await built.getChainId()) === 999);

    const raw = chain.makePublicClient({ chainId: 999, label: 'unset', rpc: null });
    let msg = '';
    try { await raw.getChainId(); } catch (e) { msg = String((e && e.shortMessage) || (e && e.message) || e); }
    check('and a real call fails as a CONNECTION error, not a viem type error',
      msg.length > 0 && !/rpcUrls/.test(msg) && !/is not a function/.test(msg),
      msg.split('\n')[0].slice(0, 64));
  }

  /* ── 9. the sink contract ─────────────────────────────────────────────────────────────────── */
  console.log('\nthe sink contract fails at startup, not three passes later');
  {
    const good = {
      declare: () => ({ api: 1, id: 'x', configKey: 'fake' }),
      configure: () => {}, audit: () => ({ ok: true, deltaRaw: 0n }),
      spentRaw: () => 0n, reservedRaw: () => 0n, stats: () => ({}),
    };
    check('a complete sink is accepted', sinkApi.assertSink(good).id === 'x');
    check('...and its optional members default rather than being demanded',
      sinkApi.assertSink(good).clients.length === 0 && sinkApi.assertSink(good).readOnlyCommands.length === 0);

    const t = (s) => { try { sinkApi.assertSink(s); return ''; } catch (e) { return e.message; } };
    check('every missing member is named, all of them at once',
      /missing spentRaw, reservedRaw/.test(t(Object.assign({}, good, { spentRaw: null, reservedRaw: null }))));
    check('an api version this core does not speak is refused',
      /declares api 2/.test(t(Object.assign({}, good, { declare: () => ({ api: 2, id: 'x', configKey: 'f' }) }))));
    check('a sink with no configKey is refused — the core must know which subtree to hand back',
      /configKey is required/.test(t(Object.assign({}, good, { declare: () => ({ api: 1, id: 'x' }) }))));
  }

  fs.rmSync(path.join(__dirname, 'state-test'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all core tests passed'}\n`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => {
  console.log = quietLog;
  console.error('\nTEST HARNESS ERROR:', e.stack, '\n');
  // see the sinks' suites: a scanner still holding state-test/ is not a failed assertion
  if (['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(e && e.code)) {
    console.error('that is a filesystem error in teardown, not a failed check — usually a scanner');
    console.error('still holding core/state-test/. Re-run: npm test\n');
  }
  process.exitCode = 1;
});
