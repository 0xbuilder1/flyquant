/* ═══════════════════════════════════════════════════════════════════════════════════════════
   WATCH — wait for the launch, then configure ourselves from it
   ═══════════════════════════════════════════════════════════════════════════════════════════
   You launch in the PONS UI (where you can actually see the metadata you are committing to) with
   creatorFeeRecipient set to the keeper. This process watches the factory for YOUR launch and
   wires itself up: token, curve, launch block. Nothing is typed in twice and nothing is guessed.

   TokenLaunched, decoded against the live factory rather than assumed:
     topic0  0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607
     topic1  token   (indexed)
     topic2  curve   (indexed)
     topic3  creator (indexed)   <- filtered server-side, so this costs one cheap query
   and factory.getLaunchedToken(token) 0x3cf28b5a returns
     word0 token · word1 curve · word2 creator · word3 CURRENT feeRecipient · word8 creatorTaxBps
   which is how we confirm the fees actually point at us before doing anything else.
   ═══════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { isAddress } = require('viem');
const cfg = require('./config.js').current();
const { persistCfg } = require('./config.js');
const { lc, log, sleep, ZERO } = require('./fmt.js');
const { source: pc } = require('./chain.js');
const { erc20Abi } = require('./abis.js');

const LAUNCH_TOPIC = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const pad32 = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const wordAddr = (data, i) => '0x' + data.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);

async function launchedTokenInfo(token) {
  const r = await pc.call({ to: cfg.pons.factory, data: '0x3cf28b5a' + pad32(token).slice(2) }).catch(() => null);
  if (!r || !r.data || r.data === '0x') return null;
  const d = r.data;
  const t = wordAddr(d, 0);
  if (lc(t) !== lc(token) || lc(t) === ZERO) return null;      // zeroed struct == not a launched token
  return {
    token: t, curve: wordAddr(d, 1), creator: wordAddr(d, 2), feeRecipient: wordAddr(d, 3),
    creatorTaxBps: Number(BigInt('0x' + d.slice(2 + 8 * 64, 2 + 9 * 64))),
  };
}

/** newest launch by `creator`, searching backwards so a long history costs nothing */
async function findLaunch(creator, s) {
  const latest = await pc.getBlockNumber();
  const span = BigInt((cfg.watch && cfg.watch.scanChunk) || 50000);
  const look = BigInt((cfg.watch && cfg.watch.lookbackBlocks) || 400000);
  const floor = latest > look ? latest - look : 0n;

  for (let to = latest; to > floor;) {
    const from = to - span + 1n > floor ? to - span + 1n : floor;
    // Raw eth_getLogs, deliberately: viem's getLogs builds its topic filter from an event ABI and
    // IGNORES a topics array passed directly. That silently returned every launch on the factory
    // rather than this creator's, so the watcher latched onto a stranger's token.
    const logs = await pc.request({
      method: 'eth_getLogs',
      params: [{
        address: cfg.pons.factory,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        topics: [LAUNCH_TOPIC, null, null, pad32(creator)],
      }],
    }).catch(() => []);
    if (logs.length) {
      const l = logs[logs.length - 1];                         // newest in the window
      const info = await launchedTokenInfo('0x' + l.topics[1].slice(26));
      if (info) return { ...info, launchBlock: Number(BigInt(l.blockNumber)) };
    }
    if (from === floor) break;
    to = from - 1n;
  }
  return null;
}

async function watchForLaunch(addr, s) {
  const creator = (cfg.watch && cfg.watch.creator) || '';
  if (!isAddress(creator) || lc(creator) === ZERO) {
    log(s, 'set watch.creator to the wallet you will launch from, then restart.');
    return null;
  }
  const want = (cfg.watch && cfg.watch.matchSymbol) || '';
  const poll = Number((cfg.watch && cfg.watch.pollMs) || 5000);

  log(s, `watching the PONS factory for a launch by ${creator}${want ? ` with symbol ${want}` : ''}…`);
  for (let i = 0; ; i++) {
    const hit = await findLaunch(creator, s).catch(() => null);
    if (hit) {
      let sym = '';
      try { sym = await pc.readContract({ address: hit.token, abi: erc20Abi, functionName: 'symbol' }); } catch {}
      if (want && lc(sym) !== lc(want)) {
        if (i % 12 === 0) log(s, `saw ${sym || 'a token'} from that wallet, but waiting for ${want}.`);
      } else {
        console.log('');
        log(s, `LAUNCH DETECTED — ${sym || '?'} at block ${hit.launchBlock}`);
        console.log(`     token          ${hit.token}`);
        console.log(`     curve          ${hit.curve}`);
        console.log(`     creator        ${hit.creator}`);
        console.log(`     feeRecipient   ${hit.feeRecipient}`);
        console.log(`     creatorTaxBps  ${hit.creatorTaxBps}  (trader pays ${(1 + hit.creatorTaxBps / 100).toFixed(2)}%, pot receives ${(0.7 + hit.creatorTaxBps / 100).toFixed(2)}%)`);
        console.log('');

        if (lc(hit.feeRecipient) !== lc(addr)) {
          log(s, `!! creatorFeeRecipient is ${hit.feeRecipient}, NOT this keeper (${addr}).`);
          log(s, '   Fees are payable to somebody else and the harvest will reach nothing.');
          log(s, '   Fix it from the current recipient: factory.transferCreatorFeeRecipient(token, keeper).');
          log(s, '   Still wiring the token up so you can inspect it; the sink stays blocked.');
        }
        cfg.token.token = hit.token;
        cfg.token.curve = hit.curve;
        cfg.token.symbol = sym || cfg.token.symbol;
        // launchBlock is persisted UNCONDITIONALLY, whether or not this token's sink reads it back.
        // A holder-shaped sink rebuilds balances from Transfer deltas and needs it as the scan's
        // from-block floor: a window that misses the early history yields WRONG balances, not merely
        // missing holders. The core does not get to know which sink it has.
        cfg.distribute.launchBlock = hit.launchBlock;
        persistCfg(s);
        return hit;
      }
    } else if (i % 12 === 0) {
      log(s, 'no launch from that wallet yet…');
    }
    await sleep(poll);
  }
}

module.exports = { LAUNCH_TOPIC, pad32, wordAddr, launchedTokenInfo, findLaunch, watchForLaunch };
